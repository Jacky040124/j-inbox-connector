// Every action on Gmail chats, end to end through the connector's own dispatcher, against
// fake-google (OAuth + Gmail) and fake-beeper, with access tokens refreshed through a fake of the
// cloud's /google/token proxy (production cloudTokenRefresher).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FAKE_GOOGLE_CLIENT, OTHER_EMAIL, OWNER_EMAIL, PDF_BYTES, PNG_BYTES, THREADS, decodeHeader, startFakeGoogle, type RunningFakeGoogle } from "@j-inbox/fake-google";
import { startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { gmailAvatarURL, parseActionResult, parseGmailAvatarURL, type ActionName, type ChatSummary, type EventFrame, type MessageItem } from "@j-inbox/protocol";
import { createActions, createWriteDedupe } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";
import { createBeeperClient } from "../src/beeper-client.ts";
import { createDispatcher, type DispatchResult } from "../src/dispatcher.ts";
import { cloudTokenRefresher } from "../src/gmail/client.ts";
import { createGmailService } from "../src/gmail/service.ts";
import { MemorySecretStore } from "../src/secrets.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const DEVICE_TOKEN = "jid_" + "A".repeat(43);
const ACC = `gmail:${OWNER_EMAIL}`;
const chat = (name: keyof typeof THREADS) => `gmail:${OWNER_EMAIL}:${THREADS[name]}`;

let fb: FakeBeeper;
let fg: RunningFakeGoogle;
let cloud: FakeCloud;

beforeAll(async () => {
  fb = await startFakeBeeper();
  fg = await startFakeGoogle();
  cloud = await startFakeCloud({ google: { url: fg.url, clientId: FAKE_GOOGLE_CLIENT.id, clientSecret: FAKE_GOOGLE_CLIENT.secret } });
});
afterAll(() => {
  fb.stop();
  fg.stop();
  cloud.stop();
});
beforeEach(() => {
  fb.reset();
  fg.google.reset();
});

// Sender pictures in tests never touch the network: a stub that knows one address.
const avatarLookups: string[] = [];
const stubAvatars = {
  resolve: async (sender: string) => (avatarLookups.push(sender), sender === "alice@example.com" ? { mimeType: "image/png", bytes: PNG_BYTES } : null),
};

async function make(o: { accounts?: string[]; scan?: { maxPages?: number; budgetMs?: number } } = {}) {
  const secrets = new MemorySecretStore();
  const life: string[] = [];
  const gmail = createGmailService({ secrets, refresh: cloudTokenRefresher({ cloudURL: cloud.url, deviceToken: DEVICE_TOKEN }), gmailURL: fg.url, oauthURL: fg.url, scan: o.scan, onLifecycle: (e) => life.push(e) });
  const tokens: Record<string, string> = {};
  for (const e of o.accounts ?? [OWNER_EMAIL]) await gmail.accounts.add(e, (tokens[e] = fg.google.issueRefreshToken(e)));
  const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 });
  const assets = new AssetAllowlist();
  const idempotency = createWriteDedupe();
  const d = createDispatcher({ actions: createActions(client, { assets, idempotency, connectorVersion: "0.1.0" }), client, assets, gmail, idempotency, avatars: stubAvatars });
  async function call<A extends ActionName>(action: A, params: unknown): Promise<any> {
    const r = await d.dispatch(action, params);
    if (r.kind !== "res") throw new Error("media");
    if (r.ok) {
      const v = parseActionResult(action, r.data);
      if (!v.ok) throw new Error(`invalid ${action} result: ${JSON.stringify(v.issues)}`);
    }
    return r;
  }
  const ok = async <A extends ActionName>(action: A, params: unknown): Promise<any> => {
    const r = await call(action, params);
    if (!r.ok) throw new Error(`${action}: ${r.error.code} ${r.error.message}`);
    return r.data;
  };
  return { d, gmail, secrets, assets, call, ok, tokens, life };
}

const box = () => fg.google.mailbox(OWNER_EMAIL);
const labelsOf = (threadId: string) => new Set(box().thread(threadId).flatMap((m) => m.labelIds));

