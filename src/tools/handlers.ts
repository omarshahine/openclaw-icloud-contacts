/**
 * Tool handlers: params -> store/CardDAV -> JSON results.
 */

import { randomUUID } from "node:crypto";
import type { ResolvedConfig } from "../config.js";
import type { Session } from "../dav/discovery.js";
import { ContactStore, type Entry } from "../dav/store.js";
import { DavError, invalidInput, notFound } from "../errors.js";
import { buildGroupCard, buildNewContact, extractUid, parseContact, patchContact, setGroupMembers, toBrief, type Contact, type ContactBrief, type ContactInput, type GroupCard } from "../vcard/contact.js";
import { matchesContact, scoreContact, sortByName, type SearchField } from "../vcard/search.js";

export interface Context {
  session: Session;
  store: ContactStore;
  config: ResolvedConfig;
  groupIds?: Map<string, string>;
  allowedGroups?: GroupCard[];
  scopedMembership?: Map<string, string[]>;
}

export function createContext(session: Session, config: ResolvedConfig): Context {
  return { session, config, groupIds: config.groups.length ? new Map() : undefined, store: new ContactStore(session, { readOnly: config.readOnly, maxContacts: config.maxContacts }) };
}

/** Drop null-valued keys (models often send null for unused optional fields). */
function stripNulls<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as T;
}

/** Refresh the cache; on a stale-discovery 404, rediscover once and retry. */
async function ensure(ctx: Context, force = false): Promise<void> {
  try {
    await ctx.store.refresh(force);
  } catch (e) {
    if (e instanceof DavError && e.code === "not_found" && e.status === 404) {
      ctx.session.invalidate();
      ctx.store.reset();
      await ctx.store.refresh(true);
    } else throw e;
  }
}

/** Scoped operations never fall back to an older address book after a failed read. */
async function forRead(ctx: Context): Promise<Context> {
  if (!ctx.config.groups.length) {
    await ensure(ctx);
    return ctx;
  }
  const store = new ContactStore(ctx.session, { readOnly: true, maxContacts: ctx.config.maxContacts, strictSnapshot: true });
  const scoped = { ...ctx, store };
  await ensure(scoped);
  const all = store.groups();
  const names = new Set(ctx.config.groups.map((name) => name.trim().toLowerCase()));
  const allowedGroups: GroupCard[] = [];
  for (const name of names) {
    const matches = all.filter((g) => g.name.trim().toLowerCase() === name);
    const pinnedId = ctx.groupIds?.get(name);
    if (matches.length !== 1 || (pinnedId !== undefined && pinnedId !== matches[0].id)) {
      throw new DavError("not_configured", "A configured Contacts group is missing, ambiguous, or no longer has its original identity. Review the group allowlist.");
    }
    allowedGroups.push(matches[0]);
  }
  // Pin only after all configured names have been resolved successfully.
  for (const group of allowedGroups) ctx.groupIds?.set(group.name.trim().toLowerCase(), group.id);
  const scopedMembership = new Map<string, string[]>();
  for (const group of allowedGroups) {
    for (const id of new Set(group.memberIds)) {
      const groups = scopedMembership.get(id) ?? [];
      groups.push(group.name);
      scopedMembership.set(id, groups);
    }
  }
  return { ...scoped, allowedGroups, scopedMembership };
}

function allowedGroups(ctx: Context): GroupCard[] {
  return ctx.allowedGroups ?? ctx.store.groups();
}

function resolveGroup(ctx: Context, nameOrId: string): GroupCard {
  const needle = nameOrId.trim().toLowerCase();
  const groups = allowedGroups(ctx);
  if (ctx.allowedGroups) {
    const matches = groups.filter((g) => g.id.toLowerCase() === needle || g.name.trim().toLowerCase() === needle);
    if (matches.length !== 1) throw notFound("No unique matching group in the allowed groups");
    return matches[0];
  }
  const g = groups.find((x) => x.id.toLowerCase() === needle) ?? groups.find((x) => x.name.toLowerCase() === needle);
  if (!g) throw notFound(`Group "${nameOrId}" not found. Available: ${groups.map((x) => x.name).join(", ") || "none"}`);
  return g;
}

function groupsForContact(ctx: Context, id: string): string[] | undefined {
  return (ctx.scopedMembership ?? ctx.store.groupIndex()).get(id);
}

