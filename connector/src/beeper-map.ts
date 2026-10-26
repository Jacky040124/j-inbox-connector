// Raw Beeper Client API JSON -> J-Inbox protocol shapes. Beeper omits fields the protocol
// requires (real iMessage messages have no `type`; isSender, chat flags and Account.network are
// optional in the spec), so this module owns the documented defaults (protocol README "Mapping
// Beeper data"). Everything coming from Beeper is untrusted text: single-line fields are
// sanitizeLine'd, message bodies sanitizeText'd and truncated. Records missing an id the protocol
// needs are dropped (null), never invented.
import {
  ACCOUNT_STATUSES,
  ATTACHMENT_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_NAME_LENGTH,
  MAX_REACTIONS_PER_MESSAGE,
  MAX_REACTION_KEY_LENGTH,
  MAX_RESULT_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  MESSAGE_TYPES,
  SEND_STATUSES,
  assetUrl,
  chatID as chatIDSchema,
  isoDateTime,
  mimeType as mimeTypeSchema,
  parse,
  sanitizeLine,
  sanitizeText,
  string,
  truncateText,
  userID as idSchema,
  type Account,
  type Attachment,
  type ChatSummary,
  type MessageItem,
  type Reaction,
} from "@j-inbox/protocol";

type Raw = Record<string, any>;
export type MapOptions = {
  /** Called with every asset URL put into a result; get_media serves only these. */
  onAsset?: (url: string) => void;
};

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const ok = <T>(schema: Parameters<typeof parse<T>>[0], v: unknown): T | undefined => {
  const r = parse(schema, v);
  return r.ok ? r.value : undefined;
};
const iso = isoDateTime();
const sortKeySchema = string({ min: 1, max: 128 });
const asset = assetUrl();
const int = (v: unknown, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : undefined);
const num = (v: unknown, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const line = (v: unknown, max: number): string | undefined => (typeof v === "string" ? sanitizeLine(v, max) : undefined);

/** A local filesystem path (Beeper's chat imgURL) as an encoded file:/// URL, or undefined. */
export function assetURLFromLocalPath(path: unknown): string | undefined {
  if (typeof path !== "string" || !path.startsWith("/")) return undefined;
  const segments = path.split("/");
  if (segments.some((s) => s === "..")) return undefined;
  return ok(asset, "file://" + segments.map((s) => encodeURIComponent(s)).join("/"));
}

function assetFrom(v: unknown, opts: MapOptions): string | undefined {
  const url = (typeof v === "string" && v.startsWith("/") ? assetURLFromLocalPath(v) : ok(asset, v)) ?? undefined;
  if (url) opts.onAsset?.(url);
  return url;
}

/** Message.type, or a derived one when Beeper omits it. */
export function messageTypeOf(raw: Raw): MessageItem["type"] {
  if (typeof raw.type === "string") return (MESSAGE_TYPES as readonly string[]).includes(raw.type) ? (raw.type as MessageItem["type"]) : "UNKNOWN";
  const first = Array.isArray(raw.attachments) ? raw.attachments.find(isObj) : undefined;
  if (first) {
    if (first.type === "img") return first.isSticker ? "STICKER" : "IMAGE";
    if (first.type === "video") return "VIDEO";
    if (first.type === "audio") return first.isVoiceNote ? "VOICE" : "AUDIO";
    return "FILE";
  }
  return typeof raw.text === "string" && raw.text.length > 0 ? "TEXT" : "UNKNOWN";
}

function mapAttachment(a: unknown, opts: MapOptions): Attachment | null {
  if (!isObj(a)) return null;
  const out: Attachment = { type: (ATTACHMENT_TYPES as readonly string[]).includes(a.type) ? a.type : "unknown" };
  const url = assetFrom(a.srcURL, opts);
  if (url) out.url = url;
  const mime = ok(mimeTypeSchema, a.mimeType);
  if (mime) out.mimeType = mime;
  const fileName = line(a.fileName, 255);
  if (fileName) out.fileName = fileName;
  const fileSize = num(a.fileSize, Number.MAX_SAFE_INTEGER);
  if (fileSize !== undefined) out.fileSize = fileSize;
  const width = num(a.size?.width, 1_000_000);
  const height = num(a.size?.height, 1_000_000);
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  const duration = num(a.duration, 1_000_000_000);
  if (duration !== undefined) out.duration = duration;
  for (const k of ["isGif", "isSticker", "isVoiceNote"] as const) if (typeof a[k] === "boolean") out[k] = a[k];
  return out;
}

function mapReaction(r: unknown): Reaction | null {
  if (!isObj(r)) return null;
  const reactionKey = line(r.reactionKey, MAX_REACTION_KEY_LENGTH);
  const participantID = ok(idSchema, r.participantID);
  if (!reactionKey || !participantID) return null;
  const out: Reaction = { reactionKey, participantID };
  if (typeof r.emoji === "boolean") out.emoji = r.emoji;
  return out;
}

export function mapMessage(raw: unknown, opts: MapOptions = {}): MessageItem | null {
  if (!isObj(raw)) return null;
  const id = ok(idSchema, raw.id);
  const chatID = ok(chatIDSchema, raw.chatID);
  const accountID = ok(idSchema, raw.accountID);
  const senderID = ok(idSchema, raw.senderID);
  const timestamp = ok(iso, raw.timestamp);
  const sortKey = ok(sortKeySchema, raw.sortKey);
  if (!id || !chatID || !accountID || !senderID || !timestamp || !sortKey) return null;
  const out: MessageItem = { id, chatID, accountID, senderID, timestamp, sortKey, type: messageTypeOf(raw), isSender: raw.isSender === true };
  if (typeof raw.senderName === "string") out.senderName = sanitizeLine(raw.senderName, MAX_NAME_LENGTH);
  if (typeof raw.text === "string") {
    const t = truncateText(sanitizeText(raw.text), MAX_RESULT_TEXT_LENGTH);
    out.text = t.text;
    if (t.truncated) out.textTruncated = true;
  }
  const isUnread = bool(raw.isUnread);
  if (isUnread !== undefined) out.isUnread = isUnread;
  const isDeleted = bool(raw.isDeleted);
  if (isDeleted !== undefined) out.isDeleted = isDeleted;
  const editedAt = ok(iso, raw.editedTimestamp);
  if (editedAt) out.editedAt = editedAt;
  const reply = ok(idSchema, raw.linkedMessageID);
  if (reply) out.replyToMessageID = reply;
  if (Array.isArray(raw.attachments)) {
    const list = raw.attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE).map((a: unknown) => mapAttachment(a, opts)).filter((a): a is Attachment => a !== null);
    if (list.length) out.attachments = list;
  }
  if (Array.isArray(raw.reactions)) {
    const list = raw.reactions.map(mapReaction).filter((r): r is Reaction => r !== null).slice(0, MAX_REACTIONS_PER_MESSAGE);
    if (list.length) out.reactions = list;
  }
  const status = raw.sendStatus?.status;
  if ((SEND_STATUSES as readonly string[]).includes(status)) out.sendStatus = status;
  return out;
}

