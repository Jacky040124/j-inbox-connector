// The noise list of senders, with fake-google and the production paths: the rule (address, domain, case, display
// name, only the newest message, the owner's verdict winning, with no definition and no key), learning from the owner's
// marks, the once-only look at old marks (resumable, across a restart, from an old file), an entry taken off sticking, the walk
// for existing mail, verdicts cleared on removal, To do leaving and coming back, no flash in To do, and what Jev reads.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBeeper, CHAT_IDS, type FakeBeeper } from "@j-inbox/fake-beeper";
import { FAKE_GOOGLE_CLIENT, OTHER_EMAIL, OWNER_EMAIL, startFakeGoogle, type RunningFakeGoogle } from "@j-inbox/fake-google";
import { MAX_NOISE_SENDERS, SENDER_NOISE_REASON, gmailChatID, parseActionResult, parseConnectorFrame, type ActionName, type EventFrame } from "@j-inbox/protocol";
import { createActions } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";
import { createBeeperClient } from "../src/beeper-client.ts";
import { createDispatcher } from "../src/dispatcher.ts";
import { cloudTokenRefresher, createGmailClient } from "../src/gmail/client.ts";
import { threadSendersOf } from "../src/gmail/map.ts";
import { clearOwnAddresses, isAnyOwnAddress, setOwnAddresses } from "../src/gmail/own.ts";
import { createGmailService } from "../src/gmail/service.ts";
import { JEV_MAX_BODY_CHARS, buildJevRequest, conversationOf, exampleOf, type JevConversation } from "../src/noise/jev.ts";
import { NoiseJudge } from "../src/noise/judge.ts";
import { BACKGROUND_BATCH, SenderRules, WALK_MAX_THREADS } from "../src/noise/senders.ts";
import { MAX_EXAMPLES, MAX_EXAMPLE_LENGTH, NoiseStore } from "../src/noise/store.ts";
import { MemorySecretStore } from "../src/secrets.ts";
import { TodoStore } from "../src/todo/store.ts";
import { TodoTracker } from "../src/todo/tracker.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";
import { TEST_JEV_KEY, TEST_JEV_URL, fakeJev, pickLine, type Decide } from "./helpers/fake-jev.ts";

// A cold list reads its threads at Gmail's pace, as in production.
setDefaultTimeout(120_000);

const WARM = "warm@warmup.example.com";
const DAY = 86_400_000;
const chat = (threadId: string, email = OWNER_EMAIL) => gmailChatID(email, threadId);
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "jinbox-senders-")), "noise.json");

let fb: FakeBeeper;
let fg: RunningFakeGoogle;
let cloud: FakeCloud;
beforeAll(async () => {
  fb = await startFakeBeeper();
  fg = await startFakeGoogle();
  cloud = await startFakeCloud({ google: { url: fg.url, clientId: FAKE_GOOGLE_CLIENT.id, clientSecret: FAKE_GOOGLE_CLIENT.secret } });
});
afterAll(() => {
  fb.stop();
  fg.stop();
  cloud.stop();
});
beforeEach(() => {
  fb.reset();
  fg.google.reset();
  clearOwnAddresses();
});

const deliver = (from: string, o: { threadId?: string; subject?: string; at?: number; labels?: string[] } = {}) => fg.google.deliver(OWNER_EMAIL, { from, subject: o.subject ?? "hi", text: "checking in", ...(o.threadId ? { threadId: o.threadId } : {}), ...(o.at !== undefined ? { at: o.at } : {}), ...(o.labels ? { labels: o.labels } : {}) });
const reply = (threadId: string) => deliver(`Owner <${OWNER_EMAIL}>`, { threadId, labels: ["SENT"] });
/** Calls to Gmail for a thread (batched or not), since the log was emptied. */
const threadReads = () => fg.google.requests.filter((r) => /\/threads\/[^/]+$/.test(r.path));

type RigOptions = { path?: string; definition?: string; key?: string | null; decide?: Decide; todo?: boolean; ownAlias?: string; startDelayMs?: number; now?: () => number };
const open: { stop(): void }[] = [];

async function rig(o: RigOptions = {}) {
  const store = new NoiseStore(o.path ? { path: o.path } : {});
  const secrets = new MemorySecretStore();
  if (o.key !== null) await secrets.set("typesafe-api-key", o.key ?? TEST_JEV_KEY);
  const jev = fakeJev(o.decide ?? ((_c, criteria) => pickLine(criteria, /never matches/)));
  const moved: string[] = [];
  const logs: string[] = [];
  let rules: SenderRules;
  const gmail = createGmailService({
    secrets,
    refresh: cloudTokenRefresher({ cloudURL: cloud.url, deviceToken: "jid_" + "A".repeat(43) }),
    gmailURL: fg.url,
    oauthURL: fg.url,
    pollIntervalMs: 3_600_000,
    onChat: (c) => rules.seeChat(c),
    beforeAnnounce: (s, ids) => rules.lookAt(s, ids),
    log: (m) => logs.push(m),
  });
  await gmail.accounts.add(OWNER_EMAIL, fg.google.issueRefreshToken(OWNER_EMAIL));
  setOwnAddresses(OWNER_EMAIL, o.ownAlias ? [o.ownAlias] : []);
  rules = new SenderRules({ store, sources: () => gmail.sources(), known: (e) => gmail.has(e), isOwn: isAnyOwnAddress, onChange: (ids) => moved.push(...ids), log: (m) => logs.push(m), ...(o.now ? { now: o.now } : {}), timing: { startDelayMs: o.startDelayMs ?? 0, pauseMs: 0, retryMs: 5 } });
  const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 });
  const assets = new AssetAllowlist();
  let read: ConstructorParameters<typeof NoiseJudge>[0]["readChat"] = async () => ({ ok: false, error: { code: "INTERNAL", message: "" } });
  const judge = new NoiseJudge({ store, readChat: (p, ctx) => read(p, ctx), apiKey: () => secrets.get("typesafe-api-key"), url: TEST_JEV_URL, fetchImpl: jev.fetchImpl, debounceMs: 60_000, random: () => 0.5, onChange: (ids) => moved.push(...ids), log: (m) => logs.push(m) });
  const todo = o.todo ? new TodoTracker({ store: new TodoStore(), noise: store, gmail: () => gmail.sources(), readChat: (p, ctx) => read(p, ctx), pauseMs: { gmail: 0, beeper: 0 } }) : undefined;
  const actions = createActions(client, { assets, noise: store, ...(todo ? { todo } : {}) });
  const d = createDispatcher({ actions, client, assets, gmail, noise: store, judge, senders: rules, ...(todo ? { todo } : {}) });
  read = d.readChat;
  const call = async <A extends ActionName>(action: A, params: unknown) => {
    const r = await d.dispatch(action, params);
    if (r.kind !== "res") throw new Error("media");
    if (!r.ok) return { error: r.error.code } as const;
    const v = parseActionResult(action, r.data);
    if (!v.ok) throw new Error(`invalid ${action} result: ${JSON.stringify(v.issues)}`);
    return v.value as any;
  };
  if (o.definition) await call("set_noise_definition", { definition: o.definition });
  // As the service does; with no wait in these tests unless one says so.
  rules.start();
  const stopper = { stop: () => (judge.stop(), rules.stop(), todo?.stop(), gmail.stopPolling()) };
  open.push(stopper);
  const ids = async (p: Record<string, unknown>) => (await call("list_chats", { limit: 50, network: "Gmail", ...p })).items.map((c: { id: string }) => c.id) as string[];
  return { store, rules, gmail, judge, jev, moved, logs, call, ids, todo, d, stop: stopper.stop };
}
afterAll(() => {
  for (const x of open) x.stop();
});

const items = (s: NoiseStore) => s.senders().map((e) => `${e.origin}:${e.value}`);

