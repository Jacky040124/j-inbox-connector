// To do on the owner's computer: the store (todo/store.ts), the tracker (todo/tracker.ts) and the whole
// service against fake Beeper, fake Gmail and a fake cloud. Network read state is never touched.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { FAKE_GOOGLE_CLIENT, OWNER_EMAIL, THREADS, startFakeGoogle, type RunningFakeGoogle } from "@j-inbox/fake-google";
import { gmailChatID, type ChatSummary, type EventFrame, type MessageItem } from "@j-inbox/protocol";
import { resolvePaths, saveConfig } from "../src/config.ts";
import { mapChat } from "../src/beeper-map.ts";
import { othersAtOf } from "../src/beeper-ws.ts";
import { FileSecretStore } from "../src/secrets.ts";
import { startService, type Service } from "../src/service.ts";
import { TodoStore, MAX_TODO_ENTRIES, noteHiddenPreview, othersFact, sourceOf } from "../src/todo/store.ts";
import { TodoTracker } from "../src/todo/tracker.ts";
import { EventBuffer } from "../src/event-buffer.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const T0 = Date.parse("2026-11-04T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const min = 60_000;

const msg = (id: string, at: number, o: Partial<MessageItem> = {}): MessageItem => ({ id, chatID: "c1", accountID: "a", senderID: "them", timestamp: iso(at), sortKey: String(at), type: "TEXT", isSender: false, ...o });
const chat = (o: Partial<ChatSummary> = {}): ChatSummary => ({ id: "c1", accountID: "a", network: "WhatsApp", title: "Chat", type: "single", unreadCount: 0, isPinned: false, isMuted: false, isArchived: false, lastActivity: iso(T0), ...o });
/** A chat whose newest message is someone else's, at `at`. */
const inbound = (at: number, o: Partial<ChatSummary> = {}) => chat({ lastActivity: iso(at), preview: msg(`m${at}`, at), ...o });
/** A chat whose newest message is the owner's, at `at`. */
const ownLast = (at: number, o: Partial<ChatSummary> = {}) => chat({ lastActivity: iso(at), preview: msg(`m${at}`, at, { isSender: true }), ...o });

function makeStore(o: { path?: string; max?: number } = {}) {
  const clock = { now: T0 };
  const store = new TodoStore({ now: () => clock.now, ...o });
  return { store, clock };
}
/** A source whose first run is over, known since T0. */
function settled(o: { path?: string; max?: number } = {}) {
  const r = makeStore(o);
  r.store.meet("beeper");
  r.store.finishFirstRun("beeper");
  r.clock.now = T0 + 60 * min;
  return r;
}

