// inbox.db (src/inbox/db.ts, pull.ts, push.ts): the one way in keeps the tables equal to the
// changelog replayed from empty, whatever comes in and in whatever order; a snapshot read while
// changes come (full chats too, whose newest 50 an old change replayed would upset), then a delta,
// gives the same state; what a snapshot being read keeps is bounded; compaction sends an old cursor to a snapshot; a
// db made again has a new epoch; the window's edges; every answer and frame fits in a frame.
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  MAX_FRAME_BYTES,
  MAX_SYNC_CHANGES,
  MAX_SYNC_SNAPSHOT_CHATS,
  SYNC_MESSAGES_PER_CHAT,
  SYNC_WINDOW_DAYS,
  encodeFrame,
  parse,
  parseConnectorFrame,
  syncChange,
  syncPullResult,
  type ChatSummary,
  type MessageItem,
  type SyncChange,
  type SyncPullResult,
} from "@j-inbox/protocol";
import { INBOX_SCHEMA_VERSION, InboxDB, type InboxDBOptions, type SyncIntent } from "../src/inbox/db.ts";
import { openSnapshots, syncPull } from "../src/inbox/pull.ts";
import { SyncPusher, syncFrames } from "../src/inbox/push.ts";
import { Replica, plain } from "./helpers/replica.ts";

// Random runs, whole services and first builds: slower than bun's 5 s default on a CI machine.
setDefaultTimeout(30_000);

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (t: number) => new Date(t).toISOString();

/** A small seeded PRNG (mulberry32): a failing seed is a failing case to rerun. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! };
}

function chat(id: string, o: Partial<ChatSummary> = {}): ChatSummary {
  return { id, accountID: "acc1", network: "WhatsApp", title: `Chat ${id}`, type: "single", unreadCount: 0, isPinned: false, isMuted: false, isArchived: false, lastActivity: iso(NOW - DAY), ...o };
}
function msg(chatID: string, id: string, sortKey: string, o: Partial<MessageItem> = {}): MessageItem {
  return { id, chatID, accountID: "acc1", senderID: "@alice:beeper.local", timestamp: iso(NOW - DAY), sortKey, type: "TEXT", text: `text of ${id}`, isSender: false, ...o };
}

/** Random intents over a few chats and many messages: repeats, stale versions and removals included. */
function randomIntents(seed: number, n: number): SyncIntent[] {
  const r = rng(seed);
  const chats = ["!a:b", "!c:d", "!e:f", "gmail:o@example.com:18c2f0a1b2c3d4e5", "!g:h"];
  const out: SyncIntent[] = [];
  const last = new Map<string, SyncIntent>();
  for (let i = 0; i < n; i++) {
    const c = r.pick(chats);
    const roll = r.next();
    if (roll < 0.06 && last.size) {
      // The very same thing again (a duplicate event, a second read).
      out.push(r.pick([...last.values()]));
      continue;
    }
    let it: SyncIntent;
    if (roll < 0.35) {
      // Sometimes archived and old (out of the window), sometimes never active.
      const age = r.pick([0, 1, 30, 89, 91, 200]) * DAY + r.int(DAY);
      it = { op: "chat.upsert", chat: chat(c, { isArchived: r.next() < 0.3, unreadCount: r.int(4), lastActivity: r.next() < 0.05 ? null : iso(NOW - age), title: r.pick(["A", "B", "Ç 中文"]) }) };
    } else if (roll < 0.42) it = { op: "chat.remove", chatID: c };
    else if (roll < 0.9) {
      const k = 1 + r.int(12);
      const messages: MessageItem[] = [];
      for (let j = 0; j < k; j++) {
        const m = r.int(80);
        // Numeric sortKeys of different lengths, as Beeper's are; a message's text has a few versions (edits, older answers arriving late).
        messages.push(msg(c, `$m${m}`, String(m * 997 + (m % 7 === 0 ? 1_000_000 : 0)), { text: `v${r.int(3)} of ${m}` }));
      }
      it = { op: "messages.upsert", chatID: c, messages };
    } else {
      const ids = Array.from({ length: 1 + r.int(5) }, () => `$m${r.int(80)}`);
      it = { op: "messages.remove", chatID: c, messageIDs: ids };
    }
    last.set(`${c}${it.op}`, it);
    out.push(it);
  }
  return out;
}

const mem = (o: Partial<InboxDBOptions> = {}) => InboxDB.open({ path: ":memory:", now: () => NOW, ...o });

