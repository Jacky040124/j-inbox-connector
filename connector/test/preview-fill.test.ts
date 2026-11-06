// A chat-list preview Beeper sends with only who and when (preview-fill.ts): real LinkedIn,
// Instagram, X and WhatsApp chats whose newest event is a reaction, a photo or an unsent message
// showed "Unsupported message". The chat's history says what it was.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { CHAT_IDS, startFakeBeeper, type BMessage, type FakeBeeper } from "@j-inbox/fake-beeper";
import type { ChatSummary, MessageItem } from "@j-inbox/protocol";
import { createBeeperClient } from "../src/beeper-client.ts";
import { createActions } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";
import { mapChat } from "../src/beeper-map.ts";
import { createPreviewFiller, isBarePreview, previewFromHistory } from "../src/preview-fill.ts";

const SELF = "@owner:beeper.com";
const THEM = "@linkedin_them:beeper.local";
const raw = (o: Record<string, unknown>) => ({ chatID: "!c:beeper.local", accountID: "linkedin", senderID: THEM, timestamp: "2026-11-01T10:00:00.000Z", isSender: false, ...o });
// What Beeper's chat list gave (2026-11-06): only who and when.
const bare = (o: Record<string, unknown>) => mapChat({ id: "!c:beeper.local", accountID: "linkedin", network: "LinkedIn", title: "T", type: "single", preview: raw(o) })!.preview!;

describe("what a bare preview was, from history", () => {
  test("the owner's reaction (not in history): the newest earlier message the owner reacted to", () => {
    const p = bare({ id: "105", sortKey: "1005", senderID: SELF, isSender: true, timestamp: "2026-11-01T10:05:00.000Z" });
    expect(isBarePreview(p)).toBe(true);
    const history = [
      raw({ id: "101", sortKey: "1001", type: "TEXT", text: "older", reactions: [{ reactionKey: "🐐", participantID: SELF, emoji: true }] }),
      raw({ id: "103", sortKey: "1003", type: "TEXT", text: "thanks", reactions: [{ reactionKey: "🚀", participantID: SELF, emoji: true }] }),
      raw({ id: "104", sortKey: "1004", type: "TEXT", text: "all good", senderID: SELF, isSender: true }),
    ];
    const out = previewFromHistory(p, history, { selfIDs: new Set([SELF]) })!;
    expect(out).toMatchObject({ id: "105", type: "REACTION", text: "🚀", replyToMessageID: "103", isSender: true, timestamp: "2026-11-01T10:05:00.000Z" });
  });

  test("someone else's reaction is theirs, never the owner's on the same message", () => {
    const p = bare({ id: "9", sortKey: "19", senderName: "Sam Lee" });
    const history = [
      raw({ id: "7", sortKey: "17", type: "TEXT", text: "mine", senderID: SELF, isSender: true, reactions: [{ reactionKey: "👏", participantID: THEM, emoji: true }] }),
      raw({ id: "8", sortKey: "18", type: "TEXT", text: "mine too", senderID: SELF, isSender: true, reactions: [{ reactionKey: "❤️", participantID: SELF, emoji: true }] }),
    ];
    expect(previewFromHistory(p, history, { selfIDs: new Set([SELF]) })).toMatchObject({ type: "REACTION", text: "👏", replyToMessageID: "7", isSender: false, senderName: "Sam Lee" });
  });

  test("a later message is never the one reacted to; sortKeys compare as numbers of any length", () => {
    const p = bare({ id: "9", sortKey: "99", senderID: SELF, isSender: true });
    const history = [raw({ id: "10", sortKey: "100", type: "TEXT", text: "later", reactions: [{ reactionKey: "👍", participantID: SELF }] })];
    expect(previewFromHistory(p, history)).toBeNull();
  });

  test("the same message in history: a photo, an unsent message", () => {
    const photo = raw({ id: "20", sortKey: "20", type: "IMAGE", attachments: [{ type: "img", srcURL: "mxc://beeper.local/photo", mimeType: "image/jpeg" }] });
    const seen: string[] = [];
    const out = previewFromHistory(bare({ id: "20", sortKey: "20" }), [photo], { onAsset: (u) => seen.push(u) })!;
    expect(out.type).toBe("IMAGE");
    expect(out.attachments?.[0]?.type).toBe("img");
    expect(seen).toEqual(["mxc://beeper.local/photo"]);
    expect(previewFromHistory(bare({ id: "21", sortKey: "21" }), [raw({ id: "21", sortKey: "21", type: "TEXT", isDeleted: true })])).toMatchObject({ isDeleted: true });
  });

  test("the same message keeps the sender the list named; names and numbers seen elsewhere name it too", () => {
    const BIG = "@whatsapp_lid-77:beeper.local";
    // The list named the sender from the chat's people; history gives only the ID.
    const listed = bare({ id: "40", sortKey: "40", senderID: BIG, senderName: "Ana Ruiz" });
    const attachments = [{ type: "img", srcURL: "mxc://beeper.local/p40", mimeType: "image/jpeg" }];
    const photo = raw({ id: "40", sortKey: "40", senderID: BIG, senderName: BIG, type: "IMAGE", attachments });
    expect(previewFromHistory(listed, [photo])).toMatchObject({ type: "IMAGE", senderName: "Ana Ruiz" });
    // Named only in another chat (the names learnt across chats).
    const unnamed = bare({ id: "41", sortKey: "41", senderID: BIG });
    expect(previewFromHistory(unnamed, [{ ...photo, id: "41", sortKey: "41" }], { names: new Map([[BIG, "Ana Ruiz"]]) })).toMatchObject({ senderName: "Ana Ruiz" });
    // The owner's message from another of the owner's numbers.
    const own = raw({ id: "42", sortKey: "42", senderID: "imsg##participant:x", senderName: "+1 (415) 555-0100", type: "IMAGE", attachments });
    expect(previewFromHistory(bare({ id: "42", sortKey: "42", senderID: "imsg##participant:x" }), [own], { selfAddresses: new Set(["4155550100"]) })?.isSender).toBe(true);
  });

  test("nothing that says: null (the row then says 'Message')", () => {
    expect(previewFromHistory(bare({ id: "30", sortKey: "30" }), [raw({ id: "29", sortKey: "29", type: "TEXT", text: "hi" })])).toBeNull();
    expect(previewFromHistory(bare({ id: "30", sortKey: "30" }), [raw({ id: "30", sortKey: "30", isHidden: true })])).toBeNull();
    expect(previewFromHistory(bare({ id: "30", sortKey: "30" }), ["junk", null, 3])).toBeNull();
  });

  test("the same message in history, visible but with nothing to show (a call, a poll): not a reaction to an older one", () => {
    const history = [
      raw({ id: "10", sortKey: "10", type: "TEXT", text: "weeks ago", reactions: [{ reactionKey: "👍", participantID: THEM }] }),
      raw({ id: "50", sortKey: "50", type: "CALL_OR_WHATEVER" }),
    ];
    expect(previewFromHistory(bare({ id: "50", sortKey: "50", senderName: "Sam" }), history)).toBeNull();
    // Hidden there, it is the reaction event history leaves out: the guess still runs.
    history[1] = raw({ id: "50", sortKey: "50", isHidden: true });
    expect(previewFromHistory(bare({ id: "50", sortKey: "50" }), history)).toMatchObject({ type: "REACTION", text: "👍", replyToMessageID: "10" });
  });

  test("a preview with something to show is not bare", () => {
    expect(isBarePreview(bare({ id: "1", sortKey: "1", text: "hi" }))).toBe(false);
    expect(isBarePreview(bare({ id: "1", sortKey: "1", type: "REACTION" }))).toBe(false);
    expect(isBarePreview(bare({ id: "1", sortKey: "1", isDeleted: true }))).toBe(false);
    expect(isBarePreview(null)).toBe(false);
  });
});