describe("the rule: a message from someone else later than anything known", () => {
  test("a new message makes a chat To do; Done clears it; the same message seen again does not bring it back; a later one does", () => {
    const { store } = settled();
    store.see(inbound(T0 + min));
    expect(store.isTodo("c1")).toBe(true);
    store.setOwner("c1", false);
    expect(store.isTodo("c1")).toBe(false);
    store.see(inbound(T0 + min));
    expect(store.isTodo("c1")).toBe(false);
    expect(store.see(inbound(T0 + 2 * min)).changed).toBe(true);
    expect(store.isTodo("c1")).toBe(true);
  });
  test("the owner's messages neither set nor clear it", () => {
    const { store } = settled();
    expect(store.see(ownLast(T0 + min)).changed).toBe(false);
    expect(store.isTodo("c1")).toBe(false);
    store.see(inbound(T0 + 2 * min));
    expect(store.isTodo("c1")).toBe(true);
    store.see(ownLast(T0 + 3 * min));
    expect(store.isTodo("c1")).toBe(true);
    store.setOwner("c1", false);
    store.see(ownLast(T0 + 4 * min));
    expect(store.isTodo("c1")).toBe(false);
  });
  test("reading elsewhere changes nothing: the unread count going to 0 is not handling it", () => {
    const { store } = settled();
    store.see(inbound(T0 + min, { unreadCount: 3 }));
    store.see(inbound(T0 + min, { unreadCount: 0, isMarkedUnread: false }));
    expect(store.isTodo("c1")).toBe(true);
  });
  test("an unread count alone (or marked unread) brings nothing back: only a message does", () => {
    const { store } = settled();
    store.see(inbound(T0 + min, { unreadCount: 2 }));
    store.setOwner("c1", false);
    store.see(inbound(T0 + min, { unreadCount: 2, isMarkedUnread: true }));
    expect(store.isTodo("c1")).toBe(false);
  });
  test("reactions and hidden tapbacks are no messages; a notice from someone else is their message", () => {
    const { store } = settled();
    expect(othersFact(chat({ preview: msg("r", T0, { type: "REACTION" }) }))).toEqual({ at: null, exact: false });
    expect(othersFact(chat({ preview: msg("n", T0, { type: "NOTICE" }) }))).toEqual({ at: T0, id: "n", exact: true });
    const hidden = msg("h", T0 + min);
    noteHiddenPreview(hidden);
    expect(store.see(chat({ lastActivity: iso(T0 + min), preview: hidden })).changed).toBe(false);
    expect(store.isTodo("c1")).toBe(false);
  });
  test("from Beeper's own shapes: a hidden preview and a hidden or reacting entry in an event are no one writing; a notice is", () => {
    const raw = { id: "c9", accountID: "a", network: "iMessage", title: "x", type: "single", unreadCount: 0, lastActivity: iso(T0), preview: { id: "t1", chatID: "c9", accountID: "a", senderID: "them", timestamp: iso(T0), sortKey: "1", isSender: false, isHidden: true, text: "{{sender}} liked" } };
    expect(othersFact(mapChat(raw)!)).toEqual({ at: null, exact: false });
    expect(othersFact(mapChat({ ...raw, preview: { ...raw.preview, isHidden: false } })!).at).toBe(T0);
    const now = iso(T0 + min);
    const entry = (o: object) => ({ isSender: false, timestamp: iso(T0), type: "TEXT", ...o });
    expect(othersAtOf([entry({ type: "NOTICE" })], now)).toBe(iso(T0));
    expect(othersAtOf([entry({ isHidden: true })], now)).toBeNull();
    expect(othersAtOf([entry({ type: "REACTION" })], now)).toBeNull();
    expect(othersAtOf([entry({})], now)).toBe(iso(T0));
    expect(othersAtOf([entry({ type: "NOTICE" }), entry({})], now)).toBe(iso(T0));
  });
  test("what is older than the first run does not count: a chat nobody wrote in since needs no entry at all", () => {
    const { store } = settled();
    store.see(inbound(T0 - 5 * min, { id: "old" }));
    expect(store.isTodo("old")).toBe(false);
    expect(store.size).toBe(0);
  });
  test("a backfill of old history brings nothing back", () => {
    const { store } = settled();
    store.see(inbound(T0 + min));
    store.setOwner("c1", false);
    expect(store.noteOthers("c1", T0 - 100 * min)).toBe(false);
    expect(store.noteOthers("c1", T0 + min)).toBe(false);
    expect(store.isTodo("c1")).toBe(false);
  });
  test("a clock in the future does not poison what comes next, and the same message does not come back", () => {
    const { store, clock } = settled();
    const future = T0 + 100 * 24 * 60 * min;
    store.see(inbound(future));
    expect(store.isTodo("c1")).toBe(true);
    store.setOwner("c1", false);
    clock.now += 5 * min;
    store.see(inbound(future));
    expect(store.isTodo("c1")).toBe(false);
    clock.now += min;
    store.see(chat({ lastActivity: iso(clock.now), preview: msg("next", clock.now - 1000) }));
    expect(store.isTodo("c1")).toBe(true);
  });
  test("an event's time, then the list's time for the same message: not new again", () => {
    const { store } = settled();
    expect(store.noteOthers("c1", T0 + min)).toBe(true);
    store.setOwner("c1", false);
    store.see(inbound(T0 + min));
    expect(store.isTodo("c1")).toBe(false);
  });
  test("a chat whose newest message is the owner's, active since: read it (once per change), and what it shows counts", () => {
    const { store } = settled();
    expect(store.see(ownLast(T0 + 2 * min)).needsRead).toBe(true);
    expect(store.seeRead(ownLast(T0 + 2 * min), [msg("in", T0 + min), msg("me", T0 + 2 * min, { isSender: true })]).changed).toBe(true);
    expect(store.isTodo("c1")).toBe(true);
    expect(store.see(ownLast(T0 + 2 * min)).needsRead).toBe(false);
    expect(store.see(ownLast(T0 + 3 * min)).needsRead).toBe(true);
  });
  test("a read that shows only the owner's messages accounts for the activity: no read on every list", () => {
    const { store } = settled();
    store.seeRead(ownLast(T0 + 2 * min), [msg("me", T0 + 2 * min, { isSender: true })]);
    expect(store.isTodo("c1")).toBe(false);
    expect(store.see(ownLast(T0 + 2 * min)).needsRead).toBe(false);
  });
});

describe("the scope is the Unread tab's", () => {
  test("archived, low priority: stored, but not To do while there; back in the inbox with nobody having handled it, it is", () => {
    const { store } = settled();
    store.see(inbound(T0 + min, { isLowPriority: true }));
    expect(store.effective(inbound(T0 + min, { isLowPriority: true }))).toBe(false);
    expect(store.known("c1")).toBe(false);
    expect(store.effective(inbound(T0 + min))).toBe(true);
    store.see(inbound(T0 + 2 * min, { isArchived: true }));
    expect(store.effective(inbound(T0 + 2 * min, { isArchived: true }))).toBe(false);
    expect(store.count("beeper")).toBe(0);
    store.see(inbound(T0 + 2 * min));
    expect(store.count("beeper")).toBe(1);
  });
  test("the count leaves noise out", () => {
    const { store } = settled();
    store.see(inbound(T0 + min));
    expect(store.count("beeper", () => true)).toBe(0);
    expect(store.count("beeper", () => false)).toBe(1);
  });
  test("a single Gmail thread's tab is a hint: it can say low priority, and only a list can say otherwise", () => {
    const { store, clock } = settled();
    const id = gmailChatID(OWNER_EMAIL, "t1");
    store.meet(sourceOf(id));
    store.finishFirstRun(sourceOf(id));
    clock.now += min;
    const c = (o: Partial<ChatSummary>) => chat({ id, lastActivity: iso(clock.now), ...o });
    expect(store.noteOthers(id, clock.now, { low: true })).toBe(true);
    expect(store.known(id)).toBe(false);
    store.see(c({ isLowPriority: false }), { at: null, exact: true }, { exactScope: false });
    expect(store.known(id)).toBe(false);
    store.see(c({ isLowPriority: false }), { at: null, exact: true }, { exactScope: true });
    expect(store.known(id)).toBe(true);
  });
});

