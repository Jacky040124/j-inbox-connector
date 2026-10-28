import { describe, expect, test } from "bun:test";
import {
  ACTION_NAMES,
  ACTIONS,
  CLOUD_ACTION_NAMES,
  CONNECTOR_ACTION_NAMES,
  coerceAgentParams,
  isCloudAction,
  isActionName,
  parseActionParams,
  parseActionResult,
  type ActionName,
} from "../src/actions.ts";
import { MAX_PAGE_LIMIT, MAX_SEND_TEXT_LENGTH } from "../src/limits.ts";
import { account, chat, chatID, message } from "./fixtures/examples.ts";
import { parse } from "../src/schema.ts";

const EXPECTED = ["status", "list_chats", "unread_summary", "read_chat", "search_messages", "draft_reply", "send_message", "react", "mark_read", "archive", "remove_account", "compose_email", "gmail_connect", "snooze_chat", "unsnooze_chat", "list_snoozed", "request_draft", "cancel_draft", "discard_draft", "mark_draft_sent", "list_drafts", "list_raft_agents", "set_draft_agents", "draft_store_put", "draft_store_get", "draft_store_set_text", "draft_store_delete", "get_media"];
const DRAFT_OWNER: string[] = ["request_draft", "cancel_draft", "discard_draft", "mark_draft_sent", "list_drafts", "list_raft_agents", "set_draft_agents"];
const DRAFT_STORE: string[] = ["draft_store_put", "draft_store_get", "draft_store_set_text", "draft_store_delete"];

