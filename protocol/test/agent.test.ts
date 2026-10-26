import { describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PATH_PREFIX,
  AGENT_META_ACTIONS,
  RAFT_CALLBACK_PATH,
  RAFT_MANIFEST_PATH,
  agentActionResponse,
  approvalView,
  buildRaftManifest,
  isAgentActionName,
} from "../src/agent.ts";
import { ACTION_NAMES, ACTIONS } from "../src/actions.ts";
import { AGENT_MEDIA_INLINE_MAX_BYTES, OFFLINE_ALERT_AFTER_MS } from "../src/limits.ts";
import { parse } from "../src/schema.ts";

// Rules from docs.raft.build "Manifest fields" / "HTTP API actions" (raft-agent-manifest.v0).
function checkManifestV0(m: any): string[] {
  const errs: string[] = [];
  if (m.schema !== "raft-agent-manifest.v0") errs.push("schema");
  if (m.execution?.mode !== "http_api") errs.push("execution.mode");
  if (m.auth && m.auth.type !== "login_with_raft") errs.push("auth.type");
  const names = new Set<string>();
  for (const a of m.actions ?? []) {
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(a.name)) errs.push(`name ${a.name}`);
    if (names.has(a.name)) errs.push(`duplicate ${a.name}`);
    names.add(a.name);
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(a.endpoint?.method)) errs.push(`method ${a.name}`);
    const p = a.endpoint?.path;
    if (typeof p !== "string" || !p.startsWith("/") || p.startsWith("//") || p.includes("#") || p.includes("://")) errs.push(`path ${a.name}`);
    for (const [k, v] of Object.entries<any>(a.parameters ?? {})) {
      if (!/^[A-Za-z0-9._:-]{1,80}$/.test(k)) errs.push(`param name ${k}`);
      if (typeof v.type !== "string" || !v.type) errs.push(`param type ${k}`);
      if (v.required !== undefined && typeof v.required !== "boolean") errs.push(`param required ${k}`);
    }
    if (a.response && (a.response.type !== "file" || !(a.response.maxBytes > 0))) errs.push(`response ${a.name}`);
  }
  for (const u of [m.app_origin, m.execution?.base_url, m.auth?.login_url, m.context_check?.url]) if (u !== undefined && !/^https?:\/\//.test(u)) errs.push(`url ${u}`);
  return errs;
}

const origin = "https://inbox.jackyzhonghq.com";

