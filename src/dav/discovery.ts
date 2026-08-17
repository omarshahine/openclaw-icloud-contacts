/**
 * CardDAV discovery: principal -> addressbook-home-set -> addressbooks.
 *
 * iCloud: PROPFIND https://contacts.icloud.com/ (Depth 0) returns a relative
 * current-user-principal; the principal's addressbook-home-set is an absolute
 * URL on the per-account partition host pNN-contacts.icloud.com. Never
 * hardcode the partition. Exactly one addressbook ("card") in practice.
 */

import { DavError } from "../errors.js";
import type { DavClient } from "./client.js";
import { NS, childOf, findAll, okProp, propfindBody, textOf, type XmlNode } from "./xml.js";

export interface AddressbookInfo {
  /** Last path segment, e.g. "card" */
  id: string;
  name: string;
  /** Absolute URL, trailing slash */
  href: string;
  readOnly: boolean;
  ctag?: string;
  syncToken?: string;
  maxResourceSize?: number;
}

export function idFromHref(href: string): string {
  const parts = href.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? "");
}

export async function discoverPrincipal(client: DavClient): Promise<string> {
  const { responses, url } = await client.propfind(client.serverUrl, propfindBody([{ ns: NS.DAV, local: "current-user-principal" }]), "0");
  for (const r of responses) {
    const prop = okProp(r);
    const cup = prop && childOf(prop, NS.DAV, "current-user-principal");
    const href = cup && textOf(childOf(cup, NS.DAV, "href"));
    if (href) return client.resolve(href, url);
  }
  throw new DavError("server_error", "Could not discover current-user-principal from the CardDAV server");
}

export async function discoverHomeSet(client: DavClient, principalUrl: string): Promise<string> {
  const { responses, url } = await client.propfind(principalUrl, propfindBody([{ ns: NS.CARDDAV, local: "addressbook-home-set" }]), "0");
  for (const r of responses) {
    const prop = okProp(r);
    const hs = prop && childOf(prop, NS.CARDDAV, "addressbook-home-set");
    const href = hs && textOf(childOf(hs, NS.DAV, "href"));
    if (href) return ensureTrailingSlash(client.resolve(href, url));
  }
  throw new DavError("server_error", "Could not discover addressbook-home-set from the CardDAV server");
}

const ADDRESSBOOK_PROPS = [
  { ns: NS.DAV, local: "resourcetype" },
  { ns: NS.DAV, local: "displayname" },
  { ns: NS.DAV, local: "current-user-privilege-set" },
  { ns: NS.DAV, local: "sync-token" },
  { ns: NS.CS, local: "getctag" },
  { ns: NS.CARDDAV, local: "max-resource-size" },
];

export async function listAddressbooks(client: DavClient, homeUrl: string): Promise<AddressbookInfo[]> {
  const { responses, url: base } = await client.propfind(homeUrl, propfindBody(ADDRESSBOOK_PROPS), "1");
  const out: AddressbookInfo[] = [];
  for (const r of responses) {
    const prop = okProp(r);
    if (!prop) continue;
    const rt = childOf(prop, NS.DAV, "resourcetype");
    if (!rt || !childOf(rt, NS.CARDDAV, "addressbook")) continue;
    const href = ensureTrailingSlash(client.resolve(r.href, base));
    const max = parseInt(textOf(childOf(prop, NS.CARDDAV, "max-resource-size")), 10);
    out.push({
      id: idFromHref(href),
      name: textOf(childOf(prop, NS.DAV, "displayname")) || idFromHref(href),
      href,
      readOnly: !canWrite(childOf(prop, NS.DAV, "current-user-privilege-set")),
      ctag: textOf(childOf(prop, NS.CS, "getctag")) || undefined,
      syncToken: textOf(childOf(prop, NS.DAV, "sync-token")) || undefined,
      maxResourceSize: Number.isFinite(max) ? max : undefined,
    });
  }
  return out;
}

/** Cheap freshness probe: current ctag + sync-token of one collection. */
export async function fetchCollectionState(client: DavClient, href: string): Promise<{ ctag?: string; syncToken?: string }> {
  const { responses } = await client.propfind(
    href,
    propfindBody([
      { ns: NS.CS, local: "getctag" },
      { ns: NS.DAV, local: "sync-token" },
    ]),
    "0",
  );
  for (const r of responses) {
    const prop = okProp(r);
    if (!prop) continue;
    return { ctag: textOf(childOf(prop, NS.CS, "getctag")) || undefined, syncToken: textOf(childOf(prop, NS.DAV, "sync-token")) || undefined };
  }
  return {};
}

function canWrite(privSet: XmlNode | undefined): boolean {
  if (!privSet) return true;
  const privs = findAll(privSet, NS.DAV, "privilege");
  if (privs.length === 0) return true;
  return privs.some((p) => p.children.some((c) => c.ns === NS.DAV && (c.local === "write" || c.local === "write-content" || c.local === "all")));
}

function ensureTrailingSlash(u: string): string {
  return u.endsWith("/") ? u : u + "/";
}

/** Caches discovery for the plugin lifetime; invalidate on stale-URL errors. */
export class Session {
  readonly client: DavClient;
  private homeUrl?: string;
  private books?: AddressbookInfo[];
  private inflight?: Promise<AddressbookInfo[]>;

  constructor(client: DavClient) {
    this.client = client;
  }

  invalidate(): void {
    this.homeUrl = undefined;
    this.books = undefined;
    this.inflight = undefined;
  }

  async getAddressbooks(force = false): Promise<AddressbookInfo[]> {
    if (!force && this.books) return this.books;
    if (!force && this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        if (!this.homeUrl || force) {
          const principal = await discoverPrincipal(this.client);
          this.homeUrl = await discoverHomeSet(this.client, principal);
        }
        this.books = await listAddressbooks(this.client, this.homeUrl);
        return this.books;
      } catch (e) {
        this.homeUrl = undefined;
        this.books = undefined;
        throw e;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  /** The primary addressbook (iCloud has exactly one, "card"). */
  async getPrimary(): Promise<AddressbookInfo> {
    const books = await this.getAddressbooks();
    const primary = books.find((b) => b.id === "card") ?? books[0];
    if (!primary) throw new DavError("not_found", "No addressbook found for this account");
    return primary;
  }
}