describe("catalogue", () => {
  test("has exactly the agreed actions", () => expect([...ACTION_NAMES].sort() as string[]).toEqual([...EXPECTED].sort()));
  test("write flags", () => {
    const writes = ACTION_NAMES.filter((n) => ACTIONS[n].write).sort();
    expect(writes).toEqual(["archive", "cancel_draft", "compose_email", "discard_draft", "draft_reply", "draft_store_delete", "draft_store_put", "draft_store_set_text", "gmail_connect", "mark_draft_sent", "mark_read", "react", "remove_account", "request_draft", "send_message", "set_draft_agents", "snooze_chat", "unsnooze_chat"]);
  });
  test("human-only actions: remove_account, the draft actions and the cloud-only gmail_connect and draft store, and never one that agents could get approved", () => {
    expect(ACTION_NAMES.filter((n) => ACTIONS[n].humanOnly === true) as string[]).toEqual(["remove_account", "gmail_connect", ...DRAFT_OWNER, ...DRAFT_STORE]);
    expect(ACTION_NAMES.filter((n) => (ACTIONS[n] as { cloudOnly?: boolean }).cloudOnly === true) as string[]).toEqual(["gmail_connect", ...DRAFT_STORE]);
    for (const n of ACTION_NAMES) if (ACTIONS[n].humanOnly) expect(ACTIONS[n].needsApprovalForAgents).toBe(false);
    for (const n of ACTION_NAMES) if ((ACTIONS[n] as { cloudOnly?: boolean }).cloudOnly) expect(ACTIONS[n].humanOnly).toBe(true);
  });
  test("approval flags: send/react/mark_read/archive/compose_email/snooze/unsnooze need approval for agents, draft_reply does not", () => {
    const approval = ACTION_NAMES.filter((n) => ACTIONS[n].needsApprovalForAgents).sort();
    expect(approval).toEqual(["archive", "compose_email", "mark_read", "react", "send_message", "snooze_chat", "unsnooze_chat"]);
    // Snoozing hides a chat like archive does: the same policy and the same per-agent cap.
    for (const n of ["snooze_chat", "unsnooze_chat"] as const) expect([ACTIONS[n].needsApprovalForAgents, ACTIONS[n].rateLimitPerMinute]).toEqual([ACTIONS.archive.needsApprovalForAgents, ACTIONS.archive.rateLimitPerMinute]);
    expect(ACTIONS.list_snoozed.needsApprovalForAgents).toBe(false);
    expect(ACTIONS.draft_reply.needsApprovalForAgents).toBe(false);
  });
  test("every approval action is a write action", () => {
    for (const n of ACTION_NAMES) if (ACTIONS[n].needsApprovalForAgents) expect(ACTIONS[n].write).toBe(true);
  });
  test("cloud actions: the snooze store (open to agents) and the draft requests (owner only), answered by the cloud, never in a req frame", () => {
    expect([...CLOUD_ACTION_NAMES].sort() as string[]).toEqual([...DRAFT_OWNER, "list_snoozed", "snooze_chat", "unsnooze_chat"].sort());
    expect([...CONNECTOR_ACTION_NAMES, ...CLOUD_ACTION_NAMES].sort()).toEqual([...ACTION_NAMES].sort());
    for (const n of CLOUD_ACTION_NAMES) {
      expect(isCloudAction(n)).toBe(true);
      expect([ACTIONS[n].humanOnly, (ACTIONS[n] as { cloudOnly?: boolean }).cloudOnly, ACTIONS[n].streamed]).toEqual([DRAFT_OWNER.includes(n) ? true : undefined, undefined, false]);
    }
    // The draft store runs at the connector, but only the cloud ever asks for it.
    for (const n of DRAFT_STORE) expect([isCloudAction(n), (CONNECTOR_ACTION_NAMES as readonly string[]).includes(n)]).toEqual([false, true]);
    for (const n of CONNECTOR_ACTION_NAMES) expect(isCloudAction(n)).toBe(false);
    for (const n of ["__proto__", "whoami", "", null]) expect(isCloudAction(n)).toBe(false);
  });
  test("only get_media streams", () => expect(ACTION_NAMES.filter((n) => ACTIONS[n].streamed)).toEqual(["get_media"]));
  test("every param is documented and every action has a description", () => {
    for (const n of ACTION_NAMES) {
      const a = ACTIONS[n];
      expect(a.description.length).toBeGreaterThan(10);
      expect(Object.keys(a.paramDocs).sort()).toEqual(Object.keys(a.params.shape).sort());
      for (const d of Object.values(a.paramDocs)) expect((d as string).length).toBeGreaterThan(3);
    }
  });
  test("defaults only name declared params and themselves validate", () => {
    for (const n of ACTION_NAMES) {
      const a = ACTIONS[n];
      for (const k of Object.keys(a.defaults)) expect(Object.keys(a.params.shape)).toContain(k);
      // tests-r1-TQ7: the default values themselves must pass the params schema
      for (const [k, v] of Object.entries(a.defaults)) {
        const r = parse((a.params.shape as any)[k], v);
        if (!r.ok) throw new Error(`${n}.${k} default does not validate: ${JSON.stringify(r.issues)}`);
      }
    }
  });
  test("send_message has a rate limit", () => expect(ACTIONS.send_message.rateLimitPerMinute).toBeGreaterThan(0));
});

describe("isActionName", () => {
  test("accepts catalogue names only", () => {
    for (const n of EXPECTED) expect(isActionName(n)).toBe(true);
    for (const n of ["__proto__", "toString", "constructor", "SEND_MESSAGE", "send_message ", "send-message", "", null, 1, "delete_message", "whoami"]) expect(isActionName(n)).toBe(false);
  });
});