describe("Raft manifest", () => {
  const m: any = buildRaftManifest({ origin, service: "j-inbox" });
  test("is valid raft-agent-manifest.v0", () => expect(checkManifestV0(m)).toEqual([]));
  test("well-known path and callback path", () => {
    expect(RAFT_MANIFEST_PATH).toBe("/.well-known/raft-agent-manifest.json");
    expect(RAFT_CALLBACK_PATH).toBe("/auth/raft/callback");
  });
  test("lists every catalogue action except the owner-only ones, plus the meta actions", () => {
    const names = m.actions.map((a: any) => a.name).sort();
    expect(names).toEqual([...ACTION_NAMES.filter((n) => n !== "remove_account"), ...AGENT_META_ACTIONS].sort());
    expect(names).not.toContain("remove_account");
  });
  test("each action posts to the agent action prefix", () => {
    for (const a of m.actions) {
      expect(a.endpoint.method).toBe("POST");
      expect(a.endpoint.path).toBe(AGENT_ACTION_PATH_PREFIX + a.name);
    }
  });
  test("parameters mirror the catalogue, with required flags and types", () => {
    const send = m.actions.find((a: any) => a.name === "send_message");
    expect(send.parameters.chatID).toEqual({ type: "string", description: ACTIONS.send_message.paramDocs.chatID, required: true });
    expect(send.parameters.replyToMessageID.required).toBe(false);
    const list = m.actions.find((a: any) => a.name === "list_chats");
    expect(list.parameters.limit.type).toBe("integer");
    expect(list.parameters.unreadOnly.type).toBe("boolean");
    expect(list.parameters.accountIDs.type).toBe("array");
  });
  test("approval actions say so in their description", () => {
    for (const a of m.actions) {
      const def = (ACTIONS as any)[a.name];
      if (def?.needsApprovalForAgents) expect(a.description).toContain("approval");
    }
  });
  test("spec-r1-F9: no undocumented manifest fields (get_media has no `response`); only documented keys", () => {
    const g = m.actions.find((a: any) => a.name === "get_media");
    expect(g.response).toBeUndefined();
    const documented = new Set(["name", "description", "endpoint", "parameters", "returns"]);
    for (const a of m.actions) for (const k of Object.keys(a)) expect(`${a.name}.${k} ${documented.has(k)}`).toBe(`${a.name}.${k} true`);
    expect(g.description).toMatch(/base64/);
  });
  test("origin is not derived from anything but the argument; trailing slash normalized", () => {
    const m2 = buildRaftManifest({ origin: origin + "/", service: "j-inbox" });
    expect(m2.app_origin).toBe(origin);
    expect(m2.execution.base_url).toBe(origin);
    expect(m2.context_check.url).toBe(origin + AGENT_ACTION_PATH_PREFIX + "whoami");
  });
  test("refuses a non-https origin (except loopback) and origins with paths", () => {
    expect(() => buildRaftManifest({ origin: "http://evil.example", service: "j-inbox" })).toThrow();
    expect(() => buildRaftManifest({ origin: "https://x.example/sub", service: "j-inbox" })).toThrow();
    expect(() => buildRaftManifest({ origin: "http://127.0.0.1:8787", service: "j-inbox" })).not.toThrow();
  });
  test("manifest is well under Raft's 1 MiB limit", () => {
    expect(JSON.stringify(m).length).toBeLessThan(64 * 1024);
  });
});

describe("isAgentActionName", () => {
  test("catalogue + meta, nothing else", () => {
    for (const n of [...ACTION_NAMES.filter((n) => n !== "remove_account"), "whoami", "approval_status"]) expect(isAgentActionName(n)).toBe(true);
    for (const n of ["__proto__", "hasOwnProperty", "approve", "decide_approval", "", "remove_account"]) expect(isAgentActionName(n)).toBe(false);
  });
});

const approval = {
  id: "apr_1",
  action: "send_message",
  status: "pending",
  createdAt: "2026-10-25T12:00:00Z",
  expiresAt: "2026-10-25T12:10:00Z",
  decidedAt: null,
  requestedBy: { type: "agent", id: "cccccccc-0000-4000-8000-000000000003", name: "Longxia" },
  target: { chatID: "imsg##thread:+1555", chatTitle: "Mom", network: "iMessage" },
  preview: { text: "On my way <script>alert(1)</script>" },
};

describe("approvalView", () => {
  test("valid", () => expect(parse(approvalView, approval).ok).toBe(true));
  test("only approval actions can be pending approval", () => {
    expect(parse(approvalView, { ...approval, action: "read_chat" }).ok).toBe(false);
    expect(parse(approvalView, { ...approval, action: "draft_reply" }).ok).toBe(false);
  });
  test("statuses", () => {
    for (const status of ["pending", "approved", "denied", "expired", "executed", "failed"]) expect(parse(approvalView, { ...approval, status }).ok).toBe(true);
    expect(parse(approvalView, { ...approval, status: "maybe" }).ok).toBe(false);
  });
  test("result and error", () => {
    expect(parse(approvalView, { ...approval, status: "executed", result: { chatID: "c", pendingMessageID: "p" } }).ok).toBe(true);
    expect(parse(approvalView, { ...approval, status: "failed", error: { code: "OFFLINE", message: "offline" } }).ok).toBe(true);
  });
  test("extra fields rejected", () => expect(parse(approvalView, { ...approval, params: {} }).ok).toBe(false));
});

