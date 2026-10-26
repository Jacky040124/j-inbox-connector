// Byte and MIME helpers for the fake: base64url, charsets, Gmail payload trees, and a small parser
// for the RFC 5322 messages clients send (users.messages.send, drafts.create).

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Gmail's raw/data fields: base64url, padding optional. Standard base64 is accepted too (Gmail does). */
export function b64urlDecode(s: string): Uint8Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9_\-+/]*={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "") + "===".slice((s.replace(/=+$/, "").length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export const utf8 = (s: string) => new TextEncoder().encode(s);

/** ISO-8859-1 bytes (chars above U+00FF become "?"). */
export function latin1(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63));
}

/** RFC 2047 B-encoding of a header value (what many mailers send for non-ASCII subjects and names). */
export function encodedWord(s: string, charset = "UTF-8"): string {
  const bytes = charset.toUpperCase() === "UTF-8" ? utf8(s) : latin1(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?${charset}?B?${btoa(bin)}?=`;
}

export type Header = { name: string; value: string };

/** One node of a Gmail payload tree (users.messages.get format=full). */
export type Part = {
  mimeType: string;
  filename?: string;
  headers: Header[];
  /** Body bytes (text in its charset, or file bytes). */
  data?: Uint8Array;
  /** Set for attachments: fetched with users.messages.attachments.get. */
  attachmentId?: string;
  parts?: Part[];
};

/** Gmail JSON for a part: small text bodies inline as base64url data, files as attachmentId. */
export function partJSON(p: Part, partId: string, format: "full" | "metadata", keepHeaders?: Set<string>): Record<string, unknown> {
  const headers = keepHeaders ? p.headers.filter((h) => keepHeaders.has(h.name.toLowerCase())) : p.headers;
  const out: Record<string, unknown> = { partId, mimeType: p.mimeType, filename: p.filename ?? "", headers };
  if (format === "metadata") {
    // metadata: headers of the top part only, no bodies or child parts (like Gmail).
    return out;
  }
  const size = p.data?.length ?? 0;
  out.body = p.attachmentId ? { attachmentId: p.attachmentId, size } : p.parts ? { size: 0 } : { size, ...(size ? { data: b64urlEncode(p.data!) } : {}) };
  if (p.parts) out.parts = p.parts.map((c, i) => partJSON(c, partId === "" ? String(i) : `${partId}.${i}`, format));
  return out;
}

export function findAttachment(p: Part, attachmentId: string): Part | null {
  if (p.attachmentId === attachmentId) return p;
  for (const c of p.parts ?? []) {
    const f = findAttachment(c, attachmentId);
    if (f) return f;
  }
  return null;
}

/** The first text/plain body (decoded), else the first text/html body stripped of tags. */
export function bodyText(p: Part): string {
  const find = (n: Part, type: string): Part | null => {
    if (n.mimeType.toLowerCase() === type && !n.attachmentId && n.data) return n;
    for (const c of n.parts ?? []) {
      const f = find(c, type);
      if (f) return f;
    }
    return null;
  };
  const decode = (n: Part) => {
    const cs = /charset="?([^";\s]+)"?/i.exec(n.headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "")?.[1] ?? "utf-8";
    try {
      return new TextDecoder(cs).decode(n.data!);
    } catch {
      return new TextDecoder().decode(n.data!);
    }
  };
  const plain = find(p, "text/plain");
  if (plain) return decode(plain);
  const html = find(p, "text/html");
  return html ? decode(html).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ") : "";
}

/** Gmail snippets: whitespace collapsed, cut short, HTML-escaped (Gmail really sends &#39; etc.). */
export function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim().slice(0, 140);
  return flat.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---- parsing what clients send ----

export type ParsedMessage = {
  /** Header lines as sent (unfolded), in order. */
  headers: Header[];
  /** The decoded text/plain body. */
  text: string;
  contentType: string;
  transferEncoding: string;
};

function unfold(head: string): Header[] {
  const out: Header[] = [];
  for (const line of head.split(/\r\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1]!.value += line;
    else {
      const i = line.indexOf(":");
      if (i > 0) out.push({ name: line.slice(0, i), value: line.slice(i + 1).trim() });
    }
  }
  return out;
}

function decodeQP(s: string): Uint8Array {
  const soft = s.replace(/=\r\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const c = soft[i]!;
    if (c === "=" && /^[0-9A-F]{2}$/i.test(soft.slice(i + 1, i + 3))) {
      out.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(c.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

/**
 * Parses an RFC 5322 message (CRLF line ends, as Gmail requires). Returns null for anything that
 * is not one: Gmail answers such sends with 400 "Invalid To header" and the like.
 */
export function parseRaw(bytes: Uint8Array): ParsedMessage | null {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) return null;
  const headers = unfold(raw.slice(0, split));
  if (!headers.length) return null;
  const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
  const contentType = get("content-type") || "text/plain; charset=us-ascii";
  const transferEncoding = (get("content-transfer-encoding") || "7bit").toLowerCase();
  let body = raw.slice(split + 4);
  if (/^multipart\//i.test(contentType)) {
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
    if (!boundary) return null;
    const first = body.split(`--${boundary}`).find((p) => /content-type:\s*text\/plain/i.test(p));
    if (!first) return { headers, text: "", contentType, transferEncoding };
    const inner = parseRaw(Uint8Array.from(first.replace(/^\r\n/, ""), (c) => c.charCodeAt(0)));
    return inner ? { headers, text: inner.text, contentType, transferEncoding } : null;
  }
  const latinBytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  let data: Uint8Array;
  if (transferEncoding === "base64") {
    const d = b64urlDecode(body.replace(/\s+/g, ""));
    if (!d) return null;
    data = d;
  } else if (transferEncoding === "quoted-printable") data = decodeQP(body);
  else data = latinBytes(body);
  const cs = /charset="?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "us-ascii";
  let text: string;
  try {
    text = new TextDecoder(cs.toLowerCase() === "us-ascii" ? "utf-8" : cs).decode(data);
  } catch {
    text = new TextDecoder().decode(data);
  }
  return { headers, text, contentType, transferEncoding };
}

/** Decodes RFC 2047 encoded-words (B and Q) in a header value. */
export function decodeHeader(v: string): string {
  return v.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, cs: string, enc: string, text: string) => {
    let bytes: Uint8Array;
    if (enc.toUpperCase() === "B") bytes = b64urlDecode(text) ?? new Uint8Array();
    else bytes = decodeQP(text.replace(/_/g, " "));
    try {
      return new TextDecoder(cs).decode(bytes);
    } catch {
      return new TextDecoder().decode(bytes);
    }
  });
}

/** Addresses in an address-list header ("A <a@x>, b@y"): lower-cased bare addresses. */
export function addressesIn(v: string): string[] {
  const out: string[] = [];
  for (const m of decodeHeader(v).matchAll(/<([^<>\s]+@[^<>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+)/g)) out.push((m[1] ?? m[2])!.toLowerCase());
  return out;
}
