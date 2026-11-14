/**
 * Thin WebDAV (CardDAV) HTTP client over global fetch.
 *
 * - HTTP Basic auth (Apple ID + app-specific password) over TLS
 * - Manual redirect following so the Authorization header survives the
 *   caldav.icloud.com -> pNN-caldav.icloud.com hop (fetch strips auth on
 *   cross-origin redirects when following automatically)
 * - One retry on 5xx / network failure for read/discovery requests only
 * - Maps HTTP status to typed DavError codes; never echoes credentials
 */

import { DavError } from "../errors.js";
import { parseMultiStatus, type MultiStatusResponse } from "./xml.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  serverUrl: string;
  username: string;
  password: string;
  fetch?: FetchLike;
  /** Milliseconds; default 30s */
  timeoutMs?: number;
  /** Maximum decoded DAV response bytes; default 32 MiB. */
  maxResponseBytes?: number;
  userAgent?: string;
}

export interface DavResponse {
  status: number;
  headers: Headers;
  text: string;
  /** Final URL after redirects */
  url: string;
}

const MAX_REDIRECTS = 5;

/**
 * Registrable-domain heuristic: the last two labels, or three for
 * two-part public suffixes such as .com.cn / .co.uk.
 */
export function baseDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split(".");
  if (parts.length <= 2) return parts.join(".");
  const tld2 = parts.slice(-2).join(".");
  if (/^(com|co|org|net|gov|edu|ac)\.[a-z]{2}$/.test(tld2)) return parts.slice(-3).join(".");
  return tld2;
}

export class DavClient {
  readonly serverUrl: string;
  /** Credentials are only ever sent to hosts within this registrable domain (from serverUrl). */
  readonly trustedDomain: string;
  private readonly authHeader: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly maxResponseBytes: number;