describe("first run", () => {
  test("while it is not done, a chat seen for the first time is To do if it is unread now in the main inbox, whatever list sees it", () => {
    const { store } = makeStore();
    store.meet("beeper");
    store.see(chat({ id: "u", unreadCount: 2, lastActivity: iso(T0 - 9 * min) }));
    store.see(chat({ id: "m", isMarkedUnread: true, lastActivity: iso(T0 - 9 * min) }));
    store.see(chat({ id: "r", lastActivity: iso(T0 - 9 * min) }));
    store.see(chat({ id: "a", unreadCount: 2, isArchived: true, lastActivity: iso(T0 - 9 * min) }));
    store.see(chat({ id: "l", unreadCount: 2, isLowPriority: true, lastActivity: iso(T0 - 9 * min) }));
    expect(["u", "m", "r", "a", "l"].map((id) => store.isTodo(id))).toEqual([true, true, false, false, false]);
  });
  test("once done, unread old chats are not looked at again", () => {
    const { store } = settled();
    store.see(chat({ id: "u", unreadCount: 2, lastActivity: iso(T0 - 9 * min) }));
    expect(store.isTodo("u")).toBe(false);
  });
  test("what the owner did during it stands: Done before the walk reaches a chat", () => {
    const { store } = makeStore();
    store.meet("beeper");
    store.setOwner("c1", false);
    store.see(chat({ unreadCount: 3, lastActivity: iso(T0 - min) }));
    expect(store.isTodo("c1")).toBe(false);
    expect(store.markUnreadAtFirstRun("c1")).toBe(false);
    expect(store.isTodo("c1")).toBe(false);
  });
  test("a thread found by id alone (Gmail) knows no time, and stays To do when its time comes", () => {
    const { store } = makeStore();
    const id = gmailChatID(OWNER_EMAIL, "t1");
    store.meet(sourceOf(id));
    expect(store.markUnreadAtFirstRun(id)).toBe(true);
    store.see(chat({ id, lastActivity: iso(T0 - min) }), { at: T0 - min, exact: true });
    expect(store.isTodo(id)).toBe(true);
    store.setOwner(id, false);
    store.see(chat({ id, lastActivity: iso(T0 - min) }), { at: T0 - min, exact: true });
    expect(store.isTodo(id)).toBe(false);
  });
  test("each Gmail account has its own: an account added later does not make its past week To do", () => {
    const { store, clock } = settled();
    const id = gmailChatID(OWNER_EMAIL, "t1");
    clock.now = T0 + 7 * 24 * 60 * min;
    store.meet(sourceOf(id));
    store.finishFirstRun(sourceOf(id));
    store.see(chat({ id, lastActivity: iso(T0 + 3 * 24 * 60 * min) }), { at: T0 + 3 * 24 * 60 * min, exact: true });
    expect(store.isTodo(id)).toBe(false);
  });
});

