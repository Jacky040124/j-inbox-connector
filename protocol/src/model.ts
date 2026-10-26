// Data shapes returned by actions. These are J-Inbox's own normalized view of the
// Beeper Client API (camelCase like Beeper). The connector maps Beeper JSON into them,
// sanitizing and truncating text (see textutil.ts).
import {
  array,
  assetUrl,
  boolean,
  enumOf,
  id,
  integer,
  isoDateTime,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
  text,
  type Infer,
} from "./schema.ts";
import {
  MAX_ACCOUNTS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ID_LENGTH,
  MAX_MEDIA_BYTES,
  MAX_NAME_LENGTH,
  MAX_REACTIONS_PER_MESSAGE,
  MAX_REACTION_KEY_LENGTH,
  MAX_RESULT_TEXT_LENGTH,
  MAX_SEND_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
} from "./limits.ts";

/** IDs J-Inbox mints itself (devices, approvals, requests) use this safe alphabet. */
export const ownId = string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_-]+$/, format: "own-id" });
export const chatID = id(MAX_ID_LENGTH);
export const messageID = id(MAX_ID_LENGTH);
export const accountID = id(MAX_ID_LENGTH);
export const userID = id(MAX_ID_LENGTH);
/** Display network name from Beeper, e.g. "WhatsApp", "Twitter/X", "iMessage". */
export const networkName = string({ min: 1, max: 64 });
export const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
export const mimeType = string({ min: 3, max: 255, pattern: MIME_RE, format: "mime" });
export const versionString = string({ min: 1, max: 64 });

/** Beeper Account.status plus "unknown" for values this protocol version does not know. */
export const ACCOUNT_STATUSES = [
  "connected",
  "connecting",
  "backfilling",
  "connection_required",
  "reconnect_required",
  "attention_required",
  "disconnected",
  "disabled",
  "unknown",
] as const;

export const account = object({
  accountID,
  network: networkName,
  status: enumOf(ACCOUNT_STATUSES),
  /** Who the owner is on that network (Beeper's user displayText, full name or username). */
  name: optional(string({ min: 1, max: MAX_NAME_LENGTH })),
  /** Beeper's human-readable status, e.g. why a reconnect is needed. */
  statusText: optional(string({ min: 1, max: 200 })),
  /** The owner can remove it from the web page (a bridge login; not the Beeper account itself). */
  removable: optional(boolean()),
});
export type Account = Infer<typeof account>;

export const ATTACHMENT_TYPES = ["unknown", "img", "video", "audio"] as const;
export const attachment = object({
  type: enumOf(ATTACHMENT_TYPES),
  /** Pass to get_media to fetch the bytes. */
  url: optional(assetUrl()),
  mimeType: optional(mimeType),
  fileName: optional(string({ min: 1, max: 255 })),
  fileSize: optional(number({ min: 0, max: Number.MAX_SAFE_INTEGER })),
  width: optional(number({ min: 0, max: 1_000_000 })),
  height: optional(number({ min: 0, max: 1_000_000 })),
  duration: optional(number({ min: 0, max: 1_000_000_000 })),
  isGif: optional(boolean()),
  isSticker: optional(boolean()),
  isVoiceNote: optional(boolean()),
});
export type Attachment = Infer<typeof attachment>;

export const reaction = object({
  reactionKey: string({ min: 1, max: MAX_REACTION_KEY_LENGTH }),
  participantID: userID,
  emoji: optional(boolean()),
});
export type Reaction = Infer<typeof reaction>;

/** Beeper Message.type plus "UNKNOWN". */
export const MESSAGE_TYPES = ["TEXT", "NOTICE", "IMAGE", "VIDEO", "VOICE", "AUDIO", "FILE", "STICKER", "LOCATION", "REACTION", "UNKNOWN"] as const;
export const SEND_STATUSES = ["SUCCESS", "PENDING", "FAIL_RETRIABLE", "FAIL_PERMANENT"] as const;

export const messageItem = object({
  id: messageID,
  chatID,
  accountID,
  senderID: userID,
  senderName: optional(nullable(string({ min: 0, max: MAX_NAME_LENGTH }))),
  timestamp: isoDateTime(),
  /** Beeper sortKey: order messages by it (numeric-string compare), not by timestamp. */
  sortKey: string({ min: 1, max: 128 }),
  type: enumOf(MESSAGE_TYPES),
  /** Truncated to MAX_RESULT_TEXT_LENGTH; textTruncated is then true. */
  text: optional(text({ max: MAX_RESULT_TEXT_LENGTH })),
  textTruncated: optional(literal(true)),
  isSender: boolean(),
  isUnread: optional(boolean()),
  isDeleted: optional(boolean()),
  editedAt: optional(isoDateTime()),
  /** Beeper linkedMessageID: the message this one replies to. */
  replyToMessageID: optional(messageID),
  attachments: optional(array(attachment, { max: MAX_ATTACHMENTS_PER_MESSAGE })),
  reactions: optional(array(reaction, { max: MAX_REACTIONS_PER_MESSAGE })),
  sendStatus: optional(enumOf(SEND_STATUSES)),
});
export type MessageItem = Infer<typeof messageItem>;

export const CHAT_TYPES = ["single", "group"] as const;
const count = integer({ min: 0, max: 1_000_000_000 });

export const chatSummary = object({
  id: chatID,
  accountID,
  network: networkName,
  /** Single line, at most MAX_TITLE_LENGTH. */
  title: string({ min: 0, max: MAX_TITLE_LENGTH }),
  type: enumOf(CHAT_TYPES),
  unreadCount: count,
  unreadMentionsCount: optional(count),
  isPinned: boolean(),
  isMuted: boolean(),
  isArchived: boolean(),
  /** Beeper's low-priority inbox. Not in Beeper's main inbox, so not in unread_summary. */
  isLowPriority: optional(boolean()),
  isReadOnly: optional(boolean()),
  isMarkedUnread: optional(boolean()),
  lastActivity: nullable(isoDateTime()),
  participantCount: optional(count),
  /** Avatar as a get_media URL (Beeper gives a local path; the connector converts it to file:///). */
  avatarURL: optional(assetUrl()),
  /** The owner has unsent text in the composer. The text itself never leaves the Mac. */
  hasDraft: optional(boolean()),
  preview: optional(nullable(messageItem)),
});
export type ChatSummary = Infer<typeof chatSummary>;

/** Beeper app.state.updated states plus "unknown". */
export const BEEPER_APP_STATES = [
  "needs-login",
  "initializing",
  "needs-cross-signing-setup",
  "needs-verification",
  "needs-secrets",
  "needs-first-sync",
  "ready",
  "unknown",
] as const;

export const beeperHealth = object({
  reachable: boolean(),
  version: nullable(versionString),
  appState: optional(enumOf(BEEPER_APP_STATES)),
  /** false when Beeper rejected the connector's token (401): re-authorize with `j-inbox doctor`, Beeper itself may be running fine. */
  tokenValid: optional(boolean()),
});
export type BeeperHealth = Infer<typeof beeperHealth>;

export const accountList = array(account, { max: MAX_ACCOUNTS });

export const mediaHead = object({
  mimeType,
  /** null when Beeper sent no Content-Length; the stream is then capped at MAX_MEDIA_BYTES as it runs. */
  size: nullable(integer({ min: 0, max: MAX_MEDIA_BYTES })),
  fileName: optional(nullable(string({ min: 1, max: 255 }))),
});
export type MediaHead = Infer<typeof mediaHead>;
