// Connector actions against the fake Beeper: filtered paging (F7), unread previews (F5), history
// quirks (TQ4), page shrinking (TQ5), draft safety (F3) and write deduplication (R1-01).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { MAX_FRAME_BYTES, encodeFrame, isRetryable, parseActionResult } from "@j-inbox/protocol";
import { createBeeperClient, beeperErrorCode } from "../src/beeper-client.ts";
import { createActions, createWriteDedupe } from "../src/actions.ts";
import { FileIdempotencyJournal } from "../src/idempotency.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper();
});
afterAll(() => fb.stop());
afterEach(() => fb.reset());

const make = (o: { timeoutMs?: number } = {}) => createActions(createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: o.timeoutMs ?? 5000 }));
const ok = <T>(r: { ok: boolean; data?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
};
const fits = (data: unknown) => encodeFrame({ type: "res", id: "r1", ok: true, data } as any).ok;

async function allPages(fn: (cursor?: string) => Promise<any>) {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page: any = ok(await fn(cursor));
    out.push(...page.items);
    if (!page.hasMore) return out;
    cursor = page.nextCursor;
  }
  throw new Error("no end");
}

describe("beeperErrorCode", () => {
  test("maps Beeper answers; lost answers to writes are UNKNOWN_OUTCOME", () => {
    expect(beeperErrorCode({ status: 404, write: false })).toBe("NOT_FOUND");
    expect(beeperErrorCode({ status: 409, write: true })).toBe("CONFLICT");
    expect(beeperErrorCode({ status: 422, write: true })).toBe("CONFLICT");
    expect(beeperErrorCode({ status: 400, write: true })).toBe("BAD_PARAMS");
    expect(beeperErrorCode({ status: 429, write: true })).toBe("RATE_LIMITED");
    expect(beeperErrorCode({ status: 403, write: false })).toBe("NOT_ALLOWED");
    expect(beeperErrorCode({ status: 401, write: false })).toBe("BEEPER_UNAUTHORIZED");
    expect(beeperErrorCode({ status: 500, write: false })).toBe("BEEPER_DOWN");
    expect(beeperErrorCode({ status: 500, write: true })).toBe("UNKNOWN_OUTCOME");
    expect(beeperErrorCode({ status: 503, write: true })).toBe("UNKNOWN_OUTCOME");
    expect(beeperErrorCode({ network: "refused", write: true })).toBe("BEEPER_DOWN");
    expect(beeperErrorCode({ network: "timeout", write: true })).toBe("UNKNOWN_OUTCOME");
    expect(beeperErrorCode({ network: "timeout", write: false })).toBe("TIMEOUT");
    expect(beeperErrorCode({ network: "other", write: true })).toBe("UNKNOWN_OUTCOME");
  });
});

describe("list_chats: network and pinnedOnly are filtered by the connector across Beeper pages", () => {
  test("network:iMessage returns every iMessage chat exactly once, though there is no iMessage account", async () => {
    const a = make();
    const got = await allPages((cursor) => a.list_chats({ network: "iMessage", limit: 2, ...(cursor ? { cursor } : {}) }));
    const expected = fb.state.chatList().filter((c) => c.network === "iMessage").map((c) => c.id);
    expect(got.map((c) => c.id).sort()).toEqual([...expected].sort());
    expect(new Set(got.map((c) => c.id)).size).toBe(got.length);
    for (const c of got) expect(c.network).toBe("iMessage");
  });
  test("network matches the chat's network case-insensitively (Twitter/X), not the account's (X)", async () => {
    const a = make();
    const tw = ok(await a.list_chats({ network: "twitter/x", limit: 50 }));
    expect(tw.items.length).toBeGreaterThan(0);
    expect(ok(await a.list_chats({ network: "X", limit: 50 })).items).toEqual([]);
  });
  test("pinnedOnly across pages", async () => {
    const a = make();
    const got = await allPages((cursor) => a.list_chats({ pinnedOnly: true, limit: 1, ...(cursor ? { cursor } : {}) }));
    expect(got.map((c) => c.id).sort()).toEqual(fb.state.chatList().filter((c) => c.isPinned).map((c) => c.id).sort());
  });
  test("results validate and a foreign cursor is BAD_PARAMS", async () => {
    const a = make();
    const r = ok(await a.list_chats({ limit: 25 }));
    expect(parseActionResult("list_chats", r).ok).toBe(true);
    expect((await a.list_chats({ cursor: "not-ours" })).error?.code).toBe("BAD_PARAMS");
  });
});