/** Contacts visible under the config allowlist and optional group filter. */
function visibleContacts(ctx: Context, group?: GroupCard): Contact[] {
  const idx = ctx.scopedMembership ?? ctx.store.groupIndex();
  const members = group ? new Set(group.memberIds) : undefined;
  return ctx.store.contacts().flatMap(({ contact }) => {
    const c = contact!;
    if (members && !members.has(c.id)) return [];
    const groups = idx.get(c.id);
    if (ctx.allowedGroups && !groups?.length) return [];
    return [groups?.length ? { ...c, groups } : c];
  });
}

function shape(c: Contact, fields: "brief" | "full" | null | undefined): Contact | ContactBrief {
  return fields === "full" ? c : toBrief(c);
}

function summary(ctx: Context) {
  const book = ctx.store.addressbook;
  if (ctx.scopedMembership) return { totalContacts: ctx.store.contacts().filter((e) => ctx.scopedMembership!.has(e.contact!.id)).length, groups: ctx.allowedGroups!.length };
  return { addressbook: book?.name ?? "card", totalContacts: ctx.store.contacts().length, groups: ctx.store.groups().length, ...(ctx.store.parseErrorCount() ? { unparseableCards: ctx.store.parseErrorCount() } : {}) };
}

// ---------------------------------------------------------------------------

export interface ListParams {
  limit?: number | null;
  offset?: number | null;
  group?: string | null;
  fields?: "brief" | "full" | null;
}

export async function handleList(ctx: Context, raw: ListParams) {
  const p = stripNulls(raw);
  ctx = await forRead(ctx);
  const all = visibleContacts(ctx, p.group ? resolveGroup(ctx, p.group) : undefined).sort(sortByName);
  const offset = p.offset ?? 0;
  const limit = p.limit ?? ctx.config.defaultLimit;
  const page = all.slice(offset, offset + limit);
  return { ...summary(ctx), matched: all.length, offset, count: page.length, truncated: offset + page.length < all.length, contacts: page.map((c) => shape(c, p.fields)) };
}

export interface SearchParams {
  query: string;
  field?: SearchField | null;
  limit?: number | null;
  group?: string | null;
  fields?: "brief" | "full" | null;
}

export async function handleSearch(ctx: Context, raw: SearchParams) {
  const p = stripNulls(raw);
  if (!p.query || !p.query.trim()) throw invalidInput("query is required");
  ctx = await forRead(ctx);
  const field = p.field ?? "any";
  const hits = visibleContacts(ctx, p.group ? resolveGroup(ctx, p.group) : undefined)
    .filter((c) => matchesContact(c, p.query, field))
    .sort((a, b) => scoreContact(a, p.query) - scoreContact(b, p.query) || sortByName(a, b));
  const limit = p.limit ?? ctx.config.defaultLimit;
  return { query: p.query, field, matched: hits.length, count: Math.min(hits.length, limit), truncated: hits.length > limit, contacts: hits.slice(0, limit).map((c) => shape(c, p.fields)) };
}

async function locate(ctx: Context, id: string): Promise<Entry> {
  if (!id || !id.trim()) throw invalidInput("id is required");
  if (!ctx.allowedGroups) await ensure(ctx);
  let e = ctx.store.byUid(id.trim());
  if (!e && !ctx.allowedGroups) {
    // Maybe created elsewhere seconds ago; force one refresh.
    await ensure(ctx, true);
    e = ctx.store.byUid(id.trim());
  }
  if (ctx.allowedGroups && (!e?.contact || !groupsForContact(ctx, e.contact.id)?.length)) throw notFound("No matching contact in the allowed groups");
  if (!e?.contact) throw notFound(`No contact with id "${id}"`);
  return e;
}

export async function handleGet(ctx: Context, params: { id: string; includePhoto?: boolean | null }): Promise<Contact> {
  if (ctx.config.groups.length) ctx = await forRead(ctx);
  const e = await locate(ctx, params.id);
  let c: Contact = { ...e.contact! };
  const groups = groupsForContact(ctx, c.id);
  if (groups?.length) c.groups = groups;
  if (params.includePhoto) {
    if (c.photoUrl) {
      const bin = await ctx.session.client.getBinary(c.photoUrl);
      if (bin) {
        c.imageBase64 = bin.data.toString("base64");
        c.imageType = bin.contentType ?? "image/jpeg";
      }
    } else if (c.hasImage) {
      c = parseContact(e.text, { etag: e.etag, readOnly: c.readOnly, includePhoto: true });
      if (groups?.length) c.groups = groups;
    }
  }
  return c;
}

