// What keeps inbox.db true (src/inbox/ingest.ts) and its first build (build.ts), over a stand-in
// for read_chat: a chat read again is applied whole; gone is removed; one read per chat at a time;
// the owner's action holds a chat's reads and its opId lands on what it caused; the build reads
// the window only, paced behind everything else, and goes on after a restart.
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { makeError, type ActionResult, type ChatSummary, type MessageItem, type SyncChange } from "@j-inbox/protocol";
import type { Outcome } from "../src/actions.ts";
import { InboxDB } from "../src/inbox/db.ts";
import { InboxIngest } from "../src/inbox/ingest.ts";
import { FirstBuild } from "../src/inbox/build.ts";

// Random runs, whole services and first builds: slower than bun's 5 s default on a CI machine.
setDefaultTimeout(30_000);

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (t: number) => new Date(t).toISOString();
const chat = (id: string, o: Partial<ChatSummary> = {}): ChatSummary => ({ id, accountID: "acc1", network: "WhatsApp", title: `Chat ${id}`, type: "single", unreadCount: 0, isPinned: false, isMuted: false, isArchived: false, lastActivity: iso(NOW - DAY), ...o });
const msg = (chatID: string, id: string, sortKey: string, o: Partial<MessageItem> = {}): MessageItem => ({ id, chatID, accountID: "acc1", senderID: "@alice:beeper.local", timestamp: iso(NOW - DAY), sortKey, type: "TEXT", text: `text ${id}`, isSender: false, ...o });

/** read_chat as a map the test changes; every read is counted, and may be made to wait. */
function source() {
  const chats = new Map<string, { chat: ChatSummary; items: MessageItem[] } | { error: "NOT_FOUND" | "BEEPER_DOWN" }>();
  const reads: string[] = [];
  let gate: Promise<void> | null = null;
  const read = async (chatID: string): Promise<Outcome<ActionResult<"read_chat">>> => {
    reads.push(chatID);
    if (gate) await gate;
    const c = chats.get(chatID);
    if (!c) return { ok: false, error: makeError("NOT_FOUND", "no such chat") };
    if ("error" in c) return { ok: false, error: makeError(c.error, "x") };
    return { ok: true, data: { chat: c.chat, items: c.items, hasMore: false, nextCursor: null } };
  };
  return {
    chats,
    reads,
    read,
    /** Reads wait until the returned function is called. */
    hold() {
      let open!: () => void;
      gate = new Promise((r) => (open = r));
      return () => {
        gate = null;
        open();
      };
    },
  };
}

function setup(o: { lingerMs?: number; retryMs?: number[]; now?: () => number } = {}) {
  const changes: SyncChange[] = [];
  const db = InboxDB.open({ path: ":memory:", now: o.now ?? (() => NOW), onChanges: (c) => changes.push(...c) });
  const src = source();
  const ingest = new InboxIngest({ db, read: src.read, now: o.now ?? (() => NOW), lingerMs: o.lingerMs, retryMs: o.retryMs ?? [20, 20] });
  return { db, src, ingest, changes, ops: () => changes.map((c) => c.op) };
}

