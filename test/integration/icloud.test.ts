/**
 * Live integration test against a real iCloud account. Opt-in:
 *
 *   ICLOUD_INTEGRATION=1 ICLOUD_TEST_APPLE_ID=you@icloud.com \
 *   ICLOUD_TEST_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npm run test:integration
 *
 * Reads the whole address book (nothing is printed), then creates, updates,
 * fetches and deletes one "[openclaw-test]" contact and one temporary group.
 */
import { afterAll, describe, expect, it } from "vitest";
import { DavClient } from "../../src/dav/client.js";
import { Session } from "../../src/dav/discovery.js";
import { createContext, handleCreate, handleDelete, handleGet, handleGroups, handleList, handleSearch, handleUpdate, type Context } from "../../src/tools/handlers.js";
import { parseVCard, serializeVCard } from "../../src/vcard/component.js";
import { cardToContact, isGroupCard } from "../../src/vcard/contact.js";

const enabled = process.env.ICLOUD_INTEGRATION === "1" && !!process.env.ICLOUD_TEST_APPLE_ID && !!process.env.ICLOUD_TEST_APP_PASSWORD;

describe.skipIf(!enabled)("live iCloud CardDAV", () => {
  const client = new DavClient({ serverUrl: "https://contacts.icloud.com", username: process.env.ICLOUD_TEST_APPLE_ID!, password: process.env.ICLOUD_TEST_APP_PASSWORD! });
  const ctx: Context = createContext(new Session(client), { appleId: "", appPassword: "", serverUrl: "https://contacts.icloud.com", readOnly: false, groups: [], defaultLimit: 25, maxContacts: 20_000 });
  let contactId: string | undefined;
  let groupName: string | undefined;

  afterAll(async () => {
    if (contactId) await handleDelete(ctx, { id: contactId }).catch(() => undefined);
    if (groupName) await handleGroups(ctx, { action: "delete", group: groupName }).catch(() => undefined);
  });

  it("syncs the whole address book and every card round-trips through the parser", async () => {
    const t0 = Date.now();
    const res = await handleList(ctx, { limit: 1 });
    const ms = Date.now() - t0;
    expect(res.totalContacts).toBeGreaterThan(0);
    expect(res.unparseableCards ?? 0).toBe(0);
    // Fidelity: parse -> serialize -> parse yields the same Contact JSON for every card
    let mismatches = 0;
    let withPhotoUri = 0;
    let withGroupsLabels = 0;
    for (const e of ctx.store.contacts()) {
      const card = parseVCard(e.text);
      const again = parseVCard(serializeVCard(card));
      const a = cardToContact(card, { readOnly: false });
      const b = cardToContact(again, { readOnly: false });
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatches++;
      if (a.photoUrl) withPhotoUri++;
      if (card.props.some((p) => p.name === "X-ABLABEL")) withGroupsLabels++;
    }
    console.log(`synced ${res.totalContacts} contacts, ${res.groups} groups in ${ms}ms; photoUri=${withPhotoUri}; labeled=${withGroupsLabels}; roundtrip mismatches=${mismatches}`);
    expect(mismatches).toBe(0);
    expect(ctx.store.contacts().filter((e) => isGroupCard(parseVCard(e.text))).length).toBe(0);
    // Delta sync is a single cheap REPORT
    const t1 = Date.now();
    await handleList(ctx, { limit: 1 });
    console.log(`delta refresh: ${Date.now() - t1}ms`);
  });

  it("creates, searches, updates, fetches and deletes a contact", async () => {
    const created = await handleCreate(ctx, {
      givenName: "Openclaw",
      familyName: "[openclaw-test]",
      organization: "OpenClaw Test Org",
      emails: [
        { label: "work", value: "openclaw-test@example.com" },
        { label: "Newsletter", value: "openclaw-news@example.com" },
      ],
      phones: [{ label: "mobile", value: "+1 (555) 010-0100" }],
      addresses: [{ label: "home", street: "1 Test Way", city: "Seattle", state: "WA", postalCode: "98101", country: "United States", countryCode: "us" }],
      birthday: { month: 2, day: 29 },
      dates: [{ label: "anniversary", year: 2020, month: 6, day: 15 }],
      relations: [{ label: "spouse", name: "Test Spouse" }],
      socialProfiles: [{ service: "github", username: "openclaw-test" }],
      notes: "safe to delete",
    });
    contactId = created.contact.id;
    expect(created.contact.fullName).toBe("Openclaw [openclaw-test]");
    expect(created.contact.emails.map((e) => e.label)).toEqual(["work", "Newsletter"]);
    expect(created.contact.addresses[0]).toMatchObject({ label: "home", city: "Seattle", countryCode: "us" });
    expect(created.contact.birthday).toEqual({ month: 2, day: 29 });
    expect(created.contact.dates).toEqual([{ label: "anniversary", year: 2020, month: 6, day: 15 }]);
    expect(created.contact.relations).toEqual([{ label: "spouse", name: "Test Spouse" }]);
    expect(created.contact.etag).toBeTruthy();

    const found = await handleSearch(ctx, { query: "openclaw-news@example.com", field: "email" });
    expect(found.contacts.map((c) => c.id)).toContain(contactId);
    const byPhone = await handleSearch(ctx, { query: "5550100100", field: "phone" });
    expect(byPhone.contacts.map((c) => c.id)).toContain(contactId);

    const upd = await handleUpdate(ctx, { id: contactId, jobTitle: "Tester", phones: [{ label: "iPhone", value: "+1 555 010 0101" }], notes: "" });
    expect(upd.contact.jobTitle).toBe("Tester");
    expect(upd.contact.phones).toEqual([{ label: "iPhone", value: "+1 555 010 0101" }]);
    expect(upd.contact.notes).toBeUndefined();
    expect(upd.contact.emails.length).toBe(2);

    const got = await handleGet(ctx, { id: contactId });
    expect(got.jobTitle).toBe("Tester");
    expect(got.socialProfiles[0]).toMatchObject({ service: "github", username: "openclaw-test" });

    const del = await handleDelete(ctx, { id: contactId });
    expect(del.deleted).toBe(true);
    contactId = undefined;
  });

  it("creates a group, adds/removes a member, deletes it", async () => {
    const c = await handleCreate(ctx, { givenName: "Openclaw", familyName: "[openclaw-test] member" });
    contactId = c.contact.id;
    groupName = `[openclaw-test] group ${Date.now()}`;
    const g = await handleGroups(ctx, { action: "create", name: groupName, contactIds: [contactId] });
    expect(g).toMatchObject({ created: true });
    const members = (await handleGroups(ctx, { action: "members", group: groupName })) as { contacts: { id: string }[] };
    expect(members.contacts.map((x) => x.id)).toEqual([contactId]);
    const got = await handleGet(ctx, { id: contactId });
    expect(got.groups).toContain(groupName);
    await handleGroups(ctx, { action: "remove", group: groupName, contactIds: [contactId] });
    const after = (await handleGroups(ctx, { action: "members", group: groupName })) as { contacts: { id: string }[] };
    expect(after.contacts.length).toBe(0);
    await handleGroups(ctx, { action: "delete", group: groupName });
    groupName = undefined;
    await handleDelete(ctx, { id: contactId });
    contactId = undefined;
  });
});
