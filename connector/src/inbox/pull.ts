// sync_pull's answer from inbox.db (sync.ts): a delta from the page's cursor, or the window as a
// snapshot, a page at a time.
//   - delta: when the page names this epoch and a cursor inbox.db still has the changes after
//     (floor <= cursor <= head). At most MAX_SYNC_CHANGES changes, and under a frame; `more` while
//     the last one is not the head.
//   - snapshot: otherwise (no replica, another epoch, a cursor older than what was kept or from
//     nowhere). The window as it was at the head of the first page, which every page answers as
//     `head`: newest activity first, at most MAX_SYNC_SNAPSHOT_CHATS chats a page and always under a
//     frame (a chat too big with all its messages goes with its newest messages that fit). `next` is
//     an opaque cursor naming the epoch, the snapshot being read and where the last page ended.
// Changes keep coming while a page reads a snapshot, and the page then applies every change after
// the head to what the pages gave it. That is only right on the chats as they were at the head:
// applying a messages.upsert keeps the chat's newest SYNC_MESSAGES_PER_CHAT, so on a chat read
// later (already as it is now) an old one can push out messages inbox.db keeps, which a later
// removal does not bring back, or keep one inbox.db pushed out. So while a snapshot is being read
// (from its first page with a `next`), inbox.db tells it before it changes a chat (beforeChange),
// and the snapshot keeps that chat as it was (once: what it was at the head; null when it was not
// there), and its pages read a chat changed since the head from what it kept, in the order it had
// then. The replica after the last page is then the window at the head, and the delta after it
// makes it the window now, change by change, exactly as inbox.db did.
// What a snapshot keeps is bounded: SNAPSHOT_KEEP_BYTES of chats as they were (a snapshot that needs
// more is given up), at most MAX_OPEN_SNAPSHOTS read at once (a new one gives up the one used least
// lately), and none left alone SNAPSHOT_IDLE_MS. A page of a snapshot given up (or of one from
// before the connector started) is BAD_PARAMS: the page pulls again from the start. A `page` that is
// not a cursor of ours is BAD_PARAMS too; one of another epoch (inbox.db was built again meanwhile)
// starts a new snapshot, whose epoch tells the page to throw the old pages away.
import { randomBytes } from "node:crypto";
import { MAX_SYNC_CHANGES, MAX_SYNC_SNAPSHOT_CHATS, makeError, type ChatSummary, type ErrorBody, type MessageItem, type SyncChange, type SyncPullParams, type SyncPullResult, type SyncSnapshotChat } from "@j-inbox/protocol";
import type { InboxDB, SnapshotRow } from "./db.ts";
import { FRAME_BUDGET_BYTES, jsonBytes } from "./window.ts";

/** The most a snapshot being read keeps of the chats as they were at its head. */
export const SNAPSHOT_KEEP_BYTES = 16 * 1024 * 1024;
/** Snapshots being read at once (a page each). */
export const MAX_OPEN_SNAPSHOTS = 8;
/** A snapshot whose next page has not been asked for in this long is given up. */
export const SNAPSHOT_IDLE_MS = 120_000;

type Cursor = { epoch: string; id: string; activity: number; rowid: number };

const NUM = "(-?\\d{1,16})";
const CURSOR_RE = new RegExp(`^s2\\.([A-Za-z0-9_-]{8,64})\\.([A-Za-z0-9_-]{16})\\.${NUM}\\.${NUM}$`);

export function encodeSnapshotCursor(c: Cursor): string {
  return `s2.${c.epoch}.${c.id}.${c.activity}.${c.rowid}`;
}

export function decodeSnapshotCursor(s: string): Cursor | null {
  const m = CURSOR_RE.exec(s);
  if (!m) return null;
  const [activity, rowid] = [Number(m[3]), Number(m[4])];
  if (![activity, rowid].every(Number.isSafeInteger) || rowid < 0 || activity < -1) return null;
  return { epoch: m[1]!, id: m[2]!, activity, rowid };
}

/** Every get_media URL a chat or message carries: what a page may ask for after this answer. */
export function urlsOf(x: ChatSummary | MessageItem): string[] {
  const out: string[] = [];
  const msg = (m: MessageItem | null | undefined) => {
    for (const a of m?.attachments ?? []) if (a.url) out.push(a.url);
  };
  if ("avatarURL" in x && x.avatarURL) out.push(x.avatarURL);
  if ("preview" in x) msg(x.preview);
  if ("senderID" in x) msg(x as MessageItem);
  return out;
}

export type PullOptions = {
  /** Asset URLs in the answer: get_media serves only URLs a result carried (assets.ts), and this is one. */
  allow?: (url: string) => void;
  /** Bytes for an answer's changes or chats (tests make it small). */
  budgetBytes?: number;
  /** The bounds of the snapshots being read (tests make them small). */
  keepBytes?: number;
  maxOpen?: number;
  idleMs?: number;
  now?: () => number;
};

