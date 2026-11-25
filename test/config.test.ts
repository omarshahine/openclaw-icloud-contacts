import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json";
import { resolveConfig, type RawPluginConfig } from "../src/config.js";

describe("host-managed Contacts credentials", () => {
  const identity = { appleId: "contact@example.invalid" };
  const ambient = { ICLOUD_APP_PASSWORD: "ambient-test-password" };

  it("declares a native string SecretInput", () => {
    expect(manifest.configContracts.secretInputs.paths).toEqual([{ path: "appPassword", expected: "string" }]);
    expect(manifest.configSchema.properties.appPassword.oneOf[1]).toMatchObject({
      additionalProperties: false,
      properties: { source: { enum: ["env", "file", "exec", "store"] } },
    });
  });

  it("uses host-prepared password strings, legacy env strings, and omitted-password fallback", () => {
    const raw = Object.freeze({ ...identity, appPassword: "host-prepared-test-password" });
    expect(resolveConfig(raw, ambient).appPassword).toBe(raw.appPassword);
    expect(resolveConfig({ appleId: "$" + "{TEST_ID}", appPassword: "$" + "{TEST_PASSWORD}" }, {
      TEST_ID: identity.appleId, TEST_PASSWORD: "fixture",
    })).toMatchObject({ appleId: identity.appleId, appPassword: "fixture" });
    expect(resolveConfig(identity, ambient).appPassword).toBe(ambient.ICLOUD_APP_PASSWORD);
  });

  it.each(["env", "file", "exec", "store"] as const)("fails closed on unresolved %s refs", (source) => {
    const appPassword = { source, provider: "fixture-provider", id: "fixture-private-id" };
    expect(() => resolveConfig({ ...identity, appPassword }, ambient)).toThrow(expect.objectContaining({
      code: "not_configured", message: expect.not.stringMatching(/fixture-private-id|ambient-test-password/),
    }));
  });

  it.each([null, {}, 42, "", "   ", "$" + "{MISSING_CONTACTS_TEST_PASSWORD}", "$MISSING_CONTACTS_TEST_PASSWORD"])(
    "does not substitute an ambient password for explicit invalid value %j", (appPassword) => {
      expect(() => resolveConfig({ ...identity, appPassword } as RawPluginConfig, ambient))
        .toThrow(expect.objectContaining({ code: "not_configured" }));
    },
  );
});
