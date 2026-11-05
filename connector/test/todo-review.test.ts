// What an independent review of To do found: each test here failed before its fix. The worst failure is the owner
// silently missing a message, so when a choice is close a chat wrongly in To do beats a chat wrongly missing.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { FAKE_GOOGLE_CLIENT, OWNER_EMAIL, THREADS, startFakeGoogle, type RunningFakeGoogle } from "@j-inbox/fake-google";
import { gmailChatID, type ActionResult, type ChatSummary, type MessageItem } from "@j-inbox/protocol";
import { createActions } from "../src/actions.ts";
import { mapBeeperEvent, othersAtOf } from "../src/beeper-ws.ts";
import { resolvePaths, saveConfig } from "../src/config.ts";
import { FileSecretStore } from "../src/secrets.ts";
import { startService, type Service } from "../src/service.ts";
import { TodoStore, othersFact } from "../src/todo/store.ts";
import { TodoTracker } from "../src/todo/tracker.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const T0 = Date.parse("2026-11-04T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const min = 60_000;
const msg = (id: string, at: number, o: Partial<MessageItem> = {}): MessageItem => ({ id, chatID: "c1", accountID: "a", senderID: "them", timestamp: iso(at), sortKey: String(at), type: "TEXT", isSender: false, ...o });
const chat = (o: Partial<ChatSummary> = {}): ChatSummary => ({ id: "c1", accountID: "a", network: "WhatsApp", title: "Chat", type: "single", unreadCount: 0, isPinned: false, isMuted: false, isArchived: false, lastActivity: iso(T0), ...o });
const inbound = (at: number, o: Partial<ChatSummary> = {}) => chat({ lastActivity: iso(at), preview: msg(`m${at}`, at), ...o });
const ownLast = (at: number, o: Partial<ChatSummary> = {}) => chat({ lastActivity: iso(at), preview: msg(`m${at}`, at, { isSender: true }), ...o });
function settled(o: { path?: string; max?: number; log?: (m: string) => void } = {}) {
  const clock = { now: T0 };
  const store = new TodoStore({ now: () => clock.now, ...o });
  store.meet("beeper");
  store.finishFirstRun("beeper");
  clock.now = T0 + 60 * min;
  return { store, clock };
}
const EMAIL = "owner@example.com";
const GKEY = `gmail:${EMAIL}`;
const message = (ids: string[], at: number, now: number, o: Record<string, unknown> = {}) => mapBeeperEvent({ type: "message.upserted", chatID: "c1", ids, entries: ids.map((id) => ({ id, isSender: false, timestamp: iso(at), type: "TEXT", ...o })) }, { beeperVersion: null, now: iso(now) })[0]!;

