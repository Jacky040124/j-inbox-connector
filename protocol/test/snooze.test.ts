import { describe, expect, test } from "bun:test";
import { ACTIONS, parseActionParams, parseActionResult } from "../src/actions.ts";
import { approvalView, buildRaftManifest, ownerNoticeText } from "../src/agent.ts";
import { encodeFrame, parseCloudFrame, parseConnectorFrame } from "../src/frames.ts";
import { MAX_SNOOZE_MS, MAX_SNOOZES, MIN_SNOOZE_MS, SNOOZE_CLOCK_SLACK_MS, snoozeItem, snoozeUntilProblem } from "../src/snooze.ts";
import { parseLiveServerMessage } from "../src/web.ts";
import { parse } from "../src/schema.ts";
import { chat, chatID } from "./fixtures/examples.ts";

const NOW = Date.parse("2026-10-28T10:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const item = { chatID, until: at(3600_000), snoozedAt: at(0) };
const { preview: _p, ...summary } = chat;

describe("snoozeUntilProblem", () => {
  test("1 minute to 7 days ahead is fine, with clock slack at the far end", () => {
    for (const ms of [MIN_SNOOZE_MS, 3 * 3600_000, MAX_SNOOZE_MS, MAX_SNOOZE_MS + SNOOZE_CLOCK_SLACK_MS]) expect(snoozeUntilProblem(at(ms), NOW)).toBeNull();
    expect(snoozeUntilProblem("2026-10-28T12:00:00+02:00", NOW - 1)).toMatch(/at least a minute/);
  });
  test("in the past, now, or under a minute: refused", () => {
    for (const ms of [-86400_000, -1, 0, MIN_SNOOZE_MS - 1]) expect(snoozeUntilProblem(at(ms), NOW)).toBe("Pick a time at least a minute from now.");
  });
  test("more than 7 days (beyond the slack): refused", () => {
    for (const ms of [MAX_SNOOZE_MS + SNOOZE_CLOCK_SLACK_MS + 1, 30 * 86400_000, 3650 * 86400_000]) expect(snoozeUntilProblem(at(ms), NOW)).toBe("Snooze for at most 7 days.");
  });
  test("not a time at all", () => {
    for (const v of ["", "tomorrow", "2026-02-30", null, undefined, 5, {}, "x".repeat(100)]) expect(snoozeUntilProblem(v, NOW)).toBe("Not a valid time.");
    expect(snoozeUntilProblem(at(3600_000), Number.NaN)).toBe("Not a valid time.");
  });
});

describe("snooze actions", () => {
  test("snooze_chat validates chatID and until's format (the time window is the cloud's check)", () => {
    expect(parseActionParams("snooze_chat", { chatID, until: at(3600_000) }).ok).toBe(true);
    for (const bad of [{ chatID: "a b", until: at(3600_000) }, { chatID: "", until: at(3600_000) }, { chatID, until: "in 3 hours" }, { chatID, until: "2026-10-28T10:00:00" }, { chatID, until: at(1), extra: 1 }])
      expect(parseActionParams("snooze_chat", bad).ok).toBe(false);
    // hostile chat ids: the shared id rules (no whitespace, no control characters, bounded)
    for (const id of ["a\u0000b", "a\nb", "x".repeat(513), "‮abc def"]) expect(parseActionParams("snooze_chat", { chatID: id, until: at(3600_000) }).ok).toBe(false);
  });
  test("list_snoozed items: the id and times (all the cloud keeps), the chat read live when the computer is online; strict and bounded", () => {
    expect(parseActionResult("list_snoozed", { items: [item, { ...item, chat: summary }] }).ok).toBe(true);
    expect(parseActionResult("list_snoozed", { items: [{ ...item, text: "leak" }] }).ok).toBe(false);
    expect(parseActionResult("list_snoozed", { items: [{ ...item, title: "Alice" }] }).ok).toBe(false);
    expect(parseActionResult("list_snoozed", { items: [{ ...item, chat: { ...summary, title: "a\nb" } }] }).ok).toBe(false);
    expect(parseActionResult("list_snoozed", { items: Array.from({ length: MAX_SNOOZES + 1 }, () => item) }).ok).toBe(false);
    expect(parse(snoozeItem, { ...item, until: "soon" }).ok).toBe(false);
  });
  test("the agent manifest lists the snooze actions like the other actions; snooze and unsnooze need approval", () => {
    const m = buildRaftManifest({ origin: "https://inbox.example.com", service: "j-inbox" });
    const byName = new Map(m.actions.map((a) => [a.name, a]));
    for (const n of ["snooze_chat", "unsnooze_chat", "list_snoozed"]) expect(byName.get(n)?.endpoint).toEqual({ method: "POST", path: `/api/raft/actions/${n}` });
    expect(byName.get("snooze_chat")!.description).toMatch(/Requires the owner's approval/);
    expect(byName.get("unsnooze_chat")!.description).toMatch(/Requires the owner's approval/);
    expect(byName.get("list_snoozed")!.description).not.toMatch(/approval/);
    expect(byName.get("snooze_chat")!.parameters).toEqual({
      chatID: { type: "string", description: "Chat ID", required: true },
      until: { type: "string", description: ACTIONS.snooze_chat.paramDocs.until, required: true },
    });
    expect(m.description).toMatch(/snoozing need the owner's approval/);
  });
  test("approvals show when a snoozed chat comes back; the owner's DM names the action", () => {
    const v = { id: "apr_1", action: "snooze_chat", status: "pending", createdAt: at(0), expiresAt: at(600_000), decidedAt: null, requestedBy: { type: "agent", id: "a", name: "龙虾" }, target: { chatID, chatTitle: "Alice", network: "iMessage" }, preview: { until: at(3600_000) } };
    expect(parse(approvalView, v).ok).toBe(true);
    expect(parse(approvalView, { ...v, preview: { until: "later" } }).ok).toBe(false);
    expect(parse(approvalView, { ...v, action: "unsnooze_chat", preview: {} }).ok).toBe(true);
    expect(ownerNoticeText({ kind: "approval_requested", agentName: "龙虾", action: "snooze_chat", approveURL: "https://inbox.example.com/approvals/apr_1", expiresAt: at(600_000) })).toMatch(/^龙虾 wants to snooze a chat in J-Inbox/);
    expect(ownerNoticeText({ kind: "approval_requested", agentName: null, action: "unsnooze_chat", approveURL: "https://inbox.example.com/approvals/apr_1", expiresAt: at(600_000) })).toMatch(/end a chat's snooze/);
  });
});

describe("frames", () => {
  const ev = { type: "event", kind: "message", op: "upserted", chatID, messageIDs: ["m1"], ts: at(0) };
  test("message events may say whether someone else wrote (othersAt: a time, null, or absent)", () => {
    for (const othersAt of [at(-5000), null, undefined]) {
      const f = othersAt === undefined ? ev : { ...ev, othersAt };
      expect(parseConnectorFrame(JSON.stringify(f)).ok).toBe(true);
      expect(encodeFrame(f as never).ok).toBe(true);
    }
    for (const othersAt of ["yesterday", 5, true, "Alice"]) expect(parseConnectorFrame(JSON.stringify({ ...ev, othersAt })).ok).toBe(false);
    // only message events carry it
    expect(parseConnectorFrame(JSON.stringify({ type: "event", kind: "chat", op: "upserted", chatID, ts: at(0), othersAt: at(0) })).ok).toBe(false);
  });
  test("the cloud's own actions never ride in a req frame", () => {
    for (const action of ["snooze_chat", "unsnooze_chat", "list_snoozed"]) {
      expect(parseCloudFrame(JSON.stringify({ type: "req", id: "r1", action, params: {} })).ok).toBe(false);
      expect(encodeFrame({ type: "req", id: "r1", action, params: {} } as never).ok).toBe(false);
    }
    expect(parseCloudFrame(JSON.stringify({ type: "req", id: "r1", action: "archive", params: { chatID } })).ok).toBe(true);
  });
});

describe("/live snooze messages", () => {
  test("set (with until) and cleared (until null, with why)", () => {
    expect(parseLiveServerMessage(JSON.stringify({ type: "snooze", chatID, until: at(3600_000), reason: "snoozed" })).ok).toBe(true);
    for (const reason of ["due", "early", "unsnoozed", "unarchived", "dropped"]) expect(parseLiveServerMessage(JSON.stringify({ type: "snooze", chatID, until: null, reason })).ok).toBe(true);
    for (const bad of [{ type: "snooze", chatID, until: null }, { type: "snooze", chatID, until: null, reason: "whatever" }, { type: "snooze", chatID, until: null, reason: "due", title: "Alice" }, { type: "snooze", chatID: "a b", until: null, reason: "due" }])
      expect(parseLiveServerMessage(JSON.stringify(bad)).ok).toBe(false);
  });
});
