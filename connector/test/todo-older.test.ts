// To do's first run, 7 days back, and Add older unread: the store, the tracker and the dispatcher's own actions,
// with the real Gmail source against fake Google (which really answers is:unread, after: and before:, and says
// resultSizeEstimate as Gmail was measured to say it) and the real Beeper pages against fake Beeper. Nothing is ever written to either.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { FAKE_GOOGLE_CLIENT, OTHER_EMAIL, OWNER_EMAIL, startFakeGoogle, type RunningFakeGoogle } from "@j-inbox/fake-google";
import { gmailChatID, parseActionResult, type ActionName, type ChatSummary } from "@j-inbox/protocol";
import { createActions, createWriteDedupe } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";
import { createBeeperClient } from "../src/beeper-client.ts";
import { createDispatcher } from "../src/dispatcher.ts";
import { cloudTokenRefresher } from "../src/gmail/client.ts";
import { createGmailService, type GmailService } from "../src/gmail/service.ts";
import { MemorySecretStore } from "../src/secrets.ts";
import { BEEPER_SOURCE, GONE_APART_MS, TodoStore, noteThreadOthers } from "../src/todo/store.ts";
import { TodoTracker } from "../src/todo/tracker.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const DAY = 24 * 3_600_000;
const DEVICE_TOKEN = "jid_" + "A".repeat(43);
const GKEY = `gmail:${OWNER_EMAIL}`;
const INBOX = ["INBOX", "UNREAD", "CATEGORY_PERSONAL"];
// A fixed instant, whatever the day this runs: the fakes and the store share it.
const T0 = Date.parse("2026-11-04T10:00:00.000Z");
const CUT_SECONDS = Math.floor((T0 - 7 * DAY) / 1000);
const iso = (ms: number) => new Date(ms).toISOString();
// A first run's three walks: unread since the cut; every thread active since then; unread older than it.
const Q_SINCE = `is:unread in:inbox category:primary after:${CUT_SECONDS - 1}`;
const Q_ACTIVE = `after:${CUT_SECONDS - 1} -in:drafts`;
const Q_BEFORE = `is:unread in:inbox category:primary before:${CUT_SECONDS}`;

let fb: FakeBeeper;
let fg: RunningFakeGoogle;
let cloud: FakeCloud;
let gmail: GmailService;
const clock = { now: T0 };

beforeAll(async () => {
  fb = await startFakeBeeper({ fixtureNow: T0 });
  fg = await startFakeGoogle({ fixtureNow: T0, now: () => clock.now });
  cloud = await startFakeCloud({ google: { url: fg.url, clientId: FAKE_GOOGLE_CLIENT.id, clientSecret: FAKE_GOOGLE_CLIENT.secret } });
});
afterAll(() => {
  fb.stop();
  fg.stop();
  cloud.stop();
});
const open: TodoTracker[] = [];
beforeEach(async () => {
  clock.now = T0;
  fb.reset();
  fg.google.reset();
  gmail = createGmailService({ secrets: new MemorySecretStore(), refresh: cloudTokenRefresher({ cloudURL: cloud.url, deviceToken: DEVICE_TOKEN }), gmailURL: fg.url, oauthURL: fg.url, pacing: { maxRequestsPerSecond: 10_000 } });
  await gmail.accounts.add(OWNER_EMAIL, fg.google.issueRefreshToken(OWNER_EMAIL));
  fg.google.mailbox().messages.clear();
});
afterEach(() => {
  for (const t of open.splice(0)) t.stop();
});

type Rig = { store: TodoStore; tracker: TodoTracker; told: { id: string; flag: boolean }[]; call: (action: ActionName, params: unknown) => Promise<any> };

/** The connector's own parts, as the service wires them; `beeper` or `email` off leaves that source out. */
function rig(o: { path?: string; max?: number; noisy?: (id: string) => boolean; beeper?: boolean; email?: boolean; laterPagesFail?: { on: boolean }; logs?: string[]; olderRetryMs?: number; sources?: () => ReturnType<GmailService["sources"]> } = {}): Rig {
  const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 });
  const assets = new AssetAllowlist();
  const idempotency = createWriteDedupe();
  const told: { id: string; flag: boolean }[] = [];
  const store = new TodoStore({ now: () => clock.now, ...(o.path ? { path: o.path } : {}), ...(o.max ? { max: o.max } : {}), ...(o.logs ? { log: (m: string) => o.logs!.push(m) } : {}) });
  const tracker: TodoTracker = new TodoTracker({
    store,
    ...(o.noisy ? { noise: { active: () => true, isNoise: o.noisy } } : {}),
    ...(o.beeper === false
      ? {}
      : {
          beeperPage: async (cursor: string | null, ctx: any) => {
            if (cursor && o.laterPagesFail?.on) throw new Error("Beeper is gone");
            return actions.internals.chatsPage(cursor, ctx);
          },
        }),
    ...(o.email === false ? {} : { gmail: o.sources ?? (() => gmail.sources()) }),
    onChange: (id, flag) => told.push({ id, flag }),
    now: () => clock.now,
    pauseMs: { gmail: 0, beeper: 0, ...(o.olderRetryMs !== undefined ? { olderRetry: o.olderRetryMs } : {}) },
    ...(o.logs ? { log: (m: string) => o.logs!.push(m) } : {}),
  });
  const actions = createActions(client, { assets, idempotency, connectorVersion: "0.1.0", todo: tracker });
  const d = createDispatcher({ actions, client, assets, gmail, idempotency, todo: tracker });
  open.push(tracker);
  const call = async (action: ActionName, params: unknown): Promise<any> => {
    const r = await d.dispatch(action, params);
    if (r.kind !== "res") throw new Error("media");
    if (!r.ok) throw new Error(`${action}: ${r.error.code}`);
    const v = parseActionResult(action, r.data);
    if (!v.ok) throw new Error(`invalid ${action} result`);
    return r.data;
  };
  return { store, tracker, told, call };
}

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "jinbox-older-")), "todo.json");
const mail = (ago: number, o: { labels?: string[]; threadId?: string; subject?: string } = {}) => fg.google.deliver(OWNER_EMAIL, { from: "A <a@example.com>", subject: o.subject ?? "Hello", text: "x", at: T0 - ago, labels: o.labels ?? INBOX, ...(o.threadId ? { threadId: o.threadId } : {}) }).threadId;
const thread = (id: string) => gmailChatID(OWNER_EMAIL, id);
const beeperChat = (id: string, ago: number, unread = 1) => {
  const c = fb.state.chats.get(id)!;
  const msgs = fb.state.messages.get(id) ?? [];
  const last = T0 - ago;
  msgs.forEach((m, i) => (m.timestamp = iso(last - (msgs.length - 1 - i) * 1000)));
  c.lastActivity = iso(last);
  c.unreadCount = unread;
  c.isArchived = false;
  c.isLowPriority = false;
  c.isMarkedUnread = false;
};
/** Every fixture chat read and long quiet, so a test's own chats are all there is. */
function quietBeeper() {
  for (const id of fb.state.chats.keys()) beeperChat(id, 60 * DAY, 0);
}
const lists = () => fg.google.requests.filter((r) => r.method === "GET" && /\/threads$/.test(r.path));
const threadReads = () => fg.google.requests.filter((r) => /\/threads\/[^/]+$/.test(r.path) || r.path.includes("/batch/"));
const gmailWrites = () => fg.google.requests.filter((r) => r.path.startsWith("/gmail/") && r.method !== "GET");
const beeperReadState = () => fb.writes().filter((w) => /\/(read|unread|archive)$/.test(w.route));
const stateOfMailbox = () => [...fg.google.mailbox().messages.values()].map((m) => `${m.id}:${[...m.labelIds].sort().join(",")}`).sort();
/** Until the background walk has settled (add_older_unread answers at once). */
async function settle(t: TodoTracker) {
  for (let i = 0; i < 400; i++) {
    await t.sync();
    if (!t.store.olderOf(BEEPER_SOURCE)?.asked && !t.store.olderOf(GKEY)?.asked) return;
    await Bun.sleep(5);
  }
  throw new Error("the walk never ended");
}

describe("Gmail's first run, 7 days back", () => {
  test("only unread in the main inbox active since the cut; nothing is changed in Gmail; old unread stays unread and in the normal lists", async () => {
    const recent = mail(1 * DAY);
    const almost = mail(7 * DAY - 60_000);
    const old = mail(10 * DAY);
    const veryOld = mail(400 * DAY);
    mail(1 * DAY, { labels: ["INBOX", "CATEGORY_PERSONAL"] }); // read
    mail(1 * DAY, { labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] });
    mail(1 * DAY, { labels: ["UNREAD", "CATEGORY_PERSONAL"] }); // archived
    const { store, tracker, call } = rig({ beeper: false });
    const before = stateOfMailbox();
    await tracker.sync();
    expect(store.meet(GKEY).done).toBe(true);
    expect([recent, almost].map((t) => store.isTodo(thread(t)))).toEqual([true, true]);
    expect([old, veryOld].map((t) => store.entry(thread(t)))).toEqual([undefined, undefined]);
    expect(store.count(GKEY)).toBe(2);
    // The boundary is epoch seconds, in the query itself; ids only, and no write.
    expect(lists().map((r) => r.q)).toEqual([Q_SINCE, Q_ACTIVE, Q_BEFORE]);
    expect(threadReads()).toEqual([]);
    expect(gmailWrites()).toEqual([]);
    expect(stateOfMailbox()).toEqual(before);
    const unread = await call("list_chats", { inbox: "primary", unreadOnly: true, accountIDs: [GKEY], limit: 50 });
    const rows = unread.items.map((c: ChatSummary) => c.id);
    expect(rows).toContain(thread(old));
    expect(rows).toContain(thread(veryOld));
    expect(unread.items.find((c: ChatSummary) => c.id === thread(old)).todo).toBe(false);
  });

  test("the very second of the cut is in To do or in the older count, never in neither", async () => {
    const atCut = mail(T0 - CUT_SECONDS * 1000);
    const { store, tracker, call } = rig({ beeper: false });
    await tracker.sync();
    expect(store.isTodo(thread(atCut))).toBe(true);
    // Already in To do, so it is not said to be left out.
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([{ source: GKEY, count: 0, adding: false, counting: false }]);
  });

  test("a restart in the middle: the same cut, however late it comes, on disk from the start", async () => {
    const path = tmpFile();
    // Two pages of 100 and 5 days back: a cut worked out again after the restart would miss this one.
    const edge = mail(6 * DAY);
    for (let i = 0; i < 120; i++) mail(1 * DAY + i);
    const old = mail(8 * DAY);
    fg.google.failNext({ path: /\/threads$/, search: /pageToken=/, status: 400 });
    const a = rig({ path, beeper: false });
    await a.tracker.sync();
    const first = a.store.meet(GKEY);
    expect(first.done).toBe(false);
    expect(first.cut).toBe(T0 - 7 * DAY);
    expect(JSON.parse(readFileSync(path, "utf8")).sources.find((s: any) => s[0] === GKEY)[1].cut).toBe(T0 - 7 * DAY);
    a.tracker.stop();
    clock.now = T0 + 3 * DAY;
    fg.google.requests.length = 0;
    const b = rig({ path, beeper: false });
    expect(b.store.meet(GKEY).cut).toBe(T0 - 7 * DAY);
    await b.tracker.sync();
    expect(b.store.meet(GKEY).done).toBe(true);
    // All three walks again from the top.
    expect(new Set(lists().map((r) => r.q))).toEqual(new Set([Q_SINCE, Q_ACTIVE, Q_BEFORE]));
    expect(b.store.isTodo(thread(edge))).toBe(true);
    expect(b.store.count(GKEY)).toBe(121);
    expect(b.store.entry(thread(old))).toBeUndefined();
  }, 20_000);

  test("a list during the first run judges by the same rule: an old unread thread does not come back through it", async () => {
    const recent = mail(1 * DAY);
    const old = mail(10 * DAY);
    const { store, call } = rig({ beeper: false });
    store.meet(GKEY);
    const r = await call("list_chats", { inbox: "primary", accountIDs: [GKEY], limit: 50 });
    expect(r.items.find((c: ChatSummary) => c.id === thread(recent)).todo).toBe(true);
    expect(r.items.find((c: ChatSummary) => c.id === thread(old)).todo).toBe(false);
    expect(store.meet(GKEY).done).toBe(false);
    expect(store.entry(thread(old))).toBeUndefined();
    // The same through a read and through a search.
    await call("read_chat", { chatID: thread(old), limit: 5 });
    await call("search_messages", { query: "Hello", accountIDs: [GKEY] });
    expect(store.isTodo(thread(old))).toBe(false);
  });

  test("an old thread someone writes to after connecting is To do as usual, and the count stays what the first run said", async () => {
    const old = mail(10 * DAY);
    const other = mail(11 * DAY);
    const { store, tracker, call } = rig({ beeper: false });
    await tracker.sync();
    expect(store.isTodo(thread(old))).toBe(false);
    clock.now = T0 + 60_000;
    const reply = fg.google.deliver(OWNER_EMAIL, { from: "A <a@example.com>", subject: "Hello", threadId: old, text: "y", at: clock.now });
    tracker.event({ type: "event", kind: "message", op: "upserted", chatID: thread(old), ts: iso(clock.now), messageIDs: [reply.id], othersAt: iso(clock.now) });
    await Bun.sleep(50);
    expect(store.isTodo(thread(old))).toBe(true);
    expect(store.isTodo(thread(other))).toBe(false);
    const items = (await call("get_older_unread", { source: "gmail" })).items;
    expect(items).toEqual([{ source: GKEY, count: 2, adding: false, counting: false }]);
  });

  test("the cut stays where it is when eviction lifts `since`", () => {
    const store = new TodoStore({ now: () => clock.now, max: 1 });
    const cut = store.meet(BEEPER_SOURCE).cut;
    store.finishFirstRun(BEEPER_SOURCE);
    clock.now = T0 + DAY;
    store.markSynced(BEEPER_SOURCE, clock.now);
    store.noteOthers("c1", T0 + 3_600_000);
    store.setOwner("c1", false);
    store.noteOthers("c2", T0 + 7_200_000);
    const after = store.meet(BEEPER_SOURCE);
    expect(after.since).toBeGreaterThan(T0);
    expect(after.cut).toBe(cut);
  });
});