describe("agentActionResponse", () => {
  test("done", () => expect(parse(agentActionResponse, { ok: true, status: "done", result: { any: "thing" } }).ok).toBe(true));
  test("pending approval", () => {
    const v = { ok: true, status: "pending_approval", approval: { id: "apr_1", action: "send_message", expiresAt: "2026-10-25T12:10:00Z", approveURL: "https://inbox.example/approvals/apr_1" } };
    expect(parse(agentActionResponse, v).ok).toBe(true);
    expect(parse(agentActionResponse, { ...v, approval: { ...v.approval, approveURL: "javascript:alert(1)" } }).ok).toBe(false);
  });
  test("error", () => {
    expect(parse(agentActionResponse, { ok: false, status: "error", error: { code: "NOT_ALLOWED", message: "no" } }).ok).toBe(true);
    expect(parse(agentActionResponse, { ok: true, status: "error", error: { code: "NOT_ALLOWED", message: "no" } }).ok).toBe(false);
    expect(parse(agentActionResponse, { ok: false, status: "done", result: {} }).ok).toBe(false);
  });
});

import { agentMediaResult, authorizeRoomAccess, canBindRoom, offlineAlertDue, ownerNoticeText, approvalTicket } from "../src/agent.ts";

describe("spec-r1-F9: agent get_media returns JSON (base64), not raw bytes", () => {
  test("small files inline as base64 with metadata", () => {
    expect(parse(agentMediaResult, { mimeType: "image/png", size: 3, fileName: "a.png", encoding: "base64", data: "AQID" }).ok).toBe(true);
    expect(parse(agentMediaResult, { mimeType: "image/png", size: 3, encoding: "base64", data: "not base64!" }).ok).toBe(false);
    expect(parse(agentMediaResult, { mimeType: "image/png", size: AGENT_MEDIA_INLINE_MAX_BYTES + 1, encoding: "base64", data: "" }).ok).toBe(false);
  });
});

// spec-r1-F2: approvals and offline alerts reach the owner through Raft (App Bot DM), metadata only.
describe("owner notices", () => {
  const approveURL = "https://inbox.jackyzhonghq.com/approvals/apr_1";
  test("approval notice names the agent and action and links the approval, but never the chat or text", () => {
    const t = ownerNoticeText({ kind: "approval_requested", agentName: "龙虾", action: "send_message", approveURL, expiresAt: "2026-10-25T12:10:00Z" });
    expect(t).toContain("龙虾");
    expect(t).toContain("send a message");
    expect(t).toContain(approveURL);
    expect(t).toContain("12:10");
  });
  test("hostile agent names cannot inject links, mentions or extra lines", () => {
    const t = ownerNoticeText({ kind: "approval_requested", agentName: "[click](javascript:alert(1))\n@everyone <b>x</b>", action: "react", approveURL, expiresAt: "2026-10-25T12:10:00Z" });
    expect(t).not.toContain("](");
    expect(t).not.toContain("<b>");
    expect(t).not.toContain("@everyone");
    expect(t.split("\n").length).toBeLessThanOrEqual(2);
  });
  test("approve URL must be https (loopback http in dev)", () => {
    expect(() => ownerNoticeText({ kind: "approval_requested", agentName: "x", action: "react", approveURL: "javascript:alert(1)", expiresAt: "2026-10-25T12:10:00Z" })).toThrow();
  });
  test("offline and back-online notices", () => {
    expect(ownerNoticeText({ kind: "connector_offline", minutes: 7 })).toMatch(/offline.*7 min/i);
    expect(ownerNoticeText({ kind: "connector_online" })).toMatch(/back online/i);
  });
  test("offline alert fires once per outage, after 5 minutes", () => {
    const since = 1_000_000;
    expect(offlineAlertDue({ offlineSince: since, now: since + OFFLINE_ALERT_AFTER_MS - 1, lastAlertAt: null })).toBe(false);
    expect(offlineAlertDue({ offlineSince: since, now: since + OFFLINE_ALERT_AFTER_MS, lastAlertAt: null })).toBe(true);
    expect(offlineAlertDue({ offlineSince: since, now: since + 3 * OFFLINE_ALERT_AFTER_MS, lastAlertAt: since + OFFLINE_ALERT_AFTER_MS })).toBe(false);
    expect(offlineAlertDue({ offlineSince: since, now: since + 3 * OFFLINE_ALERT_AFTER_MS, lastAlertAt: since - 10 })).toBe(true);
    expect(offlineAlertDue({ offlineSince: null, now: since, lastAlertAt: null })).toBe(false);
  });
  test("the pending_approval ticket says whether the owner was notified", () => {
    const t = { id: "apr_1", action: "send_message", expiresAt: "2026-10-25T12:10:00Z", approveURL };
    expect(parse(approvalTicket, { ...t, delivery: "raft_dm" }).ok).toBe(true);
    expect(parse(approvalTicket, { ...t, delivery: "none" }).ok).toBe(true);
    expect(parse(approvalTicket, { ...t, delivery: "email" }).ok).toBe(false);
  });
});