const VALID: Record<ActionName, unknown[]> = {
  status: [{}],
  list_chats: [{}, { unreadOnly: true, limit: 10 }, { network: "WhatsApp", query: "dinner", inbox: "primary", type: "group", pinnedOnly: true, accountIDs: ["a", "b"], cursor: "123|abc" }],
  unread_summary: [{}, { limit: 50 }],
  read_chat: [{ chatID }, { chatID, cursor: "1725489123456|c29tZQ", limit: MAX_PAGE_LIMIT }],
  search_messages: [{ query: "dinner" }, { query: "x", chatIDs: [chatID], sender: "me", dateAfter: "2026-01-01T00:00:00Z", limit: 20 }],
  draft_reply: [{ chatID, text: "draft" }],
  send_message: [{ chatID, text: "hello\nworld 👋" }, { chatID, text: "re", replyToMessageID: "m-1" }, { chatID, text: "x".repeat(MAX_SEND_TEXT_LENGTH) }],
  react: [{ chatID, messageID: "m-1", reactionKey: "👍" }, { chatID, messageID: "m-1", reactionKey: "👍", remove: true }, { chatID, messageID: "m-1", reactionKey: "❤️", remove: false }],
  mark_read: [{ chatID }, { chatID, messageID: "m-1" }, { chatID, read: false }],
  archive: [{ chatID }, { chatID, archived: false }],
  remove_account: [{ accountID: "whatsapp" }, { accountID: "local-whatsapp_ba_x" }, { accountID: "gmail:jacky@example.com" }],
  compose_email: [
    { accountID: "gmail:jacky@example.com", to: ["a@example.com"], subject: "", text: "hi" },
    { accountID: "gmail:jacky@example.com", to: ["a@example.com", "b.c+d@sub.example.org"], cc: [], subject: "Lunch? 🍜", text: "hello\nthere", idempotencyKey: "idem-key-0001" },
  ],
  gmail_connect: [{ email: "jacky@example.com", refreshToken: "1//0gFAKE-refresh_token.xyz" }],
  snooze_chat: [{ chatID, until: "2026-10-30T09:00:00.000Z" }, { chatID: "gmail:jacky@example.com:18c2f0a1b2c3d4e5", until: "2026-10-30T09:00:00+02:00" }],
  unsnooze_chat: [{ chatID }],
  list_snoozed: [{}],
  request_draft: [{ chatID, agentID: "bbbbbbbb-0000-4000-8000-000000000001", instruction: "Say yes, Friday works.\nKeep it short 🙂" }, { chatID: "gmail:jacky@example.com:18c2f0a1b2c3d4e5", agentID: "agent_x", instruction: "x".repeat(2000) }],
  cancel_draft: [{ requestId: "drq_0123456789abcdef" }],
  discard_draft: [{ requestId: "drq_0123456789abcdef" }],
  mark_draft_sent: [{ requestId: "drq_0123456789abcdef" }],
  list_drafts: [{}, { chatID }],
  list_raft_agents: [{}, { refresh: true }],
  set_draft_agents: [{ agentIDs: [] }, { agentIDs: ["bbbbbbbb-0000-4000-8000-000000000001", "agent_x"] }],
  draft_store_put: [{ requestId: "drq_0123456789abcdef", chatID, instruction: "Say yes", deadline: "2026-10-28T10:30:00.000Z" }],
  draft_store_get: [{ requestIds: ["drq_0123456789abcdef"] }],
  draft_store_set_text: [{ requestId: "drq_0123456789abcdef", text: "Yes, Friday works!" }],
  draft_store_delete: [{ requestIds: ["drq_0123456789abcdef", "drq_fedcba9876543210"] }],
  get_media: [{ url: "mxc://beeper.local/abc" }, { url: "localmxc://local-whatsapp/xyz" }, { url: "gmail://jacky%40example.com/18c2f0a1b2c3d4e5/ANGjdJ8-abc_DEF" }],
};

