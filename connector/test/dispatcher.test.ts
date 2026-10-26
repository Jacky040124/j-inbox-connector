// The whitelist: each catalogue action reaches exactly its Beeper endpoints with validated params;
// anything else is NOT_ALLOWED and never reaches Beeper.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ASSET_URLS, CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { ACTION_NAMES, parseActionResult, type ActionName } from "@j-inbox/protocol";
import { createBeeperClient } from "../src/beeper-client.ts";
import { createActions } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";
import { createDispatcher } from "../src/dispatcher.ts";

let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper();
});
afterAll(() => fb.stop());
afterEach(() => fb.reset());

function make() {
  const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 3000 });
  const assets = new AssetAllowlist();
  return { d: createDispatcher({ actions: createActions(client, { assets, connectorVersion: "0.1.0" }), client, assets }), assets };
}
const routes = () => [...new Set(fb.state.calls.map((c) => c.route))].sort();

const mid = () => fb.state.messagesOf(CHAT_IDS.imessageAlice)[0]!.id;
const CASES: Record<ActionName, { params: () => Record<string, unknown>; routes: string[] }> = {
  status: { params: () => ({}), routes: ["GET /v1/accounts", "GET /v1/chats", "GET /v1/info"] },
  list_chats: { params: () => ({ limit: 5 }), routes: ["GET /v1/chats"] },
  unread_summary: { params: () => ({}), routes: ["GET /v1/chats"] },
  read_chat: { params: () => ({ chatID: CHAT_IDS.imessageAlice }), routes: ["GET /v1/chats/{chatID}", "GET /v1/chats/{chatID}/messages"] },
  search_messages: { params: () => ({ query: "dinner" }), routes: ["GET /v1/messages/search"] },
  draft_reply: { params: () => ({ chatID: CHAT_IDS.imessageAlice, text: "draft" }), routes: ["GET /v1/chats/{chatID}", "PATCH /v1/chats/{chatID}"] },
  send_message: { params: () => ({ chatID: CHAT_IDS.imessageAlice, text: "hi" }), routes: ["POST /v1/chats/{chatID}/messages"] },
  react: { params: () => ({ chatID: CHAT_IDS.imessageAlice, messageID: mid(), reactionKey: "👍" }), routes: ["POST /v1/chats/{chatID}/messages/{messageID}/reactions"] },
  mark_read: { params: () => ({ chatID: CHAT_IDS.imessageAlice }), routes: ["POST /v1/chats/{chatID}/read"] },
  archive: { params: () => ({ chatID: CHAT_IDS.imessageAlice }), routes: ["POST /v1/chats/{chatID}/archive"] },
  remove_account: { params: () => ({ accountID: "instagramgo" }), routes: ["GET /v1/accounts/{accountID}", "GET /v1/bridges/{bridgeID}/logins/{loginID}", "POST /v1/bridges/{bridgeID}/logins/{loginID}/remove"] },
  get_media: { params: () => ({ url: ASSET_URLS.imgSmall }), routes: ["GET /v1/assets/serve"] },
};

