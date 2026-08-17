# openclaw-icloud-contacts

OpenClaw plugin: Apple iCloud Contacts over CardDAV (Apple ID + app-specific password), server-to-server, zero runtime deps for the CardDAV path. Sister of `openclaw-icloud-calendar`; same conventions, tests, and publish pipeline. Published to ClawHub as `openclaw-icloud-contacts`.

## Project Structure

- `src/index.ts` — plugin entry (`definePluginEntry`), registers `icloud_contacts_*` tools; write tools skipped when `readOnly`
- `src/config.ts` — config + SecretRef resolution; `groups` allowlist, `defaultLimit`, `maxContacts`
- `src/dav/` — `xml.ts` (parser + CardDAV bodies: propfind, sync-collection, multiget, addressbook-query), `client.ts` (fetch, retry, error mapping, `getBinary` for photos), `discovery.ts` (principal → addressbook-home-set → `card`, cached `Session`), `store.ts` (sync-token cache, multiget in chunks, uid index, group index)
- `src/vcard/` — `component.ts` (vCard 3.0 content lines, `itemN.` groups, vCard escaping), `contact.ts` (Contact JSON ⇄ vCard incl. Apple labels/sentinels, ADR/BDAY/X-ABDATE/X-ABRELATEDNAMES/IMPP/X-SOCIALPROFILE/PHOTO, groups), `search.ts` (client-side matching)
- `src/tools/` — `schemas.ts` (typebox; optional params nullable), `handlers.ts`
- `src/sanitize.ts` — datamarking of free text
- `skills/icloud-contacts/SKILL.md`, `openclaw.plugin.json`, `marketplace.json`
- `test/` — vitest unit, fake in-memory iCloud CardDAV (`test/helpers/fake-icloud.ts`), opt-in live test (`test/integration`)

## iCloud CardDAV facts (verified live 2026-08-17; do not "fix" away)

- Host `https://contacts.icloud.com`, PROPFIND `/` answers 401 without auth and returns a relative principal; `addressbook-home-set` is absolute on `pNN-contacts.icloud.com:443`. One addressbook `card`.
- `sync-collection` with empty token = full listing (includes the collection itself as `/…/card` without trailing slash → skip); with token = deltas; iCloud returns 412 for expired tokens → full resync.
- `addressbook-multiget` works in chunks of 100. `addressbook-query` FN contains works but is unreliable → search client-side.
- vCard 3.0 only. PUT returns 201 + ETag; `<uid>.vcf` works for our cards, other hrefs are opaque.
- Photos are external authenticated URIs (`PHOTO;VALUE=uri`), often folded mid-URI.
- Models send `null` for unused optional params; schemas accept null and handlers normalise.
- Never put `required` in `configSchema` (installer writes an empty entry; CLI refuses to start). No TS parameter properties/enums (runtime type-strip loader).

## Commands

```bash
npm test && npm run typecheck && npm run build
npm run plugin:ci        # inspector incl. runtime capture; expect Captured 2 / Failed 0
ICLOUD_INTEGRATION=1 ICLOUD_TEST_APPLE_ID=... ICLOUD_TEST_APP_PASSWORD=... npm run test:integration
scripts/check-versions.sh
npm pack && openclaw plugins install --force npm-pack:./openclaw-icloud-contacts-<v>.tgz && openclaw plugins inspect openclaw-icloud-contacts --runtime && openclaw plugins uninstall --force openclaw-icloud-contacts
```

On this Mac prefix installer smoke tests with `NPM_CONFIG_REGISTRY=https://registry.npmjs.org/` (global npm registry is a Microsoft proxy that 404s on `openclaw`).

## Publishing

Versions must agree in `package.json`, `marketplace.json`, `openclaw.plugin.json` (CI enforces). Tag `vX.Y.Z` (annotated) → `publish-clawhub.yml` (needs `CLAWHUB_TOKEN`) and `publish-npm.yml` (OIDC; needs trusted publisher after first manual npm publish). Manual: `./publish-clawhub.sh --changelog "..."`. First ClawHub publish is manual (`clawhub login` + script). Do not re-tag a published version (ClawHub versions are immutable).

Verify: `clawhub package inspect openclaw-icloud-contacts`, `openclaw plugins install clawhub:openclaw-icloud-contacts`, `openclaw plugins inspect openclaw-icloud-contacts --runtime`.