describe("the store's bound (finding 4)", () => {
  test("a store full of handled chats makes room: a new Gmail account's first run marks every unread thread, and only then is done", async () => {
    const { store, clock } = settled({ max: 50 });
    for (let i = 0; i < 50; i++) {
      const id = `h${i}`;
      store.see(inbound(T0 + min + i, { id }));
      store.setOwner(id, false);
    }
    const unread = Array.from({ length: 10 }, (_, i) => `gt${i}`);
    const gmail = { email: EMAIL, threadIDs: async () => ({ ids: unread, next: null }), primaryPage: async () => ({ items: [], next: null }) };
    const t = new TodoTracker({ store, gmail: () => [gmail], now: () => clock.now, pauseMs: { gmail: 0 } });
    await t.sync();
    expect(unread.filter((id) => store.isTodo(gmailChatID(EMAIL, id))).length).toBe(10);
    expect(store.meet(GKEY).done).toBe(true);
    expect(store.size).toBe(50);
    expect(store.overflowed()).toBe(false);
    t.stop();
  });

  test("the same for Beeper's own first-run rule", () => {
    const clock = { now: T0 };
    const store = new TodoStore({ now: () => clock.now, max: 3 });
    store.meet(GKEY);
    store.finishFirstRun(GKEY);
    clock.now += 10;
    for (let i = 0; i < 3; i++) store.setOwner(gmailChatID(EMAIL, `h${i}`), false);
    store.meet("beeper");
    store.see(chat({ id: "b1", unreadCount: 3, lastActivity: iso(T0 - min) }));
    expect(store.isTodo("b1")).toBe(true);
  });

  test("a first run that could not read its page is not done", async () => {
    const { store, clock } = settled({ max: 50 });
    let tries = 0;
    const gmail = { email: EMAIL, threadIDs: async () => { if (++tries === 1) throw new Error("down"); return { ids: ["t1"], next: null }; }, primaryPage: async () => ({ items: [], next: null }) };
    const t = new TodoTracker({ store, gmail: () => [gmail], now: () => clock.now, pauseMs: { gmail: 0 } });
    await t.sync();
    expect(store.meet(GKEY).done).toBe(false);
    await t.sync();
    expect(store.meet(GKEY).done).toBe(true);
    expect(store.isTodo(gmailChatID(EMAIL, "t1"))).toBe(true);
    t.stop();
  });

  test("the next inbound after a full first run takes the oldest's place, not the newest's; since stays, and it is said", () => {
    const logs: string[] = [];
    const clock = { now: T0 };
    const store = new TodoStore({ now: () => clock.now, max: 3, log: (m) => logs.push(m) });
    store.meet("beeper");
    for (const [id, at] of [["newest", T0 - min], ["middle", T0 - 2 * min], ["oldest", T0 - 3 * min]] as const) store.see(chat({ id, unreadCount: 1, lastActivity: iso(at), preview: msg(id, at) }));
    store.finishFirstRun("beeper");
    clock.now = T0 + min;
    store.noteOthers("fresh", T0 + 30_000);
    expect(["newest", "middle", "oldest", "fresh"].filter((id) => store.isTodo(id))).toEqual(["newest", "middle", "fresh"]);
    expect(store.meet("beeper").since).toBe(T0);
    expect(store.overflowed()).toBe(true);
    expect(logs.join("\n")).toContain("To do");
    expect(logs.join("\n")).not.toContain("oldest");
  });

  test("a To do chat that had to go is told (no silent drop): open pages hear, the owner is told, and it can come back", () => {
    const { store, clock } = settled({ max: 3 });
    const told: string[] = [];
    const t = new TodoTracker({ store, onChange: (id, f) => told.push(`${id}:${f}`), now: () => clock.now });
    for (const id of ["a", "b", "c", "d"]) {
      clock.now += 1000;
      t.event({ type: "event", kind: "message", op: "upserted", chatID: id, messageIDs: [`m-${id}`], ts: iso(clock.now), othersAt: iso(clock.now) });
    }
    expect(told).toContain("a:false");
    expect(store.isTodo("a")).toBe(false);
    expect(store.overflowed()).toBe(true);
    // `since` did not move: what was left out comes back when it is next seen.
    store.setOwner("b", false);
    store.see(chat({ id: "a", lastActivity: iso(T0 + 60 * min + 1000), preview: msg("m-a", T0 + 60 * min + 1000) }));
    expect(store.isTodo("a")).toBe(true);
    t.stop();
  });

  test("evicting a handled chat does not lift since past what was looked at: a message nobody has seen is not lost", () => {
    const { store } = settled({ max: 2 });
    store.see(inbound(T0 + min, { id: "A" }));
    store.setOwner("A", false);
    store.see(inbound(T0 + 2 * min, { id: "keep" }));
    store.see(inbound(T0 + 3 * min, { id: "new1" }));
    store.setOwner("keep", false);
    store.see(inbound(T0 + 30_000, { id: "L" }));
    expect(store.isTodo("L")).toBe(true);
  });

  test("one source cannot crowd out another: the bound is fair per source, and a handled chat goes before a To do", () => {
    const { store, clock } = settled({ max: 6 });
    store.see(inbound(T0 + min, { id: "handled" }));
    store.setOwner("handled", false);
    for (const id of ["b1", "b2"]) store.see(inbound(T0 + 2 * min, { id }));
    for (let i = 0; i < 12; i++) {
      clock.now += 1000;
      store.noteOthers(gmailChatID(EMAIL, `promo${i}`), clock.now, { low: true });
    }
    expect(store.entry("handled")).toBeUndefined();
    expect(store.isTodo("b1")).toBe(true);
    expect(store.isTodo("b2")).toBe(true);
    expect(store.size).toBe(6);
  });
});