const INVALID: Record<ActionName, unknown[]> = {
  status: [{ x: 1 }, null, [], "status"],
  list_chats: [{ limit: 0 }, { limit: MAX_PAGE_LIMIT + 1 }, { limit: "10" }, { unreadOnly: "yes" }, { query: "" }, { query: "q".repeat(201) }, { inbox: "spam" }, { accountIDs: Array.from({ length: 21 }, (_, i) => `a${i}`) }, { cursor: "has space" }, { extra: true }],
  unread_summary: [{ limit: -1 }, { limit: 1.5 }, { chatID }],
  read_chat: [{}, { chatID: "" }, { chatID: "a b" }, { chatID: "x".repeat(513) }, { chatID: 42 }, { chatID, limit: 1000 }, { chatID, direction: "after" }],
  search_messages: [{}, { query: "" }, { query: "   " }, { query: "x", limit: 21 }, { query: "x", sender: "someone" }, { query: "x", dateAfter: "yesterday" }, { query: "x", chatIDs: "abc" }],
  draft_reply: [{ chatID }, { chatID, text: "" }, { text: "x" }, { chatID, text: "x".repeat(MAX_SEND_TEXT_LENGTH + 1) }],
  send_message: [{ chatID }, { chatID, text: "" }, { chatID, text: "  \n " }, { chatID, text: "a\u0000b" }, { chatID, text: "x".repeat(MAX_SEND_TEXT_LENGTH + 1) }, { chatID, text: 5 }, { chatID, text: "x", attachment: {} }, { chatID, text: "x", replyToMessageID: "" }],
  react: [{ chatID, messageID: "m-1" }, { chatID, messageID: "m-1", reactionKey: "" }, { chatID, messageID: "m-1", reactionKey: "x".repeat(257) }, { chatID, reactionKey: "👍" }, { chatID, messageID: "m-1", reactionKey: "👍", remove: "yes" }],
  mark_read: [{}, { chatID, read: "false" }, { chatID, messageID: "" }],
  archive: [{}, { chatID, archived: 1 }],
  remove_account: [{}, { accountID: "" }, { accountID: 5 }, { accountID: "whatsapp", scope: "all-devices" }],
  compose_email: [
    {},
    { accountID: "gmail:jacky@example.com", to: [], subject: "x", text: "hi" },
    { accountID: "gmail:jacky@example.com", to: ["not-an-address"], subject: "x", text: "hi" },
    { accountID: "gmail:jacky@example.com", to: ["Alice <a@example.com>"], subject: "x", text: "hi" },
    { accountID: "gmail:jacky@example.com", to: ["a@example.com,b@example.com"], subject: "x", text: "hi" },
    { accountID: "gmail:jacky@example.com", to: ["a@example.com"], subject: "line\nbreak", text: "hi" },
    { accountID: "gmail:jacky@example.com", to: ["a@example.com"], subject: "x", text: "" },
    { accountID: "gmail:jacky@example.com", to: ["a@example.com"], text: "hi" },
    { accountID: "gmail:jacky@example.com", to: Array.from({ length: 51 }, (_, i) => `a${i}@example.com`), subject: "x", text: "hi" },
    { accountID: "gmail:jacky@example.com", to: ["a@example.com"], subject: "x", text: "hi", bcc: ["b@example.com"] },
  ],
  gmail_connect: [{}, { email: "jacky@example.com" }, { email: "jacky@example.com", refreshToken: "has space in it" }, { email: "nope", refreshToken: "1//0gFAKE-refresh" }],
  snooze_chat: [{}, { chatID }, { until: "2026-10-30T09:00:00.000Z" }, { chatID: "", until: "2026-10-30T09:00:00.000Z" }, { chatID: "a b", until: "2026-10-30T09:00:00.000Z" }, { chatID: "x".repeat(513), until: "2026-10-30T09:00:00.000Z" }, { chatID, until: "tomorrow" }, { chatID, until: "2026-10-30T09:00:00" }, { chatID, until: "2026-13-30T09:00:00Z" }, { chatID, until: 1793350800000 }, { chatID, until: "2026-10-30T09:00:00Z", archived: true }],
  unsnooze_chat: [{}, { chatID: "" }, { chatID: 5 }, { chatID, until: "2026-10-30T09:00:00Z" }],
  list_snoozed: [{ chatID }, null, []],
  request_draft: [{}, { chatID, agentID: "a" }, { chatID, instruction: "x" }, { chatID, agentID: "a", instruction: "" }, { chatID, agentID: "a", instruction: "   \n " }, { chatID, agentID: "a", instruction: "x".repeat(2001) }, { chatID, agentID: "a b", instruction: "x" }, { chatID, agentID: "", instruction: "x" }, { chatID, agentID: "x".repeat(129), instruction: "x" }, { chatID: "a b", agentID: "a", instruction: "x" }, { chatID, agentID: "a", instruction: "x", send: true }],
  cancel_draft: [{}, { requestId: "apr_0123456789abcdef" }, { requestId: "drq_" }, { requestId: "drq_has space" }, { requestId: "drq_" + "a".repeat(64) }],
  discard_draft: [{}, { requestId: 5 }],
  mark_draft_sent: [{}, { requestId: "drq_0123456789abcdef", text: "x" }],
  list_drafts: [{ chatID: "" }, { chatID, status: "pending" }, null],
  list_raft_agents: [{ refresh: "yes" }, { agentID: "a" }],
  set_draft_agents: [{}, { agentIDs: "a" }, { agentIDs: ["a b"] }, { agentIDs: Array.from({ length: 101 }, (_, i) => `a${i}`) }],
  draft_store_put: [{ requestId: "drq_0123456789abcdef", chatID, instruction: "x" }, { requestId: "drq_0123456789abcdef", chatID, instruction: "", deadline: "2026-10-28T10:30:00.000Z" }],
  draft_store_get: [{ requestIds: [] }, { requestIds: Array.from({ length: 11 }, (_, i) => `drq_0123456789abcd${i}x`) }],
  draft_store_set_text: [{ requestId: "drq_0123456789abcdef", text: "" }, { requestId: "drq_0123456789abcdef", text: "x".repeat(MAX_SEND_TEXT_LENGTH + 1) }],
  draft_store_delete: [{ requestIds: [] }, {}],
  get_media: [{ url: "gmail://jacky%40example.com/../ANG" }, { url: "gmail://jacky%40example.com/18c2/a/b" }, {}, { url: "https://evil.example/a.png" }, { url: "file:///etc/../etc/passwd" }, { url: "javascript:alert(1)" }, { url: "mxc://" + "a".repeat(3000) }],
};