describe("ingest", () => {
  test("a chat read again is applied whole: the chat, then its messages; the same read again changes nothing", async () => {
    const { db, src, ingest, ops } = setup();
    src.chats.set("!a:b", { chat: chat("!a:b"), items: [msg("!a:b", "$1", "1"), msg("!a:b", "$2", "2")] });
    await ingest.refresh("!a:b");
    expect(ops()).toEqual(["chat.upsert", "messages.upsert"]);
    expect(db.messages("!a:b").map((m) => m.id)).toEqual(["$1", "$2"]);
    await ingest.refresh("!a:b");
    expect(ops()).toEqual(["chat.upsert", "messages.upsert"]);
  });

  test("a chat with no preview, or one that says nothing, shows its newest message, as a list would", async () => {
    const { db, src, ingest } = setup();
    const bare = msg("!a:b", "$9", "9", { type: "UNKNOWN", text: undefined });
    src.chats.set("!a:b", { chat: chat("!a:b", { preview: bare }), items: [msg("!a:b", "$2", "2"), msg("!a:b", "$1", "1")] });
    src.chats.set("!c:d", { chat: chat("!c:d", { preview: msg("!c:d", "$p", "5", { text: "kept" }) }), items: [msg("!c:d", "$1", "1")] });
    await Promise.all([ingest.refresh("!a:b"), ingest.refresh("!c:d")]);
    expect(db.chat("!a:b")!.preview!.id).toBe("$2");
    expect(db.chat("!c:d")!.preview!.text).toBe("kept");
  });

  test("NOT_FOUND removes the chat; a chat gone from the window is removed too", async () => {
    const { db, src, ingest, ops } = setup();
    src.chats.set("!a:b", { chat: chat("!a:b"), items: [] });
    src.chats.set("!c:d", { chat: chat("!c:d"), items: [] });
    await Promise.all([ingest.refresh("!a:b"), ingest.refresh("!c:d")]);
    src.chats.delete("!a:b");
    src.chats.set("!c:d", { chat: chat("!c:d", { isArchived: true, lastActivity: iso(NOW - 100 * DAY) }), items: [] });
    await Promise.all([ingest.refresh("!a:b"), ingest.refresh("!c:d")]);
    expect(ops().slice(2)).toEqual(["chat.remove", "chat.remove"]);
    expect(db.chatCount()).toBe(0);
  });

  test("messages kept in the range a read covered and not in it are removed; older ones are not", async () => {
    const { db, src, ingest, changes } = setup();
    const all = [1, 2, 3, 4, 5].map((i) => msg("!a:b", `$${i}`, String(i)));
    src.chats.set("!a:b", { chat: chat("!a:b"), items: all });
    await ingest.refresh("!a:b");
    // The newest page now: 3 and 5 (4 was deleted), 1 and 2 are older than it.
    src.chats.set("!a:b", { chat: chat("!a:b"), items: [all[2]!, all[4]!] });
    await ingest.refresh("!a:b");
    expect(changes.at(-1)).toMatchObject({ op: "messages.remove", messageIDs: ["$4"] });
    expect(db.messages("!a:b").map((m) => m.id)).toEqual(["$1", "$2", "$3", "$5"]);
  });

  test("events: a deleted chat or message goes at once, without waiting for a read; an upsert reads", async () => {
    const { db, src, ingest, ops } = setup();
    src.chats.set("!a:b", { chat: chat("!a:b"), items: [msg("!a:b", "$1", "1"), msg("!a:b", "$2", "2")] });
    await ingest.refresh("!a:b");
    const open = src.hold();
    ingest.onEvent({ type: "event", kind: "message", op: "deleted", chatID: "!a:b", messageIDs: ["$2"], ts: iso(NOW) });
    expect(db.messages("!a:b").map((m) => m.id)).toEqual(["$1"]);
    ingest.onEvent({ type: "event", kind: "chat", op: "deleted", chatID: "!a:b", ts: iso(NOW) });
    expect(db.chat("!a:b")).toBeNull();
    // The read the message event asked for was out when the chat went: its answer is dropped.
    open();
    await ingest.idle();
    expect(db.chat("!a:b")).toBeNull();
    expect(ops()).toEqual(["chat.upsert", "messages.upsert", "messages.remove", "chat.remove"]);
    ingest.onEvent({ type: "event", kind: "status", ts: iso(NOW), beeper: { reachable: true, version: null } });
    expect(src.reads.length).toBe(2);
  });

  test("one read per chat at a time: asked again while it is out, it is read once more after, however often it was asked", async () => {
    const { db, src, ingest } = setup();
    src.chats.set("!a:b", { chat: chat("!a:b", { unreadCount: 1 }), items: [] });
    const open = src.hold();
    const first = ingest.refresh("!a:b");
    await Bun.sleep(5);
    // The chat changes while the first read is out; three events say so.
    src.chats.set("!a:b", { chat: chat("!a:b", { unreadCount: 2 }), items: [] });
    for (let i = 0; i < 3; i++) ingest.onEvent({ type: "event", kind: "chat", op: "upserted", chatID: "!a:b", ts: iso(NOW) });
    open();
    await first;
    await ingest.idle();
    expect(src.reads).toEqual(["!a:b", "!a:b"]);
    expect(db.chat("!a:b")!.unreadCount).toBe(2);
  });

  test("a read that fails (not NOT_FOUND) is tried again later", async () => {
    const { db, src, ingest } = setup({ retryMs: [10, 10] });
    src.chats.set("!a:b", { error: "BEEPER_DOWN" });
    await ingest.refresh("!a:b");
    src.chats.set("!a:b", { chat: chat("!a:b"), items: [] });
    await Bun.sleep(40);
    await ingest.idle();
    expect(db.chat("!a:b")?.id).toBe("!a:b");
    expect(src.reads.length).toBe(2);
  });

  test("the owner's action: reads of the chat wait while it runs, then one read carries its opId; for a moment after, so do changes to that chat", async () => {
    let now = NOW;
    const { db, src, ingest, changes } = setup({ now: () => now, lingerMs: 1000 });
    src.chats.set("!a:b", { chat: chat("!a:b"), items: [msg("!a:b", "$1", "1")] });
    src.chats.set("!c:d", { chat: chat("!c:d"), items: [] });
    await ingest.refresh("!a:b");
    const end = ingest.begin("!a:b", "op_send0001");
    // Beeper says the chat changed while the send is still running: no read yet (it would carry no opId).
    src.chats.set("!a:b", { chat: chat("!a:b", { lastActivity: iso(NOW) }), items: [msg("!a:b", "$1", "1"), msg("!a:b", "$2", "2", { isSender: true })] });
    ingest.onEvent({ type: "event", kind: "message", op: "upserted", chatID: "!a:b", messageIDs: ["$2"], ts: iso(NOW) });
    // Other chats are not held.
    await ingest.refresh("!c:d");
    await Bun.sleep(10);
    expect(src.reads.filter((x) => x === "!a:b").length).toBe(1);
    await end(true);
    expect(src.reads.filter((x) => x === "!a:b").length).toBe(2);
    const caused = changes.filter((c) => c.op !== "chat.upsert" || c.chat.id === "!a:b").slice(2);
    expect(caused.map((c) => [c.op, c.opId])).toEqual([
      ["chat.upsert", "op_send0001"],
      ["messages.upsert", "op_send0001"],
    ]);
    // Beeper's send status a moment later: still the owner's request's doing.
    src.chats.set("!a:b", { chat: chat("!a:b", { lastActivity: iso(NOW) }), items: [msg("!a:b", "$1", "1"), msg("!a:b", "$2", "2", { isSender: true, sendStatus: "SUCCESS" })] });
    await ingest.refresh("!a:b");
    expect(changes.at(-1)).toMatchObject({ op: "messages.upsert", opId: "op_send0001" });
    // After the linger, a change is nobody's request's.
    now += 1001;
    src.chats.set("!a:b", { chat: chat("!a:b", { lastActivity: iso(NOW), unreadCount: 3 }), items: [msg("!a:b", "$1", "1"), msg("!a:b", "$2", "2", { isSender: true, sendStatus: "SUCCESS" })] });
    await ingest.refresh("!a:b");
    expect(changes.at(-1)!.op).toBe("chat.upsert");
    expect(changes.at(-1)!.opId).toBeUndefined();
    expect(db.chat("!a:b")!.unreadCount).toBe(3);
  });

  test("the owner's next action on the chat ends the one before's linger: its changes are its own (here, none)", async () => {
    const { src, ingest, changes } = setup({ lingerMs: 60_000 });
    src.chats.set("!a:b", { chat: chat("!a:b"), items: [] });
    await ingest.begin("!a:b", "op_first001")(true);
    expect(changes.map((c) => c.opId)).toEqual(["op_first001"]);
    const end = ingest.begin("!a:b");
    src.chats.set("!a:b", { chat: chat("!a:b", { unreadCount: 0, isPinned: true }), items: [] });
    await end(true);
    expect(changes.map((c) => c.opId)).toEqual(["op_first001", undefined]);
  });

  test("an action that failed: no opId, and the reads it held go on", async () => {
    const { src, ingest, changes } = setup();
    src.chats.set("!a:b", { chat: chat("!a:b"), items: [] });
    const end = ingest.begin("!a:b", "op_fail0001");
    ingest.onEvent({ type: "event", kind: "chat", op: "upserted", chatID: "!a:b", ts: iso(NOW) });
    await Bun.sleep(10);
    expect(src.reads).toEqual([]);
    await end(false);
    await ingest.idle();
    expect(changes.map((c) => [c.op, c.opId])).toEqual([["chat.upsert", undefined]]);
  });

  test("the build's reads wait behind every other read", async () => {
    const { src, ingest } = setup();
    for (const id of ["!b1:x", "!b2:x", "!u1:x", "!u2:x"]) src.chats.set(id, { chat: chat(id), items: [] });
    const open = src.hold();
    const all = [ingest.refresh("!b1:x", { background: true }), ingest.refresh("!b2:x", { background: true })];
    await Bun.sleep(5);
    all.push(ingest.refresh("!u1:x"), ingest.refresh("!u2:x"));
    open();
    await Promise.all(all);
    // Two readers: the first two background reads had started; the urgent ones went before nothing else.
    expect(src.reads).toEqual(["!b1:x", "!b2:x", "!u1:x", "!u2:x"]);
    const r2 = setup();
    for (const id of ["!b1:x", "!b2:x", "!b3:x", "!u1:x"]) r2.src.chats.set(id, { chat: chat(id), items: [] });
    const open2 = r2.src.hold();
    const p = [r2.ingest.refresh("!u1:x"), r2.ingest.refresh("!b1:x", { background: true }), r2.ingest.refresh("!b2:x", { background: true }), r2.ingest.refresh("!b3:x", { background: true })];
    open2();
    await Promise.all(p);
    expect(r2.src.reads[0]).toBe("!u1:x");
  });

  test("a removed account's chats go", async () => {
    const { db, src, ingest } = setup();
    src.chats.set("!a:b", { chat: chat("!a:b", { accountID: "whatsapp1" }), items: [] });
    src.chats.set("!c:d", { chat: chat("!c:d", { accountID: "telegram1" }), items: [] });
    await Promise.all([ingest.refresh("!a:b"), ingest.refresh("!c:d")]);
    ingest.removeAccounts(["whatsapp1"], "op_rm000001");
    expect([...db.dump().keys()]).toEqual(["!c:d"]);
  });
});

