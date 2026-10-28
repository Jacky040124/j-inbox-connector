// Fix round 1: the fake must model what the real Beeper API does, and must not hide double sends.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ACCOUNTS, CHAT_IDS, startFakeBeeper, type FakeBeeper } from "../src/index.ts";

let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper();
});
afterAll(() => fb.stop());
afterEach(() => fb.reset());

const enc = encodeURIComponent;
const auth = () => ({ authorization: `Bearer ${fb.token}` });
const get = async (path: string) => {
  const r = await fetch(fb.url + path, { headers: auth() });
  return { status: r.status, body: (await r.json()) as any };
};
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = auth()) =>
  fetch(fb.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const sendPath = (id: string) => `/v1/chats/${enc(id)}/messages`;

// tests-r1-TQ1
describe("every request is logged, including injected faults", () => {
  test("a POST answered by failNext is still a write: two sends after a 500 are two writes", async () => {
    fb.failNext({ method: "POST", route: "/v1/chats/{chatID}/messages", status: 500 });
    expect((await send("POST", sendPath(CHAT_IDS.imessageAlice), { text: "one" })).status).toBe(500);
    expect((await send("POST", sendPath(CHAT_IDS.imessageAlice), { text: "one" })).status).toBe(200);
    const w = fb.writes();
    expect(w.length).toBe(2);
    expect(w[0]).toMatchObject({ method: "POST", route: "POST /v1/chats/{chatID}/messages", injected: "fail", status: 500, body: { text: "one" } });
    expect(w[1]!.injected).toBeUndefined();
  });
  test("a hung POST is logged as a write before it hangs", async () => {
    fb.hangNext({ method: "POST" });
    const pending = send("POST", sendPath(CHAT_IDS.imessageAlice), { text: "held?" }).catch(() => null);
    await Bun.sleep(30);
    expect(fb.writes()).toEqual([expect.objectContaining({ method: "POST", injected: "hang" })]);
    fb.releaseHangs();
    await pending;
  });
  test("unauthorized writes are logged as unauthorized, and still count as attempts", async () => {
    await send("POST", sendPath(CHAT_IDS.imessageAlice), { text: "x" }, { authorization: "Bearer wrong" });
    expect(fb.writes()).toEqual([expect.objectContaining({ method: "POST", authorized: false, status: 401 })]);
    expect(fb.state.messagesOf(CHAT_IDS.imessageAlice).some((m) => m.text === "x")).toBe(false);
  });
  test("an unparsable body is logged without crashing", async () => {
    const r = await fetch(fb.url + sendPath(CHAT_IDS.imessageAlice), { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: "{not json" });
    expect(r.status).toBe(400);
    expect(fb.writes().length).toBe(1);
  });
});

// tests-r1-TQ2
describe("failNext can set response headers", () => {
  test("a redirect with a Location header", async () => {
    fb.failNext({ path: "/v1/accounts", status: 302, rawBody: "", headers: { location: "http://127.0.0.1:1/steal" } });
    const r = await fetch(fb.url + "/v1/accounts", { headers: auth(), redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("http://127.0.0.1:1/steal");
  });
});

// tests-r1-TQ4 + spec-r1-F4
describe("real-API shapes", () => {
  test("iMessage messages have no type field; other networks do", async () => {
    const { body } = await get(`${sendPath(CHAT_IDS.imessageAlice)}`);
    expect(body.items.length).toBeGreaterThan(0);
    for (const m of body.items) expect("type" in m).toBe(false);
    const wa = await get(sendPath(CHAT_IDS.longHistory));
    for (const m of wa.body.items) expect(typeof m.type).toBe("string");
  });
  test("REACTION messages appear in WhatsApp history", async () => {
    const all = fb.state.messagesOf(CHAT_IDS.pinnedUnread);
    const reactions = all.filter((m) => m.type === "REACTION");
    expect(reactions.length).toBeGreaterThanOrEqual(2);
    for (const r of reactions) expect(all.some((m) => m.id === r.linkedMessageID)).toBe(true);
  });
  test("some messages omit isSender and some chats omit isPinned/isMuted/isArchived", () => {
    const msgs = [...fb.state.messages.values()].flat();
    expect(msgs.some((m) => !("isSender" in m))).toBe(true);
    const chats = fb.state.chatList();
    for (const k of ["isPinned", "isMuted", "isArchived"]) expect(chats.some((c) => !(k in c))).toBe(true);
  });
  test("one account omits network", () => {
    expect(ACCOUNTS.some((a) => a.network === undefined)).toBe(true);
  });
  test("emptyOlderPageForIMessage: hasMore:true on the first page, then an empty page with hasMore:false", async () => {
    fb.controls.emptyOlderPageForIMessage = true;
    const first = await get(sendPath(CHAT_IDS.imessageLong));
    expect(first.body.items.length).toBe(20);
    expect(first.body.hasMore).toBe(true);
    const next = await get(`${sendPath(CHAT_IDS.imessageLong)}?cursor=${enc(first.body.oldestCursor)}&direction=before`);
    expect(next.body).toEqual({ items: [], hasMore: false, oldestCursor: null, newestCursor: null });
    fb.controls.emptyOlderPageForIMessage = false;
    const normal = await get(`${sendPath(CHAT_IDS.imessageLong)}?cursor=${enc(first.body.oldestCursor)}&direction=before`);
    expect(normal.body.items.length).toBe(20);
    const wa = await get(sendPath(CHAT_IDS.longHistory));
    fb.controls.emptyOlderPageForIMessage = true;
    const waNext = await get(`${sendPath(CHAT_IDS.longHistory)}?cursor=${enc(wa.body.oldestCursor)}&direction=before`);
    expect(waNext.body.items.length).toBe(20);
  });
});

// spec-r1-F7
describe("accounts do not line up with chat networks", () => {
  test("no iMessage account, and X is not called Twitter/X", async () => {
    const { body } = await get("/v1/accounts");
    const nets = body.map((a: any) => a.network);
    expect(nets).not.toContain("iMessage");
    expect(nets).toContain("X");
    expect(nets).not.toContain("Twitter/X");
    const chats = fb.state.chatList();
    expect(chats.some((c) => c.network === "iMessage")).toBe(true);
    expect(chats.some((c) => c.network === "Twitter/X")).toBe(true);
    expect(body.some((a: any) => a.accountID === "imessage")).toBe(false);
  });
  test("sending in an iMessage chat (no account entry) still works", async () => {
    const r = await send("POST", sendPath(CHAT_IDS.imessageAlice), { text: "hi" });
    expect(r.status).toBe(200);
  });
});

// spec-r1-F3
describe("draft rule: a non-empty draft is accepted only when the current draft is empty", () => {
  test("set on an empty draft, then a second set is 409, clear then set works", async () => {
    const path = `/v1/chats/${enc(CHAT_IDS.imessageAlice)}`;
    expect((await send("PATCH", path, { draft: { text: "first" } })).status).toBe(200);
    const second = await send("PATCH", path, { draft: { text: "second" } });
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).code).toBe("CONFLICT");
    expect(fb.state.chats.get(CHAT_IDS.imessageAlice)!.draft).toEqual({ text: "first" });
    expect((await send("PATCH", path, { draft: null })).status).toBe(200);
    expect((await send("PATCH", path, { draft: { text: "second" } })).status).toBe(200);
  });
  test("a fixture chat already holds a half-typed draft", async () => {
    expect(fb.state.chats.get(CHAT_IDS.draftInProgress)!.draft?.text).toBeTruthy();
    expect((await send("PATCH", `/v1/chats/${enc(CHAT_IDS.draftInProgress)}`, { draft: { text: "agent text" } })).status).toBe(409);
  });
});

// spec-r1-F10
describe("/v1/ws app state", () => {
  function openWS() {
    const ws = new WebSocket(fb.wsURL, { headers: auth() } as any);
    const inbox: any[] = [];
    let wake: (() => void) | null = null;
    ws.onmessage = (e) => {
      inbox.push(JSON.parse(String(e.data)));
      wake?.();
    };
    const next = async (pred: (m: any) => boolean = () => true, ms = 2000): Promise<any> => {
      const t0 = Date.now();
      for (;;) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return inbox.splice(i, 1)[0];
        if (Date.now() - t0 > ms) throw new Error("timeout waiting for ws message");
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 50);
        });
      }
    };
    return { ws, next, inbox };
  }
  test("subscribing with app.state gets the current state, then updates", async () => {
    const c = openWS();
    await c.next((m) => m.type === "ready");
    c.ws.send(JSON.stringify({ type: "subscriptions.set", chatIDs: ["*"], app: { state: true } }));
    expect(await c.next((m) => m.type === "subscriptions.updated")).toEqual({ type: "subscriptions.updated", chatIDs: ["*"], app: { state: true } });
    const s0 = await c.next((m) => m.type === "app.state.updated");
    expect(s0.appState.state).toBe("ready");
    expect(typeof s0.seq).toBe("number");
    fb.setAppState("needs-login");
    expect((await c.next((m) => m.type === "app.state.updated")).appState.state).toBe("needs-login");
    c.ws.close();
  });
  test("without app.state the client gets no app state messages", async () => {
    const c = openWS();
    await c.next((m) => m.type === "ready");
    c.ws.send(JSON.stringify({ type: "subscriptions.set", chatIDs: ["*"] }));
    await c.next((m) => m.type === "subscriptions.updated");
    fb.setAppState("needs-verification");
    await Bun.sleep(100);
    expect(c.inbox.filter((m) => m.type === "app.state.updated")).toEqual([]);
    c.ws.close();
  });
  // spec-r1-F1: modes a real Beeper build may show, so the connector's handshake is tested against them
  test("wsReadyDelayMs: commands before ready are dropped without an answer; after ready they work", async () => {
    fb.controls.wsReadyDelayMs = 200;
    const c = openWS();
    await new Promise<void>((r) => (c.ws.onopen = () => r()));
    c.ws.send(JSON.stringify({ type: "subscriptions.set", requestID: "early", chatIDs: ["*"] }));
    await c.next((m) => m.type === "ready", 2000);
    await Bun.sleep(50);
    expect(c.inbox.filter((m) => m.requestID === "early")).toEqual([]);
    c.ws.send(JSON.stringify({ type: "subscriptions.set", requestID: "late", chatIDs: ["*"] }));
    expect(await c.next((m) => m.type === "subscriptions.updated")).toEqual({ type: "subscriptions.updated", requestID: "late", chatIDs: ["*"] });
    c.ws.close();
  });
  test("wsRejectApp: a subscription with app is INVALID_PAYLOAD; without app it works", async () => {
    fb.controls.wsRejectApp = true;
    const c = openWS();
    await c.next((m) => m.type === "ready");
    c.ws.send(JSON.stringify({ type: "subscriptions.set", requestID: "a1", chatIDs: ["*"], app: { state: true } }));
    expect(await c.next((m) => m.type === "error")).toMatchObject({ requestID: "a1", code: "INVALID_PAYLOAD" });
    c.ws.send(JSON.stringify({ type: "subscriptions.set", requestID: "a2", chatIDs: ["*"] }));
    expect((await c.next((m) => m.type === "subscriptions.updated")).requestID).toBe("a2");
    c.ws.close();
  });
  test("wsNoReady and wsSilentSubscribe stay silent", async () => {
    fb.controls.wsNoReady = true;
    const c = openWS();
    await Bun.sleep(150);
    expect(c.inbox).toEqual([]);
    c.ws.close();
    fb.controls.wsNoReady = false;
    fb.controls.wsSilentSubscribe = true;
    const d = openWS();
    await d.next((m) => m.type === "ready");
    d.ws.send(JSON.stringify({ type: "subscriptions.set", chatIDs: ["*"] }));
    await Bun.sleep(150);
    expect(d.inbox).toEqual([]);
    d.ws.close();
  });
  test("app must be {state: boolean}", async () => {
    const c = openWS();
    await c.next((m) => m.type === "ready");
    c.ws.send(JSON.stringify({ type: "subscriptions.set", chatIDs: ["*"], app: { state: "yes" } }));
    expect((await c.next((m) => m.type === "error")).code).toBe("INVALID_PAYLOAD");
    c.ws.close();
  });
});

describe("unread right after unarchive (real Beeper quirk)", () => {
  const chatPath = (id: string) => `/v1/chats/${enc(id)}`;
  test("unarchive then unread leaves the chat archived; unread then unarchive keeps both", async () => {
    const id = CHAT_IDS.archived;
    await send("POST", chatPath(id) + "/archive", { archived: true });
    await send("POST", chatPath(id) + "/archive", { archived: false });
    await send("POST", chatPath(id) + "/unread", {});
    let c = (await get(chatPath(id))).body;
    expect([c.isArchived, c.isMarkedUnread]).toEqual([true, true]);
    await send("POST", chatPath(id) + "/unread", {});
    await send("POST", chatPath(id) + "/archive", { archived: false });
    c = (await get(chatPath(id))).body;
    expect([c.isArchived, c.isMarkedUnread]).toEqual([false, true]);
    await send("POST", chatPath(id) + "/archive", { archived: true });
  });
});