describe("clocks and ids (findings 11 and the low ones)", () => {
  test("a future-dated message: after Done, its redelivery does not bring the chat back", () => {
    const { store, clock } = settled();
    const future = T0 + 24 * 60 * min;
    const t = new TodoTracker({ store, now: () => clock.now });
    const upsert = () => t.event(message(["fut"], future, clock.now));
    upsert();
    expect(store.isTodo("c1")).toBe(true);
    for (let i = 0; i < 3; i++) {
      store.setOwner("c1", false);
      clock.now += 30_000;
      upsert();
      expect(store.isTodo("c1")).toBe(false);
    }
    t.stop();
  });

  test("the list's preview of that same future message does not either, and does not raise others", () => {
    const { store, clock } = settled();
    const future = T0 + 24 * 60 * min;
    store.noteOthers("c1", future, { ids: ["fut"] });
    const others = store.entry("c1")!.others;
    store.setOwner("c1", false);
    clock.now += 1000;
    store.see(chat({ lastActivity: iso(future), preview: msg("fut", future) }));
    expect(store.isTodo("c1")).toBe(false);
    expect(store.entry("c1")!.others).toBe(others);
  });

  test("a future-dated preview does not mask a real message the socket lost", () => {
    const { store, clock } = settled();
    const future = T0 + 24 * 60 * min;
    const c = () => chat({ lastActivity: iso(future), preview: msg("fut", future) });
    store.see(c());
    store.setOwner("c1", false);
    clock.now += 60_000;
    const real = clock.now;
    clock.now += 60_000;
    store.see(c());
    expect(store.isTodo("c1")).toBe(false);
    store.seeRead(c(), [msg("bob", real), msg("fut", future)]);
    expect(store.isTodo("c1")).toBe(true);
  });

  test("a message older than the newest known, arriving while the chat is handled, is To do when its id is new", () => {
    const { store, clock } = settled();
    store.see(inbound(T0 + 5 * min));
    store.setOwner("c1", false);
    clock.now += min;
    expect(store.noteOthers("c1", T0 + 4 * min, { ids: ["late"] })).toBe(true);
    expect(store.isTodo("c1")).toBe(true);
    // The same one again is not new.
    store.setOwner("c1", false);
    expect(store.noteOthers("c1", T0 + 4 * min, { ids: ["late"] })).toBe(false);
    expect(store.isTodo("c1")).toBe(false);
  });

  test("the same timestamp after Done is To do when the id is new", () => {
    const { store } = settled();
    store.see(inbound(T0 + 5 * min));
    store.setOwner("c1", false);
    store.see(chat({ lastActivity: iso(T0 + 5 * min), preview: msg("different", T0 + 5 * min) }));
    expect(store.isTodo("c1")).toBe(true);
  });

  test("a Mac clock 90 s fast does not lose a reply on a chat first seen at Done", () => {
    const { store, clock } = settled();
    store.setOwner("c9", false);
    const reply = clock.now - 90_000 + 20_000;
    expect(store.noteOthers("c9", reply)).toBe(true);
    expect(store.isTodo("c9")).toBe(true);
    // With what the page showed, the clock does not come into it at all.
    store.setOwner("c8", false, { upTo: reply - 1000 });
    expect(store.noteOthers("c8", reply)).toBe(true);
  });

  test("the first event on a source not met yet is not lost", () => {
    const clock = { now: T0 };
    const store = new TodoStore({ now: () => clock.now });
    const id = gmailChatID(EMAIL, "t1");
    expect(store.noteOthers(id, clock.now)).toBe(true);
    expect(store.isTodo(id)).toBe(true);
  });

  test("a Gmail replay of what was already known does not bring a handled chat back (history re-sent with a later poll time)", async () => {
    const { store, clock } = settled();
    store.meet(GKEY);
    store.finishFirstRun(GKEY);
    const id = gmailChatID(EMAIL, "t1");
    const gmail = { email: EMAIL, threadIDs: async () => ({ ids: ["t1"], next: null }), primaryPage: async () => ({ items: [], next: null }) };
    const t = new TodoTracker({ store, gmail: () => [gmail], now: () => clock.now });
    clock.now += 1000;
    const event = (at: number) => t.event({ type: "event", kind: "message", op: "upserted", chatID: id, messageIDs: ["M1"], ts: iso(at), othersAt: iso(at) });
    event(clock.now);
    await Bun.sleep(5);
    expect(store.isTodo(id)).toBe(true);
    store.setOwner(id, false);
    clock.now += 30_000;
    event(clock.now);
    await Bun.sleep(5);
    expect(store.isTodo(id)).toBe(false);
    t.stop();
  });
});

