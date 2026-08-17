/**
 * Minimal namespace-aware XML parser and builders for WebDAV/CalDAV.
 *
 * Scope: DAV multistatus responses (PROPFIND / REPORT). Handles element
 * nesting, attributes, xmlns prefix resolution, text, CDATA, comments,
 * processing instructions, and the standard/numeric entities. Not a general
 * purpose XML parser (no DTDs, no external entities).
 */

export interface XmlNode {
  /** Namespace URI (resolved), "" if none */
  ns: string;
  /** Local name without prefix */
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated direct text content */
  text: string;
}

export const NS = {
  DAV: "DAV:",
  CARDDAV: "urn:ietf:params:xml:ns:carddav",
  CS: "http://calendarserver.org/ns/",
} as const;

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ent in ENTITIES ? ENTITIES[ent] : m;
  });
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Frame {
  node: XmlNode;
  nsMap: Record<string, string>;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

export function parseXml(input: string): XmlNode {
  const root: XmlNode = { ns: "", local: "#document", attrs: {}, children: [], text: "" };
  const stack: Frame[] = [{ node: root, nsMap: { xml: "http://www.w3.org/XML/1998/namespace" } }];
  let i = 0;
  const n = input.length;

  const appendText = (t: string) => {
    if (!t) return;
    const top = stack[stack.length - 1];
    top.node.text += decodeEntities(t);
  };

  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      appendText(input.slice(i));
      break;
    }
    if (lt > i) appendText(input.slice(i, lt));

    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      const content = end === -1 ? input.slice(lt + 9) : input.slice(lt + 9, end);
      stack[stack.length - 1].node.text += content;
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (input.startsWith("<?", lt)) {
      const end = input.indexOf("?>", lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (input.startsWith("<!", lt)) {
      // DOCTYPE or similar: skip to '>'
      const end = input.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }

    // Find the end of the tag, respecting quoted attribute values.
    let j = lt + 1;
    let quote: string | null = null;
    while (j < n) {
      const c = input[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j++;
    }
    if (j >= n) throw new Error("Malformed XML: unterminated tag");
    const tag = input.slice(lt + 1, j);
    i = j + 1;

    if (tag[0] === "/") {
      // closing tag
      if (stack.length > 1) stack.pop();
      continue;
    }

    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const spaceIdx = body.search(/\s/);
    const qname = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
    const attrs = spaceIdx === -1 ? {} : parseAttrs(body.slice(spaceIdx));

    const parentMap = stack[stack.length - 1].nsMap;
    let nsMap = parentMap;
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "xmlns" || k.startsWith("xmlns:")) {
        if (nsMap === parentMap) nsMap = { ...parentMap };
        nsMap[k === "xmlns" ? "" : k.slice(6)] = v;
      }
    }
    const colon = qname.indexOf(":");
    const prefix = colon === -1 ? "" : qname.slice(0, colon);
    const local = colon === -1 ? qname : qname.slice(colon + 1);
    const ns = nsMap[prefix] ?? "";

    const node: XmlNode = { ns, local, attrs, children: [], text: "" };
    stack[stack.length - 1].node.children.push(node);
    if (!selfClosing) stack.push({ node, nsMap });
  }
  return root;
}

/** Depth-first search for all descendants matching ns+local. */
export function findAll(node: XmlNode, ns: string, local: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.local === local && (ns === "*" || c.ns === ns)) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export function findFirst(node: XmlNode, ns: string, local: string): XmlNode | undefined {
  for (const c of node.children) {
    if (c.local === local && (ns === "*" || c.ns === ns)) return c;
    const deep = findFirst(c, ns, local);
    if (deep) return deep;
  }
  return undefined;
}

/** Direct children matching ns+local. */
export function childrenOf(node: XmlNode, ns: string, local: string): XmlNode[] {
  return node.children.filter((c) => c.local === local && (ns === "*" || c.ns === ns));
}

export function childOf(node: XmlNode, ns: string, local: string): XmlNode | undefined {
  return node.children.find((c) => c.local === local && (ns === "*" || c.ns === ns));
}

export function textOf(node: XmlNode | undefined): string {
  return node ? node.text.trim() : "";
}