describe("Beeper's first run, 7 days back", () => {
  test("every page walked; unread and recent is To do; old unread is not, and stays unread; a chat with no known time is not hidden", async () => {
    quietBeeper();
    beeperChat(CHAT_IDS.imessageAlice, 1 * DAY, 2);
    beeperChat(CHAT_IDS.pinnedUnread, 10 * DAY, 3);
    const noTime = fb.state.chats.get(CHAT_IDS.media)!;
    fb.state.messages.set(CHAT_IDS.media, []);
    noTime.unreadCount = 1;
    delete (noTime as { lastActivity?: string }).lastActivity;
    beeperChat(CHAT_IDS.muted, 400 * DAY, 1);
    const { store, tracker, call } = rig({ email: false });
    await tracker.sync();
    expect(store.meet(BEEPER_SOURCE).done).toBe(true);
    expect(store.isTodo(CHAT_IDS.imessageAlice)).toBe(true);
    expect(store.isTodo(CHAT_IDS.media)).toBe(true);
    expect(store.entry(CHAT_IDS.pinnedUnread)).toBeUndefined();
    expect(store.entry(CHAT_IDS.muted)).toBeUndefined();
    expect(fb.state.chats.get(CHAT_IDS.pinnedUnread)!.unreadCount).toBe(3);
    expect(beeperReadState()).toEqual([]);
    const unread = (await call("list_chats", { inbox: "primary", unreadOnly: true, limit: 50 })).items.map((c: ChatSummary) => c.id);
    expect(unread).toContain(CHAT_IDS.pinnedUnread);
    expect((await call("get_older_unread", { source: "beeper" })).items).toEqual([{ source: "beeper", count: 2, adding: false, counting: false }]);
  });

  test("a restart in the middle: the same cut, and what a walk later finds is judged by it", async () => {
    quietBeeper();
    const path = tmpFile();
    beeperChat(CHAT_IDS.imessageAlice, 6 * DAY, 1);
    beeperChat(CHAT_IDS.pinnedUnread, 8 * DAY, 1);
    const a = rig({ path, email: false, laterPagesFail: { on: true } });
    await a.tracker.sync();
    expect(a.store.meet(BEEPER_SOURCE).done).toBe(false);
    expect(a.store.isTodo(CHAT_IDS.imessageAlice)).toBe(true);
    a.tracker.stop();
    clock.now = T0 + 3 * DAY;
    const b = rig({ path, email: false });
    expect(b.store.meet(BEEPER_SOURCE).cut).toBe(T0 - 7 * DAY);
    await b.tracker.sync();
    expect(b.store.meet(BEEPER_SOURCE).done).toBe(true);
    expect(b.store.isTodo(CHAT_IDS.imessageAlice)).toBe(true);
    expect(b.store.entry(CHAT_IDS.pinnedUnread)).toBeUndefined();
  });

  test("a list during the first run does not put an old chat in", async () => {
    quietBeeper();
    beeperChat(CHAT_IDS.imessageAlice, 1 * DAY, 1);
    beeperChat(CHAT_IDS.pinnedUnread, 10 * DAY, 1);
    const { store, call } = rig({ email: false });
    store.meet(BEEPER_SOURCE);
    const items = (await call("list_chats", { inbox: "primary", limit: 50 })).items as ChatSummary[];
    expect(items.find((c) => c.id === CHAT_IDS.imessageAlice)!.todo).toBe(true);
    expect(items.find((c) => c.id === CHAT_IDS.pinnedUnread)!.todo).toBe(false);
    await call("read_chat", { chatID: CHAT_IDS.pinnedUnread, limit: 5 });
    expect(store.isTodo(CHAT_IDS.pinnedUnread)).toBe(false);
  });

  test("an old chat someone writes in after connecting is To do", async () => {
    quietBeeper();
    beeperChat(CHAT_IDS.pinnedUnread, 10 * DAY, 1);
    fb.state.now = () => clock.now;
    const { store, tracker, call } = rig({ email: false });
    await tracker.sync();
    expect(store.isTodo(CHAT_IDS.pinnedUnread)).toBe(false);
    clock.now = T0 + 60_000;
    fb.state.receive(CHAT_IDS.pinnedUnread, { text: "are you there" });
    await tracker.sync();
    expect(store.isTodo(CHAT_IDS.pinnedUnread)).toBe(true);
    // As of the first run, which is why the line says "About".
    expect((await call("get_older_unread", { source: "beeper" })).items).toEqual([{ source: "beeper", count: 1, adding: false, counting: false }]);
  });

  test("a chat without any time, seen by itself: kept, as before this rule", () => {
    const store = new TodoStore({ now: () => clock.now });
    const c: ChatSummary = { id: "c1", accountID: "a", network: "WhatsApp", title: "Chat", type: "single", unreadCount: 1, isPinned: false, isMuted: false, isArchived: false, lastActivity: null };
    expect(store.see(c).changed).toBe(true);
    expect(store.isTodo("c1")).toBe(true);
    expect(store.isOlder({ ...c, id: "c2" })).toBe(false);
    const bad = { ...c, id: "c3", lastActivity: "not a time" };
    expect(store.see(bad).changed).toBe(true);
    expect(store.isOlder({ ...bad, id: "c4" })).toBe(false);
  });
});

describe("a source whose first run is done", () => {
  /** A file as the connector before this rule wrote it. */
  function oldFile() {
    const path = tmpFile();
    const since = T0 - 30 * DAY;
    const source = { since, done: true, synced: T0 - DAY };
    const entry = (chatID: string, todo: boolean) => ({ chatID, todo, others: 0, activity: 0, archived: false, low: false, at: T0 - 200 * DAY });
    const oldTodo = mail(250 * DAY);
    const oldUnreadUnknown = mail(100 * DAY);
    const oldDone = mail(120 * DAY);
    writeFileSync(path, JSON.stringify({ v: 1, sources: [[BEEPER_SOURCE, source], [GKEY, source]], entries: [entry(thread(oldTodo), true), entry(thread(oldDone), false), entry(CHAT_IDS.muted, true)] }));
    return { path, oldTodo, oldUnreadUnknown, oldDone };
  }

  test("upgrading: nothing appears, nothing disappears, no line, no walk, and the file stays what it was", async () => {
    const f = oldFile();
    quietBeeper();
    beeperChat(CHAT_IDS.muted, 90 * DAY, 2);
    beeperChat(CHAT_IDS.pinnedUnread, 90 * DAY, 2);
    const before = readFileSync(f.path, "utf8");
    const { store, tracker, call } = rig({ path: f.path });
    expect(store.olderOf(GKEY)).toBeNull();
    expect(store.olderOf(BEEPER_SOURCE)).toBeNull();
    expect(store.meet(GKEY).cut).toBeUndefined();
    await tracker.sync();
    await call("list_chats", { inbox: "primary", limit: 50 });
    expect(store.isTodo(thread(f.oldTodo))).toBe(true);
    expect(store.isTodo(CHAT_IDS.muted)).toBe(true);
    expect(store.isTodo(thread(f.oldDone))).toBe(false);
    expect(store.entry(thread(f.oldUnreadUnknown))).toBeUndefined();
    expect(store.entry(CHAT_IDS.pinnedUnread)).toBeUndefined();
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([]);
    expect((await call("get_older_unread", { source: "beeper" })).items).toEqual([]);
    // And pressing it, had some page a button, does nothing at all.
    expect(await call("add_older_unread", { source: GKEY })).toEqual({ source: GKEY, adding: false });
    expect(await call("add_older_unread", { source: BEEPER_SOURCE })).toEqual({ source: BEEPER_SOURCE, adding: false });
    await tracker.sync();
    expect(store.entry(thread(f.oldUnreadUnknown))).toBeUndefined();
    expect(lists().map((r) => r.q).filter((q) => /(^| )(before|after):/.test(q ?? ""))).toEqual([]);
    // Saved again: the same sources, no field added.
    store.flush();
    const saved = JSON.parse(readFileSync(f.path, "utf8"));
    expect(saved.v).toBe(1);
    for (const [, s] of saved.sources) {
      expect(s.cut).toBeUndefined();
      expect(s.older).toBeUndefined();
      expect(s.done).toBe(true);
      expect(s.since).toBe(T0 - 30 * DAY);
    }
    expect(JSON.parse(before).entries.length).toBe(saved.entries.length);
  }, 20_000);

  test("a source new to this store next to an old one gets a cut; the old one does not", async () => {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify({ v: 1, sources: [[BEEPER_SOURCE, { since: T0 - 300 * DAY, done: true, synced: T0 }]], entries: [] }));
    const old = mail(10 * DAY);
    const { store, tracker } = rig({ path, beeper: false });
    await tracker.sync();
    expect(store.meet(GKEY).cut).toBe(T0 - 7 * DAY);
    expect(store.meet(BEEPER_SOURCE).cut).toBeUndefined();
    expect(store.entry(thread(old))).toBeUndefined();
  });

  test("a first run under way when this rule arrives gets its cut once, from its first sight, and it holds", async () => {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify({ v: 1, sources: [[GKEY, { since: T0 - DAY, done: false, synced: T0 - DAY }]], entries: [{ chatID: thread("aaaaaaaaaaaaaaaa"), todo: true, others: 0, activity: 0, archived: false, low: false, at: T0 - DAY }] }));
    const recent = mail(2 * DAY);
    const old = mail(10 * DAY);
    const a = rig({ path, beeper: false });
    expect(a.store.meet(GKEY).cut).toBe(T0 - 8 * DAY);
    // What the walk had found stays.
    expect(a.store.isTodo(thread("aaaaaaaaaaaaaaaa"))).toBe(true);
    a.store.flush();
    expect(JSON.parse(readFileSync(path, "utf8")).sources[0][1].cut).toBe(T0 - 8 * DAY);
    a.tracker.stop();
    clock.now = T0 + 5 * DAY;
    const b = rig({ path, beeper: false });
    expect(b.store.meet(GKEY).cut).toBe(T0 - 8 * DAY);
    await b.tracker.sync();
    expect(b.store.isTodo(thread(recent))).toBe(true);
    expect(b.store.entry(thread(old))).toBeUndefined();
  });

  test("a file from a newer run read by this one keeps the cut and the owner's word; rubbish in them is dropped", () => {
    const path = tmpFile();
    const s = { since: T0, done: true, synced: T0 };
    writeFileSync(path, JSON.stringify({ v: 1, sources: [["beeper", { ...s, cut: T0 - 7 * DAY, older: "asked" }], ["gmail:a@example.com", { ...s, cut: "soon", older: "asked" }], ["gmail:b@example.com", { ...s, cut: T0 - 7 * DAY, older: "maybe" }], ["gmail:c@example.com", { ...s, cut: T0 - 7 * DAY, older: "added" }]], entries: [] }));
    const store = new TodoStore({ path, now: () => clock.now });
    expect(store.olderOf("beeper")).toEqual({ cut: T0 - 7 * DAY, asked: true, done: true });
    expect(store.olderOf("gmail:a@example.com")).toBeNull();
    expect(store.olderOf("gmail:b@example.com")).toEqual({ cut: T0 - 7 * DAY, asked: false, done: true });
    expect(store.olderOf("gmail:c@example.com")).toBeNull();
  });
});