describe("what a read accounts for (finding 9)", () => {
  test("a short read showing only the owner's newest message accounts for nothing: the list still asks for a read", () => {
    const { store } = settled();
    const own = T0 + 3 * min;
    store.seeRead(chat({ lastActivity: iso(own) }), [msg("own", own, { isSender: true })], { complete: false });
    expect(store.see(ownLast(own)).needsRead).toBe(true);
  });

  test("a page of the owner's messages only accounts for nothing either, unless it reached the chat's start", () => {
    const { store } = settled();
    const items = Array.from({ length: 20 }, (_, i) => msg(`o${i}`, T0 + 3 * min + i, { isSender: true }));
    store.seeRead(chat({ lastActivity: iso(T0 + 4 * min) }), items, { complete: false });
    expect(store.see(ownLast(T0 + 4 * min)).needsRead).toBe(true);
    store.seeRead(chat({ lastActivity: iso(T0 + 4 * min) }), items, { complete: true });
    expect(store.see(ownLast(T0 + 4 * min)).needsRead).toBe(false);
  });

  test("someone else's message on the page accounts for it", () => {
    const { store } = settled();
    const own = T0 + 3 * min;
    store.seeRead(chat({ lastActivity: iso(own) }), [msg("in", T0 + 2 * min), msg("own", own, { isSender: true })], { complete: false });
    expect(store.isTodo("c1")).toBe(true);
    expect(store.see(ownLast(own)).needsRead).toBe(false);
  });

  test("the lost message is found: an agent's read limit 1 asks for a real one, and it goes further back when a page holds only the owner's", async () => {
    const { store, clock } = settled();
    const missed = T0 + 2 * min;
    const own = (i: number) => msg(`own${i}`, T0 + 3 * min + i, { isSender: true });
    const pages: Record<string, { items: MessageItem[]; hasMore: boolean; nextCursor: string | null }> = {
      first: { items: Array.from({ length: 20 }, (_, i) => own(i + 20)), hasMore: true, nextCursor: "older" },
      older: { items: [msg("M", missed), own(0)], hasMore: false, nextCursor: null },
    };
    const asked: unknown[] = [];
    const c = chat({ lastActivity: iso(T0 + 3 * min + 39) });
    const readChat = async (p: { chatID: string; limit: number; cursor?: string }) => {
      asked.push(p.cursor ?? null);
      return { ok: true as const, data: { chat: c, ...pages[p.cursor ?? "first"]! } as unknown as ActionResult<"read_chat"> };
    };
    const t = new TodoTracker({ store, readChat, now: () => clock.now });
    // What an agent's read_chat limit:1 brings.
    t.seeResult("read_chat", { chat: c, items: [own(39)], hasMore: true, nextCursor: "x" }, { chatID: "c1", limit: 1 });
    await Bun.sleep(5);
    expect(asked).toEqual([null, "older"]);
    expect(store.isTodo("c1")).toBe(true);
    t.stop();
  });

  test("a chat whose every page is the owner's is not read again until its activity moves", async () => {
    const { store, clock } = settled();
    let reads = 0;
    const c = () => chat({ lastActivity: iso(T0 + 3 * min), preview: msg("o", T0 + 3 * min, { isSender: true }) });
    const readChat = async () => {
      reads++;
      return { ok: true as const, data: { chat: c(), items: [msg("o", T0 + 3 * min, { isSender: true })], hasMore: true, nextCursor: "more" } as unknown as ActionResult<"read_chat"> };
    };
    const t = new TodoTracker({ store, readChat, now: () => clock.now });
    t.seeResult("list_chats", { items: [c()] }, {});
    await Bun.sleep(5);
    const once = reads;
    expect(once).toBeGreaterThan(0);
    t.seeResult("list_chats", { items: [c()] }, {});
    await Bun.sleep(5);
    expect(reads).toBe(once);
    t.stop();
  });
});

describe("notices count (finding 10)", () => {
  test("a NOTICE from someone else is their message, in every path; a hidden one is not", () => {
    const now = iso(T0);
    expect(othersAtOf([{ type: "NOTICE", isSender: false, timestamp: iso(T0 - 1000) }], now)).toBe(iso(T0 - 1000));
    expect(othersAtOf([{ type: "TEXT", isHidden: true, isSender: false, timestamp: iso(T0 - 1000) }], now)).toBeNull();
    expect(othersFact(chat({ preview: msg("n", T0, { type: "NOTICE" }) })).at).toBe(T0);
    const { store } = settled();
    store.seeRead(chat({ lastActivity: iso(T0 + min) }), [msg("n", T0 + min, { type: "NOTICE" })], { complete: true });
    expect(store.isTodo("c1")).toBe(true);
  });
});