export type PullOutcome = { ok: true; data: SyncPullResult } | { ok: false; error: ErrorBody };

/** A chat as a snapshot reads it: its row (order and summary) and its newest messages. */
type Kept = { row: SnapshotRow; messages: MessageItem[] };

/** A snapshot being read: its head, and the chats changed since, as they were then (null: not there). */
type Open = { id: string; head: number; was: Map<string, Kept | null>; bytes: number; used: number };

/** The snapshots being read from one inbox.db. */
class Snapshots {
  readonly open = new Map<string, Open>();
  o: Required<Pick<PullOptions, "keepBytes" | "maxOpen" | "idleMs" | "now">> = { keepBytes: SNAPSHOT_KEEP_BYTES, maxOpen: MAX_OPEN_SNAPSHOTS, idleMs: SNAPSHOT_IDLE_MS, now: Date.now };

  constructor(private readonly db: InboxDB) {
    db.beforeChange((chatID) => this.before(chatID));
  }

  set(o: PullOptions) {
    this.o = { keepBytes: o.keepBytes ?? SNAPSHOT_KEEP_BYTES, maxOpen: o.maxOpen ?? MAX_OPEN_SNAPSHOTS, idleMs: o.idleMs ?? SNAPSHOT_IDLE_MS, now: o.now ?? Date.now };
  }

  /** inbox.db is about to change this chat: every snapshot that has not kept it yet keeps it as it is (as it was at its head). */
  private before(chatID: string) {
    if (!this.open.size) return;
    this.expire();
    let was: Kept | null | undefined;
    let bytes = 0;
    for (const s of [...this.open.values()]) {
      if (s.was.has(chatID)) continue;
      if (was === undefined) {
        const row = this.db.snapshotRow(chatID);
        was = row ? { row, messages: this.db.messages(chatID) } : null;
        bytes = was ? jsonBytes(was) : 0;
      }
      s.was.set(chatID, was);
      s.bytes += bytes;
      if (s.bytes > this.o.keepBytes) this.open.delete(s.id);
    }
  }

  private expire() {
    const now = this.o.now();
    for (const s of this.open.values()) if (now - s.used > this.o.idleMs) this.open.delete(s.id);
  }

  start(): Open {
    return { id: randomBytes(12).toString("base64url"), head: this.db.head(), was: new Map(), bytes: 0, used: this.o.now() };
  }

  /** A first page with a next: it is read on from here. */
  keep(s: Open) {
    this.expire();
    while (this.open.size >= this.o.maxOpen) this.open.delete(this.open.keys().next().value!);
    this.open.set(s.id, s);
  }

  /** The snapshot a next page names, still being read (least lately used last). */
  take(id: string): Open | null {
    this.expire();
    const s = this.open.get(id);
    if (!s) return null;
    this.open.delete(id);
    s.used = this.o.now();
    this.open.set(id, s);
    return s;
  }

  done(s: Open) {
    this.open.delete(s.id);
  }
}

const readers = new WeakMap<InboxDB, Snapshots>();
function snapshotsOf(db: InboxDB, o: PullOptions): Snapshots {
  let r = readers.get(db);
  if (!r) readers.set(db, (r = new Snapshots(db)));
  r.set(o);
  return r;
}

/** How many snapshots of this inbox.db are being read (tests). */
export function openSnapshots(db: InboxDB): number {
  return readers.get(db)?.open.size ?? 0;
}

export function syncPull(db: InboxDB, p: SyncPullParams, o: PullOptions = {}): PullOutcome {
  const budget = o.budgetBytes ?? FRAME_BUDGET_BYTES;
  const snaps = snapshotsOf(db, o);
  if (p.page !== undefined) {
    const c = decodeSnapshotCursor(p.page);
    if (!c) return { ok: false, error: makeError("BAD_PARAMS", "page is not a snapshot cursor from this computer. Pull again without it.") };
    if (c.epoch !== db.epoch) return { ok: true, data: snapshot(db, snaps, null, budget, o) };
    const s = snaps.take(c.id);
    if (!s) return { ok: false, error: makeError("BAD_PARAMS", "The snapshot this page belongs to is no longer being read on this computer. Pull again without it.") };
    return { ok: true, data: snapshot(db, snaps, { s, activity: c.activity, rowid: c.rowid }, budget, o) };
  }
  const cursor = p.cursor ?? null;
  if (p.epoch === db.epoch && cursor !== null && cursor >= db.floor() && cursor <= db.head()) return { ok: true, data: delta(db, cursor, budget, o) };
  return { ok: true, data: snapshot(db, snaps, null, budget, o) };
}