describe("kept on disk", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "jinbox-todo-")), "data", "todo.json");
  test("survives a restart, 0600, written at once for the owner's hand", () => {
    const path = tmp();
    const { store } = settled({ path });
    store.see(inbound(T0 + min));
    store.setOwner("other", true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new TodoStore({ path, now: () => T0 + 120 * min });
    expect(again.isTodo("other")).toBe(true);
    expect(again.isTodo("c1")).toBe(true);
    expect(again.meet("beeper")).toMatchObject({ since: T0, done: true });
    again.setOwner("c1", false);
    const third = new TodoStore({ path, now: () => T0 + 120 * min });
    expect(third.isTodo("c1")).toBe(false);
    third.see(inbound(T0 + min));
    expect(third.isTodo("c1")).toBe(false);
  });
  test("observations wait a moment and go together; flush writes them", () => {
    const path = tmp();
    const { store } = settled({ path });
    store.setOwner("x", true);
    store.see(inbound(T0 + min));
    expect(new TodoStore({ path }).isTodo("c1")).toBe(false);
    store.flush();
    expect(new TodoStore({ path }).isTodo("c1")).toBe(true);
  });
  test("an owner's change that cannot be written is refused and changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "jinbox-todo-"));
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    const store = new TodoStore({ path: join(blocker, "todo.json"), now: () => T0 });
    store.meet("beeper");
    expect(() => store.setOwner("c1", true)).toThrow();
    expect(store.isTodo("c1")).toBe(false);
    expect(store.entry("c1")).toBeUndefined();
  });
  test("garbage: an unreadable file starts over, bad entries are dropped one by one", () => {
    const path = tmp();
    const { store } = settled({ path });
    store.setOwner("good", true);
    for (const bad of ["not json", "null", "[]", '{"v":2,"sources":[],"entries":[]}', '{"v":1}']) {
      writeFileSync(path, bad);
      const s = new TodoStore({ path, now: () => T0 });
      expect(s.size).toBe(0);
      expect(s.meet("beeper").done).toBe(false);
    }
    writeFileSync(path, JSON.stringify({ v: 1, sources: [["beeper", { since: T0, done: true, synced: T0 }], ["x", null], [1, {}]], entries: [{ chatID: "good", todo: true, others: 0, activity: 0, at: 1 }, { chatID: "a b", todo: true, others: 0, activity: 0, at: 1 }, { chatID: "n", todo: "yes", others: 0, activity: 0, at: 1 }, { chatID: "t", todo: true, others: -1, activity: 0, at: 1 }, null, 7] }));
    const s = new TodoStore({ path, now: () => T0 });
    expect(s.size).toBe(1);
    expect(s.isTodo("good")).toBe(true);
    expect(s.meet("beeper").done).toBe(true);
  });
  test("hostile chat ids are ids: nothing is polluted, and they come back as they went in", () => {
    const path = tmp();
    const { store } = settled({ path });
    const ids = ["__proto__", "constructor", "toString", "!a:b#c/d?e", "gmail:__proto__", "gmail:x:y:z", "imsg##thread:+1", "<script>alert(1)</script>", "../../etc/passwd"];
    for (const id of ids) store.setOwner(id, true);
    const again = new TodoStore({ path, now: () => T0 });
    for (const id of ids) expect(again.isTodo(id)).toBe(true);
    expect(({} as Record<string, unknown>).todo).toBeUndefined();
    expect(again.isTodo("hasOwnProperty")).toBe(false);
    again.setOwner("__proto__", false);
    expect(again.isTodo("__proto__")).toBe(false);
  });
  test("bounded: handled chats go first, then what is out of the inbox; the source's time moves up past what was looked at, so a forgotten chat does not come back", () => {
    const { store, clock } = settled({ max: 3 });
    store.markSynced("beeper", T0 + 10 * min);
    store.see(inbound(T0 + min, { id: "a" }));
    store.setOwner("a", false);
    store.see(inbound(T0 + 2 * min, { id: "b", isArchived: true }));
    store.see(inbound(T0 + 3 * min, { id: "c" }));
    clock.now += min;
    store.see(inbound(T0 + 4 * min, { id: "d" }));
    expect(store.size).toBe(3);
    expect(store.entry("a")).toBeUndefined();
    store.see(inbound(T0 + min, { id: "a" }));
    expect(store.isTodo("a")).toBe(false);
    store.see(inbound(T0 + 5 * min, { id: "e" }));
    expect(store.entry("b")).toBeUndefined();
    expect(["c", "d", "e"].map((id) => store.isTodo(id))).toEqual([true, true, true]);
    expect(MAX_TODO_ENTRIES).toBe(5000);
  });
  test("a first run past the bound keeps the newest it met, not the oldest", () => {
    const { store } = makeStore({ max: 2 });
    store.meet("beeper");
    for (const id of ["new1", "new2", "old1"]) store.see(chat({ id, unreadCount: 1, lastActivity: iso(T0 - min) }));
    expect(["new1", "new2", "old1"].map((id) => store.isTodo(id))).toEqual([true, true, false]);
    expect(store.markUnreadAtFirstRun("old2")).toBe(false);
    expect(store.size).toBe(2);
  });
  test("forgetting a Gmail account forgets its chats and its first run", () => {
    const { store } = settled();
    const id = gmailChatID(OWNER_EMAIL, "t1");
    store.meet(sourceOf(id));
    store.finishFirstRun(sourceOf(id));
    store.setOwner(id, true);
    store.setOwner("c1", true);
    store.forgetSource(sourceOf(id));
    expect(store.isTodo(id)).toBe(false);
    expect(store.isTodo("c1")).toBe(true);
    expect(store.meet(sourceOf(id)).done).toBe(false);
  });
});

describe("events kept while the link is down", () => {
  test("the last word on To do survives merging", () => {
    const b = new EventBuffer();
    const base = { type: "event", kind: "chat", op: "upserted", chatID: "c1", ts: iso(T0) } as const;
    b.add({ ...base, todo: true });
    b.add({ ...base, unreadCount: 2 });
    const sent: any[] = [];
    b.flush((f) => (sent.push(f), true));
    expect(sent[0].todo).toBe(true);
    b.add({ ...base, todo: true });
    b.add({ ...base, todo: false });
    b.flush((f) => (sent.push(f), true));
    expect(sent[1].todo).toBe(false);
  });
});