describe("the rule", () => {
  test("an exact address and a whole domain, whatever the case; a subdomain or a longer name is someone else", () => {
    const s = new NoiseStore();
    s.addSender("warm@warmup.example.com", "owner");
    s.addSender("bulk.example.org", "owner");
    expect(s.entryFor("WARM@Warmup.Example.COM")?.value).toBe("warm@warmup.example.com");
    expect(s.entryFor("anyone@BULK.example.org")?.value).toBe("bulk.example.org");
    expect(s.entryFor("other@warmup.example.com")).toBeNull();
    expect(s.entryFor("awarm@warmup.example.com")).toBeNull();
    expect(s.entryFor("anyone@mail.bulk.example.org")).toBeNull();
    expect(s.entryFor("anyone@notbulk.example.org")).toBeNull();
    expect(s.entryFor("anyone@bulk.example.org.evil.example")).toBeNull();
    const id = chat("aaa1");
    expect(s.applyRule([{ chatID: id, lastMessageID: "m1", address: "ANYONE@bulk.example.org".toLowerCase() }], { clear: true, note: false })).toEqual([id]);
    expect(s.noiseOf(id)).toEqual({ reason: SENDER_NOISE_REASON, confidence: 1, source: "sender" });
    expect(s.verdict(id)).toMatchObject({ source: "sender", rule: "bulk.example.org", sender: "anyone@bulk.example.org", lastMessageID: "m1" });
    // A Beeper chat is never caught, whatever its sender looks like.
    expect(s.applyRule([{ chatID: CHAT_IDS.imessageAlice, lastMessageID: "m1", address: WARM }], { clear: true, note: false })).toEqual([]);
    expect(s.isNoise(CHAT_IDS.imessageAlice)).toBe(false);
  });

  test("a display name and odd case in From: the address decides, as Gmail sends it and as the list reads it", async () => {
    const t = await rig();
    await t.call("add_noise_sender", { entry: WARM });
    const named = deliver(`"Warm, Up" <WaRm@WarmUp.Example.com>`);
    const encoded = deliver(`=?UTF-8?B?${Buffer.from("Wärm").toString("base64")}?= <warm@warmup.example.com>`);
    const fooled = deliver(`"warm@warmup.example.com" <someone@example.net>`);
    const primary = await t.ids({ inbox: "primary" });
    expect(primary).not.toContain(chat(named.threadId));
    expect(primary).not.toContain(chat(encoded.threadId));
    expect(primary).toContain(chat(fooled.threadId));
  });

  test("only the newest message counts: someone else replying or the owner's own reply is not caught, and a chat caught before comes back", async () => {
    const t = await rig();
    await t.call("add_noise_sender", { entry: WARM });
    const m = deliver(`Warm <${WARM}>`);
    const id = chat(m.threadId);
    expect(await t.ids({ inbox: "primary" })).not.toContain(id);
    expect(t.store.noiseOf(id)?.source).toBe("sender");
    deliver("Real Person <real@example.net>", { threadId: m.threadId });
    expect(await t.ids({ inbox: "primary" })).toContain(id);
    expect(t.store.isNoise(id)).toBe(false);
    expect(t.moved).toContain(id);
    // Warm writes again: caught again. The owner answers: not caught.
    deliver(`Warm <${WARM}>`, { threadId: m.threadId });
    expect(await t.ids({ inbox: "primary" })).not.toContain(id);
    reply(m.threadId);
    expect(await t.ids({ inbox: "primary" })).toContain(id);
    expect(t.store.isNoise(id)).toBe(false);
    // Earlier mail from the sender in a thread with someone else's newest message: from: lists it, the rule does not take it.
    const other = deliver(`Warm <${WARM}>`, { subject: "other" });
    deliver("Real Person <real@example.net>", { threadId: other.threadId });
    expect(await t.ids({ inbox: "primary" })).toContain(chat(other.threadId));
  });

  test("who wrote in a thread, from its metadata alone: drafts left out, the owner by SENT or by address, an unreadable From is nobody", () => {
    const m = (id: string, at: number, from: string, labels: string[] = ["INBOX"]) => ({ id, threadId: "t1", internalDate: String(at), labelIds: labels, payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: `s${id}` }] } });
    setOwnAddresses(OWNER_EMAIL, ["alias@example.com"]);
    const of = (...messages: unknown[]) => threadSendersOf({ id: "t1", messages }, OWNER_EMAIL);
    expect(of(m("a", 1, "Warm <WARM@Example.com>"))).toEqual({ lastMessageID: "a", newest: "warm@example.com", newestOther: "warm@example.com", sole: "warm@example.com", title: "sa" });
    expect(of(m("a", 1, "W <w@example.com>"), m("b", 2, `Me <${OWNER_EMAIL}>`, ["SENT"]))).toMatchObject({ lastMessageID: "b", newest: null, newestOther: "w@example.com" });
    expect(of(m("a", 1, "W <w@example.com>"), m("b", 2, "Me <alias@example.com>"))).toMatchObject({ newest: null, newestOther: "w@example.com" });
    expect(of(m("a", 1, "W <w@example.com>"), m("b", 2, "Me <me@elsewhere.example>", ["DRAFT"]))).toMatchObject({ lastMessageID: "a", newest: "w@example.com" });
    expect(of(m("a", 1, "no address at all"))).toEqual({ lastMessageID: "a", newest: null, newestOther: null, sole: null, title: "sa" });
    // The one other sender: not in a group, not with an unreadable From among them, as of a time.
    expect(of(m("a", 1, "W <w@example.com>"), m("b", 2, `Me <${OWNER_EMAIL}>`, ["SENT"]), m("c", 3, "W <W@example.com>"))?.sole).toBe("w@example.com");
    expect(of(m("a", 1, "W <w@example.com>"), m("b", 2, "C <c@example.com>"))?.sole).toBeNull();
    expect(of(m("a", 1, "W <w@example.com>"), m("b", 2, "no address"))?.sole).toBeNull();
    expect(threadSendersOf({ id: "t1", messages: [m("a", 1, "W <w@example.com>"), m("b", 5, "C <c@example.com>")] }, OWNER_EMAIL, { until: 3 })?.sole).toBe("w@example.com");
    expect(threadSendersOf({ id: "t1", messages: [m("b", 5, "C <c@example.com>")] }, OWNER_EMAIL, { until: 3 })?.sole).toBeNull();
    expect(of(m("b", 2, "B <b@example.com>"), m("a", 1, "A <a@example.com>"))).toMatchObject({ lastMessageID: "b", newest: "b@example.com" });
    expect(of(m("d", 1, "Me <me@elsewhere.example>", ["DRAFT"]))).toBeNull();
    expect(threadSendersOf({ id: "t1" }, OWNER_EMAIL)).toBeNull();
    expect(threadSendersOf(null, OWNER_EMAIL)).toBeNull();
  });

  test("the owner's Not noise wins, through a list, a read, a walk and new mail; their Mark as noise is not replaced either", async () => {
    const t = await rig();
    const m = deliver(`Warm <${WARM}>`);
    const id = chat(m.threadId);
    expect(await t.call("set_noise", { chatID: id, noise: false })).toEqual({ chatID: id, noise: false });
    await t.call("add_noise_sender", { entry: WARM });
    expect(t.store.applyRule([{ chatID: id, lastMessageID: m.id, address: WARM }], { clear: true, note: true })).toEqual([]);
    expect(await t.ids({ inbox: "primary" })).toContain(id);
    deliver(`Warm <${WARM}>`, { threadId: m.threadId });
    t.judge.touch(id);
    await t.judge.runNow();
    await t.call("read_chat", { chatID: id });
    expect(await t.ids({ inbox: "primary" })).toContain(id);
    expect(t.store.verdict(id)?.source).toBe("owner");
    const mine = deliver(`Warm <${WARM}>`, { subject: "mine" });
    await t.call("set_noise_definition", { definition: "Ads" });
    await t.call("set_noise", { chatID: chat(mine.threadId), noise: true });
    await t.ids({ inbox: "primary" });
    expect(t.store.noiseOf(chat(mine.threadId))?.source).toBe("owner");
  });

  test("no definition and no list: nothing is noise, Jev or no Jev, and nothing is read for it", async () => {
    const t = await rig({ key: null });
    const m = deliver(`Warm <${WARM}>`);
    const id = chat(m.threadId);
    fg.google.requests.length = 0;
    t.judge.touch(id);
    t.judge.touch(CHAT_IDS.imessageAlice);
    expect(t.judge.waiting).toBe(0);
    await t.judge.runNow();
    expect(threadReads()).toEqual([]);
    expect(t.store.active()).toBe(false);
    expect(await t.ids({ inbox: "primary" })).toContain(id);
    // An old file's owner verdict stays off with both empty, as before the list.
    t.store.setOwner(id, true);
    expect(t.store.noiseOf(id)).toBeNull();
    expect(t.store.noiseCount()).toBe(0);
  });

  test("with an empty definition and no key the rule still works: no Jev call, new activity through the judge, only for email", async () => {
    const t = await rig({ key: null });
    await t.call("add_noise_sender", { entry: "warmup.example.com" });
    expect(t.store.judging()).toBe(false);
    expect(t.store.active()).toBe(true);
    const m = deliver(`Warm <${WARM}>`);
    const id = chat(m.threadId);
    const real = deliver("Real <real@example.net>");
    t.judge.touch(id);
    t.judge.touch(chat(real.threadId));
    t.judge.touch(CHAT_IDS.imessageAlice);
    expect(t.judge.waiting).toBe(2);
    await t.judge.runNow();
    expect(t.jev.requests).toEqual([]);
    expect(t.judge.waiting).toBe(0);
    expect(t.store.noiseOf(id)?.source).toBe("sender");
    expect(t.store.verdict(chat(real.threadId))).toBeUndefined();
    expect(t.moved).toEqual([id]);
    expect(await t.ids({ inbox: "low-priority" })).toContain(id);
    expect((await t.call("get_noise_settings", {})).enabled).toBe(false);
    expect((await t.call("get_noise_settings", {})).noiseCount).toBe(1);
    // Jev's verdicts stay off with the definition empty, the list or no list.
    t.store.setJev([{ chatID: chat(real.threadId), noise: true, reason: "x", confidence: 0.9, title: "t", network: "Gmail" }]);
    expect(t.store.noiseOf(chat(real.threadId))).toBeNull();
  });

  test("with a key and no definition: not asked either. With a definition and a key: the rule first, and Jev for the rest", async () => {
    const noDefinition = await rig();
    await noDefinition.call("add_noise_sender", { entry: WARM });
    const a = deliver(`Warm <${WARM}>`);
    noDefinition.judge.touch(chat(a.threadId));
    await noDefinition.judge.runNow();
    expect(noDefinition.jev.requests).toEqual([]);
    expect(noDefinition.store.noiseOf(chat(a.threadId))?.source).toBe("sender");

    const t = await rig({ definition: "Ads", decide: (_c, criteria) => pickLine(criteria, /Ads/) });
    await t.call("add_noise_sender", { entry: WARM });
    const caught = deliver(`Warm <${WARM}>`);
    const asked = deliver("Shop <shop@example.net>");
    t.judge.touch(chat(caught.threadId));
    t.judge.touch(chat(asked.threadId));
    await t.judge.runNow();
    expect(t.jev.conversations().map((c: any) => c.messages.at(-1).address)).toEqual(["shop@example.net"]);
    expect(t.store.noiseOf(chat(caught.threadId))?.source).toBe("sender");
    expect(t.store.noiseOf(chat(asked.threadId))?.source).toBe("jev");
    // Someone real writes in the caught one: Jev is asked about it, as about any other.
    deliver("Real <real@example.net>", { threadId: caught.threadId });
    t.judge.touch(chat(caught.threadId));
    await t.judge.runNow();
    expect(t.jev.conversations().at(-1)).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ address: "real@example.net" })]) });
    expect(t.store.verdict(chat(caught.threadId))?.source).toBe("jev");
    // A definition that goes takes nothing of the list's.
    const again = deliver(`Warm <${WARM}>`);
    await t.ids({ inbox: "primary" });
    await t.call("set_noise_definition", { definition: "" });
    expect(t.store.noiseOf(chat(again.threadId))?.source).toBe("sender");
    expect(t.store.noiseOf(chat(asked.threadId))).toBeNull();
  });

  test("the reason shows where Jev's does: lists, reads, Recent decisions", async () => {
    const t = await rig();
    await t.call("add_noise_sender", { entry: WARM });
    const m = deliver(`Warm <${WARM}>`, { subject: "checking in" });
    const id = chat(m.threadId);
    const low = await t.call("list_chats", { inbox: "low-priority", limit: 50 });
    expect(low.items.find((c: any) => c.id === id)).toMatchObject({ isLowPriority: true, noise: { reason: SENDER_NOISE_REASON, source: "sender", confidence: 1 } });
    expect((await t.call("read_chat", { chatID: id })).chat.noise).toEqual({ reason: SENDER_NOISE_REASON, confidence: 1, source: "sender" });
    expect((await t.call("get_noise_settings", {})).decisions[0]).toMatchObject({ chatID: id, title: "checking in", network: "Gmail", noise: true, reason: SENDER_NOISE_REASON, confidence: null, source: "sender" });
  });
});