describe("parseActionParams", () => {
  for (const name of EXPECTED as ActionName[]) {
    test(`${name}: valid params pass`, () => {
      for (const p of VALID[name]) {
        const r = parseActionParams(name, p);
        if (!r.ok) throw new Error(`${name} rejected ${JSON.stringify(p).slice(0, 200)}: ${JSON.stringify(r.issues)}`);
      }
    });
    test(`${name}: invalid params fail`, () => {
      for (const p of INVALID[name]) {
        const r = parseActionParams(name, p);
        if (r.ok) throw new Error(`${name} accepted ${JSON.stringify(p).slice(0, 200)}`);
      }
    });
  }
  test("defaults are applied", () => {
    const r = parseActionParams("list_chats", {});
    expect(r.ok && r.value.limit).toBe(25);
    const m = parseActionParams("mark_read", { chatID });
    expect(m.ok && m.value.read).toBe(true);
    const a = parseActionParams("archive", { chatID });
    expect(a.ok && a.value.archived).toBe(true);
  });
  test("explicit values beat defaults", () => {
    const r = parseActionParams("list_chats", { limit: 5 });
    expect(r.ok && r.value.limit).toBe(5);
  });
  test("unknown action name is rejected, not thrown", () => {
    const r = parseActionParams("__proto__" as ActionName, {});
    expect(r.ok).toBe(false);
  });
});

const DRAFT = { requestId: "drq_0123456789abcdef", chatID, agent: { id: "bbbbbbbb-0000-4000-8000-000000000001", name: "龙虾" }, status: "pending", createdAt: "2026-10-28T09:00:00.000Z", updatedAt: "2026-10-28T09:00:00.000Z", deadline: "2026-10-28T09:30:00.000Z", delivery: "sent" };