describe("dispatcher whitelist", () => {
  test("covers exactly the protocol catalogue", () => {
    expect(Object.keys(CASES).sort()).toEqual([...ACTION_NAMES].sort());
  });
  for (const name of Object.keys(CASES) as ActionName[]) {
    test(`${name} calls only ${CASES[name].routes.join(", ")} and returns a valid result`, async () => {
      const { d, assets } = make();
      if (name === "get_media") assets.add(ASSET_URLS.imgSmall);
      const r = await d.dispatch(name, CASES[name].params());
      if (r.kind === "media") {
        expect(r.head.mimeType).toBe("image/png");
        r.cancel();
      } else {
        if (!r.ok) throw new Error(`${name}: ${r.error.code}`);
        expect(parseActionResult(name, r.data).ok).toBe(true);
      }
      expect(routes()).toEqual([...CASES[name].routes].sort());
    });
  }
  test("unknown actions, prototype keys and cloud-only meta actions are NOT_ALLOWED and never reach Beeper", async () => {
    const { d } = make();
    for (const a of ["delete_chat", "__proto__", "constructor", "toString", "whoami", "approval_status", "", "STATUS", "status ", "send_message\u0000"]) {
      const r = await d.dispatch(a, {});
      expect(r.kind === "res" && !r.ok && r.error.code).toBe("NOT_ALLOWED");
    }
    expect(fb.state.calls).toEqual([]);
  });
  test("bad params are BAD_PARAMS without echoing the input, and never reach Beeper", async () => {
    const { d } = make();
    const hostile = "<script>alert(1)</script>";
    const bad: [ActionName, unknown][] = [
      ["read_chat", { chatID: 42 }],
      ["read_chat", { chatID: CHAT_IDS.imessageAlice, extra: hostile }],
      ["send_message", { chatID: CHAT_IDS.imessageAlice, text: "" }],
      ["send_message", { chatID: CHAT_IDS.imessageAlice, text: "x".repeat(10_001) }],
      ["list_chats", { limit: 0 }],
      ["list_chats", { limit: "5" }],
      ["get_media", { url: "https://evil.example/x.png" }],
      ["get_media", { url: "file:///Users/x/../../etc/passwd" }],
      ["search_messages", {}],
      ["status", null],
      ["status", []],
      ["react", { chatID: CHAT_IDS.imessageAlice, messageID: "m", reactionKey: "👍", idempotencyKey: "short" }],
      ["mark_read", { chatID: "a b" }],
    ];
    for (const [a, p] of bad) {
      const r = await d.dispatch(a, p);
      expect(r.kind === "res" && !r.ok && r.error.code).toBe("BAD_PARAMS");
      if (r.kind === "res" && !r.ok) expect(r.error.message).not.toContain("<script>");
    }
    expect(fb.state.calls).toEqual([]);
  });
  test("get_media for a URL the connector never returned is NOT_ALLOWED", async () => {
    const { d } = make();
    const r = await d.dispatch("get_media", { url: ASSET_URLS.avatar1 });
    expect(r.kind === "res" && !r.ok && r.error.code).toBe("NOT_ALLOWED");
    expect(fb.state.calls).toEqual([]);
  });
  test("defaults are applied before the action runs (mark_read without read marks read)", async () => {
    const { d } = make();
    const r = await d.dispatch("mark_read", { chatID: CHAT_IDS.imessageWeird });
    expect(r.kind === "res" && r.ok && r.data).toEqual({ chatID: CHAT_IDS.imessageWeird, read: true });
  });
  test("isWrite follows the catalogue", () => {
    const { d } = make();
    expect(d.isWrite("send_message")).toBe(true);
    expect(d.isWrite("read_chat")).toBe(false);
    expect(d.isWrite("nonsense")).toBe(true);
  });
  test("an action that throws is INTERNAL, not a crash", async () => {
    const client = createBeeperClient({ baseURL: fb.url, token: fb.token });
    const actions = createActions(client);
    (actions as any).list_chats = async () => {
      throw new Error("boom with secret text");
    };
    const d = createDispatcher({ actions, client, assets: new AssetAllowlist() });
    const r = await d.dispatch("list_chats", {});
    expect(r.kind === "res" && !r.ok && r.error.code).toBe("INTERNAL");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
  test("a result that fails the protocol schema is INTERNAL (never sent half-valid)", async () => {
    const client = createBeeperClient({ baseURL: fb.url, token: fb.token });
    const actions = createActions(client);
    (actions as any).archive = async () => ({ ok: true, data: { chatID: CHAT_IDS.imessageAlice, archived: "yes" } });
    const d = createDispatcher({ actions, client, assets: new AssetAllowlist() });
    const r = await d.dispatch("archive", { chatID: CHAT_IDS.imessageAlice });
    expect(r.kind === "res" && !r.ok && r.error.code).toBe("INTERNAL");
  });
});