describe("the list, by hand", () => {
  test("add: canonical entries only, own addresses refused, full is said; it is kept in the file at 0600 and read back", async () => {
    const path = tmpFile();
    const t = await rig({ path, ownAlias: "alias@example.com" });
    expect(await t.call("add_noise_sender", { entry: "Warm@Example.com" })).toEqual({ error: "BAD_PARAMS" });
    expect(await t.call("add_noise_sender", { entry: "not an address" })).toEqual({ error: "BAD_PARAMS" });
    expect(await t.call("add_noise_sender", { entry: OWNER_EMAIL })).toEqual({ error: "NOT_ALLOWED" });
    expect(await t.call("add_noise_sender", { entry: "alias@example.com" })).toEqual({ error: "NOT_ALLOWED" });
    const r = await t.call("add_noise_sender", { entry: "bulk.example.org" });
    expect(r).toMatchObject({ added: true, entry: { value: "bulk.example.org", kind: "domain", origin: "owner" } });
    expect((await t.call("add_noise_sender", { entry: "bulk.example.org" })).added).toBe(false);
    await t.call("add_noise_sender", { entry: WARM });
    expect((await t.call("get_noise_senders", {})).items.map((e: any) => e.value)).toEqual([WARM, "bulk.example.org"]);
    t.store.flush();
    const back = new NoiseStore({ path });
    expect(back.senders().map((e) => [e.value, e.kind, e.origin])).toEqual([[WARM, "address", "owner"], ["bulk.example.org", "domain", "owner"]]);
    expect(JSON.parse(readFileSync(path, "utf8")).v).toBe(1);
    const full = new NoiseStore();
    for (let i = 0; i < MAX_NOISE_SENDERS; i++) expect(full.addSender(`s${i}@example.com`, "owner")).not.toBeNull();
    expect(full.addSender("one.more@example.com", "owner")).toBeNull();
  });

  test("always noise from this sender: the newest other person's exact address, the chat goes at once, Undo puts it back", async () => {
    const t = await rig();
    const m = deliver(`Warm <${WARM}>`);
    deliver("Another <another@warmup.example.com>", { threadId: m.threadId, subject: "Re: hi" });
    const id = chat(m.threadId);
    const r = await t.call("add_noise_sender_of_chat", { chatID: id });
    expect(r).toMatchObject({ added: true, chatNoise: true, entry: { value: "another@warmup.example.com", kind: "address", origin: "owner" } });
    expect(t.store.noiseOf(id)?.source).toBe("sender");
    expect(await t.ids({ inbox: "primary" })).not.toContain(id);
    expect(await t.call("remove_noise_sender", { entry: "another@warmup.example.com", undo: true })).toEqual({ entry: "another@warmup.example.com", removed: true });
    expect(t.store.isNoise(id)).toBe(false);
    expect(await t.ids({ inbox: "primary" })).toContain(id);
    expect(t.store.isRemovedSender("another@warmup.example.com")).toBe(false);
    // The newest message is the owner's: it counts for the next mail, and this thread stays.
    const mine = deliver(`Warm <${WARM}>`, { subject: "answered" });
    reply(mine.threadId);
    expect(await t.call("add_noise_sender_of_chat", { chatID: chat(mine.threadId) })).toMatchObject({ chatNoise: false, entry: { value: WARM } });
    expect(await t.ids({ inbox: "primary" })).toContain(chat(mine.threadId));
    // Nobody else wrote; not an email; a thread that is gone.
    const alone = deliver(`Owner <${OWNER_EMAIL}>`, { subject: "to myself", labels: ["SENT"] });
    expect(await t.call("add_noise_sender_of_chat", { chatID: chat(alone.threadId) })).toEqual({ error: "CONFLICT" });
    expect(await t.call("add_noise_sender_of_chat", { chatID: CHAT_IDS.imessageAlice })).toEqual({ error: "NOT_SUPPORTED" });
    expect(await t.call("add_noise_sender_of_chat", { chatID: chat("ffffffffffffffff") })).toEqual({ error: "NOT_FOUND" });
    // Undo of an address the owner had taken off before: taken off it stays.
    await t.call("remove_noise_sender", { entry: WARM });
    expect(t.store.isRemovedSender(WARM)).toBe(true);
    await t.call("add_noise_sender", { entry: WARM });
    expect(t.store.isRemovedSender(WARM)).toBe(false);
    await t.call("remove_noise_sender", { entry: WARM, undo: true });
    expect(t.store.isRemovedSender(WARM)).toBe(true);
  });
});