describe("Add older unread, Gmail", () => {
  const start = async (o: Parameters<typeof rig>[0] = {}) => {
    const old = [mail(8 * DAY), mail(30 * DAY), mail(400 * DAY)];
    const recent = mail(1 * DAY);
    const r = rig({ beeper: false, ...o });
    await r.tracker.sync();
    return { ...r, old, recent };
  };

  test("count, press, walk: they come in, Gmail is not touched, ids only; then the line is gone for good", async () => {
    const { store, tracker, call, old, recent } = await start();
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([{ source: GKEY, count: 3, adding: false, counting: false }]);
    expect(old.map((t) => store.isTodo(thread(t)))).toEqual([false, false, false]);
    const before = stateOfMailbox();
    fg.google.requests.length = 0;
    expect(await call("add_older_unread", { source: GKEY })).toEqual({ source: GKEY, adding: true });
    await settle(tracker);
    expect(old.map((t) => store.isTodo(thread(t)))).toEqual([true, true, true]);
    expect(store.isTodo(thread(recent))).toBe(true);
    expect(lists().filter((r) => r.q?.includes("before:")).map((r) => r.q)).toEqual([`is:unread in:inbox category:primary before:${CUT_SECONDS}`]);
    expect(threadReads()).toEqual([]);
    expect(gmailWrites()).toEqual([]);
    expect(stateOfMailbox()).toEqual(before);
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([]);
    // Over: a thread that later turns unread is no line, and a press does nothing.
    fg.google.requests.length = 0;
    mail(20 * DAY);
    expect(await call("add_older_unread", { source: GKEY })).toEqual({ source: GKEY, adding: false });
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([]);
    expect(lists()).toEqual([]);
    expect(store.meet(GKEY).done).toBe(true);
  });

  test("pressed twice, and again while it runs: one walk", async () => {
    const { tracker, call, store, old } = await start();
    fg.google.requests.length = 0;
    fg.google.latencyMs = 30;
    expect((await call("add_older_unread", { source: GKEY })).adding).toBe(true);
    expect((await call("add_older_unread", { source: GKEY })).adding).toBe(true);
    await Bun.sleep(5);
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([{ source: GKEY, count: null, adding: true, counting: false }]);
    await settle(tracker);
    expect(lists().filter((r) => r.q?.includes("before:")).length).toBe(1);
    expect(old.every((t) => store.isTodo(thread(t)))).toBe(true);
  });

  test("a restart in the middle goes on with it, and no one pressed again", async () => {
    const path = tmpFile();
    for (let i = 0; i < 130; i++) mail(8 * DAY + i);
    const a = rig({ path, beeper: false });
    await a.tracker.sync();
    // Twice: the press's own walk, and the sync asked for while it runs.
    fg.google.failNext({ path: /\/threads$/, search: /pageToken=/, status: 400, times: 2 });
    expect((await a.call("add_older_unread", { source: GKEY })).adding).toBe(true);
    await a.tracker.sync();
    // The first page came, the second did not.
    expect(a.store.count(GKEY)).toBe(100);
    expect(a.store.olderOf(GKEY)!.asked).toBe(true);
    a.tracker.stop();
    clock.now = T0 + DAY;
    const b = rig({ path, beeper: false });
    expect(b.store.olderOf(GKEY)!.asked).toBe(true);
    expect(b.store.count(GKEY)).toBe(100);
    expect((await b.call("get_older_unread", { source: "gmail" })).items).toEqual([{ source: GKEY, count: null, adding: true, counting: false }]);
    await b.tracker.sync();
    expect(b.store.count(GKEY)).toBe(130);
    expect(b.store.olderOf(GKEY)).toBeNull();
    b.tracker.stop();
    // And the end is on disk.
    const c = rig({ path, beeper: false });
    expect(c.store.olderOf(GKEY)).toBeNull();
    expect((await c.call("get_older_unread", { source: "gmail" })).items).toEqual([]);
  }, 20_000);

  test("the owner's Done stays Done, set before the press and during the walk; noise stays out", async () => {
    const noiseThread = mail(9 * DAY, { subject: "Sale" });
    const doneDuring = mail(12 * DAY);
    const r = await start({ noisy: (id) => id === thread(noiseThread) });
    expect(r.tracker.setByOwner(thread(r.old[0]!), false)).toBe(false);
    r.tracker.setByOwner(thread(doneDuring), false);
    await r.call("add_older_unread", { source: GKEY });
    await settle(r.tracker);
    expect(r.store.isTodo(thread(r.old[0]!))).toBe(false);
    expect(r.store.isTodo(thread(doneDuring))).toBe(false);
    expect(r.store.isTodo(thread(r.old[1]!))).toBe(true);
    expect(r.store.isTodo(thread(noiseThread))).toBe(false);
    expect(r.store.entry(thread(noiseThread))).toBeUndefined();
    // A Done after it came in stays too, and nothing runs again.
    r.tracker.setByOwner(thread(r.old[1]!), false);
    await r.tracker.sync();
    expect(r.store.isTodo(thread(r.old[1]!))).toBe(false);
  });

  test("the first run not over yet: a press waits for it, and both end", async () => {
    const old = mail(8 * DAY);
    const recent = mail(DAY);
    const { store, tracker, call } = rig({ beeper: false });
    store.meet(GKEY);
    expect((await call("add_older_unread", { source: GKEY })).adding).toBe(true);
    await settle(tracker);
    expect(store.meet(GKEY).done).toBe(true);
    expect([store.isTodo(thread(old)), store.isTodo(thread(recent))]).toEqual([true, true]);
  });

  test("events: a few per page, not one per thread", async () => {
    for (let i = 0; i < 20; i++) mail(8 * DAY + i);
    const { tracker, call, told, store } = rig({ beeper: false });
    await tracker.sync();
    told.length = 0;
    await call("add_older_unread", { source: GKEY });
    await settle(tracker);
    expect(store.count(GKEY)).toBe(20);
    expect(told.length).toBe(3);
    expect(told.every((t) => t.flag)).toBe(true);
  });

  test("the account removed during the walk: nothing of it comes back", async () => {
    for (let i = 0; i < 130; i++) mail(8 * DAY + i);
    const { store, tracker, call } = rig({ beeper: false });
    await tracker.sync();
    fg.google.latencyMs = 40;
    await call("add_older_unread", { source: GKEY });
    await Bun.sleep(10);
    tracker.forgetAccount(OWNER_EMAIL);
    await settle(tracker);
    fg.google.latencyMs = 0;
    expect(store.todoOf(GKEY).length).toBe(0);
  }, 20_000);

  test("each account on its own: a second one connected later has its own cut and its own line, and the first is not touched", async () => {
    const path = tmpFile();
    const mine = mail(30 * DAY);
    writeFileSync(path, JSON.stringify({ v: 1, sources: [[GKEY, { since: T0 - 20 * DAY, done: true, synced: T0 }]], entries: [] }));
    await gmail.accounts.add(OTHER_EMAIL, fg.google.issueRefreshToken(OTHER_EMAIL));
    const other = fg.google.mailbox(OTHER_EMAIL);
    other.messages.clear();
    const OKEY = `gmail:${OTHER_EMAIL}`;
    const old = fg.google.deliver(OTHER_EMAIL, { from: "A <a@example.com>", subject: "Hi", text: "x", at: T0 + DAY - 8 * DAY, labels: INBOX }).threadId;
    clock.now = T0 + DAY;
    const { store, tracker, call } = rig({ path, beeper: false });
    await tracker.sync();
    expect(store.meet(GKEY).cut).toBeUndefined();
    expect(store.meet(OKEY).cut).toBe(T0 + DAY - 7 * DAY);
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([{ source: OKEY, count: 1, adding: false, counting: false }]);
    await call("add_older_unread", { source: OKEY });
    await settle(tracker);
    await tracker.sync();
    expect(store.isTodo(gmailChatID(OTHER_EMAIL, old))).toBe(true);
    expect(store.entry(thread(mine))).toBeUndefined();
  });

  test("a source nobody knows: no, and it stays unknown", async () => {
    const { store, call } = rig({ beeper: false });
    expect(await call("add_older_unread", { source: "gmail:nobody@example.com" })).toEqual({ source: "gmail:nobody@example.com", adding: false });
    expect(store.olderOf("gmail:nobody@example.com")).toBeNull();
    expect(await call("add_older_unread", { source: "__proto__" })).toEqual({ source: "__proto__", adding: false });
  });
});

