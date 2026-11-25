# openclaw-icloud-contacts

OpenClaw plugin that reads and writes **Apple iCloud Contacts** directly over CardDAV, using an
Apple ID and an app-specific password. Server-to-server: it runs wherever your OpenClaw gateway
runs (Linux, a Raspberry Pi, a VPS). No macOS, no Contacts.app, no phone in the loop.

Zero runtime dependencies for the CardDAV path: `fetch` plus a small XML/vCard layer written for
exactly the responses iCloud sends. Sister plugin of
[openclaw-icloud-calendar](https://github.com/omarshahine/openclaw-icloud-calendar).

## Tools

| Tool | What it does |
|------|--------------|
| `icloud_contacts_search` | Find contacts by name, email, phone (digits), organization, or any |
| `icloud_contacts_get` | One contact by id, all fields; optional photo as base64 |
| `icloud_contacts_list` | Browse sorted by name with paging; optionally one group |
| `icloud_contacts_groups` | List groups, list members, create, add/remove members, delete |
| `icloud_contacts_create` | New contact (name or organization required) |
| `icloud_contacts_update` | Change fields by id and reviewed version (arrays replace) |
| `icloud_contacts_delete` | Delete a contact by id and reviewed version |

Set `readOnly: true` and the write tools are not registered at all (group mutations also refuse).

## Install

```bash
openclaw plugins install clawhub:openclaw-icloud-contacts
```

## Setup

1. Turn on two-factor authentication for your Apple Account if it is not already on.
2. Create an app-specific password at <https://account.apple.com> → Sign-In and Security →
   App-Specific Passwords. Copy the `xxxx-xxxx-xxxx-xxxx` value.
3. Make it available to the gateway as an environment variable named `ICLOUD_APP_PASSWORD` (or store it
   using an OpenClaw-managed secret provider, see below).
4. Configure the plugin in `openclaw.json`:

   ```jsonc
   {
     "plugins": {
       "entries": {
         "openclaw-icloud-contacts": {
           "enabled": true,
           "config": {
             "appleId": "you@icloud.com",
             "appPassword": "${ICLOUD_APP_PASSWORD}"
           }
         }
       }
     }
   }
   ```

   The host can materialize appPassword from configured env, file, exec, or store providers
   on compatible OpenClaw versions. OpenClaw 2026.6.5 supports env, file, and exec references;
   use a store-capable host (such as OpenClaw 2026.11.1 or later) for store references.
   The plugin does not read secret files or run providers.
   If you previously relied on the plugin reading ~/.openclaw/secrets.json directly, configure
   a host file provider in OpenClaw and update the reference, or supply ICLOUD_APP_PASSWORD in
   the gateway environment and omit appPassword. An explicit unresolved, malformed, or empty
   appPassword never falls back to another credential. The legacy single `${ENV_VAR}` string form
   continues to work when the named environment variable exists.

   After installing the new SecretInput declaration, fully restart the gateway before testing a
   newly configured provider. A targeted plugin reload may retain startup manifest metadata.
   The same app-specific password works for the calendar plugin.

## Configuration

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `appleId` | string | | Apple Account email. Required. |
| `appPassword` | string / `${ENV}` / SecretRef | | App-specific password. Required. Never your Apple Account password. |
| `serverUrl` | string | `https://contacts.icloud.com` | Must be `https`. |
| `readOnly` | boolean | `false` | No writes; create/update/delete not registered. |
| `groups` | string[] | all | Read-only allowlist: only these groups and their current members are visible. |
| `defaultLimit` | integer | 25 | Default page size for list/search. |
| `maxContacts` | integer | 10000 | Refuse to sync larger address books. |

## Behavior worth knowing

- **Sync cache.** First call runs an RFC 6578 `sync-collection` plus batched `addressbook-multiget`
  (about 4 s for 600 contacts); later calls send only the sync token and fetch changed cards. iCloud
  invalidates tokens occasionally; the plugin resyncs transparently. Search is client-side because
  iCloud's `addressbook-query` silently downgrades `allof` to `anyof` and matches case-sensitively.
- **Contact JSON** mirrors apple-pim's contact tool: brief records for lists/searches, full records
  with labeled entries for get/create/update. `id` is the vCard UID (stable across devices).
- **Apple vCard dialect.** vCard 3.0 only. Labels use Apple's `itemN.X-ABLabel` grouping and
  `_$!<Home>!$_` sentinels; standard labels map to TYPE params, custom labels round-trip as text.
  Unknown properties are preserved on update.
- **Photos:** Without a configured group allowlist, full records can include an external photo URL and Get can return base64 on request. External photo responses are capped at 5 MiB. A configured group allowlist exposes only photo presence in full records, never photo URLs or bytes, and never fetches a separate photo.
- **Response limits:** Each CardDAV fetch attempt, including reading its response, has a
  30-second deadline. Text responses are limited to 32 MiB per response. Oversized or
  incomplete responses fail without returning partial data.
- **Credential hygiene.** Credentials are sent only to the configured server origin (scheme, host,
  and port). Default iCloud discovery also allows Apple's numbered Contacts partition hosts over
  HTTPS on port 443. Redirects and photos outside those origins are not fetched.
- **Groups** are Apple `X-ADDRESSBOOKSERVER-KIND:group` cards; membership is by contact UID.
- **Concurrency.** Contact edits and deletes require `expectedEtag`, the exact quoted `etag` returned by `icloud_contacts_get` for the contact version you reviewed. The plugin never substitutes a newer version or retries a conflict. A lost or uncertain write response returns `write_unconfirmed`; check the stored record before deciding whether to try again. CardDAV read requests still tolerate one transient retry.
- **Rate limits.** iCloud throttles roughly 15-20 writes/minute (503). The plugin has no bulk write
  tool on purpose; batch mutations should be paced.
- **Untrusted content.** Names, organizations, titles, nicknames and notes are wrapped in per-session
  `[UNTRUSTED_CONTACT_DATA_...]` markers and instruction-like text is flagged. Deletion responses contain only status and the requested ID.
- **Errors.** `error.code`: `auth_failed`, `not_found`, `conflict`, `read_only`, `invalid_input`,
  `not_configured`, `server_error`, `write_unconfirmed`.

## Privacy

An address book is more sensitive than a calendar. Defaults are conservative: brief shape, small
limits, no photos unless asked. For shared or family gateways use `groups` to expose only a slice,
or `readOnly` to prevent edits without filtering. With `groups` set, the plugin disables
contact and group writes: CardDAV cannot atomically authorize a write against a separate group card.
Every scoped read checks a fresh complete address-book snapshot, without exposing other groups or
their counts. Each configured name must identify one group; its identity is pinned for the process
lifetime. If a group is renamed, replaced, missing, or ambiguous, review the allowlist before
restarting the gateway. Unscoped access keeps the normal cache and write behavior.

The group filter applies to plugin tool results, not the underlying credential. The plugin fetches
the full address book into memory to evaluate membership. Use a separate address book/account if
you need isolation from the gateway itself.

## Development

```bash
npm install
npm test                # unit + fake-server tests, no network
npm run typecheck && npm run build
npm run plugin:check    # @openclaw/plugin-inspector
```

Live test against a real account (syncs the whole book read-only, then creates and deletes one
`[openclaw-test]` contact and group):

```bash
ICLOUD_INTEGRATION=1 ICLOUD_TEST_APPLE_ID=you@icloud.com ICLOUD_TEST_APP_PASSWORD=<app-specific password> npm run test:integration
```

## Not in v1

Multiple address books, vCard 4 export, contact photo upload, merging duplicates, bulk import.

## License

MIT
