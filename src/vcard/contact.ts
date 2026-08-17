/**
 * Contact JSON <-> vCard 3.0 (Apple dialect).
 *
 * The JSON shape mirrors apple-pim's contact tool so agent skills port over.
 * Unknown properties, unknown groups, and parameter shapes are preserved on
 * update; only fields the caller supplies are rewritten.
 */

import { invalidInput } from "../errors.js";
import {
  escapeText,
  getProp,
  getProps,
  joinCompound,
  nextGroup,
  parseVCard,
  removeAll,
  removeWithGroup,
  serializeVCard,
  setSingle,
  splitCompound,
  splitList,
  unescapeText,
  type VCard,
  type VProperty,
} from "./component.js";

export const PRODID = "-//omarshahine//openclaw-icloud-contacts//EN";

export interface Labeled {
  label: string;
  value: string;
}
export interface Address {
  label: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  countryCode?: string;
}
export interface DateValue {
  label: string;
  year?: number;
  month: number;
  day: number;
}
export interface Birthday {
  year?: number;
  month: number;
  day: number;
}
export interface InstantMessage {
  label?: string;
  service: string;
  username: string;
}
export interface Relation {
  label: string;
  name: string;
}
export interface SocialProfile {
  label?: string;
  service: string;
  username?: string;
  url?: string;
}

export interface Contact {
  id: string;
  fullName: string;
  givenName?: string;
  familyName?: string;
  middleName?: string;
  namePrefix?: string;
  nameSuffix?: string;
  nickname?: string;
  phoneticGivenName?: string;
  phoneticFamilyName?: string;
  organization?: string;
  department?: string;
  jobTitle?: string;
  contactType: "person" | "organization";
  emails: Labeled[];
  phones: Labeled[];
  urls: Labeled[];
  addresses: Address[];
  instantMessages: InstantMessage[];
  relations: Relation[];
  socialProfiles: SocialProfile[];
  birthday?: Birthday;
  dates: DateValue[];
  notes?: string;
  hasImage: boolean;
  /** Present when the server stores the photo as an external URI (iCloud does) */
  photoUrl?: string;
  /** Only when explicitly requested */
  imageBase64?: string;
  imageType?: string;
  groups?: string[];
  etag?: string;
  lastModified?: string;
  readOnly: boolean;
}

/** Compact shape for list/search results. */
export interface ContactBrief {
  id: string;
  fullName: string;
  givenName?: string;
  familyName?: string;
  organization?: string;
  emails: string[];
  phones: string[];
  birthday?: Birthday;
  groups?: string[];
}

export function toBrief(c: Contact): ContactBrief {
  const b: ContactBrief = { id: c.id, fullName: c.fullName, emails: c.emails.map((e) => e.value), phones: c.phones.map((p) => p.value) };
  if (c.givenName) b.givenName = c.givenName;
  if (c.familyName) b.familyName = c.familyName;
  if (c.organization) b.organization = c.organization;
  if (c.birthday) b.birthday = c.birthday;
  if (c.groups?.length) b.groups = c.groups;
  return b;
}

/** Fields accepted by create/update. Arrays replace wholesale; null clears. */
export interface LabeledInput {
  label?: string | null;
  value: string;
}
export interface AddressInput extends Partial<Omit<Address, "label">> {
  label?: string | null;
}
export interface DateInput {
  label?: string | null;
  year?: number | null;
  month: number;
  day: number;
}
export interface BirthdayInput {
  year?: number | null;
  month: number;
  day: number;
}
export interface InstantMessageInput {
  label?: string | null;
  service: string;
  username: string;
}
export interface SocialProfileInput {
  label?: string | null;
  service: string;
  username?: string | null;
  url?: string | null;
}