describe("the count", () => {
  /** A Gmail account whose threadIDs calls are counted. */
  const spied = () => {
    const calls = { n: 0 };
    return { calls, sources: () => gmail.sources().map((s) => ({ ...s, threadIDs: (...a: Parameters<typeof s.threadIDs>) => (calls.n++, s.threadIDs(...a)) })) };
  };
  const gmailItems = async (call: Rig["call"]) => (await call("get_older_unread", { source: "gmail" })).items;
  const beeperItems = async (call: Rig["call"]) => (await call("get_older_unread", { source: "beeper" })).items;
  const onDisk = (path: string, key: string) => JSON.parse(readFileSync(path, "utf8")).sources.find((s: any) => s[0] === key)[1];

  test("Gmail: 2,500 older unread are 2,500, through the first run's walk; fake Google's estimate says 201 and nothing reads it", async () => {
    for (let i = 0; i < 2500; i++) mail(8 * DAY + i * 1000);
    const { tracker, call, store } = rig({ beeper: false });
    await tracker.sync();
    expect(store.meet(GKEY).done).toBe(true);
    expect(lists().filter((r) => r.q === Q_BEFORE).length).toBe(25);
    expect(threadReads()).toEqual([]);
    expect(store.size).toBe(0);
    fg.google.requests.length = 0;
    expect(await gmailItems(call)).toEqual([{ source: GKEY, count: 2500, adding: false, counting: false }]);
    expect(fg.google.requests).toEqual([]);
  }, 120_000);

  test("Gmail: on disk with done, and it holds across a restart with no call", async () => {
    const path = tmpFile();
    for (let i = 0; i < 130; i++) mail(8 * DAY + i);
    const a = rig({ path, beeper: false });
    await a.tracker.sync();
    a.tracker.stop();
    expect(onDisk(path, GKEY)).toMatchObject({ done: true, olderLeft: 130 });
    fg.google.requests.length = 0;
    const b = rig({ path, beeper: false });
    expect(await gmailItems(b.call)).toEqual([{ source: GKEY, count: 130, adding: false, counting: false }]);
    expect(fg.google.requests).toEqual([]);
  });

  test("Gmail: a restart in the middle counts again from the top, once each; what became known meanwhile is not counted", async () => {
    const path = tmpFile();
    const old = Array.from({ length: 130 }, (_, i) => mail(8 * DAY + i));
    fg.google.failNext({ path: /\/threads$/, search: /before.*pageToken/, status: 400 });
    const a = rig({ path, beeper: false });
    await a.tracker.sync();
    expect(a.store.meet(GKEY).done).toBe(false);
    expect(await gmailItems(a.call)).toEqual([{ source: GKEY, count: null, adding: false, counting: true }]);
    a.store.setOwner(thread(old[129]!), false);
    a.tracker.stop();
    expect(onDisk(path, GKEY).olderLeft).toBeUndefined();
    const b = rig({ path, beeper: false });
    await b.tracker.sync();
    expect(await gmailItems(b.call)).toEqual([{ source: GKEY, count: 129, adding: false, counting: false }]);
  });

  test("Gmail: not counted: noise, what is known, what is active since the cut (marked instead), what is also unread since the cut, what is read or elsewhere", async () => {
    const counted = mail(8 * DAY);
    const noisy = mail(9 * DAY);
    const done = mail(10 * DAY);
    const active = mail(30 * DAY);
    fg.google.deliver(OWNER_EMAIL, { from: "A <a@example.com>", subject: "Hello", text: "x", at: T0 - DAY, labels: ["INBOX", "CATEGORY_PERSONAL"], threadId: active });
    const activeNoise = mail(31 * DAY);
    fg.google.deliver(OWNER_EMAIL, { from: "A <a@example.com>", subject: "Hello", text: "x", at: T0 - DAY, labels: ["INBOX", "CATEGORY_PERSONAL"], threadId: activeNoise });
    const both = mail(32 * DAY);
    fg.google.deliver(OWNER_EMAIL, { from: "A <a@example.com>", subject: "Hello", text: "x", at: T0 - DAY, labels: INBOX, threadId: both });
    mail(33 * DAY, { labels: ["INBOX", "CATEGORY_PERSONAL"] });
    mail(34 * DAY, { labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] });
    mail(35 * DAY, { labels: ["UNREAD", "CATEGORY_PERSONAL"] });
    const noise = new Set([thread(noisy), thread(activeNoise)]);
    const { store, tracker, call } = rig({ beeper: false, noisy: (id) => noise.has(id) });
    store.meet(GKEY);
    store.setOwner(thread(done), false);
    await tracker.sync();
    expect(store.isTodo(thread(active))).toBe(true);
    expect(store.isTodo(thread(both))).toBe(true);
    expect(store.entry(thread(activeNoise))).toBeUndefined();
    expect(store.entry(thread(counted))).toBeUndefined();
    expect(await gmailItems(call)).toEqual([{ source: GKEY, count: 1, adding: false, counting: false }]);
  });

  test("Gmail: the older walk runs with nothing active since the cut too; none left out is a count of 0", async () => {
    const { store, tracker, call } = rig({ beeper: false });
    await tracker.sync();
    expect(lists().map((r) => r.q)).toEqual([Q_SINCE, Q_ACTIVE, Q_BEFORE]);
    expect(store.olderLeft(GKEY)).toBe(0);
    expect(await gmailItems(call)).toEqual([{ source: GKEY, count: 0, adding: false, counting: false }]);
  });

  test("get_older_unread makes no threadIDs call, nor any other, before, during or after the first run", async () => {
    mail(8 * DAY);
    const { calls, sources } = spied();
    fg.google.failNext({ path: /\/threads$/, search: /before/, status: 400 });
    const { tracker, call } = rig({ beeper: false, sources });
    expect(await gmailItems(call)).toEqual([{ source: GKEY, count: null, adding: false, counting: true }]);
    expect(calls.n).toBe(0);
    await tracker.sync();
    const walked = calls.n;
    expect(walked).toBe(3);
    fg.google.requests.length = 0;
    expect(await gmailItems(call)).toEqual([{ source: GKEY, count: null, adding: false, counting: true }]);
    await tracker.sync();
    const after = calls.n;
    expect(await gmailItems(call)).toEqual([{ source: GKEY, count: 1, adding: false, counting: false }]);
    expect(calls.n).toBe(after);
    // And Google down changes nothing about it.
    fg.google.failNext({ path: /\/threads$/, status: 500, times: 5 });
    expect(await gmailItems(call)).toEqual([{ source: GKEY, count: 1, adding: false, counting: false }]);
    expect(calls.n).toBe(after);
  });

  test("counting until the first run has ended, also behind a press; a press waiting keeps counting true, and its number comes off as the walk takes", async () => {
    mail(8 * DAY);
    mail(9 * DAY);
    const { store, tracker, call } = rig({ beeper: false });
    store.meet(GKEY);
    await call("add_older_unread", { source: GKEY });
    expect(await gmailItems(call)).toEqual([{ source: GKEY, count: null, adding: true, counting: true }]);
    await settle(tracker);
    expect(await gmailItems(call)).toEqual([]);
    expect(store.count(GKEY)).toBe(2);
  });

  test("a source whose first run ended with no number kept: not known, not counting, no call", async () => {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify({ v: 1, sources: [[GKEY, { since: T0, done: true, synced: T0, cut: T0 - 7 * DAY }]], entries: [] }));
    const { call } = rig({ path, beeper: false });
    expect(await gmailItems(call)).toEqual([{ source: GKEY, count: null, adding: false, counting: false }]);
    expect(lists()).toEqual([]);
  });

  test("Beeper: exact, without noise, archived, low priority, read, recent or known chats; on disk with done; Beeper is not asked and may be down", async () => {
    const path = tmpFile();
    quietBeeper();
    beeperChat(CHAT_IDS.imessageAlice, 8 * DAY, 1);
    beeperChat(CHAT_IDS.pinnedUnread, 9 * DAY, 2);
    beeperChat(CHAT_IDS.muted, 9 * DAY, 2);
    beeperChat(CHAT_IDS.longHistory, 9 * DAY, 2);
    beeperChat(CHAT_IDS.bigGroup, 9 * DAY, 2);
    beeperChat(CHAT_IDS.imessageLong, 1 * DAY, 2);
    fb.state.chats.get(CHAT_IDS.muted)!.isArchived = true;
    fb.state.chats.get(CHAT_IDS.longHistory)!.isLowPriority = true;
    const { store, tracker, call } = rig({ path, email: false, noisy: (id) => id === CHAT_IDS.bigGroup });
    store.meet(BEEPER_SOURCE);
    store.setOwner(CHAT_IDS.pinnedUnread, false);
    await tracker.sync();
    store.flush();
    expect(onDisk(path, BEEPER_SOURCE)).toMatchObject({ done: true, olderLeft: 1 });
    const asked = fb.state.calls.length;
    fb.failNext({ method: "GET", path: "/v1/chats", status: 500 });
    expect(await beeperItems(call)).toEqual([{ source: "beeper", count: 1, adding: false, counting: false }]);
    expect(fb.state.calls.length).toBe(asked);
  });

  test("Beeper: counting until its walk ends; a restart in the middle counts again from the top, once each", async () => {
    const path = tmpFile();
    quietBeeper();
    beeperChat(CHAT_IDS.imessageAlice, 8 * DAY, 1);
    // Older than the fixture's quiet chats: on the walk's last page.
    beeperChat(CHAT_IDS.imessageLong, 90 * DAY, 1);
    const a = rig({ path, email: false, laterPagesFail: { on: true } });
    a.store.meet(BEEPER_SOURCE);
    const asked = fb.state.calls.length;
    expect(await beeperItems(a.call)).toEqual([{ source: "beeper", count: null, adding: false, counting: true }]);
    expect(fb.state.calls.length).toBe(asked);
    await a.tracker.sync();
    expect(a.store.meet(BEEPER_SOURCE).done).toBe(false);
    expect(await beeperItems(a.call)).toEqual([{ source: "beeper", count: null, adding: false, counting: true }]);
    a.tracker.stop();
    expect(onDisk(path, BEEPER_SOURCE).olderLeft).toBeUndefined();
    const b = rig({ path, email: false });
    await b.tracker.sync();
    expect(await beeperItems(b.call)).toEqual([{ source: "beeper", count: 2, adding: false, counting: false }]);
    b.store.flush();
    expect(onDisk(path, BEEPER_SOURCE)).toMatchObject({ done: true, olderLeft: 2 });
  });

  test("a Gmail account not met yet is met by asking, and says it is counting: its line comes by itself when its first run ends, from that moment", async () => {
    const old = mail(8 * DAY);
    const { store, tracker, call } = rig({ beeper: false });
    expect(await gmailItems(call)).toEqual([{ source: GKEY, count: null, adding: false, counting: true }]);
    expect(store.meet(GKEY)).toEqual({ since: T0, done: false, synced: T0, cut: T0 - 7 * DAY });
    expect(store.entry(thread(old))).toBeUndefined();
    expect(lists()).toEqual([]);
    await tracker.sync();
    expect(await gmailItems(call)).toEqual([{ source: GKEY, count: 1, adding: false, counting: false }]);
  });
});