function assertWriteEnabled(ctx: Context): void {
  if (ctx.config.groups.length) throw new DavError("read_only", "Group-scoped Contacts access is read-only. CardDAV cannot enforce group membership and a contact write atomically.");
  if (ctx.config.readOnly) throw new DavError("read_only", "This plugin is configured readOnly");
}

function assertWritable(ctx: Context): void {
  assertWriteEnabled(ctx);
  const book = ctx.store.addressbook;
  if (book?.readOnly) throw new DavError("read_only", `Address book "${book.name}" is read-only`);
}

function normaliseInput(raw: ContactInput & Record<string, unknown>): ContactInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === "object" ? stripNulls(x as object) : x));
    else if (v && typeof v === "object") out[k] = stripNulls(v as object);
    else out[k] = v;
  }
  return out as ContactInput;
}

export async function handleCreate(ctx: Context, raw: ContactInput): Promise<{ contact: Contact }> {
  assertWriteEnabled(ctx);
  await ensure(ctx);
  assertWritable(ctx);
  const input = normaliseInput(raw as ContactInput & Record<string, unknown>);
  const uid = randomUUID().toUpperCase();
  const vcard = buildNewContact(input, uid);
  const book = ctx.store.addressbook!;
  const href = `${book.href}${uid}.vcf`;
  await ctx.session.client.put(href, vcard, { ifNoneMatch: "*" });
  const stored = await ctx.session.client.get(href);
  const entry = ctx.store.upsertLocal(href, stored.etag, stored.text);
  if (!entry.contact) throw new DavError("server_error", `Created card could not be parsed back: ${entry.parseError}`);
  return { contact: entry.contact };
}

function requireContactVersion(entry: Entry): string {
  const etag = entry.etag;
  if (!etag || etag.trim() !== etag || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) {
    throw new DavError("conflict", "This contact has no usable strong version tag. No write was sent. Re-read the contact before attempting a new change.");
  }
  return etag;
}

async function writeExistingContact(ctx: Context, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    // A deliberate follow-up read should not serve the snapshot tied to this attempt.
    if (error instanceof DavError && ["conflict", "write_unconfirmed", "not_found"].includes(error.code)) {
      ctx.store.reset();
    }
    throw error;
  }
}

export async function handleUpdate(ctx: Context, raw: { id: string } & ContactInput): Promise<{ contact: Contact }> {
  assertWriteEnabled(ctx);
  const { id, ...rest } = raw;
  const input = normaliseInput(rest as ContactInput & Record<string, unknown>);
  if (Object.keys(input).length === 0) throw invalidInput("Nothing to update: provide at least one field");
  const e = await locate(ctx, id);
  assertWritable(ctx);
  const etag = requireContactVersion(e);
  const vcard = patchContact(e.text, e.contact!, input);
  await writeExistingContact(ctx, () => ctx.session.client.put(e.href, vcard, { ifMatch: etag }));
  let entry: Entry;
  try {
    const stored = await ctx.session.client.get(e.href);
    entry = ctx.store.upsertLocal(e.href, stored.etag, stored.text);
  } catch {
    ctx.store.reset();
    throw new DavError("write_unconfirmed", "The update was acknowledged, but the stored contact could not be read back. Check it before attempting another update.");
  }
  if (!entry.contact || entry.contact.id !== e.contact!.id) {
    ctx.store.reset();
    throw new DavError("write_unconfirmed", "The update was acknowledged, but the stored contact could not be confirmed. Check it before attempting another update.");
  }
  const groups = ctx.store.groupIndex().get(entry.contact.id);
  return { contact: groups?.length ? { ...entry.contact, groups } : entry.contact };
}