export interface ContactInput {
  givenName?: string | null;
  familyName?: string | null;
  middleName?: string | null;
  namePrefix?: string | null;
  nameSuffix?: string | null;
  nickname?: string | null;
  phoneticGivenName?: string | null;
  phoneticFamilyName?: string | null;
  organization?: string | null;
  department?: string | null;
  jobTitle?: string | null;
  contactType?: "person" | "organization" | null;
  emails?: LabeledInput[] | null;
  phones?: LabeledInput[] | null;
  urls?: LabeledInput[] | null;
  addresses?: AddressInput[] | null;
  instantMessages?: InstantMessageInput[] | null;
  relations?: Relation[] | null;
  socialProfiles?: SocialProfileInput[] | null;
  birthday?: BirthdayInput | null;
  dates?: DateInput[] | null;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Apple sentinel <-> friendly label */
const SENTINELS: Record<string, string> = {
  Home: "home",
  Work: "work",
  Mobile: "mobile",
  Main: "main",
  HomePage: "homepage",
  Other: "other",
  HomeFAX: "homeFax",
  WorkFAX: "workFax",
  Pager: "pager",
  School: "school",
  Anniversary: "anniversary",
  Mother: "mother",
  Father: "father",
  Parent: "parent",
  Brother: "brother",
  Sister: "sister",
  Child: "child",
  Friend: "friend",
  Spouse: "spouse",
  Partner: "partner",
  Assistant: "assistant",
  Manager: "manager",
};
const SENTINEL_BY_LABEL: Record<string, string> = Object.fromEntries(Object.entries(SENTINELS).map(([k, v]) => [v.toLowerCase(), k]));

export function decodeLabel(raw: string): string {
  const m = /^_\$!<(.+)>!\$_$/.exec(raw.trim());
  if (m) return SENTINELS[m[1]] ?? m[1];
  return raw.trim();
}

export function encodeLabel(label: string): string {
  const s = SENTINEL_BY_LABEL[label.trim().toLowerCase()];
  return s ? `_$!<${s}>!$_` : label.trim();
}

/** Group label of a property (X-ABLabel in the same itemN group), decoded. */
function groupLabel(card: VCard, p: VProperty): string | undefined {
  if (!p.group) return undefined;
  const lab = card.props.find((q) => q.group === p.group && q.name === "X-ABLABEL");
  return lab ? decodeLabel(unescapeText(lab.value)) : undefined;
}

function types(p: VProperty): string[] {
  return (p.params.TYPE ?? []).map((t) => t.toUpperCase());
}

/** Label from TYPE params for TEL/EMAIL/URL/ADR when no X-ABLabel exists. */
function labelFromTypes(p: VProperty, kind: "tel" | "email" | "url" | "adr"): string {
  const t = types(p);
  if (kind === "tel") {
    if (t.includes("IPHONE")) return "iPhone";
    if (t.includes("FAX")) return t.includes("WORK") ? "workFax" : t.includes("HOME") ? "homeFax" : "fax";
    if (t.includes("CELL")) return "mobile";
    if (t.includes("PAGER")) return "pager";
    if (t.includes("MAIN")) return "main";
  }
  if (t.includes("HOME")) return "home";
  if (t.includes("WORK")) return "work";
  if (t.includes("OTHER")) return "other";
  return kind === "url" ? "homepage" : "other";
}

const STANDARD_TYPES: Record<string, string[]> = {
  home: ["HOME"],
  work: ["WORK"],
  mobile: ["CELL", "VOICE"],
  iphone: ["IPHONE", "CELL", "VOICE"],
  main: ["MAIN"],
  pager: ["PAGER"],
  homefax: ["HOME", "FAX"],
  workfax: ["WORK", "FAX"],
  fax: ["FAX"],
  homepage: ["HOME"], // URL homepage is `_$!<HomePage>!$_` label in Apple; we still add TYPE=HOME? no: keep label
};

/** Add a labeled property; standard labels become TYPE params, others get an itemN X-ABLabel. */
function addLabeled(card: VCard, name: string, label: string, value: string, extraTypes: string[], pref: boolean, kind: "tel" | "email" | "url" | "adr"): void {
  const key = label.trim().toLowerCase();
  const std = kind === "url" ? (key === "home" || key === "work" ? STANDARD_TYPES[key] : undefined) : STANDARD_TYPES[key];
  const params: Record<string, string[]> = {};
  const typeVals: string[] = [];
  if (std) typeVals.push(...std);
  typeVals.push(...extraTypes.filter((t) => !typeVals.includes(t)));
  if (pref) typeVals.push("pref");
  if (typeVals.length) params.TYPE = typeVals;
  const prop: VProperty = { name, params, value };
  if (!std) {
    const g = nextGroup(card);
    prop.group = g;
    card.props.push(prop);
    card.props.push({ group: g, name: "X-ABLABEL", params: {}, value: escapeText(encodeLabel(label)) });
  } else {
    card.props.push(prop);
  }
}

// ---------------------------------------------------------------------------
// vCard -> Contact
// ---------------------------------------------------------------------------

function textOf(card: VCard, name: string): string | undefined {
  const p = getProp(card, name);
  if (!p) return undefined;
  const v = unescapeText(p.value).trim();
  return v.length ? v : undefined;
}

function parseDate(value: string, params: Record<string, string[]>): { year?: number; month: number; day: number } | undefined {
  const v = value.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(v);
  if (m) {
    const year = parseInt(m[1], 10);
    const omit = params["X-APPLE-OMIT-YEAR"]?.[0];
    const d = { month: parseInt(m[2], 10), day: parseInt(m[3], 10) } as { year?: number; month: number; day: number };
    if (!(omit && parseInt(omit, 10) === year) && year !== 1604) d.year = year;
    return d;
  }
  m = /^--(\d{2})-?(\d{2})$/.exec(v);
  if (m) return { month: parseInt(m[1], 10), day: parseInt(m[2], 10) };
  return undefined;
}

function formatDate(d: { year?: number | null; month: number; day: number }): { value: string; params: Record<string, string[]> } {
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  if (d.year) return { value: `${d.year}-${mm}-${dd}`, params: {} };
  // Apple convention for year-less dates in vCard 3.0
  return { value: `1604-${mm}-${dd}`, params: { "X-APPLE-OMIT-YEAR": ["1604"] } };
}

export interface GroupCard {
  id: string;
  name: string;
  memberIds: string[];
  etag?: string;
}

/** True if this vCard is an Apple address book group rather than a person. */
export function isGroupCard(card: VCard): boolean {
  const kind = getProp(card, "X-ADDRESSBOOKSERVER-KIND")?.value.trim().toLowerCase();
  return kind === "group";
}

export function cardToGroup(card: VCard, etag?: string): GroupCard {
  return {
    id: textOf(card, "UID") ?? "",
    name: textOf(card, "FN") ?? textOf(card, "N") ?? "",
    memberIds: getProps(card, "X-ADDRESSBOOKSERVER-MEMBER").map((p) => p.value.trim().replace(/^urn:uuid:/i, "")),
    etag,
  };
}

export function cardToContact(card: VCard, opts: { etag?: string; readOnly: boolean; includePhoto?: boolean }): Contact {
  const n = getProp(card, "N") ? splitCompound(getProp(card, "N")!.value) : [];
  const [familyName, givenName, middleName, namePrefix, nameSuffix] = n;
  const c: Contact = {
    id: textOf(card, "UID") ?? "",
    fullName: textOf(card, "FN") ?? [givenName, familyName].filter(Boolean).join(" ").trim(),
    contactType: (getProp(card, "X-ABSHOWAS")?.value.trim().toUpperCase() === "COMPANY" ? "organization" : "person"),
    emails: [],
    phones: [],
    urls: [],
    addresses: [],
    instantMessages: [],
    relations: [],
    socialProfiles: [],
    dates: [],
    hasImage: false,
    readOnly: opts.readOnly,
  };
  const set = (k: keyof Contact, v?: string) => {
    if (v) (c as unknown as Record<string, unknown>)[k] = v;
  };
  set("givenName", givenName || undefined);
  set("familyName", familyName || undefined);
  set("middleName", middleName || undefined);
  set("namePrefix", namePrefix || undefined);
  set("nameSuffix", nameSuffix || undefined);
  set("nickname", textOf(card, "NICKNAME"));
  set("phoneticGivenName", textOf(card, "X-PHONETIC-FIRST-NAME"));
  set("phoneticFamilyName", textOf(card, "X-PHONETIC-LAST-NAME"));
  const org = getProp(card, "ORG") ? splitCompound(getProp(card, "ORG")!.value) : [];
  set("organization", org[0] || undefined);
  set("department", org[1] || undefined);
  set("jobTitle", textOf(card, "TITLE"));
  set("notes", textOf(card, "NOTE"));

  const sortPref = (a: VProperty, b: VProperty) => Number(types(b).includes("PREF")) - Number(types(a).includes("PREF"));

  for (const p of getProps(card, "EMAIL").sort(sortPref)) c.emails.push({ label: groupLabel(card, p) ?? labelFromTypes(p, "email"), value: unescapeText(p.value).trim() });
  for (const p of getProps(card, "TEL").sort(sortPref)) c.phones.push({ label: groupLabel(card, p) ?? labelFromTypes(p, "tel"), value: unescapeText(p.value).trim() });
  for (const p of getProps(card, "URL").sort(sortPref)) c.urls.push({ label: groupLabel(card, p) ?? labelFromTypes(p, "url"), value: unescapeText(p.value).trim() });
  for (const p of getProps(card, "ADR").sort(sortPref)) {
    const [, , street, city, state, postalCode, country] = splitCompound(p.value);
    const cc = p.group ? card.props.find((q) => q.group === p.group && q.name === "X-ABADR")?.value.trim().toLowerCase() : undefined;
    const a: Address = { label: groupLabel(card, p) ?? labelFromTypes(p, "adr") };
    if (street) a.street = street;
    if (city) a.city = city;
    if (state) a.state = state;
    if (postalCode) a.postalCode = postalCode;
    if (country) a.country = country;
    if (cc) a.countryCode = cc;
    c.addresses.push(a);
  }
  const bday = getProp(card, "BDAY");
  if (bday) {
    const d = parseDate(bday.value, bday.params);
    if (d) c.birthday = d;
  }
  for (const p of getProps(card, "X-ABDATE")) {
    const d = parseDate(p.value, p.params);
    if (d) c.dates.push({ label: groupLabel(card, p) ?? "other", ...d });
  }
  for (const p of getProps(card, "X-ABRELATEDNAMES")) c.relations.push({ label: groupLabel(card, p) ?? "other", name: unescapeText(p.value).trim() });
  for (const p of getProps(card, "IMPP")) {
    const value = unescapeText(p.value).trim();
    const colon = value.indexOf(":");
    const service = p.params["X-SERVICE-TYPE"]?.[0] ?? (colon > 0 ? value.slice(0, colon) : "other");
    const username = colon > 0 ? value.slice(colon + 1) : value;
    const im: InstantMessage = { service, username };
    const lab = groupLabel(card, p);
    if (lab) im.label = lab;
    c.instantMessages.push(im);
  }
  for (const legacy of ["X-AIM", "X-JABBER", "X-MSN", "X-YAHOO", "X-ICQ", "X-SKYPE", "X-GOOGLE-TALK", "X-FACEBOOK", "X-GADUGADU", "X-QQ"]) {
    for (const p of getProps(card, legacy)) {
      const service = legacy.slice(2).replace(/-/g, "").toLowerCase();
      c.instantMessages.push({ service: service === "googletalk" ? "GoogleTalk" : service.charAt(0).toUpperCase() + service.slice(1), username: unescapeText(p.value).trim(), ...(groupLabel(card, p) ? { label: groupLabel(card, p) } : {}) });
    }
  }
  for (const p of getProps(card, "X-SOCIALPROFILE")) {
    const sp: SocialProfile = { service: p.params.TYPE?.[0] ?? "other" };
    const user = p.params["X-USER"]?.[0];
    if (user) sp.username = user;
    const value = unescapeText(p.value).trim();
    if (value) sp.url = value;
    const lab = groupLabel(card, p);
    if (lab) sp.label = lab;
    c.socialProfiles.push(sp);
  }
  const photo = getProp(card, "PHOTO");
  if (photo) {
    c.hasImage = true;
    const val = photo.value.trim();
    const isUri = (photo.params.VALUE?.[0] ?? "").toLowerCase() === "uri" || /^https?:\/\//i.test(val);
    if (isUri) c.photoUrl = val;
    else if (opts.includePhoto) {
      c.imageBase64 = val.replace(/\s+/g, "");
      const t = photo.params.TYPE?.[0];
      if (t) c.imageType = t.toLowerCase();
    }
  }
  const rev = textOf(card, "REV");
  if (rev) {
    const iso = /^\d{8}T\d{6}Z$/.test(rev) ? `${rev.slice(0, 4)}-${rev.slice(4, 6)}-${rev.slice(6, 8)}T${rev.slice(9, 11)}:${rev.slice(11, 13)}:${rev.slice(13, 15)}Z` : rev;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) c.lastModified = d.toISOString();
  }
  if (opts.etag) c.etag = opts.etag;
  return c;
}

