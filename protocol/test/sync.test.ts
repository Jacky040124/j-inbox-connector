import { describe, expect, test } from "bun:test";
import { CAPABILITIES, connectorFrame, encodeFrame, liveServerMessage, parse, reqFrame, syncChange, syncFrame, syncPullParams, syncPullResult, MAX_FRAME_BYTES, MAX_SYNC_CHANGES, SYNC_MESSAGES_PER_CHAT } from "../src/index.ts";

const chat = { id: "imsg##thread:+15550201001", accountID: "imessage", network: "iMessage", title: "Alice", type: "single", unreadCount: 1, isPinned: false, isMuted: false, isArchived: false, lastActivity: "2026-11-06T20:00:00.000Z", todo: true };
const message = { id: "m1", chatID: chat.id, accountID: "imessage", senderID: "alice", senderName: "Alice", timestamp: "2026-11-06T20:00:00.000Z", sortKey: "1000", type: "TEXT", isSender: false, text: "hi" };
const at = "2026-11-06T20:00:01.000Z";

describe("sync changes", () => {
  test("each op with its whole state", () => {
    for (const c of [
      { seq: 1, at, op: "chat.upsert", chat },
      { seq: 2, at, op: "chat.remove", chatID: chat.id },
      { seq: 3, at, op: "messages.upsert", chatID: chat.id, messages: [message] },
      { seq: 4, at, op: "messages.remove", chatID: chat.id, messageIDs: ["m1"] },
      { seq: 5, at, op: "chat.upsert", chat, opId: "op_abc12345" },
    ])
      expect(parse(syncChange, c).ok).toBe(true);
  });
  test("refused: a patch, no seq, seq 0, an unknown op, a bad opId, too many messages", () => {
    for (const c of [
      { seq: 1, at, op: "chat.upsert", chat: { id: chat.id, todo: false } },
      { at, op: "chat.remove", chatID: chat.id },
      { seq: 0, at, op: "chat.remove", chatID: chat.id },
      { seq: 1, at, op: "chat.patch", chatID: chat.id },
      { seq: 1, at, op: "chat.remove", chatID: chat.id, opId: "x" },
      { seq: 1, at, op: "messages.upsert", chatID: chat.id, messages: Array.from({ length: SYNC_MESSAGES_PER_CHAT + 1 }, (_, i) => ({ ...message, id: `m${i}` })) },
      { seq: 1, at, op: "messages.upsert", chatID: chat.id, messages: [] },
    ])
      expect(parse(syncChange, c).ok).toBe(false);
  });
});

describe("sync_pull", () => {
  test("params: nothing (a first visit), or the replica's epoch and cursor, or a snapshot's next page", () => {
    for (const p of [{}, { epoch: null, cursor: null }, { epoch: "ep_0123456789", cursor: 41 }, { epoch: "ep_0123456789", cursor: 0, page: "p.2" }]) expect(parse(syncPullParams, p).ok).toBe(true);
    for (const p of [{ epoch: "short" }, { cursor: -1 }, { cursor: 1.5 }, { page: "" }]) expect(parse(syncPullParams, p).ok).toBe(false);
  });
  test("a delta and a snapshot page", () => {
    expect(parse(syncPullResult, { kind: "delta", epoch: "ep_0123456789", head: 2, changes: [{ seq: 2, at, op: "chat.remove", chatID: chat.id }], more: false }).ok).toBe(true);
    expect(parse(syncPullResult, { kind: "snapshot", epoch: "ep_0123456789", head: 7, chats: [{ chat, messages: [message] }], next: "p.2" }).ok).toBe(true);
    expect(parse(syncPullResult, { kind: "snapshot", epoch: "ep_0123456789", head: 7, chats: [{ chat, messages: [message] }] }).ok).toBe(false);
  });
});

describe("sync frames", () => {
  test("a connector frame of its own, and the same object as a /live message", () => {
    const f = { type: "sync", epoch: "ep_0123456789", changes: [{ seq: 1, at, op: "chat.upsert", chat }] };
    expect(parse(syncFrame, f).ok).toBe(true);
    expect(parse(connectorFrame, f).ok).toBe(true);
    expect(parse(liveServerMessage, f).ok).toBe(true);
    expect(parse(syncFrame, { ...f, changes: [] }).ok).toBe(false);
    expect(parse(syncFrame, { ...f, changes: Array.from({ length: MAX_SYNC_CHANGES + 1 }, (_, i) => ({ seq: i + 1, at, op: "chat.remove", chatID: chat.id })) }).ok).toBe(false);
  });
  test("a full push of chat upserts fits a frame", () => {
    const big = { type: "sync" as const, epoch: "ep_0123456789", changes: Array.from({ length: MAX_SYNC_CHANGES }, (_, i) => ({ seq: i + 1, at, op: "chat.upsert" as const, chat: { ...chat, title: "x".repeat(200), preview: message } })) };
    expect(encodeFrame(big as never).ok).toBe(true);
    expect(JSON.stringify(big).length).toBeLessThan(MAX_FRAME_BYTES);
  });
  test("reqFrame carries the page's opId; the capability is sync.v1", () => {
    expect(parse(reqFrame, { type: "req", id: "r1", action: "archive", params: { chatID: chat.id }, opId: "op_abc12345" }).ok).toBe(true);
    expect(parse(reqFrame, { type: "req", id: "r1", action: "archive", params: { chatID: chat.id }, opId: "nope" }).ok).toBe(false);
    expect(CAPABILITIES.sync).toBe("sync.v1");
  });
});
