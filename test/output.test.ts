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
});
