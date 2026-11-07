// The whitelist: each catalogue action reaches exactly its Beeper endpoints with validated params;
// anything else is NOT_ALLOWED and never reaches Beeper.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ASSET_URLS, CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { CLOUD_ACTION_NAMES, CONNECTOR_ACTION_NAMES, parseActionResult, type ActionName, type ConnectorActionName } from "@j-inbox/protocol";
import { createBeeperClient } from "../src/beeper-client.ts";
import { createActions } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";
import { SYNC_WAIT_MARGIN_MS, SYNC_WAIT_MS, createDispatcher } from "../src/dispatcher.ts";

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
// Gmail-only actions never reach Beeper; without a Gmail account they answer an error (gmail.test.ts runs them for real).
const CASES: Record<ConnectorActionName, { params: () => Record<string, unknown>; routes: string[]; error?: string }> = {
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
  compose_email: { params: () => ({ accountID: "gmail:owner@example.com", to: ["a@example.com"], subject: "s", text: "t" }), routes: [], error: "NOT_FOUND" },
  gmail_connect: { params: () => ({ email: "owner@example.com", refreshToken: "1//0fake-token" }), routes: [], error: "NOT_ALLOWED" },
  // The draft store is local: never Beeper.
  draft_store_put: { params: () => ({ requestId: "drq_0123456789abcdef", chatID: CHAT_IDS.imessageAlice, instruction: "Say yes", deadline: new Date(Date.now() + 1800_000).toISOString() }), routes: [] },
  draft_store_get: { params: () => ({ requestIds: ["drq_0123456789abcdef"] }), routes: [] },
  draft_store_set_text: { params: () => ({ requestId: "drq_0123456789abcdef", text: "Yes!" }), routes: [], error: "NOT_FOUND" },
  draft_store_delete: { params: () => ({ requestIds: ["drq_0123456789abcdef"] }), routes: [] },
  // The upload store is local too (uploads.test.ts runs it with files and sends).
  upload_store_begin: { params: () => ({ uploadId: "upl_0123456789abcdef", owner: "o_0123456789abcdef", fileName: "a.pdf", mimeType: "application/pdf", size: 3 }), routes: [] },
  upload_store_chunk: { params: () => ({ uploadId: "upl_0123456789abcdef", owner: "o_0123456789abcdef", index: 0, data: "JVBE" }), routes: [], error: "NOT_FOUND" },
  upload_store_commit: { params: () => ({ uploadId: "upl_0123456789abcdef", owner: "o_0123456789abcdef" }), routes: [], error: "NOT_FOUND" },
  upload_store_delete: { params: () => ({ uploadIds: ["upl_0123456789abcdef"] }), routes: [] },
  upload_store_read: { params: () => ({ uploadId: "upl_0123456789abcdef", owner: "o_0123456789abcdef" }), routes: [], error: "NOT_FOUND" },
  // Email only; gmail-email-html.test.ts runs it against fake Google.
  get_email_html: { params: () => ({ chatID: CHAT_IDS.imessageAlice, messageID: "1" }), routes: [], error: "NOT_SUPPORTED" },
  discard_upload: { params: () => ({ uploadId: "upl_0123456789abcdef" }), routes: [] },
  // The noise store is local; set_noise reads the chat for the owner's example (noise.test.ts runs Jev).
  get_noise_settings: { params: () => ({}), routes: [] },
  set_noise_definition: { params: () => ({ definition: "Newsletters" }), routes: [] },
  // The To do store is local: nothing goes to Beeper for it.
  set_todo: { params: () => ({ chatID: CHAT_IDS.imessageAlice, todo: true }), routes: [] },
  sync_pull: { params: () => ({}), routes: [], error: "NOT_SUPPORTED" },
  get_older_unread: { params: () => ({ source: "beeper" }), routes: [] },
  add_older_unread: { params: () => ({ source: "beeper" }), routes: [] },
  set_noise: { params: () => ({ chatID: CHAT_IDS.imessageAlice, noise: true }), routes: ["GET /v1/chats/{chatID}", "GET /v1/chats/{chatID}/messages"] },
  // The noise list of senders is local too, and Gmail's (noise-senders.test.ts).
  get_noise_senders: { params: () => ({}), routes: [] },
  add_noise_sender: { params: () => ({ entry: "example.com" }), routes: [] },
  add_noise_sender_of_chat: { params: () => ({ chatID: CHAT_IDS.imessageAlice }), routes: [], error: "NOT_SUPPORTED" },
  remove_noise_sender: { params: () => ({ entry: "example.com" }), routes: [] },
  // Connecting chat apps: Beeper's bridges and its own sign-in (chat-login.test.ts runs every flow).
  chat_apps: { params: () => ({}), routes: ["GET /v1/bridges", "GET /v1/bridges/{bridgeID}/login-flows"] },
  chat_login_start: { params: () => ({ app: "slack" }), routes: ["GET /v1/bridges", "POST /v1/bridges/{bridgeID}/login-sessions"] },
  chat_login_poll: { params: () => ({ sessionID: "cl_0123456789abcdef" }), routes: [], error: "NOT_FOUND" },
  chat_login_submit: { params: () => ({ sessionID: "cl_0123456789abcdef", stepID: "s", fields: {} }), routes: [], error: "NOT_FOUND" },
  chat_login_cancel: { params: () => ({ sessionID: "cl_0123456789abcdef" }), routes: [] },
};