function delta(db: InboxDB, cursor: number, budget: number, o: PullOptions): SyncPullResult {
  const head = db.head();
  const changes = db.changesAfter(cursor, MAX_SYNC_CHANGES, budget);
  for (const c of changes) allowChange(c, o);
  const last = changes.length ? changes[changes.length - 1]!.seq : cursor;
  return { kind: "delta", epoch: db.epoch, head, changes, more: last < head };
}

function allowChange(c: SyncChange, o: PullOptions) {
  if (!o.allow) return;
  if (c.op === "chat.upsert") for (const u of urlsOf(c.chat)) o.allow(u);
  if (c.op === "messages.upsert") for (const m of c.messages) for (const u of urlsOf(m)) o.allow(u);
}

/** A chat and its newest messages, cut to `room` bytes (the newest messages that fit; the chat itself always). */
function entryOf(chat: ChatSummary, all: MessageItem[], room: number): { entry: SyncSnapshotChat; bytes: number } {
  let entry: SyncSnapshotChat = { chat, messages: all };
  let bytes = jsonBytes(entry) + 1;
  if (bytes > room) {
    // Too big as a whole: one by one from the newest, as many as fit.
    const base = jsonBytes({ chat, messages: [] }) + 1;
    let n = 0;
    let used = base;
    for (let i = all.length - 1; i >= 0; i--) {
      const b = jsonBytes(all[i]) + 1;
      if (used + b > room) break;
      used += b;
      n++;
    }
    entry = { chat, messages: all.slice(all.length - n) };
    bytes = used;
  }
  return { entry, bytes };
}

/** Newest activity first, then the newer row: the snapshot's order. */
const before = (a: { activity: number; rowid: number }, b: { activity: number; rowid: number }) => b.activity - a.activity || b.rowid - a.rowid;
const after = (r: { activity: number; rowid: number }, activity: number, rowid: number) => r.activity < activity || (r.activity === activity && r.rowid < rowid);

/** The table's chats not changed since the head (nor kept by the snapshot: a change that made nothing), after the boundary, in order. */
function* unchanged(db: InboxDB, s: Open, activity: number, rowid: number): Generator<SnapshotRow> {
  const batch = MAX_SYNC_SNAPSHOT_CHATS + 1;
  for (;;) {
    const rows = db.snapshotAfter(s.head, activity, rowid, batch);
    for (const x of rows) {
      activity = x.activity;
      rowid = x.rowid;
      if (!s.was.has(x.chatID)) yield x;
    }
    if (rows.length < batch) return;
  }
}

/**
 * The chats after the boundary, as they were at the head, in the snapshot's order: those not
 * changed since (from the table, as they are), and those changed since (as the snapshot kept them).
 */
function* chatsAfter(db: InboxDB, s: Open, activity: number, rowid: number): Generator<Kept> {
  const kept = [...s.was.values()].filter((k): k is Kept => k !== null && after(k.row, activity, rowid)).sort((a, b) => before(a.row, b.row));
  let k = 0;
  for (const row of unchanged(db, s, activity, rowid)) {
    while (k < kept.length && before(kept[k]!.row, row) < 0) yield kept[k++]!;
    yield { row, messages: db.messages(row.chatID) };
  }
  while (k < kept.length) yield kept[k++]!;
}

function snapshot(db: InboxDB, snaps: Snapshots, from: { s: Open; activity: number; rowid: number } | null, budget: number, o: PullOptions): SyncPullResult {
  const s = from?.s ?? snaps.start();
  const chats: SyncSnapshotChat[] = [];
  let bytes = 0;
  let activity = from?.activity ?? Number.MAX_SAFE_INTEGER;
  let rowid = from?.rowid ?? Number.MAX_SAFE_INTEGER;
  let more = false;
  for (const k of chatsAfter(db, s, activity, rowid)) {
    if (chats.length >= MAX_SYNC_SNAPSHOT_CHATS) {
      more = true;
      break;
    }
    // Only the page's first chat is cut to fit; any other waits whole for the next page.
    const { entry, bytes: b } = entryOf(k.row.chat, k.messages, chats.length ? Number.POSITIVE_INFINITY : budget);
    if (chats.length && bytes + b > budget) {
      more = true;
      break;
    }
    chats.push(entry);
    bytes += b;
    activity = k.row.activity;
    rowid = k.row.rowid;
  }
  for (const e of chats) {
    if (!o.allow) break;
    for (const u of urlsOf(e.chat)) o.allow(u);
    for (const m of e.messages) for (const u of urlsOf(m)) o.allow(u);
  }
  if (!more) snaps.done(s);
  else if (!from) snaps.keep(s);
  return { kind: "snapshot", epoch: db.epoch, head: s.head, chats, next: more ? encodeSnapshotCursor({ epoch: db.epoch, id: s.id, activity, rowid }) : null };
}
