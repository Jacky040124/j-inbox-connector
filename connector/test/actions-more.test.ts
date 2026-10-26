// search_messages, react, mark_read, archive and the asset allowlist plumbing, against fake Beeper.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ASSET_URLS, CHAT_IDS, HOSTILE_TEXTS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { parseActionResult } from "@j-inbox/protocol";
import { createBeeperClient } from "../src/beeper-client.ts";
import { createActions } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";

let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper();
});
afterAll(() => fb.stop());
afterEach(() => fb.reset());

const make = (assets = new AssetAllowlist()) => ({ a: createActions(createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 }), { assets }), assets });
const ok = <T>(r: { ok: boolean; data?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
};

describe("search_messages", () => {
  test("finds messages across networks, with the chats they belong to, valid per the protocol", async () => {
    const { a } = make();
    const r = ok(await a.search_messages({ query: "dinner", limit: 20 }));
    expect(parseActionResult("search_messages", r).ok).toBe(true);
    expect(r.items.length).toBeGreaterThan(0);
    for (const m of r.items) {
      expect(m.text?.toLowerCase()).toContain("dinner");
      expect(r.chats[m.chatID]).toBeDefined();
    }
    // only chats of returned items
    expect(Object.keys(r.chats).every((id) => r.items.some((m: any) => m.chatID === id))).toBe(true);
  });
  test("passes query, sender, dates and ids to Beeper as query parameters (ids encoded by URLSearchParams)", async () => {
    const { a } = make();
    await a.search_messages({ query: "a b", sender: "me", dateAfter: "2026-01-01T00:00:00.000Z", dateBefore: "2026-12-01T00:00:00.000Z", chatIDs: [CHAT_IDS.imessageWeird], accountIDs: ["imessage"], limit: 5 });
    const call = fb.state.calls.find((c) => c.route === "GET /v1/messages/search")!;
    expect(call.query.query).toEqual(["a b"]);
    expect(call.query.sender).toEqual(["me"]);
    expect(call.query.chatIDs).toEqual([CHAT_IDS.imessageWeird]);
    expect(call.query.accountIDs).toEqual(["imessage"]);
    expect(call.query.dateAfter).toEqual(["2026-01-01T00:00:00.000Z"]);
  });
  test("pages with a j2 cursor bound to this search: every hit once, other searches refuse the cursor", async () => {
    const { a } = make();
    const all: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const r = ok(await a.search_messages({ query: "the", limit: 3, ...(cursor ? { cursor } : {}) }));
      all.push(...r.items.map((m: any) => `${m.chatID}|${m.id}`));
      if (!r.hasMore) break;
      expect(r.nextCursor).toStartWith("j2.");
      cursor = r.nextCursor!;
    }
    expect(all.length).toBeGreaterThan(3);
    expect(new Set(all).size).toBe(all.length);
    const r1 = ok(await a.search_messages({ query: "the", limit: 3 }));
    const other = await a.search_messages({ query: "dinner", limit: 3, cursor: r1.nextCursor! });
    expect(other.error?.code).toBe("BAD_PARAMS");
  });
  test("network is filtered by the connector on the chat's network", async () => {
    const { a } = make();
    const r = ok(await a.search_messages({ query: "the", network: "iMessage", limit: 20 }));
    expect(r.items.length).toBeGreaterThan(0);
    for (const m of r.items) expect(r.chats[m.chatID]!.network).toBe("iMessage");
  });
  test("hostile message text is sanitized and stays valid", async () => {
    const { a } = make();
    const r = ok(await a.search_messages({ query: "script", limit: 20 }));
    expect(parseActionResult("search_messages", r).ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("\u0000");
    expect(HOSTILE_TEXTS.script.length).toBeGreaterThan(0);
  });
  test("Beeper 500 on a read is BEEPER_DOWN (retryable)", async () => {
    const { a } = make();
    fb.failNext({ route: "/v1/messages/search", status: 500 });
    expect((await a.search_messages({ query: "x" })).error?.code).toBe("BEEPER_DOWN");
  });
});

describe("react", () => {
  test("posts the reaction to the encoded message path and answers the protocol shape", async () => {
    const { a } = make();
    const msgs = fb.state.messagesOf(CHAT_IDS.imessageWeird);
    const target = msgs[0]!;
    const r = ok(await a.react({ chatID: CHAT_IDS.imessageWeird, messageID: target.id, reactionKey: "👍" }));
    expect(r).toEqual({ chatID: CHAT_IDS.imessageWeird, messageID: target.id, reactionKey: "👍" });
    expect(parseActionResult("react", r).ok).toBe(true);
    const w = fb.writes();
    expect(w.length).toBe(1);
    expect(w[0]!.route).toBe("POST /v1/chats/{chatID}/messages/{messageID}/reactions");
    expect(w[0]!.params).toEqual({ chatID: CHAT_IDS.imessageWeird, messageID: target.id });
  });
  test("the same idempotencyKey reaches Beeper once; another key with other params is CONFLICT", async () => {
    const { a } = make();
    const mid = fb.state.messagesOf(CHAT_IDS.imessageAlice)[0]!.id;
    const p = { chatID: CHAT_IDS.imessageAlice, messageID: mid, reactionKey: "❤️", idempotencyKey: "react_key_0001" };
    const [x, y] = await Promise.all([a.react(p), a.react(p)]);
    expect(x).toEqual(y);
    ok(await a.react(p));
    expect(fb.writes().length).toBe(1);
    expect((await a.react({ ...p, reactionKey: "😂" })).error?.code).toBe("CONFLICT");
    expect(fb.writes().length).toBe(1);
  });
  test("unknown message is NOT_FOUND; Beeper 502 is UNKNOWN_OUTCOME (never retryable)", async () => {
    const { a } = make();
    expect((await a.react({ chatID: CHAT_IDS.imessageAlice, messageID: "nope", reactionKey: "👍" })).error?.code).toBe("NOT_FOUND");
    const mid = fb.state.messagesOf(CHAT_IDS.imessageAlice)[0]!.id;
    fb.failNext({ route: "/v1/chats/{chatID}/messages/{messageID}/reactions", status: 502 });
    expect((await a.react({ chatID: CHAT_IDS.imessageAlice, messageID: mid, reactionKey: "👍" })).error?.code).toBe("UNKNOWN_OUTCOME");
  });
});

describe("mark_read", () => {
  test("read:true posts /read (optionally up to a message) and clears the unread count", async () => {
    const { a } = make();
    const r = ok(await a.mark_read({ chatID: CHAT_IDS.imessageAlice, read: true }));
    expect(r).toEqual({ chatID: CHAT_IDS.imessageAlice, read: true });
    expect(fb.state.chats.get(CHAT_IDS.imessageAlice)!.unreadCount).toBe(0);
    const mid = fb.state.messagesOf(CHAT_IDS.longHistory)[10]!.id;
    ok(await a.mark_read({ chatID: CHAT_IDS.longHistory, messageID: mid, read: true }));
    expect(fb.writes()[1]!.body).toEqual({ messageID: mid });
  });
  test("read:false posts /unread", async () => {
    const { a } = make();
    expect(ok(await a.mark_read({ chatID: CHAT_IDS.imessageWeird, read: false }))).toEqual({ chatID: CHAT_IDS.imessageWeird, read: false });
    expect(fb.writes()[0]!.route).toBe("POST /v1/chats/{chatID}/unread");
    expect(fb.state.chats.get(CHAT_IDS.imessageWeird)!.isMarkedUnread).toBe(true);
  });
  test("defaults to read:true when read is absent", async () => {
    const { a } = make();
    ok(await a.mark_read({ chatID: CHAT_IDS.imessageAlice } as any));
    expect(fb.writes()[0]!.route).toBe("POST /v1/chats/{chatID}/read");
  });
  test("unknown chat is NOT_FOUND", async () => {
    const { a } = make();
    expect((await a.mark_read({ chatID: "!nope:x", read: true })).error?.code).toBe("NOT_FOUND");
  });
});

describe("archive", () => {
  test("archives and unarchives (204 from Beeper)", async () => {
    const { a } = make();
    expect(ok(await a.archive({ chatID: CHAT_IDS.imessageWeird, archived: true }))).toEqual({ chatID: CHAT_IDS.imessageWeird, archived: true });
    expect(fb.state.chats.get(CHAT_IDS.imessageWeird)!.isArchived).toBe(true);
    expect(ok(await a.archive({ chatID: CHAT_IDS.imessageWeird, archived: false }))).toEqual({ chatID: CHAT_IDS.imessageWeird, archived: false });
    expect(fb.state.chats.get(CHAT_IDS.imessageWeird)!.isArchived).toBe(false);
    expect(fb.writes().map((w) => w.body)).toEqual([{ archived: true }, { archived: false }]);
  });
  test("Beeper unreachable is BEEPER_DOWN (nothing happened)", async () => {
    const { a } = make();
    await fb.pause();
    try {
      expect((await a.archive({ chatID: CHAT_IDS.imessageWeird, archived: true })).error?.code).toBe("BEEPER_DOWN");
    } finally {
      await fb.resume();
    }
  });
});

describe("asset allowlist is fed by every result", () => {
  test("read_chat attachments and list_chats avatars are allowed afterwards; others are not", async () => {
    const { a, assets } = make();
    expect(assets.has(ASSET_URLS.imgSmall)).toBe(false);
    ok(await a.read_chat({ chatID: CHAT_IDS.media, limit: 30 }));
    expect(assets.has(ASSET_URLS.imgSmall)).toBe(true);
    expect(assets.has(ASSET_URLS.videoBig)).toBe(true);
    ok(await a.list_chats({ limit: 50 }));
    expect(assets.has(ASSET_URLS.avatar1)).toBe(true);
    expect(assets.has("file:///etc/passwd")).toBe(false);
  });
  test("unread_summary previews and search results also count", async () => {
    const { a, assets } = make();
    ok(await a.unread_summary({ limit: 50 }));
    ok(await a.search_messages({ query: "photo", limit: 20 }));
    expect(assets.has(ASSET_URLS.imgMedium)).toBe(true);
  });
});