const RESULTS: Record<ActionName, unknown> = {
  status: { online: true, lastSeenAt: null, connectorVersion: "0.1.0", beeper: { reachable: true, version: "4.2.1", appState: "ready" }, accounts: [account] },
  list_chats: { items: [chat], hasMore: true, nextCursor: "abc" },
  unread_summary: { totalUnreadChats: 1, totalUnreadMessages: 2, items: [chat], truncated: false },
  read_chat: { chat, items: [message], hasMore: false, nextCursor: null },
  search_messages: { items: [message], chats: { [chatID]: { ...chat, preview: null } }, hasMore: false, nextCursor: null },
  draft_reply: { chatID, draftSet: true },
  send_message: { chatID, pendingMessageID: "pm-1" },
  react: { chatID, messageID: "m-1", reactionKey: "👍" },
  mark_read: { chatID, read: true },
  archive: { chatID, archived: true },
  remove_account: { accountID: "whatsapp", removed: true, scope: "all-devices", affectedAccountIDs: ["whatsapp"] },
  compose_email: { accountID: "gmail:jacky@example.com", chatID: "gmail:jacky@example.com:18c2f0a1b2c3d4e5", pendingMessageID: "18c2f0a1b2c3d4e6" },
  gmail_connect: { accountID: "gmail:jacky@example.com", connected: true },
  snooze_chat: { chatID, until: "2026-10-30T09:00:00.000Z" },
  unsnooze_chat: { chatID },
  list_snoozed: { items: [{ chatID, until: "2026-10-30T09:00:00.000Z", snoozedAt: "2026-10-28T09:00:00.000Z", chat: { ...chat, preview: undefined } }, { chatID: "imsg##thread:+1", until: "2026-10-30T09:00:00.000Z", snoozedAt: "2026-10-28T09:00:00.000Z" }] },
  request_draft: DRAFT,
  cancel_draft: { ...DRAFT, status: "cancelled" },
  discard_draft: { ...DRAFT, status: "discarded" },
  mark_draft_sent: { ...DRAFT, status: "sent" },
  list_drafts: { items: [{ ...DRAFT, status: "drafted", instruction: "Say yes", text: "Yes!" }, { ...DRAFT, status: "failed", error: { code: "NOT_FOUND", message: "That agent is not on your Raft server." } }] },
  list_raft_agents: { agents: [{ id: "bbbbbbbb-0000-4000-8000-000000000001", name: "龙虾", handle: "longxia", avatarURL: "https://api.raft.test/a.svg" }], allowedAgentIDs: ["bbbbbbbb-0000-4000-8000-000000000001"], fetchedAt: "2026-10-28T09:00:00.000Z", signInNeeded: false },
  set_draft_agents: { allowedAgentIDs: [] },
  draft_store_put: { requestId: "drq_0123456789abcdef", stored: true },
  draft_store_get: { items: [{ requestId: "drq_0123456789abcdef", chatID, instruction: "Say yes", text: "Yes!" }] },
  draft_store_set_text: { requestId: "drq_0123456789abcdef", stored: true },
  draft_store_delete: { deleted: 2 },
  get_media: { mimeType: "image/png", size: 1234, fileName: "a.png" },
};

describe("parseActionResult", () => {
  for (const name of EXPECTED as ActionName[]) {
    test(`${name}: valid result passes`, () => {
      const r = parseActionResult(name, RESULTS[name]);
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
    });
    test(`${name}: extra field fails`, () => {
      expect(parseActionResult(name, { ...(RESULTS[name] as object), injected: "x" }).ok).toBe(false);
    });
  }
  test("message text above the email limit (the larger cap) is rejected", () => {
    const big = { ...message, text: "x".repeat(20_001) };
    expect(parseActionResult("read_chat", { chat, items: [big], hasMore: false, nextCursor: null }).ok).toBe(false);
  });
  test("textTruncated may only be true", () => {
    expect(parseActionResult("read_chat", { chat, items: [{ ...message, textTruncated: true }], hasMore: false, nextCursor: null }).ok).toBe(true);
    expect(parseActionResult("read_chat", { chat, items: [{ ...message, textTruncated: false }], hasMore: false, nextCursor: null }).ok).toBe(false);
  });
  test("chat titles must be single-line", () => {
    expect(parseActionResult("list_chats", { items: [{ ...chat, title: "a\nb" }], hasMore: false, nextCursor: null }).ok).toBe(false);
  });
  test("too many items rejected", () => {
    expect(parseActionResult("list_chats", { items: Array.from({ length: MAX_PAGE_LIMIT + 1 }, () => chat), hasMore: false, nextCursor: null }).ok).toBe(false);
  });
  test("negative counts and unknown enums rejected", () => {
    expect(parseActionResult("list_chats", { items: [{ ...chat, unreadCount: -1 }], hasMore: false, nextCursor: null }).ok).toBe(false);
    expect(parseActionResult("list_chats", { items: [{ ...chat, type: "channel" }], hasMore: false, nextCursor: null }).ok).toBe(false);
    expect(parseActionResult("status", { ...(RESULTS.status as object), accounts: [{ ...account, status: "weird" }] }).ok).toBe(false);
  });
  test("media size above the relay limit rejected", () => {
    expect(parseActionResult("get_media", { mimeType: "image/png", size: 26 * 1024 * 1024 }).ok).toBe(false);
    expect(parseActionResult("get_media", { mimeType: "not a mime", size: 1 }).ok).toBe(false);
  });
  test("asset urls inside results are validated", () => {
    const bad = { ...message, attachments: [{ type: "img", url: "https://evil.example/x" }] };
    expect(parseActionResult("read_chat", { chat, items: [bad], hasMore: false, nextCursor: null }).ok).toBe(false);
  });
});