// ---------------------------------------------------------------------------
// Multistatus helpers
// ---------------------------------------------------------------------------

export interface PropStat {
  status: number;
  prop: XmlNode;
}

export interface MultiStatusResponse {
  href: string;
  /** Status from a per-response <D:status> (used for 404s without propstat) */
  status?: number;
  propstats: PropStat[];
}

function parseStatusLine(s: string): number {
  const m = /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(s);
  return m ? parseInt(m[1], 10) : NaN;
}

export function parseMultiStatus(xml: string): MultiStatusResponse[] {
  const doc = parseXml(xml);
  const responses = findAll(doc, NS.DAV, "response");
  return responses.map((r) => {
    const href = textOf(childOf(r, NS.DAV, "href"));
    const statusNode = childOf(r, NS.DAV, "status");
    const propstats = childrenOf(r, NS.DAV, "propstat").map((ps) => ({
      status: parseStatusLine(textOf(childOf(ps, NS.DAV, "status"))),
      prop: childOf(ps, NS.DAV, "prop") ?? { ns: NS.DAV, local: "prop", attrs: {}, children: [], text: "" },
    }));
    return { href, status: statusNode ? parseStatusLine(textOf(statusNode)) : undefined, propstats };
  });
}

/** Top-level <D:sync-token> of a sync-collection multistatus, if present. */
export function parseSyncToken(xml: string): string | undefined {
  const doc = parseXml(xml);
  const ms = doc.children.find((c) => c.local === "multistatus");
  const tok = ms ? childOf(ms, NS.DAV, "sync-token") : undefined;
  return tok ? textOf(tok) || undefined : undefined;
}

/** Return the first successful (2xx) prop node for a response, if any. */
export function okProp(r: MultiStatusResponse): XmlNode | undefined {
  return r.propstats.find((p) => p.status >= 200 && p.status < 300)?.prop;
}

// ---------------------------------------------------------------------------
// Request body builders (CardDAV)
// ---------------------------------------------------------------------------

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';
const NS_DECL = `xmlns:D="${NS.DAV}" xmlns:C="${NS.CARDDAV}" xmlns:CS="${NS.CS}"`;

export interface PropSpec {
  ns: string;
  local: string;
}

function propTag(p: PropSpec): string {
  const prefix = p.ns === NS.DAV ? "D" : p.ns === NS.CARDDAV ? "C" : p.ns === NS.CS ? "CS" : null;
  if (!prefix) throw new Error(`Unsupported namespace in prop spec: ${p.ns}`);
  return `<${prefix}:${p.local}/>`;
}

export function propfindBody(props: PropSpec[]): string {
  return `${XML_HEAD}<D:propfind ${NS_DECL}><D:prop>${props.map(propTag).join("")}</D:prop></D:propfind>`;
}

/** RFC 6578 sync-collection; empty token = full listing. */
export function syncCollectionBody(token: string | undefined): string {
  return `${XML_HEAD}<D:sync-collection ${NS_DECL}><D:sync-token>${token ? escapeXml(token) : ""}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`;
}

export function multigetBody(hrefs: string[]): string {
  return `${XML_HEAD}<C:addressbook-multiget ${NS_DECL}><D:prop><D:getetag/><C:address-data/></D:prop>${hrefs.map((h) => `<D:href>${escapeXml(h)}</D:href>`).join("")}</C:addressbook-multiget>`;
}

/**
 * addressbook-query hint: iCloud honours a single prop-filter text-match, but
 * silently downgrades allof->anyof and matches case-sensitively, so callers
 * must post-filter client-side. Used only as an optional pre-filter.
 */
export function addressbookQueryBody(prop: string, text: string): string {
  return (
    `${XML_HEAD}<C:addressbook-query ${NS_DECL}><D:prop><D:getetag/><C:address-data/></D:prop>` +
    `<C:filter><C:prop-filter name="${escapeXml(prop)}"><C:text-match collation="i;unicode-casemap" match-type="contains">${escapeXml(text)}</C:text-match></C:prop-filter></C:filter>` +
    `</C:addressbook-query>`
  );
}