describe("dispatcher whitelist", () => {
  test("covers exactly the protocol catalogue's connector actions", () => {
    expect(Object.keys(CASES).sort()).toEqual([...CONNECTOR_ACTION_NAMES].sort());
  });
  for (const name of Object.keys(CASES) as ConnectorActionName[]) {
    test(`${name} calls only ${CASES[name].routes.join(", ")} and returns a valid result`, async () => {
      const { d, assets } = make();
      if (name === "get_media") assets.add(ASSET_URLS.imgSmall);
      const r = await d.dispatch(name, CASES[name].params());
      if (r.kind === "media") {
        expect(r.head.mimeType).toBe("image/png");
        r.cancel();
      } else if (CASES[name].error) {
        expect(!r.ok && r.error.code).toBe(CASES[name].error as any);
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
  test("the cloud's own actions (the snooze store, the draft and delegation requests) are NOT_ALLOWED here, even with valid params", async () => {
    const { d } = make();
    const rid = { requestId: "drq_0123456789abcdef" };
    const valid: Record<string, unknown> = {
      snooze_chat: { chatID: CHAT_IDS.imessageAlice, until: new Date(Date.now() + 3600_000).toISOString() },
      unsnooze_chat: { chatID: CHAT_IDS.imessageAlice },
      list_snoozed: {},
      request_draft: { chatID: CHAT_IDS.imessageAlice, agentID: "agent_x", instruction: "Say yes" },
      cancel_draft: rid,
      discard_draft: rid,
      mark_draft_sent: rid,
      list_drafts: {},
      list_raft_agents: {},
      set_draft_agents: { agentIDs: [] },
      request_delegation: { chatID: CHAT_IDS.imessageAlice, agentID: "agent_x", channel: "#garage", instruction: "Get quotes" },
      cancel_delegation: { requestId: "dlg_0123456789abcdef" },
      dismiss_delegation: { requestId: "dlg_0123456789abcdef" },
      list_delegations: {},
    };
    expect([...CLOUD_ACTION_NAMES].sort() as string[]).toEqual(Object.keys(valid).sort());
    for (const a of CLOUD_ACTION_NAMES) {
      const r = await d.dispatch(a, valid[a]);
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

describe("dispatcher and the inbox kept for sync", () => {
  function withInbox(o: { pull?: (p: unknown) => any; slowMs?: number } = {}) {
    const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 3000 });
    const assets = new AssetAllowlist();
    const log: string[] = [];
    const inbox = {
      pull: o.pull ?? (() => ({ ok: true, data: { kind: "delta", epoch: "ep_dispatch1", head: 3, changes: [], more: false } })),
      begin: (chatID: string, opId?: string) => {
        log.push(`begin ${chatID} ${opId ?? "-"}`);
        return async (ok: boolean) => {
          log.push(`end ${ok}`);
          await Bun.sleep(o.slowMs ?? 0);
          log.push("read");
        };
      },
      caused: async (action: string, _p: unknown, _d: unknown, opId?: string) => void log.push(`caused ${action} ${opId ?? "-"}`),
    };
    return { d: createDispatcher({ actions: createActions(client, { assets, connectorVersion: "0.1.0" }), client, assets, inbox: inbox as never }), log };
  }

  test("sync_pull answers from the inbox, checked against the contract; without an inbox NOT_SUPPORTED", async () => {
    const { d } = withInbox();
    expect(await d.dispatch("sync_pull", { epoch: null })).toEqual({ kind: "res", ok: true, data: { kind: "delta", epoch: "ep_dispatch1", head: 3, changes: [], more: false } });
    const bad = withInbox({ pull: () => ({ ok: true, data: { kind: "delta", epoch: "x", head: -1, changes: [], more: false } }) });
    expect(((await bad.d.dispatch("sync_pull", {})) as any).error?.code).toBe("INTERNAL");
    const refused = withInbox({ pull: () => ({ ok: false, error: { code: "BAD_PARAMS", message: "page" } }) });
    expect(((await refused.d.dispatch("sync_pull", { page: "s1.x" })) as any).error?.code).toBe("BAD_PARAMS");
    expect(((await make().d.dispatch("sync_pull", {})) as any).error?.code).toBe("NOT_SUPPORTED");
  });

  test("an action on a chat is held around it in the inbox; with an opId the answer waits for the read, without one it does not", async () => {
    const a = withInbox({ slowMs: 60 });
    const r = (await a.d.dispatch("mark_read", { chatID: CHAT_IDS.imessageAlice }, { opId: "op_disp0001" })) as any;
    expect(r.ok).toBe(true);
    expect(a.log.sort()).toEqual([`begin ${CHAT_IDS.imessageAlice} op_disp0001`, "caused mark_read op_disp0001", "end true", "read"]);
    const b = withInbox({ slowMs: 60 });
    await b.d.dispatch("mark_read", { chatID: CHAT_IDS.imessageAlice });
    expect(b.log).toEqual([`begin ${CHAT_IDS.imessageAlice} -`, "end true", "caused mark_read -"]);
    // A failed action ends the hold as failed; a read is never held.
    const c = withInbox();
    fb.failNext({ route: "/v1/chats/{chatID}/archive", status: 401 });
    await c.d.dispatch("archive", { chatID: CHAT_IDS.imessageAlice }, { opId: "op_disp0002" });
    await c.d.dispatch("read_chat", { chatID: CHAT_IDS.imessageAlice }, { opId: "op_disp0003" });
    expect(c.log.slice(0, 2)).toEqual([`begin ${CHAT_IDS.imessageAlice} op_disp0002`, "end false"]);
    expect(c.log.join("\n")).not.toContain("op_disp0003");
  });

  test("the wait for the read never outlasts the request's deadline: a write that took long still answers what it did, before the cloud link's watchdog", async () => {
    // The read is slower than SYNC_WAIT_MS: only the deadline (less SYNC_WAIT_MARGIN_MS) bounds the wait.
    const a = withInbox({ slowMs: SYNC_WAIT_MS * 3 });
    const t0 = Date.now();
    const r = (await a.d.dispatch("mark_read", { chatID: CHAT_IDS.imessageAlice }, { opId: "op_disp0004", deadline: Date.now() + SYNC_WAIT_MARGIN_MS + 300 })) as any;
    const took = Date.now() - t0;
    expect(r.ok).toBe(true);
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(SYNC_WAIT_MS / 2);
    expect(a.log).not.toContain("read");
    // A deadline already (nearly) here: the answer goes at once.
    const b = withInbox({ slowMs: SYNC_WAIT_MS * 3 });
    const t1 = Date.now();
    expect(((await b.d.dispatch("mark_read", { chatID: CHAT_IDS.imessageAlice }, { opId: "op_disp0005", deadline: Date.now() + SYNC_WAIT_MARGIN_MS / 2 })) as any).ok).toBe(true);
    expect(Date.now() - t1).toBeLessThan(SYNC_WAIT_MS / 2);
  });
});