describe("the tracker with fake sources", () => {
  const page = (n: number) => ({ items: Array.from({ length: 50 }, (_, i) => chat({ id: `p${n}_${i}`, unreadCount: i === 0 ? 1 : 0, lastActivity: iso(T0 - (n * 100 + i) * 1000) })), next: n < 2 ? `c${n + 1}` : null });
  test("first run walks every page, resumes from the top after a restart, then never again", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "jinbox-todo-")), "todo.json");
    let fail = 1;
    const calls: (string | null)[] = [];
    const beeperPage = async (c: string | null) => {
      calls.push(c);
      if (c === "c1" && fail-- > 0) throw new Error("down");
      return page(c === null ? 0 : Number(c.slice(1)));
    };
    const a = new TodoTracker({ store: new TodoStore({ path, now: () => T0 }), beeperPage, now: () => T0, pauseMs: { beeper: 0 } });
    a.start();
    await a.sync();
    expect(a.store.meet("beeper").done).toBe(false);
    expect(a.store.isTodo("p0_0")).toBe(true);
    a.stop();
    const b = new TodoTracker({ store: new TodoStore({ path, now: () => T0 }), beeperPage, now: () => T0, pauseMs: { beeper: 0 } });
    await b.sync();
    expect(b.store.meet("beeper").done).toBe(true);
    expect(["p0_0", "p1_0", "p2_0", "p0_1"].map((id) => b.store.isTodo(id))).toEqual([true, true, true, false]);
    b.stop();
    calls.length = 0;
    const c = new TodoTracker({ store: new TodoStore({ path, now: () => T0 + 500_000 }), beeperPage, now: () => T0 + 500_000 });
    await c.sync();
    // Catching up: only as far as what is new (a margin for clocks), not through every page. And what was read since is not To do again.
    expect(calls).toEqual([null, "c1"]);
    c.stop();
  });
  test("a first run tells open pages a little per page, not once per chat", async () => {
    const told: string[] = [];
    const items = Array.from({ length: 30 }, (_, i) => chat({ id: `u${i}`, unreadCount: 1, lastActivity: iso(T0 - i) }));
    const t = new TodoTracker({ store: new TodoStore({ now: () => T0 }), beeperPage: async () => ({ items, next: null }), onChange: (id) => told.push(id), now: () => T0 });
    await t.sync();
    expect(t.store.count("beeper")).toBe(30);
    expect(told.length).toBe(3);
    t.stop();
  });
  test("noise at first run is not To do", async () => {
    const t = new TodoTracker({ store: new TodoStore({ now: () => T0 }), noise: { active: () => true, isNoise: (id) => id === "n" }, beeperPage: async () => ({ items: [chat({ id: "n", unreadCount: 1 }), chat({ id: "k", unreadCount: 1 })], next: null }), now: () => T0 });
    await t.sync();
    expect([t.store.isTodo("n"), t.store.isTodo("k")]).toEqual([false, true]);
    t.stop();
  });
  test("a Gmail first run lists ids only, a page at a time; the second run asks nothing of the kind", async () => {
    const asked: (string | null)[] = [];
    const gmail = { email: OWNER_EMAIL, threadIDs: async (_q: string, tok: string | null) => (asked.push(tok), tok === null ? { ids: ["a", "b"], next: "n" } : { ids: ["c"], next: null }), primaryPage: async () => ({ items: [], next: null }) };
    const t = new TodoTracker({ store: new TodoStore({ now: () => T0 }), gmail: () => [gmail], now: () => T0, pauseMs: { gmail: 0 } });
    await t.sync();
    expect(asked).toEqual([null, "n"]);
    expect(["a", "b", "c"].map((x) => t.store.isTodo(gmailChatID(OWNER_EMAIL, x)))).toEqual([true, true, true]);
    asked.length = 0;
    await t.sync();
    expect(asked).toEqual([]);
    t.stop();
  });
  test("new mail: one look at the Primary tab decides whether it counts", async () => {
    const asked: string[] = [];
    const gmail = { email: OWNER_EMAIL, threadIDs: async (q: string) => (asked.push(q), { ids: ["inbox1"], next: null }), primaryPage: async () => ({ items: [], next: null }) };
    const clock = { now: T0 };
    const store = new TodoStore({ now: () => clock.now });
    const key = sourceOf(gmailChatID(OWNER_EMAIL, "x"));
    store.meet(key);
    store.finishFirstRun(key);
    clock.now = T0 + 10_000;
    const t = new TodoTracker({ store, gmail: () => [gmail], now: () => clock.now });
    const e = (id: string): EventFrame => ({ type: "event", kind: "message", op: "upserted", chatID: gmailChatID(OWNER_EMAIL, id), messageIDs: ["m"], ts: iso(T0 + 5000), othersAt: iso(T0 + 5000) });
    t.event(e("inbox1"));
    t.event(e("updates1"));
    for (let i = 0; i < 50 && !store.isTodo(gmailChatID(OWNER_EMAIL, "updates1")); i++) await Bun.sleep(5);
    expect(asked.length).toBe(1);
    expect(store.known(gmailChatID(OWNER_EMAIL, "inbox1"))).toBe(true);
    expect(store.known(gmailChatID(OWNER_EMAIL, "updates1"))).toBe(false);
    t.stop();
  });
  test("an event that does not say who wrote: the chat is read, and a chat gone is forgotten only when that repeats", async () => {
    const clock = { now: T0 };
    const store = new TodoStore({ now: () => clock.now });
    store.meet("beeper");
    clock.now = T0 + 10 * min;
    store.setOwner("gone", true);
    const t = new TodoTracker({
      store,
      now: () => clock.now,
      readChat: async (p) => (p.chatID === "gone" ? { ok: false, error: { code: "NOT_FOUND", message: "x" } } : { ok: true, data: { chat: chat({ id: p.chatID, lastActivity: iso(T0 + 5 * min) }), items: [msg("x", T0 + 5 * min)], hasMore: false, nextCursor: null } }),
    });
    t.event({ type: "event", kind: "message", op: "upserted", chatID: "c1", messageIDs: ["m"], ts: iso(T0) });
    t.event({ type: "event", kind: "message", op: "upserted", chatID: "gone", messageIDs: ["m"], ts: iso(T0) });
    for (let i = 0; i < 50 && !(store.isTodo("c1") && store.entry("gone")?.gone); i++) await Bun.sleep(5);
    expect(store.isTodo("c1")).toBe(true);
    expect(store.isTodo("gone")).toBe(true);
    clock.now += 30 * min;
    await t.sync();
    for (let i = 0; i < 50 && store.entry("gone"); i++) await Bun.sleep(5);
    expect(store.entry("gone")).toBeUndefined();
    t.event({ type: "event", kind: "chat", op: "deleted", chatID: "c1", ts: iso(T0) });
    expect(store.known("c1")).toBe(false);
    expect(store.count("beeper")).toBe(0);
    t.stop();
  });
});

// ---------------------------------------------------------------------------------------------
// The whole service.