  constructor(opts: ClientOptions) {
    const url = new URL(opts.serverUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new DavError("invalid_input", "serverUrl must use https (credentials are sent with HTTP Basic auth)");
    }
    this.serverUrl = url.toString();
    this.trustedDomain = baseDomain(url.hostname);
    this.authHeader = "Basic " + Buffer.from(`${opts.username}:${opts.password}`, "utf8").toString("base64");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxResponseBytes = opts.maxResponseBytes ?? 32 * 1024 * 1024;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) throw new DavError("invalid_input", "Response limit and timeout must be positive");
    this.userAgent = opts.userAgent ?? "openclaw-icloud-contacts/0.1";
  }

  /** True if credentials may be sent to this URL (same registrable domain as serverUrl, https). */
  isTrustedUrl(url: string): boolean {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && !(u.hostname === "localhost" || u.hostname === "127.0.0.1")) return false;
      const host = u.hostname.toLowerCase();
      return host === this.trustedDomain || host.endsWith("." + this.trustedDomain);
    } catch {
      return false;
    }
  }

  /** Resolve a possibly-relative href against the server or a base URL. */
  resolve(href: string, base?: string): string {
    return new URL(href, base ?? this.serverUrl).toString();
  }

  async request(
    method: string,
    url: string,
    opts: { headers?: Record<string, string>; body?: string; depth?: "0" | "1" | "infinity" } = {},
  ): Promise<DavResponse> {
    let current = url;
    let attempt = 0;
    let redirects = 0;
    const readOnly = ["GET", "PROPFIND", "REPORT", "HEAD", "OPTIONS"].includes(method);
    if (!this.isTrustedUrl(current)) {
      throw new DavError("server_error", `Refusing to send credentials to untrusted host ${safeHost(current)} (trusted: *.${this.trustedDomain})`);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const deadline = <T>(operation: Promise<T>): Promise<T> => withAbort(operation, ac.signal);
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const headers: Record<string, string> = {
          Authorization: this.authHeader,
          "User-Agent": this.userAgent,
          Accept: "*/*",
          ...(opts.depth !== undefined ? { Depth: opts.depth } : {}),
          ...(opts.body !== undefined ? { "Content-Type": "application/xml; charset=utf-8" } : {}),
          ...(opts.headers ?? {}),
        };
        let res: Response;
        try {
          res = await deadline(this.fetchImpl(current, {
            method,
            headers,
            body: opts.body,
            redirect: "manual",
            signal: ac.signal,
          }));
        } catch {
          if (readOnly && attempt === 0 && !ac.signal.aborted) {
            attempt++;
            await deadline(sleep(500));
            continue;
          }
          throw new DavError(readOnly ? "server_error" : "outcome_unknown", readOnly ? "CardDAV request failed or timed out" : "Write outcome is unknown; do not replay automatically. Reconcile server state before another write.");
        }

        if (res.status >= 300 && res.status < 400) {
          discardBody(res);
          if (!readOnly) throw new DavError("outcome_unknown", "Write redirect was not followed; reconcile server state before retrying");
          const loc = res.headers.get("location");
          if (!loc || redirects >= MAX_REDIRECTS) {
            throw new DavError("server_error", `Too many redirects or missing Location (status ${res.status})`, res.status);
          }
          redirects++;
          const next = new URL(loc, current).toString();
          if (!this.isTrustedUrl(next)) {
            throw new DavError("server_error", `Refusing to follow redirect to untrusted host ${safeHost(next)} (trusted: *.${this.trustedDomain})`);
          }
          current = next;
          continue;
        }

        if (res.status >= 500 && !readOnly) {
          discardBody(res);
          throw new DavError("outcome_unknown", "Server failed during write; reconcile server state before retrying", res.status);
        }
        if (res.status >= 500 && attempt === 0) {
          discardBody(res);
          attempt++;
          await deadline(sleep(500));
          continue;
        }

        let text: string;
        try {
          text = (await readBody(res, this.maxResponseBytes, ac.signal)).toString("utf8");
        } catch (e) {
          if (!readOnly) throw new DavError("outcome_unknown", "Write response could not be read; reconcile server state before retrying");
          if (e instanceof DavError) throw e;
          throw new DavError("server_error", "CardDAV response body could not be read");
        }
        this.throwForStatus(res.status, method, current);
        return { status: res.status, headers: res.headers, text, url: current };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private throwForStatus(status: number, method: string, url: string): void {
    if (status < 400) return;
    const path = safePath(url);
    switch (status) {
      case 401:
      case 403:
        throw new DavError(
          "auth_failed",
          "Authentication failed (HTTP " + status + "). Check the Apple ID and make sure you are using an app-specific password from appleid.apple.com, not your Apple Account password.",
          status,
        );
      case 404:
        throw new DavError("not_found", `${method} ${path}: not found`, status);
      case 412:
        throw new DavError("conflict", `${method} ${path}: precondition failed (the event changed on the server)`, status);
      case 423:
        throw new DavError("conflict", `${method} ${path}: resource is locked`, status);
      default:
        throw new DavError(
          "server_error",
          `${method} ${path}: HTTP ${status}`,
          status,
        );
    }
  }

  /** PROPFIND; `url` in the result is the final URL after redirects (resolve relative hrefs against it). */
  async propfind(url: string, body: string, depth: "0" | "1"): Promise<{ responses: MultiStatusResponse[]; url: string }> {
    const res = await this.request("PROPFIND", url, { body, depth });
    return { responses: parseMultiStatus(res.text), url: res.url };
  }

  async report(url: string, body: string, depth: "0" | "1" = "1"): Promise<{ responses: MultiStatusResponse[]; text: string }> {
    const res = await this.request("REPORT", url, { body, depth });
    return { responses: parseMultiStatus(res.text), text: res.text };
  }

  async get(url: string): Promise<{ text: string; etag?: string }> {
    const res = await this.request("GET", url, { headers: { Accept: "text/vcard, text/plain;q=0.9, */*;q=0.5" } });
    return { text: res.text, etag: res.headers.get("etag") ?? undefined };
  }

  async put(url: string, vcard: string, cond: { ifMatch?: string; ifNoneMatch?: "*" }): Promise<{ etag?: string }> {
    if (cond.ifNoneMatch !== "*") requireEtag(cond.ifMatch);
    const headers: Record<string, string> = { "Content-Type": "text/vcard; charset=utf-8" };
    if (cond.ifMatch) headers["If-Match"] = cond.ifMatch;
    if (cond.ifNoneMatch) headers["If-None-Match"] = cond.ifNoneMatch;
    const res = await this.request("PUT", url, { headers, body: vcard });
    return { etag: res.headers.get("etag") ?? undefined };
  }

  /**
   * Authenticated binary GET (photos). Credentials are sent only to trusted
   * hosts and redirects are never followed. Unsafe/oversized responses fail explicitly.
   */
  async getBinary(url: string, maxBytes = 5 * 1024 * 1024): Promise<{ data: Buffer; contentType?: string }> {
    if (!this.isTrustedUrl(url)) throw new DavError("invalid_input", "Photo URL is outside the trusted CardDAV domain");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await withAbort(this.fetchImpl(url, { method: "GET", headers: { Authorization: this.authHeader, "User-Agent": this.userAgent, Accept: "image/*,*/*;q=0.5" }, redirect: "manual", signal: ac.signal }), ac.signal);
      if (!res.ok) {
        discardBody(res);
        throw new DavError("server_error", `Photo request failed (HTTP ${res.status}); redirects are not followed`, res.status);
      }
      return { data: await readBody(res, maxBytes, ac.signal), contentType: res.headers.get("content-type")?.split(";")[0] ?? undefined };
    } catch (error) {
      if (error instanceof DavError) throw error;
      throw new DavError("server_error", "Photo request failed or timed out");
    } finally {
      clearTimeout(timer);
    }
  }

  async delete(url: string, cond: { ifMatch?: string } = {}): Promise<void> {
    requireEtag(cond.ifMatch);
    const headers: Record<string, string> = {};
    if (cond.ifMatch) headers["If-Match"] = cond.ifMatch;
    await this.request("DELETE", url, { headers });
  }
}

function discardBody(res: Response): void {
  // Cancellation is best effort; never let a stalled cleanup extend the deadline.
  void res.body?.cancel().catch(() => {});
}

function requireEtag(etag?: string): void {
  if (!etag || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) throw new DavError("conflict", "A strong ETag is required; reread the resource before writing");
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DavError("server_error", "CardDAV deadline exceeded"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readBody(res: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new DavError("invalid_input", "Body limit must be positive");
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    discardBody(res);
    throw new DavError("server_error", "CardDAV response exceeds byte limit");
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new DavError("server_error", "CardDAV response exceeds byte limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    void reader.cancel().catch(() => { /* Preserve the original body/timeout error. */ });
    reader.releaseLock();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "<invalid-url>";
  }
}

/** Path only, so error messages never include a userinfo component. */
function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return "<url>";
  }
}
