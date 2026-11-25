import { beforeEach, describe, expect, it, vi } from "vitest";
import { DavClient, type ClientOptions } from "../src/dav/client.js";
import { Session } from "../src/dav/discovery.js";
import { DavError } from "../src/errors.js";
import type { ResolvedConfig } from "../src/config.js";
import { createContext, handleCreate, handleDelete, handleGet, handleGroups, handleList, handleSearch, handleUpdate, type Context } from "../src/tools/handlers.js";
import { FakeICloud, groupCard, vcard } from "./helpers/fake-icloud.js";

function makeCtx(fake: FakeICloud, overrides: Partial<ResolvedConfig> = {}, transport: Pick<ClientOptions, "fetch" | "timeoutMs"> = {}): Context {
  const config: ResolvedConfig = { appleId: fake.username, appPassword: fake.password, serverUrl: "https://contacts.icloud.com", readOnly: false, groups: [], defaultLimit: 25, maxContacts: 10_000, ...overrides };
  const client = new DavClient({ serverUrl: config.serverUrl, username: config.appleId, password: config.appPassword, fetch: fake.fetch, ...transport });
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

  it("exposes photo presence only in scoped full lists, searches and Gets, without fetching photo bytes", async () => {
    const url = fake.cardUrl + "wbs/photo-a.jpg";
    fake.seed("P.vcf", vcard({ uid: "UID-P", given: "Photo External", extra: ["PHOTO;VALUE=uri:" + url] }));
    fake.seed("I.vcf", vcard({ uid: "UID-I", given: "Photo Inline", extra: ["PHOTO;ENCODING=b;TYPE=JPEG:/9j/4A=="] }));
    fake.seed("G2.vcf", groupCard("GRP-2", "Photo Team", ["UID-P", "UID-I"]));
    const scoped = makeCtx(fake, { groups: ["Photo Team"] });
    const list = await handleList(scoped, { fields: "full" });
    const search = await handleSearch(scoped, { query: "Photo", fields: "full" });
    expect(list.contacts).toHaveLength(2);
    expect(search.contacts).toHaveLength(2);
    const inline = await handleGet(scoped, { id: "UID-I", includePhoto: true });
    const external = await handleGet(scoped, { id: "UID-P", includePhoto: true });
    for (const c of [...list.contacts, ...search.contacts, inline, external]) {
      expect(c).toMatchObject({ hasImage: true, groups: ["Photo Team"] });
      for (const field of ["photoUrl", "imageBase64", "imageType"]) expect(c).not.toHaveProperty(field);
    }
    for (const c of (await handleList(scoped, {})).contacts) expect(c).not.toHaveProperty("hasImage");
    expect(fake.log.some((req) => req.url === url)).toBe(false);
    expect((await handleGet(ctx, { id: "UID-I", includePhoto: true })).imageBase64).toBe("/9j/4A==");
    expect((await handleGet(ctx, { id: "UID-P", includePhoto: true })).imageBase64).toBe("/9j/4A==");
    expect(fake.log.filter((req) => req.url === url)).toHaveLength(1);
  });

  it("applies the request deadline while a contact listing body is still being read", async () => {
    let started: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const cancel = vi.fn();
    const fetch = vi.fn((url: string, init: RequestInit) => {
      if (init.method !== "REPORT") return fake.fetch(url, init);
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        pull() { started?.(); },
        cancel,
      }, { highWaterMark: 0 }), { status: 207 }));
    });
    const limited = makeCtx(fake, {}, { fetch, timeoutMs: 100 });

    vi.useFakeTimers();
    try {
      const result = expect(handleList(limited, {})).rejects.toMatchObject({
        code: "server_error", message: "CardDAV response body timed out",
      });
      await reading;
      await vi.advanceTimersByTimeAsync(100);
      await result;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls.filter(([, init]) => init.method === "REPORT")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an oversized listing from its headers before consuming the body", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const fetch = (url: string, init: RequestInit) => {
      if (init.method !== "REPORT") return fake.fetch(url, init);
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), {
        status: 207, headers: { "content-length": String(32 * 1024 * 1024 + 1) },
      }));
    };
    await expect(handleList(makeCtx(fake, {}, { fetch }), {})).rejects.toMatchObject({
      code: "server_error", message: "CardDAV response exceeded the 32 MiB limit",
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not return a photo beyond the streaming limit", async () => {
    const url = `${fake.cardUrl}wbs/large.jpg`;
    fake.seed("P.vcf", vcard({ uid: "UID-P", given: "Pat", family: "Photo", extra: [`PHOTO;VALUE=uri:${url}`] }));
    const cancel = vi.fn();
    let pulls = 0;
    const fetch = vi.fn((input: string, init: RequestInit) => {
      if (input !== url) return fake.fetch(input, init);
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(++pulls === 1 ? 5 * 1024 * 1024 : 1));
        },
        cancel,
      }, { highWaterMark: 0 }), { headers: { "content-type": "image/jpeg" } }));
    });
    const limited = makeCtx(fake, {}, { fetch });
    await expect(handleGet(limited, { id: "UID-P", includePhoto: true })).rejects.toMatchObject({
      code: "invalid_input", message: "Binary larger than 5 MB; not returned",
    });
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(handleGet(limited, { id: "UID-P" })).resolves.toMatchObject({ id: "UID-P", hasImage: true });
    expect(fetch.mock.calls.filter(([input]) => input === url)).toHaveLength(1);
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

    const upd = await handleUpdate(ctx, { id: created.contact.id, expectedEtag: created.contact.etag!, jobTitle: "Engineer", phones: [{ label: "iPhone", value: "+1 555 0101" }, { label: "Batphone", value: "+1 555 0102" }] });
    expect(upd.contact.jobTitle).toBe("Engineer");
    expect(upd.contact.phones).toEqual([{ label: "iPhone", value: "+1 555 0101" }, { label: "Batphone", value: "+1 555 0102" }]);
    expect(upd.contact.emails).toEqual([{ label: "work", value: "dana@x.example" }]); // untouched
    const updatePut = fake.log.filter((l) => l.method === "PUT")[1];
    expect(updatePut.headers["if-match"]).toBe(created.contact.etag);
    await expect(handleUpdate(ctx, { id: created.contact.id, expectedEtag: upd.contact.etag! })).rejects.toMatchObject({ code: "invalid_input" });

    const del = await handleDelete(ctx, { id: created.contact.id, expectedEtag: upd.contact.etag! });
    expect(del).toEqual({ deleted: true, id: created.contact.id });
    await expect(handleGet(ctx, { id: created.contact.id })).rejects.toMatchObject({ code: "not_found" });
  });

  const initialTag = () => fake.objects.get(`${fake.cardUrl}A.vcf`)!.etag;

  it.each(["PUT", "DELETE"] as const)("reports a %s conflict without replaying it", async (method) => {
    const attempts: string[] = [];
    const client = new DavClient({
      serverUrl: ctx.config.serverUrl, username: fake.username, password: fake.password,
      fetch: async (url, init) => {
        if (init.method !== method) return fake.fetch(url, init);
        attempts.push(method);
        return new Response(null, { status: 412 });
      },
    });
    const c = createContext(new Session(client), ctx.config);
    const op = method === "PUT" ? handleUpdate(c, { id: "UID-A", expectedEtag: initialTag(), nickname: "Ali" }) : handleDelete(c, { id: "UID-A", expectedEtag: initialTag() });
    await expect(op).rejects.toMatchObject({ code: "conflict", status: 412 });
    expect(attempts).toEqual([method]);
    expect(c.store.size).toBe(0); // A deliberate follow-up read must fetch a fresh snapshot.
  });

  it.each([undefined, 'W/"weak"', "*", '"one", "two"'])("does not write a contact without a single strong version (%s)", async (etag) => {
    await handleList(ctx, {});
    const href = `${fake.cardUrl}A.vcf`;
    const original = fake.objects.get(href)!;
    ctx.store.upsertLocal(href, etag, original.text);
    ctx.store.opts.minRefreshIntervalMs = Number.MAX_SAFE_INTEGER;
    await expect(handleUpdate(ctx, { id: "UID-A", expectedEtag: initialTag(), nickname: "Ali" })).rejects.toMatchObject({ code: "conflict" });
    await handleList(ctx, {});
    ctx.store.upsertLocal(href, etag, original.text);
    await expect(handleDelete(ctx, { id: "UID-A", expectedEtag: initialTag() })).rejects.toMatchObject({ code: "conflict" });
    expect(fake.log.filter((l) => l.method === "PUT" || l.method === "DELETE")).toEqual([]);
  });

  it.each([undefined, 'W/"weak"', "*", '"one", "two"', '"valid"\n'])("rejects a missing or invalid caller version (%s)", async (expectedEtag) => {
    await expect(handleDelete(ctx, { id: "UID-A", expectedEtag: expectedEtag! })).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.log).toHaveLength(0);
  });

  it("requires a fresh decision when a contact changes between review and write", async () => {
    const reviewed = await handleGet(ctx, { id: "UID-A" });
    fake.seed("A.vcf", vcard({ uid: "UID-A", given: "Alice", family: "Anders", note: "New information" }));
    const expectedEtag = reviewed.etag!;
    await expect(handleUpdate(ctx, { id: reviewed.id, expectedEtag, notes: "Older decision" })).rejects.toMatchObject({ code: "conflict" });
    await expect(handleDelete(ctx, { id: reviewed.id, expectedEtag })).rejects.toMatchObject({ code: "conflict" });
    expect(fake.log.filter((r) => r.method === "PUT" || r.method === "DELETE")).toEqual([]);
    expect((await handleGet(ctx, { id: reviewed.id })).notes).toBe("New information");
  });

  it.each([
    ["PUT", "lost"], ["PUT", 503], ["PUT", 202], ["PUT", 307],
    ["DELETE", "lost"], ["DELETE", 503],
  ] as const)("does not resend %s after an uncertain result (%s)", async (method, result) => {
    const attempts: string[] = [];
    const client = new DavClient({
      serverUrl: ctx.config.serverUrl, username: fake.username, password: fake.password,
      fetch: async (url, init) => {
        if (init.method !== method) return fake.fetch(url, init);
        attempts.push(method);
        if (result === "lost") throw new TypeError("fixture disconnected");
        return new Response(null, { status: result, headers: { Location: url } });
      },
    });
    const c = createContext(new Session(client), ctx.config);
    const op = method === "PUT" ? handleUpdate(c, { id: "UID-A", expectedEtag: initialTag(), nickname: "Ali" }) : handleDelete(c, { id: "UID-A", expectedEtag: initialTag() });
    await expect(op).rejects.toMatchObject({ code: "write_unconfirmed" });
    expect(attempts).toEqual([method]);
  });

  it("reports acknowledged update with failed readback without writing again", async () => {
    const mutations: string[] = [];
    const client = new DavClient({
      serverUrl: ctx.config.serverUrl, username: fake.username, password: fake.password,
      fetch: async (url, init) => {
        if (init.method === "PUT") mutations.push("PUT");
        if (init.method === "GET") return new Response(null, { status: 404 });
        return fake.fetch(url, init);
      },
    });
    const c = createContext(new Session(client), ctx.config);
    await expect(handleUpdate(c, { id: "UID-A", expectedEtag: initialTag(), nickname: "Ali" })).rejects.toMatchObject({ code: "write_unconfirmed" });
    expect(mutations).toEqual(["PUT"]);
    expect(c.store.size).toBe(0);
    expect(fake.objects.get(`${fake.cardUrl}A.vcf`)?.text).toContain("NICKNAME:Ali");
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
    await expect(handleDelete(ro, { id: "UID-A", expectedEtag: initialTag() })).rejects.toMatchObject({ code: "read_only" });
    expect((await handleGet(ro, { id: "UID-A" })).readOnly).toBe(true);
  });

  it("scopes contact results, counts, and group labels to verified groups", async () => {
    fake.seed("G2.vcf", groupCard("GRP-2", "Other", ["UID-A", "UID-B"]));
    const scoped = makeCtx(fake, { groups: ["Friends"] });
    const list = await handleList(scoped, {});
    expect(list).toMatchObject({ totalContacts: 2, groups: 1 });
    expect(list).not.toHaveProperty("addressbook");
    expect(list.contacts.map((c) => [c.id, c.groups])).toEqual([["UID-B", ["Friends"]], ["UID-C", ["Friends"]]]);
    expect(await handleGet(scoped, { id: "UID-B" })).toMatchObject({ readOnly: true, groups: ["Friends"] });
    expect((await handleSearch(scoped, { query: "Bob", group: "GRP-1" })).contacts).toHaveLength(1);
    expect(await handleGroups(scoped, { action: "list" })).toEqual({
      count: 1, groups: [{ id: "GRP-1", name: "Friends", memberCount: 2 }],
    });
    expect(await handleGroups(scoped, { action: "members", group: "GRP-1" })).toMatchObject({
      group: { id: "GRP-1", name: "Friends" }, matched: 2,
    });
  });

  it("denies all scoped mutations before contacting CardDAV", async () => {
    const scoped = makeCtx(fake, { groups: ["Friends"] });
    await expect(handleCreate(scoped, { givenName: "New" })).rejects.toMatchObject({ code: "read_only" });
    await expect(handleUpdate(scoped, { id: "UID-B", expectedEtag: initialTag(), nickname: "B" })).rejects.toMatchObject({ code: "read_only" });
    await expect(handleDelete(scoped, { id: "UID-B", expectedEtag: initialTag() })).rejects.toMatchObject({ code: "read_only" });
    for (const action of ["create", "add", "remove", "delete"] as const) {
      await expect(handleGroups(scoped, { action, group: "Friends", name: "New", contactIds: ["UID-B"] }))
        .rejects.toMatchObject({ code: "read_only" });
    }
    expect(fake.log).toHaveLength(0);
  });

  it("requires a complete snapshot rather than serving a previously successful scoped read", async () => {
    let incomplete = false;
    const scopedConfig = { ...ctx.config, groups: ["Friends"] };
    const client = new DavClient({
      serverUrl: scopedConfig.serverUrl, username: fake.username, password: fake.password,
      fetch: async (input, init) => {
        if (incomplete && String(init?.body).includes("addressbook-multiget")) {
          return new Response('<D:multistatus xmlns:D="DAV:"/>', { status: 207 });
        }
        return fake.fetch(input, init);
      },
    });
    const scoped = createContext(new Session(client), scopedConfig);
    expect((await handleList(scoped, {})).matched).toBe(2);
    incomplete = true;
    await expect(handleList(scoped, {})).rejects.toMatchObject({ code: "server_error" });
    incomplete = false;
    fake.seed("G1.vcf", groupCard("GRP-1", "Friends", ["UID-C"]));
    expect((await handleList(scoped, {})).contacts.map((c) => c.id)).toEqual(["UID-C"]);
  });

  it("refuses to guess when a configured group name is ambiguous or its identity changes", async () => {
    const scoped = makeCtx(fake, { groups: ["Friends"] });
    await handleList(scoped, {});
    fake.seed("G2.vcf", groupCard("GRP-2", "FRIENDS", ["UID-C"]));
    await expect(handleList(scoped, {})).rejects.toMatchObject({ code: "not_configured" });
    fake.seed("G1.vcf", groupCard("GRP-1", "Renamed", ["UID-B", "UID-C"]));
    await expect(handleList(scoped, {})).rejects.toMatchObject({ code: "not_configured" });
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
    await handleDelete(ctx, { id: res.contact.id, expectedEtag: res.contact.etag! });
  });
});
