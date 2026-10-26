// spec-r1-F4 / tests-r1-TQ4: Beeper JSON -> protocol shapes, with documented defaults for the
// fields Beeper omits. Every fixture chat and message (hostile ones included) must map to a
// result the protocol validators accept.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CHAT_IDS, HOSTILE_TEXTS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { MAX_RESULT_TEXT_LENGTH, parse, parseActionResult, chatSummary, messageItem, account as accountSchema } from "@j-inbox/protocol";
import { assetURLFromLocalPath, mapAccount, mapChat, mapMessage, messageTypeOf } from "../src/beeper-map.ts";

let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper();
});
afterAll(() => fb.stop());

const get = async (p: string) => (await (await fetch(fb.url + p, { headers: { authorization: `Bearer ${fb.token}` } })).json()) as any;

describe("defaults for fields Beeper omits", () => {
  test("missing Message.type is derived from attachments, then text, else UNKNOWN", () => {
    expect(messageTypeOf({ text: "hi" })).toBe("TEXT");
    expect(messageTypeOf({})).toBe("UNKNOWN");
    expect(messageTypeOf({ attachments: [{ type: "img" }] })).toBe("IMAGE");
    expect(messageTypeOf({ attachments: [{ type: "img", isSticker: true }] })).toBe("STICKER");
    expect(messageTypeOf({ attachments: [{ type: "video" }] })).toBe("VIDEO");
    expect(messageTypeOf({ attachments: [{ type: "audio", isVoiceNote: true }] })).toBe("VOICE");
    expect(messageTypeOf({ attachments: [{ type: "audio" }] })).toBe("AUDIO");
    expect(messageTypeOf({ attachments: [{ type: "unknown" }] })).toBe("FILE");
    expect(messageTypeOf({ type: "REACTION", text: "x" })).toBe("REACTION");
    expect(messageTypeOf({ type: "SOMETHING_NEW", text: "x" })).toBe("UNKNOWN");
  });
  test("missing isSender, chat flags and account network get safe defaults", () => {
    const m = mapMessage({ id: "1", chatID: "c", accountID: "a", senderID: "s", timestamp: "2026-10-01T10:00:00.000Z", sortKey: "5" })!;
    expect(m.isSender).toBe(false);
    expect(m.type).toBe("UNKNOWN");
    const c = mapChat({ id: "c", accountID: "a", network: "Instagram", title: "t", type: "single", participants: { items: [], hasMore: false, total: 2 }, unreadCount: 0 })!;
    expect([c.isPinned, c.isMuted, c.isArchived]).toEqual([false, false, false]);
    expect(mapAccount({ accountID: "x", bridge: {}, user: {}, status: "connected" })!.network).toBe("Unknown");
    expect(mapAccount({ accountID: "x", network: "X", status: "brand_new_status" })!.status).toBe("unknown");
  });
  test("records without the ids the protocol needs are dropped, not invented", () => {
    for (const bad of [null, "x", [], {}, { id: "1" }, { id: "1", chatID: "c", accountID: "a", senderID: "s", timestamp: "yesterday", sortKey: "1" }, { id: "a b", chatID: "c", accountID: "a", senderID: "s", timestamp: "2026-10-01T10:00:00Z", sortKey: "1" }])
      expect(mapMessage(bad as any)).toBeNull();
    expect(mapChat({ id: "", accountID: "a" } as any)).toBeNull();
  });
});