/** All changes still in the changelog, through the pull's own delta pages. */
function allChanges(db: InboxDB): SyncChange[] {
  return db.changesAfter(db.floor(), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
}

/**
 * A page with no replica: snapshot pages (calling between() before each next page), then deltas
 * until up to date. Its cursor is the oldest head of the pages, as the web's client takes it (they
 * are all the first page's).
 */
function syncFromEmpty(db: InboxDB, between: () => void = () => {}, budgetBytes?: number): { replica: Replica; pages: SyncPullResult[] } {
  const replica = new Replica();
  const pages: SyncPullResult[] = [];
  const got: { epoch: string; head: number; chats: any[] } = { epoch: "", head: Number.MAX_SAFE_INTEGER, chats: [] };
  let r = syncPull(db, {}, { budgetBytes });
  for (;;) {
    if (!r.ok) throw new Error(r.error.message);
    pages.push(r.data);
    if (r.data.kind !== "snapshot") throw new Error("expected a snapshot");
    got.epoch = r.data.epoch;
    got.head = Math.min(got.head, r.data.head);
    got.chats.push(...r.data.chats);
    if (!r.data.next) break;
    between();
    r = syncPull(db, { page: r.data.next }, { budgetBytes });
  }
  replica.replace(got.epoch, got.head, got.chats);
  between();
  for (;;) {
    const d = syncPull(db, { epoch: replica.epoch, cursor: replica.cursor }, { budgetBytes });
    if (!d.ok || d.data.kind !== "delta") throw new Error(`expected a delta: ${JSON.stringify([replica.epoch, replica.cursor, db.epoch, db.floor(), db.head(), d.ok ? d.data.kind : d.error])}`);
    pages.push(d.data);
    for (const c of d.data.changes) {
      // seq is contiguous: what the page checks before it applies.
      expect(c.seq).toBe(replica.cursor + 1);
      replica.apply(c);
    }
    if (!d.data.more) break;
  }
  return { replica, pages };
}

describe("inbox.db: the changelog is the tables", () => {
  test("for many random runs (duplicates, stale versions, removals), the tables equal the changelog replayed from empty", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const pushed: SyncChange[] = [];
      // Every third run sealed, as the service keeps it: the comparisons go through the seal.
      const db = mem({ onChanges: (c) => pushed.push(...c), ...(seed % 3 === 0 ? { key: new Uint8Array(32).fill(seed) } : {}) });
      const live = new Replica();
      for (const it of randomIntents(seed, 160)) {
        const before = db.head();
        const made = db.apply(it);
        live.applyAll(made);
        // Contiguous seq, every change valid against the contract.
        made.forEach((c, i) => expect(c.seq).toBe(before + 1 + i));
        for (const c of made) expect(parse(syncChange, c).ok).toBe(true);
        // The very same again changes nothing.
        expect(db.apply(it)).toEqual([]);
      }
      const replayed = new Replica();
      replayed.applyAll(allChanges(db));
      expect(plain(replayed.state())).toEqual(plain(db.dump()));
      expect(plain(live.state())).toEqual(plain(db.dump()));
      // What was handed on for the frames is the changelog itself, in order.
      expect(pushed).toEqual(allChanges(db));
      // Never more than the newest SYNC_MESSAGES_PER_CHAT, never a message of a chat not kept.
      for (const [, e] of db.dump()) {
        expect(e.chat).not.toBeNull();
        expect(e.messages.length).toBeLessThanOrEqual(SYNC_MESSAGES_PER_CHAT);
      }
      db.close();
    }
  });

  test("a change names the whole new state: an older version arriving after a newer one is a change back, applied the same everywhere", () => {
    const db = mem();
    db.apply({ op: "chat.upsert", chat: chat("!a:b") });
    db.apply({ op: "messages.upsert", chatID: "!a:b", messages: [msg("!a:b", "$1", "10", { text: "new" })] });
    const back = db.apply({ op: "messages.upsert", chatID: "!a:b", messages: [msg("!a:b", "$1", "10", { text: "old" })] });
    expect(back.map((c) => c.op)).toEqual(["messages.upsert"]);
    expect(db.messages("!a:b").map((m) => m.text)).toEqual(["old"]);
  });

  test("a chat keeps its newest SYNC_MESSAGES_PER_CHAT by sortKey (length, then lexically); older ones arriving later change nothing", () => {
    const db = mem();
    db.apply({ op: "chat.upsert", chat: chat("!a:b") });
    const keys = Array.from({ length: 60 }, (_, i) => String(9 + i * 10)); // 9, 19, ... 599: lengths 1 to 3
    const made = db.apply({ op: "messages.upsert", chatID: "!a:b", messages: keys.map((k) => msg("!a:b", `$${k}`, k)) });
    expect(made.flatMap((c) => (c.op === "messages.upsert" ? c.messages.map((m) => m.sortKey) : []))).toEqual(keys.slice(10));
    expect(db.messages("!a:b").map((m) => m.sortKey)).toEqual(keys.slice(10));
    // "99" is older than "109" (shorter), though it sorts after it as text.
    expect(db.apply({ op: "messages.upsert", chatID: "!a:b", messages: [msg("!a:b", "$99", "99", { text: "edited" })] })).toEqual([]);
    // A newer one pushes the oldest out, without a removal (pages trim the same way).
    const one = db.apply({ op: "messages.upsert", chatID: "!a:b", messages: [msg("!a:b", "$1000", "1000")] });
    expect(one.map((c) => c.op)).toEqual(["messages.upsert"]);
    expect(db.messages("!a:b")[0]!.sortKey).toBe("119");
    // Messages of a chat not kept: nothing.
    expect(db.apply({ op: "messages.upsert", chatID: "!x:y", messages: [msg("!x:y", "$1", "1")] })).toEqual([]);
    expect(db.dump().has("!x:y")).toBe(false);
  });

  test("removals: only what was kept is named, and a chat goes with its messages", () => {
    const db = mem();
    db.apply({ op: "chat.upsert", chat: chat("!a:b") });
    db.apply({ op: "messages.upsert", chatID: "!a:b", messages: [msg("!a:b", "$1", "1"), msg("!a:b", "$2", "2")] });
    expect(db.apply({ op: "messages.remove", chatID: "!a:b", messageIDs: ["$2", "$nope", "$2"] }).map((c) => (c.op === "messages.remove" ? c.messageIDs : null))).toEqual([["$2"]]);
    expect(db.apply({ op: "messages.remove", chatID: "!a:b", messageIDs: ["$nope"] })).toEqual([]);
    expect(db.apply({ op: "chat.remove", chatID: "!a:b" }).map((c) => c.op)).toEqual(["chat.remove"]);
    expect(db.dump().size).toBe(0);
    expect(db.apply({ op: "chat.remove", chatID: "!a:b" })).toEqual([]);
  });

  test("an invalid chat or message is not kept (nothing a page could not parse goes in)", () => {
    const db = mem();
    expect(db.apply({ op: "chat.upsert", chat: { ...chat("!a:b"), title: "two\nlines" } })).toEqual([]);
    db.apply({ op: "chat.upsert", chat: chat("!a:b") });
    expect(db.apply({ op: "messages.upsert", chatID: "!a:b", messages: [{ ...msg("!a:b", "$1", "1"), type: "BOGUS" as never }] })).toEqual([]);
    // A message that says it is another chat's.
    expect(db.apply({ op: "messages.upsert", chatID: "!a:b", messages: [msg("!c:d", "$1", "1")] })).toEqual([]);
  });

  test("opId lands on every change the intent made, and only on those", () => {
    const db = mem();
    const a = db.apply({ op: "chat.upsert", chat: chat("!a:b") }, "op_abc12345");
    const b = db.apply({ op: "messages.upsert", chatID: "!a:b", messages: [msg("!a:b", "$1", "1")] });
    expect(a.map((c) => c.opId)).toEqual(["op_abc12345"]);
    expect(b.map((c) => c.opId)).toEqual([undefined]);
    expect(allChanges(db).map((c) => c.opId ?? null)).toEqual(["op_abc12345", null]);
  });
});

