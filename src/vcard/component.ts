/**
 * vCard 3.0 content-line parser/serializer (RFC 2426 / RFC 6350 §3).
 *
 * Preserves unknown properties, parameter casing, and Apple's `itemN.` group
 * prefixes so updates round-trip byte-for-byte for anything we do not model.
 */

export interface VProperty {
  /** Apple/RFC group prefix without the dot, e.g. "item1"; undefined if none */
  group?: string;
  /** Upper-case property name, e.g. "EMAIL", "X-ABLABEL" */
  name: string;
  /** Upper-case param name -> values (a param may repeat: type=INTERNET;type=pref) */
  params: Record<string, string[]>;
  /** Raw (still-escaped) value */
  value: string;
}

export interface VCard {
  props: VProperty[];
}

/** Unfold folded lines (CRLF/LF followed by space or tab). */
export function unfold(text: string): string[] {
  return text
    .replace(/\r\n[ \t]|\n[ \t]|\r[ \t]/g, "")
    .split(/\r\n|\n|\r/)
    .filter((l) => l.length > 0);
}

export function parseContentLine(line: string): VProperty {
  let i = 0;
  let quote = false;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') quote = !quote;
    else if (c === ":" && !quote) break;
    i++;
  }
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts: string[] = [];
  let cur = "";
  quote = false;
  for (const c of head) {
    if (c === '"') {
      quote = !quote;
      cur += c;
    } else if (c === ";" && !quote) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  let name = parts[0].toUpperCase();
  let group: string | undefined;
  const dot = name.indexOf(".");
  if (dot > 0) {
    group = parts[0].slice(0, dot);
    name = name.slice(dot + 1);
  }
  const params: Record<string, string[]> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    // vCard 2.1-style bare params (e.g. ";CELL") -> TYPE
    const k = eq === -1 ? "TYPE" : p.slice(0, eq).toUpperCase();
    const raw = eq === -1 ? p : p.slice(eq + 1);
    for (let v of splitParamValues(raw)) {
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      (params[k] ??= []).push(v);
    }
  }
  return { group, name, params, value };
}

function splitParamValues(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = false;
  for (const c of raw) {
    if (c === '"') {
      quote = !quote;
      cur += c;
    } else if (c === "," && !quote) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parse a single vCard document. Returns the first VCARD. */
export function parseVCard(text: string): VCard {
  const lines = unfold(text);
  const props: VProperty[] = [];
  let inside = false;
  for (const line of lines) {
    const p = parseContentLine(line);
    if (p.name === "BEGIN" && p.value.trim().toUpperCase() === "VCARD") {
      if (inside) break; // nested VCARD not supported; stop
      inside = true;
      continue;
    }
    if (p.name === "END" && p.value.trim().toUpperCase() === "VCARD") break;
    if (inside) props.push(p);
  }
  if (!inside) throw new Error("Not a vCard (missing BEGIN:VCARD)");
  return { props };
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/** Fold at 75 octets without splitting UTF-8 sequences. */
export function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    const limit = first ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
    out.push((first ? "" : " ") + bytes.subarray(start, end).toString("utf8"));
    start = end;
    first = false;
  }
  return out.join("\r\n");
}

function paramValueOut(v: string): string {
  return /[;:,]/.test(v) ? `"${v}"` : v;
}

export function serializeProperty(p: VProperty): string {
  let line = (p.group ? `${p.group}.` : "") + p.name;
  for (const [k, vals] of Object.entries(p.params)) {
    // Apple writes repeated type params (type=INTERNET;type=pref); keep that shape.
    for (const v of vals) line += `;${k.toLowerCase() === "type" ? "type" : k}=${paramValueOut(v)}`;
  }
  line += `:${p.value}`;
  return fold(line);
}

export function serializeVCard(card: VCard): string {
  const lines = ["BEGIN:VCARD"];
  // VERSION must come first per RFC 2426; ensure it exists and leads.
  const version = card.props.find((p) => p.name === "VERSION");
  lines.push(`VERSION:${version?.value ?? "3.0"}`);
  for (const p of card.props) if (p.name !== "VERSION") lines.push(serializeProperty(p));
  lines.push("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/**
 * Escape a vCard TEXT value: backslash, comma, semicolon, newline. Colons and
 * Apple's `_$!<Home>!$_` sentinel characters MUST NOT be escaped (RFC 6350 §3.4).
 */
export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

export function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** Split a compound value on unescaped ';' and unescape each part. */
export function splitCompound(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && i + 1 < value.length) {
      cur += c + value[i + 1];
      i++;
    } else if (c === ";") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map(unescapeText);
}

export function joinCompound(parts: (string | undefined)[]): string {
  return parts.map((p) => escapeText(p ?? "")).join(";");
}

/** Split a list value on unescaped ',' (e.g. CATEGORIES, N sub-parts). */
export function splitList(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && i + 1 < value.length) {
      cur += c + value[i + 1];
      i++;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map(unescapeText).filter((s) => s.length > 0);
}

export function getProps(card: VCard, name: string): VProperty[] {
  return card.props.filter((p) => p.name === name);
}

export function getProp(card: VCard, name: string): VProperty | undefined {
  return card.props.find((p) => p.name === name);
}

export function setSingle(card: VCard, name: string, value: string, params: Record<string, string[]> = {}): void {
  const idx = card.props.findIndex((p) => p.name === name);
  const prop: VProperty = { name, params, value };
  if (idx === -1) card.props.push(prop);
  else card.props[idx] = { ...prop, group: card.props[idx].group };
}

export function removeAll(card: VCard, name: string): void {
  card.props = card.props.filter((p) => p.name !== name);
}

/** Remove a property and its group-mates (e.g. item3.EMAIL + item3.X-ABLabel). */
export function removeWithGroup(card: VCard, name: string): void {
  const groups = new Set(card.props.filter((p) => p.name === name && p.group).map((p) => p.group as string));
  card.props = card.props.filter((p) => p.name !== name && !(p.group && groups.has(p.group) && p.name === "X-ABLABEL"));
}

/** Next unused itemN group id. */
export function nextGroup(card: VCard): string {
  let n = 1;
  const used = new Set(card.props.map((p) => p.group?.toLowerCase()).filter(Boolean));
  while (used.has(`item${n}`)) n++;
  return `item${n}`;
}
