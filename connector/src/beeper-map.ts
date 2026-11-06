// Raw Beeper Client API JSON -> J-Inbox protocol shapes. Beeper omits fields the protocol
// requires (real iMessage messages have no `type`; isSender, chat flags and Account.network are
// optional in the spec), so this module owns the documented defaults (protocol README "Mapping
// Beeper data"). Everything coming from Beeper is untrusted text: single-line fields are
// sanitizeLine'd, message bodies sanitizeText'd and truncated. Records missing an id the protocol
// needs are dropped (null), never invented.
import {
  ACCOUNT_STATUSES,
  htmlToPlainText,
  parseSharedPost,
  sharedPost as sharedPostSchema,
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
import { contactKey, contactName, isAddress, sameAddress } from "./contacts.ts";
import { noteHiddenPreview } from "./todo/store.ts";

type Raw = Record<string, any>;
export type MapOptions = {
  /** Keep a message Beeper hides (a chat's preview may be one: iMessage's tapback). History drops them. */
  keepHidden?: boolean;
  /** Called with every asset URL put into a result; get_media serves only these. */
  onAsset?: (url: string) => void;
  /** The owner's own user IDs: reactions from them get isSelf, messages from them isSender. */
  selfIDs?: ReadonlySet<string>;
  /** The owner's own numbers and emails (contactKey form, selfAddressesIn): a message signed with one is the owner's. */
  selfAddresses?: ReadonlySet<string>;
  /** The chat's people by user ID (chatPeople): names for senders Beeper leaves unnamed, network bots. */
  people?: ReadonlyMap<string, Person>;
  /** A one-to-one chat's other person (the chat's title): the name of their messages Beeper leaves unnamed. */
  otherName?: string;
  /** Names seen for user IDs in other chats and earlier messages (namesIn): a big group's people Beeper leaves out of its list. */
  names?: ReadonlyMap<string, string>;
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

function mapReaction(r: unknown, selfIDs?: ReadonlySet<string>): Reaction | null {
  if (!isObj(r)) return null;
  const reactionKey = line(r.reactionKey, MAX_REACTION_KEY_LENGTH);
  const participantID = ok(idSchema, r.participantID);
  if (!reactionKey || !participantID) return null;
  const out: Reaction = { reactionKey, participantID };
  if (typeof r.emoji === "boolean") out.emoji = r.emoji;
  if (selfIDs?.has(participantID)) out.isSelf = true;
  return out;
}

/**
 * The owner's own user IDs a raw chat or message shows: participants marked isSelf, the sender of
 * the owner's messages, and (given the owner's numbers and emails) whoever has or signs with one of
 * them. Beeper uses the owner's Beeper ID for most networks, so IDs learned in one chat also mark
 * reactions and messages in big groups whose participant list leaves the owner out.
 */
export function selfIDsIn(raw: unknown, selfAddresses?: ReadonlySet<string>): string[] {
  if (!isObj(raw)) return [];
  const out: string[] = [];
  if (Array.isArray(raw.participants?.items))
    for (const u of raw.participants.items)
      if (isObj(u) && (u.isSelf === true || [u.phoneNumber, u.email].some((v) => isSelfAddress(v, selfAddresses))) && ok(idSchema, u.id)) out.push(u.id);
  if ((raw.isSender === true || isSelfAddress(raw.senderName, selfAddresses)) && ok(idSchema, raw.senderID)) out.push(raw.senderID);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Who wrote a message, and system lines. Beeper does not always say: iMessage marks the owner's
// messages from another of the owner's numbers as someone else's, a name may be missing or an ID,
// and bridges send events ("X joined the chat", "{{sender}} unsent a message") as plain text.

/** What a chat's participant list says about one person. */
export type Person = { name?: string; bot?: true };

const MATRIX_USER_ID = /^@[^\s:]+:[A-Za-z0-9.-]+$/;
/** An ID where a name should be: a Matrix user ID ("@whatsapp_lid-123:beeper.local") or iMessage's own ("imsg##participant:…"). */
const idAsName = (s: string, id?: unknown) => {
  const t = s.trim();
  return MATRIX_USER_ID.test(t) || t.startsWith("imsg##") || t === id;
};

function isSelfAddress(v: unknown, selfAddresses?: ReadonlySet<string>): boolean {
  if (!selfAddresses?.size || typeof v !== "string") return false;
  const k = contactKey(v);
  return k !== null && selfAddresses.has(k);
}

/**
 * The owner's own numbers and emails (contactKey form) a raw chat or account shows: its participants marked isSelf,
 * an account's user. iMessage can send from any of them, and Beeper then names the owner by the number.
 */
export function selfAddressesIn(raw: unknown): string[] {
  if (!isObj(raw)) return [];
  const users: unknown[] = Array.isArray(raw.participants?.items) ? raw.participants.items.filter((u: unknown) => isObj(u) && u.isSelf === true) : [];
  if (typeof raw.accountID === "string" && isObj(raw.user)) users.push(raw.user);
  return users.flatMap((u) => (isObj(u) ? [u.phoneNumber, u.email] : [])).flatMap((v) => (typeof v === "string" && contactKey(v) ? [contactKey(v)!] : []));
}

/** A person's name as the owner would know them: their name, else their number or email (as the owner's Contacts name it). */
function personName(u: Raw): string | undefined {
  const full = typeof u.fullName === "string" && u.fullName.trim() && !idAsName(u.fullName, u.id) ? u.fullName : undefined;
  const address = [u.phoneNumber, u.email].find((v): v is string => typeof v === "string" && isAddress(v));
  const name = full ? (contactName(full) ?? full) : address ? (contactName(address) ?? address) : undefined;
  return name ? sanitizeLine(name, MAX_NAME_LENGTH) || undefined : undefined;
}

/** A raw chat's people by user ID (Beeper may list only some of a big group's), and its other person if one-to-one. */
export function chatPeople(raw: unknown): Pick<MapOptions, "people" | "otherName"> {
  if (!isObj(raw)) return {};
  const people = new Map<string, Person>();
  if (Array.isArray(raw.participants?.items))
    for (const u of raw.participants.items) {
      if (!isObj(u) || typeof u.id !== "string" || people.has(u.id)) continue;
      const name = personName(u);
      people.set(u.id, { ...(name ? { name } : {}), ...(u.isNetworkBot === true ? { bot: true as const } : {}) });
    }
  const other = raw.type === "group" ? "" : line(chatTitle(raw), MAX_NAME_LENGTH);
  return { people, ...(other ? { otherName: other } : {}) };
}

/**
 * Names for user IDs a raw chat or message shows: its participants (their name, else number or email), the named
 * sender of a message someone else wrote, a chat's preview. Beeper lists only 20 of a chat's people with the chat
 * list, so a big group's preview may come from someone named only in another chat or in a message read before.
 */
export function namesIn(raw: unknown): [string, string][] {
  if (!isObj(raw)) return [];
  const out: [string, string][] = [];
  if (Array.isArray(raw.participants?.items))
    for (const u of raw.participants.items) {
      const name = isObj(u) && u.isSelf !== true && ok(idSchema, u.id) ? personName(u) : undefined;
      if (name) out.push([u.id, name]);
    }
  const id = ok(idSchema, raw.senderID);
  if (id && raw.isSender !== true && typeof raw.senderName === "string" && raw.senderName.trim() && !idAsName(raw.senderName, id)) {
    const name = sanitizeLine(contactName(raw.senderName) ?? raw.senderName, MAX_NAME_LENGTH);
    if (name) out.push([id, name]);
  }
  if (isObj(raw.preview)) out.push(...namesIn(raw.preview));
  return out;
}

/** A network bridge's bot ("@twitterbot:beeper.local"): what it writes in a chat is the network's own system line. Named ones only: "@robot:beeper.com" may be a person. */
const BRIDGE_BOT = /^@(?:whatsapp|twitter|instagram|facebook|messenger|meta|signal|telegram|discord|slack|linkedin|gmessages|googlechat|gvoice|imessage|bluesky)bot:[A-Za-z0-9.-]+$/;
/** Beeper's template for an iMessage event: "{{sender}} added {{+15550100}} to the conversation", "{{sender}} unsent a message". */
const TEMPLATE_PART = /\{\{([^{}\n]{1,320})\}\}/g;
/** The WhatsApp bridge's own lines ("Ana joined the chat", "+15550100 was invited to the chat"), sent as text: [whole, who, what]. */
const WHATSAPP_EVENT = /^([^\n]{1,60}) (joined the chat|left the chat|was (?:invited to|added to|removed from) the chat)$/;
const PHONE_NUMBER = /^\+\d{7,15}$/;
/** iMessage's "{{sender}} added {{+15550100}} to the conversation": [whole, verb, who, preposition]. */
const TEMPLATE_ADD = /^\{\{sender\}\} (added|removed) \{\{([^{}\n]{1,320})\}\} (to|from) the conversation$/;
const WHATSAPP_CALL = /^Incoming (video )?call\. Use the WhatsApp app to answer\.$/;

/** A person named in a template: the owner is "you", a number or email the name it has in the owner's Contacts. */
function templateName(part: string, opts: MapOptions): string {
  if (isSelfAddress(part, opts.selfAddresses) || opts.selfIDs?.has(part)) return "you";
  if (isAddress(part)) return contactName(part) ?? part;
  return opts.people?.get(part)?.name ?? "someone";
}

/**
 * The system line a message is, in words to show, or null for a message someone wrote: Beeper's iMessage templates
 * with their people named, the WhatsApp bridge's join, invite and call lines, anything a network's bot writes.
 */
function systemLine(raw: Raw, text: string, sender: { own: boolean; name?: string }, opts: MapOptions): string | null {
  const t = text.trim();
  if (t.startsWith("{{") && t.length <= 1000 && !t.includes("\n")) {
    // Beeper signs some adds with the person added ("{{sender}} added {{+1…}}", both the owner's number): one person, said once.
    const add = TEMPLATE_ADD.exec(t);
    const who = add?.[2]!.trim();
    if (add && who && (sender.own ? isSelfAddress(who, opts.selfAddresses) || !!opts.selfIDs?.has(who) : who === raw.senderID || (typeof raw.senderName === "string" && sameAddress(raw.senderName, who))))
      return `${sender.own ? "You were" : `${sender.name ?? templateName(who, opts)} was`} ${add[1]} ${add[3]} the conversation`;
    const parts = [...t.matchAll(TEMPLATE_PART)].map((m) => m[1]!.trim());
    // Only Beeper's own parts (the sender, a number or email, an ID): a message someone typed with braces in it ("{{name}}") stays a message.
    if (parts.every((p) => p === "sender" || isAddress(p) || /^\+?\d{3,15}$/.test(p) || p.startsWith("imsg##") || MATRIX_USER_ID.test(p)))
      return t.replace(TEMPLATE_PART, (_m, p: string) => (p.trim() === "sender" ? (sender.own ? "You" : (sender.name ?? "Someone")) : templateName(p.trim(), opts)));
  }
  if (typeof raw.accountID === "string" && /whatsapp/i.test(raw.accountID)) {
    const call = WHATSAPP_CALL.exec(t);
    if (call) return call[1] ? "📹 Video call" : "📞 Voice call";
    // Only when who it names is the sender (a join or leave comes from the person), a number (the bridge's way of naming
    // someone it has no name for), one of the chat's people, or, for an invite, the owner: "Mom left the chat" from Ana is Ana's.
    const ev = WHATSAPP_EVENT.exec(t);
    const who = ev?.[1]!.trim().toLowerCase();
    const names = [raw.senderName, sender.name].filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase());
    const known = (n: string) => names.includes(n) || [...(opts.people?.values() ?? [])].some((p) => p.name?.trim().toLowerCase() === n);
    if (ev && who && (PHONE_NUMBER.test(who) || known(who) || (sender.own && ev[2]!.startsWith("was ")))) return t;
  }
  if (BRIDGE_BOT.test(String(raw.senderID)) || opts.people?.get(String(raw.senderID))?.bot) return text;
  return null;
}

export function mapMessage(raw: unknown, opts: MapOptions = {}): MessageItem | null {
  if (!isObj(raw)) return null;
  // iMessage's tapback, as a message of its own ("{{sender}} liked ..."): Beeper marks it hidden, and the reaction is on the message it was for.
  if (raw.isHidden === true && !opts.keepHidden) return null;
  const id = ok(idSchema, raw.id);
  const chatID = ok(chatIDSchema, raw.chatID);
  const accountID = ok(idSchema, raw.accountID);
  const senderID = ok(idSchema, raw.senderID);
  const timestamp = ok(iso, raw.timestamp);
  const sortKey = ok(sortKeySchema, raw.sortKey);
  if (!id || !chatID || !accountID || !senderID || !timestamp || !sortKey) return null;
  // The owner's own: Beeper says so, or the sender is one of the owner's IDs or numbers (iMessage from another of the owner's numbers).
  const own = raw.isSender === true || !!opts.selfIDs?.has(senderID) || isSelfAddress(raw.senderName, opts.selfAddresses);
  const out: MessageItem = { id, chatID, accountID, senderID, timestamp, sortKey, type: messageTypeOf(raw), isSender: own };
  // Beeper sometimes gives the sender's ID as the name ("@whatsapp_lid-123:beeper.local" in chat-list previews,
  // "imsg##participant:…" in iMessage groups), or no name: the chat's participants, else a one-to-one chat's
  // other person, else the name seen for the ID elsewhere, name them (the owner's own messages need none). No name is better than an ID.
  const given = typeof raw.senderName === "string" && raw.senderName.trim() && !idAsName(raw.senderName, senderID) ? sanitizeLine(contactName(raw.senderName) ?? raw.senderName, MAX_NAME_LENGTH) : undefined;
  const name = given || (own ? undefined : opts.people?.get(senderID)?.name || opts.otherName || opts.names?.get(senderID));
  if (name) out.senderName = name;
  if (typeof raw.text === "string") {
    // Beeper's own template for a hidden tapback: the row already says who.
    const body = raw.isHidden === true ? raw.text.replace(/\{\{sender\}\}\s*/g, "") : raw.text;
    // A system event Beeper sends as text: a line of its own, in words to show.
    const system = raw.isHidden !== true && raw.isDeleted !== true && (out.type === "TEXT" || out.type === "NOTICE") ? systemLine(raw, htmlToPlainText(raw.text), { own, name }, opts) : null;
    if (system !== null) out.type = "NOTICE";
    const t = truncateText(sanitizeText(system ?? htmlToPlainText(body)), MAX_RESULT_TEXT_LENGTH);
    out.text = t.text;
    if (t.truncated) out.textTruncated = true;
    const post = parseSharedPost(raw.text);
    if (post) {
      const sp = ok(sharedPostSchema, {
        network: post.network,
        url: post.url,
        ...(post.author ? { author: sanitizeLine(post.author, 64) } : {}),
        ...(post.caption ? { caption: truncateText(sanitizeText(post.caption), 4000).text } : {}),
      });
      if (sp) out.sharedPost = sp;
    }
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
    const list = raw.reactions.map((r: unknown) => mapReaction(r, opts.selfIDs)).filter((r): r is Reaction => r !== null).slice(0, MAX_REACTIONS_PER_MESSAGE);
    if (list.length) out.reactions = list;
  }
  const status = raw.sendStatus?.status;
  if ((SEND_STATUSES as readonly string[]).includes(status)) out.sendStatus = status;
  return out;
}

/** Beeper leaves imgURL empty on most 1:1 chats; the other person's picture is on the participant. */
function otherParticipantImage(raw: Raw): unknown {
  const items = raw.participants?.items;
  if (!Array.isArray(items)) return undefined;
  return items.find((u: unknown) => isObj(u) && u.isSelf !== true && typeof u.imgURL === "string" && u.imgURL.length > 0)?.imgURL;
}

/**
 * iMessage names a chat after its people's numbers. Each becomes the name it has in the owner's Contacts; a
 * group's title made of nothing but numbers and addresses also loses the owner's own, which Beeper lists too.
 */
function chatTitle(raw: Raw): string {
  const title = line(raw.title, MAX_TITLE_LENGTH) ?? "";
  if (raw.type !== "group") return contactName(title) ?? title;
  const parts = title.split(/, | & /);
  if (parts.length < 2 || !parts.every(isAddress)) return title;
  const items: unknown[] = Array.isArray(raw.participants?.items) ? raw.participants.items : [];
  const self = items.filter((u): u is Raw => isObj(u) && u.isSelf === true).flatMap((u) => [u.phoneNumber, u.email]).filter((v): v is string => typeof v === "string");
  const others = parts.filter((p) => !self.some((v) => sameAddress(v, p)));
  const names = (others.length ? others : parts).map((p) => contactName(p) ?? p);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}` : names[0]!;
}

/**
 * Beeper calls every Apple Messages thread iMessage, text messages too, and does not say which service a thread uses.
 * A one-to-one thread with a short code (3 to 6 digits), a Chinese service number (106…, China Mobile's 10086… and
 * 1252…) or a Google business sender (RCS, "…@rbm.goog") can only be a text message thread. Other text threads
 * still look like iMessage.
 */
const TEXT_ONLY_SENDER = (v: unknown) => {
  if (typeof v !== "string") return false;
  const t = v.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return /^\d{3,6}$/.test(t) || /^(?:\+?86)?(?:106\d{5,17}|10086\d{1,15}|1252\d{4,16})$/.test(t.replace(/[\s-]/g, "")) || /^[^\s@]+@rbm\.goog$/i.test(t);
};
function isTextThread(raw: Raw, out: ChatSummary): boolean {
  if (out.type !== "single" || !(out.network.toLowerCase() === "imessage" || out.id.startsWith("imsg##"))) return false;
  const others: Raw[] = Array.isArray(raw.participants?.items) ? raw.participants.items.filter((u: unknown): u is Raw => isObj(u) && u.isSelf !== true) : [];
  const preview = isObj(raw.preview) && raw.preview.isSender !== true ? raw.preview.senderName : undefined;
  return [raw.title, preview, ...others.flatMap((u) => [u.phoneNumber, u.email, u.fullName])].some(TEXT_ONLY_SENDER);
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
    title: line(chatTitle(raw), MAX_TITLE_LENGTH) ?? "",
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
  const avatar = assetFrom(raw.imgURL ?? (out.type === "single" ? otherParticipantImage(raw) : undefined), opts);
  if (avatar) out.avatarURL = avatar;
  // Only whether a draft exists: the owner's unsent text never leaves the Mac.
  if (isObj(raw.draft)) out.hasDraft = typeof raw.draft.text === "string" && raw.draft.text.length > 0;
  if (isTextThread(raw, out)) out.textMessage = true;
  if ("preview" in raw) out.preview = raw.preview ? mapMessage(raw.preview, { ...chatPeople(raw), ...opts, keepHidden: true }) : null;
  if (out.preview && raw.preview.isHidden === true) noteHiddenPreview(out.preview);
  return out;
}

export function mapAccount(raw: unknown): Account | null {
  if (!isObj(raw)) return null;
  const accountID = ok(idSchema, raw.accountID);
  if (!accountID) return null;
  const out: Account = {
    accountID,
    network: line(raw.network, 64) || "Unknown",
    status: (ACCOUNT_STATUSES as readonly string[]).includes(raw.status) ? raw.status : "unknown",
  };
  const u = isObj(raw.user) ? raw.user : {};
  const name = [u.displayText, u.fullName, u.username, u.phoneNumber, u.email].map((v) => line(v, MAX_NAME_LENGTH)).find((v) => v);
  if (name) out.name = name;
  const statusText = line(raw.statusText, 200);
  if (statusText) out.statusText = statusText;
  // The Beeper account itself ("matrix") has no bridge login to remove; bridge logins do.
  out.removable = typeof raw.loginID === "string" && raw.loginID.length > 0 && accountID !== "matrix" && !(isObj(raw.bridge) && raw.bridge.type === "matrix");
  return out;
}