describe("inbox.db: the window", () => {
  const at = (ms: number) => InboxDB.open({ path: ":memory:", now: () => ms });
  test("archived and active exactly SYNC_WINDOW_DAYS ago is in; a millisecond older is out; not archived is in at any age; archived and never active is out", () => {
    const db = at(NOW);
    const edge = NOW - SYNC_WINDOW_DAYS * DAY;
    expect(db.apply({ op: "chat.upsert", chat: chat("!edge:x", { isArchived: true, lastActivity: iso(edge) }) }).map((c) => c.op)).toEqual(["chat.upsert"]);
    expect(db.apply({ op: "chat.upsert", chat: chat("!old:x", { isArchived: true, lastActivity: iso(edge - 1) }) })).toEqual([]);
    expect(db.apply({ op: "chat.upsert", chat: chat("!ancient:x", { isArchived: false, lastActivity: iso(NOW - 3000 * DAY) }) }).map((c) => c.op)).toEqual(["chat.upsert"]);
    expect(db.apply({ op: "chat.upsert", chat: chat("!never:x", { isArchived: true, lastActivity: null }) })).toEqual([]);
    expect(db.apply({ op: "chat.upsert", chat: chat("!never2:x", { isArchived: false, lastActivity: null }) }).map((c) => c.op)).toEqual(["chat.upsert"]);
    // A kept chat archived and old: removed.
    expect(db.apply({ op: "chat.upsert", chat: chat("!ancient:x", { isArchived: true, lastActivity: iso(NOW - 3000 * DAY) }) }).map((c) => c.op)).toEqual(["chat.remove"]);
    expect([...db.dump().keys()].sort()).toEqual(["!edge:x", "!never2:x"]);
  });

  test("time takes an archived chat out: outOfWindow names it once it is older than the window", () => {
    let now = NOW;
    const db = InboxDB.open({ path: ":memory:", now: () => now });
    db.apply({ op: "chat.upsert", chat: chat("!arch:x", { isArchived: true, lastActivity: iso(NOW - 89 * DAY) }) });
    db.apply({ op: "chat.upsert", chat: chat("!open:x", { isArchived: false, lastActivity: iso(NOW - 89 * DAY) }) });
    expect(db.outOfWindow()).toEqual([]);
    now = NOW + DAY;
    expect(db.outOfWindow()).toEqual([]);
    now = NOW + DAY + 1;
    expect(db.outOfWindow()).toEqual(["!arch:x"]);
  });

  test("a Gmail thread is in the window only by its activity, archived or not; a Beeper chat by either", () => {
    let now = NOW;
    const db = InboxDB.open({ path: ":memory:", now: () => now });
    const old = iso(NOW - 120 * DAY);
    // An old Gmail thread still in the inbox is not kept; an old Beeper chat still in the inbox is.
    expect(db.apply({ op: "chat.upsert", chat: chat("gmail:owner@example.com:aaa111", { isArchived: false, lastActivity: old }) }).map((c) => c.op)).toEqual([]);
    expect(db.apply({ op: "chat.upsert", chat: chat("!beeper:x", { isArchived: false, lastActivity: old }) }).map((c) => c.op)).toEqual(["chat.upsert"]);
    db.apply({ op: "chat.upsert", chat: chat("gmail:owner@example.com:bbb222", { isArchived: false, lastActivity: iso(NOW - 89 * DAY) }) });
    expect(db.outOfWindow()).toEqual([]);
    // Time takes the recent Gmail thread out although it is in the inbox; the Beeper chat stays.
    now = NOW + 2 * DAY;
    expect(db.outOfWindow()).toEqual(["gmail:owner@example.com:bbb222"]);
  });
});

