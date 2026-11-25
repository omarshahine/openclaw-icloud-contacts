import { afterEach, expect, it, vi } from "vitest";
import plugin from "../src/index.js";
import { FakeICloud, groupCard, vcard } from "./helpers/fake-icloud.js";

type Api = Parameters<NonNullable<typeof plugin.register>>[0];
type Registered = {
  name: string;
  execute(id: string, params: Record<string, unknown>): Promise<{ content: { text: string }[] }>;
};

function register(pluginConfig: Record<string, unknown>) {
  const tools = new Map<string, Registered>();
  const logger = { info: vi.fn(), warn: vi.fn() };
  plugin.register!({ pluginConfig, logger, registerTool(tool: Registered) {
    tools.set(tool.name, tool);
  } } as unknown as Api);
  return { tools, logger, execute: async (tool: string, params: Record<string, unknown>) =>
    JSON.parse((await tools.get("icloud_contacts_" + tool)!.execute("fixture", params)).content[0].text) };
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("scopes photo outputs at the actual SDK entry and marks nested external text", async () => {
  const fake = new FakeICloud();
  const url = fake.cardUrl + "wbs/fixture.jpg";
  fake.seed("p.vcf", vcard({ uid: "P", given: "Fixture", emails: [["Custom Label", "hello@example.invalid"]], extra: ["PHOTO;VALUE=uri:" + url] }));
  fake.seed("g.vcf", groupCard("G", "Family", ["P"]));
  vi.stubGlobal("fetch", fake.fetch);
  const { execute, tools } = register({ appleId: fake.username, appPassword: fake.password, groups: ["Family"] });
  expect(tools.has("icloud_contacts_update")).toBe(false);
  const results = [
    (await execute("get", { id: "P", includePhoto: true })).contact,
    (await execute("list", { fields: "full" })).contacts[0],
    (await execute("search", { query: "Fixture", fields: "full" })).contacts[0],
  ];
  for (const c of results) {
    expect(c).toMatchObject({ id: "P", hasImage: true, etag: expect.any(String) });
    expect(c.emails[0].label).toContain("UNTRUSTED_CONTACT_DATA_");
    expect(c.emails[0].value).toContain("hello@example.invalid");
    expect(c).not.toHaveProperty("photoUrl");
    expect(c).not.toHaveProperty("imageBase64");
    expect(c).not.toHaveProperty("imageType");
  }
  expect(fake.log.some((r) => r.url === url)).toBe(false);
});

it("keeps usable photo formats and bytes intact at the unscoped SDK boundary", async () => {
  const fake = new FakeICloud();
  const url = fake.cardUrl + "wbs/fixture.jpg";
  fake.photos.set(url, { data: Buffer.from("/9j/4A==", "base64"), contentType: "image/jpeg" });
  fake.seed("ext.vcf", vcard({ uid: "External", given: "Fixture", extra: ["PHOTO;VALUE=uri:" + url] }));
  fake.seed("inline.vcf", vcard({ uid: "Inline", given: "Fixture", extra: ["PHOTO;ENCODING=b;TYPE=JPEG:/9j/4A=="] }));
  fake.seed("unknown.vcf", vcard({ uid: "Unknown", given: "Fixture", extra: ['PHOTO;ENCODING=b;TYPE="unknown format":/9j/4A=='] }));
  vi.stubGlobal("fetch", fake.fetch);
  const { execute } = register({ appleId: fake.username, appPassword: fake.password });

  const get = async (id: string) => (await execute("get", { id, includePhoto: true })).contact;
  expect(await get("External")).toMatchObject({ imageBase64: "/9j/4A==", imageType: "image/jpeg" });
  expect(await get("Inline")).toMatchObject({ imageBase64: "/9j/4A==", imageType: "jpeg" });
  expect((await get("Unknown")).imageType).toContain("UNTRUSTED_CONTACT_DATA_");
});

it("rejects unprepared credentials without using an ambient password or networking", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("ICLOUD_APP_PASSWORD", "fixture-ambient-not-used");
  const { execute, logger } = register({ appleId: "fixture@example.invalid", appPassword: { source: "store", provider: "default", id: "fixture-private-reference" } });
  const result = await execute("list", {});
  expect(result).toMatchObject({ success: false, error: { code: "not_configured" } });
  expect(JSON.stringify({ result, warnings: logger.warn.mock.calls })).not.toMatch(/fixture-private-reference|fixture-ambient-not-used/);
  expect(fetch).not.toHaveBeenCalled();
});
