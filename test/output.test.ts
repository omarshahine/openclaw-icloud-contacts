import { afterEach, expect, it, vi } from "vitest";
import plugin from "../src/index.js";
import { FakeICloud, groupCard, vcard } from "./helpers/fake-icloud.js";

type Api = Parameters<NonNullable<typeof plugin.register>>[0];
type RegisteredTool = {
  name: string;
  execute(id: string, params: Record<string, unknown>): Promise<{ content: { type: string; text?: string }[] }>;
};

afterEach(() => vi.unstubAllGlobals());

it("marks nested group/deletion/error strings at the registered tool boundary using the real SDK entry", async () => {
  const fake = new FakeICloud();
  fake.seed("a.vcf", vcard({ uid: "A", given: "Allowed", emails: [["Custom Label", "me@example.invalid"]] }));
  fake.seed("g.vcf", groupCard("G", "Family", ["A"]));
  vi.stubGlobal("fetch", fake.fetch);
  const tools = new Map<string, RegisteredTool>();
  const api = {
    pluginConfig: { appleId: fake.username, appPassword: fake.password },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
  };
  // Only the registration/context surface consumed by this plugin is needed.
  plugin.register!(api as Api);
  const execute = async (name: string, params: Record<string, unknown>) => {
    const result = await tools.get(name)!.execute("test", params);
    expect(JSON.stringify(result)).not.toContain(fake.password);
    return JSON.parse(result.content[0].text!);
  };
  const contact = await execute("icloud_contacts_get", { id: "A" });
  expect(contact.preamble).toContain("EXTERNAL and untrusted");
  expect(contact.contact.id).toBe("A");
  expect(contact.contact.emails[0].label).toContain("UNTRUSTED_CONTACT_DATA_");
  expect(contact.contact.emails[0].value).toContain("UNTRUSTED_CONTACT_DATA_");
  const group = await execute("icloud_contacts_groups", { action: "members", group: "G" });
  expect(group.group.id).toBe("G");
  expect(group.group.name).toContain("UNTRUSTED_CONTACT_DATA_");
  const deleted = await execute("icloud_contacts_delete", { id: "A" });
  expect(deleted).toMatchObject({ success: true, deleted: true, id: "A" });
  expect(deleted.fullName).toContain("UNTRUSTED_CONTACT_DATA_");
  const error = await execute("icloud_contacts_get", { id: "Remote text" });
  expect(error.success).toBe(false);
  expect(error.error.code).toBe("not_found");
  expect(error.error.message).toContain("UNTRUSTED_CONTACT_DATA_");
  expect(JSON.stringify(api.logger.info.mock.calls)).not.toContain(fake.password);
  expect(JSON.stringify(api.logger.warn.mock.calls)).not.toContain(fake.password);
});

it("reports an unresolved explicit SecretRef without exposing it or attempting network access", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const tools = new Map<string, RegisteredTool>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = {
    pluginConfig: { appleId: "dummy@example.invalid", appPassword: { source: "store", provider: "dummy", id: "DUMMY_PRIVATE_REF" } },
    logger,
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
  };
  plugin.register!(api as Api);
  const result = await tools.get("icloud_contacts_list")!.execute("test", {});
  const output = JSON.stringify({ result, logs: Object.values(logger).map((log) => log.mock.calls) });
  expect(output).toContain("not_configured");
  expect(output).not.toContain("DUMMY_PRIVATE_REF");
  expect(output).not.toContain('"provider"');
  expect(fetch).not.toHaveBeenCalled();
});

it("does not reflect a materialized password from an authentication error body into results or logs", async () => {
  const password = "DUMMY_MATERIALIZED_PASSWORD";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(`rejected ${password}`, { status: 401 })));
  const tools = new Map<string, RegisteredTool>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  plugin.register!({
    pluginConfig: { appleId: "dummy@example.invalid", appPassword: password },
    logger,
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
  } as Api);
  const result = await tools.get("icloud_contacts_list")!.execute("test", {});
  const parsed = JSON.parse(result.content[0].text!);
  expect(parsed).toMatchObject({ success: false, error: { code: "auth_failed" } });
  expect(JSON.stringify({ result, logs: Object.values(logger).map((log) => log.mock.calls) })).not.toContain(password);
});

it("retains an initial missing-email error until a new plugin registration receives the corrected config", async () => {
  vi.stubGlobal("process", Object.create(process, { env: { value: {} } }));
  const fake = new FakeICloud();
  vi.stubGlobal("fetch", fake.fetch);
  const tools = new Map<string, RegisteredTool>();
  const raw = { appleId: "", appPassword: fake.password };
  const api = {
    pluginConfig: raw,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
  };
  plugin.register!(api as Api);
  const invoke = async () => JSON.parse((await tools.get("icloud_contacts_list")!.execute("test", { limit: 1 })).content[0].text!);
  expect(await invoke()).toMatchObject({ success: false, error: { code: "not_configured", message: expect.stringContaining("appleId is not configured") } });
  raw.appleId = fake.username;
  expect(await invoke()).toMatchObject({ success: false, error: { code: "not_configured" } });
  expect(fake.log).toHaveLength(0);
  plugin.register!(api as Api);
  expect(await invoke()).toMatchObject({ count: 0, contacts: [] });
  expect(fake.log.length).toBeGreaterThan(0);
});