describe("sync_pull", () => {
  function filled(n: number, seed = 7, o: { keep?: number } = {}) {
    const db = mem(o);
    const r = rng(seed);
    for (let i = 0; i < n; i++) {
      const id = `!c${i}:x`;
      db.apply({ op: "chat.upsert", chat: chat(id, { lastActivity: iso(NOW - r.int(80) * DAY - r.int(DAY)) }) });
      db.apply({ op: "messages.upsert", chatID: id, messages: Array.from({ length: 1 + r.int(5) }, (_, j) => msg(id, `$${i}_${j}`, String(100 + j))) });
    }
    return db;
  }

  test("no replica: a snapshot, newest activity first, at most MAX_SYNC_SNAPSHOT_CHATS a page, every page with the first page's head", () => {
    const db = filled(MAX_SYNC_SNAPSHOT_CHATS * 2 + 17);
    const { replica, pages } = syncFromEmpty(db);
    const snaps = pages.filter((p) => p.kind === "snapshot") as Extract<SyncPullResult, { kind: "snapshot" }>[];
    expect(snaps.length).toBe(3);
    expect(snaps.map((p) => p.chats.length)).toEqual([MAX_SYNC_SNAPSHOT_CHATS, MAX_SYNC_SNAPSHOT_CHATS, 17]);
    expect(new Set(snaps.map((p) => p.head)).size).toBe(1);
    const times = snaps.flatMap((p) => p.chats.map((c) => Date.parse(c.chat.lastActivity!)));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    for (const p of pages) expect(parse(syncPullResult, p).ok).toBe(true);
    expect(plain(replica.state())).toEqual(plain(db.dump()));
  });

  test("a snapshot read while changes come, then a delta, gives exactly what inbox.db holds (random runs)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const db = filled(60 + seed, seed);
      const r = rng(1000 + seed);
      // Between pages: chats move ahead (new messages), go, come back, change; small pages (a few chats) so there are many.
      const between = () => {
        for (let k = r.int(3); k > 0; k--) {
          const id = `!c${r.int(60 + seed + 5)}:x`;
          const roll = r.next();
          if (roll < 0.5) {
            db.apply({ op: "chat.upsert", chat: chat(id, { lastActivity: iso(NOW - r.int(3) * 1000), unreadCount: r.int(5) }) });
            db.apply({ op: "messages.upsert", chatID: id, messages: [msg(id, `$n${r.int(1e6)}`, String(1000 + r.int(1e5)))] });
          } else if (roll < 0.7) db.apply({ op: "chat.remove", chatID: id });
          else if (roll < 0.85) db.apply({ op: "messages.remove", chatID: id, messageIDs: [`$${id.slice(2, -2)}_0`] });
          else db.apply({ op: "chat.upsert", chat: chat(id, { lastActivity: iso(NOW - 85 * DAY), title: `t${r.int(9)}` }) });
        }
      };
      const { replica } = syncFromEmpty(db, between, 3000);
      expect(plain(replica.state())).toEqual(plain(db.dump()));
      db.close();
    }
  });

  // A page replays every change after the snapshot's head on chats it read later. Applying a
  // messages.upsert keeps the newest SYNC_MESSAGES_PER_CHAT, so on a chat already as it is now an
  // old one is not harmless: it can push out messages inbox.db keeps (a later removal does not bring
  // them back), or keep one inbox.db pushed out. So every page reads a chat changed since the head
  // as it was at the head.
  function full(db: InboxDB, id: string, n: number, o: { age?: number; key?: (i: number) => number } = {}) {
    db.apply({ op: "chat.upsert", chat: chat(id, { lastActivity: iso(NOW - (o.age ?? 50) * DAY) }) });
    db.apply({ op: "messages.upsert", chatID: id, messages: Array.from({ length: n }, (_, i) => msg(id, `$m${i + 1}`, String(o.key ? o.key(i + 1) : 1000 + i + 1))) });
  }
  function newer(db: InboxDB, n: number) {
    for (let i = 0; i < n; i++) db.apply({ op: "chat.upsert", chat: chat(`!x${i}:y`, { lastActivity: iso(NOW - i * 1000) }) });
  }

  test("a chat on a later page that got messages and lost them while the pages were read: the replica keeps all inbox.db keeps", () => {
    const db = mem();
    newer(db, MAX_SYNC_SNAPSHOT_CHATS);
    const C = "!old:y";
    full(db, C, 48);
    let step = 0;
    const { replica, pages } = syncFromEmpty(db, () => {
      if (step++) return;
      // A pending message and its real one (the pending goes), then two more: 50 again.
      db.apply({ op: "messages.upsert", chatID: C, messages: [msg(C, "$m49", "1049"), msg(C, "$m50", "1050")] });
      db.apply({ op: "messages.remove", chatID: C, messageIDs: ["$m49", "$m50"] });
      db.apply({ op: "messages.upsert", chatID: C, messages: [msg(C, "$m51", "1051"), msg(C, "$m52", "1052")] });
    });
    expect(pages.filter((p) => p.kind === "snapshot").length).toBe(2);
    expect(db.messages(C).length).toBe(50);
    expect(replica.state().get(C)!.messages.map((m) => m.id)).toEqual(db.messages(C).map((m) => m.id));
    expect(plain(replica.state())).toEqual(plain(db.dump()));
  });

  test("a chat on a later page that got a message inbox.db then pushed out, and lost its newest: the replica does not keep the one pushed out", () => {
    const db = mem();
    newer(db, MAX_SYNC_SNAPSHOT_CHATS);
    const C = "!old:y";
    // Keys 10, 20, ... 500: full.
    full(db, C, 50, { key: (i) => i * 10 });
    let step = 0;
    const { replica } = syncFromEmpty(db, () => {
      if (step++) return;
      // An older one arrives late (pushes $m1 out), a newer one pushes it out again, then the newest goes.
      db.apply({ op: "messages.upsert", chatID: C, messages: [msg(C, "$late", "15")] });
      db.apply({ op: "messages.upsert", chatID: C, messages: [msg(C, "$m51", "510")] });
      db.apply({ op: "messages.remove", chatID: C, messageIDs: ["$m50"] });
    });
    expect(db.messages(C).map((m) => m.id)).not.toContain("$late");
    expect(replica.state().get(C)!.messages.map((m) => m.id)).toEqual(db.messages(C).map((m) => m.id));
    expect(plain(replica.state())).toEqual(plain(db.dump()));
  });

  test("full chats (about 50 messages) changing between small pages: snapshot then delta gives exactly what inbox.db holds (random runs)", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const db = mem(seed % 4 === 0 ? { key: new Uint8Array(32).fill(seed) } : {});
      const r = rng(5000 + seed);
      const n = 12 + r.int(10);
      const ids = Array.from({ length: n + 4 }, (_, i) => `!f${i}:x`);
      let next = 100;
      // Keys interleave (a late older message, an edit) as well as grow.
      const key = () => String(r.next() < 0.25 ? 1000 + r.int(next) : 1000 + next++);
      for (const id of ids.slice(0, n)) {
        db.apply({ op: "chat.upsert", chat: chat(id, { lastActivity: iso(NOW - r.int(80) * DAY - r.int(DAY)) }) });
        db.apply({ op: "messages.upsert", chatID: id, messages: Array.from({ length: 40 + r.int(25) }, () => msg(id, `$${r.int(1e9)}`, key())) });
      }
      const between = () => {
        for (let k = 1 + r.int(4); k > 0; k--) {
          const id = r.pick(ids);
          const kept = db.messages(id);
          const roll = r.next();
          if (roll < 0.35) db.apply({ op: "messages.upsert", chatID: id, messages: Array.from({ length: 1 + r.int(4) }, () => msg(id, `$${r.int(1e9)}`, key())) });
          else if (roll < 0.6 && kept.length) db.apply({ op: "messages.remove", chatID: id, messageIDs: Array.from({ length: 1 + r.int(3) }, () => r.pick(kept).id) });
          else if (roll < 0.7 && kept.length) db.apply({ op: "messages.upsert", chatID: id, messages: [{ ...r.pick(kept), text: `edited ${r.int(9)}` }] });
          else if (roll < 0.8) db.apply({ op: "chat.upsert", chat: chat(id, { lastActivity: iso(NOW - r.int(3) * 1000), unreadCount: r.int(5) }) });
          else if (roll < 0.88) db.apply({ op: "chat.remove", chatID: id });
          else {
            // Back (or new) with its messages.
            db.apply({ op: "chat.upsert", chat: chat(id, { lastActivity: iso(NOW - r.int(80) * DAY) }) });
            db.apply({ op: "messages.upsert", chatID: id, messages: Array.from({ length: 1 + r.int(55) }, () => msg(id, `$${r.int(1e9)}`, key())) });
          }
        }
      };
      // Pages of a few chats (each whole: one too big for a page would go cut), so most are read after many changes.
      const { replica, pages } = syncFromEmpty(db, between, 30_000);
      expect(pages.filter((p) => p.kind === "snapshot").length).toBeGreaterThanOrEqual(4);
      expect(plain(replica.state())).toEqual(plain(db.dump()));
      db.close();
    }
  });

  test("delta from a cursor: at most MAX_SYNC_CHANGES, `more` until the head, then empty and up to date", () => {
    const db = filled(150);
    const head = db.head();
    expect(head).toBeGreaterThan(MAX_SYNC_CHANGES);
    const first = syncPull(db, { epoch: db.epoch, cursor: 0 });
    expect(first.ok && first.data.kind === "delta" && first.data.changes.length === MAX_SYNC_CHANGES && first.data.more && first.data.changes[0]!.seq === 1).toBe(true);
    const last = syncPull(db, { epoch: db.epoch, cursor: head - 3 });
    expect(last.ok && last.data.kind === "delta" ? [last.data.changes.map((c) => c.seq), last.data.more, last.data.head] : null).toEqual([[head - 2, head - 1, head], false, head]);
    expect(syncPull(db, { epoch: db.epoch, cursor: head })).toEqual({ ok: true, data: { kind: "delta", epoch: db.epoch, head, changes: [], more: false } });
  });

  test("another epoch, no cursor, a cursor ahead of the head: a snapshot; a page cursor that is not ours: BAD_PARAMS", () => {
    const db = filled(3);
    for (const p of [{ epoch: "ep_another1", cursor: 1 }, { epoch: db.epoch }, { epoch: db.epoch, cursor: null }, { epoch: db.epoch, cursor: db.head() + 1 }, {}]) {
      const r = syncPull(db, p);
      expect(r.ok && r.data.kind).toBe("snapshot");
    }
    for (const page of ["x", "s2.short.AAAAAAAAAAAAAAAA.1.1", `s1.${db.epoch}.5.4.1.1`, `s2.${db.epoch}.AAAAAAAAAAAAAAAA.a.1`, `s2.${db.epoch}.AAAA.1.1`, `s2.${db.epoch}.AAAAAAAAAAAAAAAA.-2.1`])
      expect(syncPull(db, { page })).toMatchObject({ ok: false, error: { code: "BAD_PARAMS" } });
    // Well made, of this epoch, but no snapshot of ours (one from before a restart).
    expect(syncPull(db, { page: `s2.${db.epoch}.AAAAAAAAAAAAAAAA.${NOW}.5` })).toMatchObject({ ok: false, error: { code: "BAD_PARAMS" } });
  });

  test("what a snapshot keeps is bounded: none for one page, none after its last page, none left alone too long, too big or too many given up", () => {
    let now = NOW;
    const o = { now: () => now, idleMs: 1000 };
    const one = filled(5);
    expect(syncPull(one, {}, o).ok).toBe(true);
    expect(openSnapshots(one)).toBe(0);
    const db = filled(MAX_SYNC_SNAPSHOT_CHATS * 2 + 3);
    const page1 = (x = db) => {
      const r = syncPull(x, {}, o);
      return r.ok && r.data.kind === "snapshot" ? r.data.next! : "";
    };
    const a = page1();
    expect(openSnapshots(db)).toBe(1);
    const b = syncPull(db, { page: a }, o);
    expect(b.ok && b.data.kind === "snapshot" && b.data.next).toBeTruthy();
    const c = syncPull(db, { page: (b as any).data.next }, o);
    expect(c.ok && c.data.kind === "snapshot" ? c.data.next : "x").toBeNull();
    expect(openSnapshots(db)).toBe(0);
    // Its next page asked for after idleMs: given up, and the page starts again.
    const late = page1();
    now += 1001;
    expect(syncPull(db, { page: late }, o)).toMatchObject({ ok: false, error: { code: "BAD_PARAMS" } });
    expect(openSnapshots(db)).toBe(0);
    // A page asked for within idleMs each time goes on.
    const slow = page1();
    now += 900;
    const s2 = syncPull(db, { page: slow }, o);
    now += 900;
    expect(s2.ok && syncPull(db, { page: (s2 as any).data.next }, o).ok).toBe(true);
    // Keeping more than keepBytes of chats as they were: given up.
    const big = syncPull(db, {}, { ...o, keepBytes: 2000 });
    const next = big.ok && big.data.kind === "snapshot" ? big.data.next! : "";
    for (let i = 0; i < 20; i++) db.apply({ op: "messages.upsert", chatID: `!c${i}:x`, messages: [msg(`!c${i}:x`, `$new${i}`, "999")] });
    expect(openSnapshots(db)).toBe(0);
    expect(syncPull(db, { page: next }, o)).toMatchObject({ ok: false, error: { code: "BAD_PARAMS" } });
    // maxOpen: a new one gives up the one used least lately.
    const o2 = { ...o, maxOpen: 2 };
    const [x, y] = [syncPull(db, {}, o2), syncPull(db, {}, o2)].map((r) => (r.ok && r.data.kind === "snapshot" ? r.data.next! : ""));
    const x2 = syncPull(db, { page: x! }, o2);
    expect(x2.ok).toBe(true);
    syncPull(db, {}, o2);
    expect(openSnapshots(db)).toBe(2);
    expect(syncPull(db, { page: y! }, o2)).toMatchObject({ ok: false, error: { code: "BAD_PARAMS" } });
    expect(syncPull(db, { page: (x2 as any).data.next }, o2).ok).toBe(true);
  });

  test("a chat that came, went, or came back while the pages were read: the pages have it as it was at the head, the delta as it is", () => {
    const db = mem();
    newer(db, MAX_SYNC_SNAPSHOT_CHATS);
    full(db, "!gone:y", 10, { age: 40 });
    full(db, "!back:y", 10, { age: 41 });
    full(db, "!moved:y", 10, { age: 42 });
    let step = 0;
    const { replica, pages } = syncFromEmpty(db, () => {
      if (step++) return;
      db.apply({ op: "chat.remove", chatID: "!gone:y" });
      db.apply({ op: "chat.remove", chatID: "!back:y" });
      full(db, "!back:y", 3, { age: 39 });
      full(db, "!new:y", 4, { age: 43 });
      // Ahead of every chat on the first page: it is still read where it was.
      db.apply({ op: "chat.upsert", chat: chat("!moved:y", { lastActivity: iso(NOW) }) });
    });
    const snaps = pages.filter((p) => p.kind === "snapshot") as Extract<SyncPullResult, { kind: "snapshot" }>[];
    expect(snaps[1]!.chats.map((c) => [c.chat.id, c.messages.length])).toEqual([
      ["!gone:y", 10],
      ["!back:y", 10],
      ["!moved:y", 10],
    ]);
    expect(snaps.flatMap((p) => p.chats).filter((c) => c.chat.id === "!moved:y").length).toBe(1);
    expect(plain(replica.state())).toEqual(plain(db.dump()));
    expect([...db.dump().keys()].filter((id) => !id.startsWith("!x")).sort()).toEqual(["!back:y", "!moved:y", "!new:y"]);
  });

  test("a snapshot page of another epoch (inbox.db made again meanwhile) starts a new snapshot in the new epoch", () => {
    const db = filled(MAX_SYNC_SNAPSHOT_CHATS + 5);
    const r = syncPull(db, {});
    const next = r.ok && r.data.kind === "snapshot" ? r.data.next! : "";
    const other = filled(4, 9);
    const again = syncPull(other, { page: next });
    expect(again.ok && again.data.kind === "snapshot" ? [again.data.epoch, again.data.chats.length, again.data.next] : null).toEqual([other.epoch, 4, null]);
  });

  test("compaction keeps the newest `keep` changes: a cursor older than that gets a snapshot, a newer one a delta", () => {
    const keep = 40;
    const db = filled(120, 3, { keep });
    const head = db.head();
    const floor = db.floor();
    expect(floor).toBeGreaterThan(0);
    expect(head - floor).toBeGreaterThanOrEqual(keep);
    expect(allChanges(db)[0]!.seq).toBe(floor + 1);
    expect(syncPull(db, { epoch: db.epoch, cursor: floor - 1 }).ok && (syncPull(db, { epoch: db.epoch, cursor: floor - 1 }) as any).data.kind).toBe("snapshot");
    const d = syncPull(db, { epoch: db.epoch, cursor: floor });
    expect(d.ok && d.data.kind === "delta" && d.data.changes[0]!.seq).toBe(floor + 1);
    // And a page that only has the snapshot catches up the same.
    expect(plain(syncFromEmpty(db).replica.state())).toEqual(plain(db.dump()));
  });

  test("asset URLs in an answer are allowed for get_media (a result carried them)", () => {
    const db = mem();
    const url = "mxc://beeper.local/photo1";
    db.apply({ op: "chat.upsert", chat: chat("!a:b", { avatarURL: "mxc://beeper.local/avatar" }) });
    db.apply({ op: "messages.upsert", chatID: "!a:b", messages: [msg("!a:b", "$1", "1", { type: "IMAGE", attachments: [{ type: "img", url }] })] });
    const seen: string[] = [];
    syncPull(db, {}, { allow: (u) => seen.push(u) });
    expect(seen.sort()).toEqual(["mxc://beeper.local/avatar", url]);
    const d: string[] = [];
    syncPull(db, { epoch: db.epoch, cursor: 0 }, { allow: (u) => d.push(u) });
    expect(d.sort()).toEqual(["mxc://beeper.local/avatar", url]);
  });
});

