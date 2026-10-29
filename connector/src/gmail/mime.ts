// Email text in and out. In: Gmail's base64url bodies in their declared charset, RFC 2047 encoded
// headers, address lists, HTML entities in snippets. Out: plain-text RFC 5322 messages (UTF-8,
// base64 body, RFC 2047 encoded Subject and names, CRLF) as base64url for users.messages.send,
// with reply-all recipients and threading headers. Every header value that goes out is rebuilt
// from validated parts, so nothing a sender wrote can add a header line (no CR/LF injection).
import { sanitizeLine, type EmailPerson } from "@j-inbox/protocol";

// ---- base64url ----

export function b64urlToBytes(s: string): Uint8Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9_\-+/]*={0,2}$/.test(s)) return null;
  const clean = s.replace(/=+$/, "");
  if (clean.length % 4 === 1) return null;
  try {
    const bin = atob(clean.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((clean.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesToBinary(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

export function bytesToB64url(b: Uint8Array): string {
  return btoa(bytesToBinary(b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- charsets ----

/** Text in a declared charset; unknown charsets fall back to UTF-8 (with replacement characters). */
export function decodeCharset(bytes: Uint8Array, charset: string | null | undefined): string {
  const cs = (charset ?? "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  const label = cs === "us-ascii" || cs === "ascii" || cs === "" ? "utf-8" : cs;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function charsetOf(contentType: string | null | undefined): string | null {
  return /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "")?.[1] ?? null;
}

// ---- RFC 2047 ----

function decodeQ(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "_") out.push(0x20);
    else if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(c.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

/** Decodes encoded-words (=?charset?B|Q?...?=); whitespace between adjacent ones is dropped (RFC 2047 6.2). */
export function decodeEncodedWords(v: string): string {
  if (typeof v !== "string" || !v.includes("=?")) return v ?? "";
  return v.slice(0, 20_000).replace(/=\?([^?\s]{1,40})\?([BbQq])\?([^?\s]*)\?=(?:[ \t\r\n]+(?==\?[^?\s]{1,40}\?[BbQq]\?))?/g, (m, cs: string, enc: string, text: string) => {
    const bytes = enc.toUpperCase() === "B" ? b64urlToBytes(text) : decodeQ(text);
    if (!bytes) return m;
    return decodeCharset(bytes, cs.split("*")[0]);
  });
}

/** A header value for display: encoded-words decoded, one clean line. */
export function headerText(v: string | null | undefined, max: number): string {
  return sanitizeLine(decodeEncodedWords(v ?? ""), max);
}

// ---- addresses ----

const ADDRESS_RE = /^[^\s@<>",;:()[\]\\]{1,64}@[^\s@<>",;:()[\]\\.]{1,63}(?:\.[^\s@<>",;:()[\]\\.]{1,63})+$/;

export function isAddress(v: unknown): v is string {
  return typeof v === "string" && v.length <= 254 && ADDRESS_RE.test(v);
}

/** Splits an address-list header at top-level commas (not inside quotes, <> or comments). */
function splitList(v: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === "\\" && quote) {
      cur += c + (v[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') quote = !quote;
    else if (!quote && c === "<") angle++;
    else if (!quote && c === ">") angle = Math.max(0, angle - 1);
    else if (!quote && c === "(") paren++;
    else if (!quote && c === ")") paren = Math.max(0, paren - 1);
    if ((c === "," || c === ";") && !quote && !angle && !paren) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * People in an address-list header (From, To, Cc, Reply-To). Invalid entries ("undisclosed-
 * recipients:;", garbage) are dropped; addresses are lower-cased; names are decoded and cleaned.
 */
export function parseAddressList(v: string | null | undefined, max = 100): EmailPerson[] {
  const out: EmailPerson[] = [];
  if (!v) return out;
  // Group syntax "name: a, b;" -> just the members.
  const flat = v.slice(0, 50_000).replace(/^[^"<>@,]*:(?=[^:]*@)/, "");
  for (const item of splitList(flat)) {
    if (out.length >= max) break;
    const angle = /^([\s\S]*?)<\s*([^<>\s]+)\s*>\s*(?:\([\s\S]*\))?$/.exec(item);
    let name = "";
    let address = "";
    if (angle) {
      name = angle[1]!.trim();
      address = angle[2]!;
    } else {
      const m = /^([^\s()]+)\s*(?:\(([\s\S]*)\))?$/.exec(item);
      if (!m) continue;
      address = m[1]!;
      name = m[2] ?? "";
    }
    address = address.toLowerCase();
    if (!isAddress(address)) continue;
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    const clean = headerText(name, 200);
    out.push(clean && clean.toLowerCase() !== address ? { name: clean, address } : { address });
  }
  return out;
}

// ---- snippets and bodies ----

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Gmail snippets are HTML-escaped ("&#39;", "&amp;"): plain text. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in NAMED) return NAMED[k]!;
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : k.startsWith("#") ? parseInt(k.slice(1), 10) : NaN;
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m;
  });
}

/**
 * Email HTML as plain text (for HTML-only mail): drops <head>, <style>, <script> and comments with
 * their contents, keeps link targets, turns blocks into line breaks. The result is plain text.
 */
export function emailHtmlToText(html: string): string {
  const s = html
    .slice(0, 2_000_000)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]*\n[ \t]*/g, " ")
    .replace(/<a\s[^<>]*?href\s*=\s*"([^"]*)"[^<>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^<>]*>/g, "").trim();
      const url = decodeEntities(href).trim();
      if (!/^(https?:|mailto:)/i.test(url)) return label;
      return !label || decodeEntities(label) === url ? url : `${label} (${url})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li(?:\s[^<>]*)?>/gi, "\n• ")
    .replace(/<\/?(?:p|div|tr|table|ul|ol|blockquote|h[1-6]|section|article|header|footer)(?:\s[^<>]*)?>/gi, "\n")
    .replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi, "")
    .replace(/<[^<>]*>/g, "");
  return decodeEntities(s)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A reply's quoted history, like Gmail's "•••": the body splits at the first attribution line
 * ("On <date>, <name> wrote:", also split over two lines, and the Chinese 写道 form), an
 * "Original Message" separator, or a block of ">" lines that runs to the end (blank lines and a
 * short signature between are allowed). Forwarded messages are content, not history: kept.
 * When nothing would be left above the quote, the whole body is `main`.
 */
export function splitQuoted(text: string): { main: string; quoted: string } {
  const lines = text.split("\n");
  const attribution = (i: number): boolean => {
    const a = lines[i]!.trim();
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(a)) return true;
    if (/^(?:On|Le|Am|El)\s.{3,300}(?:wrote|a écrit|schrieb|escribió)\s*:$/i.test(a)) return true;
    if (/^在.{2,200}写道[:：]$/.test(a) || /^.{2,200}于.{2,100}写道[:：]$/.test(a)) return true;
    // Attribution wrapped over two lines.
    const b = (lines[i + 1] ?? "").trim();
    return /^On\s/i.test(a) && a.length < 200 && /(?:wrote|写道)\s*[:：]$/i.test(b) && !/[:：]$/.test(a);
  };
  const quoteRunsToEnd = (i: number): boolean => {
    let nonQuote = 0;
    for (let j = i; j < lines.length; j++) {
      const l = lines[j]!.trim();
      if (!l || l.startsWith(">")) continue;
      if (++nonQuote > 3) return false;
    }
    return true;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (attribution(i) || (l.startsWith(">") && quoteRunsToEnd(i))) {
      const main = lines.slice(0, i).join("\n").replace(/\s+$/, "");
      if (!main.trim()) return { main: text, quoted: "" };
      return { main, quoted: lines.slice(i).join("\n").trim() };
    }
  }
  return { main: text, quoted: "" };
}

/**
 * Undo hard wrapping in plain-text mail (most clients wrap at 72-78 columns): a line of 55-80
 * characters is joined with the next when the next goes on with the same paragraph. Quoted (">"),
 * list, indented and short lines keep their breaks, so tables, lists and signatures stay as written.
 */
export function reflowPlain(text: string): string {
  const LIST = /^\s*(?:[-*•+]|\d{1,3}[.)])\s/;
  const indent = (l: string) => /^[ \t]*/.exec(l)![0].length;
  const canJoin = (prev: string, next: string): boolean => {
    const p = prev.replace(/\s+$/, "");
    const len = [...p.trim()].length;
    if (len < 55 || len > 80 || /^\s*>/.test(p) || /[:：]$/.test(p)) return false;
    if (!next.trim() || /^\s*>/.test(next) || LIST.test(next)) return false;
    // An indented line goes on only a list item or an indented line (a wrapped bullet), never plain prose.
    if (indent(next) >= 2) return LIST.test(p) || indent(p) >= 2;
    return true;
  };
  const out: string[] = [];
  let para: string | null = null;
  let prev = "";
  for (const line of text.split("\n")) {
    if (para !== null && canJoin(prev, line)) para = para.replace(/\s+$/, "") + " " + line.trim();
    else {
      if (para !== null) out.push(para);
      para = line;
    }
    prev = line;
  }
  if (para !== null) out.push(para);
  return out.join("\n");
}

// ---- writing ----

/** RFC 2047 B-encoded words for non-ASCII text, split so each word stays under 75 characters. */
export function encodeHeaderValue(v: string): string {
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words: string[] = [];
  let chunk = "";
  const flush = () => {
    if (chunk) words.push(`=?UTF-8?B?${btoa(bytesToBinary(new TextEncoder().encode(chunk)))}?=`);
    chunk = "";
  };
  for (const ch of v) {
    // 45 UTF-8 bytes -> 60 base64 characters + 12 of framing = 72.
    if (new TextEncoder().encode(chunk + ch).length > 45) flush();
    chunk += ch;
  }
  flush();
  return words.join("\r\n ");
}

function quoteName(name: string): string {
  const clean = sanitizeLine(name, 200);
  if (!clean) return "";
  if (!/^[\x20-\x7e]*$/.test(clean)) return encodeHeaderValue(clean);
  return /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(clean) ? clean : `"${clean.replace(/["\\]/g, "\\$&")}"`;
}

/** One mailbox for a header: validated address, cleaned and encoded name. */
export function formatPerson(p: EmailPerson): string {
  if (!isAddress(p.address)) throw new Error("invalid address");
  const name = p.name ? quoteName(p.name) : "";
  return name ? `${name} <${p.address}>` : p.address;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function uniq(list: EmailPerson[], minus: string[]): EmailPerson[] {
  const seen = new Set(minus.map((m) => m.toLowerCase()));
  const out: EmailPerson[] = [];
  for (const p of list) {
    const k = p.address.toLowerCase();
    if (seen.has(k) || !isAddress(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export type ReplyBase = {
  from: EmailPerson[];
  replyTo: EmailPerson[];
  to: EmailPerson[];
  cc: EmailPerson[];
  subject: string;
  /** The Message-ID header of the message replied to (with <>), or "". */
  messageId: string;
  /** Its References header, or "". */
  references: string;
};

/**
 * Reply-all recipients: To = the sender (Reply-To when set) + the original To; Cc = the original
 * Cc; the owner's own address and duplicates removed. Replying to the owner's own message goes to
 * that message's recipients again. Nobody left (a note to self): To = the owner.
 */
export function replyAllRecipients(m: ReplyBase, self: string): { to: EmailPerson[]; cc: EmailPerson[] } {
  const fromSelf = m.from.some((p) => sameAddress(p.address, self));
  const head = fromSelf ? [] : m.replyTo.length ? m.replyTo : m.from;
  const to = uniq([...head, ...m.to], [self]);
  const cc = uniq(m.cc, [self, ...to.map((p) => p.address)]);
  if (!to.length && !cc.length) return { to: [{ address: self.toLowerCase() }], cc: [] };
  if (!to.length) return { to: cc, cc: [] };
  return { to, cc };
}

export function replySubject(subject: string): string {
  const s = sanitizeLine(subject, 900);
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`.trimEnd();
}

const MSGID_RE = /<[^<>\s]{1,250}>/g;

/** References for a reply: the parent's References (or In-Reply-To) plus the parent's Message-ID (RFC 5322 3.6.4), bounded. */
export function replyReferences(m: Pick<ReplyBase, "messageId" | "references">): { inReplyTo: string; references: string } {
  const parent = (m.messageId.match(MSGID_RE) ?? [])[0] ?? "";
  const refs = [...(m.references.match(MSGID_RE) ?? []), ...(parent ? [parent] : [])];
  const unique = [...new Set(refs)];
  // Keep the first (thread root) and the newest ones; very long chains are trimmed in the middle.
  const kept = unique.length > 20 ? [unique[0]!, ...unique.slice(-19)] : unique;
  return { inReplyTo: parent, references: kept.join(" ") };
}

function foldBase64(b: Uint8Array): string {
  const s = btoa(bytesToBinary(b));
  return s.replace(/.{1,76}/g, "$&\r\n");
}

export type OutgoingEmail = {
  from: string;
  to: EmailPerson[];
  cc: EmailPerson[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  date?: Date;
  /** One file: the message becomes multipart/mixed (the text, then the file as an attachment). */
  attachment?: OutgoingFile;
  /** The multipart boundary (tests); random otherwise. */
  boundary?: string;
};

/** A file to attach: a cleaned name (protocol fileName) and a validated MIME type (MIME_RE: no quotes, spaces or ;). */
export type OutgoingFile = { fileName: string; mimeType: string; bytes: Uint8Array };

/** `value` as a quoted MIME parameter: ASCII only, quotes and backslashes escaped. */
function quotedParam(value: string): string {
  return `"${value.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "\\$&")}"`;
}

/** RFC 2231 / 5987 ext-value: UTF-8, every byte outside attr-char percent-encoded. */
export function rfc2231(value: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(value)) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9!#$&+.^_`|~-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `UTF-8''${out}`;
}

/**
 * Content-Type and Content-Disposition for an attached file. ASCII names go as a quoted filename;
 * others as an ASCII fallback plus filename* (RFC 2231), which Gmail and every current client read.
 */
export function attachmentHeaders(f: Pick<OutgoingFile, "fileName" | "mimeType">): string[] {
  const name = sanitizeLine(f.fileName, 255) || "file";
  const ascii = /^[\x20-\x7e]*$/.test(name);
  const fallback = quotedParam(name);
  const ext = ascii ? "" : `; filename*=${rfc2231(name)}`;
  return [`Content-Type: ${f.mimeType}; name=${fallback}`, `Content-Disposition: attachment; filename=${fallback}${ext}`, "Content-Transfer-Encoding: base64"];
}

function randomBoundary(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  // "=_" never occurs in base64 lines, so the boundary cannot appear in a part.
  return `=_jinbox_${bytesToB64url(b)}`;
}

/** An RFC 5322 plain-text message (CRLF), UTF-8, base64 body; with a file, multipart/mixed. Throws on an invalid address. */
export function buildMessage(m: OutgoingEmail): string {
  if (!isAddress(m.from)) throw new Error("invalid from");
  if (!m.to.length) throw new Error("no recipients");
  const lines = [
    `From: ${m.from}`,
    `To: ${m.to.map(formatPerson).join(",\r\n ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(formatPerson).join(",\r\n ")}`] : []),
    `Subject: ${encodeHeaderValue(sanitizeLine(m.subject, 900))}`,
    `Date: ${(m.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    ...(m.inReplyTo && /^<[^<>\s]+>$/.test(m.inReplyTo) ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references && /^(<[^<>\s]+>)( <[^<>\s]+>)*$/.test(m.references) ? [`References: ${m.references}`] : []),
    "MIME-Version: 1.0",
  ];
  const body = foldBase64(new TextEncoder().encode(m.text.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n")));
  const textHead = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
  if (!m.attachment) return `${[...lines, ...textHead].join("\r\n")}\r\n\r\n${body}`;
  const b = m.boundary ?? randomBoundary();
  return [
    `${[...lines, `Content-Type: multipart/mixed; boundary="${b}"`].join("\r\n")}\r\n`,
    `--${b}`,
    `${textHead.join("\r\n")}\r\n`,
    body,
    `--${b}`,
    `${attachmentHeaders(m.attachment).join("\r\n")}\r\n`,
    foldBase64(m.attachment.bytes),
    `--${b}--\r\n`,
  ].join("\r\n");
}

/** users.messages.send `raw`: the message as UTF-8 bytes (headers are ASCII except internationalized addresses), base64url. */
export function rawForGmail(message: string): string {
  return bytesToB64url(new TextEncoder().encode(message));
}