describe("coerceAgentParams (raft --param sends strings)", () => {
  test("booleans and integers from strings", () => {
    const out = coerceAgentParams("list_chats", { unreadOnly: "true", pinnedOnly: "false", limit: "10" });
    expect(out).toEqual({ unreadOnly: true, pinnedOnly: false, limit: 10 });
    expect(parseActionParams("list_chats", out).ok).toBe(true);
  });
  test("arrays from JSON strings", () => {
    const out = coerceAgentParams("search_messages", { query: "x", chatIDs: '["a","b"]' });
    expect(out.chatIDs).toEqual(["a", "b"]);
  });
  test("garbage stays garbage so validation rejects it", () => {
    for (const raw of [{ limit: "ten" }, { limit: "1e3" }, { limit: " 5" }, { unreadOnly: "yes" }, { accountIDs: "[oops" }]) {
      const out = coerceAgentParams("list_chats", raw);
      expect(parseActionParams("list_chats", out).ok).toBe(false);
    }
  });
  test("strings for string params are untouched, unknown keys kept (and later rejected)", () => {
    const out = coerceAgentParams("send_message", { chatID, text: "true", evil: "1" });
    expect(out.text).toBe("true");
    expect(parseActionParams("send_message", out).ok).toBe(false);
  });
  test("does not throw on hostile input", () => {
    for (const raw of [null, [], "x", JSON.parse('{"__proto__":{"x":1}}')]) expect(() => coerceAgentParams("list_chats", raw as any)).not.toThrow();
    expect(() => coerceAgentParams("nope" as ActionName, {})).not.toThrow();
  });
});

describe("round 1 fixes", () => {
  test("TQ7: parseActionParams validates the merged value, so a bad default can never reach the connector", () => {
    const def = ACTIONS.list_chats as any;
    const saved = def.defaults;
    try {
      def.defaults = { limit: 100 };
      expect(parseActionParams("list_chats", {}).ok).toBe(false);
      def.defaults = { limit: 0 };
      expect(parseActionParams("list_chats", {}).ok).toBe(false);
    } finally {
      def.defaults = saved;
    }
    expect(parseActionParams("list_chats", {}).ok).toBe(true);
  });
  test("R1-01: send_message and react accept an optional idempotencyKey; other writes are idempotent by nature", () => {
    expect(parseActionParams("send_message", { chatID, text: "hi", idempotencyKey: "k_0123456789abcdef" }).ok).toBe(true);
    expect(parseActionParams("react", { chatID, messageID: "m1", reactionKey: "👍", idempotencyKey: "k_0123456789abcdef" }).ok).toBe(true);
    for (const bad of ["", "short", "has space 12345678", "x".repeat(65), "ü".repeat(10), 12345678])
      expect(parseActionParams("send_message", { chatID, text: "hi", idempotencyKey: bad }).ok).toBe(false);
    expect(ACTIONS.send_message.paramDocs.idempotencyKey).toMatch(/retry/i);
  });
  test("F3: draft_reply documents that it never replaces an existing draft (CONFLICT)", () => {
    expect(ACTIONS.draft_reply.description).toMatch(/CONFLICT/);
    expect(ACTIONS.draft_reply.beeper).toMatch(/409|CONFLICT/);
  });
  test("F5: unread_summary reads /v1/chats (which carries preview), not /v1/chats/search (which does not)", () => {
    expect(ACTIONS.unread_summary.beeper).toMatch(/^GET \/v1\/chats\b/);
    expect(ACTIONS.unread_summary.beeper).not.toMatch(/chats\/search/);
  });
  test("F7: network and pinnedOnly are documented as connector-side filters (Beeper has no such filter)", () => {
    expect(ACTIONS.list_chats.paramDocs.network).toMatch(/chat network/i);
    expect(ACTIONS.list_chats.beeper).toMatch(/filter/i);
  });
  test("TQ3: array params tell agents to use --data-json (raft --param is text-only)", () => {
    expect(ACTIONS.list_chats.paramDocs.accountIDs).toMatch(/--data-json/);
    expect(ACTIONS.search_messages.paramDocs.chatIDs).toMatch(/--data-json/);
    expect(ACTIONS.search_messages.paramDocs.accountIDs).toMatch(/--data-json/);
  });
});

