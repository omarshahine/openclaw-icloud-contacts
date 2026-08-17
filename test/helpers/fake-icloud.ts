/**
 * In-memory fake of iCloud's CardDAV surface, driven through the client's
 * injectable fetch. Mirrors observed behaviour:
 *  - PROPFIND / (Depth 0)              -> relative current-user-principal, no redirect
 *  - PROPFIND principal (Depth 0)      -> absolute addressbook-home-set on pNN host
 *  - PROPFIND home (Depth 1)           -> one addressbook "card" (+ home collection)
 *  - REPORT sync-collection            -> full listing on empty token, deltas after
 *  - REPORT addressbook-multiget       -> etag + address-data
 *  - GET/PUT/DELETE object             -> etag + If-Match / If-None-Match
 *  - GET photo URL                     -> binary bytes (auth required)
 */

import type { FetchLike } from "../../src/dav/client.js";

interface StoredObject {
  text: string;
  etag: string;
  seq: number;
}

export interface RequestLog {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export class FakeICloud {
  readonly root = "https://contacts.icloud.com/";
  readonly partition = "https://p42-contacts.icloud.com";
  readonly principalPath = "/1234/principal/";
  readonly homePath = "/1234/carddavhome/";
  readonly cardPath = "/1234/carddavhome/card/";
  readonly log: RequestLog[] = [];
  readonly objects = new Map<string, StoredObject>(); // absolute URL -> object
  readonly deleted = new Map<string, number>(); // absolute URL -> seq at deletion
  readonly photos = new Map<string, { data: Buffer; contentType: string }>();
  private seq = 1;
  private etagCounter = 1;
  username = "user@icloud.com";
  password = "abcd-efgh-ijkl-mnop";
  readOnly = false;
  failNext?: { method: string; status: number };
  /** If true, sync-collection with a non-empty token returns 412 once (expired token) */
  expireTokenOnce = false;

  get fetch(): FetchLike {
    return async (input, init) => this.handle(input, init);
  }

  get cardUrl(): string {
    return `${this.partition}${this.cardPath}`;
  }

  seed(filename: string, text: string): string {
    const url = `${this.cardUrl}${filename}`;
    this.objects.set(url, { text, etag: `"e${this.etagCounter++}"`, seq: this.seq++ });
    return url;
  }

