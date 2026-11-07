// inbox.db: the window of the inbox as this computer knows it, and every change to it numbered in
// one changelog (sync.ts, "sync.v1"). bun:sqlite in WAL mode at <dataDir>/inbox.db (0600, in the
// 0700 data directory), next to the other stores. What it holds is what read_chat would answer:
// each chat's ChatSummary (To do and noise marks included) and its newest messages, as JSON; the
// other columns are only for ordering and for the window. The JSON (in the changelog too) is
// AES-256-GCM sealed with a 32-byte key from the Keychain (`inbox-key`, made the first time), as
// the Gmail list cache is: no message text on disk in the clear. Nor any id: a chat's id can hold a
// phone number or an address, so the key columns (chat_id, message_id, and the changelog's chat_id)
// hold an HMAC-SHA256 of the id (base64url) under a subkey of the same key, and every id inbox.db
// answers is read from the sealed JSON. Without a key it stays in memory
// (the service then opens ":memory:"). It is a cache of Beeper and Gmail, so a file that cannot be
// read, of another schema version, or sealed with another key (or none), is thrown away and built
// again, with a new epoch: every page then takes a snapshot.
//
// apply() is the one way in. In one transaction it writes chats/messages and appends to the
// changelog only what really changed (the stored JSON is compared), then hands the new changes on
// (onChanges: the next `sync` frame). Nothing else writes those three tables, so replaying the
// changelog from empty gives exactly what they hold; the test suite checks that over random runs.
//   - chat.upsert of a chat outside the window is a chat.remove (when the chat was kept).
//   - messages.upsert keeps a chat's newest SYNC_MESSAGES_PER_CHAT (window.ts), as a page does:
//     messages that would fall out at once, and messages of a chat not kept, change nothing. The
//     messages that changed go out in as many changes as their size needs (MAX_CHANGE_BYTES).
//   - chat.remove forgets the chat and its messages; messages.remove only the ids that were kept.
// The changelog keeps at least `keep` (SYNC_CHANGELOG_KEEP) of the newest changes; `floor` is the
// last seq thrown away, and a page whose cursor is older than it gets a snapshot.
// beforeChange(): told a chat's id just before apply() may change it (inside the transaction, so
// what it reads is still the chat as it was): a snapshot being read keeps that (pull.ts).
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { SYNC_CHANGELOG_KEEP, SYNC_MESSAGES_PER_CHAT, chatSummary, messageItem, parse, type ChatSummary, type MessageItem, type SyncChange } from "@j-inbox/protocol";
import { MAX_CHANGE_BYTES, WINDOW_MS, activityOf, inWindow, jsonBytes, keptIDs, newestFirst, sortColumn } from "./window.ts";

/** What a source says about a chat: the whole new state of what it names (never a patch). */
export type SyncIntent =
  | { op: "chat.upsert"; chat: ChatSummary }
  | { op: "chat.remove"; chatID: string }
  | { op: "messages.upsert"; chatID: string; messages: MessageItem[] }
  | { op: "messages.remove"; chatID: string; messageIDs: string[] };

/** Bumped when the tables change shape: an older file is then built again, with a new epoch. */
export const INBOX_SCHEMA_VERSION = 2;

export type InboxDBOptions = {
  /** The file (paths.inboxFile), or ":memory:" (tests). */
  path: string;
  now?: () => number;
  /** The newest changes always kept (default SYNC_CHANGELOG_KEEP). */
  keep?: number;
  /** New changes, in seq order, after their transaction committed. */
  onChanges?: (changes: SyncChange[]) => void;
  /** 32 bytes: the JSON is sealed with it. None: kept as it is (memory only, tests). */
  key?: Uint8Array | null;
  log?: (msg: string) => void;
};

/** A chat row as a snapshot reads it. */
export type SnapshotRow = { rowid: number; chatID: string; activity: number; seq: number; chat: ChatSummary };