describe("unread_summary uses /v1/chats so every unread chat has its latest message", () => {
  test("previews are present and match the newest message", async () => {
    const r = ok(await make().unread_summary({ limit: 50 }));
    expect(parseActionResult("unread_summary", r).ok).toBe(true);
    const expected = fb.state.chatList().filter((c) => c.unreadCount > 0 || c.isMarkedUnread);
    expect(r.totalUnreadChats).toBe(expected.length);
    expect(r.totalUnreadMessages).toBe(expected.reduce((n, c) => n + c.unreadCount, 0));
    for (const c of r.items) {
      if (fb.state.messagesOf(c.id).length === 0) continue;
      expect(c.preview?.id).toBe(fb.state.lastMessage(c.id)!.id);
    }
    expect(fb.state.calls.some((c) => c.route === "GET /v1/chats/search")).toBe(false);
  });
  test("limit caps items and marks truncated", async () => {
    const r = ok(await make().unread_summary({ limit: 2 }));
    expect(r.items.length).toBe(2);
    expect(r.truncated).toBe(true);
  });
});

describe("read_chat", () => {
  test("pages through 250 messages oldest-first per page, no duplicates or gaps", async () => {
    const a = make();
    const pages: any[] = [];
    let cursor: string | undefined;
    for (;;) {
      const p = ok(await a.read_chat({ chatID: CHAT_IDS.longHistory, limit: 50, ...(cursor ? { cursor } : {}) }));
      expect(parseActionResult("read_chat", p).ok).toBe(true);
      pages.push(p);
      if (!p.hasMore) break;
      cursor = p.nextCursor!;
    }
    const keys = pages.flatMap((p) => p.items.map((m: any) => Number(m.sortKey)));
    for (const p of pages) expect(p.items.map((m: any) => Number(m.sortKey))).toEqual([...p.items.map((m: any) => Number(m.sortKey))].sort((x, y) => x - y));
    expect(new Set(keys).size).toBe(250);
    expect(pages.length).toBe(5);
  });
  test("works the same whatever order Beeper uses inside a page", async () => {
    fb.controls.messageOrder = "asc";
    const p = ok(await make().read_chat({ chatID: CHAT_IDS.longHistory, limit: 30 }));
    const all = fb.state.messagesOf(CHAT_IDS.longHistory).map((m) => m.id);
    expect(p.items.map((m: any) => m.id)).toEqual(all.slice(-30));
  });
  test("real iMessage quirk: an empty older page after hasMore:true ends history instead of looping", async () => {
    fb.controls.emptyOlderPageForIMessage = true;
    const p = ok(await make().read_chat({ chatID: CHAT_IDS.imessageLong, limit: 50 }));
    expect(p.items.length).toBe(20);
    expect(p.hasMore).toBe(false);
    expect(p.nextCursor).toBeNull();
    expect(p.items.every((m: any) => m.type === "TEXT")).toBe(true);
  });
  test("a page too big for one frame is shrunk; the cursor continues exactly after it", async () => {
    const chatID = CHAT_IDS.longHistory;
    for (const m of fb.state.messagesOf(chatID).slice(-100)) {
      m.text = "語".repeat(5000);
      m.attachments = Array.from({ length: 10 }, (_, k) => ({ type: "img" as const, srcURL: `mxc://beeper.local/${"a".repeat(200)}${k}`, fileName: "語".repeat(100) + ".jpg", mimeType: "image/jpeg" }));
      m.reactions = Array.from({ length: 50 }, (_, k) => ({ id: `r${k}`, reactionKey: "👍🏽", participantID: `@whatsapp_1555${String(k).padStart(7, "0")}:beeper.local` }));
    }
    fb.controls.messagesPageSize = 50;
    const a = make();
    const p1 = ok(await a.read_chat({ chatID, limit: 50 }));
    expect(p1.items.length).toBeGreaterThan(0);
    expect(p1.items.length).toBeLessThan(50);
    expect(p1.hasMore).toBe(true);
    expect(fits(p1)).toBe(true);
    const p2 = ok(await a.read_chat({ chatID, limit: 50, cursor: p1.nextCursor! }));
    expect(fits(p2)).toBe(true);
    const all = fb.state.messagesOf(chatID).map((m) => m.id);
    const got = [...p2.items, ...p1.items].map((m: any) => m.id);
    expect(got).toEqual(all.slice(all.length - got.length));
    expect(JSON.stringify(p1).length).toBeLessThan(MAX_FRAME_BYTES);
  });
  test("unknown chat is NOT_FOUND; ids with # / ? are encoded", async () => {
    const a = make();
    expect((await a.read_chat({ chatID: "imsg##thread:nope" })).error?.code).toBe("NOT_FOUND");
    expect(ok(await a.read_chat({ chatID: CHAT_IDS.imessageWeird })).items.length).toBe(5);
  });
});