describe("learning from the owner's marks", () => {
  const mark = async (t: Awaited<ReturnType<typeof rig>>, from: string, noise: boolean, subject = "hi") => {
    const m = deliver(from, { subject });
    await t.call("set_noise", { chatID: chat(m.threadId), noise });
    return chat(m.threadId);
  };

  test("at 2 marks, not at 1; the owner's marks keep the sender; the entry says learned and existing mail follows", async () => {
    const t = await rig({ definition: "Ads" });
    const first = await mark(t, `Warm <${WARM}>`, true);
    expect(t.store.verdict(first)?.sender).toBe(WARM);
    expect(t.store.senders()).toEqual([]);
    await mark(t, `Warm <${WARM}>`, true);
    expect(items(t.store)).toEqual([`learned:${WARM}`]);
    // A new message in one more thread, unmarked: caught.
    const next = deliver(`Warm <${WARM}>`, { subject: "next" });
    expect(await t.ids({ inbox: "primary" })).not.toContain(chat(next.threadId));
  });

  test("not with a Not noise mark, at any count; a domain is never learned; marks on two addresses do not add up", async () => {
    const t = await rig({ definition: "Ads" });
    await mark(t, `Warm <${WARM}>`, true);
    await mark(t, `Warm <${WARM}>`, false);
    await mark(t, `Warm <${WARM}>`, true);
    await mark(t, `Warm <${WARM}>`, true);
    expect(t.store.senders()).toEqual([]);
    await mark(t, "A <a@same.example.org>", true);
    await mark(t, "B <b@same.example.org>", true);
    expect(t.store.senders()).toEqual([]);
  });

  test("never the owner's own addresses or aliases, also when one becomes known only later", async () => {
    const t = await rig({ definition: "Ads", ownAlias: "alias@example.com" });
    // The alias's mail is the owner's own: a mark has no sender at all.
    const a = await mark(t, "Me <alias@example.com>", true);
    await mark(t, "Me <alias@example.com>", true);
    expect(t.store.verdict(a)?.sender).toBeNull();
    expect(t.store.senders()).toEqual([]);
    // learn itself refuses, whatever the verdicts say.
    t.store.setOwner(chat("aaa1"), true, { sender: "alias@example.com" });
    t.store.setOwner(chat("aaa2"), true, { sender: "alias@example.com" });
    t.rules.ownerMarked(chat("aaa2"), true);
    expect(t.store.senders()).toEqual([]);
    // Learned before Gmail said it was an alias: it goes when that is known, with what it caught.
    const late = "late.alias@example.com";
    const one = await mark(t, `Late <${late}>`, true);
    await mark(t, `Late <${late}>`, true);
    expect(items(t.store)).toEqual([`learned:${late}`]);
    const caught = deliver(`Late <${late}>`, { subject: "caught" });
    await t.ids({ inbox: "primary" });
    expect(t.store.isNoise(chat(caught.threadId))).toBe(true);
    setOwnAddresses(OWNER_EMAIL, ["alias@example.com", late]);
    t.rules.ownAddressesChanged();
    expect(t.store.senders()).toEqual([]);
    expect(t.store.isNoise(chat(caught.threadId))).toBe(false);
    expect(t.store.verdict(one)?.source).toBe("owner");
  });

  test("taken off by hand it stays off, however many marks follow, across a restart, until the owner adds it", async () => {
    const path = tmpFile();
    const t = await rig({ path, definition: "Ads" });
    await mark(t, `Warm <${WARM}>`, true);
    await mark(t, `Warm <${WARM}>`, true);
    expect(items(t.store)).toEqual([`learned:${WARM}`]);
    await t.call("remove_noise_sender", { entry: WARM });
    expect(t.store.senders()).toEqual([]);
    await mark(t, `Warm <${WARM}>`, true);
    expect(t.store.senders()).toEqual([]);
    t.stop();
    const back = await rig({ path });
    back.rules.ownerMarked(chat("aaa1"), true);
    expect(back.store.senders()).toEqual([]);
    await back.call("add_noise_sender", { entry: WARM });
    expect(items(back.store)).toEqual([`owner:${WARM}`]);
    await back.call("remove_noise_sender", { entry: WARM });
    back.rules.ownerMarked(chat("aaa1"), true);
    expect(back.store.senders()).toEqual([]);
  });

  test("a Not noise mark on a conversation from a learned address: it stops being learned, what it caught comes back, and it does not come back by itself", async () => {
    const t = await rig({ definition: "Ads" });
    await mark(t, `Warm <${WARM}>`, true);
    await mark(t, `Warm <${WARM}>`, true);
    const caught = deliver(`Warm <${WARM}>`, { subject: "caught" });
    await t.ids({ inbox: "primary" });
    expect(t.store.isNoise(chat(caught.threadId))).toBe(true);
    await t.call("set_noise", { chatID: chat(caught.threadId), noise: false });
    expect(t.store.senders()).toEqual([]);
    const other = deliver(`Warm <${WARM}>`, { subject: "other" });
    expect(await t.ids({ inbox: "primary" })).toContain(chat(other.threadId));
    await mark(t, `Warm <${WARM}>`, true);
    expect(t.store.senders()).toEqual([]);
    expect(t.store.isRemovedSender(WARM)).toBe(false);
    // A Not noise on an entry the owner added is about that conversation: the entry stays.
    await t.call("add_noise_sender", { entry: "hand@example.org" });
    const h = deliver("Hand <hand@example.org>");
    await t.ids({ inbox: "primary" });
    await t.call("set_noise", { chatID: chat(h.threadId), noise: false });
    expect(items(t.store)).toEqual(["owner:hand@example.org"]);
    expect(t.store.isNoise(chat(h.threadId))).toBe(false);
  });

  test("a mark that could not read who wrote is looked up later and counts", async () => {
    const t = await rig({ definition: "Ads" });
    t.rules.start();
    const a = deliver(`Warm <${WARM}>`);
    // The read for the example and the look at who wrote both fail.
    fg.google.failNext({ path: `/gmail/v1/users/me/threads/${a.threadId}`, status: 500, times: 2 });
    await t.call("set_noise", { chatID: chat(a.threadId), noise: true });
    expect(t.store.verdict(chat(a.threadId))?.sender).toBeUndefined();
    await t.rules.runNow();
    expect(t.store.verdict(chat(a.threadId))?.sender).toBe(WARM);
    expect(t.store.senders()).toEqual([]);
    const b = deliver(`Warm <${WARM}>`, { subject: "second" });
    expect(await t.call("set_noise", { chatID: chat(b.threadId), noise: true })).toMatchObject({ learned: WARM });
    expect(items(t.store)).toEqual([`learned:${WARM}`]);
  });
});

