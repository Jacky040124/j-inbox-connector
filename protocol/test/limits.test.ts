import { describe, expect, test } from "bun:test";
import * as L from "../src/limits.ts";
import { parseActionResult } from "../src/actions.ts";
import { byteLength, encodeFrame } from "../src/frames.ts";

const CJK = (n: number) => "語".repeat(n);
const matrixUser = (i: number) => `@whatsapp_1555${String(i).padStart(7, "0")}:beeper.local`;

/** Realistic heavy page: long CJK texts, many file:/// attachments and many reactions. */
function heavyReadChat(n: number) {
  const items = Array.from({ length: n }, (_, i) => ({
    id: `$${"e".repeat(40)}${i}`,
    chatID: "!whatsapp_group_0000000000000000:beeper.local",
    accountID: "local-whatsapp_ba_FAKEwa0001",
    senderID: matrixUser(i),
    senderName: CJK(30),
    timestamp: "2026-10-01T10:00:00.000Z",
    sortKey: String(100000 + i),
    type: "IMAGE",
    text: CJK(L.MAX_RESULT_TEXT_LENGTH),
    textTruncated: true as const,
    isSender: false,
    attachments: Array.from({ length: 10 }, (_, k) => ({
      type: "img",
      url: `file:///Users/someone/Library/Application%20Support/BeeperTexts/media/local-whatsapp/${"a".repeat(64)}/${k}.jpg`,
      mimeType: "image/jpeg",
      fileName: `${CJK(40)}.jpg`,
      fileSize: 1234567,
      width: 4032,
      height: 3024,
    })),
    reactions: Array.from({ length: L.MAX_REACTIONS_PER_MESSAGE }, (_, k) => ({ reactionKey: "👍🏽", participantID: matrixUser(k), emoji: true })),
  }));
  const chat = { id: items[0]!.chatID, accountID: items[0]!.accountID, network: "WhatsApp", title: CJK(100), type: "group", unreadCount: 3, isPinned: false, isMuted: false, isArchived: false, lastActivity: "2026-10-01T10:00:00.000Z" };
  return { chat, items, hasMore: true, nextCursor: "abc" };
}

function maximalMessage() {
  const id = (c: string) => c.repeat(L.MAX_ID_LENGTH);
  return {
    id: id("m"),
    chatID: id("c"),
    accountID: id("a"),
    senderID: id("s"),
    senderName: CJK(L.MAX_NAME_LENGTH),
    timestamp: "2026-10-01T10:00:00.000000000+00:00",
    sortKey: "9".repeat(128),
    type: "FILE",
    text: CJK(L.MAX_EMAIL_TEXT_LENGTH),
    textTruncated: true as const,
    quotedText: CJK(L.MAX_EMAIL_TEXT_LENGTH),
    isSender: false,
    isUnread: true,
    isDeleted: false,
    editedAt: "2026-10-01T10:00:00.000000000+00:00",
    replyToMessageID: id("r"),
    attachments: Array.from({ length: L.MAX_ATTACHMENTS_PER_MESSAGE }, () => ({
      type: "unknown",
      url: "file:///" + "%E8%AA%9E".repeat(Math.floor((L.MAX_URL_LENGTH - 8) / 9)),
      mimeType: "application/" + "x".repeat(120),
      fileName: CJK(255),
      fileSize: Number.MAX_SAFE_INTEGER,
      width: 1_000_000,
      height: 1_000_000,
      duration: 1_000_000_000,
      isGif: false,
      isSticker: false,
      isVoiceNote: false,
    })),
    reactions: Array.from({ length: L.MAX_REACTIONS_PER_MESSAGE }, () => ({ reactionKey: CJK(L.MAX_REACTION_KEY_LENGTH), participantID: id("p"), emoji: false })),
    sendStatus: "FAIL_PERMANENT",
  };
}

function maximalChat() {
  return {
    id: "c".repeat(L.MAX_ID_LENGTH),
    accountID: "a".repeat(L.MAX_ID_LENGTH),
    network: CJK(64),
    title: CJK(L.MAX_TITLE_LENGTH),
    type: "group",
    unreadCount: 1_000_000_000,
    unreadMentionsCount: 1_000_000_000,
    isPinned: true,
    isMuted: true,
    isArchived: true,
    isReadOnly: true,
    isMarkedUnread: true,
    lastActivity: "2026-10-01T10:00:00.000000000+00:00",
    participantCount: 1_000_000_000,
    avatarURL: "file:///" + "%E8%AA%9E".repeat(Math.floor((L.MAX_URL_LENGTH - 8) / 9)),
    hasDraft: true,
    isLowPriority: true,
  };
}

describe("limits are coherent", () => {
  test("a full chunk fits in a frame with envelope room", () => {
    const b64 = Math.ceil(L.MAX_CHUNK_BYTES / 3) * 4;
    expect(L.MAX_CHUNK_BASE64_LENGTH).toBe(b64);
    expect(b64 + 512).toBeLessThan(L.MAX_FRAME_BYTES);
  });
  test("max media is a whole number of chunks", () => {
    expect(L.MAX_CHUNKS).toBe(Math.ceil(L.MAX_MEDIA_BYTES / L.MAX_CHUNK_BYTES));
  });
  // tests-r1-TQ5: build the worst case from the real schemas and the real encoder.
  test("a heavy but valid read_chat page can exceed one frame, so the connector must shrink pages", () => {
    const r = heavyReadChat(L.MAX_PAGE_LIMIT);
    expect(parseActionResult("read_chat", r).ok).toBe(true);
    const e = encodeFrame({ type: "res", id: "r1", ok: true, data: r } as any);
    expect(!e.ok && e.error).toBe("TOO_LARGE");
  });
  test("one maximal message (with a maximal chat and preview) always fits in a frame, so shrinking can always make progress", () => {
    const worst = maximalMessage();
    const chat = { ...maximalChat(), preview: worst };
    const data = { chat, items: [worst], hasMore: true, nextCursor: "c".repeat(L.MAX_CURSOR_LENGTH) };
    expect(parseActionResult("read_chat", data).ok).toBe(true);
    const e = encodeFrame({ type: "res", id: "x".repeat(L.MAX_REQUEST_ID_LENGTH), ok: true, data } as any);
    if (!e.ok) throw new Error(e.message);
    expect(byteLength(e.value)).toBeLessThan(L.MAX_FRAME_BYTES * 0.9);
    const search = { items: Array.from({ length: 1 }, () => worst), chats: { [worst.chatID]: { ...maximalChat(), preview: null } }, hasMore: true, nextCursor: null };
    expect(parseActionResult("search_messages", search).ok).toBe(true);
    expect(encodeFrame({ type: "res", id: "r", ok: true, data: search } as any).ok).toBe(true);
  });
  test("frames stay under the Cloudflare 1 MiB WebSocket message limit", () => {
    expect(L.MAX_FRAME_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });
  test("heartbeat timeout covers at least two missed pings", () => {
    expect(L.HEARTBEAT_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * L.HEARTBEAT_INTERVAL_MS);
  });
  test("protocol version is a positive integer", () => {
    expect(Number.isInteger(L.PROTOCOL_VERSION) && L.PROTOCOL_VERSION >= 1).toBe(true);
  });
});