// spec-r1-F8: one owner per Raft server; agents reach exactly that owner's room.
describe("room binding", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const jacky = { type: "human" as const, sub: "aaaaaaaa-0000-4000-8000-000000000001", serverID: A, role: "owner" };
  const guest = { type: "human" as const, sub: "aaaaaaaa-0000-4000-8000-000000000002", serverID: A, role: "member" };
  const admin2 = { type: "human" as const, sub: "aaaaaaaa-0000-4000-8000-000000000003", serverID: A, role: "admin" };
  const mallory = { type: "human" as const, sub: "cccccccc-0000-4000-8000-000000000001", serverID: B, role: "owner" };
  const lunlun = { type: "agent" as const, sub: "bbbbbbbb-0000-4000-8000-000000000002", serverID: A, role: "member" };
  const intruder = { type: "agent" as const, sub: "dddddddd-0000-4000-8000-000000000001", serverID: B, role: "member" };
  const binding = { ownerSub: jacky.sub, serverID: A };
  test("only a server owner/admin human may bind a server's room, and only if no one else owns it", () => {
    expect(canBindRoom(jacky, null)).toEqual({ ok: true });
    expect(canBindRoom(jacky, binding)).toEqual({ ok: true });
    expect(canBindRoom(guest, null)).toEqual({ ok: false, code: "NOT_ALLOWED" });
    expect(canBindRoom(admin2, binding)).toEqual({ ok: false, code: "CONFLICT" });
    expect(canBindRoom(lunlun, null)).toEqual({ ok: false, code: "NOT_ALLOWED" });
    expect(canBindRoom(mallory, binding)).toEqual({ ok: true });
  });
  test("humans reach only their own room; agents only the room bound to their server", () => {
    expect(authorizeRoomAccess(jacky, binding)).toEqual({ ok: true });
    expect(authorizeRoomAccess(guest, binding)).toEqual({ ok: false, code: "NOT_ALLOWED" });
    expect(authorizeRoomAccess(admin2, binding)).toEqual({ ok: false, code: "NOT_ALLOWED" });
    expect(authorizeRoomAccess(lunlun, binding)).toEqual({ ok: true });
    expect(authorizeRoomAccess(intruder, binding)).toEqual({ ok: false, code: "NOT_ALLOWED" });
    expect(authorizeRoomAccess(mallory, binding)).toEqual({ ok: false, code: "NOT_ALLOWED" });
    expect(authorizeRoomAccess(lunlun, null)).toEqual({ ok: false, code: "NOT_FOUND" });
  });
  // tests-r2-TQ2-05: an agent can never become the owner, whatever role Raft reports.
  test("agents cannot bind a room even as server owner or admin", () => {
    for (const role of ["owner", "admin", "member"]) {
      const agent = { ...lunlun, role };
      expect(canBindRoom(agent, null)).toEqual({ ok: false, code: "NOT_ALLOWED" });
      expect(canBindRoom(agent, binding)).toEqual({ ok: false, code: "NOT_ALLOWED" });
    }
  });
  // tests-r2-TQ2-09: a half-reset binding (empty/null owner) lets no agent in.
  test("a binding without an owner fails closed for agents too", () => {
    for (const ownerSub of ["", null, undefined, 42, "x".repeat(129)]) expect(authorizeRoomAccess(lunlun, { ownerSub, serverID: A } as any)).toEqual({ ok: false, code: "NOT_ALLOWED" });
    for (const serverID of ["", null, undefined]) expect(authorizeRoomAccess(lunlun, { ownerSub: jacky.sub, serverID } as any)).toEqual({ ok: false, code: "NOT_ALLOWED" });
  });
  test("malformed principals fail closed", () => {
    for (const p of [{}, { type: "agent", sub: "", serverID: A, role: "member" }, { type: "robot", sub: "x", serverID: A, role: "owner" }, { ...jacky, serverID: "" }, null])
      expect(authorizeRoomAccess(p as any, binding).ok).toBe(false);
    expect(authorizeRoomAccess(jacky, { ownerSub: "", serverID: A }).ok).toBe(false);
  });
});