describe("draft_reply never replaces the owner's draft", () => {
  test("a chat with a half-typed draft answers CONFLICT and nothing is written", async () => {
    const r = await make().draft_reply({ chatID: CHAT_IDS.draftInProgress, text: "agent text" });
    expect(r.error?.code).toBe("CONFLICT");
    expect(fb.writes()).toEqual([]);
    expect(fb.state.chats.get(CHAT_IDS.draftInProgress)!.draft?.text).toBe("Hi, could we move my appointment to");
  });
  test("an empty draft is set once", async () => {
    const r = ok(await make().draft_reply({ chatID: CHAT_IDS.imessageAlice, text: "hello" }));
    expect(r).toEqual({ chatID: CHAT_IDS.imessageAlice, draftSet: true });
    expect(fb.writes().length).toBe(1);
  });
  test("if Beeper refuses because a draft appeared meanwhile, the answer is CONFLICT", async () => {
    fb.failNext({ method: "PATCH", status: 409, code: "CONFLICT" });
    expect((await make().draft_reply({ chatID: CHAT_IDS.imessageAlice, text: "x" })).error?.code).toBe("CONFLICT");
  });
});

describe("send_message: no double sends", () => {
  const params = { chatID: CHAT_IDS.imessageAlice, text: "only once", idempotencyKey: "key_0123456789" };
  test("the same key twice reaches Beeper once and replays the result", async () => {
    const a = make();
    const r1 = ok(await a.send_message(params));
    const r2 = ok(await a.send_message(params));
    expect(r2).toEqual(r1);
    expect(fb.writes().length).toBe(1);
  });
  test("concurrent duplicates share one POST", async () => {
    const a = make();
    fb.controls.latencyMs = 50;
    const [r1, r2] = await Promise.all([a.send_message(params), a.send_message(params)]);
    expect(r1).toEqual(r2);
    expect(fb.writes().length).toBe(1);
  });
  test("a Beeper 500 is UNKNOWN_OUTCOME and a retry with the same key does not send again", async () => {
    const a = make();
    fb.failNext({ method: "POST", route: "/v1/chats/{chatID}/messages", status: 500 });
    expect((await a.send_message(params)).error?.code).toBe("UNKNOWN_OUTCOME");
    expect((await a.send_message(params)).error?.code).toBe("UNKNOWN_OUTCOME");
    expect(fb.writes().length).toBe(1);
  });
  test("a timeout after sending is UNKNOWN_OUTCOME, never TIMEOUT", async () => {
    const a = make({ timeoutMs: 150 });
    fb.hangNext({ method: "POST" });
    const r = await a.send_message(params);
    fb.releaseHangs();
    expect(r.error?.code).toBe("UNKNOWN_OUTCOME");
    expect(fb.writes().length).toBe(1);
  });
  test("Beeper down (connection refused) is BEEPER_DOWN and the same key may run again later", async () => {
    const a = make({ timeoutMs: 1000 });
    await fb.pause();
    try {
      expect((await a.send_message(params)).error?.code).toBe("BEEPER_DOWN");
    } finally {
      await fb.resume();
    }
    ok(await a.send_message(params));
    expect(fb.writes().length).toBe(1);
  });
  // tests-r2-TQ2-07 + spec-r2-R2-SPEC-1: which failures may run again under the same key.
  for (const status of [429, 401]) {
    test(`Beeper ${status} proves nothing was sent: the same key reaches Beeper again and succeeds`, async () => {
      const a = make();
      fb.failNext({ method: "POST", route: "/v1/chats/{chatID}/messages", status });
      const r1 = await a.send_message(params);
      expect(r1.error?.code).toBe(status === 429 ? "RATE_LIMITED" : "BEEPER_UNAUTHORIZED");
      ok(await a.send_message(params));
      expect(fb.writes().length).toBe(2);
    });
  }
  for (const status of [502, 503]) {
    test(`Beeper ${status} on a send may have gone out: UNKNOWN_OUTCOME, remembered, no second POST`, async () => {
      const a = make();
      fb.failNext({ method: "POST", route: "/v1/chats/{chatID}/messages", status });
      const r1 = await a.send_message(params);
      expect(r1.error?.code).toBe("UNKNOWN_OUTCOME");
      expect(isRetryable(r1.error!.code, "send_message")).toBe(false);
      expect((await a.send_message(params)).error?.code).toBe("UNKNOWN_OUTCOME");
      expect(fb.writes().length).toBe(1);
    });
  }
  // stability-r2-R2-2 / tests-r2-TQ2-01
  test("the same key with different text is CONFLICT and the second text is not reported as sent", async () => {
    const a = make();
    ok(await a.send_message({ chatID: CHAT_IDS.imessageAlice, text: "Yes, I'll come", idempotencyKey: "k1_reused_key" }));
    const r = await a.send_message({ chatID: CHAT_IDS.imessageAlice, text: "Sorry, I can't make it", idempotencyKey: "k1_reused_key" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("CONFLICT");
    expect(r.error?.message).toMatch(/different/i);
    expect(fb.writes().length).toBe(1);
  });
  test("the same key with a different replyToMessageID is CONFLICT", async () => {
    const a = make();
    ok(await a.send_message({ ...params }));
    expect((await a.send_message({ ...params, replyToMessageID: "some-other-message" })).error?.code).toBe("CONFLICT");
    expect(fb.writes().length).toBe(1);
  });
  // stability-r2-R2-1
  test("a send in flight when the connector died answers UNKNOWN_OUTCOME after restart and is not sent again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jinbox-actions-"));
    try {
      const journalPath = join(dir, "idempotency.json");
      const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 });
      fb.hangNext({ method: "POST" });
      const before = createActions(client, { idempotency: createWriteDedupe({ journal: new FileIdempotencyJournal(journalPath) }) });
      void before.send_message(params); // Beeper accepts, then the process dies before answering
      for (let i = 0; i < 100 && fb.writes().length === 0; i++) await Bun.sleep(10);
      const after = createActions(client, { idempotency: createWriteDedupe({ journal: new FileIdempotencyJournal(journalPath) }) });
      const r = await after.send_message(params);
      expect(r.error?.code).toBe("UNKNOWN_OUTCOME");
      expect(fb.writes().length).toBe(1);
      expect(readFileSync(journalPath, "utf8")).not.toContain("only once");
    } finally {
      fb.releaseHangs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("the journal on disk never holds the chat id; a replay after restart still answers with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jinbox-actions-"));
    try {
      const journalPath = join(dir, "idempotency.json");
      const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 });
      const first = await createActions(client, { idempotency: createWriteDedupe({ journal: new FileIdempotencyJournal(journalPath) }) }).send_message(params);
      ok(first);
      const reactParams = { chatID: CHAT_IDS.imessageAlice, messageID: "26.1", reactionKey: "👍", idempotencyKey: "react_key_1" };
      const firstReact = await createActions(client, { idempotency: createWriteDedupe({ journal: new FileIdempotencyJournal(journalPath) }) }).react(reactParams);
      const disk = readFileSync(journalPath, "utf8");
      expect(disk).not.toContain(params.chatID);
      expect(disk).not.toContain("15550201001");
      const after = createActions(client, { idempotency: createWriteDedupe({ journal: new FileIdempotencyJournal(journalPath) }) });
      expect(await after.send_message(params)).toEqual(first);
      expect(await after.react(reactParams)).toEqual(firstReact);
      expect(fb.writes().filter((w) => w.method === "POST").length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("without a key every call is a new send", async () => {
    const a = make();
    ok(await a.send_message({ chatID: CHAT_IDS.imessageAlice, text: "a" }));
    ok(await a.send_message({ chatID: CHAT_IDS.imessageAlice, text: "a" }));
    expect(fb.writes().length).toBe(2);
  });
  test("the same key for a different action or chat is a different write", async () => {
    const a = make();
    ok(await a.send_message(params));
    ok(await a.send_message({ ...params, chatID: CHAT_IDS.longHistory }));
    expect(fb.writes().length).toBe(2);
  });
});