  private authorized(headers: Record<string, string>): boolean {
    const expected = "Basic " + Buffer.from(`${this.username}:${this.password}`).toString("base64");
    return headers.authorization === expected;
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const body = typeof init.body === "string" ? init.body : undefined;
    this.log.push({ method, url, headers, body });

    if (this.failNext && this.failNext.method === method) {
      const status = this.failNext.status;
      this.failNext = undefined;
      return new Response("simulated failure", { status });
    }
    if (!this.authorized(headers)) return new Response("Unauthorized", { status: 401 });

    const u = new URL(url);
    if (this.photos.has(url)) {
      const p = this.photos.get(url)!;
      return new Response(new Uint8Array(p.data), { status: 200, headers: { "Content-Type": p.contentType } });
    }

    if (method === "PROPFIND") {
      if (u.origin === "https://contacts.icloud.com" && u.pathname === "/") {
        return xml(207, multistatus([response("/", `<D:current-user-principal><D:href>${this.principalPath}</D:href></D:current-user-principal>`)]));
      }
      if (u.pathname === this.principalPath) {
        return xml(207, multistatus([response(this.principalPath, `<C:addressbook-home-set><D:href>${this.partition}:443${this.homePath}</D:href></C:addressbook-home-set>`)]));
      }
      if (u.origin !== this.partition) return new Response("Not found", { status: 404 });
      if (u.pathname === this.homePath) {
        if (headers.depth !== "1") return new Response("Bad Depth", { status: 400 });
        const priv = this.readOnly ? `<D:privilege><D:read/></D:privilege>` : `<D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege>`;
        return xml(
          207,
          multistatus([
            response(this.homePath, `<D:resourcetype><D:collection/></D:resourcetype><CS:getctag>${this.ctag()}</CS:getctag>`),
            response(
              this.cardPath,
              `<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype><CS:getctag>${this.ctag()}</CS:getctag><D:sync-token>${this.token()}</D:sync-token><D:current-user-privilege-set>${priv}</D:current-user-privilege-set><C:max-resource-size>563200</C:max-resource-size>`,
            ),
          ]),
        );
      }
      if (u.pathname === this.cardPath) {
        if (headers.depth === "0") return xml(207, multistatus([response(this.cardPath, `<CS:getctag>${this.ctag()}</CS:getctag><D:sync-token>${this.token()}</D:sync-token>`)]));
        const items = [response(this.cardPath, `<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>`)];
        for (const [objUrl, obj] of this.objects) items.push(response(new URL(objUrl).pathname, `<D:getetag>${esc(obj.etag)}</D:getetag>`));
        return xml(207, multistatus(items));
      }
      return new Response("Not found", { status: 404 });
    }

    if (method === "REPORT") {
      if (u.origin !== this.partition || u.pathname !== this.cardPath) return new Response("Not found", { status: 404 });
      if (headers.depth !== "1") return new Response("Bad Depth", { status: 400 });
      const b = body ?? "";
      if (b.includes("sync-collection")) {
        const m = /<D:sync-token>([^<]*)<\/D:sync-token>/.exec(b);
        const tokenIn = m?.[1] ?? "";
        const since = tokenIn ? parseInt(tokenIn.replace(/^tok-/, ""), 10) : 0;
        if (tokenIn && this.expireTokenOnce) {
          this.expireTokenOnce = false;
          return new Response("invalid sync token", { status: 412, headers: { "Content-Type": "text/plain" } });
        }
        const items: string[] = [];
        // iCloud includes the collection itself, without a trailing slash
        if (!since) items.push(response(this.cardPath.replace(/\/$/, ""), `<D:getetag>"col"</D:getetag>`));
        for (const [objUrl, obj] of this.objects) if (obj.seq > since) items.push(response(new URL(objUrl).pathname, `<D:getetag>${esc(obj.etag)}</D:getetag>`));
        for (const [objUrl, delSeq] of this.deleted) if (delSeq > since && !this.objects.has(objUrl)) items.push(`<D:response><D:href>${esc(new URL(objUrl).pathname)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`);
        return xml(207, multistatus(items, `<D:sync-token>${this.token()}</D:sync-token>`));
      }
      if (b.includes("addressbook-multiget")) {
        const hrefs = [...b.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((x) => unesc(x[1]));
        const items: string[] = [];
        for (const h of hrefs) {
          const objUrl = `${this.partition}${h}`;
          const obj = this.objects.get(objUrl);
          if (!obj) {
            items.push(`<D:response><D:href>${esc(h)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`);
            continue;
          }
          // iCloud quirk: a 404 propstat sibling next to the 200 propstat
          items.push(
            `<D:response><D:href>${esc(h)}</D:href><D:propstat><D:prop><D:getetag>${esc(obj.etag)}</D:getetag><C:address-data>${esc(obj.text)}</C:address-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat><D:propstat><D:prop><D:displayname/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>`,
          );
        }
        return xml(207, multistatus(items));
      }
      if (b.includes("addressbook-query")) {
        const m = /<C:text-match[^>]*>([^<]*)<\/C:text-match>/.exec(b);
        const needle = (m?.[1] ?? "").toLowerCase();
        const items: string[] = [];
        for (const [objUrl, obj] of this.objects) if (obj.text.toLowerCase().includes(needle)) items.push(response(new URL(objUrl).pathname, `<D:getetag>${esc(obj.etag)}</D:getetag><C:address-data>${esc(obj.text)}</C:address-data>`));
        return xml(207, multistatus(items));
      }
      return new Response("Bad report", { status: 400 });
    }

    if (method === "GET") {
      const obj = this.objects.get(url);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.text, { status: 200, headers: { ETag: obj.etag, "Content-Type": "text/plain; charset=UTF-8" } });
    }

    if (method === "PUT") {
      if (!url.startsWith(this.cardUrl)) return new Response("Not found", { status: 404 });
      if (this.readOnly) return new Response("Forbidden", { status: 403 });
      const existing = this.objects.get(url);
      if (headers["if-none-match"] === "*" && existing) return new Response("Exists", { status: 412 });
      if (headers["if-match"] && (!existing || existing.etag !== headers["if-match"])) return new Response("Precondition Failed", { status: 412 });
      const etag = `"e${this.etagCounter++}"`;
      this.objects.set(url, { text: body ?? "", etag, seq: this.seq++ });
      this.deleted.delete(url);
      return new Response(null, { status: existing ? 204 : 201, headers: { ETag: etag } });
    }

    if (method === "DELETE") {
      const existing = this.objects.get(url);
      if (!existing) return new Response("Not found", { status: 404 });
      if (headers["if-match"] && existing.etag !== headers["if-match"]) return new Response("Precondition Failed", { status: 412 });
      this.objects.delete(url);
      this.deleted.set(url, this.seq++);
      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  }

  private ctag(): string {
    return `ctag-${this.seq}`;
  }
  private token(): string {
    return `tok-${this.seq - 1}`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function unesc(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function response(href: string, props: string): string {
  return `<D:response><D:href>${esc(href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}
function multistatus(responses: string[], tail = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">${responses.join("")}${tail}</D:multistatus>`;
}
function xml(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/xml; charset=utf-8" } });
}

/** Build an Apple-style vCard for tests. */
export function vcard(fields: { uid: string; given?: string; family?: string; org?: string; emails?: [string, string][]; tels?: [string, string][]; note?: string; extra?: string[] }): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", "PRODID:-//Apple Inc.//iOS 26.0//EN", `N:${fields.family ?? ""};${fields.given ?? ""};;;`, `FN:${[fields.given, fields.family].filter(Boolean).join(" ")}`];
  if (fields.org) lines.push(`ORG:${fields.org};`);
  let item = 1;
  for (const [label, value] of fields.emails ?? []) {
    if (label === "home" || label === "work") lines.push(`EMAIL;type=INTERNET;type=${label.toUpperCase()};type=pref:${value}`);
    else lines.push(`item${item}.EMAIL;type=INTERNET:${value}`, `item${item}.X-ABLabel:${label}`), item++;
  }
  for (const [label, value] of fields.tels ?? []) {
    if (label === "mobile") lines.push(`TEL;type=CELL;type=VOICE;type=pref:${value}`);
    else if (label === "iPhone") lines.push(`TEL;type=IPHONE;type=CELL;type=VOICE:${value}`);
    else lines.push(`item${item}.TEL:${value}`, `item${item}.X-ABLabel:${label}`), item++;
  }
  if (fields.note) lines.push(`NOTE:${fields.note}`);
  lines.push(...(fields.extra ?? []));
  lines.push(`UID:${fields.uid}`, "REV:2026-08-01T12:00:00Z", "END:VCARD", "");
  return lines.join("\r\n");
}

export function groupCard(uid: string, name: string, members: string[]): string {
  return ["BEGIN:VCARD", "VERSION:3.0", `N:${name}`, `FN:${name}`, "X-ADDRESSBOOKSERVER-KIND:group", ...members.map((m) => `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${m}`), `UID:${uid}`, "END:VCARD", ""].join("\r\n");
}
