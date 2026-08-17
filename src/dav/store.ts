/**
 * In-memory address book cache kept fresh with RFC 6578 sync-collection.
 *
 * iCloud's addressbook-query is unreliable for filtering (silent anyof
 * downgrade, case-sensitive matching), so search runs client-side over this
 * cache. A full first sync of ~600 cards takes a few seconds; every later
 * refresh is one small REPORT that returns only changed hrefs.
 */

import { DavError } from "../errors.js";
import type { DavClient } from "./client.js";
import type { AddressbookInfo, Session } from "./discovery.js";
import { NS, childOf, multigetBody, okProp, parseSyncToken, syncCollectionBody, textOf } from "./xml.js";
import { cardToContact, cardToGroup, isGroupCard, type Contact, type GroupCard } from "../vcard/contact.js";
import { parseVCard } from "../vcard/component.js";

export interface Entry {
  href: string;
  etag?: string;
  text: string;
  contact?: Contact;
  group?: GroupCard;
  parseError?: string;
}

export interface StoreOptions {
  readOnly: boolean;
  maxContacts: number;
  /** Do not re-sync more often than this (ms) */
  minRefreshIntervalMs: number;
  multigetChunk: number;
}

const DEFAULTS: StoreOptions = { readOnly: false, maxContacts: 10_000, minRefreshIntervalMs: 10_000, multigetChunk: 100 };

export class ContactStore {
  readonly session: Session;
  readonly opts: StoreOptions;
  private entries = new Map<string, Entry>();
  private syncToken?: string;
  private lastRefreshAt = 0;
  private inflight?: Promise<void>;
  private book?: AddressbookInfo;
  private uidIndex = new Map<string, string>(); // uid -> href

  constructor(session: Session, opts: Partial<StoreOptions> = {}) {
    this.session = session;
    this.opts = { ...DEFAULTS, ...opts };
  }

  private get client(): DavClient {
    return this.session.client;
  }

  /** Force a full resync next time (e.g. after discovery invalidation). */
  reset(): void {
    this.entries.clear();
    this.uidIndex.clear();
    this.syncToken = undefined;
    this.lastRefreshAt = 0;
    this.book = undefined;
  }

  get addressbook(): AddressbookInfo | undefined {
    return this.book;
  }

  get size(): number {
    return this.entries.size;
  }

  async refresh(force = false): Promise<void> {
    if (!force && this.syncToken && Date.now() - this.lastRefreshAt < this.opts.minRefreshIntervalMs) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        this.book = await this.session.getPrimary();
        try {
          await this.syncOnce();
        } catch (e) {
          // Invalid/expired token (iCloud answers 412 or 403): full resync once.
          if (this.syncToken && e instanceof DavError && (e.status === 412 || e.status === 403 || e.code === "conflict")) {
            this.reset();
            this.book = await this.session.getPrimary();
            await this.syncOnce();
          } else throw e;
        }
        this.lastRefreshAt = Date.now();
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private async syncOnce(): Promise<void> {
    const book = this.book!;
    const { responses, text } = await this.client.report(book.href, syncCollectionBody(this.syncToken), "1");
    const newToken = parseSyncToken(text);
    const toFetch: string[] = [];
    const bookPath = new URL(book.href).pathname.replace(/\/+$/, "");
    for (const r of responses) {
      const href = this.client.resolve(r.href, book.href);
      // iCloud lists the collection itself (without trailing slash); skip it and anything that is not a member resource.
      const path = new URL(href).pathname.replace(/\/+$/, "");
      if (path === bookPath || !path.startsWith(bookPath + "/")) continue;
      if (r.status === 404 || (r.propstats.length > 0 && r.propstats.every((p) => p.status === 404))) {
        this.removeLocal(href);
        continue;
      }
      const prop = okProp(r);
      const etag = prop ? textOf(childOf(prop, NS.DAV, "getetag")) || undefined : undefined;
      const cur = this.entries.get(href);
      if (!cur || !etag || cur.etag !== etag) toFetch.push(href);
    }
    if (this.entries.size + toFetch.length > this.opts.maxContacts) {
      throw new DavError("server_error", `Address book has more than maxContacts (${this.opts.maxContacts}) entries; raise the limit in plugin config`);
    }
    for (let i = 0; i < toFetch.length; i += this.opts.multigetChunk) {
      const chunk = toFetch.slice(i, i + this.opts.multigetChunk);
      const { responses: got } = await this.client.report(book.href, multigetBody(chunk.map((h) => new URL(h).pathname)), "1");
      for (const r of got) {
        const href = this.client.resolve(r.href, book.href);
        const prop = okProp(r);
        if (!prop) continue;
        const data = textOf(childOf(prop, NS.CARDDAV, "address-data"));
        if (!data) continue;
        const etag = textOf(childOf(prop, NS.DAV, "getetag")) || undefined;
        this.upsertLocal(href, etag, data);
      }
    }
    if (newToken) this.syncToken = newToken;
  }

  /** Parse and cache one card. */
  upsertLocal(href: string, etag: string | undefined, text: string): Entry {
    const entry: Entry = { href, etag, text };
    try {
      const card = parseVCard(text);
      if (isGroupCard(card)) entry.group = cardToGroup(card, etag);
      else entry.contact = cardToContact(card, { etag, readOnly: this.opts.readOnly });
    } catch (e) {
      entry.parseError = e instanceof Error ? e.message : String(e);
    }
    const prev = this.entries.get(href);
    if (prev) {
      const prevUid = prev.contact?.id ?? prev.group?.id;
      if (prevUid) this.uidIndex.delete(prevUid);
    }
    this.entries.set(href, entry);
    const uid = entry.contact?.id ?? entry.group?.id;
    if (uid) this.uidIndex.set(uid, href);
    return entry;
  }

  removeLocal(href: string): void {
    const prev = this.entries.get(href);
    if (!prev) return;
    const uid = prev.contact?.id ?? prev.group?.id;
    if (uid) this.uidIndex.delete(uid);
    this.entries.delete(href);
  }

  contacts(): Entry[] {
    return [...this.entries.values()].filter((e) => e.contact);
  }

  groups(): GroupCard[] {
    return [...this.entries.values()].filter((e) => e.group).map((e) => e.group!);
  }

  groupEntries(): Entry[] {
    return [...this.entries.values()].filter((e) => e.group);
  }

  byUid(uid: string): Entry | undefined {
    const href = this.uidIndex.get(uid);
    return href ? this.entries.get(href) : undefined;
  }

  byHref(href: string): Entry | undefined {
    return this.entries.get(href);
  }

  /** Map contact uid -> group names, for decorating results. */
  groupIndex(): Map<string, string[]> {
    const idx = new Map<string, string[]>();
    for (const g of this.groups()) for (const m of g.memberIds) (idx.get(m) ?? idx.set(m, []).get(m)!).push(g.name);
    return idx;
  }

  parseErrorCount(): number {
    return [...this.entries.values()].filter((e) => e.parseError).length;
  }
}