describe("reading Gmail", () => {
  test("status lists the Gmail account and the Gmail network next to Beeper's", async () => {
    const t = await make();
    const s = await t.ok("status", {});
    expect(s.accounts).toContainEqual({ accountID: ACC, network: "Gmail", status: "connected", name: OWNER_EMAIL, removable: true });
    expect(s.networks).toContain("Gmail");
    expect(s.networks).toContain("WhatsApp");
  });

  test("list_chats network Gmail: threads as chats, primary inbox only, newest first, previews as text", async () => {
    const t = await make();
    const page = await t.ok("list_chats", { network: "Gmail", inbox: "primary", limit: 50 });
    const ids = page.items.map((c: ChatSummary) => c.id);
    expect(ids).toContain(chat("lunch"));
    for (const n of ["promo", "social", "archived", "sentOnly"] as const) expect(ids).not.toContain(chat(n));
    const lunch = page.items.find((c: ChatSummary) => c.id === chat("lunch"))!;
    expect(lunch).toMatchObject({ accountID: ACC, network: "Gmail", title: "Lunch on Friday?", type: "single", unreadCount: 1, isArchived: false, isLowPriority: false });
    expect(lunch.preview.text).toBe("Great, I'll book a table for two.");
    expect(lunch.preview.email.from).toEqual({ name: "Alice Chen", address: "alice@example.com" });
    const times = page.items.map((c: ChatSummary) => Date.parse(c.lastActivity!));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const kickoff = page.items.find((c: ChatSummary) => c.id === chat("kickoff"))!;
    expect(kickoff.type).toBe("group");
    expect(page.items.find((c: ChatSummary) => c.id === chat("noSubject"))!.title).toBe("(no subject)");
    expect(page.items.find((c: ChatSummary) => c.id === chat("encoded"))!.title).toBe("Grüße aus Zürich 🇨🇭 und mehr");
    expect(page.items.find((c: ChatSummary) => c.id === chat("draft"))!.hasDraft).toBe(true);
  });

  test("Primary is Gmail's own category:primary: Updates mail Gmail shows in Primary is in the primary inbox, unread list and summary", async () => {
    const t = await make();
    const primary = (await t.ok("list_chats", { network: "Gmail", inbox: "primary" })).items;
    const nl = primary.find((c: ChatSummary) => c.id === chat("newsletter"));
    expect(nl).toBeDefined();
    expect(nl.isLowPriority).toBe(false);
    const unread = (await t.ok("list_chats", { network: "Gmail", inbox: "primary", unreadOnly: true })).items.map((c: ChatSummary) => c.id);
    expect(unread).toContain(chat("newsletter"));
    expect(unread).not.toContain(chat("promo"));
    const low = (await t.ok("list_chats", { network: "Gmail", inbox: "low-priority" })).items;
    expect(low.map((c: ChatSummary) => c.id)).not.toContain(chat("newsletter"));
    expect(low.every((c: ChatSummary) => c.isLowPriority === true)).toBe(true);
    const summary = await t.ok("unread_summary", {});
    expect(summary.items.map((c: ChatSummary) => c.id)).toContain(chat("newsletter"));
  });

  test("sender pictures: each email from someone else has senderAvatarURL, the chat the newest other sender's; get_media serves it or answers NOT_FOUND", async () => {
    const t = await make();
    const page = await t.ok("read_chat", { chatID: chat("lunch") });
    const mine = page.items.filter((m: any) => m.isSender);
    const theirs = page.items.filter((m: any) => !m.isSender);
    expect(mine.length).toBeGreaterThan(0);
    for (const m of mine) expect(m.senderAvatarURL).toBeUndefined();
    for (const m of theirs) expect(parseGmailAvatarURL(m.senderAvatarURL)).toEqual({ email: OWNER_EMAIL, sender: m.email.from.address.toLowerCase() });
    expect(parseGmailAvatarURL(page.chat.avatarURL)?.sender).toBe("alice@example.com");
    const media = await t.d.dispatch("get_media", { url: page.chat.avatarURL });
    expect(media.kind).toBe("media");
    if (media.kind === "media") expect(media.head.mimeType).toBe("image/png");
    // A sender without a picture: NOT_FOUND (the web shows initials).
    const other = gmailAvatarURL(OWNER_EMAIL, "nobody@example.org");
    t.assets.add(other);
    const none = await t.d.dispatch("get_media", { url: other });
    expect(none.kind === "res" && !none.ok && none.error.code).toBe("NOT_FOUND");
    // Only URLs this connector handed out.
    const forged = gmailAvatarURL(OWNER_EMAIL, "victim@example.net");
    const refused = await t.d.dispatch("get_media", { url: forged });
    expect(refused.kind === "res" && !refused.ok && refused.error.code).toBe("NOT_ALLOWED");
    expect(avatarLookups).not.toContain("victim@example.net");
  });

  test("the other inboxes and filters", async () => {
    const t = await make();
    const low = (await t.ok("list_chats", { network: "Gmail", inbox: "low-priority" })).items.map((c: ChatSummary) => c.id);
    expect(low).toContain(chat("promo"));
    expect(low).toContain(chat("social"));
    expect(low).not.toContain(chat("lunch"));
    const archive = (await t.ok("list_chats", { network: "Gmail", inbox: "archive" })).items.map((c: ChatSummary) => c.id);
    expect(archive).toContain(chat("archived"));
    expect(archive).toContain(chat("sentOnly"));
    expect(archive).not.toContain(chat("lunch"));
    const starred = (await t.ok("list_chats", { network: "Gmail", pinnedOnly: true })).items.map((c: ChatSummary) => c.id);
    expect(starred).toEqual([chat("starred")]);
    const unread = (await t.ok("list_chats", { accountIDs: [ACC], unreadOnly: true, inbox: "primary" })).items;
    expect(unread.every((c: ChatSummary) => c.unreadCount > 0)).toBe(true);
    expect(unread.map((c: ChatSummary) => c.id)).toContain(chat("cjk"));
    const q = (await t.ok("list_chats", { network: "gmail", query: "lunch" })).items.map((c: ChatSummary) => c.id);
    expect(q).toEqual([chat("lunch")]);
    const groups = (await t.ok("list_chats", { network: "Gmail", type: "group" })).items;
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((c: ChatSummary) => c.type === "group")).toBe(true);
  });

  test("read_chat: messages oldest first with email headers; drafts never leave the Mac", async () => {
    const t = await make();
    const r = await t.ok("read_chat", { chatID: chat("lunch") });
    expect(r.items.map((m: MessageItem) => m.isSender)).toEqual([false, true, false]);
    expect(r.items[0]).toMatchObject({ chatID: chat("lunch"), accountID: ACC, senderID: "alice@example.com", senderName: "Alice Chen", type: "TEXT" });
    expect(r.items[0].text).toBe("Hi! Are we still on for lunch on Friday?\nThe usual place at 12:30.");
    expect(r.items[0].email).toEqual({ subject: "Lunch on Friday?", from: { name: "Alice Chen", address: "alice@example.com" }, to: [{ name: "Jacky Owner", address: OWNER_EMAIL }], cc: [] });
    const draft = await t.ok("read_chat", { chatID: chat("draft") });
    expect(draft.items).toHaveLength(1);
    expect(JSON.stringify(draft)).not.toContain("Thursday is");
    expect(draft.chat.hasDraft).toBe(true);
  });

  test("HTML-only, RFC 2047 + Latin-1, CJK and hostile mail come out as plain text", async () => {
    const t = await make();
    const html = (await t.ok("read_chat", { chatID: chat("html") })).items[0];
    expect(html.text).toContain("Hello & welcome,");
    expect(html.text).toContain("full report (https://example.net/report?a=1&b=2)");
    expect(html.text).toContain("• 3 new comments");
    expect(html.text).not.toMatch(/<|alert|color:red/);
    const enc = (await t.ok("read_chat", { chatID: chat("encoded") })).items[0];
    expect(enc.text).toBe("Liebe Grüße aus Zürich, à bientôt !");
    expect(enc.senderName).toBe("Jürgen Groß");
    expect((await t.ok("read_chat", { chatID: chat("cjk") })).chat.title).toBe("周五一起吃饭吗？🍜");
    const hostile = await t.ok("read_chat", { chatID: chat("hostile") });
    expect(hostile.items[0].textTruncated).toBe(true);
    expect(hostile.items[0].text.length).toBeLessThanOrEqual(20_000);
    expect(hostile.chat.title).not.toMatch(/[\r\n]/);
  });

  test("read_chat pages a 45-message thread to its start without duplicates; foreign cursors are refused", async () => {
    const t = await make();
    const p1 = await t.ok("read_chat", { chatID: chat("long"), limit: 30 });
    expect(p1.items).toHaveLength(30);
    expect(p1.items.at(-1).text).toBe("Message 45 of 45");
    expect(p1.hasMore).toBe(true);
    const p2 = await t.ok("read_chat", { chatID: chat("long"), limit: 30, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(15);
    expect(p2.items[0].text).toBe("Message 1 of 45");
    expect(p2.hasMore).toBe(false);
    expect(new Set([...p1.items, ...p2.items].map((m: MessageItem) => m.id)).size).toBe(45);
    const bad = await t.call("read_chat", { chatID: chat("lunch"), cursor: p1.nextCursor });
    expect(bad.error.code).toBe("BAD_PARAMS");
    const unknown = await t.call("read_chat", { chatID: `gmail:${OWNER_EMAIL}:ffffffffffffffff` });
    expect(unknown.error.code).toBe("NOT_FOUND");
    const otherAccount = await t.call("read_chat", { chatID: `gmail:nobody@example.com:${THREADS.lunch}` });
    expect(otherAccount.error.code).toBe("NOT_FOUND");
  });

  test("attachments: gmail:// URLs from results only, bytes and type from Gmail", async () => {
    const t = await make();
    const msg = (await t.ok("read_chat", { chatID: chat("attachments") })).items[0];
    const pdf = msg.attachments.find((a: any) => a.fileName === "invoice.pdf");
    const png = msg.attachments.find((a: any) => a.fileName === "photo.png");
    expect(pdf).toMatchObject({ type: "unknown", mimeType: "application/pdf", fileSize: PDF_BYTES.length });
    expect(png.type).toBe("img");
    expect(pdf.url).toMatch(/^gmail:\/\/owner%40example\.com\//);
    const read = async (url: string) => {
      const r: DispatchResult = await t.d.dispatch("get_media", { url });
      if (r.kind !== "media") return r;
      const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
      return { head: r.head, bytes };
    };
    const a = (await read(pdf.url)) as any;
    expect(a.head).toEqual({ mimeType: "application/pdf", size: PDF_BYTES.length, fileName: "invoice.pdf" });
    expect(a.bytes).toEqual(PDF_BYTES);
    expect(((await read(png.url)) as any).bytes).toEqual(PNG_BYTES);
    // A well-formed URL this connector never returned is refused before Gmail is asked.
    const before = fg.google.requests.length;
    const forged = pdf.url.replace(/\/[^/]+$/, "/ANGjdJforged");
    const f = (await read(forged)) as any;
    expect(f.ok === false && f.error.code).toBe("NOT_ALLOWED");
    expect(fg.google.requests.length).toBe(before);
  });
});

describe("writing Gmail", () => {
  test("mark_read and mark unread, archive and unarchive change Gmail's labels", async () => {
    const t = await make();
    expect(labelsOf(THREADS.lunch).has("UNREAD")).toBe(true);
    expect(await t.ok("mark_read", { chatID: chat("lunch") })).toEqual({ chatID: chat("lunch"), read: true });
    expect(labelsOf(THREADS.lunch).has("UNREAD")).toBe(false);
    await t.ok("mark_read", { chatID: chat("lunch"), read: false });
    expect(labelsOf(THREADS.lunch).has("UNREAD")).toBe(true);
    expect(await t.ok("archive", { chatID: chat("lunch") })).toEqual({ chatID: chat("lunch"), archived: true });
    expect(labelsOf(THREADS.lunch).has("INBOX")).toBe(false);
    await t.ok("archive", { chatID: chat("lunch"), archived: false });
    expect(labelsOf(THREADS.lunch).has("INBOX")).toBe(true);
    // Read up to one message only.
    const k = (await t.ok("read_chat", { chatID: chat("kickoff") })).items;
    await t.ok("mark_read", { chatID: chat("kickoff"), messageID: k[0].id });
    expect(box().thread(THREADS.kickoff).map((m) => m.labelIds.includes("UNREAD"))).toEqual([false, true]);
  });

  test("send_message is a reply-all in the thread: recipients, subject, threading headers, UTF-8 body", async () => {
    const t = await make();
    const r = await t.ok("send_message", { chatID: chat("kickoff"), text: "Sounds good — see you Monday 👋" });
    expect(r.chatID).toBe(chat("kickoff"));
    const sent = fg.google.sent().at(-1)!;
    // Gmail filed it into the thread: the subject and References/In-Reply-To were right.
    expect(sent.threadId).toBe(THREADS.kickoff);
    expect(r.pendingMessageID).toBe(sent.id);
    const h = (n: string) => sent.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    // Replying to Carol's message (the newest): Carol + her To (Bob; the owner removed), her Cc.
    expect(decodeHeader(h("to"))).toBe("Carol <carol@example.com>, Bob Builder <bob@example.com>");
    expect(h("cc")).toBe("dave@example.com");
    expect(h("from")).toBe(OWNER_EMAIL);
    expect(h("subject")).toBe("Re: Project kickoff");
    const thread = box().thread(THREADS.kickoff);
    const carolId = thread[1]!.payload.headers.find((x) => x.name === "Message-ID")!.value;
    const bobId = thread[0]!.payload.headers.find((x) => x.name === "Message-ID")!.value;
    expect(h("in-reply-to")).toBe(carolId);
    expect(h("references")).toBe(`${bobId} ${carolId}`);
    expect(sent.contentType).toBe("text/plain; charset=UTF-8");
    expect(sent.transferEncoding).toBe("base64");
    expect(sent.text).toBe("Sounds good — see you Monday 👋");
  });

  test("send_message replying to an older message, and to the owner's own message", async () => {
    const t = await make();
    const lunch = (await t.ok("read_chat", { chatID: chat("lunch") })).items;
    await t.ok("send_message", { chatID: chat("lunch"), text: "x", replyToMessageID: lunch[1].id });
    const s = fg.google.sent().at(-1)!;
    // The owner's own message: to its recipients again.
    expect(s.headers.find((x) => x.name === "To")!.value).toBe("Alice Chen <alice@example.com>");
    expect(s.threadId).toBe(THREADS.lunch);
    await t.ok("send_message", { chatID: chat("sentOnly"), text: "Any news?" });
    const s2 = fg.google.sent().at(-1)!;
    expect(s2.headers.find((x) => x.name === "To")!.value).toBe("Kim <kim@example.com>");
    expect(s2.headers.find((x) => x.name === "Subject")!.value).toBe("Re: Question about the lease");
    expect(s2.threadId).toBe(THREADS.sentOnly);
  });

  test("send_message with an idempotency key sends once; the same key with other text is CONFLICT", async () => {
    const t = await make();
    const p = { chatID: chat("lunch"), text: "once", idempotencyKey: "idem-gmail-0001" };
    const [a, b] = await Promise.all([t.ok("send_message", p), t.ok("send_message", p)]);
    expect(a).toEqual(b);
    expect(await t.ok("send_message", p)).toEqual(a);
    expect(fg.google.sent()).toHaveLength(1);
    expect((await t.call("send_message", { ...p, text: "other" })).error.code).toBe("CONFLICT");
    expect(fg.google.sent()).toHaveLength(1);
  });

  test("draft_reply makes a reply-all draft in the thread; never on a thread that has one", async () => {
    const t = await make();
    expect(await t.ok("draft_reply", { chatID: chat("lunch"), text: "Maybe 13:00?" })).toEqual({ chatID: chat("lunch"), draftSet: true });
    const d = fg.google.drafts().at(-1)!;
    expect(d.threadId).toBe(THREADS.lunch);
    expect(d.text).toBe("Maybe 13:00?");
    expect((await t.call("draft_reply", { chatID: chat("draft"), text: "x" })).error.code).toBe("CONFLICT");
    expect((await t.call("draft_reply", { chatID: chat("lunch"), text: "again" })).error.code).toBe("CONFLICT");
    expect(fg.google.sent()).toHaveLength(0);
  });

  test("compose_email starts a new thread; idempotent; unknown accounts are NOT_FOUND", async () => {
    const t = await make();
    const p = { accountID: ACC, to: ["alice@example.com", "bob@example.com"], cc: ["carol@example.com"], subject: "Plan für Freitag ✨", text: "Hi all,\nhere is the plan.", idempotencyKey: "idem-compose-01" };
    const r = await t.ok("compose_email", p);
    const sent = fg.google.sent().at(-1)!;
    expect(r).toEqual({ accountID: ACC, chatID: `gmail:${OWNER_EMAIL}:${sent.threadId}`, pendingMessageID: sent.id });
    expect(sent.threadId).toBe(sent.id);
    const h = (n: string) => sent.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    expect(h("to")).toBe("alice@example.com, bob@example.com");
    expect(h("cc")).toBe("carol@example.com");
    expect(decodeHeader(h("subject"))).toBe("Plan für Freitag ✨");
    expect(h("in-reply-to")).toBe("");
    expect(sent.text).toBe("Hi all,\r\nhere is the plan.");
    expect(await t.ok("compose_email", p)).toEqual(r);
    expect(fg.google.sent()).toHaveLength(1);
    expect((await t.call("compose_email", { ...p, accountID: "gmail:nobody@example.com", idempotencyKey: undefined })).error.code).toBe("NOT_FOUND");
    expect((await t.call("compose_email", { ...p, accountID: "whatsapp", idempotencyKey: undefined })).error.code).toBe("NOT_FOUND");
    // The new thread reads back like any other.
    const back = await t.ok("read_chat", { chatID: r.chatID });
    expect(back.chat.title).toBe("Plan für Freitag ✨");
    expect(back.items[0].isSender).toBe(true);
  });

  test("react on email is NOT_SUPPORTED and nothing reaches Gmail", async () => {
    const t = await make();
    const before = fg.google.requests.length;
    expect((await t.call("react", { chatID: chat("lunch"), messageID: THREADS.lunch, reactionKey: "👍" })).error.code).toBe("NOT_SUPPORTED");
    expect(fg.google.requests.length).toBe(before);
  });

  test("Gmail failures map to protocol codes: a failed read is UPSTREAM_DOWN, a send whose answer was lost is UNKNOWN_OUTCOME", async () => {
    const t = await make();
    await t.ok("status", {});
    fg.google.failNext({ path: "/gmail/v1/users/me/threads/", status: 503 });
    expect((await t.call("read_chat", { chatID: chat("lunch") })).error.code).toBe("UPSTREAM_DOWN");
    fg.google.failNext({ path: "/gmail/v1/users/me/messages/send", status: 500 });
    expect((await t.call("send_message", { chatID: chat("lunch"), text: "x" })).error.code).toBe("UNKNOWN_OUTCOME");
    fg.google.failNext({ path: "/gmail/v1/users/me/messages/send", status: 429 });
    expect((await t.call("send_message", { chatID: chat("lunch"), text: "x" })).error.code).toBe("RATE_LIMITED");
  });
});

describe("mixed lists", () => {
  async function walk(t: Awaited<ReturnType<typeof make>>, params: Record<string, unknown>, limit: number) {
    const out: ChatSummary[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 200; i++) {
      const p = await t.ok("list_chats", { ...params, limit, ...(cursor ? { cursor } : {}) });
      out.push(...p.items);
      if (!p.hasMore) return out;
      cursor = p.nextCursor;
    }
    throw new Error("did not finish");
  }

  for (const limit of [7, 25]) {
    test(`list_chats with no filter pages Beeper and Gmail together, newest first, every chat once (limit ${limit})`, async () => {
      const t = await make();
      const beeper = await walk(t, { network: "WhatsApp" }, 50);
      const all = await walk(t, {}, limit);
      const ids = all.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      const gmailIDs = ids.filter((id) => id.startsWith("gmail:"));
      expect(gmailIDs.length).toBe(box().threadIds().length);
      expect(ids.filter((id) => !id.startsWith("gmail:")).length).toBeGreaterThan(beeper.length);
      // Both sources interleave (not one block after the other).
      const firstGmail = ids.findIndex((id) => id.startsWith("gmail:"));
      const lastBeeper = ids.length - 1 - [...ids].reverse().findIndex((id) => !id.startsWith("gmail:"));
      expect(firstGmail).toBeLessThan(lastBeeper);
      const times = all.map((c) => (c.lastActivity ? Date.parse(c.lastActivity) : 0));
      for (let i = 1; i < times.length; i++) expect(times[i]!).toBeLessThanOrEqual(times[i - 1]!);
      // The same as listing each source alone.
      const beeperAll = await walk(t, { accountIDs: [...new Set(all.filter((c) => !c.id.startsWith("gmail:")).map((c) => c.accountID))] }, 50);
      expect(ids.filter((id) => !id.startsWith("gmail:")).sort()).toEqual(beeperAll.map((c) => c.id).sort());
    });
  }

  test("primary inbox merged: no archived or low-priority chats from either source", async () => {
    const t = await make();
    const all = await walk(t, { inbox: "primary" }, 10);
    expect(all.some((c) => c.id.startsWith("gmail:"))).toBe(true);
    expect(all.some((c) => !c.id.startsWith("gmail:"))).toBe(true);
    expect(all.every((c) => !c.isArchived && !c.isLowPriority)).toBe(true);
  });

  test("with another network only Beeper is asked (its own cursors); a Beeper-only cursor is refused by the merged list", async () => {
    const t = await make();
    const before = fg.google.requests.length;
    const p = await t.ok("list_chats", { network: "WhatsApp", limit: 3 });
    expect(fg.google.requests.length).toBe(before);
    expect(p.nextCursor.startsWith("j2.")).toBe(true);
    expect((await t.call("list_chats", { limit: 3, cursor: p.nextCursor })).error.code).toBe("BAD_PARAMS");
    const g = await t.ok("list_chats", { network: "Gmail", limit: 3 });
    expect(g.items.every((c: ChatSummary) => c.network === "Gmail")).toBe(true);
    expect(fb.state.calls.filter((c) => c.route === "GET /v1/chats" || c.route === "GET /v1/chats/search")).toHaveLength(1);
  });

  test("unread_summary adds Gmail's unread primary threads to Beeper's", async () => {
    const t = await make();
    const beeperOnly = await (async () => {
      const t2 = await make({ accounts: [] });
      return t2.ok("unread_summary", {});
    })();
    const s = await t.ok("unread_summary", {});
    const gmailUnread = s.items.filter((c: ChatSummary) => c.network === "Gmail");
    expect(gmailUnread.map((c: ChatSummary) => c.id).sort()).toEqual([chat("lunch"), chat("kickoff"), chat("encoded"), chat("hostile"), chat("cjk"), chat("newsletter")].sort());
    expect(s.totalUnreadChats).toBe(beeperOnly.totalUnreadChats + 6);
    expect(s.totalUnreadMessages).toBe(beeperOnly.totalUnreadMessages + 1 + 2 + 1 + 1 + 1 + 1);
  });

  test("search_messages: Gmail query syntax, merged with Beeper, chats included, filters honoured", async () => {
    const t = await make();
    const r = await t.ok("search_messages", { query: "lunch" });
    const g = r.items.filter((m: MessageItem) => m.chatID.startsWith("gmail:"));
    expect(g.length).toBeGreaterThan(0);
    for (const m of r.items) expect(r.chats[m.chatID]).toBeTruthy();
    const mine = await t.ok("search_messages", { query: "lunch", network: "Gmail", sender: "me" });
    expect(mine.items.every((m: MessageItem) => m.isSender)).toBe(true);
    const inThread = await t.ok("search_messages", { query: "subject:kickoff", chatIDs: [chat("kickoff")] });
    expect(inThread.items.length).toBe(2);
    expect(inThread.items.every((m: MessageItem) => m.chatID === chat("kickoff"))).toBe(true);
    const before = await t.ok("search_messages", { query: "update", network: "Gmail", dateBefore: "2026-10-10T00:00:00Z", limit: 20 });
    expect(before.items.every((m: MessageItem) => Date.parse(m.timestamp) < Date.parse("2026-10-10T00:00:00Z"))).toBe(true);
  });

  test("a Gmail account Google no longer accepts: lists answer with Beeper and name it in failedSources; status says reconnect", async () => {
    const t = await make();
    fg.google.revokeAll(OWNER_EMAIL);
    const merged = await t.ok("list_chats", { inbox: "primary", limit: 10 });
    expect(merged.items.length).toBe(10);
    expect(merged.items.every((c: ChatSummary) => !c.id.startsWith("gmail:"))).toBe(true);
    expect(merged.failedSources).toEqual([{ source: "gmail", accountID: ACC, error: expect.objectContaining({ code: "REAUTH_REQUIRED" }) }]);
    expect((await t.call("list_chats", { network: "Gmail" })).error.code).toBe("REAUTH_REQUIRED");
    expect((await t.call("send_message", { chatID: chat("lunch"), text: "x" })).error.code).toBe("REAUTH_REQUIRED");
    const s = await t.ok("status", {});
    expect(s.accounts.find((a: any) => a.accountID === ACC).status).toBe("reconnect_required");
    expect(t.life).toContain("gmail.reauth");
    const sum = await t.ok("unread_summary", {});
    expect(sum.failedSources[0].accountID).toBe(ACC);
  });

  test("a refused refresh token is not tried again on every call (no hammering of the cloud or Google)", async () => {
    const t = await make();
    fg.google.revokeAll(OWNER_EMAIL);
    const n0 = cloud.googleRefreshes.count;
    for (let i = 0; i < 5; i++) expect((await t.call("list_chats", { network: "Gmail" })).error.code).toBe("REAUTH_REQUIRED");
    expect(cloud.googleRefreshes.count - n0).toBe(1);
    // Adding the account again (a new token) works at once.
    expect(await t.ok("gmail_connect", { email: OWNER_EMAIL, refreshToken: fg.google.issueRefreshToken(OWNER_EMAIL) })).toMatchObject({ connected: true });
    expect((await t.ok("list_chats", { network: "Gmail", limit: 3 })).items).toHaveLength(3);
    expect((await t.ok("status", {})).accounts.find((a: any) => a.accountID === ACC).status).toBe("connected");
  });
});

describe("accounts", () => {
  test("gmail_connect checks the token against the address, stores it in the Keychain, and the account works", async () => {
    const t = await make({ accounts: [] });
    const rt = fg.google.issueRefreshToken(OTHER_EMAIL);
    expect(await t.ok("gmail_connect", { email: "Other@Example.com", refreshToken: rt })).toEqual({ accountID: `gmail:${OTHER_EMAIL}`, connected: true });
    expect(await t.secrets.get(`gmail:${OTHER_EMAIL}`)).toBe(rt);
    expect((await t.ok("list_chats", { network: "Gmail" })).items).toHaveLength(1);
    expect(t.life).toContain("gmail.connected");
  });

  test("gmail_connect refuses a token of another account, or one Google rejects, and stores nothing", async () => {
    const t = await make({ accounts: [] });
    const rt = fg.google.issueRefreshToken(OTHER_EMAIL);
    expect((await t.call("gmail_connect", { email: OWNER_EMAIL, refreshToken: rt })).error.code).toBe("NOT_ALLOWED");
    fg.google.revokeAll(OTHER_EMAIL);
    expect((await t.call("gmail_connect", { email: OTHER_EMAIL, refreshToken: rt })).error.code).toBe("NOT_ALLOWED");
    expect(t.gmail.emails()).toEqual([]);
    expect(await t.secrets.get(`gmail:${OWNER_EMAIL}`)).toBeNull();
    expect(await t.secrets.get(`gmail:${OTHER_EMAIL}`)).toBeNull();
  });

  test("remove_account on Gmail revokes the token at Google and forgets the account", async () => {
    const t = await make();
    const rt = t.tokens[OWNER_EMAIL]!;
    expect(await t.ok("remove_account", { accountID: ACC })).toEqual({ accountID: ACC, removed: true, scope: "all-devices", affectedAccountIDs: [ACC] });
    expect(fg.google.isRevoked(rt)).toBe(true);
    expect(await t.secrets.get(`gmail:${OWNER_EMAIL}`)).toBeNull();
    expect(t.gmail.emails()).toEqual([]);
    expect((await t.ok("status", {})).accounts.some((a: any) => a.accountID === ACC)).toBe(false);
    expect((await t.call("read_chat", { chatID: chat("lunch") })).error.code).toBe("NOT_FOUND");
    expect((await t.call("remove_account", { accountID: ACC })).error.code).toBe("NOT_FOUND");
    expect(t.life).toContain("gmail.removed");
  });

  test("access tokens are cached and refreshed through the cloud only when needed", async () => {
    const t = await make();
    const n0 = cloud.googleRefreshes.count;
    await t.ok("list_chats", { network: "Gmail", limit: 5 });
    await t.ok("read_chat", { chatID: chat("lunch") });
    expect(cloud.googleRefreshes.count - n0).toBe(1);
    // Google expires it early: one refresh, one retry, the read still works.
    fg.google.expireAccessTokens();
    await t.ok("read_chat", { chatID: chat("lunch") });
    expect(cloud.googleRefreshes.count - n0).toBe(2);
  });
});

describe("live updates", () => {
  test("history polling turns new mail and label changes into metadata-only events", async () => {
    const t = await make();
    const events: EventFrame[] = [];
    t.gmail.startPolling((f) => (events.push(f), true));
    try {
      await t.gmail.pollNow();
      expect(events).toEqual([]);
      const m = fg.google.deliver(OWNER_EMAIL, { threadId: THREADS.kickoff, from: "Bob <bob@example.com>", subject: "Re: Project kickoff", text: "secret agenda text" });
      await t.ok("archive", { chatID: chat("lunch") });
      await t.gmail.pollNow();
      expect(events).toContainEqual({ type: "event", kind: "message", op: "upserted", chatID: chat("kickoff"), messageIDs: [m.id], ts: expect.any(String) });
      expect(events).toContainEqual(expect.objectContaining({ kind: "chat", op: "upserted", chatID: chat("kickoff") }));
      expect(events).toContainEqual(expect.objectContaining({ kind: "chat", op: "upserted", chatID: chat("lunch") }));
      expect(JSON.stringify(events)).not.toContain("secret agenda");
      // Drafts are never announced.
      events.length = 0;
      await t.ok("draft_reply", { chatID: chat("kickoff"), text: "draft text" });
      await t.gmail.pollNow();
      expect(events.filter((e) => e.kind === "message")).toEqual([]);
      // History too old: a re-sync announces the newest threads.
      events.length = 0;
      fg.google.deliver(OWNER_EMAIL, { from: "New <new@example.com>", subject: "Brand new", text: "hi" });
      fg.google.expireHistory();
      await t.gmail.pollNow();
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.kind === "chat")).toBe(true);
      events.length = 0;
      await t.gmail.pollNow();
      expect(events).toEqual([]);
    } finally {
      t.gmail.stopPolling();
    }
  });
});