describe("the look at old marks", () => {
  /** A noise.json from before the list. */
  const oldFile = (path: string, verdicts: { threadId: string; noise: boolean }[], extra: object = {}) => {
    writeFileSync(path, JSON.stringify({ v: 1, definition: "Ads", verdicts: [...verdicts.map((v, i) => ({ chatID: chat(v.threadId), noise: v.noise, source: "owner", at: Date.now() + i, example: `Gmail "old ${i}"; started by the owner: no` })), { chatID: CHAT_IDS.imessageAlice, noise: true, source: "owner", at: 5000 }], decisions: [], ...extra }));
  };

  test("an upgrade from an old file: each owner verdict's newest other sender, From only, then learned; once, never again after a restart", async () => {
    const path = tmpFile();
    const a = deliver(`Warm <${WARM}>`, { subject: "a" });
    const b = deliver(`Warm <${WARM}>`, { subject: "b" });
    reply(b.threadId); // The owner answered since: the newest OTHER person still counts.
    const c = deliver("Solo <solo@example.net>", { subject: "c" });
    const own = deliver(`Owner <${OWNER_EMAIL}>`, { subject: "own", labels: ["SENT"] });
    oldFile(path, [{ threadId: a.threadId, noise: true }, { threadId: b.threadId, noise: true }, { threadId: c.threadId, noise: true }, { threadId: own.threadId, noise: true }, { threadId: "ffffffffffffffff", noise: false }]);
    const t = await rig({ path });
    expect(t.store.definition).toBe("Ads");
    expect(t.store.senderLookupsDone).toBe(false);
    expect(t.store.ownerWithoutSender()).toHaveLength(5);
    fg.google.requests.length = 0;
    await t.rules.runNow();
    const reads = threadReads();
    expect(reads.filter((r) => r.format === "metadata" && r.metadataHeaders?.join() === "From").length).toBe(5);
    // The walk for the learned one comes after, and asks more.
    expect(t.store.verdict(chat(a.threadId))?.sender).toBe(WARM);
    expect(t.store.verdict(chat(b.threadId))?.sender).toBe(WARM);
    expect(t.store.verdict(chat(c.threadId))?.sender).toBe("solo@example.net");
    expect(t.store.verdict(chat(own.threadId))?.sender).toBeNull();
    expect(t.store.verdict(chat("ffffffffffffffff"))?.sender).toBeNull();
    expect(t.store.verdict(CHAT_IDS.imessageAlice)?.sender).toBeUndefined();
    expect(t.store.ownerWithoutSender()).toEqual([]);
    expect(items(t.store)).toEqual([`learned:${WARM}`]);
    expect(t.store.senderLookupsDone).toBe(true);
    // The file says so; a restart asks Gmail nothing.
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.senderLookupsDone).toBe(true);
    t.stop();
    fg.google.requests.length = 0;
    const back = await rig({ path });
    back.rules.start();
    await new Promise((r) => setTimeout(r, 30));
    await back.rules.runNow();
    expect(threadReads()).toEqual([]);
    expect(fg.google.requests.filter((r) => r.path.endsWith("/threads"))).toEqual([]);
    expect(items(back.store)).toEqual([`learned:${WARM}`]);
    // Nothing about mail in the logs.
    expect([...t.logs, ...back.logs].join("\n")).not.toMatch(/@|warm|hi\b/i);
  });

  test("paced in batches through the client's batch endpoint", async () => {
    const path = tmpFile();
    const threads = Array.from({ length: BACKGROUND_BATCH * 2 + 3 }, (_, i) => deliver(`S${i} <s${i}@example.net>`, { subject: `s${i}` }).threadId);
    oldFile(path, threads.map((threadId) => ({ threadId, noise: true })));
    const t = await rig({ path });
    fg.google.requests.length = 0;
    await t.rules.runNow();
    expect(fg.google.requests.filter((r) => r.path === "/batch/gmail/v1")).toHaveLength(3);
    expect(threadReads().filter((r) => r.inBatch).length).toBe(threads.length);
  });

  test("failures are logged by count and tried again; resumable across a restart: what was found is not asked again", async () => {
    const path = tmpFile();
    const threads = Array.from({ length: BACKGROUND_BATCH + 4 }, (_, i) => deliver(`Warm <${WARM}>`, { subject: `w${i}` }).threadId);
    oldFile(path, threads.map((threadId) => ({ threadId, noise: true })));
    const t = await rig({ path });
    // The second batch fails altogether.
    let batches = 0;
    const realStore = t.store.setOwnerSenders.bind(t.store);
    t.store.setOwnerSenders = (f) => {
      if (++batches === 1) fg.google.failNext({ path: "/batch/gmail/v1", status: 500, times: 1 });
      realStore(f);
    };
    await t.rules.runNow();
    t.stop();
    t.store.setOwnerSenders = realStore;
    expect(t.logs.join("\n")).toMatch(/looked up the senders of 10 of your marks, 4 failed and will be tried again/);
    expect(t.logs.join("\n")).not.toContain(WARM);
    expect(t.store.senderLookupsDone).toBe(false);
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.senderLookupsDone).toBe(false);
    expect(file.verdicts.filter((v: any) => v.sender === WARM)).toHaveLength(10);
    // Restart: only the four left.
    fg.google.requests.length = 0;
    const back = await rig({ path });
    expect(back.store.ownerWithoutSender()).toHaveLength(4);
    await back.rules.runNow();
    expect(back.store.ownerWithoutSender()).toEqual([]);
    expect(threadReads().filter((r) => r.metadataHeaders?.join() === "From")).toHaveLength(4);
    expect(back.store.senderLookupsDone).toBe(true);
    expect(items(back.store)).toEqual([`learned:${WARM}`]);
  });

  test("tried again by itself after a failure, without a restart", async () => {
    const path = tmpFile();
    const a = deliver(`Warm <${WARM}>`, { subject: "a" });
    oldFile(path, [{ threadId: a.threadId, noise: true }]);
    const t = await rig({ path });
    fg.google.failNext({ path: new RegExp(`/threads/${a.threadId}$`), status: 500, times: 1 });
    t.rules.start();
    for (let i = 0; i < 200 && !t.store.senderLookupsDone; i++) await new Promise((r) => setTimeout(r, 10));
    expect(t.store.senderLookupsDone).toBe(true);
    expect(t.store.verdict(chat(a.threadId))?.sender).toBe(WARM);
  });

  test("an account no longer here has no sender to find; one waiting for a reconnect is asked again later", async () => {
    const path = tmpFile();
    const gone = gmailChatID(OTHER_EMAIL, "aaaa0000aaaa0000");
    writeFileSync(path, JSON.stringify({ v: 1, definition: "Ads", verdicts: [{ chatID: gone, noise: true, source: "owner", at: 1 }], decisions: [] }));
    const t = await rig({ path });
    await t.rules.runNow();
    expect(t.store.verdict(gone)?.sender).toBeNull();
    expect(t.store.senderLookupsDone).toBe(true);
  });
});

