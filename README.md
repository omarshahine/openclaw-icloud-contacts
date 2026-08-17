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
| `icloud_contacts_update` | Change fields by id (etag-protected; arrays replace) |
| `icloud_contacts_delete` | Delete a contact by id |

Set `readOnly: true` and the write tools are not registered at all (group mutations also refuse).

## Install

```bash
openclaw plugins install clawhub:openclaw-icloud-contacts
```

## Setup

1. Turn on two-factor authentication for your Apple Account if it is not already on.
2. Create an app-specific password at <https://account.apple.com> → Sign-In and Security →
   App-Specific Passwords. Copy the `xxxx-xxxx-xxxx-xxxx` value.
3. Make it available to the gateway, e.g. `export ICLOUD_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"`.
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

   `appPassword` also accepts a SecretRef (`{"source":"env","provider":"env","id":"ICLOUD_APP_PASSWORD"}`
   or `{"source":"file","provider":"secrets","id":"/icloud/appPassword"}` into `~/.openclaw/secrets.json`).
   Without config, `ICLOUD_APPLE_ID` and `ICLOUD_APP_PASSWORD` environment variables are used.
   The same app-specific password works for the calendar plugin.

## Configuration

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `appleId` | string | | Apple Account email. Required. |
| `appPassword` | string / `${ENV}` / SecretRef | | App-specific password. Required. Never your Apple Account password. |
| `serverUrl` | string | `https://contacts.icloud.com` | Must be `https`. |
| `readOnly` | boolean | `false` | No writes; create/update/delete not registered. |
| `groups` | string[] | all | Allowlist: only members of these groups are visible or editable. |
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
- **Photos** are external URIs on iCloud; `photoUrl` is always returned, `includePhoto=true` fetches
  it (authenticated) and returns base64. Photos larger than 5 MB are not returned.
- **Groups** are Apple `X-ADDRESSBOOKSERVER-KIND:group` cards; membership is by contact UID.
- **Concurrency.** Writes send `If-Match`; one re-read + retry on 412, then `conflict`.
- **Rate limits.** iCloud throttles roughly 15-20 writes/minute (503). The plugin has no bulk write
  tool on purpose; batch mutations should be paced.
- **Untrusted content.** Names, organizations, titles, nicknames and notes are wrapped in per-session
  `[UNTRUSTED_CONTACT_DATA_...]` markers and instruction-like text is flagged.
- **Errors.** `error.code`: `auth_failed`, `not_found`, `conflict`, `read_only`, `invalid_input`,
  `not_configured`, `server_error`.

## Privacy

An address book is more sensitive than a calendar. Defaults are conservative: brief shape, small
limits, no photos unless asked. For shared or family gateways use `groups` to expose only a slice,
or `readOnly` to prevent edits. Consider a dedicated agent with only the read tools allowed.

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
ICLOUD_INTEGRATION=1 ICLOUD_TEST_APPLE_ID=you@icloud.com ICLOUD_TEST_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npm run test:integration
```

## Not in v1

Multiple address books, vCard 4 export, contact photo upload, merging duplicates, bulk import.

## License

MIT
