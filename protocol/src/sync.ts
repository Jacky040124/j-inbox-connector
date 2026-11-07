// Sync ("sync.v1", task #57, design: raft-artifacts.com/p/jackyland/j-inbox-sync-design): the
// owner's computer is the only truth about the inbox. The connector keeps the inbox materialized
// (every chat's ChatSummary and its newest messages, in inbox.db) and numbers every change to it in
// one changelog. The page keeps a replica: it pulls a snapshot or the changes since its cursor
// (sync_pull, through the cloud's relay like any action) and applies the changes pushed to it
// (`sync` frames, relayed by the cloud to every open page). The cloud parses nothing of a change
// beyond the frame's schema and keeps none of it: it relays, as it relays read_chat's answers.
//
// Rules every side keeps:
// - A change carries the whole new state of what it names (a chat's whole summary; the messages
//   themselves), never a patch: applying one twice, or applying an older one that a newer one
//   already replaced, changes nothing.
// - seq is the changelog's order, contiguous within an epoch. A page that sees a seq other than
//   cursor+1 stops applying pushes and pulls from its cursor (it keeps the early ones to apply after).
// - epoch names one changelog. inbox.db rebuilt (new install, wiped, schema change): a new epoch.
//   A page whose epoch differs from the connector's throws its replica away and takes a snapshot.
// - A change caused by the owner's own request carries that request's opId (reqFrame.opId): the
//   page's optimistic copy of that request is done when it sees it.
// - Only chats in the window are kept: active in the last SYNC_WINDOW_DAYS days, or not archived.
//   A chat that leaves the window (archived and older) is removed with `chat.remove`; an older one
//   is still read with read_chat / list_chats as before.
import { array, boolean, discriminated, integer, isoDateTime, literal, nullable, object, optional, string, type Infer } from "./schema.ts";
import { chatID, chatSummary, messageID, messageItem } from "./model.ts";

/** A chat in the window was active this recently, or is not archived. */
export const SYNC_WINDOW_DAYS = 90;
/** The newest messages kept per chat (and sent per chat in a snapshot). Older ones: read_chat. */
export const SYNC_MESSAGES_PER_CHAT = 50;
/** Changes in one `sync` event or one delta page. The sender also keeps a frame under MAX_FRAME_BYTES. */
export const MAX_SYNC_CHANGES = 200;
/** Chats in one snapshot page (with their messages, under MAX_FRAME_BYTES: the connector makes pages smaller when it must). */
export const MAX_SYNC_SNAPSHOT_CHATS = 100;
/** The connector keeps at least this many of the newest changes; a cursor older than what it kept gets a snapshot. */
export const SYNC_CHANGELOG_KEEP = 10_000;

export const syncEpoch = string({ min: 8, max: 64, pattern: /^[A-Za-z0-9_-]+$/, format: "sync-epoch" });
export const syncSeq = integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
/** The id the page gives one of its own requests, so the change it causes can be matched to it. */
export const syncOpId = string({ min: 8, max: 40, pattern: /^op_[A-Za-z0-9]+$/, format: "sync-op-id" });
const snapshotCursor = string({ min: 1, max: 512, pattern: /^[A-Za-z0-9_.=-]+$/, format: "sync-snapshot-cursor" });

const base = { seq: syncSeq, at: isoDateTime(), opId: optional(syncOpId) };

export const syncChange = discriminated("op", {
  /** The chat's whole summary now (preview, To do, noise and all). */
  "chat.upsert": object({ ...base, op: literal("chat.upsert"), chat: chatSummary }),
  /** The chat is gone, or left the window: forget it and its messages. */
  "chat.remove": object({ ...base, op: literal("chat.remove"), chatID }),
  /** These messages of the chat, as they are now (new or changed). The page keeps the newest SYNC_MESSAGES_PER_CHAT. */
  "messages.upsert": object({ ...base, op: literal("messages.upsert"), chatID, messages: array(messageItem, { min: 1, max: SYNC_MESSAGES_PER_CHAT }) }),
  /** These messages were deleted. */
  "messages.remove": object({ ...base, op: literal("messages.remove"), chatID, messageIDs: array(messageID, { min: 1, max: SYNC_MESSAGES_PER_CHAT }) }),
});
export type SyncChange = Infer<typeof syncChange>;

/** sync_pull's params: what the page has. Neither: a first visit (a snapshot). */
export const syncPullParams = object({
  /** The epoch of the page's replica, if it has one. */
  epoch: optional(nullable(syncEpoch)),
  /** The last seq the page applied. */
  cursor: optional(nullable(integer({ min: 0, max: Number.MAX_SAFE_INTEGER }))),
  /** A snapshot's next page (snapshot.next of the page before). */
  page: optional(snapshotCursor),
});
export type SyncPullParams = Infer<typeof syncPullParams>;

/** A chat and its newest messages, newest last, at most SYNC_MESSAGES_PER_CHAT. */
export const syncSnapshotChat = object({ chat: chatSummary, messages: array(messageItem, { max: SYNC_MESSAGES_PER_CHAT }) });
export type SyncSnapshotChat = Infer<typeof syncSnapshotChat>;

export const syncPullResult = discriminated("kind", {
  /**
   * The changes after the page's cursor, in order (from = cursor + 1). more: there are more after
   * these; pull again with cursor = the last seq here. Empty changes and more false: up to date.
   */
  delta: object({ kind: literal("delta"), epoch: syncEpoch, head: integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), changes: array(syncChange, { max: MAX_SYNC_CHANGES }), more: boolean() }),
  /**
   * The whole window as of `head`, a page at a time, newest activity first. The page replaces its
   * replica with all the pages together (next null on the last), sets cursor = head, then pulls a
   * delta from there for what changed while it read the pages.
   */
  snapshot: object({ kind: literal("snapshot"), epoch: syncEpoch, head: integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), chats: array(syncSnapshotChat, { max: MAX_SYNC_SNAPSHOT_CHATS }), next: nullable(snapshotCursor) }),
});
export type SyncPullResult = Infer<typeof syncPullResult>;

/**
 * Connector -> cloud (a connector frame of its own, not an `event`), and cloud -> every open page
 * (the same object as a /live message): changes as they happen, in seq order.
 */
export const syncFrame = object({
  type: literal("sync"),
  epoch: syncEpoch,
  changes: array(syncChange, { min: 1, max: MAX_SYNC_CHANGES }),
});
export type SyncFrame = Infer<typeof syncFrame>;