describe("existing mail", () => {
  test("the walk: in the inbox, the last 30 days, this sender as the newest; no Jev; a non-match keeps its verdict", async () => {
    const t = await rig({ definition: "Ads" });
    const recent = deliver(`Warm <${WARM}>`, { subject: "recent" });
    const old = deliver(`Warm <${WARM}>`, { subject: "old", at: Date.now() - 40 * DAY });
    const archived = deliver(`Warm <${WARM}>`, { subject: "archived", labels: ["CATEGORY_PERSONAL"] });
    const lookalike = deliver("B <bwarm@warmup.example.com>", { subject: "lookalike" });
    const repliedTo = deliver(`Warm <${WARM}>`, { subject: "real reply" });
    deliver("Real <real@example.net>", { threadId: repliedTo.threadId });
    const jevSaid = deliver(`Warm <${WARM}>`, { subject: "jev said" });
    deliver("Real <real@example.net>", { threadId: jevSaid.threadId });
    t.store.setJev([{ chatID: chat(jevSaid.threadId), noise: true, reason: "Ads", confidence: 0.9, title: "t", network: "Gmail" }]);
    const notNoise = deliver(`Warm <${WARM}>`, { subject: "not noise" });
    t.store.setOwner(chat(notNoise.threadId), false, { sender: null });
    fg.google.requests.length = 0;
    t.moved.length = 0;
    await t.call("add_noise_sender", { entry: WARM });
    expect(t.store.pendingWalks()).toEqual([WARM]);
    await t.rules.runNow();
    expect(t.store.pendingWalks()).toEqual([]);
    const q = fg.google.requests.find((r) => r.q?.includes("from:"))!.q!;
    expect(q).toMatch(new RegExp(`^in:inbox from:${WARM} after:\\d+$`));
    expect(t.jev.requests).toEqual([]);
    expect(t.store.noiseOf(chat(recent.threadId))?.source).toBe("sender");
    expect(t.moved).toEqual([chat(recent.threadId)]);
    expect(t.store.verdict(chat(old.threadId))).toBeUndefined();
    expect(t.store.verdict(chat(archived.threadId))).toBeUndefined();
    expect(t.store.verdict(chat(lookalike.threadId))).toBeUndefined();
    expect(t.store.verdict(chat(repliedTo.threadId))).toBeUndefined();
    expect(t.store.noiseOf(chat(jevSaid.threadId))?.source).toBe("jev");
    expect(t.store.verdict(chat(notNoise.threadId))?.source).toBe("owner");
    // It does not read a thread the owner has a verdict on.
    expect(threadReads().filter((r) => r.path.endsWith(notNoise.threadId))).toEqual([]);
    // A domain walks the domain.
    const dom = deliver("Any <any@bulk.example.org>", { subject: "domain" });
    const sub = deliver("Sub <sub@mail.bulk.example.org>", { subject: "subdomain" });
    await t.call("add_noise_sender", { entry: "bulk.example.org" });
    await t.rules.runNow();
    expect(t.store.noiseOf(chat(dom.threadId))?.source).toBe("sender");
    expect(t.store.verdict(chat(sub.threadId))).toBeUndefined();
  });

  test("at most 500 threads, paced in batches", async () => {
    const t = await rig();
    for (let i = 0; i < WALK_MAX_THREADS + 7; i++) deliver(`Warm <${WARM}>`, { subject: `n${i}`, at: Date.now() - i * 1000 });
    await t.call("add_noise_sender", { entry: WARM });
    fg.google.requests.length = 0;
    await t.rules.runNow();
    expect(threadReads().length).toBe(WALK_MAX_THREADS);
    expect(fg.google.requests.filter((r) => r.path === "/batch/gmail/v1").length).toBe(WALK_MAX_THREADS / BACKGROUND_BATCH);
    expect(t.store.noiseCount()).toBe(WALK_MAX_THREADS);
    // Open pages hear enough to read their lists again, not five hundred events.
    expect(t.moved.length).toBeLessThanOrEqual((WALK_MAX_THREADS / BACKGROUND_BATCH) * 3);
    expect(t.store.decisions()).toEqual([]);
  }, 60_000);

  test("waiting walks survive a restart, one taken off is not walked, and a walk that fails is tried again, then given up", async () => {
    const path = tmpFile();
    const t = await rig({ path });
    const a = deliver(`Warm <${WARM}>`);
    await t.call("add_noise_sender", { entry: WARM });
    await t.call("add_noise_sender", { entry: "gone.example.org" });
    await t.call("remove_noise_sender", { entry: "gone.example.org" });
    expect(JSON.parse(readFileSync(path, "utf8")).senderWalks).toEqual([WARM]);
    t.stop();
    const back = await rig({ path });
    expect(back.store.pendingWalks()).toEqual([WARM]);
    fg.google.requests.length = 0;
    await back.rules.runNow();
    expect(fg.google.requests.filter((r) => r.q?.includes("gone.example.org"))).toEqual([]);
    expect(back.store.noiseOf(chat(a.threadId))?.source).toBe("sender");
    expect(JSON.parse(readFileSync(path, "utf8")).senderWalks).toEqual([]);

    const f = await rig();
    await f.call("add_noise_sender", { entry: "failing.example.org" });
    fg.google.failNext({ path: "/gmail/v1/users/me/threads", status: 500, times: 40 });
    for (let i = 0; i < 5; i++) {
      expect(f.store.pendingWalks()).toEqual(["failing.example.org"]);
      await f.rules.runNow();
    }
    expect(f.store.pendingWalks()).toEqual([]);
    expect(f.logs.join("\n")).toMatch(/moving existing mail failed for 1 senders/);
    expect(f.logs.join("\n")).toMatch(/gave up/);
    expect(f.logs.join("\n")).not.toContain("failing.example.org");
  });

  test("removing an entry clears the verdicts from it, not others'; another entry that still catches it keeps it; judged again on the next activity", async () => {
    const t = await rig({ definition: "Ads", decide: (_c, criteria) => pickLine(criteria, /Ads/) });
    const m = deliver(`Warm <${WARM}>`);
    const id = chat(m.threadId);
    const byDomain = deliver("Other <other@warmup.example.com>", { subject: "domain" });
    const jev = deliver("Shop <shop@example.net>", { subject: "jev" });
    t.store.setJev([{ chatID: chat(jev.threadId), noise: true, reason: "Ads", confidence: 0.9, title: "t", network: "Gmail" }]);
    const owner = deliver(`Warm <${WARM}>`, { subject: "owner" });
    t.store.setOwner(chat(owner.threadId), true, { sender: null });
    await t.call("add_noise_sender", { entry: WARM });
    await t.call("add_noise_sender", { entry: "warmup.example.com" });
    await t.rules.runNow();
    expect(t.store.verdict(id)?.rule).toBe(WARM);
    expect(t.store.verdict(chat(byDomain.threadId))?.rule).toBe("warmup.example.com");
    // The address goes: the domain still catches its mail.
    t.moved.length = 0;
    await t.call("remove_noise_sender", { entry: WARM });
    expect(t.store.noiseOf(id)?.source).toBe("sender");
    expect(t.store.verdict(id)?.rule).toBe("warmup.example.com");
    expect(t.moved).toEqual([]);
    // The domain goes: cleared, and heard of.
    await t.call("remove_noise_sender", { entry: "warmup.example.com" });
    expect(t.store.verdict(id)).toBeUndefined();
    expect(t.store.verdict(chat(byDomain.threadId))).toBeUndefined();
    expect(t.moved.sort()).toEqual([id, chat(byDomain.threadId)].sort());
    expect(t.store.noiseOf(chat(jev.threadId))?.source).toBe("jev");
    expect(t.store.noiseOf(chat(owner.threadId))?.source).toBe("owner");
    expect(await t.ids({ inbox: "primary" })).toContain(id);
    expect(t.jev.requests).toEqual([]);
    deliver(`Warm <${WARM}>`, { threadId: m.threadId });
    t.judge.touch(id);
    await t.judge.runNow();
    expect(t.jev.requests).toHaveLength(1);
    expect(t.store.noiseOf(id)?.source).toBe("jev");
    expect((await t.call("remove_noise_sender", { entry: "nobody.example.org" })).removed).toBe(false);
  });

  test("an old connector's file reads a new one; a new one's verdict whose entry went is no verdict", () => {
    const path = tmpFile();
    const id = chat("aaa1");
    writeFileSync(path, JSON.stringify({ v: 1, definition: "", verdicts: [{ chatID: id, noise: true, source: "sender", reason: SENDER_NOISE_REASON, confidence: 1, at: 1, sender: WARM, rule: WARM }], decisions: [], senders: [{ value: "Bad Entry", kind: "domain", origin: "owner", at: 1 }, { value: "x.example.org", kind: "domain", origin: "alien", at: 1 }] }));
    const s = new NoiseStore({ path });
    expect(s.senders()).toEqual([]);
    expect(s.verdict(id)).toBeUndefined();
    expect(s.active()).toBe(false);
  });
});

