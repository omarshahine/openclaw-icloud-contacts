/**
 * Plugin configuration after OpenClaw prepares any password SecretRef.
 */

import { DavError } from "./errors.js";

export interface SecretRef {
  source: "env" | "file" | "exec" | "store";
  provider: string;
  id: string;
}

export interface RawPluginConfig {
  appleId?: string;
  appPassword?: string | SecretRef;
  serverUrl?: string;
  readOnly?: boolean;
  groups?: string[];
  defaultLimit?: number;
  maxContacts?: number;
}

export interface ResolvedConfig {
  appleId: string;
  appPassword: string;
  serverUrl: string;
  readOnly: boolean;
  /** Restrict visible contacts to members of these group names (empty = all) */
  groups: string[];
  defaultLimit: number;
  maxContacts: number;
}

export const DEFAULT_SERVER_URL = "https://contacts.icloud.com";

/** Expand the legacy single-variable string form against the same injected environment. */
function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
  return match ? env[match[1]] ?? "" : value;
}

function readPassword(explicit: unknown, env: NodeJS.ProcessEnv): string {
  // An explicit input is authoritative; an unresolved provider must never become
  // a different ambient credential. Only OpenClaw resolves provider objects.
  const raw = explicit === undefined ? env.ICLOUD_APP_PASSWORD : explicit;
  const candidate = typeof raw === "string" ? expandEnv(raw, env) : "";
  if (!candidate.trim() || /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(candidate.trim())) {
    throw new DavError("not_configured", "appPassword is missing or unresolved. Configure ICLOUD_APP_PASSWORD or use an appPassword SecretRef prepared by OpenClaw.");
  }
  return candidate;
}

export function resolveConfig(raw: RawPluginConfig | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const appleId = (typeof raw?.appleId === "string" && expandEnv(raw.appleId, env)) || env.ICLOUD_APPLE_ID || "";
  if (!appleId) throw new DavError("not_configured", "appleId is not configured (set plugin config appleId or ICLOUD_APPLE_ID)");
  const appPassword = readPassword(raw?.appPassword, env);

  const serverUrl = raw?.serverUrl?.trim() || DEFAULT_SERVER_URL;
  try {
    new URL(serverUrl);
  } catch {
    throw new DavError("not_configured", `serverUrl "${serverUrl}" is not a valid URL`);
  }

  const groups = Array.isArray(raw?.groups) ? raw!.groups.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim()) : [];
  const defaultLimit = clampInt(raw?.defaultLimit, 1, 500, 25);
  const maxContacts = clampInt(raw?.maxContacts, 100, 50_000, 10_000);
  return { appleId, appPassword, serverUrl, readOnly: raw?.readOnly === true, groups, defaultLimit, maxContacts };
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : dflt;
}