// chat_id and message_id are the ids' keyed hashes (idHashFor), never the ids.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS chats (
  chat_id TEXT PRIMARY KEY,
  -- the ChatSummary's JSON, sealed (a blob) when there is a key
  json BLOB NOT NULL,
  -- ms, -1 for none: the snapshot's order (newest activity first) and the window
  last_activity INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  -- the last change about the chat or its messages: a snapshot reads a chat changed since its head as it was then (pull.ts)
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_by_activity ON chats (last_activity);
CREATE INDEX IF NOT EXISTS chats_by_seq ON chats (seq);
CREATE TABLE IF NOT EXISTS messages (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  -- sortKey as a column that sorts as Beeper's does (window.ts sortColumn)
  sort_key TEXT NOT NULL,
  json BLOB NOT NULL,
  PRIMARY KEY (chat_id, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS messages_by_sort ON messages (chat_id, sort_key);
CREATE TABLE IF NOT EXISTS changelog (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  op TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  op_id TEXT,
  json BLOB NOT NULL
);
`;

const newEpoch = () => "ep" + randomBytes(12).toString("base64url");

type Stored = string | Uint8Array;
type ChatRow = { rowid: number; last_activity: number; seq: number; json: Stored };
type ChangeRow = { seq: number; at: string; op: SyncChange["op"]; op_id: string | null; json: Stored };

/** How the JSON is kept: sealed with the key (iv, tag, then the ciphertext, as one blob), or as it is. */
type Box = { seal(text: string): Stored; open(v: Stored): string };
function boxFor(key: Uint8Array | null | undefined): Box {
  if (!key) return { seal: (t) => t, open: (v) => (typeof v === "string" ? v : Buffer.from(v).toString("utf8")) };
  if (key.length !== 32) throw new Error("The inbox key must be 32 bytes.");
  return {
    seal(t) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(t, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    },
    open(v) {
      const b = typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      if (b.length < 28) throw new Error("not sealed");
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    },
  };
}
/**
 * How an id is kept in a key column: HMAC-SHA256 (base64url) under a subkey of the inbox key, so the
 * same id always finds its row and the file shows none. Without a key (memory, tests) the subkey is
 * fixed: the JSON is not sealed then either, but the columns are hashes in every mode, so a read
 * that would answer a column instead of the JSON is caught by every test.
 */
function idHashFor(key: Uint8Array | null | undefined): (id: string) => string {
  const sub = createHmac("sha256", key ?? Buffer.alloc(0)).update("inbox.db ids").digest();
  return (id) => createHmac("sha256", sub).update(id, "utf8").digest("base64url");
}

/** What meta `seal` says: sealed with this key (a known text sealed, which only this key opens), or not sealed. */
const SEAL_CHECK = "j-inbox inbox.db";

export class InboxDB {
  readonly epoch: string;
  /** True when this open made the file (first run, or the old one was thrown away): a new epoch. */
  readonly created: boolean;
  private readonly db: Database;
  private readonly now: () => number;
  private readonly keep: number;
  private readonly box: Box;
  /** An id as its key column keeps it. */
  private readonly h: (id: string) => string;
  private closed = false;
  private readonly watchers = new Set<(chatID: string) => void>();

  private constructor(db: Database, created: boolean, private readonly o: InboxDBOptions) {
    this.db = db;
    this.box = boxFor(o.key);
    this.h = idHashFor(o.key);
    this.created = created;
    this.now = o.now ?? Date.now;
    this.keep = Math.max(1, o.keep ?? SYNC_CHANGELOG_KEEP);
    this.epoch = this.meta("epoch")!;
  }

  /**
   * Open (or make) inbox.db. A file that is not a database, of another schema version, or not
   * sealed with this key, is removed (with its -wal and -shm) and made again; the error of a second
   * failure is thrown (the service then runs without sync).
   */
  static open(o: InboxDBOptions): InboxDB {
    const memory = o.path === ":memory:";
    const box = boxFor(o.key);
    const sealedWithThis = (v: string | undefined) => {
      if (v === undefined) return false;
      if (v === "none") return !o.key;
      try {
        return !!o.key && box.open(Buffer.from(v, "base64")) === SEAL_CHECK;
      } catch {
        return false;
      }
    };
    if (!memory) mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 });
    const tryOpen = (): { db: Database; created: boolean } | "stale" => {
      const fresh = memory || !existsSync(o.path);
      const db = new Database(o.path, { create: true });
      try {
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;");
        const has = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
        const version = has ? (db.query("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | null)?.value : undefined;
        const seal = has ? (db.query("SELECT value FROM meta WHERE key = 'seal'").get() as { value: string } | null)?.value : undefined;
        if (has && (version !== String(INBOX_SCHEMA_VERSION) || !sealedWithThis(seal))) {
          db.close();
          return "stale";
        }
        db.exec(SCHEMA);
        const created = !has || fresh;
        if (!has) {
          const put = db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
          db.transaction(() => {
            put.run("schema", String(INBOX_SCHEMA_VERSION));
            put.run("epoch", newEpoch());
            put.run("floor", "0");
            put.run("seal", o.key ? Buffer.from(box.seal(SEAL_CHECK)).toString("base64") : "none");
          })();
        }
        if (!memory) chmodSync(o.path, 0o600);
        return { db, created };
      } catch (e) {
        try {
          db.close();
        } catch {}
        throw e;
      }
    };
    const wipe = () => {
      for (const f of [o.path, `${o.path}-wal`, `${o.path}-shm`]) rmSync(f, { force: true });
    };
    let r: ReturnType<typeof tryOpen>;
    try {
      r = tryOpen();
    } catch (e) {
      if (memory) throw e;
      o.log?.("inbox: inbox.db could not be read; building it again");
      wipe();
      r = tryOpen();
    }
    if (r === "stale") {
      o.log?.("inbox: inbox.db is of another version or key; building it again");
      wipe();
      r = tryOpen();
      if (r === "stale") throw new Error("inbox.db could not be made again.");
    }
    return new InboxDB(r.db, r.created, o);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {}
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  // ---------------------------------------------------------------- meta (progress of the first build and such)

  meta(key: string): string | undefined {
    return (this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value;
  }

  setMeta(key: string, value: string | null) {
    if (value === null) this.db.query("DELETE FROM meta WHERE key = ?").run(key);
    else this.db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Meta keys starting with `prefix`. */
  metaKeys(prefix: string): string[] {
    return (this.db.query("SELECT key FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix) as { key: string }[]).map((r) => r.key);
  }

  // ---------------------------------------------------------------- the one way in

  /** Be told a chat's id just before apply() may change it, still as it was (a snapshot being read keeps it). Returns the way to stop. */
  beforeChange(fn: (chatID: string) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  /** Apply what a source says; the changes it made (none when nothing changed), in seq order. */
  apply(intent: SyncIntent, opId?: string): SyncChange[] {
    if (this.closed) return [];
    const at = new Date(this.now()).toISOString();
    const out: SyncChange[] = [];
    this.db.transaction(() => {
      const chatID = intent.op === "chat.upsert" ? intent.chat?.id : intent.chatID;
      if (typeof chatID === "string")
        for (const w of this.watchers)
          try {
            w(chatID);
          } catch {}
      switch (intent.op) {
        case "chat.upsert":
          return this.upsertChat(intent.chat, at, opId, out);
        case "chat.remove":
          return this.removeChat(intent.chatID, at, opId, out);
        case "messages.upsert":
          return this.upsertMessages(intent.chatID, intent.messages, at, opId, out);
        case "messages.remove":
          return this.removeMessages(intent.chatID, intent.messageIDs, at, opId, out);
      }
    })();
    if (out.length) {
      this.compact();
      try {
        this.o.onChanges?.(out);
      } catch {}
    }
    return out;
  }

  private changeOf(r: ChangeRow, plain = this.box.open(r.json)): SyncChange {
    return { seq: r.seq, at: r.at, ...(r.op_id ? { opId: r.op_id } : {}), op: r.op, ...JSON.parse(plain) } as SyncChange;
  }

  private append(op: SyncChange["op"], chatID: string, payload: Record<string, unknown>, at: string, opId: string | undefined, out: SyncChange[]): number {
    const json = JSON.stringify(payload);
    const { seq } = this.db.query("INSERT INTO changelog (at, op, chat_id, op_id, json) VALUES (?, ?, ?, ?, ?) RETURNING seq").get(at, op, this.h(chatID), opId ?? null, this.box.seal(json)) as { seq: number };
    out.push(this.changeOf({ seq, at, op, op_id: opId ?? null, json }, json));
    return seq;
  }

  private upsertChat(raw: ChatSummary, at: string, opId: string | undefined, out: SyncChange[]) {
    const p = parse(chatSummary, raw);
    if (!p.ok) return this.o.log?.("inbox: a chat that is not a valid ChatSummary was not kept");
    const chat = p.value;
    if (!inWindow(chat, this.now())) return this.removeChat(chat.id, at, opId, out);
    const json = JSON.stringify(chat);
    const had = this.db.query("SELECT json FROM chats WHERE chat_id = ?").get(this.h(chat.id)) as { json: Stored } | null;
    if (had && this.box.open(had.json) === json) return;
    const seq = this.append("chat.upsert", chat.id, { chat }, at, opId, out);
    this.db
      .query("INSERT INTO chats (chat_id, json, last_activity, archived, seq) VALUES (?, ?, ?, ?, ?) ON CONFLICT (chat_id) DO UPDATE SET json = excluded.json, last_activity = excluded.last_activity, archived = excluded.archived, seq = excluded.seq")
      .run(this.h(chat.id), this.box.seal(json), activityOf(chat), chat.isArchived ? 1 : 0, seq);
  }

  private removeChat(chatID: string, at: string, opId: string | undefined, out: SyncChange[]) {
    const c = this.h(chatID);
    if (!this.db.query("SELECT 1 FROM chats WHERE chat_id = ?").get(c)) return;
    this.append("chat.remove", chatID, { chatID }, at, opId, out);
    this.db.query("DELETE FROM chats WHERE chat_id = ?").run(c);
    this.db.query("DELETE FROM messages WHERE chat_id = ?").run(c);
  }

  private upsertMessages(chatID: string, raw: MessageItem[], at: string, opId: string | undefined, out: SyncChange[]) {
    const c = this.h(chatID);
    if (!this.db.query("SELECT 1 FROM chats WHERE chat_id = ?").get(c)) return;
    const incoming = new Map<string, { m: MessageItem; json: string }>();
    for (const r of raw) {
      const p = parse(messageItem, r);
      if (!p.ok || p.value.chatID !== chatID) continue;
      incoming.set(p.value.id, { m: p.value, json: JSON.stringify(p.value) });
    }
    if (!incoming.size) return;
    // The kept messages by their ids (read from their JSON: the column is a hash).
    const old = new Map(
      (this.db.query("SELECT sort_key, json FROM messages WHERE chat_id = ?").all(c) as { sort_key: string; json: Stored }[]).map((r) => {
        const json = this.box.open(r.json);
        const id = (JSON.parse(json) as MessageItem).id;
        return [id, { id, sort_key: r.sort_key, json }];
      }),
    );
    const changed = [...incoming.values()].filter((x) => old.get(x.m.id)?.json !== x.json);
    if (!changed.length) return;
    // What the chat would keep with every changed message: those that would fall out at once change nothing.
    const rank = (over: { m: MessageItem }[]) => {
      const all = new Map([...old.values()].map((r) => [r.id, { id: r.id, col: r.sort_key }]));
      for (const x of over) all.set(x.m.id, { id: x.m.id, col: sortColumn(x.m.sortKey) });
      return keptIDs(all.values());
    };
    const would = rank(changed);
    const kept = changed.filter((x) => would.has(x.m.id));
    if (!kept.length) return;
    const put = this.db.query("INSERT INTO messages (chat_id, message_id, sort_key, json) VALUES (?, ?, ?, ?) ON CONFLICT (chat_id, message_id) DO UPDATE SET sort_key = excluded.sort_key, json = excluded.json");
    for (const x of kept) put.run(c, this.h(x.m.id), sortColumn(x.m.sortKey), this.box.seal(x.json));
    // What a page keeps after applying them: the same rule over the same messages.
    const stay = rank(kept);
    const drop = this.db.query("DELETE FROM messages WHERE chat_id = ? AND message_id = ?");
    for (const id of new Set([...old.keys(), ...kept.map((x) => x.m.id)])) if (!stay.has(id)) drop.run(c, this.h(id));
    // Oldest first, grouped under MAX_CHANGE_BYTES (one message alone always goes).
    const ordered = kept.map((x) => x.m).sort((a, b) => newestFirst(b, a));
    let group: MessageItem[] = [];
    let bytes = 0;
    let seq = 0;
    const flush = () => {
      if (group.length) seq = this.append("messages.upsert", chatID, { chatID, messages: group }, at, opId, out);
      group = [];
      bytes = 0;
    };
    for (const m of ordered) {
      const b = jsonBytes(m) + 1;
      if (group.length && (bytes + b > MAX_CHANGE_BYTES || group.length >= SYNC_MESSAGES_PER_CHAT)) flush();
      group.push(m);
      bytes += b;
    }
    flush();
    this.db.query("UPDATE chats SET seq = ? WHERE chat_id = ?").run(seq, c);
  }

  private removeMessages(chatID: string, ids: string[], at: string, opId: string | undefined, out: SyncChange[]) {
    const c = this.h(chatID);
    const has = this.db.query("SELECT 1 FROM messages WHERE chat_id = ? AND message_id = ?");
    const gone = [...new Set(ids)].filter((id) => has.get(c, this.h(id)));
    if (!gone.length) return;
    const drop = this.db.query("DELETE FROM messages WHERE chat_id = ? AND message_id = ?");
    let seq = 0;
    for (let i = 0; i < gone.length; i += SYNC_MESSAGES_PER_CHAT) {
      const part = gone.slice(i, i + SYNC_MESSAGES_PER_CHAT);
      seq = this.append("messages.remove", chatID, { chatID, messageIDs: part }, at, opId, out);
      for (const id of part) drop.run(c, this.h(id));
    }
    this.db.query("UPDATE chats SET seq = ? WHERE chat_id = ?").run(seq, c);
  }

  /** Keep the newest `keep` changes, with some slack so it is not done on every change. */
  private compact() {
    const head = this.head();
    const floor = this.floor();
    const slack = Math.max(16, Math.floor(this.keep / 10));
    if (head - floor <= this.keep + slack) return;
    const to = head - this.keep;
    this.db.transaction(() => {
      this.db.query("DELETE FROM changelog WHERE seq <= ?").run(to);
      this.setMeta("floor", String(to));
    })();
  }

  // ---------------------------------------------------------------- reads

  /** The newest seq (0: none yet). */
  head(): number {
    const r = this.db.query("SELECT seq FROM sqlite_sequence WHERE name = 'changelog'").get() as { seq: number } | null;
    return r?.seq ?? 0;
  }

  /** The last seq no longer kept (0: all are): a delta can start from a cursor at or after it. */
  floor(): number {
    return Number(this.meta("floor") ?? 0);
  }

  /** Changes after `cursor`, in order: at most `max`, and (but always one) their JSON under `budget` bytes. */
  changesAfter(cursor: number, max: number, budget: number): SyncChange[] {
    const rows = this.db.query("SELECT seq, at, op, op_id, json FROM changelog WHERE seq > ? ORDER BY seq LIMIT ?").all(cursor, max) as ChangeRow[];
    const out: SyncChange[] = [];
    let bytes = 0;
    for (const r of rows) {
      const c = this.changeOf(r);
      const b = jsonBytes(c) + 1;
      if (out.length && bytes + b > budget) break;
      out.push(c);
      bytes += b;
    }
    return out;
  }

  chat(chatID: string): ChatSummary | null {
    const r = this.db.query("SELECT json FROM chats WHERE chat_id = ?").get(this.h(chatID)) as { json: Stored } | null;
    return r ? (JSON.parse(this.box.open(r.json)) as ChatSummary) : null;
  }

  /** A kept chat's messages, newest last (at most SYNC_MESSAGES_PER_CHAT). */
  messages(chatID: string, limit = SYNC_MESSAGES_PER_CHAT): MessageItem[] {
    // Ties of sortKey go by the real id, which only the JSON holds: sorted here (a chat keeps few).
    const rows = this.db.query("SELECT json FROM messages WHERE chat_id = ?").all(this.h(chatID)) as { json: Stored }[];
    return rows
      .map((r) => JSON.parse(this.box.open(r.json)) as MessageItem)
      .sort(newestFirst)
      .slice(0, Math.max(0, limit))
      .reverse();
  }

  /** Ids of a chat's kept messages at or after this sortKey (what a newest page of history covers). */
  messageIDsFrom(chatID: string, sortKey: string): string[] {
    return (this.db.query("SELECT json FROM messages WHERE chat_id = ? AND sort_key >= ?").all(this.h(chatID), sortColumn(sortKey)) as { json: Stored }[]).map((r) => (JSON.parse(this.box.open(r.json)) as MessageItem).id);
  }

  /** The kept chats of these accounts (a removed account takes its chats with it). */
  chatIDsOfAccounts(accountIDs: readonly string[]): string[] {
    if (!accountIDs.length) return [];
    const want = new Set(accountIDs);
    return (this.db.query("SELECT json FROM chats").all() as { json: Stored }[])
      .map((r) => JSON.parse(this.box.open(r.json)) as ChatSummary)
      .filter((c) => want.has(c.accountID))
      .map((c) => c.id);
  }

  /** Kept chats that time has taken out of the window (archived, and no activity in SYNC_WINDOW_DAYS days). */
  outOfWindow(): string[] {
    return (this.db.query("SELECT json FROM chats WHERE archived = 1 AND last_activity < ?").all(this.now() - WINDOW_MS) as { json: Stored }[]).map((r) => (JSON.parse(this.box.open(r.json)) as ChatSummary).id);
  }

  /** How many chats are kept. */
  chatCount(): number {
    return (this.db.query("SELECT count(*) AS n FROM chats").get() as { n: number }).n;
  }

  /** Chats not changed since `head`, after a snapshot's boundary (activity, rowid), newest activity first. */
  snapshotAfter(head: number, activity: number, rowid: number, limit: number): SnapshotRow[] {
    const rows = this.db
      .query("SELECT rowid, last_activity, seq, json FROM chats WHERE seq <= ?1 AND (last_activity < ?2 OR (last_activity = ?2 AND rowid < ?3)) ORDER BY last_activity DESC, rowid DESC LIMIT ?4")
      .all(head, activity, rowid, limit) as ChatRow[];
    return rows.map((r) => this.snapshotOf(r));
  }

  /** A kept chat as a snapshot reads it (null: not kept). */
  snapshotRow(chatID: string): SnapshotRow | null {
    const r = this.db.query("SELECT rowid, last_activity, seq, json FROM chats WHERE chat_id = ?").get(this.h(chatID)) as ChatRow | null;
    return r ? this.snapshotOf(r) : null;
  }

  /** The id is the JSON's (the column is a hash). */
  private snapshotOf(r: ChatRow): SnapshotRow {
    const chat = JSON.parse(this.box.open(r.json)) as ChatSummary;
    return { rowid: r.rowid, chatID: chat.id, activity: r.last_activity, seq: r.seq, chat };
  }

  /** Every kept chat and its messages (tests, and checks): chat id -> {chat, messages newest last}. */
  dump(): Map<string, { chat: ChatSummary; messages: MessageItem[] }> {
    const out = new Map<string, { chat: ChatSummary; messages: MessageItem[] }>();
    const parsed = (v: Stored) => JSON.parse(this.box.open(v));
    // By the columns (hashes), then named by the JSON's ids.
    const byHash = new Map<string, { chat: ChatSummary; messages: MessageItem[] }>();
    for (const r of this.db.query("SELECT chat_id, json FROM chats").all() as { chat_id: string; json: Stored }[]) byHash.set(r.chat_id, { chat: parsed(r.json), messages: [] });
    for (const r of this.db.query("SELECT chat_id, json FROM messages").all() as { chat_id: string; json: Stored }[]) {
      const m = parsed(r.json) as MessageItem;
      const e = byHash.get(r.chat_id);
      if (e) e.messages.push(m);
      // A message of a chat not kept would be a bug: dump shows it under a chat of its own so tests see it.
      else byHash.set(r.chat_id, { chat: null as never, messages: [m] });
    }
    for (const e of byHash.values()) {
      e.messages.sort((a, b) => newestFirst(b, a));
      out.set(e.chat ? e.chat.id : e.messages[0]!.chatID, e);
    }
    return out;
  }
}