// tests-r2-TQ2-02: cursors are bound to the action and chat (or filters) that minted them.
describe("cursors cannot be mixed up", () => {
  test("another chat's read_chat cursor is BAD_PARAMS, not an empty history", async () => {
    const a = make();
    const p1 = ok(await a.read_chat({ chatID: CHAT_IDS.longHistory, limit: 20 }));
    expect(p1.nextCursor).not.toBeNull();
    const r = await a.read_chat({ chatID: CHAT_IDS.imessageLong, limit: 20, cursor: p1.nextCursor! });
    expect(r.error?.code).toBe("BAD_PARAMS");
  });
  test("a list_chats cursor passed to read_chat is BAD_PARAMS", async () => {
    const a = make();
    const l = ok(await a.list_chats({ limit: 2 }));
    expect((await a.read_chat({ chatID: CHAT_IDS.longHistory, cursor: l.nextCursor! })).error?.code).toBe("BAD_PARAMS");
  });
  test("a garbage cursor on read_chat is BAD_PARAMS", async () => {
    for (const cursor of ["garbage", "j2.e30", "j1." + btoa('{"b":null,"k":null}')]) expect((await make().read_chat({ chatID: CHAT_IDS.longHistory, cursor })).error?.code).toBe("BAD_PARAMS");
  });
  test("a list_chats cursor reused with different filters is BAD_PARAMS", async () => {
    const a = make();
    const l = ok(await a.list_chats({ network: "iMessage", limit: 1 }));
    expect((await a.list_chats({ network: "WhatsApp", limit: 1, cursor: l.nextCursor! })).error?.code).toBe("BAD_PARAMS");
    expect(ok(await a.list_chats({ network: "imessage", limit: 1, cursor: l.nextCursor! })).items.length).toBe(1);
  });
});