describe("the filler", () => {
  const row = (preview: MessageItem, id = "!c:beeper.local") => ({ value: { id, preview } as ChatSummary, urls: [] as string[] });
  test("waits only so long; a late answer is remembered for the next list, not written into rows already sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reads = 0;
    const f = createPreviewFiller({
      waitMs: 20,
      history: async () => {
        reads++;
        await gate;
        return [raw({ id: "2", sortKey: "2", type: "TEXT", text: "x", reactions: [{ reactionKey: "👍", participantID: THEM }] })];
      },
    });
    const first = row(bare({ id: "3", sortKey: "3" }));
    await f.fill([first]);
    expect(first.value.preview!.type).toBe("UNKNOWN");
    release();
    await Bun.sleep(5);
    expect(first.value.preview!.type).toBe("UNKNOWN");
    const second = row(bare({ id: "3", sortKey: "3" }));
    await f.fill([second]);
    expect(second.value.preview).toMatchObject({ type: "REACTION", text: "👍" });
    expect(reads).toBe(1);
  });
  test("a failed read is not remembered", async () => {
    let n = 0;
    const f = createPreviewFiller({ history: async () => (n++ === 0 ? null : []) });
    await f.fill([row(bare({ id: "3", sortKey: "3" }))]);
    await f.fill([row(bare({ id: "3", sortKey: "3" }))]);
    await f.fill([row(bare({ id: "3", sortKey: "3" }))]);
    expect(n).toBe(2);
  });
});

