// Gmail API JSON -> J-Inbox protocol shapes. One thread = one chat (chatID gmail:<address>:<threadId>).
// Everything Gmail sends is untrusted: headers are decoded and sanitizeLine'd, bodies decoded in
// their charset (HTML-only mail through emailHtmlToText), sanitizeText'd and truncated. Drafts are
// the owner's unsent text: they never leave the Mac (only hasDraft).
//
// Decisions (design/gmail-plan.md "Model mapping"): title = subject of the thread's first message
// or "(no subject)"; isArchived = no message has INBOX; isLowPriority = a message carries
// CATEGORY_PROMOTIONS / SOCIAL / FORUMS. That is only a hint for a single thread: the lists and
// unread_summary ask Gmail (`category:primary`) and set it from the query, because Gmail shows
// most CATEGORY_UPDATES mail in Primary; isPinned = STARRED; type = group when more than one other
// person is on the thread; lastActivity = the newest message that is not a draft.
import {
  GMAIL_ATTACHMENT_ID_RE,
  GMAIL_ID_RE,
  GMAIL_NETWORK,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_NAME_LENGTH,
  MAX_RESULT_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  emailHeaders,
  gmailAccountID,
  gmailAssetURL,
  gmailChatID,
  mimeType as mimeTypeSchema,
  parse,
  sanitizeLine,
  sanitizeText,
  truncateText,
  type Attachment,
  type ChatSummary,
  type EmailHeaders,
  type MessageItem,
} from "@j-inbox/protocol";
import { b64urlToBytes, charsetOf, decodeCharset, decodeEntities, emailHtmlToText, headerText, parseAddressList } from "./mime.ts";

export type GPart = { partId?: string; mimeType?: string; filename?: string; headers?: { name?: string; value?: string }[]; body?: { size?: number; data?: string; attachmentId?: string }; parts?: GPart[] };
export type GMessage = { id?: string; threadId?: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: GPart };
export type GThread = { id?: string; messages?: GMessage[] };

export const LOW_PRIORITY_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"] as const;
export const NO_SUBJECT = "(no subject)";
const MAX_PART_DEPTH = 12;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const labels = (m: GMessage): string[] => (Array.isArray(m.labelIds) ? m.labelIds.filter((l): l is string => typeof l === "string") : []);
const has = (m: GMessage, l: string) => labels(m).includes(l);
export const isDraft = (m: GMessage) => has(m, "DRAFT");

export function header(p: GPart | undefined, name: string): string {
  if (!p || !Array.isArray(p.headers)) return "";
  const n = name.toLowerCase();
  for (const h of p.headers) if (isObj(h) && typeof h.name === "string" && h.name.toLowerCase() === n && typeof h.value === "string") return h.value;
  return "";
}

function walk(p: GPart | undefined, fn: (p: GPart) => boolean | void, depth = 0): void {
  if (!isObj(p) || depth > MAX_PART_DEPTH) return;
  if (fn(p) === true) return;
  if (Array.isArray(p.parts)) for (const c of p.parts) walk(c, fn, depth + 1);
}

const isFile = (p: GPart) => !!p.body?.attachmentId || (typeof p.filename === "string" && p.filename.length > 0) || /^\s*attachment/i.test(header(p, "Content-Disposition"));

function partText(p: GPart): string | null {
  const data = p.body?.data;
  if (typeof data !== "string" || data.length > MAX_BODY_BYTES * 2) return null;
  const bytes = b64urlToBytes(data);
  return bytes ? decodeCharset(bytes, charsetOf(header(p, "Content-Type"))) : null;
}

/** The plain-text body: the first text/plain part, else the first text/html part as text. null for metadata-only messages. */
export function messageBody(payload: GPart | undefined): string | null {
  let plain: string | null = null;
  let html: string | null = null;
  walk(payload, (p) => {
    if (isFile(p)) return;
    const t = String(p.mimeType ?? "").toLowerCase();
    if (plain === null && t === "text/plain") plain = partText(p);
    else if (html === null && t === "text/html") html = partText(p);
    if (plain !== null) return true;
  });
  if (plain !== null) return plain;
  if (html !== null) return emailHtmlToText(html);
  return null;
}

function attachmentType(mime: string): Attachment["type"] {
  if (mime.startsWith("image/")) return "img";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "unknown";
}

function attachmentsOf(email: string, messageId: string, payload: GPart | undefined, onAsset?: (u: string) => void): Attachment[] {
  const out: Attachment[] = [];
  walk(payload, (p) => {
    if (out.length >= MAX_ATTACHMENTS_PER_MESSAGE) return true;
    const id = p.body?.attachmentId;
    if (typeof id !== "string" || !GMAIL_ATTACHMENT_ID_RE.test(id)) return;
    const mime = String(p.mimeType ?? "").toLowerCase();
    const a: Attachment = { type: attachmentType(mime) };
    const url = gmailAssetURL(email, messageId, id);
    a.url = url;
    onAsset?.(url);
    const m = parse(mimeTypeSchema, mime);
    if (m.ok) a.mimeType = m.value;
    const name = sanitizeLine(decodeEncodedName(p.filename ?? ""), 255);
    if (name) a.fileName = name;
    if (typeof p.body?.size === "number" && Number.isFinite(p.body.size) && p.body.size >= 0) a.fileSize = p.body.size;
    out.push(a);
  });
  return out;
}