export async function handleDelete(ctx: Context, params: { id: string }): Promise<{ deleted: true; id: string; fullName: string }> {
  assertWriteEnabled(ctx);
  const e = await locate(ctx, params.id);
  assertWritable(ctx);
  const etag = requireContactVersion(e);
  await writeExistingContact(ctx, () => ctx.session.client.delete(e.href, { ifMatch: etag }));
  const fullName = e.contact!.fullName;
  ctx.store.removeLocal(e.href);
  // Also drop membership from cached groups so results are consistent before next sync.
  return { deleted: true, id: e.contact!.id, fullName };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface GroupsParams {
  action: "list" | "members" | "create" | "add" | "remove" | "delete";
  group?: string | null;
  name?: string | null;
  contactIds?: string[] | null;
  limit?: number | null;
}

export async function handleGroups(ctx: Context, raw: GroupsParams) {
  const p = stripNulls(raw);
  if (p.action === "list" || p.action === "members") ctx = await forRead(ctx);
  else {
    assertWriteEnabled(ctx);
    await ensure(ctx);
  }
  switch (p.action) {
    case "list": {
      const groups = allowedGroups(ctx).sort((a, b) => a.name.localeCompare(b.name));
      return { count: groups.length, groups: groups.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberIds.length })) };
    }
    case "members": {
      if (!p.group) throw invalidInput("group is required for members");
      const g = resolveGroup(ctx, p.group);
      const members = visibleContacts(ctx, g).sort(sortByName);
      const limit = p.limit ?? ctx.config.defaultLimit;
      return { group: { id: g.id, name: g.name }, matched: members.length, count: Math.min(members.length, limit), truncated: members.length > limit, contacts: members.slice(0, limit).map(toBrief) };
    }
    case "create": {
      assertWritable(ctx);
      if (!p.name || !p.name.trim()) throw invalidInput("name is required for create");
      const uid = randomUUID().toUpperCase();
      const book = ctx.store.addressbook!;
      const href = `${book.href}${uid}.vcf`;
      const ids = await validContactIds(ctx, p.contactIds ?? []);
      await ctx.session.client.put(href, buildGroupCard(p.name.trim(), uid, ids), { ifNoneMatch: "*" });
      const stored = await ctx.session.client.get(href);
      const entry = ctx.store.upsertLocal(href, stored.etag, stored.text);
      return { created: true, group: entry.group ? { id: entry.group.id, name: entry.group.name, memberCount: entry.group.memberIds.length } : { id: uid, name: p.name } };
    }
    case "add":
    case "remove": {
      assertWritable(ctx);
      if (!p.group) throw invalidInput(`group is required for ${p.action}`);
      if (!p.contactIds?.length) throw invalidInput(`contactIds is required for ${p.action}`);
      const g = resolveGroup(ctx, p.group);
      const ids = await validContactIds(ctx, p.contactIds);
      const entry = ctx.store.groupEntries().find((e) => e.group!.id === g.id)!;
      const current = new Set(g.memberIds);
      for (const id of ids) p.action === "add" ? current.add(id) : current.delete(id);
      const vcard = setGroupMembers(entry.text, [...current]);
      try {
        await ctx.session.client.put(entry.href, vcard, entry.etag ? { ifMatch: entry.etag } : {});
      } catch (err) {
        if (err instanceof DavError && err.code === "conflict") {
          const fresh = await ctx.session.client.get(entry.href);
          const fe = ctx.store.upsertLocal(entry.href, fresh.etag, fresh.text);
          const cur2 = new Set(fe.group?.memberIds ?? []);
          for (const id of ids) p.action === "add" ? cur2.add(id) : cur2.delete(id);
          await ctx.session.client.put(entry.href, setGroupMembers(fe.text, [...cur2]), fe.etag ? { ifMatch: fe.etag } : {});
        } else throw err;
      }
      const stored = await ctx.session.client.get(entry.href);
      const updated = ctx.store.upsertLocal(entry.href, stored.etag, stored.text);
      return { updated: true, group: { id: g.id, name: g.name, memberCount: updated.group?.memberIds.length ?? current.size } };
    }
    case "delete": {
      assertWritable(ctx);
      if (!p.group) throw invalidInput("group is required for delete");
      const g = resolveGroup(ctx, p.group);
      const entry = ctx.store.groupEntries().find((e) => e.group!.id === g.id)!;
      await ctx.session.client.delete(entry.href, entry.etag ? { ifMatch: entry.etag } : {});
      ctx.store.removeLocal(entry.href);
      return { deleted: true, group: { id: g.id, name: g.name } };
    }
    default:
      throw invalidInput(`Unknown action "${String((p as { action?: unknown }).action)}"`);
  }
}

async function validContactIds(ctx: Context, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const e = ctx.store.byUid(id.trim());
    if (!e || !e.contact) throw notFound(`No contact with id "${id}"`);
    out.push(e.contact.id);
  }
  return out;
}

export { extractUid };