describe("To do", () => {
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const todoIDs = async (t: Awaited<ReturnType<typeof rig>>) => (await t.call("list_chats", { todo: true, limit: 50 })).items.map((c: any) => c.id);
  const count = async (t: Awaited<ReturnType<typeof rig>>) => (await t.call("unread_summary", { todo: true, limit: 50 })).totalUnreadChats;

  test("leaves To do when it is added and comes back when it is removed, with its To do intact, also the count", async () => {
    const t = await rig({ todo: true });
    await t.todo!.sync();
    await t.gmail.refreshOwnAddresses();
    const m = deliver(`Warm <${WARM}>`);
    const id = chat(m.threadId);
    await t.ids({ inbox: "primary" });
    expect(await todoIDs(t)).toContain(id);
    const before = await count(t);
    await t.call("add_noise_sender", { entry: WARM });
    await t.rules.runNow();
    expect(await todoIDs(t)).not.toContain(id);
    expect(await count(t)).toBe(before - 1);
    expect((await t.call("read_chat", { chatID: id })).chat.todo).toBe(false);
    // Jev's verdict and this one both leave what the owner has not handled: it was never Done.
    expect(t.todo!.store.isTodo(id)).toBe(true);
    await t.call("remove_noise_sender", { entry: WARM });
    expect(await todoIDs(t)).toContain(id);
    expect(await count(t)).toBe(before);
    expect((await t.call("read_chat", { chatID: id })).chat.todo).toBe(true);
  });

  test("Always noise from this sender does not say Done: Not noise brings it back to To do", async () => {
    const t = await rig({ todo: true });
    await t.todo!.sync();
    const m = deliver(`Warm <${WARM}>`);
    const id = chat(m.threadId);
    await t.ids({ inbox: "primary" });
    await t.call("add_noise_sender_of_chat", { chatID: id });
    expect(await todoIDs(t)).not.toContain(id);
    await t.call("set_noise", { chatID: id, noise: false });
    expect(await todoIDs(t)).toContain(id);
  });

  test("no flash: when the poll announces new mail from a listed sender it is already noise, and it never shows in To do", async () => {
    const t = await rig({ todo: true });
    await t.todo!.sync();
    await t.call("add_noise_sender", { entry: WARM });
    await t.rules.runNow();
    const heard: { id: string; noise: boolean; todo: boolean }[] = [];
    t.gmail.startPolling((f: EventFrame) => {
      expect(parseConnectorFrame(JSON.stringify(f)).ok).toBe(true);
      if (f.kind !== "status") {
        heard.push({ id: f.chatID, noise: t.store.isNoise(f.chatID), todo: t.todo!.store.isTodo(f.chatID) && t.store.isNoise(f.chatID) === false });
        if (f.kind === "message" && f.op === "upserted") t.judge.touch(f.chatID, f.messageIDs);
        t.todo!.event(f);
      }
      return true;
    }, () => true);
    await t.gmail.pollNow();
    const m = deliver(`Warm <${WARM}>`);
    const real = deliver("Real <real@example.net>", { subject: "real" });
    const id = chat(m.threadId);
    fg.google.requests.length = 0;
    await t.gmail.pollNow();
    t.gmail.stopPolling();
    expect(heard.filter((h) => h.id === id).length).toBeGreaterThan(0);
    for (const h of heard.filter((x) => x.id === id)) expect(h.noise).toBe(true);
    // One read of who wrote for both, From and Subject only, before anything was said.
    const looks = threadReads().filter((r) => r.metadataHeaders?.join() === "From,Subject");
    expect(looks).toHaveLength(2);
    // The judge has nothing left to ask: the rule has answered about that message.
    expect(t.judge.waiting).toBe(1);
    await settle();
    expect(await todoIDs(t)).not.toContain(id);
    expect(await todoIDs(t)).toContain(chat(real.threadId));
    expect((await t.call("unread_summary", { todo: true, limit: 50 })).items.map((c: any) => c.id)).not.toContain(id);
  });

  test("a list that reaches the mail before the poll: no flash either, it is judged as it is mapped", async () => {
    const t = await rig({ todo: true });
    await t.todo!.sync();
    await t.call("add_noise_sender", { entry: WARM });
    const m = deliver(`Warm <${WARM}>`);
    expect(await t.ids({ inbox: "primary" })).not.toContain(chat(m.threadId));
    expect(await todoIDs(t)).not.toContain(chat(m.threadId));
    expect((await t.call("unread_summary", {})).items.map((c: any) => c.id)).not.toContain(chat(m.threadId));
  });

  test("the poll's read failing costs nothing: the events go out, and the judge catches it", async () => {
    const t = await rig();
    await t.call("add_noise_sender", { entry: WARM });
    await t.rules.runNow();
    const heard: string[] = [];
    t.gmail.startPolling((f: EventFrame) => {
      if (f.kind === "message" && f.op === "upserted") t.judge.touch(f.chatID, f.messageIDs);
      if (f.kind !== "status") heard.push(f.chatID);
      return true;
    }, () => true);
    await t.gmail.pollNow();
    const m = deliver(`Warm <${WARM}>`);
    const id = chat(m.threadId);
    fg.google.failNext({ path: "/gmail/v1/users/me/threads/", status: 500, times: 1 });
    await t.gmail.pollNow();
    t.gmail.stopPolling();
    expect(heard).toContain(id);
    expect(t.store.isNoise(id)).toBe(false);
    expect(t.judge.waiting).toBe(1);
    await t.judge.runNow();
    expect(t.store.noiseOf(id)?.source).toBe("sender");
  });
});

describe("what Jev reads", () => {
  const page = (chatID: string, messages: { isSender: boolean; senderID: string; name?: string }[]) =>
    ({
      chat: { id: chatID, accountID: "a", network: chatID.startsWith("gmail:") ? "Gmail" : "WhatsApp", title: "hi", type: "single", unreadCount: 0, isPinned: false, isMuted: false, isArchived: false, participantCount: 2, lastActivity: null, preview: null },
      items: messages.map((m, i) => ({ id: `m${i}`, chatID, accountID: "a", senderID: m.senderID, senderName: m.name ?? "Warm", timestamp: new Date(1000 + i).toISOString(), sortKey: String(i), type: "TEXT", isSender: m.isSender, text: "checking in" })),
      hasMore: false,
      nextCursor: null,
    }) as any;

  test("an email sender's address, in the conversation and the example, within limits; never a Beeper senderID; old examples keep working", () => {
    const gmail = conversationOf(page(chat("aaa1"), [{ isSender: false, senderID: WARM }, { isSender: true, senderID: OWNER_EMAIL }]));
    expect(gmail.conversation.messages).toEqual([{ from: "other", name: "Warm", address: WARM, text: "checking in" }, { from: "me", text: "checking in" }]);
    const beeper = conversationOf(page(CHAT_IDS.imessageAlice, [{ isSender: false, senderID: "+15550201001" }]));
    expect(beeper.conversation.messages[0]).toEqual({ from: "other", name: "Warm", text: "checking in" });
    expect(exampleOf(gmail.conversation)).toBe(`Gmail "hi"; sender: ${WARM}; started by the owner: no; others replied: yes; last message from me: "checking in"`);
    expect(exampleOf(beeper.conversation)).not.toContain("sender:");
    const long = conversationOf(page(chat("aaa1"), [{ isSender: false, senderID: `${"a".repeat(64)}@${"b".repeat(180)}.example.com` }]));
    expect(long.conversation.messages[0]!.address!.length).toBeLessThanOrEqual(101);
    const wide: JevConversation = { ...long.conversation, title: "t".repeat(200), messages: [{ from: "other", address: "a".repeat(100), text: "x".repeat(300) }] };
    expect(exampleOf(wide).length).toBeLessThanOrEqual(MAX_EXAMPLE_LENGTH);
    expect(exampleOf(wide)).toContain("last message from other");
  });

  test("the store's examples: an old one gains its sender once it was looked up, and one that says it does not repeat it", () => {
    const s = new NoiseStore();
    const a = chat("aaa1");
    s.setOwner(a, true, { example: `Gmail "old"; started by the owner: no` });
    expect(s.examples()).toEqual([{ example: `Gmail "old"; started by the owner: no`, noise: true }]);
    s.setOwnerSenders([{ chatID: a, sender: WARM }]);
    expect(s.examples()).toEqual([{ example: `Gmail "old"; started by the owner: no; sender: ${WARM}`, noise: true }]);
    s.setOwner(chat("aaa2"), true, { example: `Gmail "new"; sender: ${WARM}`, sender: WARM });
    expect(s.examples()[0]!.example).toBe(`Gmail "new"; sender: ${WARM}`);
  });

  test(`measured: ${MAX_EXAMPLES} examples at their longest stay well inside the body's limit, and every question still fits for a usual definition`, () => {
    const example = (i: number) => ({ example: `${"e".repeat(MAX_EXAMPLE_LENGTH)}; sender: ${"s".repeat(80)}${i}`, noise: i % 2 === 0 });
    const examples = Array.from({ length: MAX_EXAMPLES }, (_, i) => example(i));
    const state = buildJevRequest({ lines: ["Ads"], conversations: [], examples }).body.state.length;
    // At their longest: about a sixth of the body.
    expect(state).toBeLessThan(JEV_MAX_BODY_CHARS / 5);
    const conv = (i: number): JevConversation => ({ network: "Gmail", title: `Conversation ${i} `.padEnd(200, "t"), group: false, lowPriority: false, startedByMe: false, othersReplied: true, messages: Array.from({ length: 5 }, () => ({ from: "other" as const, name: "n".repeat(60), address: "a".repeat(100), text: "x".repeat(300) })) });
    const usual = buildJevRequest({ lines: ["Newsletters, ads, app notifications", "Cold emails I sent that nobody has replied to yet", "Warm-up emails"], conversations: Array.from({ length: 40 }, (_, i) => conv(i)), examples });
    expect(JSON.stringify(usual.body).length).toBeLessThanOrEqual(JEV_MAX_BODY_CHARS);
    // Conversations this long do not happen in a batch of forty; what does not fit goes first in the next call.
    expect(usual.asked).toBeGreaterThanOrEqual(25);
    const worst = buildJevRequest({ lines: Array.from({ length: 50 }, (_, i) => `Line number ${i} ${"y".repeat(60)}`), conversations: Array.from({ length: 40 }, (_, i) => conv(i)), examples });
    expect(JSON.stringify(worst.body).length).toBeLessThanOrEqual(JEV_MAX_BODY_CHARS);
    expect(worst.asked).toBeGreaterThan(0);
  });
});