function decodeEncodedName(v: string): string {
  return headerText(v, 255);
}

export function emailHeadersOf(payload: GPart | undefined): EmailHeaders {
  const from = parseAddressList(header(payload, "From"), 1)[0] ?? { address: "unknown@unknown.invalid" };
  const h: EmailHeaders = {
    subject: headerText(header(payload, "Subject"), MAX_TITLE_LENGTH),
    from,
    to: parseAddressList(header(payload, "To")),
    cc: parseAddressList(header(payload, "Cc")),
  };
  return parse(emailHeaders, h).ok ? h : { subject: "", from: { address: from.address }, to: [], cc: [] };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function dateOf(m: GMessage): number | null {
  const s = m.internalDate;
  if (typeof s !== "string" || !/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n < 8.64e15 ? n : null;
}

export type GmailMapOptions = { onAsset?: (url: string) => void };

/** One Gmail message as a MessageItem (text from the body when the payload has one, else the snippet). */
export function mapGmailMessage(raw: unknown, email: string, o: GmailMapOptions = {}): MessageItem | null {
  if (!isObj(raw)) return null;
  const m = raw as GMessage;
  const at = dateOf(m);
  if (typeof m.id !== "string" || !GMAIL_ID_RE.test(m.id) || typeof m.threadId !== "string" || !GMAIL_ID_RE.test(m.threadId) || at === null) return null;
  const headers = emailHeadersOf(m.payload);
  const self = headers.from.address === email;
  const out: MessageItem = {
    id: m.id,
    chatID: gmailChatID(email, m.threadId),
    accountID: gmailAccountID(email),
    senderID: headers.from.address,
    senderName: sanitizeLine(headers.from.name ?? headers.from.address, MAX_NAME_LENGTH),
    timestamp: iso(at),
    sortKey: String(at),
    type: "TEXT",
    isSender: has(m, "SENT") || self,
    email: headers,
  };
  const body = messageBody(m.payload);
  const text = body ?? (typeof m.snippet === "string" ? decodeEntities(m.snippet) : "");
  if (text) {
    const t = truncateText(sanitizeText(text).replace(/\s+$/, ""), MAX_RESULT_TEXT_LENGTH);
    out.text = t.text;
    if (t.truncated) out.textTruncated = true;
  }
  out.isUnread = has(m, "UNREAD");
  const atts = attachmentsOf(email, m.id, m.payload, o.onAsset);
  if (atts.length) {
    out.attachments = atts;
    if (!out.text) out.type = atts[0]!.type === "img" ? "IMAGE" : "FILE";
  }
  if (!out.text && !atts.length) out.type = "TEXT";
  return out;
}

/** The thread's messages oldest first, drafts left out (the owner's unsent text stays on the Mac). */
export function threadMessages(t: GThread): GMessage[] {
  const list = Array.isArray(t.messages) ? t.messages.filter((m): m is GMessage => isObj(m) && dateOf(m) !== null) : [];
  return list.filter((m) => !isDraft(m)).sort((a, b) => dateOf(a)! - dateOf(b)! || (String(a.id) < String(b.id) ? -1 : 1));
}

/** One Gmail thread as a ChatSummary, with its newest message as the preview. */
export function mapGmailThread(raw: unknown, email: string, o: GmailMapOptions = {}): ChatSummary | null {
  if (!isObj(raw)) return null;
  const t = raw as GThread;
  if (typeof t.id !== "string" || !GMAIL_ID_RE.test(t.id)) return null;
  const all = Array.isArray(t.messages) ? t.messages.filter(isObj) : [];
  const msgs = threadMessages(t);
  if (!msgs.length && !all.length) return null;
  const first = msgs[0] ?? all[0]!;
  const last = msgs.at(-1) ?? null;
  const people = new Set<string>();
  for (const m of msgs) for (const n of ["From", "To", "Cc"]) for (const p of parseAddressList(header(m.payload, n))) if (p.address !== email) people.add(p.address);
  const subject = headerText(header(first.payload, "Subject"), MAX_TITLE_LENGTH);
  const newest = last ? dateOf(last) : Math.max(...all.map((m) => dateOf(m) ?? 0));
  const chat: ChatSummary = {
    id: gmailChatID(email, t.id),
    accountID: gmailAccountID(email),
    network: GMAIL_NETWORK,
    title: subject || NO_SUBJECT,
    type: people.size > 1 ? "group" : "single",
    unreadCount: msgs.filter((m) => has(m, "UNREAD")).length,
    isPinned: msgs.some((m) => has(m, "STARRED")),
    isMuted: false,
    isArchived: !msgs.some((m) => has(m, "INBOX")),
    isLowPriority: msgs.some((m) => LOW_PRIORITY_LABELS.some((l) => has(m, l))),
    lastActivity: newest ? iso(newest) : null,
    participantCount: people.size + 1,
    hasDraft: all.some(isDraft),
    preview: last ? mapGmailMessage(last, email, o) : null,
  };
  return chat;
}

/** Epoch ms of a chat's last activity (0 when unknown). */
export function activityMs(c: ChatSummary): number {
  const t = c.lastActivity ? Date.parse(c.lastActivity) : NaN;
  return Number.isFinite(t) ? t : 0;
}
