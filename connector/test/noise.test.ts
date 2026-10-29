// Noise: the prompt Jev gets (criteria from the definition's lines, examples, truncation, the size
// budget), the verdict threshold, the System One client's error mapping, the noise store (bounds,
// 0600, load checks, sticky owner verdicts, a changed definition), the judge (new activity is judged
// again, unchanged conversations are not asked again, failures keep verdicts and back off, no key
// judges nothing, the call cap) and the lists (noise leaves the main inbox, Unread and
// unread_summary and joins Low priority; a not-noise verdict brings it back), with fake-beeper,
// fake-google and a fake of System One.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { FAKE_GOOGLE_CLIENT, OWNER_EMAIL, startFakeGoogle, type RunningFakeGoogle } from "@j-inbox/fake-google";
import { MAX_NOISE_DECISIONS, NOISE_CONFIDENCE_THRESHOLD, OWNER_NOISE_REASON, parseActionResult, type ActionName, type ActionResult, type ChatSummary } from "@j-inbox/protocol";
import { createActions } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";
import { createBeeperClient } from "../src/beeper-client.ts";
import { createDispatcher } from "../src/dispatcher.ts";
import { cloudTokenRefresher } from "../src/gmail/client.ts";
import { createGmailService } from "../src/gmail/service.ts";
import { noiseDebounceOverride, resolvePaths, typesafeURL } from "../src/config.ts";
import { JEV_MESSAGE_CHARS, NOT_NOISE, buildJevRequest, callJev, conversationOf, exampleOf, noiseLabels, verdictOf, type JevConversation } from "../src/noise/jev.ts";
import { NoiseJudge } from "../src/noise/judge.ts";
import { NoiseStore } from "../src/noise/store.ts";
import { MemorySecretStore } from "../src/secrets.ts";
import { fakeJev, pickLine, TEST_JEV_KEY, TEST_JEV_URL, type Decide } from "./helpers/fake-jev.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const DEFINITION = "Newsletters, ads, app notifications\nCold emails I sent that nobody has replied to yet";
const [NEWSLETTERS, COLD] = DEFINITION.split("\n") as [string, string];
const conv = (o: Partial<JevConversation> = {}): JevConversation => ({ network: "Gmail", title: "Hello", group: false, lowPriority: false, startedByMe: false, othersReplied: true, messages: [{ from: "other", name: "Ann", text: "Hi" }], ...o });

/** Newsletter when the newest message says "unsubscribe"; cold when the owner started it and nobody answered; else not noise. */
const decide: Decide = (c, criteria) => {
  const last = String(c.messages?.at(-1)?.text ?? "");
  if (/unsubscribe/i.test(last)) return pickLine(criteria, /newsletter/i, /UNSURE/.test(last) ? 0.6 : 0.9);
  if (c.startedByMe === true && c.othersReplied === false) return pickLine(criteria, /cold/i, 0.85);
  return { choice: NOT_NOISE, confidence: 0.95 };
};