describe("sizes: every change, answer and frame fits in a frame", () => {
  // The largest messages there are: emails at MAX_EMAIL_TEXT_LENGTH of three-byte characters, three times over.
  const huge = (chatID: string, i: number): MessageItem => msg(chatID, `m${i}`, String(1_000_000 + i), { text: "中".repeat(20_000), quotedText: "文".repeat(20_000), plainText: "字".repeat(20_000) });
  const res = (data: unknown) => encodeFrame({ type: "res", id: "r".repeat(64), ok: true, data } as never);

  test("50 maximal emails go as several messages.upsert changes, each alone well under a frame", () => {
    const db = mem();
    const id = "gmail:o@example.com:18c2f0a1b2c3d4e5";
    db.apply({ op: "chat.upsert", chat: chat(id, { preview: huge(id, 99) }) });
    const made = db.apply({ op: "messages.upsert", chatID: id, messages: Array.from({ length: 50 }, (_, i) => huge(id, i)) });
    expect(made.length).toBeGreaterThan(5);
    expect(made.flatMap((c) => (c.op === "messages.upsert" ? c.messages : [])).length).toBe(50);
    for (const c of made) expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThan(MAX_FRAME_BYTES / 2);
    // Delta pages and the sync frames: valid frames under MAX_FRAME_BYTES, all changes, in order.
    let cursor = 0;
    const seen: number[] = [];
    for (;;) {
      const d = syncPull(db, { epoch: db.epoch, cursor });
      if (!d.ok || d.data.kind !== "delta") throw new Error("delta");
      const enc = res(d.data);
      expect(enc.ok).toBe(true);
      seen.push(...d.data.changes.map((c) => c.seq));
      if (!d.data.more) break;
      cursor = d.data.changes.at(-1)!.seq;
    }
    expect(seen).toEqual(allChanges(db).map((c) => c.seq));
    const frames = syncFrames(db.epoch, allChanges(db));
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      const enc = encodeFrame(f);
      expect(enc.ok).toBe(true);
      if (enc.ok) expect(parseConnectorFrame(enc.value).ok).toBe(true);
    }
    expect(frames.flatMap((f) => f.changes.map((c) => c.seq))).toEqual(seen);
    // A snapshot of that chat: under a frame, with its newest messages that fit.
    const s = syncPull(db, {});
    expect(s.ok && res(s.data).ok).toBe(true);
    const kept = s.ok && s.data.kind === "snapshot" ? s.data.chats[0]!.messages : [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(50);
    expect(kept.at(-1)!.id).toBe("m49");
  });

  test("many chats of large messages: snapshot pages stay under a frame and together hold every chat", () => {
    const db = mem();
    for (let i = 0; i < 12; i++) {
      const id = `!big${i}:x`;
      db.apply({ op: "chat.upsert", chat: chat(id, { lastActivity: iso(NOW - i * 1000) }) });
      db.apply({ op: "messages.upsert", chatID: id, messages: Array.from({ length: 3 }, (_, j) => huge(id, j)) });
    }
    const { replica, pages } = syncFromEmpty(db);
    expect(pages.filter((p) => p.kind === "snapshot").length).toBeGreaterThan(3);
    for (const p of pages) expect(res(p).ok).toBe(true);
    expect(plain(replica.state())).toEqual(plain(db.dump()));
  });

  test("MAX_SYNC_CHANGES small changes a frame", () => {
    const db = mem();
    for (let i = 0; i < 450; i++) db.apply({ op: "chat.upsert", chat: chat(`!c${i}:x`) });
    expect(syncFrames(db.epoch, allChanges(db)).map((f) => f.changes.length)).toEqual([200, 200, 50]);
  });
});