describe("Add older unread, Beeper", () => {
  function chats() {
    quietBeeper();
    beeperChat(CHAT_IDS.imessageAlice, 8 * DAY, 1);
    beeperChat(CHAT_IDS.pinnedUnread, 9 * DAY, 2);
    beeperChat(CHAT_IDS.muted, 10 * DAY, 2);
    beeperChat(CHAT_IDS.longHistory, 11 * DAY, 2);
    beeperChat(CHAT_IDS.bigGroup, 1 * DAY, 2);
  }

  test("count, press twice, walk: they come in with their times, Beeper is not touched; noise and the owner's Done stay as they are", async () => {
    chats();
    const { store, tracker, call } = rig({ email: false, noisy: (id) => id === CHAT_IDS.longHistory });
    await tracker.sync();
    expect((await call("get_older_unread", { source: "beeper" })).items).toEqual([{ source: "beeper", count: 3, adding: false, counting: false }]);
    tracker.setByOwner(CHAT_IDS.muted, false);
    expect((await call("add_older_unread", { source: "beeper" })).adding).toBe(true);
    expect((await call("add_older_unread", { source: "beeper" })).adding).toBe(true);
    await settle(tracker);
    expect(store.isTodo(CHAT_IDS.imessageAlice)).toBe(true);
    expect(store.isTodo(CHAT_IDS.pinnedUnread)).toBe(true);
    expect(store.entry(CHAT_IDS.imessageAlice)!.others).toBeGreaterThan(0);
    expect(store.isTodo(CHAT_IDS.muted)).toBe(false);
    expect(store.isTodo(CHAT_IDS.longHistory)).toBe(false);
    expect(beeperReadState()).toEqual([]);
    expect(fb.state.chats.get(CHAT_IDS.pinnedUnread)!.unreadCount).toBe(2);
    expect((await call("get_older_unread", { source: "beeper" })).items).toEqual([]);
    expect(await call("add_older_unread", { source: "beeper" })).toEqual({ source: "beeper", adding: false });
  });

  test("across a restart, with Beeper down in the middle", async () => {
    chats();
    // Older than the fixture's quiet chats: on the walk's last page.
    beeperChat(CHAT_IDS.imessageLong, 90 * DAY, 1);
    const path = tmpFile();
    const failing = { on: false };
    const a = rig({ path, email: false, laterPagesFail: failing });
    await a.tracker.sync();
    failing.on = true;
    expect((await a.call("add_older_unread", { source: "beeper" })).adding).toBe(true);
    await a.tracker.sync();
    expect(a.store.isTodo(CHAT_IDS.pinnedUnread)).toBe(true);
    expect(a.store.isTodo(CHAT_IDS.imessageLong)).toBe(false);
    expect(a.store.olderOf(BEEPER_SOURCE)!.asked).toBe(true);
    a.tracker.setByOwner(CHAT_IDS.pinnedUnread, false);
    a.tracker.stop();
    const b = rig({ path, email: false });
    expect((await b.call("get_older_unread", { source: "beeper" })).items).toEqual([{ source: "beeper", count: null, adding: true, counting: false }]);
    await b.tracker.sync();
    expect(b.store.isTodo(CHAT_IDS.imessageLong)).toBe(true);
    // What the owner did in between stands.
    expect(b.store.isTodo(CHAT_IDS.pinnedUnread)).toBe(false);
    expect(b.store.olderOf(BEEPER_SOURCE)).toBeNull();
  });

  test("a chat first seen after the press is judged by the walk, and a read one stays out", async () => {
    chats();
    const { store, tracker, call } = rig({ email: false });
    await tracker.sync();
    fb.state.chats.get(CHAT_IDS.muted)!.unreadCount = 0;
    await call("add_older_unread", { source: "beeper" });
    await settle(tracker);
    expect(store.isTodo(CHAT_IDS.muted)).toBe(false);
    expect(store.isTodo(CHAT_IDS.imessageAlice)).toBe(true);
  });
});