describe("the prompt", () => {
  test("criteria: Not noise plus one choice per line, named by its first words, described by the line", () => {
    const { body } = buildJevRequest({ lines: [NEWSLETTERS, COLD], conversations: [conv()], examples: [] });
    expect(body.model).toBe("jev-latest");
    const q = body.questions.q0!;
    expect(q.type).toBe("choice");
    expect(q.criteria).toEqual({ [NOT_NOISE]: expect.stringContaining("real people writing to the owner"), "Noise: Newsletters ads app notifications": NEWSLETTERS, "Noise: Cold emails I sent that": COLD });
    expect(JSON.parse(q.instructions.slice(q.instructions.indexOf("{")))).toEqual(conv());
  });
  test("labels are unique, never Not noise, short; hostile lines stay text", () => {
    const labels = noiseLabels(["Not noise", "Cold emails I sent that nobody answered", "Cold emails I sent that are old", "<script>alert(1)</script>", "!!!", "x".repeat(300)]);
    expect(new Set(labels.map((l) => l.toLowerCase())).size).toBe(labels.length);
    expect(labels).not.toContain(NOT_NOISE);
    expect(labels[2]).toBe("Noise: Cold emails I sent that (3)");
    expect(labels[4]).toBe("Noise: line 5");
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(48);
  });
  test("the owner's corrections are examples in state", () => {
    const { body } = buildJevRequest({ lines: [NEWSLETTERS], conversations: [conv()], examples: [{ example: 'Gmail "Weekly deals"', noise: true }, { example: 'WhatsApp "Mom"', noise: false }] });
    expect(body.state).toContain('Choose "Not noise" for anything a person would want to see');
    expect(body.state).toContain('- Gmail "Weekly deals" => Noise');
    expect(body.state).toContain('- WhatsApp "Mom" => Not noise');
    expect(buildJevRequest({ lines: [NEWSLETTERS], conversations: [conv()], examples: [] }).body.state).not.toContain("earlier conversations");
  });
  test("a conversation: last 5 messages cut to 300 characters, me / other, who started it, whether others wrote", () => {
    const m = (i: number, isSender: boolean, text: string, type = "TEXT") => ({ id: `m${i}`, chatID: "c", accountID: "a", senderID: isSender ? "me" : "x", senderName: isSender ? "Me" : "Ann‮", timestamp: "2026-10-29T10:00:00.000Z", sortKey: String(i), type, text, isSender }) as any;
    const chat = { id: "c", accountID: "a", network: "LinkedIn", title: "Intro\nto you", type: "single", unreadCount: 0, isPinned: false, isMuted: false, isArchived: false, lastActivity: null } as ChatSummary;
    const page = (items: any[], hasMore = false) => ({ chat, items, hasMore, nextCursor: null }) as ActionResult<"read_chat">;
    const cold = conversationOf(page([m(1, true, "Hi, may I pitch you?"), m(2, true, "Following up"), m(3, false, "👍", "REACTION")]));
    expect(cold.conversation).toMatchObject({ network: "LinkedIn", title: "Intro to you", startedByMe: true, othersReplied: false, lowPriority: false, group: false });
    expect(cold.conversation.messages.map((x) => x.from)).toEqual(["me", "me"]);
    expect(cold.lastMessageID).toBe("m3");
    const long = conversationOf(page(Array.from({ length: 8 }, (_, i) => m(i, i % 2 === 0, "word ".repeat(200))), true));
    expect(long.conversation.messages).toHaveLength(5);
    for (const x of long.conversation.messages) expect(x.text.length).toBeLessThanOrEqual(JEV_MESSAGE_CHARS + 1);
    expect(long.conversation.messages[0]!.text.endsWith("…")).toBe(true);
    expect([long.conversation.startedByMe, long.conversation.othersReplied]).toEqual([null, true]);
    expect(long.conversation.messages.find((x) => x.from === "other")!.name).toBe("Ann‮");
    expect(exampleOf(cold.conversation)).toBe('LinkedIn "Intro to you"; started by the owner: yes; others replied: no; last message from me: "Following up"');
  });
  test("the body stays within its budget: what does not fit waits (always at least one)", () => {
    const many = Array.from({ length: 40 }, (_, i) => conv({ title: `Conversation ${i}`, messages: [{ from: "other", text: "x".repeat(300) }] }));
    const r = buildJevRequest({ lines: Array.from({ length: 50 }, (_, i) => `Line number ${i} ${"y".repeat(250)}`), conversations: many, examples: [] });
    expect(r.asked).toBeGreaterThan(0);
    expect(r.asked).toBeLessThan(40);
    expect(JSON.stringify(r.body).length).toBeLessThanOrEqual(120_000);
    expect(Object.keys(r.body.questions)).toHaveLength(r.asked);
    expect(buildJevRequest({ lines: [NEWSLETTERS], conversations: many, examples: [], maxChars: 10 }).asked).toBe(1);
    expect(buildJevRequest({ lines: [NEWSLETTERS], conversations: many, examples: [] }).asked).toBe(40);
  });
});