export function parseContact(text: string, opts: { etag?: string; readOnly: boolean; includePhoto?: boolean }): Contact {
  return cardToContact(parseVCard(text), opts);
}

// ---------------------------------------------------------------------------
// Contact -> vCard
// ---------------------------------------------------------------------------

function nowRev(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function validateLabeled(list: LabeledInput[] | null | undefined, field: string): Labeled[] {
  if (!list) return [];
  return list.map((e, i) => {
    if (!e || typeof e.value !== "string" || !e.value.trim()) throw invalidInput(`${field}[${i}].value is required`);
    return { label: (e.label ?? "other").toString(), value: e.value.trim() };
  });
}

function applyName(card: VCard, input: ContactInput, existing?: Contact): void {
  const cur = existing ?? ({} as Partial<Contact>);
  const pick = (k: keyof ContactInput & keyof Contact) => (input[k] === undefined ? (cur[k] as string | undefined) : input[k] === null ? undefined : (input[k] as string));
  const family = pick("familyName");
  const given = pick("givenName");
  const middle = pick("middleName");
  const prefix = pick("namePrefix");
  const suffix = pick("nameSuffix");
  const org = pick("organization");
  const dept = pick("department");
  setSingle(card, "N", joinCompound([family, given, middle, prefix, suffix]));
  const fnParts = [prefix, given, middle, family, suffix].filter(Boolean).join(" ").trim();
  const contactType = input.contactType === undefined ? cur.contactType : input.contactType;
  const fn = fnParts || org || cur.fullName || "";
  if (!fn) throw invalidInput("A name (givenName/familyName) or organization is required");
  setSingle(card, "FN", escapeText(fn));
  if (org || dept) setSingle(card, "ORG", joinCompound([org, dept]));
  else if (input.organization === null || input.department === null || (input.organization !== undefined && !org)) removeAll(card, "ORG");
  if (contactType === "organization") setSingle(card, "X-ABSHOWAS", "COMPANY");
  else if (input.contactType === "person" || input.contactType === null) removeAll(card, "X-ABSHOWAS");
}

function applyScalar(card: VCard, name: string, value: string | null | undefined): void {
  if (value === undefined) return;
  if (value === null || value === "") removeAll(card, name);
  else setSingle(card, name, escapeText(value));
}

function applyList(card: VCard, name: string, kind: "tel" | "email" | "url", list: LabeledInput[] | null | undefined, field: string): void {
  if (list === undefined) return;
  removeWithGroup(card, name);
  const items = validateLabeled(list, field);
  items.forEach((e, i) => addLabeled(card, name, e.label, escapeText(e.value), kind === "email" ? ["INTERNET"] : kind === "tel" ? ["VOICE"] : [], i === 0 && items.length > 1, kind));
}

function applyAddresses(card: VCard, list: AddressInput[] | null | undefined): void {
  if (list === undefined) return;
  // remove ADR + group-mates (X-ABLabel, X-ABADR)
  const groups = new Set(card.props.filter((p) => p.name === "ADR" && p.group).map((p) => p.group as string));
  card.props = card.props.filter((p) => p.name !== "ADR" && !(p.group && groups.has(p.group) && (p.name === "X-ABLABEL" || p.name === "X-ABADR")));
  if (!list) return;
  list.forEach((a, i) => {
    if (!a || !(a.street || a.city || a.state || a.postalCode || a.country)) throw invalidInput(`addresses[${i}] needs at least one of street/city/state/postalCode/country`);
    const value = joinCompound(["", "", a.street, a.city, a.state, a.postalCode, a.country]);
    const label = a.label || "home";
    const before = card.props.length;
    addLabeled(card, "ADR", label, value, [], i === 0 && list.length > 1, "adr");
    // Apple stores ADR with an itemN group even for standard labels; attach X-ABADR (country code) if given
    if (a.countryCode) {
      const adr = card.props[before];
      if (!adr.group) {
        const g = nextGroup(card);
        adr.group = g;
      }
      card.props.push({ group: adr.group, name: "X-ABADR", params: {}, value: a.countryCode.toLowerCase() });
    }
  });
}

function applyGroupedX(card: VCard, name: string, items: { label?: string; value: string; params?: Record<string, string[]> }[] | null | undefined, defaultLabel: string): void {
  if (items === undefined) return;
  removeWithGroup(card, name);
  if (!items) return;
  for (const it of items) {
    const g = nextGroup(card);
    card.props.push({ group: g, name, params: it.params ?? {}, value: it.value });
    card.props.push({ group: g, name: "X-ABLABEL", params: {}, value: escapeText(encodeLabel(it.label || defaultLabel)) });
  }
}

/** Apply a ContactInput onto a card (create: empty card; update: parsed existing). */
export function applyInput(card: VCard, input: ContactInput, existing?: Contact): void {
  applyName(card, input, existing);
  applyScalar(card, "NICKNAME", input.nickname);
  applyScalar(card, "TITLE", input.jobTitle);
  applyScalar(card, "NOTE", input.notes);
  applyScalar(card, "X-PHONETIC-FIRST-NAME", input.phoneticGivenName);
  applyScalar(card, "X-PHONETIC-LAST-NAME", input.phoneticFamilyName);
  applyList(card, "EMAIL", "email", input.emails, "emails");
  applyList(card, "TEL", "tel", input.phones, "phones");
  applyList(card, "URL", "url", input.urls, "urls");
  applyAddresses(card, input.addresses);
  if (input.birthday !== undefined) {
    if (input.birthday === null) removeAll(card, "BDAY");
    else {
      validateDate(input.birthday, "birthday");
      const f = formatDate(input.birthday);
      setSingle(card, "BDAY", f.value, f.params);
    }
  }
  if (input.dates !== undefined) {
    input.dates?.forEach((d, i) => validateDate(d, `dates[${i}]`));
    applyGroupedX(card, "X-ABDATE", input.dates?.map((d) => ({ label: d.label ?? undefined, ...formatDate(d) })) ?? null, "other");
  }
  if (input.relations !== undefined) {
    applyGroupedX(card, "X-ABRELATEDNAMES", input.relations?.map((r) => ({ label: r.label, value: escapeText(r.name) })) ?? null, "other");
  }
  if (input.instantMessages !== undefined) {
    // Drop legacy X-AIM etc. too, since we replace the whole IM set.
    for (const legacy of ["X-AIM", "X-JABBER", "X-MSN", "X-YAHOO", "X-ICQ", "X-SKYPE", "X-GOOGLE-TALK", "X-FACEBOOK", "X-GADUGADU", "X-QQ"]) removeWithGroup(card, legacy);
    removeWithGroup(card, "IMPP");
    if (input.instantMessages) {
      for (const im of input.instantMessages) {
        if (!im?.service || !im?.username) throw invalidInput("instantMessages entries need service and username");
        const g = nextGroup(card);
        card.props.push({ group: g, name: "IMPP", params: { "X-SERVICE-TYPE": [im.service] }, value: escapeText(`${im.service.toLowerCase()}:${im.username}`) });
        card.props.push({ group: g, name: "X-ABLABEL", params: {}, value: escapeText(encodeLabel(im.label || "other")) });
      }
    }
  }
  if (input.socialProfiles !== undefined) {
    removeWithGroup(card, "X-SOCIALPROFILE");
    if (input.socialProfiles) {
      for (const sp of input.socialProfiles) {
        if (!sp?.service) throw invalidInput("socialProfiles entries need service");
        const params: Record<string, string[]> = { TYPE: [sp.service.toLowerCase()] };
        if (sp.username) params["X-USER"] = [sp.username];
        const url = sp.url ?? defaultProfileUrl(sp.service, sp.username ?? undefined);
        const prop: VProperty = { name: "X-SOCIALPROFILE", params, value: escapeText(url ?? "") };
        if (sp.label) {
          const g = nextGroup(card);
          prop.group = g;
          card.props.push(prop, { group: g, name: "X-ABLABEL", params: {}, value: escapeText(encodeLabel(sp.label)) });
        } else card.props.push(prop);
      }
    }
  }
  setSingle(card, "REV", nowRev());
}

function defaultProfileUrl(service: string, username?: string): string | undefined {
  if (!username) return undefined;
  const s = service.toLowerCase();
  const map: Record<string, string> = {
    twitter: "https://twitter.com/",
    x: "https://x.com/",
    facebook: "https://www.facebook.com/",
    linkedin: "https://www.linkedin.com/in/",
    instagram: "https://www.instagram.com/",
    github: "https://github.com/",
    mastodon: "",
    flickr: "https://www.flickr.com/photos/",
  };
  return s in map && map[s] ? `${map[s]}${username}` : undefined;
}

function validateDate(d: { year?: number | null; month: number; day: number }, field: string): void {
  if (!d || !Number.isInteger(d.month) || !Number.isInteger(d.day) || d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31) throw invalidInput(`${field} needs integer month (1-12) and day (1-31)`);
  if (d.year !== undefined && d.year !== null && (!Number.isInteger(d.year) || d.year < 1 || d.year > 9999)) throw invalidInput(`${field}.year is invalid`);
}

export function buildNewContact(input: ContactInput, uid: string): string {
  const card: VCard = {
    props: [
      { name: "VERSION", params: {}, value: "3.0" },
      { name: "PRODID", params: {}, value: PRODID },
      { name: "UID", params: {}, value: uid },
    ],
  };
  applyInput(card, input);
  return serializeVCard(card);
}

export function patchContact(existingText: string, existing: Contact, input: ContactInput): string {
  const card = parseVCard(existingText);
  if (!getProp(card, "VERSION")) card.props.unshift({ name: "VERSION", params: {}, value: "3.0" });
  applyInput(card, input, existing);
  return serializeVCard(card);
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function buildGroupCard(name: string, uid: string, memberIds: string[]): string {
  const card: VCard = {
    props: [
      { name: "VERSION", params: {}, value: "3.0" },
      { name: "PRODID", params: {}, value: PRODID },
      { name: "UID", params: {}, value: uid },
      { name: "N", params: {}, value: escapeText(name) },
      { name: "FN", params: {}, value: escapeText(name) },
      { name: "X-ADDRESSBOOKSERVER-KIND", params: {}, value: "group" },
      ...memberIds.map((id) => ({ name: "X-ADDRESSBOOKSERVER-MEMBER", params: {}, value: `urn:uuid:${id}` })),
      { name: "REV", params: {}, value: nowRev() },
    ],
  };
  return serializeVCard(card);
}

export function setGroupMembers(existingText: string, memberIds: string[]): string {
  const card = parseVCard(existingText);
  removeAll(card, "X-ADDRESSBOOKSERVER-MEMBER");
  for (const id of memberIds) card.props.push({ name: "X-ADDRESSBOOKSERVER-MEMBER", params: {}, value: `urn:uuid:${id}` });
  setSingle(card, "REV", nowRev());
  return serializeVCard(card);
}

/** Cheap UID extraction (first UID line). */
export function extractUid(text: string): string | undefined {
  const m = /^(?:[A-Za-z0-9-]+\.)?UID(?:;[^:]*)?:(.*)$/m.exec(text.replace(/\r?\n[ \t]/g, ""));
  return m ? m[1].trim() : undefined;
}

export { splitList };