const TOKEN = "jid_" + "T".repeat(43);
let fb: FakeBeeper;
let fg: RunningFakeGoogle;
beforeAll(async () => {
  fb = await startFakeBeeper();
  fg = await startFakeGoogle();
});
afterAll(() => {
  fb.stop();
  fg.stop();
});
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  fb.reset();
  fg.google.reset();
});

type Booted = { cloud: FakeCloud; svc: Service; paths: ReturnType<typeof resolvePaths>; secrets: FileSecretStore; again: () => Promise<Service> };
async function boot(): Promise<Booted> {
  const cloud = await startFakeCloud({ token: TOKEN, google: { url: fg.url, clientId: FAKE_GOOGLE_CLIENT.id, clientSecret: FAKE_GOOGLE_CLIENT.secret } });
  cleanup.push(() => cloud.stop());
  const paths = resolvePaths({ HOME: "/nonexistent", J_INBOX_CONFIG_DIR: mkdtempSync(join(tmpdir(), "jinbox-tsvc-")) });
  saveConfig(paths, { cloudURL: cloud.url, beeperURL: fb.url, deviceID: "dev_todo", deviceName: "Test Mac" });
  const secrets = new FileSecretStore(paths.secretsFile);
  await secrets.set("beeper-token", fb.token);
  await secrets.set("device-token", TOKEN);
  const env = { J_INBOX_GMAIL_API_URL: fg.url, J_INBOX_GOOGLE_OAUTH_URL: fg.url };
  const start = async () => {
    const svc = await startService({ paths, secrets, version: "0.1.0", healthIntervalMs: 60_000, backoff: () => 30, env, gmailPollIntervalMs: 100, log: () => {} });
    cleanup.push(() => svc.stop(0));
    await cloud.waitFor(() => svc.link?.state.status === "connected", 4000, "connected");
    return svc;
  };
  const svc = await start();
  return { cloud, svc, paths, secrets, again: start };
}
/** The first run over, Beeper's socket up. */
async function settledService(b: Booted) {
  await b.cloud.waitFor(() => fb.wsClientCount() === 1, 3000, "beeper ws");
  await waitTodo(b, CHAT_IDS.pinnedUnread, true);
  await Bun.sleep(50);
}
const todoIDs = async (cloud: FakeCloud, extra: Record<string, unknown> = {}) => {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const r = await cloud.req("list_chats", { todo: true, limit: 50, ...extra, ...(cursor ? { cursor } : {}) });
    expect(r.res.ok).toBe(true);
    const d = r.res.data as any;
    out.push(...d.items.map((c: any) => c.id));
    cursor = d.nextCursor;
    if (!d.hasMore || !cursor) break;
  }
  return out;
};
async function waitTodo(b: Booted, id: string, want: boolean) {
  for (let i = 0; i < 200; i++) {
    if ((await todoIDs(b.cloud)).includes(id) === want) return;
    await Bun.sleep(20);
  }
  throw new Error(`${id} never became todo=${want}`);
}
const flagOf = async (cloud: FakeCloud, id: string) => ((await cloud.req("read_chat", { chatID: id, limit: 1 })).res.data as any).chat.todo;
const networkReadWrites = () => fb.writes().filter((w) => /\/(read|unread)$/.test(w.route));