describe("the verdict", () => {
  const lines = [NEWSLETTERS, COLD];
  const [nl] = noiseLabels(lines);
  test(`noise only for a line chosen at least ${NOISE_CONFIDENCE_THRESHOLD} sure; uncertain, Not noise, unknown or missing is not noise`, () => {
    expect(verdictOf({ choice: nl!, confidence: 0.7 }, lines)).toEqual({ noise: true, reason: NEWSLETTERS, confidence: 0.7 });
    expect(verdictOf({ choice: nl!, confidence: 0.69 }, lines)).toEqual({ noise: false, confidence: 0.69 });
    expect(verdictOf({ choice: NOT_NOISE, confidence: 0.99 }, lines).noise).toBe(false);
    expect(verdictOf({ choice: "Noise: something else", confidence: 0.99 }, lines).noise).toBe(false);
    expect(verdictOf(undefined, lines)).toEqual({ noise: false, confidence: 0 });
    expect(verdictOf({ choice: nl!, confidence: Number.NaN }, lines).noise).toBe(false);
    expect(verdictOf({ choice: nl!, confidence: 7 }, lines)).toEqual({ noise: true, reason: NEWSLETTERS, confidence: 1 });
  });
});

describe("where Jev is", () => {
  test("api.typesafe.ai; a loopback fake and a shorter window only in test mode", () => {
    const test_ = resolvePaths({ HOME: "/h", J_INBOX_CONFIG_DIR: "/tmp/x" });
    const real = resolvePaths({ HOME: "/h" });
    expect(typesafeURL({}, real)).toBe("https://api.typesafe.ai");
    expect(() => typesafeURL({ J_INBOX_TYPESAFE_URL: "http://127.0.0.1:9" }, real)).toThrow(/only allowed/);
    expect(() => typesafeURL({ J_INBOX_TYPESAFE_URL: "https://evil.example" }, test_)).toThrow(/loopback/);
    expect(typesafeURL({ J_INBOX_TYPESAFE_URL: "http://127.0.0.1:9/" }, test_)).toBe("http://127.0.0.1:9");
    expect(noiseDebounceOverride({}, real)).toBeUndefined();
    expect(() => noiseDebounceOverride({ J_INBOX_NOISE_DEBOUNCE_MS: "300" }, real)).toThrow(/only allowed/);
    expect(noiseDebounceOverride({ J_INBOX_NOISE_DEBOUNCE_MS: "300" }, test_)).toBe(300);
    expect(() => noiseDebounceOverride({ J_INBOX_NOISE_DEBOUNCE_MS: "1" }, test_)).toThrow();
  });
});

describe("the System One client", () => {
  const body = buildJevRequest({ lines: [NEWSLETTERS], conversations: [conv()], examples: [] }).body;
  test("POST /v1/systemone with the key as a Bearer token and a JSON body", async () => {
    const jev = fakeJev(() => ({ choice: NOT_NOISE, confidence: 0.9 }));
    const r = await callJev({ url: TEST_JEV_URL, key: TEST_JEV_KEY, body, fetchImpl: jev.fetchImpl });
    expect(r).toEqual({ ok: true, answers: { q0: { choice: NOT_NOISE, confidence: 0.9 } } });
    expect(jev.requests[0]).toMatchObject({ url: `${TEST_JEV_URL}/v1/systemone`, auth: `Bearer ${TEST_JEV_KEY}`, contentType: "application/json" });
  });
  test("failures: unreachable (network, timeout, 429, 5xx, garbage) retries; refused (401/403) retries; other 4xx does not", async () => {
    const jev = fakeJev(() => ({ choice: NOT_NOISE, confidence: 0.9 }));
    const once = async (f: Parameters<typeof jev.failNext>[0]) => (jev.failNext(f), callJev({ url: TEST_JEV_URL, key: TEST_JEV_KEY, body, fetchImpl: jev.fetchImpl, timeoutMs: 50 }));
    expect(await once("network")).toEqual({ ok: false, problem: "jev_unreachable", retry: true });
    expect(await once("hang")).toEqual({ ok: false, problem: "jev_unreachable", retry: true });
    expect(await once(429)).toMatchObject({ problem: "jev_unreachable", retry: true });
    expect(await once(503)).toMatchObject({ problem: "jev_unreachable", retry: true });
    expect(await once("garbage")).toMatchObject({ problem: "jev_unreachable", retry: true });
    expect(await once(401)).toMatchObject({ problem: "jev_refused", retry: true, status: 401 });
    expect(await once(400)).toMatchObject({ problem: "jev_refused", retry: false, status: 400 });
    expect(await callJev({ url: TEST_JEV_URL, key: "ts_wrong_key_000000", body, fetchImpl: jev.fetchImpl })).toMatchObject({ problem: "jev_refused" });
  });
});