describe("the sync frames", () => {
  test("coalesced for a moment, sent in seq order; dropped while the link is down (never kept for later)", async () => {
    const sent: { changes: SyncChange[] }[] = [];
    let up = true;
    const db = mem({ onChanges: (c) => pusher.push(c) });
    const pusher = new SyncPusher({ epoch: db.epoch, send: (f) => (sent.push(f), true), connected: () => up, coalesceMs: 30 });
    db.apply({ op: "chat.upsert", chat: chat("!a:b") });
    db.apply({ op: "messages.upsert", chatID: "!a:b", messages: [msg("!a:b", "$1", "1")] });
    expect(sent.length).toBe(0);
    await Bun.sleep(60);
    expect(sent.map((f) => f.changes.map((c) => c.seq))).toEqual([[1, 2]]);
    up = false;
    db.apply({ op: "chat.upsert", chat: chat("!c:d") });
    await Bun.sleep(60);
    up = true;
    db.apply({ op: "chat.upsert", chat: chat("!e:f") });
    await Bun.sleep(60);
    // seq 3 is gone for good: the page sees 4 after 2 and pulls.
    expect(sent.map((f) => f.changes.map((c) => c.seq))).toEqual([[1, 2], [4]]);
    expect(pusher.dropped).toBe(1);
  });

  test("a frame the link refuses: it and the rest of that batch are dropped", async () => {
    const sent: number[][] = [];
    let n = 0;
    const db = mem({ onChanges: (c) => pusher.push(c) });
    const pusher = new SyncPusher({ epoch: db.epoch, send: (f) => (n++ === 0 ? (sent.push(f.changes.map((c) => c.seq)), true) : false), connected: () => true, coalesceMs: 10 });
    for (let i = 0; i < 450; i++) db.apply({ op: "chat.upsert", chat: chat(`!c${i}:x`) });
    await Bun.sleep(40);
    expect(sent.length).toBe(1);
    expect(sent[0]!.length).toBe(200);
    expect(pusher.dropped).toBe(250);
  });
});