// security-r2-SEC2-9: approvals are capped per agent and per room and count against the action's rate.
import { MAX_PENDING_APPROVALS_PER_AGENT, MAX_PENDING_APPROVALS_PER_ROOM, APPROVAL_NOTICE_COOLDOWN_MS, approvalNoticeDue, canCreateApproval } from "../src/agent.ts";
describe("approval caps and grouped notices", () => {
  const ok = { action: "send_message" as const, pendingForAgent: 0, pendingInRoom: 0, createdLastMinuteByAgent: 0 };
  test("per-agent, per-room and per-minute caps answer RATE_LIMITED", () => {
    expect(canCreateApproval(ok)).toEqual({ ok: true });
    expect(canCreateApproval({ ...ok, pendingForAgent: MAX_PENDING_APPROVALS_PER_AGENT })).toEqual({ ok: false, code: "RATE_LIMITED" });
    expect(canCreateApproval({ ...ok, pendingInRoom: MAX_PENDING_APPROVALS_PER_ROOM })).toEqual({ ok: false, code: "RATE_LIMITED" });
    expect(canCreateApproval({ ...ok, createdLastMinuteByAgent: ACTIONS.send_message.rateLimitPerMinute! })).toEqual({ ok: false, code: "RATE_LIMITED" });
    expect(canCreateApproval({ ...ok, action: "react", createdLastMinuteByAgent: ACTIONS.send_message.rateLimitPerMinute! })).toEqual({ ok: true });
    expect(MAX_PENDING_APPROVALS_PER_AGENT).toBeLessThanOrEqual(5);
    expect(MAX_PENDING_APPROVALS_PER_ROOM).toBeLessThanOrEqual(20);
    expect(canCreateApproval({ ...ok, pendingForAgent: -1 } as any).ok).toBe(false);
    expect(canCreateApproval({ ...ok, action: "list_chats" } as any).ok).toBe(false);
  });
  test("owner DMs are grouped: at most one per cooldown, then a count", () => {
    expect(approvalNoticeDue({ lastNoticeAt: null, now: 1000 })).toBe(true);
    expect(approvalNoticeDue({ lastNoticeAt: 1000, now: 1000 + APPROVAL_NOTICE_COOLDOWN_MS - 1 })).toBe(false);
    expect(approvalNoticeDue({ lastNoticeAt: 1000, now: 1000 + APPROVAL_NOTICE_COOLDOWN_MS })).toBe(true);
    const t = ownerNoticeText({ kind: "approvals_pending", count: 7, approvalsURL: "https://inbox.example.com/approvals" });
    expect(t).toMatch(/7 .*approval/i);
    expect(t).toContain("https://inbox.example.com/approvals");
  });
  test("the owner is told when a new computer replaced the old one (metadata only, safe names)", () => {
    const t = ownerNoticeText({ kind: "connector_replaced", newDeviceName: "[x](javascript:alert(1)) Mac", oldDeviceName: "Jacky's Mac mini", devicesURL: "https://inbox.example.com/devices" });
    expect(t).toMatch(/replaced/i);
    expect(t).toContain("https://inbox.example.com/devices");
    expect(t).not.toContain("javascript:");
    expect(t).not.toContain("](");
    expect(ownerNoticeText({ kind: "approval_requested", agentName: "javajavascript:script:x", action: "react", approveURL: "https://inbox.example.com/a", expiresAt: "2026-10-25T12:10:00Z" })).not.toMatch(/javascript:/i);
  });
});