describe("the noise store", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "jinbox-noise-"))));
  const jevVerdict = (chatID: string, noise: boolean, reason?: string) => ({ chatID, noise, ...(reason ? { reason } : {}), confidence: 0.9, title: "T", network: "Gmail" });

  test("one 0600 file, read back; an empty definition applies nothing", () => {
    const path = join(dir, "data", "noise.json");
    const s = new NoiseStore({ path });
    s.setDefinition(DEFINITION);
    s.setJev([jevVerdict("c1", true, NEWSLETTERS), jevVerdict("c2", false)]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "data")).mode & 0o777).toBe(0o700);
    const again = new NoiseStore({ path });
    expect([again.definition, again.isNoise("c1"), again.isNoise("c2"), again.noiseCount()]).toEqual([DEFINITION, true, false, 1]);
    expect(again.noiseOf("c1")).toEqual({ reason: NEWSLETTERS, confidence: 0.9, source: "jev" });
    again.setDefinition("");
    expect([again.active(), again.isNoise("c1"), again.noiseCount()]).toEqual([false, false, 0]);
    rmSync(dir, { recursive: true, force: true });
  });
  test("bounded: at most max verdicts, the least recently judged go first; at most 20 decisions", () => {
    const s = new NoiseStore({ max: 3 });
    s.setDefinition(DEFINITION);
    for (let i = 0; i < 30; i++) s.setJev([jevVerdict(`c${i}`, true, NEWSLETTERS)]);
    expect(s.size).toBe(3);
    expect([s.isNoise("c26"), s.isNoise("c27"), s.isNoise("c29")]).toEqual([false, true, true]);
    expect(s.decisions()).toHaveLength(MAX_NOISE_DECISIONS);
    expect(s.decisions()[0]!.chatID).toBe("c29");
  });
  test("a garbled or hostile file is ignored or cleaned, never trusted", () => {
    const path = join(dir, "noise.json");
    writeFileSync(path, "{not json");
    expect(new NoiseStore({ path }).active()).toBe(false);
    writeFileSync(path, JSON.stringify({ v: 1, definition: 42, verdicts: [{ chatID: "a b", noise: true, source: "jev", at: 1, reason: "x" }, { chatID: "ok", noise: true, source: "agent", at: 1 }, { chatID: "ok2", noise: true, source: "jev", at: 1 }, { chatID: "fine", noise: true, source: "owner", at: 1, example: "e\u0000x" }], decisions: [{ bogus: true }] }));
    const s = new NoiseStore({ path });
    expect([s.definition, s.size, s.verdict("fine")?.example, s.decisions()]).toEqual(["", 1, "e x", []]);
    rmSync(dir, { recursive: true, force: true });
  });
  test("the owner's verdict sticks: Jev's later verdict leaves it alone; it is an example", () => {
    const s = new NoiseStore();
    s.setDefinition(DEFINITION);
    s.setOwner("c1", false, { title: "Mom", network: "WhatsApp", example: 'WhatsApp "Mom"' });
    expect(s.setJev([jevVerdict("c1", true, NEWSLETTERS)])).toBe(0);
    expect(s.isNoise("c1")).toBe(false);
    s.setOwner("c2", true, { title: "Deals" });
    expect(s.noiseOf("c2")).toEqual({ reason: OWNER_NOISE_REASON, confidence: 1, source: "owner" });
    expect(s.examples()).toEqual([{ example: 'WhatsApp "Mom"', noise: false }]);
    expect(s.decisions().map((d) => [d.chatID, d.source, d.noise, d.reason])).toEqual([["c2", "owner", true, OWNER_NOISE_REASON], ["c1", "owner", false, null]]);
    expect(s.decisions()[1]!.network).toBe("WhatsApp");
  });
  test("a new definition forgets Jev's noise verdicts whose line went, keeps the rest", () => {
    const s = new NoiseStore();
    s.setDefinition(DEFINITION);
    s.setJev([jevVerdict("a", true, NEWSLETTERS), jevVerdict("b", true, COLD), jevVerdict("c", false)]);
    s.setOwner("d", true);
    s.setDefinition(COLD + "\nReceipts");
    expect([s.verdict("a"), s.isNoise("b"), s.verdict("c")?.noise, s.isNoise("d")]).toEqual([undefined, true, false, true]);
  });
  test("decorate: a noise chat is low priority, with why; others are untouched", () => {
    const s = new NoiseStore();
    s.setDefinition(DEFINITION);
    s.setJev([jevVerdict("a", true, NEWSLETTERS)]);
    const c = { id: "a", isLowPriority: false } as ChatSummary;
    expect(s.decorate(c)).toEqual({ id: "a", isLowPriority: true, noise: { reason: NEWSLETTERS, confidence: 0.9, source: "jev" } } as any);
    const other = { id: "b" } as ChatSummary;
    expect(s.decorate(other)).toBe(other);
  });
});