// stability-r2-R2-2: the cloud scopes every idempotencyKey to its caller before forwarding.
import { idempotencyKey, scopeIdempotencyKey } from "../src/actions.ts";
describe("scopeIdempotencyKey", () => {
  const agentA = { type: "agent" as const, sub: "bbbbbbbb-0000-4000-8000-000000000001" };
  const agentB = { type: "agent" as const, sub: "bbbbbbbb-0000-4000-8000-000000000002" };
  const human = { type: "human" as const, sub: "bbbbbbbb-0000-4000-8000-000000000001" };
  test("same caller and key give the same valid key; other callers never collide", async () => {
    const a1 = await scopeIdempotencyKey(agentA, "daily-summary");
    expect(await scopeIdempotencyKey(agentA, "daily-summary")).toBe(a1);
    expect(await scopeIdempotencyKey(agentB, "daily-summary")).not.toBe(a1);
    expect(await scopeIdempotencyKey(human, "daily-summary")).not.toBe(a1);
    expect(await scopeIdempotencyKey(agentA, "daily-summarz")).not.toBe(a1);
    expect(parse(idempotencyKey, a1).ok).toBe(true);
    expect(a1).not.toContain("daily");
  });
  test("refuses invalid keys and callers", async () => {
    await expect(scopeIdempotencyKey(agentA, "short")).rejects.toThrow();
    await expect(scopeIdempotencyKey(agentA, "a".repeat(65))).rejects.toThrow();
    await expect(scopeIdempotencyKey({ type: "agent", sub: "" }, "valid_key_123")).rejects.toThrow();
    await expect(scopeIdempotencyKey({ type: "robot" as any, sub: "x" }, "valid_key_123")).rejects.toThrow();
  });
});

// privacy-r2-P2-3, spec-r2-R2-SPEC-3, spec-r2-R2-SPEC-4: model additions.
import { chatSummary } from "../src/model.ts";
describe("chat summary and status shapes (round 2)", () => {
  const base = { id: "c1", accountID: "a1", network: "WhatsApp", title: "t", type: "single", unreadCount: 0, isPinned: false, isMuted: false, isArchived: false, lastActivity: null };
  test("a chat says whether it has a draft, never what the draft says", () => {
    expect(parse(chatSummary, { ...base, hasDraft: true }).ok).toBe(true);
    expect(parse(chatSummary, { ...base, draftText: "half-typed private reply" }).ok).toBe(false);
  });
  test("a chat can say it is low priority", () => {
    expect(parse(chatSummary, { ...base, isLowPriority: true }).ok).toBe(true);
  });
  test("status carries the connected networks list (accounts[] alone is not the platform list)", () => {
    const r = parseActionResult("status", { online: true, lastSeenAt: null, connectorVersion: "1.0.0", beeper: { reachable: true, version: "4.2.1" }, accounts: [], networks: ["iMessage", "Twitter/X"] });
    expect(r.ok).toBe(true);
    expect(parseActionResult("status", { online: true, lastSeenAt: null, connectorVersion: null, beeper: null, accounts: [], networks: Array.from({ length: 51 }, (_, i) => `n${i}`) }).ok).toBe(false);
  });
});