describe("To do in the service", () => {
  test("the hello says todo.v1; every chat carries the flag; first run: what was unread in the main inbox is To do, nothing else", async () => {
    const b = await boot();
    expect((b.cloud.hello() as any).capabilities).toContain("todo.v1");
    await settledService(b);
    const unreadOnes = ((await b.cloud.req("list_chats", { inbox: "primary", unreadOnly: true, limit: 50 })).res.data as any).items.map((c: any) => c.id).sort();
    expect((await todoIDs(b.cloud)).sort()).toEqual(unreadOnes);
    const all = ((await b.cloud.req("list_chats", { inbox: "primary", limit: 50 })).res.data as any).items;
    for (const c of all) expect(c.todo).toBe(unreadOnes.includes(c.id));
    expect(statSync(b.paths.todoFile).mode & 0o777).toBe(0o600);
    // The cloud hears one bit; the file holds ids and times, no names or text.
    await b.svc.stop(500);
    const text = readFileSync(b.paths.todoFile, "utf8");
    for (const s of ["Alice Chen", "New incoming", "Mom"]) expect(text).not.toContain(s);
    expect(networkReadWrites()).toEqual([]);
  });

  test("Done, a reply, a read on the phone and a new message: the whole story, with no read state changed by it", async () => {
    const b = await boot();
    await settledService(b);
    const id = CHAT_IDS.pinnedUnread;
    // Opening it does not clear it.
    expect(await flagOf(b.cloud, id)).toBe(true);
    // A reply does not clear it (the owner's own send, as the event says).
    expect((await b.cloud.req("send_message", { chatID: id, text: "on my way", idempotencyKey: "todo_key_0001" })).res.ok).toBe(true);
    await Bun.sleep(300);
    expect(await flagOf(b.cloud, id)).toBe(true);
    // Read on the phone: Beeper's own state, not this one.
    const chat = fb.state.chats.get(id)!;
    chat.unreadCount = 0;
    fb.state.emitChat(chat);
    await Bun.sleep(100);
    expect(await flagOf(b.cloud, id)).toBe(true);
    // Done: gone from the list, on disk, and every tab hears of it.
    expect((await b.cloud.req("set_todo", { chatID: id, todo: false })).res).toMatchObject({ ok: true, data: { chatID: id, todo: false } });
    expect(await flagOf(b.cloud, id)).toBe(false);
    expect(await todoIDs(b.cloud)).not.toContain(id);
    await b.cloud.waitFor(() => b.cloud.events().some((e: any) => e.kind === "chat" && e.chatID === id && e.todo === false), 2000, "Done reaches the other tabs");
    // Idempotent.
    expect((await b.cloud.req("set_todo", { chatID: id, todo: false })).res.ok).toBe(true);
    // A send after Done does not bring it back.
    expect((await b.cloud.req("send_message", { chatID: id, text: "one more", idempotencyKey: "todo_key_0002" })).res.ok).toBe(true);
    await Bun.sleep(300);
    expect(await flagOf(b.cloud, id)).toBe(false);
    // Someone writes: back, at once, with the bit on the event.
    fb.state.receive(id, { text: "PRIVATE thanks" });
    await waitTodo(b, id, true);
    await b.cloud.waitFor(() => b.cloud.events().some((e: any) => e.kind === "chat" && e.chatID === id && e.todo === true), 2000, "the bit");
    expect(JSON.stringify(b.cloud.events())).not.toContain("PRIVATE");
    // Put back by hand, and Done again.
    expect((await b.cloud.req("set_todo", { chatID: id, todo: false })).res.ok).toBe(true);
    expect((await b.cloud.req("set_todo", { chatID: id, todo: true })).res.ok).toBe(true);
    expect(await flagOf(b.cloud, id)).toBe(true);
    // Not one of these touched the network's read state, and no unread was ever called.
    expect(networkReadWrites()).toEqual([]);
    expect(fb.writes().filter((w) => w.route.includes("archive"))).toEqual([]);
  });

  test("restart with changes while it was down: someone's message counts, also with the owner's reply after it, Done stays done, first run does not run again", async () => {
    const b = await boot();
    await settledService(b);
    const done = CHAT_IDS.pinnedUnread;
    const repliedOnPhone = CHAT_IDS.longHistory;
    const quiet = CHAT_IDS.muted;
    for (const id of [done, repliedOnPhone, quiet]) expect((await b.cloud.req("set_todo", { chatID: id, todo: false })).res.ok).toBe(true);
    await b.svc.stop(500);
    await fb.pause();
    await fb.resume();
    await Bun.sleep(5);
    fb.state.receive(done, { text: "while down" });
    const chat = fb.state.chats.get(repliedOnPhone)!;
    fb.state.receive(repliedOnPhone, { text: "while down" });
    await Bun.sleep(5);
    fb.state.sendOwn(chat, "replied on my phone", undefined, 0);
    const svc2 = await b.again();
    await waitTodo(b, done, true);
    await waitTodo(b, repliedOnPhone, true);
    expect(await flagOf(b.cloud, quiet)).toBe(false);
    await svc2.stop(500);
    const after = await b.again();
    await Bun.sleep(150);
    expect(await flagOf(b.cloud, quiet)).toBe(false);
    expect(after).toBeDefined();
  });

  test("agents and the owner see the same flag; set_todo needs no network; a chat that does not exist is only a harmless entry; a hostile id is refused or kept as an id", async () => {
    const b = await boot();
    await settledService(b);
    await fb.pause();
    try {
      // Beeper down: the owner's state is not Beeper's.
      expect((await b.cloud.req("set_todo", { chatID: CHAT_IDS.pinnedUnread, todo: false })).res.ok).toBe(true);
    } finally {
      await fb.resume();
    }
    for (const chatID of ["__proto__", "constructor", "!a:b#c/d?e", "gmail:nobody@example.com:abc"]) expect((await b.cloud.req("set_todo", { chatID, todo: true })).res.ok).toBe(true);
    expect((await b.cloud.req("set_todo", { chatID: "a b", todo: true })).res.error?.code).toBe("BAD_PARAMS");
    const ids = await todoIDs(b.cloud);
    expect(ids).not.toContain("__proto__");
    expect(({} as any).todo).toBeUndefined();
  });

  test("low priority and noise chats are not To do; marking noise is the owner's hand and clears it for good", async () => {
    const b = await boot();
    await settledService(b);
    const id = CHAT_IDS.pinnedUnread;
    const chat = fb.state.chats.get(id)!;
    chat.isLowPriority = true;
    expect(await todoIDs(b.cloud)).not.toContain(id);
    expect(await flagOf(b.cloud, id)).toBe(false);
    chat.isLowPriority = false;
    expect(await flagOf(b.cloud, id)).toBe(true);
    expect((await b.cloud.req("set_noise_definition", { definition: "Newsletters" })).res.ok).toBe(true);
    expect((await b.cloud.req("set_noise", { chatID: id, noise: true })).res.ok).toBe(true);
    expect(await todoIDs(b.cloud)).not.toContain(id);
    expect((await b.cloud.req("set_noise", { chatID: id, noise: false })).res.ok).toBe(true);
    // Not noise: back in the inbox, and handled until someone writes.
    expect(await flagOf(b.cloud, id)).toBe(false);
    expect(await todoIDs(b.cloud)).not.toContain(id);
  });

  test("the count behind the badge: unread_summary {todo} says how many, unread or not, while plain unread_summary is what it was", async () => {
    const b = await boot();
    await settledService(b);
    const before = (await b.cloud.req("unread_summary", { limit: 1 })).res.data as any;
    const todo = (await b.cloud.req("unread_summary", { limit: 1, todo: true })).res.data as any;
    expect(todo.totalUnreadChats).toBe(before.totalUnreadChats);
    const id = CHAT_IDS.pinnedUnread;
    const chat = fb.state.chats.get(id)!;
    chat.unreadCount = 0;
    const after = (await b.cloud.req("unread_summary", { limit: 1 })).res.data as any;
    expect(after.totalUnreadChats).toBe(before.totalUnreadChats - 1);
    expect(((await b.cloud.req("unread_summary", { limit: 1, todo: true })).res.data as any).totalUnreadChats).toBe(todo.totalUnreadChats);
    await b.cloud.req("set_todo", { chatID: id, todo: false });
    expect(((await b.cloud.req("unread_summary", { limit: 1, todo: true })).res.data as any).totalUnreadChats).toBe(todo.totalUnreadChats - 1);
  });
});