describe("list_chats and unread_summary against the fake Beeper", () => {
  let fb: FakeBeeper;
  beforeAll(async () => {
    fb = await startFakeBeeper();
  });
  afterAll(() => fb.stop());
  afterEach(() => fb.reset());

  const newest = () => Math.max(...fb.state.chatList().map((c) => Date.parse(c.lastActivity ?? "1970-01-01T00:00:00Z")));
  /** The chat's last event becomes a hidden reaction by `who` (the owner or someone else) on the newest message someone else sent. */
  function reactLast(chatID: string, who: "self" | "other", key: string) {
    const c = fb.state.chats.get(chatID)!;
    const self = c.participants.items.find((p) => p.isSelf)!;
    const other = c.participants.items.find((p) => !p.isSelf)!;
    const msgs = fb.state.messagesOf(chatID);
    const reactor = who === "self" ? self : other;
    // The fixture's own reactions by them would be newer guesses: this is their only one.
    for (const m of msgs) m.reactions = m.reactions?.filter((r) => r.participantID !== reactor.id);
    const target = [...msgs].reverse().find((m) => m.senderID !== reactor.id && !m.isHidden && m.type !== "REACTION")!;
    target.reactions = [...(target.reactions ?? []), { id: `rx-${chatID}`, reactionKey: key, participantID: reactor.id, emoji: true }];
    const at = new Date(newest() + 60_000).toISOString();
    const last = msgs[msgs.length - 1]!;
    const hidden: BMessage = { id: `hx-${last.id}`, chatID, accountID: c.accountID, senderID: reactor.id, ...(who === "other" ? { senderName: reactor.fullName } : {}), timestamp: at, sortKey: String(Number(last.sortKey) + 1), isSender: who === "self", isHidden: true };
    msgs.push(hidden);
    c.lastActivity = at;
    return { c, target, hidden };
  }
  const historyReads = () => fb.state.calls.filter((x) => x.route === "GET /v1/chats/{chatID}/messages").length;
  const make = (assets?: AssetAllowlist) => createActions(createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 }), { assets });
  const find = async (a: ReturnType<typeof make>, id: string) => {
    const r = await a.list_chats({ limit: 10 });
    if (!r.ok) throw new Error(r.error.code);
    return r.data.items.find((c) => c.id === id)!;
  };

  test("the owner's reaction: REACTION with its key, on the message it was for", async () => {
    const { target, hidden } = reactLast(CHAT_IDS.bigGroup, "self", "🙏");
    const c = await find(make(), CHAT_IDS.bigGroup);
    expect(c.preview).toMatchObject({ id: hidden.id, type: "REACTION", text: "🙏", isSender: true, replyToMessageID: target.id });
  });

  test("someone else's reaction keeps who; read once, then remembered", async () => {
    const { c: chat, target } = reactLast("!linkedin_2001:beeper.local", "other", "👏");
    const a = make();
    const c = await find(a, chat.id);
    expect(c.preview).toMatchObject({ type: "REACTION", text: "👏", isSender: false, replyToMessageID: target.id });
    expect(c.preview!.senderName).toBeTruthy();
    const reads = historyReads();
    expect(reads).toBeGreaterThan(0);
    await find(a, chat.id);
    expect(historyReads()).toBe(reads);
  });

  test("a photo whose preview came bare: the photo, its picture allowed for get_media", async () => {
    const chat = fb.state.chats.get(CHAT_IDS.media)!;
    chat.lastActivity = new Date(newest() + 60_000).toISOString();
    const last = fb.state.lastMessage(CHAT_IDS.media)!;
    fb.controls.barePreviewChats = [CHAT_IDS.media];
    const assets = new AssetAllowlist();
    const c = await find(make(assets), CHAT_IDS.media);
    expect(c.preview!.id).toBe(last.id);
    expect(c.preview!.type).toBe(last.type as MessageItem["type"]);
    expect(c.preview!.attachments?.length).toBe(1);
    const url = c.preview!.attachments![0]!.url;
    if (url) expect(assets.has(url)).toBe(true);
  });

  test("an unsent message whose preview came bare: deleted", async () => {
    const chat = fb.state.chats.get(CHAT_IDS.readOnly)!;
    chat.lastActivity = new Date(newest() + 60_000).toISOString();
    const last = fb.state.lastMessage(chat.id)!;
    last.isDeleted = true;
    delete last.text;
    fb.controls.barePreviewChats = [chat.id];
    expect((await find(make(), chat.id)).preview).toMatchObject({ id: last.id, isDeleted: true });
  });

  test("unread_summary fills them too", async () => {
    const { c: chat } = reactLast(CHAT_IDS.muted, "other", "😂");
    const r = await make().unread_summary({ limit: 50 });
    if (!r.ok) throw new Error(r.error.code);
    expect(r.data.items.find((c) => c.id === chat.id)!.preview).toMatchObject({ type: "REACTION", text: "😂" });
  });

  test("a chat whose previews say what they are reads no history", async () => {
    await find(make(), CHAT_IDS.bigGroup);
    expect(historyReads()).toBe(0);
  });
});