// stability-r2-R2-4: long ids and long Beeper cursors never make paging stuck on INTERNAL.
describe("long ids and long Beeper cursors", () => {
  const stub = (idLength: number, beeperCursorLength: number) => {
    const chat = (p: string, i: number) => ({ id: (p + i).padEnd(idLength, "x"), accountID: "whatsapp", network: "WhatsApp", title: `${p}${i}`, type: "single", unreadCount: 0, isPinned: false, isMuted: false, isArchived: false });
    const older = "C".repeat(beeperCursorLength);
    const calls: string[] = [];
    const client = {
      chatPath: (id: string, ...rest: string[]) => ["/v1/chats", encodeURIComponent(id), ...rest].join("/"),
      get: async (path: string) => {
        calls.push(path);
        const cursor = new URL(path, "http://x").searchParams.get("cursor");
        return cursor === older
          ? { ok: true as const, status: 200, body: { items: [0, 1, 2].map((i) => chat("b", i)), hasMore: false, oldestCursor: null } }
          : { ok: true as const, status: 200, body: { items: [0, 1, 2].map((i) => chat("a", i)), hasMore: true, oldestCursor: older } };
      },
      write: async () => ({ ok: false as const, error: { code: "INTERNAL" as const, message: "x" } }),
      stream: async () => ({ ok: false as const, error: { code: "INTERNAL" as const, message: "x" } }),
      upload: async () => ({ ok: false as const, error: { code: "INTERNAL" as const, message: "x" } }),
    };
    return { actions: createActions(client), calls };
  };
  for (const idLength of [301, 512]) {
    test(`${idLength}-char ids and a 450-char Beeper cursor page through every chat one by one`, async () => {
      const { actions } = stub(idLength, 450);
      const got = await allPages((cursor) => actions.list_chats({ limit: 1, ...(cursor ? { cursor } : {}) }));
      expect(got.map((c) => c.title)).toEqual(["a0", "a1", "a2", "b0", "b1", "b2"]);
    });
  }
  test("a Beeper cursor too long to wrap is a non-retryable TOO_LARGE, never INTERNAL", async () => {
    const { actions } = stub(40, 2000);
    const r = await actions.list_chats({ limit: 3 });
    expect(r.error?.code).toBe("TOO_LARGE");
    expect(isRetryable(r.error!.code, "list_chats")).toBe(false);
  });
});