describe("To do with Gmail in the service", () => {
  async function withGmail() {
    const b = await boot();
    const rt = fg.google.issueRefreshToken(OWNER_EMAIL);
    expect((await b.cloud.req("gmail_connect", { email: OWNER_EMAIL, refreshToken: rt })).res.ok).toBe(true);
    const lunch = gmailChatID(OWNER_EMAIL, THREADS.lunch);
    await settledService(b);
    await waitTodo(b, lunch, true);
    return { ...b, lunch };
  }

  test("first run reads no thread: only threads.list; the merged list pages like Unread; Gmail's other tabs stay out", async () => {
    fg.google.requests.length = 0;
    const b = await boot();
    const before = fg.google.requests.length;
    const rt = fg.google.issueRefreshToken(OWNER_EMAIL);
    expect((await b.cloud.req("gmail_connect", { email: OWNER_EMAIL, refreshToken: rt })).res.ok).toBe(true);
    await waitTodo(b, gmailChatID(OWNER_EMAIL, THREADS.lunch), true);
    const ids = await todoIDs(b.cloud);
    // Only the threads the To do list itself is after: none of the handled ones cost a read.
    const reads = fg.google.requests.slice(before).filter((r) => /\/threads\/[^/]+$/.test(r.path)).map((r) => gmailChatID(OWNER_EMAIL, r.path.split("/").at(-1)!.split("?")[0]!));
    for (const id of reads) expect(ids).toContain(id);
    expect(ids).toContain(CHAT_IDS.pinnedUnread);
    expect(ids).toContain(gmailChatID(OWNER_EMAIL, THREADS.lunch));
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of [THREADS.promo, THREADS.social, THREADS.archived]) expect(ids).not.toContain(gmailChatID(OWNER_EMAIL, t));
    // A page of one at a time: every row once.
    const paged: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 80; i++) {
      const r = (await b.cloud.req("list_chats", { todo: true, limit: 1, ...(cursor ? { cursor } : {}) })).res.data as any;
      paged.push(...r.items.map((c: any) => c.id));
      cursor = r.nextCursor;
      if (!r.hasMore || !cursor) break;
    }
    expect(paged.sort()).toEqual([...ids].sort());
    expect(((await b.cloud.req("unread_summary", { limit: 1, todo: true })).res.data as any).totalUnreadChats).toBe(ids.length);
  }, 30_000);

  test("a Done thread comes back with new mail, not with the owner's reply; a promotion stays out", async () => {
    const b = await withGmail();
    expect((await b.cloud.req("set_todo", { chatID: b.lunch, todo: false })).res.ok).toBe(true);
    expect(await todoIDs(b.cloud)).not.toContain(b.lunch);
    expect((await b.cloud.req("send_message", { chatID: b.lunch, text: "SENT reply", idempotencyKey: "todo_key_0003" })).res.ok).toBe(true);
    await Bun.sleep(400);
    expect(await flagOf(b.cloud, b.lunch)).toBe(false);
    fg.google.deliver(OWNER_EMAIL, { threadId: THREADS.lunch, from: "Alice <alice@example.com>", subject: "Re: Lunch on Friday?", text: "PRIVATE-TEXT" });
    await waitTodo(b, b.lunch, true);
    await b.cloud.waitFor(() => b.cloud.events().some((e: any) => e.kind === "chat" && e.chatID === b.lunch && e.todo === true), 2000, "the bit");
    const promo = gmailChatID(OWNER_EMAIL, THREADS.promo);
    fg.google.deliver(OWNER_EMAIL, { threadId: THREADS.promo, from: "Shop <shop@example.com>", subject: "Sale", text: "buy", labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] });
    await Bun.sleep(400);
    expect(await todoIDs(b.cloud)).not.toContain(promo);
  }, 30_000);

  test("mail that came while it was down counts on the next start", async () => {
    const b = await withGmail();
    expect((await b.cloud.req("set_todo", { chatID: b.lunch, todo: false })).res.ok).toBe(true);
    await b.svc.stop(500);
    await Bun.sleep(5);
    fg.google.advance(1000);
    fg.google.deliver(OWNER_EMAIL, { threadId: THREADS.lunch, from: "Alice <alice@example.com>", subject: "Re: Lunch on Friday?", text: "while down" });
    await b.again();
    await waitTodo(b, b.lunch, true);
  }, 30_000);

  test("a removed account's To do goes with it", async () => {
    const b = await withGmail();
    expect((await b.cloud.req("remove_account", { accountID: `gmail:${OWNER_EMAIL}` })).res.ok).toBe(true);
    await b.svc.stop(500);
    expect(existsSync(b.paths.todoFile)).toBe(true);
    expect(readFileSync(b.paths.todoFile, "utf8")).not.toContain(OWNER_EMAIL);
  }, 30_000);
});