describe("Add older unread at the store's bound", () => {
  const OTHER = "gmail:other@example.com";
  const elsewhere = (i: number) => `${OTHER}:${i.toString(16).padStart(16, "a")}`;
  const line = async (call: Rig["call"]) => (await call("get_older_unread", { source: "gmail" })).items;

  test("a store full of handled chats is not full: they make room, the older unread all come in, the line ends, nothing is said to be full", async () => {
    const old = [mail(8 * DAY), mail(9 * DAY), mail(10 * DAY)];
    const { store, tracker, call, told } = rig({ beeper: false, max: 10 });
    await tracker.sync();
    for (let i = 0; i < 10; i++) store.setOwner(elsewhere(i), false);
    expect(await line(call)).toEqual([{ source: GKEY, count: 3, adding: false, counting: false }]);
    told.length = 0;
    expect((await call("add_older_unread", { source: GKEY })).adding).toBe(true);
    await settle(tracker);
    expect(old.map((t) => store.isTodo(thread(t)))).toEqual([true, true, true]);
    expect(store.count(GKEY)).toBe(3);
    expect(store.size).toBe(10);
    expect(store.overflowed()).toBe(false);
    expect(store.olderOf(GKEY)).toBeNull();
    expect(told.filter((t) => !t.flag)).toEqual([]);
  });

  test("To do itself full: no one's place is taken; the rest stays a line that can be pressed again; a Done makes the notice go, and a press brings more", async () => {
    const old = Array.from({ length: 20 }, (_, i) => mail(8 * DAY + i));
    const { store, tracker, call, told } = rig({ beeper: false, max: 10 });
    await tracker.sync();
    for (let i = 0; i < 6; i++) store.setOwner(elsewhere(i), true);
    told.length = 0;
    await call("add_older_unread", { source: GKEY });
    await settle(tracker);
    expect(store.count(GKEY)).toBe(4);
    expect(store.size).toBe(10);
    for (let i = 0; i < 6; i++) expect(store.isTodo(elsewhere(i))).toBe(true);
    expect(store.overflowed()).toBe(true);
    expect(told.filter((t) => !t.flag)).toEqual([]);
    // Not used up: it says what is still left out, and it is not "adding".
    expect(store.olderOf(GKEY)).toEqual({ cut: T0 - 7 * DAY, asked: false, done: true });
    expect(await line(call)).toEqual([{ source: GKEY, count: 16, adding: false, counting: false }]);
    // The owner makes room: the notice goes, though the Done chats are still kept.
    for (let i = 0; i < 6; i++) store.setOwner(elsewhere(i), false);
    expect(store.size).toBe(10);
    expect(store.overflowed()).toBe(false);
    await call("add_older_unread", { source: GKEY });
    await settle(tracker);
    expect(store.count(GKEY)).toBe(10);
    expect(await line(call)).toEqual([{ source: GKEY, count: 10, adding: false, counting: false }]);
    for (const t of old.slice(0, 10)) store.setOwner(thread(t), false);
    await call("add_older_unread", { source: GKEY });
    await settle(tracker);
    // The walk's end, with room: over, and the owner's Done still Done.
    expect(store.olderOf(GKEY)).toBeNull();
    expect(old.slice(10).every((t) => store.isTodo(thread(t)))).toBe(true);
    expect(old.slice(0, 10).some((t) => store.isTodo(thread(t)))).toBe(false);
    expect(store.overflowed()).toBe(false);
  });

  test("the line that came back survives a restart as a line, and no walk starts by itself", async () => {
    const path = tmpFile();
    for (let i = 0; i < 4; i++) mail(8 * DAY + i);
    const a = rig({ path, beeper: false, max: 2 });
    await a.tracker.sync();
    await a.call("add_older_unread", { source: GKEY });
    await settle(a.tracker);
    expect(a.store.count(GKEY)).toBe(2);
    a.tracker.stop();
    fg.google.requests.length = 0;
    const b = rig({ path, beeper: false, max: 2 });
    await b.tracker.sync();
    expect(lists().filter((r) => r.q?.includes("before:"))).toEqual([]);
    expect(await line(b.call)).toEqual([{ source: GKEY, count: 2, adding: false, counting: false }]);
  });

  test("a Done that made room is not brought back by the walk that met it later", async () => {
    // The owner's Done threads are the oldest, so the walk (newest first) reaches them after they went for the bound.
    const done = [mail(90 * DAY), mail(91 * DAY)];
    const fresh = [mail(8 * DAY), mail(9 * DAY)];
    const { store, tracker, call } = rig({ beeper: false, max: 2 });
    await tracker.sync();
    for (const t of done) store.setOwner(thread(t), false);
    expect(await line(call)).toEqual([{ source: GKEY, count: 4, adding: false, counting: false }]);
    await call("add_older_unread", { source: GKEY });
    await settle(tracker);
    expect(fresh.map((t) => store.isTodo(thread(t)))).toEqual([true, true]);
    expect(done.map((t) => store.isTodo(thread(t)))).toEqual([false, false]);
    expect(store.olderOf(GKEY)).toBeNull();
  });

  test("a Done forgotten for the bound before the press stays Done too, across a restart; when the walk is over nothing of it is kept", async () => {
    const path = tmpFile();
    const done = mail(90 * DAY);
    const a = rig({ path, beeper: false, max: 2 });
    await a.tracker.sync();
    a.store.setOwner(thread(done), false);
    a.store.setOwner(elsewhere(1), true);
    a.store.setOwner(elsewhere(2), true);
    expect(a.store.entry(thread(done))).toBeUndefined();
    // As of the first run, which is why the line says "About".
    expect(await line(a.call)).toEqual([{ source: GKEY, count: 1, adding: false, counting: false }]);
    a.tracker.stop();
    const b = rig({ path, beeper: false, max: 4 });
    expect(await line(b.call)).toEqual([{ source: GKEY, count: 1, adding: false, counting: false }]);
    await b.call("add_older_unread", { source: GKEY });
    await settle(b.tracker);
    expect(b.store.isTodo(thread(done))).toBe(false);
    b.store.flush();
    const saved = JSON.parse(readFileSync(path, "utf8")).sources.find((s: any) => s[0] === GKEY)[1];
    expect(saved.older).toBe("added");
    expect(saved.forgot).toBeUndefined();
  });

  test("what is kept of a forgotten Done is bounded, a hash, and only where a walk can still come", () => {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify({ v: 1, sources: [[BEEPER_SOURCE, { since: T0, done: true, synced: T0 }], [GKEY, { since: T0, done: true, synced: T0, cut: T0 - 7 * DAY, forgot: ["ok", 5, "x".repeat(99)] }]], entries: [] }));
    const loaded = new TodoStore({ path, now: () => clock.now, max: 2 });
    for (const id of ["c1", "c2", "c3"]) loaded.setOwner(id, false);
    for (const id of ["a", "b"]) loaded.setOwner(thread(id.repeat(16)), false);
    loaded.setOwner(thread("c".repeat(16)), true);
    loaded.setOwner(thread("d".repeat(16)), true);
    loaded.flush();
    const saved = JSON.parse(readFileSync(path, "utf8"));
    const of = (k: string) => saved.sources.find((s: any) => s[0] === k)[1];
    // A source with no cut has no walk to come, and gets nothing.
    expect(of(BEEPER_SOURCE).forgot).toBeUndefined();
    expect(of(GKEY).forgot.length).toBeLessThanOrEqual(3);
    expect(of(GKEY).forgot[0]).toBe("ok");
    for (const h of of(GKEY).forgot) expect(h.length).toBeLessThanOrEqual(16);
  });

  test("Beeper: handled chats make room there too, a Done forgotten stays Done", async () => {
    quietBeeper();
    beeperChat(CHAT_IDS.imessageAlice, 8 * DAY, 1);
    beeperChat(CHAT_IDS.pinnedUnread, 9 * DAY, 2);
    beeperChat(CHAT_IDS.muted, 60 * DAY, 2);
    const { store, tracker, call } = rig({ email: false, max: 2 });
    await tracker.sync();
    store.setOwner(CHAT_IDS.muted, false);
    store.setOwner("other-1", false);
    store.setOwner("other-2", false);
    // As the first run counted them: the Done came after it.
    expect((await call("get_older_unread", { source: "beeper" })).items).toEqual([{ source: "beeper", count: 3, adding: false, counting: false }]);
    await call("add_older_unread", { source: "beeper" });
    await settle(tracker);
    expect(store.isTodo(CHAT_IDS.imessageAlice)).toBe(true);
    expect(store.isTodo(CHAT_IDS.pinnedUnread)).toBe(true);
    expect(store.isTodo(CHAT_IDS.muted)).toBe(false);
    expect(store.olderOf(BEEPER_SOURCE)).toBeNull();
    expect(store.overflowed()).toBe(false);
  });

  test("a source that is done with no cut: the notice goes by what is To do, and nothing else about it changes", () => {
    const store = new TodoStore({ now: () => clock.now, max: 4 });
    store.meet(BEEPER_SOURCE);
    store.finishFirstRun(BEEPER_SOURCE);
    for (const id of ["a", "b", "c", "d", "e"]) {
      clock.now += 1000;
      store.noteOthers(id, clock.now);
    }
    expect(store.overflowed()).toBe(true);
    store.setOwner("b", false);
    // Four kept, three of them To do: still what is kept, and room to say so no more.
    expect(store.size).toBe(4);
    expect(store.overflowed()).toBe(false);
  });

  describe("what is left when the bound stopped a walk of many pages", () => {
    // Newest first, so a walk takes them in this order.
    const many = (n: number) => Array.from({ length: n }, (_, i) => mail(8 * DAY + i * 1000));
    const stopped = async (n: number, max: number, o: Parameters<typeof rig>[0] = {}) => {
      const old = many(n);
      const r = rig({ beeper: false, max, ...o });
      await r.tracker.sync();
      await r.call("add_older_unread", { source: GKEY });
      await settle(r.tracker);
      return { ...r, old };
    };

    for (const [n, max] of [[600, 500], [1200, 1000]] as const)
      test(`${n} older, room for ${max}: the line says what is truly left`, async () => {
        const { store, call, old } = await stopped(n, max);
        expect(store.count(GKEY)).toBe(max);
        expect(old.slice(0, max).every((t) => store.isTodo(thread(t)))).toBe(true);
        expect(old.slice(max).some((t) => store.isTodo(thread(t)))).toBe(false);
        fg.google.requests.length = 0;
        expect(await line(call)).toEqual([{ source: GKEY, count: n - max, adding: false, counting: false }]);
        // Read from the store.
        expect(lists()).toEqual([]);
        expect(threadReads()).toEqual([]);
      }, 60_000);

    test("what the walk goes past without taking was never in the number: noise and what was known come off nothing", async () => {
      const old = many(300);
      const noisy = new Set(old.slice(0, 20).map(thread));
      const { store, tracker, call } = rig({ beeper: false, max: 100, noisy: (id) => noisy.has(id) });
      await tracker.sync();
      expect(await line(call)).toEqual([{ source: GKEY, count: 280, adding: false, counting: false }]);
      await call("add_older_unread", { source: GKEY });
      await settle(tracker);
      expect(store.count(GKEY)).toBe(100);
      // 100 taken and 20 of noise are behind the walk: 180 are left.
      expect(await line(call)).toEqual([{ source: GKEY, count: 180, adding: false, counting: false }]);
    }, 60_000);

    test("it holds across a restart", async () => {
      const path = tmpFile();
      const a = await stopped(600, 500, { path });
      expect(await line(a.call)).toEqual([{ source: GKEY, count: 100, adding: false, counting: false }]);
      a.tracker.stop();
      const b = rig({ path, beeper: false, max: 500 });
      expect(await line(b.call)).toEqual([{ source: GKEY, count: 100, adding: false, counting: false }]);
    }, 60_000);

    test("a walk that restarts on the way and is stopped after: what it took before the restart stays off the number", async () => {
      const path = tmpFile();
      many(300);
      const a = rig({ path, beeper: false, max: 150 });
      await a.tracker.sync();
      // Twice: the press's own sync, and the one this asks for after it.
      fg.google.failNext({ path: /\/threads$/, search: /before.*pageToken/, status: 400, times: 2 });
      await a.call("add_older_unread", { source: GKEY });
      await a.tracker.sync();
      expect(a.store.count(GKEY)).toBe(100);
      expect(a.store.olderOf(GKEY)!.asked).toBe(true);
      a.tracker.stop();
      const b = rig({ path, beeper: false, max: 150 });
      await settle(b.tracker);
      expect(b.store.count(GKEY)).toBe(150);
      expect(await line(b.call)).toEqual([{ source: GKEY, count: 150, adding: false, counting: false }]);
    }, 60_000);

    test("the owner reads what the walk took: as many left, and the line does not vanish", async () => {
      const { call, old } = await stopped(600, 500);
      const box = fg.google.mailbox();
      for (const t of old.slice(0, 200)) for (const m of box.thread(t)) m.labelIds = m.labelIds.filter((l) => l !== "UNREAD");
      expect(await line(call)).toEqual([{ source: GKEY, count: 100, adding: false, counting: false }]);
    }, 60_000);

    test("the number has run lower than what is there (mail turned unread since the first run): never less than the rest of the page, and the walk can go on", async () => {
      const first = many(5);
      const { store, tracker, call } = rig({ beeper: false, max: 50 });
      await tracker.sync();
      expect(store.olderLeft(GKEY)).toBe(5);
      const later = Array.from({ length: 120 }, (_, i) => mail(20 * DAY + i * 1000));
      await call("add_older_unread", { source: GKEY });
      await settle(tracker);
      expect(store.count(GKEY)).toBe(50);
      expect(await line(call)).toEqual([{ source: GKEY, count: 50, adding: false, counting: false }]);
      for (const t of [...first, ...later.slice(0, 45)]) store.setOwner(thread(t), false);
      await call("add_older_unread", { source: GKEY });
      await settle(tracker);
      // 50 more taken, the first page used up: what stopped it was the next page's 25.
      expect(await line(call)).toEqual([{ source: GKEY, count: 25, adding: false, counting: false }]);
      for (const t of later.slice(45, 95)) store.setOwner(thread(t), false);
      await call("add_older_unread", { source: GKEY });
      await settle(tracker);
      expect(store.olderOf(GKEY)).toBeNull();
      expect(later.slice(95).every((t) => store.isTodo(thread(t)))).toBe(true);
    }, 60_000);

    test("Beeper: the same; a second stop takes off only what the second walk took in, and the end ends it", async () => {
      quietBeeper();
      beeperChat(CHAT_IDS.imessageAlice, 8 * DAY, 1);
      beeperChat(CHAT_IDS.pinnedUnread, 9 * DAY, 1);
      beeperChat(CHAT_IDS.muted, 10 * DAY, 1);
      const { store, tracker, call } = rig({ email: false, max: 1 });
      const items = async () => (await call("get_older_unread", { source: "beeper" })).items;
      await tracker.sync();
      expect(await items()).toEqual([{ source: "beeper", count: 3, adding: false, counting: false }]);
      await call("add_older_unread", { source: "beeper" });
      await settle(tracker);
      expect(store.isTodo(CHAT_IDS.imessageAlice)).toBe(true);
      expect(await items()).toEqual([{ source: "beeper", count: 2, adding: false, counting: false }]);
      store.setOwner(CHAT_IDS.imessageAlice, false);
      await call("add_older_unread", { source: "beeper" });
      await settle(tracker);
      expect(store.isTodo(CHAT_IDS.pinnedUnread)).toBe(true);
      expect(await items()).toEqual([{ source: "beeper", count: 1, adding: false, counting: false }]);
      store.setOwner(CHAT_IDS.pinnedUnread, false);
      await call("add_older_unread", { source: "beeper" });
      await settle(tracker);
      expect(store.isTodo(CHAT_IDS.muted)).toBe(true);
      expect(await items()).toEqual([]);
    }, 60_000);

    test("room made and pressed again: stopped again it says the new figure; at the end nothing of it is kept", async () => {
      const path = tmpFile();
      const { store, tracker, call, old } = await stopped(600, 500, { path });
      for (const t of old.slice(0, 60)) store.setOwner(thread(t), false);
      expect(await line(call)).toEqual([{ source: GKEY, count: 100, adding: false, counting: false }]);
      await call("add_older_unread", { source: GKEY });
      await settle(tracker);
      // 60 Done made way for 60 more: 40 left.
      expect(await line(call)).toEqual([{ source: GKEY, count: 40, adding: false, counting: false }]);
      for (const t of old.slice(60, 120)) store.setOwner(thread(t), false);
      await call("add_older_unread", { source: GKEY });
      await settle(tracker);
      expect(store.olderOf(GKEY)).toBeNull();
      store.flush();
      const saved = JSON.parse(readFileSync(path, "utf8")).sources.find((s: any) => s[0] === GKEY)[1];
      expect(saved.older).toBe("added");
      expect(saved.olderLeft).toBeUndefined();
    }, 60_000);

    test("the number in a file: rubbish is dropped, which leaves it not known; a walk that ended keeps none", () => {
      const path = tmpFile();
      const source = (olderLeft: unknown) => [GKEY, { since: T0, done: true, synced: T0, cut: T0 - 7 * DAY, olderLeft }];
      writeFileSync(path, JSON.stringify({ v: 1, sources: [source(100)], entries: [] }));
      expect(new TodoStore({ path, now: () => clock.now }).olderLeft(GKEY)).toBe(100);
      for (const rubbish of ["many", -1, 1.5, null]) {
        writeFileSync(path, JSON.stringify({ v: 1, sources: [source(rubbish)], entries: [] }));
        expect(new TodoStore({ path, now: () => clock.now }).olderLeft(GKEY)).toBeUndefined();
      }
      writeFileSync(path, JSON.stringify({ v: 1, sources: [[GKEY, { since: T0, done: true, synced: T0, cut: T0 - 7 * DAY, older: "added", olderLeft: 100 }]], entries: [] }));
      expect(new TodoStore({ path, now: () => clock.now }).olderLeft(GKEY)).toBeUndefined();
    });
  });

  describe("the list of what was forgotten holds each chat once", () => {
    const hash = (id: string) => createHash("sha256").update(id).digest("base64url").slice(0, 12);
    // A thread of only the owner's messages, as gmail/map.ts leaves it: handled, nothing from anyone else.
    const ownerLast = (at: number): ChatSummary => {
      const c = { id: thread("0".repeat(16)), accountID: "gmail", title: "Mine", type: "group", unreadCount: 0, isArchived: false, isMuted: false, isPinned: false, lastActivity: iso(at), participants: { items: [], hasMore: false, total: 0 } } as unknown as ChatSummary;
      noteThreadOthers(c, null, []);
      return c;
    };

    test("one handled chat seen over and over at the bound does not push out a real Done: it stays Done after the press", async () => {
      const path = tmpFile();
      const done = mail(90 * DAY);
      const { store, tracker, call } = rig({ path, beeper: false, max: 3 });
      await tracker.sync();
      store.setOwner(thread(done), false);
      for (let i = 1; i <= 3; i++) store.setOwner(elsewhere(i), true);
      expect(store.entry(thread(done))).toBeUndefined();
      clock.now += 60_000;
      const row = ownerLast(clock.now);
      for (let i = 0; i < 5000; i++) tracker.seeResult("list_chats", { items: [row] }, { inbox: "primary" });
      expect(store.heardOf(thread(done))).toBe(true);
      store.flush();
      const forgot = JSON.parse(readFileSync(path, "utf8")).sources.find((s: any) => s[0] === GKEY)[1].forgot;
      expect(forgot).toEqual([hash(thread(done)), hash(row.id)]);
      // Room, and the press: the walk meets the Done, and leaves it.
      for (let i = 1; i <= 3; i++) store.setOwner(elsewhere(i), false);
      await call("add_older_unread", { source: GKEY });
      await settle(tracker);
      expect(store.isTodo(thread(done))).toBe(false);
      expect(store.olderOf(GKEY)).toBeNull();
    }, 60_000);

    test("the same chat forgotten again goes to the newest place: what goes first is what was forgotten longest ago", () => {
      const path = tmpFile();
      const store = new TodoStore({ path, now: () => clock.now, max: 1 });
      const [a, b] = [thread("a".repeat(16)), thread("b".repeat(16))];
      store.meet(GKEY);
      for (const id of [a, b, a, b, a]) store.setOwner(id, false);
      store.setOwner(elsewhere(1), true);
      store.flush();
      const saved = JSON.parse(readFileSync(path, "utf8")).sources.find((s: any) => s[0] === GKEY)[1];
      expect(saved.forgot).toEqual([hash(b), hash(a)]);
    });

    test("a file that already holds copies: read once each, the last place kept, and they take no real one's room", () => {
      const path = tmpFile();
      const real = thread("a".repeat(16));
      const forgot = [hash(real), ...Array.from({ length: 5000 }, () => "copy"), "x", "copy"];
      writeFileSync(path, JSON.stringify({ v: 1, sources: [[GKEY, { since: T0, done: true, synced: T0, cut: T0 - 7 * DAY, forgot }]], entries: [] }));
      const store = new TodoStore({ path, now: () => clock.now });
      expect(store.heardOf(real)).toBe(true);
      store.setOwner(elsewhere(1), true);
      const saved = JSON.parse(readFileSync(path, "utf8")).sources.find((s: any) => s[0] === GKEY)[1];
      expect(saved.forgot).toEqual([hash(real), "x", "copy"]);
    });
  });

  describe("the notice goes when room comes by other ways than a Done", () => {
    const pressAtBound = async (o: { max: number; others: number; path?: string }) => {
      const old = Array.from({ length: 5 }, (_, i) => mail(8 * DAY + i));
      const r = rig({ beeper: false, max: o.max, ...(o.path ? { path: o.path } : {}) });
      await r.tracker.sync();
      for (let i = 0; i < o.others; i++) r.store.setOwner(elsewhere(i), true);
      await r.call("add_older_unread", { source: GKEY });
      await settle(r.tracker);
      expect(r.tracker.full()).toBe(true);
      return { ...r, old };
    };

    test("an account removed: nothing is said to be full any more, nor after a restart, and the press brings the rest", async () => {
      const path = tmpFile();
      quietBeeper();
      const { store, tracker, call, old } = await pressAtBound({ max: 10, others: 9, path });
      expect(store.count(GKEY)).toBe(1);
      tracker.forgetAccount("other@example.com");
      expect(store.size).toBe(1);
      expect(tracker.full()).toBe(false);
      expect((await call("unread_summary", { todo: true })).todoFull).toBeUndefined();
      await call("add_older_unread", { source: GKEY });
      await settle(tracker);
      expect(old.every((t) => store.isTodo(thread(t)))).toBe(true);
      expect(store.olderOf(GKEY)).toBeNull();
      expect(tracker.full()).toBe(false);
      tracker.stop();
      const again = new TodoStore({ path, now: () => clock.now, max: 10 });
      expect(again.overflowed()).toBe(false);
      expect(JSON.parse(readFileSync(path, "utf8")).sources.find((s: any) => s[0] === GKEY)[1].full).toBeUndefined();
    }, 60_000);

    test("an account removed that leaves To do still past 90%: the notice stays, since it is still true", async () => {
      const { store, tracker } = await pressAtBound({ max: 20, others: 19 });
      store.setOwner(`gmail:third@example.com:${"e".repeat(16)}`, false);
      tracker.forgetAccount("third@example.com");
      expect(store.count(GKEY)).toBe(1);
      expect(tracker.full()).toBe(true);
    }, 60_000);

    test("a walk that reaches its end with room: the notice goes with it", async () => {
      const { store, tracker, call, old } = await pressAtBound({ max: 10, others: 9 });
      // To do chats gone at the source: room, with no Done and no account removed.
      for (let i = 0; i < 9; i++) {
        store.noteNotFound(elsewhere(i));
        clock.now += GONE_APART_MS;
        store.noteNotFound(elsewhere(i));
      }
      expect(tracker.full()).toBe(true);
      await call("add_older_unread", { source: GKEY });
      await settle(tracker);
      expect(old.every((t) => store.isTodo(thread(t)))).toBe(true);
      expect(store.olderOf(GKEY)).toBeNull();
      expect(tracker.full()).toBe(false);
    }, 60_000);

    test("a walk that reaches its end with To do still past 90%: the notice stays", async () => {
      const { store, tracker, call } = await pressAtBound({ max: 10, others: 9 });
      // Room for exactly what is left, and no more.
      for (let i = 0; i < 4; i++) {
        store.noteNotFound(elsewhere(i));
        clock.now += GONE_APART_MS;
        store.noteNotFound(elsewhere(i));
      }
      await call("add_older_unread", { source: GKEY });
      await settle(tracker);
      expect(store.olderOf(GKEY)).toBeNull();
      expect(store.size).toBe(10);
      expect(tracker.full()).toBe(true);
    }, 60_000);
  });
});

