// The rules a replica of the inbox keeps (sync.ts), in one place: which chats are in the window,
// which messages of a chat are its newest, and how big a change or a frame may be. inbox.db keeps
// them when it writes, and a page keeps the same ones when it applies changes, so that applying the
// changelog from empty gives exactly what inbox.db holds.
//   - The window: a chat active in the last SYNC_WINDOW_DAYS days, or a Beeper chat that is not
//     archived (whatever its age). A Gmail thread is in it only by its activity (Jacky, 2026-11-07:
//     an inbox keeps years of mail nobody archived; older threads are read when asked). A chat with
//     no known activity counts as old.
//   - A chat's messages: the newest SYNC_MESSAGES_PER_CHAT by sortKey (Beeper's sortKeys are numeric
//     strings of any length: by length, then lexically; Gmail's is the message's time in ms), ties
//     by message id. Older ones are read with read_chat.
import { MAX_FRAME_BYTES, SYNC_MESSAGES_PER_CHAT, SYNC_WINDOW_DAYS, type ChatSummary, type MessageItem } from "@j-inbox/protocol";

export const WINDOW_MS = SYNC_WINDOW_DAYS * 24 * 3600_000;

/** A chat's activity in ms, or -1 when it has none (a chat never written in sorts last). */
export function activityOf(c: Pick<ChatSummary, "lastActivity">): number {
  const t = c.lastActivity === null ? Number.NaN : Date.parse(c.lastActivity);
  return Number.isFinite(t) ? t : -1;
}

/** In the window: active in the last SYNC_WINDOW_DAYS days, or a Beeper chat that is not archived. */
export function inWindow(c: Pick<ChatSummary, "id" | "isArchived" | "lastActivity">, now: number): boolean {
  if (!c.isArchived && !c.id.startsWith("gmail:")) return true;
  const t = activityOf(c);
  return t >= 0 && t >= now - WINDOW_MS;
}

/** A sortKey as a string whose plain order is Beeper's (by length, then lexically): its length in three digits, then itself. */
export function sortColumn(sortKey: string): string {
  return String(sortKey.length).padStart(3, "0") + sortKey;
}

/** Newest first by sort column (sortColumn), then by id. */
export function newestByColumn(a: { id: string; col: string }, b: { id: string; col: string }): number {
  return a.col < b.col ? 1 : a.col > b.col ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Newest first: by sortKey, then by id. */
export function newestFirst(a: Pick<MessageItem, "id" | "sortKey">, b: Pick<MessageItem, "id" | "sortKey">): number {
  return newestByColumn({ id: a.id, col: sortColumn(a.sortKey) }, { id: b.id, col: sortColumn(b.sortKey) });
}

/** The ids a chat keeps of these: its newest SYNC_MESSAGES_PER_CHAT. */
export function keptIDs(all: Iterable<{ id: string; col: string }>): Set<string> {
  return new Set([...all].sort(newestByColumn).slice(0, SYNC_MESSAGES_PER_CHAT).map((x) => x.id));
}

/** UTF-8 bytes of a value as JSON: what it costs in a frame. */
export function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), "utf8");
}

/**
 * What one `messages.upsert` change may carry: messages are grouped until the next one would pass
 * this. A single message is never split (the largest valid one is about half a megabyte), so any
 * change fits in a frame of its own.
 */
export const MAX_CHANGE_BYTES = 400_000;

/** Room for a frame's own fields around its changes or chats: the type, the epoch, the res frame's id and head, the commas. */
export const FRAME_BUDGET_BYTES = MAX_FRAME_BYTES - 4096;