// ------------------------------------------------------------------------------------------------
// The judge and the lists, end to end through the dispatcher

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
});

async function make(o: { key?: string | null; gmail?: boolean; decide?: Decide; callsPerMinute?: number; batchMax?: number; definition?: string } = {}) {
  const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 });
  const assets = new AssetAllowlist();
  const store = new NoiseStore();
  const secrets = new MemorySecretStore();
  if (o.key !== null) await secrets.set("typesafe-api-key", o.key ?? TEST_JEV_KEY);
  const jev = fakeJev(o.decide ?? decide);
  const logs: string[] = [];
  let gmail = null;
  if (o.gmail) {
    gmail = createGmailService({ secrets, refresh: cloudTokenRefresher({ cloudURL: cloud.url, deviceToken: "jid_" + "A".repeat(43) }), gmailURL: fg.url, oauthURL: fg.url });
    await gmail.accounts.add(OWNER_EMAIL, fg.google.issueRefreshToken(OWNER_EMAIL));
  }
  let read: ConstructorParameters<typeof NoiseJudge>[0]["readChat"] = async () => ({ ok: false, error: { code: "INTERNAL", message: "" } });
  const changed: string[][] = [];
  const judge = new NoiseJudge({ store, readChat: (p, ctx) => read(p, ctx), apiKey: () => secrets.get("typesafe-api-key"), url: TEST_JEV_URL, fetchImpl: jev.fetchImpl, debounceMs: 60_000, random: () => 0.5, callsPerMinute: o.callsPerMinute, batchMax: o.batchMax, log: (m) => logs.push(m), onChange: (ids) => changed.push(ids) });
  const d = createDispatcher({ actions: createActions(client, { assets, noise: store }), client, assets, gmail, noise: store, judge });
  read = d.readChat;
  const ok = async <A extends ActionName>(action: A, params: unknown): Promise<ActionResult<A>> => {
    const r = await d.dispatch(action, params);
    if (r.kind !== "res" || !r.ok) throw new Error(`${action}: ${r.kind === "res" && !r.ok ? r.error.code : "media"}`);
    const v = parseActionResult(action, r.data);
    if (!v.ok) throw new Error(`invalid ${action} result: ${JSON.stringify(v.issues)}`);
    return v.value;
  };
  if (o.definition !== "") await ok("set_noise_definition", { definition: o.definition ?? DEFINITION });
  /** New activity in these chats, then the batch at once. */
  const judged = async (...ids: string[]) => {
    for (const id of ids) judge.touch(id);
    await judge.runNow();
  };
  const ids = async (p: Record<string, unknown>) => (await ok("list_chats", { limit: 50, ...p })).items.map((c) => c.id);
  return { d, store, judge, jev, secrets, ok, judged, ids, logs, changed };
}

