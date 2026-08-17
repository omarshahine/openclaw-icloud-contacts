import { beforeEach, describe, expect, it } from "vitest";
import { DavClient } from "../src/dav/client.js";
import { Session } from "../src/dav/discovery.js";
import { DavError } from "../src/errors.js";
import type { ResolvedConfig } from "../src/config.js";
import { createContext, handleCreate, handleDelete, handleGet, handleGroups, handleList, handleSearch, handleUpdate, type Context } from "../src/tools/handlers.js";
import { FakeICloud, groupCard, vcard } from "./helpers/fake-icloud.js";

function makeCtx(fake: FakeICloud, overrides: Partial<ResolvedConfig> = {}): Context {
  const config: ResolvedConfig = { appleId: fake.username, appPassword: fake.password, serverUrl: "https://contacts.icloud.com", readOnly: false, groups: [], defaultLimit: 25, maxContacts: 10_000, ...overrides };
  const client = new DavClient({ serverUrl: config.serverUrl, username: config.appleId, password: config.appPassword, fetch: fake.fetch });
  const ctx = createContext(new Session(client), config);
  ctx.store.opts.minRefreshIntervalMs = 0; // tests want every call to sync
  return ctx;
}

describe("handlers against fake iCloud CardDAV", () => {
  let fake: FakeICloud;
  let ctx: Context;

  beforeEach(() => {
    fake = new FakeICloud();
    fake.seed("A.vcf", vcard({ uid: "UID-A", given: "Alice", family: "Anders", org: "Acme", emails: [["work", "alice@acme.example"]], tels: [["mobile", "+1 (206) 555-0100"]] }));
    fake.seed("B.vcf", vcard({ uid: "UID-B", given: "Bob", family: "Brown", emails: [["home", "bob@example.com"], ["Newsletter", "bob.news@example.com"]], tels: [["iPhone", "+1 206 555 0199"]], note: "Met at party" }));
    fake.seed("C.vcf", vcard({ uid: "UID-C", given: "Carla", family: "Chen", org: "Acme" }));
    fake.seed("G1.vcf", groupCard("GRP-1", "Friends", ["UID-B", "UID-C"]));
    fake.photos.set(`${fake.cardUrl}wbs/photo-a.jpg`, { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), contentType: "image/jpeg" });
    ctx = makeCtx(fake);
  });

  it("discovers, syncs and lists contacts (brief, sorted, groups attached)", async () => {
    const res = await handleList(ctx, {});
    expect(res.totalContacts).toBe(3);
    expect(res.groups).toBe(1);
    expect(res.contacts.map((c) => c.fullName)).toEqual(["Alice Anders", "Bob Brown", "Carla Chen"]);
    expect(res.contacts[1]).toMatchObject({ id: "UID-B", emails: ["bob@example.com", "bob.news@example.com"], phones: ["+1 206 555 0199"], groups: ["Friends"] });
    expect("notes" in res.contacts[1]).toBe(false); // brief shape
    // discovery + sync + multiget happened; second call is a cheap delta
    const before = fake.log.length;
    await handleList(ctx, {});
    const delta = fake.log.slice(before);
    expect(delta.map((l) => l.method)).toEqual(["REPORT"]); // one sync-collection, no multiget
    expect(delta[0].body).toContain("<D:sync-token>tok-");
    // Auth on partition host
    expect(fake.log.filter((l) => l.url.startsWith(fake.partition)).every((l) => l.headers.authorization?.startsWith("Basic "))).toBe(true);
  });

  it("pages and filters by group and returns full records on request", async () => {
    const page = await handleList(ctx, { limit: 1, offset: 1 });
    expect(page.contacts.map((c) => c.id)).toEqual(["UID-B"]);
    expect(page.truncated).toBe(true);
    const friends = await handleList(ctx, { group: "friends", fields: "full" });
    expect(friends.contacts.map((c) => c.id)).toEqual(["UID-B", "UID-C"]);
    expect((friends.contacts[0] as { notes?: string }).notes).toBe("Met at party");
  });

  it("searches by name, email, phone digits, org", async () => {
    expect((await handleSearch(ctx, { query: "ali" })).contacts.map((c) => c.id)).toEqual(["UID-A"]);
    expect((await handleSearch(ctx, { query: "bob.news@example.com", field: "email" })).contacts.map((c) => c.id)).toEqual(["UID-B"]);
    expect((await handleSearch(ctx, { query: "206 555 0199", field: "phone" })).contacts.map((c) => c.id)).toEqual(["UID-B"]);
    expect((await handleSearch(ctx, { query: "acme", field: "org" })).contacts.map((c) => c.id)).toEqual(["UID-A", "UID-C"]);
    expect((await handleSearch(ctx, { query: "acme", group: "Friends" })).contacts.map((c) => c.id)).toEqual(["UID-C"]);
    await expect(handleSearch(ctx, { query: " " })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("gets a contact with photo on demand", async () => {
    fake.seed("P.vcf", vcard({ uid: "UID-P", given: "Pat", family: "Photo", extra: [`PHOTO;VALUE=uri:${fake.cardUrl}wbs/photo-a.jpg`] }));
    const c = await handleGet(ctx, { id: "UID-P" });
    expect(c.hasImage).toBe(true);
    expect(c.photoUrl).toBe(`${fake.cardUrl}wbs/photo-a.jpg`);
    expect(c.imageBase64).toBeUndefined();
    const withPhoto = await handleGet(ctx, { id: "UID-P", includePhoto: true });
    expect(withPhoto.imageBase64).toBe(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"));
    expect(withPhoto.imageType).toBe("image/jpeg");
    await expect(handleGet(ctx, { id: "NOPE" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("creates, updates with etag, and deletes", async () => {
    const created = await handleCreate(ctx, { givenName: "Dana", familyName: "Diaz", emails: [{ label: "work", value: "dana@x.example" }], phones: [{ label: "mobile", value: "+1 555 0100" }], notes: null });
    expect(created.contact.id).toMatch(/^[0-9A-F-]{36}$/);
    expect(created.contact.fullName).toBe("Dana Diaz");
    const put = fake.log.find((l) => l.method === "PUT")!;
    expect(put.headers["if-none-match"]).toBe("*");
    expect(put.headers["content-type"]).toContain("text/vcard");
    expect(put.url).toBe(`${fake.cardUrl}${created.contact.id}.vcf`);
    // visible in list right away (local upsert) and after sync
    expect((await handleList(ctx, {})).contacts.map((c) => c.id)).toContain(created.contact.id);

    const upd = await handleUpdate(ctx, { id: created.contact.id, jobTitle: "Engineer", phones: [{ label: "iPhone", value: "+1 555 0101" }, { label: "Batphone", value: "+1 555 0102" }] });
    expect(upd.contact.jobTitle).toBe("Engineer");
    expect(upd.contact.phones).toEqual([{ label: "iPhone", value: "+1 555 0101" }, { label: "Batphone", value: "+1 555 0102" }]);
    expect(upd.contact.emails).toEqual([{ label: "work", value: "dana@x.example" }]); // untouched
    const updatePut = fake.log.filter((l) => l.method === "PUT")[1];
    expect(updatePut.headers["if-match"]).toBe(created.contact.etag);
    await expect(handleUpdate(ctx, { id: created.contact.id })).rejects.toMatchObject({ code: "invalid_input" });

    const del = await handleDelete(ctx, { id: created.contact.id });
    expect(del).toMatchObject({ deleted: true, fullName: "Dana Diaz" });
    await expect(handleGet(ctx, { id: created.contact.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("recovers from a concurrent modification (412) once", async () => {
    await handleList(ctx, {});
    const url = `${fake.cardUrl}A.vcf`;
    let mutated = false;
    const real = fake.fetch;
    const client = new DavClient({
      serverUrl: "https://contacts.icloud.com",
      username: fake.username,
      password: fake.password,
      fetch: async (u, init) => {
        if ((init.method ?? "GET") === "PUT" && !mutated) {
          mutated = true;
          const cur = fake.objects.get(url)!;
          fake.objects.set(url, { ...cur, etag: '"changed"' });
        }
        return real(u, init);
      },
    });
    const c2 = createContext(new Session(client), ctx.config);
    c2.store.opts.minRefreshIntervalMs = 0;
    const res = await handleUpdate(c2, { id: "UID-A", nickname: "Ali" });
    expect(res.contact.nickname).toBe("Ali");
    expect(fake.log.filter((l) => l.method === "PUT").length).toBe(2);
  });

  it("manages groups: create, add, remove, members, delete", async () => {
    const created = await handleGroups(ctx, { action: "create", name: "Team", contactIds: ["UID-A"] });
    expect(created).toMatchObject({ created: true, group: { name: "Team", memberCount: 1 } });
    const gid = (created as { group: { id: string } }).group.id;
    await handleGroups(ctx, { action: "add", group: "Team", contactIds: ["UID-C"] });
    let members = await handleGroups(ctx, { action: "members", group: gid });
    expect((members as { contacts: { id: string }[] }).contacts.map((c) => c.id)).toEqual(["UID-A", "UID-C"]);
    await handleGroups(ctx, { action: "remove", group: "team", contactIds: ["UID-A"] });
    members = await handleGroups(ctx, { action: "members", group: "Team" });
    expect((members as { contacts: { id: string }[] }).contacts.map((c) => c.id)).toEqual(["UID-C"]);
    const list = await handleGroups(ctx, { action: "list" });
    expect((list as { groups: { name: string }[] }).groups.map((g) => g.name)).toEqual(["Friends", "Team"]);
    await handleGroups(ctx, { action: "delete", group: "Team" });
    expect(((await handleGroups(ctx, { action: "list" })) as { count: number }).count).toBe(1);
    await expect(handleGroups(ctx, { action: "add", group: "Nope", contactIds: ["UID-A"] })).rejects.toMatchObject({ code: "not_found" });
  });

  it("honours the group allowlist and readOnly", async () => {
    const scoped = makeCtx(fake, { groups: ["Friends"] });
    expect((await handleList(scoped, {})).contacts.map((c) => c.id)).toEqual(["UID-B", "UID-C"]);
    await expect(handleGet(scoped, { id: "UID-A" })).rejects.toMatchObject({ code: "not_found" });
    const ro = makeCtx(fake, { readOnly: true });
    await expect(handleCreate(ro, { givenName: "X" })).rejects.toMatchObject({ code: "read_only" });
    await expect(handleDelete(ro, { id: "UID-A" })).rejects.toMatchObject({ code: "read_only" });
    expect((await handleGet(ro, { id: "UID-A" })).readOnly).toBe(true);
  });

  it("picks up server-side changes and deletions via sync deltas, and survives an expired token", async () => {
    await handleList(ctx, {});
    fake.seed("D.vcf", vcard({ uid: "UID-D", given: "Dee", family: "Delta" }));
    fake.objects.delete(`${fake.cardUrl}C.vcf`);
    fake.deleted.set(`${fake.cardUrl}C.vcf`, 999);
    let ids = (await handleList(ctx, {})).contacts.map((c) => c.id);
    expect(ids).toEqual(["UID-A", "UID-B", "UID-D"]);
    fake.expireTokenOnce = true;
    fake.seed("E.vcf", vcard({ uid: "UID-E", given: "Eve", family: "Evans" }));
    ids = (await handleList(ctx, {})).contacts.map((c) => c.id);
    expect(ids).toEqual(["UID-A", "UID-B", "UID-D", "UID-E"]);
  });

  it("maps auth failures without leaking credentials and retries 5xx once", async () => {
    const bad = makeCtx(fake, { appPassword: "wrong" });
    const err = await handleList(bad, {}).catch((e) => e);
    expect(err).toBeInstanceOf(DavError);
    expect(err.code).toBe("auth_failed");
    expect(err.message).not.toContain("wrong");
    fake.failNext = { method: "PROPFIND", status: 503 };
    expect((await handleList(ctx, {})).totalContacts).toBe(3);
  });

  it("tolerates null for unused optional params", async () => {
    const res = await handleCreate(ctx, { givenName: "Nul", familyName: null, organization: null, emails: null, phones: [{ label: null, value: "+1 555 0000" }], birthday: null, dates: null, notes: null } as never);
    expect(res.contact.fullName).toBe("Nul");
    expect(res.contact.phones).toEqual([{ label: "other", value: "+1 555 0000" }]);
    const listed = await handleList(ctx, { limit: null, offset: null, group: null, fields: null });
    expect(listed.contacts.length).toBeGreaterThan(0);
    await handleDelete(ctx, { id: res.contact.id });
  });
});