// spec-r2-R2-SPEC-2: new messages between pages do not turn "older" pages into newer ones.
describe("read_chat while new messages arrive", () => {
  test("the next page continues right before the last message returned", async () => {
    const a = make();
    const chatID = CHAT_IDS.longHistory;
    const p1 = ok(await a.read_chat({ chatID, limit: 5 }));
    for (let i = 0; i < 25; i++) fb.state.receive(chatID, { text: `new ${i}` });
    const p2 = ok(await a.read_chat({ chatID, limit: 5, cursor: p1.nextCursor! }));
    const all = fb.state.messagesOf(chatID).map((m) => m.id).slice(0, 250);
    expect(p1.items.map((m: any) => m.id)).toEqual(all.slice(245, 250));
    expect(p2.items.map((m: any) => m.id)).toEqual(all.slice(240, 245));
  });
});

// tests-r2-TQ2-08: when the scan stops early, unread_summary says so.
describe("unread_summary scan budget", () => {
  test("a scan that stops before Beeper's last page reports truncated:true", async () => {
    const a = createActions(createBeeperClient({ baseURL: fb.url, token: fb.token }), { scan: { maxPages: 1 } });
    const r = ok(await a.unread_summary({ limit: 50 }));
    const unreadEverywhere = fb.state.chatList().filter((c) => c.unreadCount > 0 || c.isMarkedUnread).length;
    expect(r.totalUnreadChats).toBeLessThan(unreadEverywhere);
    expect(r.items.length).toBe(r.totalUnreadChats);
    expect(r.truncated).toBe(true);
  });
});

// stability-r2-R2-3: one deadline and one cancel signal per request, across every Beeper call.
import { requestContext } from "../src/actions.ts";
describe("request deadline and cancel", () => {
  const callsTo = (chatID: string) => fb.state.calls.filter((c) => c.params.chatID === chatID).length;
  test("a slow Beeper makes a multi-call read answer TIMEOUT within the request timeout, not after it", async () => {
    fb.controls.latencyMs = 600; // like 6 s per call against a 15 s request timeout, scaled down
    const a = make({ timeoutMs: 5000 });
    const t0 = performance.now();
    const r = await a.read_chat({ chatID: CHAT_IDS.longHistory, limit: 30 }, requestContext({ timeoutMs: 1000, marginMs: 100 }));
    const ms = performance.now() - t0;
    expect(r.error?.code).toBe("TIMEOUT");
    expect(ms).toBeLessThan(1000);
  });
  test("a cancel stops further Beeper calls", async () => {
    fb.controls.latencyMs = 150;
    fb.controls.messagesPageSize = 10;
    const a = make();
    const cancel = new AbortController();
    const done = a.read_chat({ chatID: CHAT_IDS.longHistory, limit: 50 }, requestContext({ timeoutMs: 10_000, cancel: cancel.signal }));
    await Bun.sleep(200);
    cancel.abort();
    const r = await done;
    expect(r.ok).toBe(false);
    await Bun.sleep(700);
    expect(callsTo(CHAT_IDS.longHistory)).toBeLessThanOrEqual(2);
  });
  test("draft_reply: when the deadline passes during the GET, the PATCH is never dispatched", async () => {
    fb.controls.latencyMs = 600;
    const a = make();
    const r = await a.draft_reply({ chatID: CHAT_IDS.imessageAlice, text: "late" }, requestContext({ timeoutMs: 500, marginMs: 0 }));
    expect(r.error?.code).toBe("TIMEOUT");
    await Bun.sleep(900);
    expect(fb.writes()).toEqual([]);
  });
  test("send_message after the deadline is TIMEOUT, not dispatched, and the same key may run later", async () => {
    const a = make();
    const ctl = new AbortController();
    ctl.abort();
    const p = { chatID: CHAT_IDS.imessageAlice, text: "x", idempotencyKey: "deadline_key_1" };
    expect((await a.send_message(p, { signal: ctl.signal })).error?.code).toBe("TIMEOUT");
    expect(fb.writes()).toEqual([]);
    ok(await a.send_message(p));
    expect(fb.writes().length).toBe(1);
  });
});

