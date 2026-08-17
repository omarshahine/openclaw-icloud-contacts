# openclaw-icloud-contacts: design

Date: 2026-08-17. Built "just like calendar" (see openclaw-icloud-calendar spec 2026-08-16); this records the deltas.

## Goal
Server-to-server read/write of Apple iCloud Contacts over CardDAV with Apple ID + app-specific password, zero runtime deps, public ClawHub plugin. Separate plugin from calendar (install boundary = privacy boundary), code shared by copy.

## Components
`src/dav/{xml,client,discovery,store}.ts`, `src/vcard/{component,contact,search}.ts`, `src/tools/{schemas,handlers}.ts`, `src/{config,errors,sanitize,index}.ts`.

Data flow (read): tool → `ContactStore.refresh()` (sync-collection with stored token → multiget changed hrefs → parse to Contact) → filter/search in memory → shape (brief/full) → datamark.
Data flow (write): Contact input → vCard (new) or patch of stored text (preserving unknown props) → PUT with `If-None-Match:*` / `If-Match: etag` → GET back → cache upsert.

## Tools
`icloud_contacts_list|search|get|groups|create|update|delete`. Contact JSON mirrors apple-pim (brief: id, fullName, given/family, organization, emails[], phones[], birthday, groups; full: labeled arrays + IM/relations/social/dates/notes/photoUrl). Groups: Apple `X-ADDRESSBOOKSERVER-KIND:group` cards.

## Config
`appleId`, `appPassword` (string/${ENV}/SecretRef), `serverUrl`, `readOnly`, `groups` (allowlist), `defaultLimit` (25), `maxContacts` (10000).

## Decisions
- Search client-side over the sync cache (iCloud addressbook-query unreliable). Cache refresh throttled to 10 s between calls; sync-collection deltas after first full sync.
- Photos: `photoUrl` always; base64 only on `includePhoto`, capped at 5 MB.
- Labels: standard → TYPE params; custom → `itemN.X-ABLabel`; Apple sentinels decoded/encoded; sentinel characters never escaped.
- Arrays replace wholesale on update; null/"" clears scalars.
- Privacy: brief shape + small limits by default; group allowlist; readOnly; datamarking.

## Verified live (2026-08-17)
619 contacts synced in 4.3 s, 0 unparseable, 0 parse→serialize→parse mismatches; contact CRUD, search, group CRUD all pass.

## Not in v1
Multiple address books, vCard 4, photo upload, dedupe/merge, bulk import.