describe("an account removed while something is in flight", () => {
  type Gate = { release: () => void; opened: Promise<void> };
  const gate = (): Gate => {
    let release = () => {};
    const opened = new Promise<void>((r) => (release = r));
    return { release, opened };
  };
  /** A source whose walk waits at the gate, as a slow threads.list does. Everything else about it is the production tracker's. */
  const held = (email: string, ids: string[], g?: Gate, calls: string[] = []) => ({
    email,
    threadIDs: async (q: string) => {
      calls.push(q);
      await g?.opened;
      return { ids, next: null };
    },
    primaryPage: async () => ({ items: [] as ChatSummary[], next: null }),
  });
  const A = "a@example.com";
  const B = "b@example.com";
  const list = (t: Record<string, ReturnType<typeof held>>) => () => Object.values(t);
  const tracker = (store: TodoStore, sources: () => ReturnType<typeof held>[]) => {
    const t = new TodoTracker({ store, gmail: sources, now: () => clock.now, pauseMs: { gmail: 0 } });
    open.push(t);
    return t;
  };
  const unread = (id: string, ago: number): ChatSummary => ({ id, accountID: GKEY, network: "Gmail", title: "T", type: "single", unreadCount: 1, isPinned: false, isMuted: false, isArchived: false, lastActivity: iso(T0 - ago) });

  test("a result that arrives after removal does not make the source known again: a later re-add starts afresh, with its own cut", () => {
    const store = new TodoStore({ now: () => clock.now });
    store.meet(GKEY);
    store.setOwner(thread("a".repeat(16)), false);
    store.forgetSource(GKEY);
    const late = unread(thread("b".repeat(16)), DAY);
    expect(store.see(late)).toEqual({ changed: false, needsRead: false });
    expect(store.noteOthers(thread("c".repeat(16)), T0)).toBe(false);
    expect(store.setOwner(thread("d".repeat(16)), false)).toBe(false);
    store.markUnreadAtFirstRun(thread("e".repeat(16)));
    store.markSynced(GKEY, T0);
    store.finishFirstRun(GKEY);
    expect(store.size).toBe(0);
    expect(store.olderOf(GKEY)).toBeNull();
    clock.now = T0 + 90 * DAY;
    expect(store.meet(GKEY)).toEqual({ since: clock.now, done: false, synced: clock.now, cut: clock.now - 7 * DAY });
    // Known again, it is what it was: a list counts once more.
    expect(store.see(unread(thread("f".repeat(16)), -90 * DAY + 60_000)).changed).toBe(true);
  });

  test("it does not outlive a restart: a source first seen in another run is simply new, and Beeper is never removed", () => {
    const path = tmpFile();
    const a = new TodoStore({ path, now: () => clock.now });
    a.meet(GKEY);
    a.forgetSource(GKEY);
    const b = new TodoStore({ path, now: () => clock.now });
    expect(b.see(unread(thread("a".repeat(16)), DAY)).changed).toBe(true);
    expect(b.meet(GKEY).done).toBe(false);
  });

  test("a first run's page in flight during removal: nothing comes of it, not even the source", async () => {
    const store = new TodoStore({ now: () => clock.now });
    const g = gate();
    const sources: Record<string, ReturnType<typeof held>> = { a: held(A, ["a".repeat(16)], g) };
    const t = tracker(store, list(sources));
    const running = t.sync();
    await Bun.sleep(5);
    delete sources.a;
    t.forgetAccount(A);
    g.release();
    await running;
    expect(store.olderOf(`gmail:${A}`)).toBeNull();
    expect(store.size).toBe(0);
    // And when it is back, its first run is its own.
    clock.now = T0 + 30 * DAY;
    sources.a = held(A, ["b".repeat(16)]);
    await t.sync();
    expect(store.meet(`gmail:${A}`)).toMatchObject({ done: true, since: clock.now, cut: clock.now - 7 * DAY });
    expect(store.isTodo(gmailChatID(A, "a".repeat(16)))).toBe(false);
    expect(store.isTodo(gmailChatID(A, "b".repeat(16)))).toBe(true);
  });

  test("removed while the account before it in the same sync is being walked: it is not met, not asked", async () => {
    const store = new TodoStore({ now: () => clock.now });
    const g = gate();
    const calls: string[] = [];
    const sources: Record<string, ReturnType<typeof held>> = { a: held(A, [], g), b: held(B, [], undefined, calls) };
    const t = tracker(store, list(sources));
    const running = t.sync();
    await Bun.sleep(5);
    delete sources.b;
    t.forgetAccount(B);
    g.release();
    await running;
    expect(calls).toEqual([]);
    expect(store.olderOf(`gmail:${B}`)).toBeNull();
    expect(store.meet(`gmail:${A}`).done).toBe(true);
  });

  test("removed and added again while the old walk is out: the walk goes no further, and the new first run is the one that counts", async () => {
    const store = new TodoStore({ now: () => clock.now });
    const g = gate();
    const sources: Record<string, ReturnType<typeof held>> = { a: held(A, ["a".repeat(16)], g) };
    const t = tracker(store, list(sources));
    const running = t.sync();
    await Bun.sleep(5);
    t.forgetAccount(A);
    clock.now = T0 + DAY;
    const fresh = store.meet(`gmail:${A}`);
    sources.a = held(A, []);
    g.release();
    await running;
    expect(store.isTodo(gmailChatID(A, "a".repeat(16)))).toBe(false);
    expect(store.meet(`gmail:${A}`).cut).toBe(fresh.cut!);
  });

  test("connecting an account this computer does not have clears what a source left on disk says; a reconnect keeps everything", async () => {
    const path = tmpFile();
    const OKEY = `gmail:${OTHER_EMAIL}`;
    writeFileSync(path, JSON.stringify({ v: 1, sources: [[OKEY, { since: T0 - 90 * DAY, done: true, synced: T0 - 90 * DAY }], [GKEY, { since: T0 - 90 * DAY, done: true, synced: T0 }]], entries: [] }));
    const { store, tracker: t } = rig({ path, beeper: false });
    const seen = createGmailService({ secrets: new MemorySecretStore(), refresh: cloudTokenRefresher({ cloudURL: cloud.url, deviceToken: DEVICE_TOKEN }), gmailURL: fg.url, oauthURL: fg.url, onNewAccount: (email) => t.meetAccount(email) });
    expect((await seen.connect(OTHER_EMAIL, fg.google.issueRefreshToken(OTHER_EMAIL), {})).ok).toBe(true);
    expect(store.meet(OKEY)).toEqual({ since: T0, done: false, synced: T0, cut: T0 - 7 * DAY });
    await seen.accounts.add(OWNER_EMAIL, fg.google.issueRefreshToken(OWNER_EMAIL));
    expect((await seen.connect(OWNER_EMAIL, fg.google.issueRefreshToken(OWNER_EMAIL), {})).ok).toBe(true);
    expect(store.meet(GKEY)).toEqual({ since: T0 - 90 * DAY, done: true, synced: T0 });
    expect(store.meet(OKEY).cut).toBe(T0 - 7 * DAY);
  });
});