// privacy-r2-P2-3: the owner's unsent draft never leaves the Mac.
describe("draft text stays local", () => {
  const DRAFT = "Hi, could we move my appointment to";
  test("read_chat, list_chats and unread_summary say hasDraft, never the draft text", async () => {
    const a = make();
    fb.state.chats.get(CHAT_IDS.draftInProgress)!.unreadCount = 2;
    const read = ok(await a.read_chat({ chatID: CHAT_IDS.draftInProgress }));
    expect(read.chat.hasDraft).toBe(true);
    const all = [read, ok(await a.list_chats({ limit: 50 })), ok(await a.unread_summary({ limit: 50 }))];
    for (const r of all) expect(JSON.stringify(r)).not.toContain(DRAFT);
    expect(JSON.stringify(all)).not.toContain("draftText");
  });
});

// spec-r2-R2-SPEC-3: unread_summary matches Beeper's inbox (no archived, no low-priority chats).
describe("unread_summary leaves out archived and low-priority chats", () => {
  test("an archived and a low-priority chat with unread messages are not counted", async () => {
    const a = make();
    const before = ok(await a.unread_summary({ limit: 50 }));
    const archived = fb.state.chats.get(CHAT_IDS.archived)!;
    archived.unreadCount = 3;
    const muted = fb.state.chats.get(CHAT_IDS.muted)!;
    muted.isLowPriority = true; // had 4 unread
    const after = ok(await a.unread_summary({ limit: 50 }));
    expect(after.totalUnreadChats).toBe(before.totalUnreadChats - 1);
    expect(after.totalUnreadMessages).toBe(before.totalUnreadMessages - 4);
    const ids = after.items.map((c: any) => c.id);
    expect(ids).not.toContain(CHAT_IDS.archived);
    expect(ids).not.toContain(CHAT_IDS.muted);
  });
  test("mapped chats carry isLowPriority so callers can filter", async () => {
    fb.state.chats.get(CHAT_IDS.muted)!.isLowPriority = true;
    const l = ok(await make().list_chats({ limit: 50 }));
    expect(l.items.find((c: any) => c.id === CHAT_IDS.muted)?.isLowPriority).toBe(true);
  });
});

// spec-r2-R2-SPEC-4 (+ SPEC-5): status lists the networks the owner can actually use.
describe("status", () => {
  test("networks come from chats too: iMessage (no account) and Twitter/X (account says X)", async () => {
    const r = ok(await createActions(createBeeperClient({ baseURL: fb.url, token: fb.token }), { connectorVersion: "0.1.0" }).status({}));
    expect(parseActionResult("status", r).ok).toBe(true);
    expect(r.accounts.some((x: any) => x.network === "iMessage")).toBe(false);
    expect(r.networks).toContain("iMessage");
    expect(r.networks).toContain("Twitter/X");
    expect(r.networks).toContain("WhatsApp");
    expect(r.networks).not.toContain("X");
    expect(r.networks).not.toContain("Unknown");
    expect(r.beeper).toMatchObject({ reachable: true, version: expect.any(String) });
    expect(r.connectorVersion).toBe("0.1.0");
  });
  test("a rejected token is reachable:true, tokenValid:false (not 'Beeper down')", async () => {
    const r = ok(await createActions(createBeeperClient({ baseURL: fb.url, token: "revoked-token" })).status({}));
    expect(r.beeper).toMatchObject({ reachable: true, tokenValid: false });
    expect(r.accounts).toEqual([]);
  });
  test("Beeper not running is reachable:false", async () => {
    await fb.pause();
    try {
      const r = ok(await createActions(createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 1000 })).status({}));
      expect(r.beeper?.reachable).toBe(false);
    } finally {
      await fb.resume();
    }
  });
});