describe("every fixture record maps to a valid protocol value", () => {
  test("all chats from /v1/chats (with preview) and all accounts", async () => {
    let cursor: string | null = null;
    let n = 0;
    for (;;) {
      const page: any = await get(`/v1/chats?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}&direction=before` : ""}`);
      for (const raw of page.items) {
        const c = mapChat(raw);
        if (!c) throw new Error(`chat ${n} did not map`);
        const r = parse(chatSummary, c);
        if (!r.ok) throw new Error(JSON.stringify(r.issues));
        if (raw.preview) expect(c.preview?.id).toBe(raw.preview.id);
        n++;
      }
      if (!page.hasMore) break;
      cursor = page.oldestCursor;
    }
    expect(n).toBe(fb.state.chats.size);
    for (const a of await get("/v1/accounts")) expect(parse(accountSchema, mapAccount(a)).ok).toBe(true);
  });
  test("all messages of every chat, including hostile text, iMessage without type and REACTIONs", () => {
    const types = new Set<string>();
    for (const [chatID, msgs] of fb.state.messages) {
      const items = msgs.map((m) => mapMessage(structuredClone(m) as any));
      for (const it of items) {
        if (!it) throw new Error(`message in ${chatID} did not map`);
        const r = parse(messageItem, it);
        if (!r.ok) throw new Error(`${chatID}: ${JSON.stringify(r.issues)}`);
        types.add(it.type);
      }
    }
    expect(types.has("REACTION")).toBe(true);
    const imsg = fb.state.messagesOf(CHAT_IDS.imessageAlice).map((m) => mapMessage(m as any)!);
    expect(imsg.every((m) => m.type === "TEXT")).toBe(true);
  });
  test("hostile text is sanitized and truncated, never rejected", () => {
    const msgs = fb.state.messagesOf(CHAT_IDS.hostile).map((m) => mapMessage(m as any)!);
    const huge = msgs.find((m) => m.textTruncated)!;
    expect(huge.text!.length).toBeLessThanOrEqual(MAX_RESULT_TEXT_LENGTH);
    expect(msgs.some((m) => m.text?.includes("<script>"))).toBe(true); // data, not markup: kept verbatim
    expect(msgs.some((m) => m.text?.includes("\u0000"))).toBe(false);
    const nul = msgs.find((m) => m.text?.startsWith("before"))!;
    expect(nul.text).toBe("beforeafter");
    expect(HOSTILE_TEXTS.nul).toContain("\u0000");
    const chat = mapChat(fb.state.chats.get(CHAT_IDS.hostile) as any)!;
    expect(chat.title).not.toContain("\n");
  });
  test("read_chat and unread_summary results built from mapped data validate", () => {
    const chat = mapChat(fb.state.chats.get(CHAT_IDS.pinnedUnread) as any)!;
    const items = fb.state.messagesOf(CHAT_IDS.pinnedUnread).map((m) => mapMessage(m as any)!).slice(-30);
    expect(parseActionResult("read_chat", { chat, items, hasMore: true, nextCursor: "x" }).ok).toBe(true);
  });
});

describe("HTML message bodies", () => {
  test("a LinkedIn-style HTML body reaches agents and the web page as plain text", () => {
    const raw = { id: "m1", chatID: "!c:beeper.local", accountID: "linkedin", senderID: "u", timestamp: "2026-10-21T10:00:00.000Z", sortKey: "1", text: "<p>Hi Jacky</p><br><p>Tom &amp; Jerry</p>" };
    expect(mapMessage(raw)!.text).toBe("Hi Jacky\n\nTom & Jerry");
    expect(mapMessage({ ...raw, text: "a <b> c &amp; <p> d" })!.text).toBe("a <b> c &amp; <p> d");
  });
});

describe("asset URLs", () => {
  test("chat imgURL (a local path) becomes an encoded file:/// URL; attachments keep mxc://", () => {
    expect(assetURLFromLocalPath("/Users/a b/Library/x#1?.png")).toBe("file:///Users/a%20b/Library/x%231%3F.png");
    expect(assetURLFromLocalPath("relative/x.png")).toBeUndefined();
    expect(assetURLFromLocalPath("/Users/x/../../etc/passwd")).toBeUndefined();
    expect(assetURLFromLocalPath("")).toBeUndefined();
    const media = fb.state.messagesOf(CHAT_IDS.media).map((m) => mapMessage(m as any)!);
    expect(media[0]!.attachments![0]!.url).toBe("mxc://beeper.local/img_small");
  });
  test("a 1:1 chat without imgURL uses the other person's picture; groups and self pictures do not", () => {
    const base = { id: "!c:beeper.local", accountID: "whatsapp", network: "WhatsApp", title: "Ana" };
    const self = { id: "me", isSelf: true, imgURL: "mxc://beeper.local/me" };
    const other = { id: "ana", imgURL: "file:///Users/x/Library/Application%20Support/BeeperTexts/media/ana" };
    const seen: string[] = [];
    expect(mapChat({ ...base, type: "single", participants: { items: [self, other] } }, { onAsset: (u) => seen.push(u) })!.avatarURL).toBe(other.imgURL);
    expect(seen).toEqual([other.imgURL]);
    expect(mapChat({ ...base, type: "single", imgURL: "mxc://beeper.local/chat", participants: { items: [other] } })!.avatarURL).toBe("mxc://beeper.local/chat");
    expect(mapChat({ ...base, type: "single", participants: { items: [self, { id: "ana" }] } })!.avatarURL).toBeUndefined();
    expect(mapChat({ ...base, type: "group", participants: { items: [self, other] } })!.avatarURL).toBeUndefined();
    expect(mapChat({ ...base, type: "single", participants: { items: [{ ...other, imgURL: "http://evil/x" }] } })!.avatarURL).toBeUndefined();
  });
  test("every asset URL the mapper returns is reported so get_media can whitelist it", () => {
    const seen = new Set<string>();
    for (const m of fb.state.messagesOf(CHAT_IDS.media)) mapMessage(m as any, { onAsset: (u) => seen.add(u) });
    for (const c of fb.state.chatList()) mapChat(c as any, { onAsset: (u) => seen.add(u) });
    expect(seen.has("mxc://beeper.local/img_small")).toBe(true);
    expect([...seen].some((u) => u.startsWith("file:///"))).toBe(true);
  });
});