describe("the file", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "jinbox-inbox-"));
  test("made with a random epoch; opened again it keeps its epoch and changelog; made again it has a new epoch", () => {
    const path = join(dir(), "data", "inbox.db");
    const a = InboxDB.open({ path });
    expect(a.created).toBe(true);
    expect(a.epoch).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    a.apply({ op: "chat.upsert", chat: chat("!a:b") });
    a.close();
    const b = InboxDB.open({ path });
    expect([b.created, b.epoch, b.head(), b.chat("!a:b")?.id]).toEqual([false, a.epoch, 1, "!a:b"]);
    expect(new Database(path, { readonly: true }).query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect((Bun.file(path) as any).size).toBeGreaterThan(0);
    b.close();
    const st = require("node:fs").statSync(path);
    expect(st.mode & 0o777).toBe(0o600);
    // Wiped (a new install): a new epoch, nothing kept, seq from 1 again.
    for (const f of [path, `${path}-wal`, `${path}-shm`]) require("node:fs").rmSync(f, { force: true });
    const c = InboxDB.open({ path });
    expect(c.created).toBe(true);
    expect(c.epoch).not.toBe(a.epoch);
    expect(c.head()).toBe(0);
    c.close();
  });

  test("sealed with its key: no text in the clear in the file or its WAL; the same key opens it, another key or none makes it again", () => {
    const path = join(dir(), "inbox.db");
    const key = new Uint8Array(32).fill(7);
    const a = InboxDB.open({ path, key });
    a.apply({ op: "chat.upsert", chat: chat("!a:b", { title: "SECRET-TITLE" }) });
    a.apply({ op: "messages.upsert", chatID: "!a:b", messages: [msg("!a:b", "$1", "1", { text: "SECRET-TEXT" })] });
    const raw = [path, `${path}-wal`].map((f) => (require("node:fs").existsSync(f) ? require("node:fs").readFileSync(f, "latin1") : "")).join("");
    expect(raw.length).toBeGreaterThan(0);
    for (const s of ["SECRET-TITLE", "SECRET-TEXT", "Chat !a:b"]) expect(raw.includes(s)).toBe(false);
    // What it answers is the plain JSON.
    expect(a.messages("!a:b")[0]!.text).toBe("SECRET-TEXT");
    expect(a.changesAfter(0, 10, 1e9).map((c) => c.op)).toEqual(["chat.upsert", "messages.upsert"]);
    const epoch = a.epoch;
    a.close();
    const same = InboxDB.open({ path, key: new Uint8Array(32).fill(7) });
    expect([same.created, same.epoch, same.chat("!a:b")?.title]).toEqual([false, epoch, "SECRET-TITLE"]);
    same.close();
    const other = InboxDB.open({ path, key: new Uint8Array(32).fill(8) });
    expect([other.created, other.epoch === epoch, other.chatCount()]).toEqual([true, false, 0]);
    other.close();
    const none = InboxDB.open({ path });
    expect([none.created, none.epoch === other.epoch]).toEqual([true, false]);
    none.close();
    expect(() => InboxDB.open({ path: ":memory:", key: new Uint8Array(16) })).toThrow();
  });

  test("sealed with its key: no chat id, message id or text in the clear in the file or its WAL, whatever wrote them; every read answers the real ids", () => {
    const path = join(dir(), "inbox.db");
    const key = new Uint8Array(32).fill(9);
    // Ids as Beeper and Gmail make them: a phone number, an address.
    const A = "imsg##thread:+15550199001";
    const B = "gmail:idmarker.owner@example.com:thread-IDMARKER-77";
    const OLD = "imsg##thread:+15550199002";
    const M = ["$msgid-IDMARKER-1", "$msgid-IDMARKER-2", "$msgid-IDMARKER-3"];
    const a = InboxDB.open({ path, key, now: () => NOW });
    a.apply({ op: "chat.upsert", chat: chat(A, { title: "TITLE-MARKER-A", accountID: "imessage" }) }, "op-1");
    a.apply({ op: "chat.upsert", chat: chat(B, { title: "TITLE-MARKER-B", accountID: "gmail" }) });
    a.apply({ op: "chat.upsert", chat: chat(OLD, { isArchived: true, lastActivity: iso(NOW - 2 * DAY) }) });
    a.apply({ op: "messages.upsert", chatID: A, messages: M.map((id, i) => msg(A, id, String(10 + i), { text: `TEXT-MARKER-${i}` })) });
    a.apply({ op: "messages.upsert", chatID: B, messages: [msg(B, "gmail-msg-IDMARKER-9", "1", { text: "TEXT-MARKER-B" })] });
    a.apply({ op: "messages.remove", chatID: A, messageIDs: [M[0]!] });
    // Every read answers the real ids, not the columns.
    expect(a.messageIDsFrom(A, "0").sort()).toEqual([M[1]!, M[2]!]);
    expect(a.messages(A).map((m) => m.id)).toEqual([M[1]!, M[2]!]);
    expect(a.chatIDsOfAccounts(["gmail"])).toEqual([B]);
    expect(a.snapshotRow(A)?.chatID).toBe(A);
    expect(a.snapshotAfter(a.head(), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 10).map((r) => r.chatID).sort()).toEqual([A, B, OLD].sort());
    expect([...a.dump().keys()].sort()).toEqual([A, B, OLD].sort());
    a.close();
    // Time takes OLD (archived) and B (a Gmail thread, archived or not) out of the window: the sweep names them by their real ids.
    const b = InboxDB.open({ path, key, now: () => NOW + (SYNC_WINDOW_DAYS + 10) * DAY });
    expect(b.created).toBe(false);
    expect(b.outOfWindow().sort()).toEqual([OLD, B].sort());
    b.apply({ op: "chat.remove", chatID: OLD });
    b.apply({ op: "chat.remove", chatID: B });
    const changes = b.changesAfter(0, 100, 1e9);
    expect(changes.map((c) => c.op)).toEqual(["chat.upsert", "chat.upsert", "chat.upsert", "messages.upsert", "messages.upsert", "messages.remove", "chat.remove", "chat.remove"]);
    expect(changes.filter((c) => c.op === "chat.remove").map((c) => (c as { chatID: string }).chatID)).toEqual([OLD, B]);
    expect(changes[0]!.opId).toBe("op-1");
    b.close();
    const raw = Buffer.concat([path, `${path}-wal`].map((f) => (require("node:fs").existsSync(f) ? require("node:fs").readFileSync(f) : Buffer.alloc(0))));
    expect(raw.length).toBeGreaterThan(0);
    const leaks = [A, B, OLD, ...M, "gmail-msg-IDMARKER-9", "+15550199001", "+15550199002", "idmarker.owner@example.com", "IDMARKER", "TITLE-MARKER", "TEXT-MARKER"].filter((s) => raw.includes(Buffer.from(s, "utf8")));
    expect(leaks).toEqual([]);
  });

  test("a file that is not a database, or of another schema version, is made again with a new epoch", () => {
    const d = dir();
    const path = join(d, "inbox.db");
    writeFileSync(path, "this is not sqlite at all, not even close".repeat(100));
    const logs: string[] = [];
    const a = InboxDB.open({ path, log: (m) => logs.push(m) });
    expect(a.created).toBe(true);
    expect(logs.join("\n")).toContain("could not be read");
    a.apply({ op: "chat.upsert", chat: chat("!a:b") });
    const epoch = a.epoch;
    a.close();
    const raw = new Database(path);
    raw.query("UPDATE meta SET value = ? WHERE key = 'schema'").run(String(INBOX_SCHEMA_VERSION + 1));
    raw.close();
    const b = InboxDB.open({ path, log: (m) => logs.push(m) });
    expect([b.created, b.epoch === epoch, b.chatCount()]).toEqual([true, false, 0]);
    expect(logs.join("\n")).toContain("another version");
    b.close();
  });
});
