/**
 * Client-side contact search (iCloud's addressbook-query is unreliable).
 * Semantics mirror apple-pim: case-insensitive substring on names/org,
 * substring on emails, digit-normalised bidirectional containment on phones.
 */

import type { Contact } from "./contact.js";

export type SearchField = "name" | "email" | "phone" | "org" | "any";

export function normalizePhone(s: string): string {
  return s.replace(/\D+/g, "");
}

function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function matchesContact(c: Contact, query: string, field: SearchField): boolean {
  const q = fold(query.trim());
  if (!q) return false;
  const nameHay = fold([c.fullName, c.givenName, c.familyName, c.middleName, c.nickname, c.phoneticGivenName, c.phoneticFamilyName].filter(Boolean).join(" "));
  const orgHay = fold([c.organization, c.department, c.jobTitle].filter(Boolean).join(" "));
  const emailHit = () => c.emails.some((e) => fold(e.value).includes(q));
  const phoneHit = () => {
    const qd = normalizePhone(query);
    if (qd.length < 3) return false;
    return c.phones.some((p) => {
      const pd = normalizePhone(p.value);
      return pd.includes(qd) || qd.includes(pd);
    });
  };
  switch (field) {
    case "name":
      return nameHay.includes(q);
    case "org":
      return orgHay.includes(q);
    case "email":
      return emailHit();
    case "phone":
      return phoneHit();
    default:
      return nameHay.includes(q) || orgHay.includes(q) || emailHit() || phoneHit();
  }
}

/** Rank: exact full-name/email match first, then prefix, then substring; ties by name. */
export function scoreContact(c: Contact, query: string): number {
  const q = fold(query.trim());
  const name = fold(c.fullName);
  if (name === q || c.emails.some((e) => fold(e.value) === q)) return 0;
  if (name.startsWith(q) || fold(c.givenName ?? "").startsWith(q) || fold(c.familyName ?? "").startsWith(q)) return 1;
  return 2;
}

export function sortByName(a: Contact, b: Contact): number {
  const ka = fold(`${a.familyName ?? ""} ${a.givenName ?? ""} ${a.fullName}`).trim();
  const kb = fold(`${b.familyName ?? ""} ${b.givenName ?? ""} ${b.fullName}`).trim();
  return ka.localeCompare(kb);
}