describe("a first run and a thread whose unread message is older than its activity", () => {
  const INBOX_READ = ["INBOX", "CATEGORY_PERSONAL"];
  const reply = (threadId: string, ago: number, labels: string[]) => fg.google.deliver(OWNER_EMAIL, { from: "A <a@example.com>", subject: "Hello", text: "x", at: T0 - ago, labels, threadId });

  test("unread 30 days ago, read reply 2 days ago: To do, as a list would have it, ids only and nothing changed", async () => {
    const both = mail(30 * DAY);
    reply(both, 2 * DAY, INBOX_READ);
    const own = mail(40 * DAY);
    reply(own, DAY, ["SENT"]);
    const onlyOld = mail(30 * DAY);
    const readOld = mail(30 * DAY, { labels: INBOX_READ });
    reply(readOld, DAY, INBOX_READ);
    const oldInPromotions = mail(30 * DAY, { labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] });
    reply(oldInPromotions, DAY, ["INBOX", "CATEGORY_PROMOTIONS"]);
    const { store, tracker, call } = rig({ beeper: false });
    const before = stateOfMailbox();
    await tracker.sync();
    expect(store.isTodo(thread(both))).toBe(true);
    expect(store.isTodo(thread(own))).toBe(true);
    expect(store.entry(thread(onlyOld))).toBeUndefined();
    expect(store.entry(thread(readOld))).toBeUndefined();
    expect(store.entry(thread(oldInPromotions))).toBeUndefined();
    expect(threadReads()).toEqual([]);
    expect(gmailWrites()).toEqual([]);
    expect(stateOfMailbox()).toEqual(before);
    // What came in is not left out any more.
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([{ source: GKEY, count: 1, adding: false, counting: false }]);
  });

  test("the same thread met by a list during the first run gets the same answer: no race decides it", async () => {
    const both = mail(30 * DAY);
    reply(both, 2 * DAY, INBOX_READ);
    const a = rig({ beeper: false });
    a.store.meet(GKEY);
    const r = await a.call("list_chats", { inbox: "primary", accountIDs: [GKEY], limit: 50 });
    expect(r.items.find((c: ChatSummary) => c.id === thread(both)).todo).toBe(true);
    a.store.forgetSource(GKEY);
    a.store.meet(GKEY);
    await a.tracker.sync();
    expect(a.store.isTodo(thread(both))).toBe(true);
  });

  test("a draft is no activity: a list says the same", async () => {
    const drafted = mail(30 * DAY);
    reply(drafted, DAY, ["DRAFT"]);
    const { store, tracker } = rig({ beeper: false });
    await tracker.sync();
    expect(store.entry(thread(drafted))).toBeUndefined();
  });

  test("the owner's Done stands, noise stays out, and a walk that fails on the way starts over without marking the source done", async () => {
    const done = mail(30 * DAY);
    reply(done, DAY, INBOX_READ);
    const noisy = mail(31 * DAY);
    reply(noisy, DAY, INBOX_READ);
    const r = rig({ beeper: false, noisy: (id) => id === thread(noisy) });
    r.store.meet(GKEY);
    r.store.setOwner(thread(done), false);
    fg.google.failNext({ path: /\/threads$/, search: /before/, status: 400 });
    await r.tracker.sync();
    expect(r.store.meet(GKEY).done).toBe(false);
    await r.tracker.sync();
    expect(r.store.meet(GKEY).done).toBe(true);
    expect(r.store.isTodo(thread(done))).toBe(false);
    expect(r.store.isTodo(thread(noisy))).toBe(false);
  });
});

describe("a walk that fails after the press", () => {
  const older = () => [mail(8 * DAY), mail(9 * DAY)];
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 400 && !fn(); i++) await Bun.sleep(5);
  };

  test("Gmail: it is logged, with nothing of the account or a message in it, and tried again long before the half-hourly sync", async () => {
    const old = older();
    const logs: string[] = [];
    const { store, tracker, call } = rig({ beeper: false, logs, olderRetryMs: 20 });
    await tracker.sync();
    logs.length = 0;
    fg.google.failNext({ path: /\/threads$/, status: 400 });
    await call("add_older_unread", { source: GKEY });
    await until(() => store.olderOf(GKEY) === null);
    expect(store.olderOf(GKEY)).toBeNull();
    expect(old.every((t) => store.isTodo(thread(t)))).toBe(true);
    const said = logs.filter((m) => /older unread/.test(m) && !/added/.test(m));
    expect(said.length).toBe(1);
    expect(said[0]).not.toContain(OWNER_EMAIL);
  });

  test("it backs off, and the line says adding while it does: true, since it still is", async () => {
    older();
    const logs: string[] = [];
    const { store, tracker, call } = rig({ beeper: false, logs, olderRetryMs: 40 });
    await tracker.sync();
    logs.length = 0;
    fg.google.failNext({ path: /\/threads$/, status: 400, times: 99 });
    await call("add_older_unread", { source: GKEY });
    await Bun.sleep(250);
    const tries = logs.filter((m) => /older unread/.test(m)).length;
    // 40, 80 and 160 ms apart: three or four, not one per 40 ms.
    expect(tries).toBeGreaterThanOrEqual(2);
    expect(tries).toBeLessThanOrEqual(5);
    expect(store.olderOf(GKEY)!.asked).toBe(true);
    fg.google.reset();
  });

  test("Beeper: the same", async () => {
    quietBeeper();
    beeperChat(CHAT_IDS.pinnedUnread, 9 * DAY, 2);
    const logs: string[] = [];
    const { store, tracker, call } = rig({ email: false, logs, olderRetryMs: 20 });
    await tracker.sync();
    logs.length = 0;
    fb.failNext({ method: "GET", path: "/v1/chats", status: 500, times: 2 });
    await call("add_older_unread", { source: "beeper" });
    await until(() => store.olderOf(BEEPER_SOURCE) === null);
    expect(store.isTodo(CHAT_IDS.pinnedUnread)).toBe(true);
    expect(logs.some((m) => /older unread/.test(m) && !/added/.test(m))).toBe(true);
  });

  test("a first run that fails with a press waiting behind it counts too; with no press it is as it was: quiet, until the next sync", async () => {
    const old = mail(8 * DAY);
    const logs: string[] = [];
    const { store, tracker, call } = rig({ beeper: false, logs, olderRetryMs: 20 });
    store.meet(GKEY);
    fg.google.failNext({ path: /\/threads$/, status: 400 });
    await tracker.sync();
    await Bun.sleep(60);
    expect(store.meet(GKEY).done).toBe(false);
    expect(logs).toEqual([]);
    fg.google.failNext({ path: /\/threads$/, status: 400, times: 2 });
    await call("add_older_unread", { source: GKEY });
    await until(() => store.olderOf(GKEY) === null);
    expect(store.isTodo(thread(old))).toBe(true);
  });

  test("stopped: no retry is left behind", async () => {
    older();
    const { store, tracker, call } = rig({ beeper: false, olderRetryMs: 10 });
    await tracker.sync();
    fg.google.failNext({ path: /\/threads$/, status: 400 });
    await call("add_older_unread", { source: GKEY });
    await Bun.sleep(1);
    tracker.stop();
    fg.google.requests.length = 0;
    await Bun.sleep(40);
    expect(lists()).toEqual([]);
    expect(store.olderOf(GKEY)!.asked).toBe(true);
  });
});

describe("an account that needs reconnecting during the walk", () => {
  test("the line keeps saying it is adding; after the reconnect the walk goes on; removed, nothing is said", async () => {
    const old = mail(8 * DAY);
    let needsSignIn = false;
    const { store, tracker, call } = rig({ beeper: false, sources: () => (needsSignIn ? [] : gmail.sources()) });
    await tracker.sync();
    fg.google.failNext({ path: /\/threads$/, status: 400, times: 2 });
    await call("add_older_unread", { source: GKEY });
    await tracker.sync();
    needsSignIn = true;
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([{ source: GKEY, count: null, adding: true, counting: false }]);
    expect(store.isTodo(thread(old))).toBe(false);
    needsSignIn = false;
    await settle(tracker);
    expect(store.isTodo(thread(old))).toBe(true);
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([]);
  });

  test("not asked for: an account that cannot be asked has no line, and removing one that was asked takes its line", async () => {
    mail(8 * DAY);
    let shown = true;
    const { tracker, call } = rig({ beeper: false, sources: () => (shown ? gmail.sources() : []) });
    await tracker.sync();
    shown = false;
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([]);
    expect((await call("add_older_unread", { source: GKEY })).adding).toBe(true);
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([{ source: GKEY, count: null, adding: true, counting: false }]);
    tracker.forgetAccount(OWNER_EMAIL);
    expect((await call("get_older_unread", { source: "gmail" })).items).toEqual([]);
  });
});

describe("a just-added Gmail account", () => {
  test("says it is counting while another account's first run is still walking, and asks nothing of it", async () => {
    let release = () => {};
    const opened = new Promise<void>((r) => (release = r));
    const A = "a@example.com";
    const store = new TodoStore({ now: () => clock.now });
    const slow = { email: A, threadIDs: async (q: string) => (q.includes("after:") ? await opened : 0, { ids: [], next: null }), primaryPage: async () => ({ items: [] as ChatSummary[], next: null }) };
    const list: any[] = [slow];
    const t = new TodoTracker({ store, gmail: () => list, now: () => clock.now, pauseMs: { gmail: 0 } });
    open.push(t);
    const running = t.sync();
    await Bun.sleep(5);
    await gmail.accounts.add(OWNER_EMAIL, fg.google.issueRefreshToken(OWNER_EMAIL));
    mail(8 * DAY);
    list.push(gmail.source(OWNER_EMAIL));
    fg.google.requests.length = 0;
    const items = t.olderUnread("gmail");
    expect(items.find((i) => i.source === GKEY)).toEqual({ source: GKEY, count: null, adding: false, counting: true });
    expect(lists()).toEqual([]);
    release();
    await running;
    expect(t.olderUnread("gmail").find((i) => i.source === GKEY)).toEqual({ source: GKEY, count: 1, adding: false, counting: false });
  });
});

describe("a damaged file", () => {
  test("says what really comes back: not all that is unread, only what the first run takes", () => {
    const path = tmpFile();
    writeFileSync(path, "{ not json");
    const logs: string[] = [];
    new TodoStore({ path, now: () => clock.now, log: (m) => logs.push(m) });
    const said = logs.join("\n");
    expect(said).toContain("7 days");
    expect(said).not.toContain("what is unread becomes To do again");
  });
});