describe("the first build", () => {
  /** Beeper's chat list as pages of 3, newest first. */
  function beeper(list: ChatSummary[]) {
    const asked: (string | null)[] = [];
    let failNext = 0;
    return {
      asked,
      failNext: (n: number) => (failNext = n),
      page: async (cursor: string | null) => {
        asked.push(cursor);
        if (failNext > 0) {
          failNext--;
          throw new Error("Beeper is down");
        }
        const from = cursor ? Number(cursor) : 0;
        const items = list.slice(from, from + 3);
        return { items, next: from + 3 < list.length ? String(from + 3) : null };
      },
    };
  }

  test("reads every chat in the window once, removes a kept one that left it, and records it is done", async () => {
    const { db, src, ingest } = setup();
    const list = [chat("!1:x"), chat("!2:x", { isArchived: true, lastActivity: iso(NOW - 100 * DAY) }), chat("!3:x", { isArchived: false, lastActivity: iso(NOW - 900 * DAY) }), chat("!4:x"), chat("!5:x", { isArchived: true, lastActivity: iso(NOW - 2 * DAY) }), chat("!6:x"), chat("!7:x")];
    for (const c of list) src.chats.set(c.id, { chat: c, items: [] });
    // Kept from before, now out of the window.
    db.apply({ op: "chat.upsert", chat: chat("!2:x", { isArchived: true, lastActivity: iso(NOW - 80 * DAY) }) });
    const b = beeper(list);
    const build = new FirstBuild({ db, ingest, beeperPage: b.page, paceMs: 0, now: () => NOW });
    expect(build.started).toBe(false);
    build.start();
    expect(build.started).toBe(true);
    for (let i = 0; i < 200 && !db.meta("build.done"); i++) await Bun.sleep(5);
    expect(db.meta("build.done")).toBeTruthy();
    expect(src.reads.sort()).toEqual(["!1:x", "!3:x", "!4:x", "!5:x", "!6:x", "!7:x"]);
    expect([...db.dump().keys()].sort()).toEqual(["!1:x", "!3:x", "!4:x", "!5:x", "!6:x", "!7:x"]);
    expect(b.asked).toEqual([null, "3", "6"]);
    expect(build.done).toBe(true);
  });

  test("a restart goes on from the page it was on, and a chat already kept as it is is not read again", async () => {
    const { db, src, ingest } = setup();
    const list = Array.from({ length: 9 }, (_, i) => chat(`!${i}:x`));
    for (const c of list) src.chats.set(c.id, { chat: c, items: [] });
    const b = beeper(list);
    // The first run stops after a page and a half.
    let n = 0;
    const first: FirstBuild = new FirstBuild({ db, ingest: { ...ingest, busy: false, removeChat: (id) => ingest.removeChat(id), refresh: async (id: string, o?: { opId?: string; background?: boolean }): Promise<void> => (++n === 5 ? first.stop() : undefined, ingest.refresh(id, o)) }, beeperPage: b.page, paceMs: 0, now: () => NOW });
    first.start();
    for (let i = 0; i < 100 && n < 5; i++) await Bun.sleep(5);
    await Bun.sleep(20);
    expect(JSON.parse(db.meta("build:beeper")!)).toEqual({ cursor: "3", done: false });
    const readsBefore = src.reads.length;
    const second = new FirstBuild({ db, ingest, beeperPage: b.page, paceMs: 0, now: () => NOW });
    second.start();
    for (let i = 0; i < 200 && !db.meta("build.done"); i++) await Bun.sleep(5);
    expect(b.asked).toEqual([null, "3", "3", "6"]);
    // Page "3" again: the chat read before the stop is not read twice.
    expect(src.reads.length - readsBefore).toBe(9 - 5);
    expect(db.chatCount()).toBe(9);
  });

  test("a source that fails is tried again later; Gmail's walk asks for the window and reads its threads", async () => {
    const { db, src, ingest } = setup();
    const b = beeper([chat("!1:x")]);
    b.failNext(1);
    src.chats.set("!1:x", { chat: chat("!1:x"), items: [] });
    const gid = "gmail:o@example.com:18c2f0a1b2c3d4e5";
    src.chats.set(gid, { chat: chat(gid, { accountID: "gmail:o@example.com", network: "Gmail" }), items: [] });
    const queries: string[] = [];
    const gmail = { email: "o@example.com", threadIDs: async (q: string) => (queries.push(q), { ids: ["18c2f0a1b2c3d4e5"], next: null }) };
    const build = new FirstBuild({ db, ingest, beeperPage: b.page, gmail: () => [gmail], paceMs: 0, retryMs: 30, now: () => NOW });
    build.start();
    for (let i = 0; i < 200 && !db.meta("build.done"); i++) await Bun.sleep(5);
    expect(db.meta("build.done")).toBeTruthy();
    expect(b.asked).toEqual([null, null]);
    expect(queries[0]).toBe(`(in:inbox OR after:${Math.floor((NOW - 90 * DAY) / 1000)}) -in:drafts`);
    expect([...db.dump().keys()].sort()).toEqual(["!1:x", gid]);
  });

  test("it waits while the connector answers requests", async () => {
    const { db, src, ingest } = setup();
    src.chats.set("!1:x", { chat: chat("!1:x"), items: [] });
    let busy = true;
    const build = new FirstBuild({ db, ingest, beeperPage: beeper([chat("!1:x")]).page, paceMs: 0, busy: () => busy, now: () => NOW });
    build.start();
    await Bun.sleep(80);
    expect(src.reads).toEqual([]);
    busy = false;
    for (let i = 0; i < 100 && !db.meta("build.done"); i++) await Bun.sleep(5);
    expect(src.reads).toEqual(["!1:x"]);
  });
});