describe("review fixes", () => {
  test("1. the owner's verdicts are never pushed out by Jev's or the list's: their Not noise still wins and still keeps an address from being learned", () => {
    const s = new NoiseStore({ max: 3, maxOwner: 2 });
    s.setDefinition("Ads");
    const notNoise = chat("aaa0");
    s.setOwner(notNoise, false, { sender: WARM });
    s.addSender("bulk.example.org", "owner");
    for (let i = 0; i < 10; i++) s.setJev([{ chatID: chat(`b${i}`), noise: true, reason: "Ads", confidence: 0.9, title: "t", network: "Gmail" }]);
    for (let i = 0; i < 10; i++) s.applyRule([{ chatID: chat(`c${i}`), lastMessageID: "m", address: "x@bulk.example.org" }], { clear: true, note: false });
    expect(s.isOwners(notNoise)).toBe(true);
    expect(s.applyRule([{ chatID: notNoise, lastMessageID: "m", address: "x@bulk.example.org" }], { clear: true, note: false })).toEqual([]);
    s.setOwner(chat("aaa1"), true, { sender: WARM });
    expect(s.isOwners(notNoise)).toBe(true);
    expect(s.learn(() => false).learned).toEqual([]);
    // Past their own cap, the oldest of the owner's go.
    s.setOwner(chat("aaa2"), true, { sender: WARM });
    expect(s.isOwners(notNoise)).toBe(false);
    expect([s.isOwners(chat("aaa1")), s.isOwners(chat("aaa2"))]).toEqual([true, true]);
    // A file holding more than the bound: the owner's are kept first.
    const path = tmpFile();
    writeFileSync(path, JSON.stringify({ v: 1, definition: "Ads", verdicts: [{ chatID: notNoise, noise: false, source: "owner", at: 1, sender: WARM }, ...Array.from({ length: 6 }, (_, i) => ({ chatID: chat(`d${i}`), noise: true, source: "jev", reason: "Ads", confidence: 0.9, at: 2 + i }))], decisions: [] }));
    const back = new NoiseStore({ path, max: 3 });
    expect(back.isOwners(notNoise)).toBe(true);
    expect(back.size).toBe(4);
  });

  test("2. a mark counts only for a thread with one other sender in it; a group or list thread teaches nothing, and a colleague is never learned", async () => {
    const t = await rig({ definition: "Ads" });
    const mixed = async () => {
      const m = deliver(`Warm <${WARM}>`, { subject: "mixed" });
      deliver("Colleague <colleague@example.net>", { threadId: m.threadId });
      await t.call("set_noise", { chatID: chat(m.threadId), noise: true });
      return chat(m.threadId);
    };
    const a = await mixed();
    await mixed();
    expect(t.store.verdict(a)?.sender).toBeNull();
    expect(t.store.senders()).toEqual([]);
    // One sender, several messages, the owner's reply in between: counts.
    const solo = async () => {
      const m = deliver(`Warm <${WARM}>`, { subject: "solo" });
      reply(m.threadId);
      deliver(`Warm <${WARM}>`, { threadId: m.threadId });
      return t.call("set_noise", { chatID: chat(m.threadId), noise: true });
    };
    expect(await solo()).toEqual({ chatID: expect.any(String), noise: true });
    // The second mark learns it, and says so: the page shows a toast for it.
    expect(await solo()).toMatchObject({ noise: true, learned: WARM });
    expect(items(t.store)).toEqual([`learned:${WARM}`]);
  });

  test("2. the look at old marks takes the thread as it was at the mark: someone who wrote after it is not the sender", async () => {
    const path = tmpFile();
    const markedAt = Date.now() - 3 * DAY;
    const threads = [0, 1].map((i) => {
      const m = deliver(`Warm <${WARM}>`, { subject: `old ${i}`, at: markedAt - DAY });
      deliver("Colleague <colleague@example.net>", { threadId: m.threadId, at: markedAt + DAY });
      return m.threadId;
    });
    writeFileSync(path, JSON.stringify({ v: 1, definition: "Ads", verdicts: threads.map((th, i) => ({ chatID: chat(th), noise: true, source: "owner", at: markedAt + i })), decisions: [] }));
    const t = await rig({ path });
    await t.rules.runNow();
    expect(threads.map((th) => t.store.verdict(chat(th))?.sender)).toEqual([WARM, WARM]);
    expect(items(t.store)).toEqual([`learned:${WARM}`]);
  });

  test("3. nothing is learned, kicked or walked until the start's wait is over (an old Worker may still be up)", async () => {
    let now = Date.now();
    const t = await rig({ definition: "Ads", startDelayMs: 120_000, now: () => now });
    for (const s of ["one", "two"]) {
      const m = deliver(`Warm <${WARM}>`, { subject: s });
      expect(await t.call("set_noise", { chatID: chat(m.threadId), noise: true })).not.toHaveProperty("learned");
    }
    await t.call("add_noise_sender", { entry: "bulk.example.org" });
    const ownAdd = deliver("Any <any@bulk.example.org>", { subject: "existing" });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.store.senders().map((e) => e.value)).toEqual(["bulk.example.org"]);
    expect(fg.google.requests.filter((r) => r.q?.includes("from:"))).toEqual([]);
    expect(t.store.verdict(chat(ownAdd.threadId))).toBeUndefined();
    now += 120_000;
    await t.rules.runNow();
    expect(items(t.store)).toEqual([`learned:${WARM}`, "owner:bulk.example.org"]);
    expect(t.store.noiseOf(chat(ownAdd.threadId))?.source).toBe("sender");
  });

  test("4. a first run takes in what the list caught: To do keeps it while it is noise, and has it when the entry goes", async () => {
    const t = await rig({ todo: true });
    const m = deliver(`Warm <${WARM}>`, { subject: "caught before the first run" });
    const id = chat(m.threadId);
    await t.call("add_noise_sender", { entry: WARM });
    await t.rules.runNow();
    expect(t.store.noiseOf(id)?.source).toBe("sender");
    await t.todo!.sync();
    const todoIDs = async () => (await t.call("list_chats", { todo: true, limit: 50 })).items.map((c: any) => c.id);
    expect(await todoIDs()).not.toContain(id);
    await t.call("remove_noise_sender", { entry: WARM });
    expect(await todoIDs()).toContain(id);
  });

  test("4. Add older unread takes in what the list caught too", async () => {
    const t = await rig({ todo: true });
    const m = deliver(`Warm <${WARM}>`, { subject: "older, caught", at: Date.now() - 12 * DAY });
    const id = chat(m.threadId);
    await t.call("add_noise_sender", { entry: WARM });
    await t.rules.runNow();
    await t.todo!.sync();
    expect(t.todo!.store.isTodo(id)).toBe(false);
    expect((await t.call("add_older_unread", { source: `gmail:${OWNER_EMAIL}` })).adding).toBe(true);
    await t.todo!.sync();
    expect(t.todo!.store.isTodo(id)).toBe(true);
    expect((await t.call("list_chats", { todo: true, limit: 50 })).items.map((c: any) => c.id)).not.toContain(id);
    await t.call("remove_noise_sender", { entry: WARM });
    expect((await t.call("list_chats", { todo: true, limit: 50 })).items.map((c: any) => c.id)).toContain(id);
  });

  test("5. a call whose signal ends while it waits for its turn behind a long queue gives up then, not at its turn", async () => {
    const client = createGmailClient({ email: OWNER_EMAIL, refreshToken: async () => "rt_123456789", refresh: async () => ({ ok: true as const, accessToken: "at_123456789", expiresIn: 3600 }), maxRequestsPerSecond: 1, fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch });
    const queued = Array.from({ length: 4 }, () => client.get(client.path(["profile"])));
    const t0 = Date.now();
    const r = await client.get(client.path(["profile"]), { signal: AbortSignal.timeout(150) });
    expect(Date.now() - t0).toBeLessThan(800);
    expect(r.ok).toBe(false);
    await Promise.all(queued);
  }, 30_000);
});
