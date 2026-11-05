import { describe, expect, test } from "bun:test";
import { ACTIONS, coerceAgentParams, parseActionParams, parseActionResult } from "../src/actions.ts";
import { AGENT_CATALOGUE_ACTIONS, buildRaftManifest, isAgentActionName } from "../src/agent.ts";
import { CAPABILITIES, eventFrame } from "../src/frames.ts";
import { chatSummary } from "../src/model.ts";
import { parse } from "../src/schema.ts";
import { chat, chatID } from "./fixtures/examples.ts";

describe("To do in the protocol", () => {
  test("the capability", () => expect(CAPABILITIES.todo).toBe("todo.v1"));

  test("ChatSummary.todo: optional, a boolean, and older rows without it still parse", () => {
    expect(parse(chatSummary, chat).ok).toBe(true);
    expect(parse(chatSummary, { ...chat, todo: true }).ok).toBe(true);
    expect(parse(chatSummary, { ...chat, todo: false }).ok).toBe(true);
    for (const bad of ["true", 1, null]) expect(parse(chatSummary, { ...chat, todo: bad }).ok).toBe(false);
  });

  test("list_chats and unread_summary filter on it; the other params are as they were", () => {
    expect(parseActionParams("list_chats", { inbox: "primary", todo: true, limit: 50 }).ok).toBe(true);
    expect(parseActionParams("list_chats", { todo: "yes" }).ok).toBe(false);
    expect(parseActionParams("list_chats", {}).ok).toBe(true);
    expect(parseActionParams("unread_summary", { limit: 1, todo: true }).ok).toBe(true);
    expect(parseActionParams("unread_summary", { todo: 1 }).ok).toBe(false);
    expect(parseActionParams("unread_summary", {}).ok).toBe(true);
  });

  test("agents may read it: the filter is in the manifest, and `raft --param todo=true` comes through as a boolean", () => {
    const list = buildRaftManifest({ origin: "https://inbox.example.com", service: "j-inbox" }).actions.find((a) => a.name === "list_chats")!;
    expect(JSON.stringify(list.parameters)).toContain("todo");
    expect(coerceAgentParams("list_chats", { todo: "true" }).todo).toBe(true);
    expect(parseActionResult("list_chats", { items: [{ ...chat, todo: true }], hasMore: false, nextCursor: null }).ok).toBe(true);
  });

  test("set_todo: owner only, never in the manifest, nothing an agent could ask or get approved", () => {
    const d = ACTIONS.set_todo;
    expect([d.humanOnly, d.needsApprovalForAgents, d.write, d.streamed, (d as { cloud?: boolean }).cloud, (d as { cloudOnly?: boolean }).cloudOnly]).toEqual([true, false, true, false, undefined, undefined]);
    expect(AGENT_CATALOGUE_ACTIONS as string[]).not.toContain("set_todo");
    expect(isAgentActionName("set_todo")).toBe(false);
    const names = buildRaftManifest({ origin: "https://inbox.example.com", service: "j-inbox" }).actions.map((a) => a.name);
    expect(names).not.toContain("set_todo");
    expect(JSON.stringify(buildRaftManifest({ origin: "https://inbox.example.com", service: "j-inbox" })).includes("set_todo")).toBe(false);
  });

  test("set_todo's shape: strict both ways", () => {
    expect(parseActionParams("set_todo", { chatID, todo: false }).ok).toBe(true);
    for (const bad of [{ chatID }, { todo: true }, { chatID, todo: "false" }, { chatID, todo: true, extra: 1 }]) expect(parseActionParams("set_todo", bad).ok).toBe(false);
    expect(parseActionResult("set_todo", { chatID, todo: true }).ok).toBe(true);
    expect(parseActionResult("set_todo", { chatID }).ok).toBe(false);
  });

  test("hostile chat ids are fine as ids, and whitespace is not", () => {
    for (const id of ["__proto__", "constructor", "!a:b#c/d?e", "gmail:o@example.com:abc", "imsg##thread:+1"]) expect(parseActionParams("set_todo", { chatID: id, todo: true }).ok).toBe(true);
    for (const id of ["a b", "", "x‮y", "x".repeat(5000)]) expect(parseActionParams("set_todo", { chatID: id, todo: true }).ok).toBe(false);
  });

  test("a chat event may carry the flag, one bit and nothing else", () => {
    const f = { type: "event", kind: "chat", op: "upserted", chatID, ts: "2026-11-04T10:00:00.000Z" };
    expect(parse(eventFrame, f).ok).toBe(true);
    expect(parse(eventFrame, { ...f, todo: true }).ok).toBe(true);
    expect(parse(eventFrame, { ...f, todo: "true" }).ok).toBe(false);
    expect(parse(eventFrame, { ...f, kind: "message", messageIDs: ["m1"], todo: true }).ok).toBe(false);
  });
});