export function mapChat(raw: unknown, opts: MapOptions = {}): ChatSummary | null {
  if (!isObj(raw)) return null;
  const id = ok(chatIDSchema, raw.id);
  const accountID = ok(idSchema, raw.accountID);
  if (!id || !accountID) return null;
  const out: ChatSummary = {
    id,
    accountID,
    network: line(raw.network, 64) || "Unknown",
    title: line(raw.title, MAX_TITLE_LENGTH) ?? "",
    type: raw.type === "group" ? "group" : "single",
    unreadCount: int(raw.unreadCount, 1_000_000_000) ?? 0,
    isPinned: raw.isPinned === true,
    isMuted: raw.isMuted === true,
    isArchived: raw.isArchived === true,
    lastActivity: ok(iso, raw.lastActivity) ?? null,
  };
  const mentions = int(raw.unreadMentionsCount, 1_000_000_000);
  if (mentions !== undefined) out.unreadMentionsCount = mentions;
  const lowPriority = bool(raw.isLowPriority);
  if (lowPriority !== undefined) out.isLowPriority = lowPriority;
  const readOnly = bool(raw.isReadOnly);
  if (readOnly !== undefined) out.isReadOnly = readOnly;
  const markedUnread = bool(raw.isMarkedUnread);
  if (markedUnread !== undefined) out.isMarkedUnread = markedUnread;
  const total = int(raw.participants?.total, 1_000_000_000);
  if (total !== undefined) out.participantCount = total;
  const avatar = assetFrom(raw.imgURL, opts);
  if (avatar) out.avatarURL = avatar;
  // Only whether a draft exists: the owner's unsent text never leaves the Mac.
  if (isObj(raw.draft)) out.hasDraft = typeof raw.draft.text === "string" && raw.draft.text.length > 0;
  if ("preview" in raw) out.preview = raw.preview ? mapMessage(raw.preview, opts) : null;
  return out;
}

export function mapAccount(raw: unknown): Account | null {
  if (!isObj(raw)) return null;
  const accountID = ok(idSchema, raw.accountID);
  if (!accountID) return null;
  return {
    accountID,
    network: line(raw.network, 64) || "Unknown",
    status: (ACCOUNT_STATUSES as readonly string[]).includes(raw.status) ? raw.status : "unknown",
  };
}