describe("the file (finding 13)", () => {
  function written() {
    const dir = mkdtempSync(join(tmpdir(), "todo-rev-"));
    const path = join(dir, "todo.json");
    const a = settled({ path });
    a.store.see(inbound(T0 + min, { id: "readButTodo" }));
    a.store.setOwner("x", true);
    a.store.flush();
    return { dir, path, good: readFileSync(path, "utf8") };
  }

  test("a corrupt file is put aside and said, and the first run finds what is unread again", () => {
    const { dir, path, good } = written();
    writeFileSync(path, good.slice(0, Math.floor(good.length / 2)));
    const logs: string[] = [];
    const clock = { now: T0 + 120 * min };
    const b = new TodoStore({ path, now: () => clock.now, log: (m) => logs.push(m) });
    expect(readdirSync(dir).filter((f) => f.includes("corrupt")).length).toBe(1);
    expect(logs.join("\n")).toMatch(/could not be read/);
    expect(b.meet("beeper").done).toBe(false);
    b.see(chat({ id: "stillUnread", unreadCount: 2, lastActivity: iso(T0 + min) }));
    expect(b.isTodo("stillUnread")).toBe(true);
  });

  test("a file of an unknown version is left as it is: nothing overwrites it, To do goes on in memory", () => {
    const { path } = written();
    const newer = JSON.stringify({ v: 2, sources: [], entries: [] });
    writeFileSync(path, newer);
    const logs: string[] = [];
    const clock = { now: T0 + 120 * min };
    const c = new TodoStore({ path, now: () => clock.now, log: (m) => logs.push(m) });
    c.meet("beeper");
    c.setOwner("x", true);
    c.flush();
    expect(readFileSync(path, "utf8")).toBe(newer);
    expect(c.isTodo("x")).toBe(true);
    expect(logs.join("\n")).toMatch(/version/);
  });

  test("no file at all is not a corruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-rev-"));
    const logs: string[] = [];
    new TodoStore({ path: join(dir, "todo.json"), now: () => T0, log: (m) => logs.push(m) });
    expect(logs).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("a chat that seems gone (finding 14)", () => {
  test("chat.deleted hides it at once and keeps what is known: the same chat listed again is what it was", () => {
    const { store } = settled();
    store.see(inbound(T0 + min));
    store.setOwner("c1", false);
    store.noteDeleted("c1");
    expect(store.entry("c1")).toBeDefined();
    store.see(inbound(T0 + min));
    expect(store.isTodo("c1")).toBe(false);

    const clock = { now: T0 };
    const s2 = new TodoStore({ now: () => clock.now });
    s2.meet("beeper");
    s2.see(chat({ id: "old", unreadCount: 1, lastActivity: iso(T0 - min), preview: msg("o", T0 - min) }));
    s2.finishFirstRun("beeper");
    clock.now += min;
    s2.noteDeleted("old");
    expect(s2.known("old")).toBe(false);
    expect(s2.count("beeper")).toBe(0);
    s2.see(chat({ id: "old", unreadCount: 0, lastActivity: iso(T0 - min), preview: msg("o", T0 - min) }));
    expect(s2.isTodo("old")).toBe(true);
    expect(s2.known("old")).toBe(true);
    expect(s2.count("beeper")).toBe(1);
  });

  test("one NOT_FOUND forgets nothing, and leaves it in To do; it takes one more, later", async () => {
    const { store, clock } = settled();
    store.noteOthers("c1", T0 + 61 * min, { ids: ["m"] });
    let found = false;
    const readChat = async () => (found ? { ok: true as const, data: { chat: inbound(T0 + 61 * min), items: [], hasMore: false, nextCursor: null } as unknown as ActionResult<"read_chat"> } : { ok: false as const, error: { code: "NOT_FOUND" as const, message: "gone", retryable: false } });
    const t = new TodoTracker({ store, readChat: readChat as never, now: () => clock.now });
    t.event({ type: "event", kind: "message", op: "upserted", chatID: "c1", messageIDs: ["z"], ts: iso(clock.now) });
    await Bun.sleep(5);
    expect(store.isTodo("c1")).toBe(true);
    expect(store.known("c1")).toBe(true);
    // Soon after: not a second opinion.
    await t.sync();
    await Bun.sleep(5);
    expect(store.entry("c1")).toBeDefined();
    // Half an hour on, it answers again: nothing was lost.
    clock.now += 30 * min;
    found = true;
    await t.sync();
    await Bun.sleep(5);
    expect(store.isTodo("c1")).toBe(true);
    expect(store.entry("c1")!.gone).toBeUndefined();
    // Gone twice, apart: forgotten.
    found = false;
    t.event({ type: "event", kind: "message", op: "upserted", chatID: "c1", messageIDs: ["z2"], ts: iso(clock.now) });
    await Bun.sleep(5);
    expect(store.entry("c1")).toBeDefined();
    clock.now += 30 * min;
    await t.sync();
    await Bun.sleep(5);
    expect(store.entry("c1")).toBeUndefined();
    t.stop();
  });
});

describe("Done against what the store knows (finding 5)", () => {
  test("something newer than what was on screen: it stays To do, and the answer says so", () => {
    const { store, clock } = settled();
    store.see(inbound(T0 + 30 * min));
    clock.now += 1000;
    const m = clock.now;
    store.noteOthers("c1", m, { ids: ["M"] });
    expect(store.setOwner("c1", false, { upTo: T0 + 30 * min })).toBe(true);
    expect(store.isTodo("c1")).toBe(true);
    // The page has it now: Done holds.
    expect(store.setOwner("c1", false, { upTo: m })).toBe(false);
    expect(store.isTodo("c1")).toBe(false);
    store.see(chat({ lastActivity: iso(m), preview: msg("M", m) }));
    expect(store.isTodo("c1")).toBe(false);
  });

  test("Done past what the store heard raises the floor: the list that follows does not undo it", () => {
    const { store, clock } = settled();
    store.see(inbound(T0 + 30 * min));
    const m = T0 + 62 * min;
    clock.now = m + 1000;
    expect(store.setOwner("c1", false, { upTo: m })).toBe(false);
    store.see(chat({ lastActivity: iso(m), preview: msg("M", m) }));
    expect(store.isTodo("c1")).toBe(false);
  });

  test("Gmail's poll time is only an estimate: once a read says when the message really came, Done for it holds (never stuck)", () => {
    const { store, clock } = settled();
    const id = gmailChatID(EMAIL, "t1");
    store.meet(GKEY);
    store.finishFirstRun(GKEY);
    const written = clock.now + 1000;
    clock.now = written + 40_000;
    store.noteOthers(id, clock.now, { ids: ["M"] });
    store.seeRead(chat({ id, lastActivity: iso(written) }), [msg("M", written, { chatID: id })], { complete: true, exactScope: false });
    expect(store.setOwner(id, false, { upTo: written })).toBe(false);
  });

  test("a message deleted at the source does not leave Done stuck", () => {
    const { store, clock } = settled();
    const t1 = T0 + 30 * min;
    store.see(inbound(t1));
    clock.now = T0 + 70 * min;
    store.noteOthers("c1", clock.now, { ids: ["deleted"] });
    clock.now += 60_000;
    store.seeRead(chat({ lastActivity: iso(t1) }), [msg(`m${t1}`, t1)], { complete: true });
    expect(store.setOwner("c1", false, { upTo: t1 })).toBe(false);
  });
});

describe("a thread's hint is not its tab (finding 15)", () => {
  test("a read's hint moves neither the flag nor what the store knows; a list asked by tab does", () => {
    const { store, clock } = settled();
    const id = gmailChatID(EMAIL, "t1");
    store.meet(GKEY);
    store.finishFirstRun(GKEY);
    clock.now += 1000;
    store.noteOthers(id, clock.now, { low: false, archived: false, ids: ["m"] });
    const mixed = chat({ id, isLowPriority: true, lastActivity: iso(clock.now) });
    store.see(mixed, { at: null, exact: false }, { exactScope: false });
    expect(store.entry(id)!.low).toBe(false);
    expect(store.effective(mixed, { hinted: true })).toBe(true);
    expect(store.scopeOf(id)).toEqual({ low: false });
    store.see(chat({ id, isLowPriority: true, lastActivity: iso(clock.now) }), { at: null, exact: false }, { exactScope: true });
    expect(store.entry(id)!.low).toBe(true);
    expect(store.effective(mixed, { hinted: true })).toBe(false);
  });
});

describe("the Beeper badge (finding 7)", () => {
  test("To do deep in a long list is counted, whatever a scan reaches", async () => {
    const now = Date.now();
    const N = 3000;
    const raw = Array.from({ length: N }, (_, i) => ({ id: `c${i}`, accountID: "a", network: "WhatsApp", title: `t${i}`, type: "single", unreadCount: 0, isPinned: false, isMuted: false, isArchived: false, lastActivity: iso(now - i * 60_000), sortKey: String(N - i), preview: { id: `m${i}`, chatID: `c${i}`, accountID: "a", senderID: "x", timestamp: iso(now - i * 60_000), sortKey: String(N - i), type: "TEXT", isSender: false, text: "x" } }));
    const client: any = {
      chatPath: () => "/x",
      get: async (path: string) => {
        const u = new URL("http://x" + path);
        const from = Number(u.searchParams.get("cursor") ?? 0);
        return { ok: true, status: 200, body: { items: raw.slice(from, from + 50), hasMore: from + 50 < N, oldestCursor: String(from + 50), newestCursor: String(from) } };
      },
    };
    const store = new TodoStore({ now: () => now });
    store.meet("beeper");
    store.finishFirstRun("beeper");
    const tracker = new TodoTracker({ store, now: () => now });
    for (const i of [5, 1500, 2500]) store.setOwner(`c${i}`, true);
    const actions = createActions(client, { todo: tracker, scan: { maxPages: 2 } } as never);
    const s = await actions.unread_summary({ limit: 1, todo: true }, {});
    if (!s.ok) throw new Error(JSON.stringify(s.error));
    expect(s.data.totalUnreadChats).toBe(3);
    tracker.stop();
  });
});

describe("Gmail To do in the service (findings 1, 2, 15, through the real Gmail lane)", () => {
  const TOKEN = "jid_" + "T".repeat(43);
  let fb: FakeBeeper;
  let fg: RunningFakeGoogle;
  beforeAll(async () => {
    // The connector goes by the real clock: the fixtures must be recent to it, or To do's first run leaves them out.
    fb = await startFakeBeeper({ fixtureNow: Date.now() });
    fg = await startFakeGoogle({ fixtureNow: Date.now() });
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
  async function withGmail() {
    const cloud: FakeCloud = await startFakeCloud({ token: TOKEN, google: { url: fg.url, clientId: FAKE_GOOGLE_CLIENT.id, clientSecret: FAKE_GOOGLE_CLIENT.secret } });
    cleanup.push(() => cloud.stop());
    const paths = resolvePaths({ HOME: "/nonexistent", J_INBOX_CONFIG_DIR: mkdtempSync(join(tmpdir(), "jinbox-trev-")) });
    saveConfig(paths, { cloudURL: cloud.url, beeperURL: fb.url, deviceID: "dev_todo", deviceName: "Test Mac" });
    const secrets = new FileSecretStore(paths.secretsFile);
    await secrets.set("beeper-token", fb.token);
    await secrets.set("device-token", TOKEN);
    const svc: Service = await startService({ paths, secrets, version: "0.1.0", healthIntervalMs: 60_000, backoff: () => 30, env: { J_INBOX_GMAIL_API_URL: fg.url, J_INBOX_GOOGLE_OAUTH_URL: fg.url }, gmailPollIntervalMs: 100, log: () => {} });
    cleanup.push(() => svc.stop(0));
    await cloud.waitFor(() => svc.link?.state.status === "connected", 4000, "connected");
    const rt = fg.google.issueRefreshToken(OWNER_EMAIL);
    expect((await cloud.req("gmail_connect", { email: OWNER_EMAIL, refreshToken: rt })).res.ok).toBe(true);
    const lunch = gmailChatID(OWNER_EMAIL, THREADS.lunch);
    const todoIDs = async (extra: Record<string, unknown> = {}) => {
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
    for (let i = 0; i < 300 && !(await todoIDs()).includes(lunch); i++) await Bun.sleep(20);
    expect(await todoIDs()).toContain(lunch);
    const count = async () => ((await cloud.req("unread_summary", { limit: 1, todo: true })).res.data as any).totalUnreadChats as number;
    const stored = () => (JSON.parse(readFileSync(paths.todoFile, "utf8")).entries as any[]).find((e) => e.chatID === lunch);
    return { cloud, svc, paths, lunch, todoIDs, count, stored };
  }

  test("a read-only filtered list hides nothing: not pinned, not unread, not a query", async () => {
    const b = await withGmail();
    const before = (await b.todoIDs()).filter((i) => i.startsWith("gmail:"));
    const countBefore = await b.count();
    expect(before.length).toBeGreaterThan(0);
    for (const narrowed of [{ pinnedOnly: true }, { unreadOnly: true }, { query: "nothingmatchesthis" }]) {
      expect((await b.cloud.req("list_chats", { todo: true, source: "gmail", limit: 50, ...narrowed })).res.ok).toBe(true);
      expect((await b.todoIDs()).filter((i) => i.startsWith("gmail:"))).toEqual(before);
      expect(await b.count()).toBe(countBefore);
    }
  }, 60_000);

  test("the whole Primary walk still says what is not in it", async () => {
    const b = await withGmail();
    // A To do thread moved away from Primary: its row is not on the list.
    const promo = gmailChatID(OWNER_EMAIL, THREADS.promo);
    await b.cloud.req("set_todo", { chatID: promo, todo: true });
    const c0 = await b.count();
    expect((await b.todoIDs()).includes(promo)).toBe(false);
    for (let i = 0; i < 200 && (await b.count()) === c0; i++) await Bun.sleep(20);
    expect(await b.count()).toBe(c0 - 1);
  }, 60_000);

  test("a reply on an archived thread in Primary is in the list and the badge, and its event says so", async () => {
    const b = await withGmail();
    for (const id of (await b.todoIDs()).filter((i) => i.startsWith("gmail:"))) await b.cloud.req("set_todo", { chatID: id, todo: false });
    expect((await b.cloud.req("archive", { chatID: b.lunch, archived: true })).res.ok).toBe(true);
    await Bun.sleep(200);
    const c0 = await b.count();
    const e0 = b.cloud.events().length;
    fg.google.advance(1000);
    fg.google.deliver(OWNER_EMAIL, { threadId: THREADS.lunch, from: "Alice <alice@example.com>", subject: "Re: Lunch on Friday?", text: "reply after archive" });
    for (let i = 0; i < 300 && !(await b.todoIDs()).includes(b.lunch); i++) await Bun.sleep(20);
    expect(await b.todoIDs()).toContain(b.lunch);
    expect(await b.count()).toBe(c0 + 1);
    const told = b.cloud.events().slice(e0).filter((e: any) => e.kind === "chat" && e.chatID === b.lunch && e.todo !== undefined).map((e: any) => e.todo);
    expect(told.at(-1)).toBe(true);
  }, 60_000);

  test("a thread with a promotion's message in it says the same in a list and in a read: Done stays possible", async () => {
    const b = await withGmail();
    fg.google.advance(1000);
    fg.google.deliver(OWNER_EMAIL, { threadId: THREADS.lunch, from: "Bot <bot@example.com>", subject: "Re: Lunch on Friday?", text: "newsletterish", labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] });
    await Bun.sleep(600);
    const inList = ((await b.cloud.req("list_chats", { inbox: "primary", source: "gmail", limit: 20 })).res.data as any).items.find((c: any) => c.id === b.lunch);
    const read = ((await b.cloud.req("read_chat", { chatID: b.lunch, limit: 10 })).res.data as any).chat;
    expect(inList.todo).toBe(true);
    expect(read.todo).toBe(true);
    expect(read.isLowPriority).toBe(false);
    expect(await b.todoIDs()).toContain(b.lunch);
  }, 60_000);

  test("set_todo with upTo is answered with what the store decided, through the whole way", async () => {
    const b = await withGmail();
    fg.google.advance(1000);
    fg.google.deliver(OWNER_EMAIL, { threadId: THREADS.lunch, from: "Alice <alice@example.com>", subject: "Re: Lunch on Friday?", text: "new" });
    const shown = () => b.cloud.req("read_chat", { chatID: b.lunch, limit: 10 });
    await Bun.sleep(400);
    const refused = await b.cloud.req("set_todo", { chatID: b.lunch, todo: false, upTo: "2000-01-01T00:00:00.000Z" });
    expect((refused.res.data as any).todo).toBe(true);
    const newest = ((await shown()).res.data as any).items.at(-1).timestamp as string;
    const held = await b.cloud.req("set_todo", { chatID: b.lunch, todo: false, upTo: newest });
    expect((held.res.data as any).todo).toBe(false);
    expect(await b.todoIDs()).not.toContain(b.lunch);
  }, 60_000);
});
