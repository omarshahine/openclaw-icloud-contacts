import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json";
import { resolveConfig, type RawPluginConfig } from "../src/config.js";

describe("host-managed app password", () => {
  it("declares the password as a startup-materialized native SecretInput", () => {
    expect(manifest).toMatchObject({
      configContracts: { secretInputs: { paths: [{ path: "appPassword", expected: "string" }] } },
    });
  });

  it("accepts all four host SecretRef sources without allowing extra object fields", () => {
    const ref = manifest.configSchema.properties.appPassword.oneOf[1];
    expect(ref.properties.source.enum).toEqual(["env", "file", "exec", "store"]);
    expect(ref).toMatchObject({ additionalProperties: false, required: ["source", "provider", "id"] });
  });

  it("consumes a host-materialized credential without changing the source config", () => {
    const raw = { appleId: "dummy@example.invalid", appPassword: "DUMMY_MATERIALIZED_PASSWORD" };
    const snapshot = structuredClone(raw);
    expect(resolveConfig(raw, {}).appPassword).toBe("DUMMY_MATERIALIZED_PASSWORD");
    expect(raw).toEqual(snapshot);
  });

  it.each(["env", "file", "exec", "store"] as const)("fails closed if a %s reference was not materialized by the host", (source) => {
    const ref = { source, provider: "dummy-provider", id: "DUMMY_REF_DO_NOT_ECHO" };
    let error: unknown;
    try {
      resolveConfig({ appleId: "dummy@example.invalid", appPassword: ref }, { ICLOUD_APP_PASSWORD: "DUMMY_FALLBACK_MUST_NOT_BE_USED" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "not_configured" });
    const message = (error as Error).message;
    expect(message).not.toContain(ref.provider);
    expect(message).not.toContain(ref.id);
    expect(message).not.toContain("DUMMY_FALLBACK_MUST_NOT_BE_USED");
  });

  it.each([null, {}, { source: "unsupported", provider: "default", id: "DUMMY" }, { source: "env", id: "DUMMY" }, 42, "", "   ", "${DUMMY_UNRESOLVED}", "$DUMMY_UNRESOLVED"])("does not fall back for explicit invalid or unresolved input %j", (value) => {
    expect(() => resolveConfig({ appleId: "dummy@example.invalid", appPassword: value } as RawPluginConfig, { ICLOUD_APP_PASSWORD: "DUMMY_FALLBACK" })).toThrow(expect.objectContaining({ code: "not_configured" }));
  });

  it("uses only the supplied environment fallback when no explicit password is configured", () => {
    expect(resolveConfig(undefined, { ICLOUD_APPLE_ID: "dummy@example.invalid", ICLOUD_APP_PASSWORD: "DUMMY_LEGACY_ENV" }).appPassword).toBe("DUMMY_LEGACY_ENV");
    expect(() => resolveConfig({ appleId: "dummy@example.invalid" }, {})).toThrow(expect.objectContaining({ code: "not_configured" }));
  });
});