const ALICE = CHAT_IDS.imessageAlice;

describe("judging new activity", () => {
  test("a newsletter becomes noise: out of All chats, Unread and unread_summary, into Low priority with its reason; nothing changes in Beeper", async () => {
    const t = await make();
    fb.state.receive(ALICE, { text: "This week's digest. Unsubscribe here", senderName: "Alice Chen" });
    expect(await t.ids({ inbox: "primary" })).toContain(ALICE);
    const writesBefore = fb.writes().length;
    await t.judged(ALICE);
    expect(t.jev.requests).toHaveLength(1);
    expect(t.jev.conversations()[0]).toMatchObject({ network: "iMessage", title: "Alice Chen" });
    expect(await t.ids({ inbox: "primary" })).not.toContain(ALICE);
    expect(await t.ids({ inbox: "primary", unreadOnly: true })).not.toContain(ALICE);
    expect((await t.ok("unread_summary", {})).items.map((c) => c.id)).not.toContain(ALICE);
    const low = (await t.ok("list_chats", { inbox: "low-priority", limit: 50 })).items;
    const a = low.find((c) => c.id === ALICE)!;
    expect(a).toMatchObject({ isLowPriority: true, noise: { reason: NEWSLETTERS, confidence: 0.9, source: "jev" } });
    // Beeper's own low-priority chats are still there, newest first.
    const native = fb.state.chatList().filter((c) => c.isLowPriority && !c.isArchived).map((c) => c.id);
    expect(native.length).toBeGreaterThan(0);
    for (const id of native) expect(low.map((c) => c.id)).toContain(id);
    const times = low.map((c) => Date.parse(c.lastActivity ?? "") || 0);
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect((await t.ok("read_chat", { chatID: ALICE, limit: 1 })).chat.noise?.reason).toBe(NEWSLETTERS);
    expect(fb.writes().length).toBe(writesBefore);
    expect(t.logs.join("\n")).not.toMatch(/digest|Alice|Unsubscribe/);
    expect(t.logs).toContain("noise: judged 1 conversations (1 noise)");
  });
  test("the same newest message is not asked about again; a new one is, and not noise brings the chat back", async () => {
    const t = await make();
    fb.state.receive(ALICE, { text: "Digest. Unsubscribe here" });
    await t.judged(ALICE);
    await t.judged(ALICE);
    expect(t.jev.requests).toHaveLength(1);
    fb.state.receive(ALICE, { text: "Are we still on for dinner tonight?" });
    await t.judged(ALICE);
    expect(t.jev.requests).toHaveLength(2);
    expect(t.store.isNoise(ALICE)).toBe(false);
    // Told twice: into Low priority, then out of it (an unchanged verdict says nothing).
    expect(t.changed).toEqual([[ALICE], [ALICE]]);
    expect(await t.ids({ inbox: "primary" })).toContain(ALICE);
    expect(await t.ids({ inbox: "low-priority" })).not.toContain(ALICE);
    expect((await t.ok("get_noise_settings", {})).decisions.map((d) => [d.noise, d.reason])).toEqual([[false, null], [true, NEWSLETTERS]]);
  });
  test("a cold message the owner sent is noise until someone replies", async () => {
    const t = await make();
    const empty = CHAT_IDS.empty;
    await t.ok("send_message", { chatID: empty, text: "Hi! Could I show you our product?" });
    await t.judged(empty);
    expect(t.jev.conversations().at(-1)).toMatchObject({ startedByMe: true, othersReplied: false });
    expect(t.store.noiseOf(empty)?.reason).toBe(COLD);
    expect(await t.ids({ inbox: "primary" })).not.toContain(empty);
    fb.state.receive(empty, { text: "Sure, send me a deck" });
    await t.judged(empty);
    expect(t.store.isNoise(empty)).toBe(false);
    expect(await t.ids({ inbox: "primary" })).toContain(empty);
  });
  test("uncertain is not noise", async () => {
    const t = await make();
    fb.state.receive(ALICE, { text: "UNSURE: unsubscribe maybe" });
    await t.judged(ALICE);
    expect(t.store.verdict(ALICE)).toMatchObject({ noise: false, confidence: 0.6 });
    expect(await t.ids({ inbox: "primary" })).toContain(ALICE);
  });
  test("the owner's verdict sticks and becomes an example; Jev never asks about that chat again", async () => {
    const t = await make();
    fb.state.receive(ALICE, { text: "Digest. Unsubscribe here" });
    await t.judged(ALICE);
    expect(await t.ok("set_noise", { chatID: ALICE, noise: false })).toEqual({ chatID: ALICE, noise: false });
    expect(await t.ids({ inbox: "primary" })).toContain(ALICE);
    fb.state.receive(ALICE, { text: "Another digest. Unsubscribe" });
    await t.judged(ALICE);
    expect(t.jev.requests).toHaveLength(1);
    expect(t.store.isNoise(ALICE)).toBe(false);
    // Marked by hand: noise with the owner's reason; the next call carries both corrections as examples.
    await t.ok("set_noise", { chatID: CHAT_IDS.muted, noise: true });
    expect((await t.ok("read_chat", { chatID: CHAT_IDS.muted, limit: 1 })).chat.noise).toEqual({ reason: OWNER_NOISE_REASON, confidence: 1, source: "owner" });
    fb.state.receive(CHAT_IDS.pinnedUnread, { text: "Hello" });
    await t.judged(CHAT_IDS.pinnedUnread);
    const state = t.jev.requests.at(-1)!.body.state as string;
    expect(state).toContain('"Alice Chen"');
    expect(state).toMatch(/Alice Chen.*=> Not noise/);
    expect(state).toMatch(/=> Noise$/m);
    const settings = await t.ok("get_noise_settings", {});
    expect(settings.decisions[0]).toMatchObject({ chatID: CHAT_IDS.pinnedUnread, source: "jev" });
    expect(settings.decisions.filter((x) => x.source === "owner").map((x) => x.noise)).toEqual([true, false]);
    expect((await t.d.dispatch("set_noise", { chatID: "!nope:beeper.local", noise: true })) as any).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
  test("Jev failing keeps the verdicts, waits and asks again later; the inbox still answers", async () => {
    const t = await make();
    fb.state.receive(ALICE, { text: "Digest. Unsubscribe here" });
    await t.judged(ALICE);
    fb.state.receive(ALICE, { text: "Dinner tonight?" });
    t.jev.failNext(503);
    await t.judged(ALICE);
    expect(t.store.isNoise(ALICE)).toBe(true);
    expect(t.judge.problem).toBe("jev_unreachable");
    expect(t.judge.waiting).toBe(1);
    expect((await t.ok("get_noise_settings", {})).problem).toBe("jev_unreachable");
    expect(await t.ids({ inbox: "primary" })).not.toContain(ALICE);
    t.jev.failNext("network");
    await t.judge.runNow();
    expect([t.store.isNoise(ALICE), t.judge.waiting]).toEqual([true, 1]);
    await t.judge.runNow();
    expect([t.store.isNoise(ALICE), t.judge.waiting, t.judge.problem]).toEqual([false, 0, null]);
    // A refused request (400) is not asked again.
    fb.state.receive(ALICE, { text: "Digest. Unsubscribe" });
    t.jev.failNext(400);
    await t.judged(ALICE);
    expect([t.judge.problem, t.judge.waiting]).toEqual(["jev_refused", 0]);
  });
  test("no key: nothing is asked and nothing waits; Settings says no_key", async () => {
    const t = await make({ key: null });
    fb.state.receive(ALICE, { text: "Digest. Unsubscribe here" });
    await t.judged(ALICE);
    expect([t.jev.requests.length, t.judge.waiting, t.store.isNoise(ALICE)]).toEqual([0, 0, false]);
    expect(await t.ok("get_noise_settings", {})).toMatchObject({ enabled: true, keySet: false, problem: "no_key" });
    await t.secrets.set("typesafe-api-key", TEST_JEV_KEY);
    expect(await t.ok("get_noise_settings", {})).toMatchObject({ keySet: true, problem: null });
  });
  test("an empty definition: nothing is judged, nothing applied; only new activity counts once it is on", async () => {
    const t = await make({ definition: "" });
    fb.state.receive(ALICE, { text: "Digest. Unsubscribe here" });
    await t.judged(ALICE);
    expect(t.jev.requests).toHaveLength(0);
    expect(await t.ok("set_noise_definition", { definition: DEFINITION })).toMatchObject({ definition: DEFINITION, enabled: true, keySet: true, noiseCount: 0 });
    await t.judge.runNow();
    expect(t.jev.requests).toHaveLength(0);
    await t.judged(ALICE);
    expect(t.store.isNoise(ALICE)).toBe(true);
    await t.ok("set_noise_definition", { definition: "" });
    expect(await t.ids({ inbox: "primary" })).toContain(ALICE);
    expect((await t.ok("read_chat", { chatID: ALICE, limit: 1 })).chat.noise).toBeUndefined();
  });
  test("batches of at most batchMax; at most callsPerMinute calls a minute", async () => {
    const t = await make({ batchMax: 2, callsPerMinute: 2 });
    const chats = fb.state.chatList().filter((c) => !c.isArchived).slice(0, 5).map((c) => c.id);
    for (const id of chats) fb.state.receive(id, { text: "Digest. Unsubscribe" });
    await t.judged(...chats);
    await t.judge.runNow();
    await t.judge.runNow();
    expect(t.jev.requests.map((r) => Object.keys(r.body.questions).length)).toEqual([2, 2]);
    expect(t.judge.waiting).toBe(1);
    t.judge.stop();
  });
});

describe("Gmail", () => {
  test("a newsletter thread leaves Primary and joins Low priority with Gmail's other tabs; unread_summary leaves it out", async () => {
    const t = await make({ gmail: true });
    const m = fg.google.deliver(OWNER_EMAIL, { from: "Example News <news@example.com>", subject: "Your weekly digest", text: "Top stories. Unsubscribe here" });
    const id = `gmail:${OWNER_EMAIL}:${m.threadId}`;
    expect(await t.ids({ inbox: "primary" })).toContain(id);
    await t.judged(id);
    expect(t.jev.conversations()[0]).toMatchObject({ network: "Gmail", title: "Your weekly digest", messages: [{ from: "other", name: "Example News", text: "Top stories. Unsubscribe here" }] });
    expect(await t.ids({ inbox: "primary" })).not.toContain(id);
    expect(await t.ids({ inbox: "primary", network: "Gmail" })).not.toContain(id);
    expect((await t.ok("unread_summary", {})).items.map((c) => c.id)).not.toContain(id);
    const low = await t.ok("list_chats", { inbox: "low-priority", limit: 50 });
    expect(low.items.find((c) => c.id === id)).toMatchObject({ isLowPriority: true, noise: { reason: NEWSLETTERS } });
    // Gmail's own other tabs are still there; nothing is asked twice; one entry per failed source.
    const gmailLow = await t.ok("list_chats", { inbox: "low-priority", network: "Gmail", limit: 50 });
    expect(gmailLow.items.some((c) => c.id !== id)).toBe(true);
    expect(new Set(gmailLow.items.map((c) => c.id)).size).toBe(gmailLow.items.length);
    expect(fg.google.sent(OWNER_EMAIL)).toEqual([]);
    expect(fg.google.mailbox(OWNER_EMAIL).thread(m.threadId).flatMap((x) => x.labelIds)).toContain("UNREAD");
  });
});
