// Who wrote a message and what kind of line it is (beeper-map.ts "Who wrote a message, and system lines"), checked
// against shapes seen in the owner's real data (2026-11-06 audit), with made-up IDs and 555 numbers: the owner's
// messages from another of the owner's numbers, IDs given as names, Beeper's iMessage event templates, the WhatsApp
// bridge's join and call lines, bridge bots, unnamed senders, and text message threads Beeper lists as iMessage.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { chatSummary, messageItem, parse, parseActionResult } from "@j-inbox/protocol";
import { createActions } from "../src/actions.ts";
import { createBeeperClient } from "../src/beeper-client.ts";
import { chatPeople, mapChat, mapMessage, namesIn, selfAddressesIn, selfIDsIn } from "../src/beeper-map.ts";
import { setContacts } from "../src/contacts.ts";

const GROUP = "imsg##thread:0a1b2c3d4e5f";
const msg = (over: Record<string, unknown> = {}) => ({
  id: "M1",
  chatID: GROUP,
  accountID: "imessage_0a1b",
  senderID: "imsg##participant:aaaa",
  senderName: "Ana",
  timestamp: "2026-07-24T18:35:50.439Z",
  sortKey: "1784918150439",
  text: "hello",
  isSender: false,
  ...over,
});
const wa = (over: Record<string, unknown> = {}) => msg({ chatID: "!wa_group:beeper.local", accountID: "whatsapp.15550100001", senderID: "@whatsapp_lid-1001:beeper.local", type: "TEXT", ...over });
const valid = (m: unknown) => expect(parse(messageItem, m).ok).toBe(true);

afterEach(() => setContacts(new Map()));

describe("the owner's own messages (item 3)", () => {
  test("a sender among the owner's IDs learned in other chats is the owner, though Beeper says isSender false", () => {
    const m = mapMessage(msg({ senderID: "imsg##participant:self2" }), { selfIDs: new Set(["imsg##participant:self2"]) })!;
    expect(m.isSender).toBe(true);
    expect(mapMessage(msg({ senderID: "imsg##participant:self2" }))!.isSender).toBe(false);
  });
  test("a message signed with one of the owner's own numbers is the owner's, however the number is written", () => {
    const selfAddresses = new Set(selfAddressesIn({ accountID: "whatsapp.15550100001", user: { id: "x", phoneNumber: "+15550100001", isSelf: true } }));
    expect([...selfAddresses]).toEqual(["5550100001"]);
    const m = mapMessage(msg({ senderID: "imsg##participant:bd35", senderName: "+1 555-010-0001" }), { selfAddresses })!;
    expect(m.isSender).toBe(true);
    valid(m);
    // Someone else's number stays someone else's.
    expect(mapMessage(msg({ senderName: "+1 555-010-0009" }), { selfAddresses })!.isSender).toBe(false);
  });
  test("the owner's numbers come from participants marked isSelf and accounts; IDs signed with them are learned", () => {
    const chat = { id: GROUP, participants: { items: [{ id: "p1", phoneNumber: "+15550100002", isSelf: true }, { id: "p2", email: "Owner@Example.com" }, { id: "p3", phoneNumber: "+15550100009" }] } };
    const addresses = new Set(selfAddressesIn(chat));
    expect([...addresses]).toEqual(["5550100002"]);
    addresses.add("owner@example.com");
    expect(selfIDsIn(chat, addresses)).toEqual(["p1", "p2"]);
    expect(selfIDsIn(msg({ senderID: "imsg##participant:bd35", senderName: "+1 555 010 0002" }), addresses)).toEqual(["imsg##participant:bd35"]);
  });
});

describe("IDs never shown as names (item 6), names from the chat (items 13 and 15)", () => {
  test("iMessage's own participant ID, or the sender ID itself, as a name is no name", () => {
    expect(mapMessage(msg({ senderName: "imsg##participant:e95f00aa" }))!.senderName).toBeUndefined();
    expect(mapMessage(msg({ senderName: "imsg##participant:aaaa" }))!.senderName).toBeUndefined();
    expect(mapMessage(msg({ senderID: "u123", senderName: "u123" }))!.senderName).toBeUndefined();
    expect(mapMessage(msg({ senderName: "@whatsapp_lid-1:beeper.local" }))!.senderName).toBeUndefined();
  });
  test("an unnamed sender gets the participant's name, else their number as the owner's Contacts name it", () => {
    const chat = { id: GROUP, type: "group", participants: { items: [{ id: "imsg##participant:aaaa", phoneNumber: "+15550201009" }, { id: "imsg##participant:bbbb", fullName: "imsg##participant:bbbb", email: "bo@example.com" }, { id: "u3", fullName: "Cy Ng" }] } };
    const people = chatPeople(chat);
    expect(people.otherName).toBeUndefined();
    expect(mapMessage(msg({ senderName: "imsg##participant:aaaa" }), people)!.senderName).toBe("+15550201009");
    setContacts(new Map([["5550201009", "Dana Example"]]));
    expect(mapMessage(msg({ senderName: "imsg##participant:aaaa" }), chatPeople(chat))!.senderName).toBe("Dana Example");
    expect(mapMessage(msg({ senderID: "imsg##participant:bbbb", senderName: undefined }), people)!.senderName).toBe("bo@example.com");
    expect(mapMessage(msg({ senderID: "u3", senderName: undefined }), people)!.senderName).toBe("Cy Ng");
    // A name Beeper gives stays.
    expect(mapMessage(msg({ senderID: "u3", senderName: "Cyrus" }), people)!.senderName).toBe("Cyrus");
  });
  test("a group's list preview keeps its sender's name when Beeper gives only an ID", () => {
    const raw = {
      id: "!g:beeper.local",
      accountID: "whatsapp.15550100001",
      network: "WhatsApp",
      title: "Builders",
      type: "group",
      participants: { items: [{ id: "@whatsapp_lid-2:beeper.local", fullName: "Teo" }], hasMore: true, total: 140 },
      unreadCount: 1,
      preview: wa({ senderID: "@whatsapp_lid-2:beeper.local", senderName: "@whatsapp_lid-2:beeper.local", text: "see you there" }),
    };
    const c = mapChat(raw)!;
    expect(c.preview!.senderName).toBe("Teo");
    expect(parse(chatSummary, c).ok).toBe(true);
  });
  test("a big group's preview from someone Beeper leaves out of the listed participants takes the name seen elsewhere", () => {
    const raw = {
      id: "!g:beeper.local",
      accountID: "whatsapp.15550100001",
      network: "WhatsApp",
      title: "Builders",
      type: "group",
      participants: { items: [{ id: "@whatsapp_lid-9:beeper.local", fullName: "Nine" }], hasMore: true, total: 142 },
      unreadCount: 1,
      preview: wa({ senderID: "@whatsapp_lid-2:beeper.local", senderName: "@whatsapp_lid-2:beeper.local", text: "see you there" }),
    };
    expect(mapChat(raw)!.preview!.senderName).toBeUndefined();
    // Learned from a message read before, another chat's participants, another chat's preview; never the owner, never an ID.
    const names = new Map([...namesIn(wa({ senderID: "@whatsapp_lid-2:beeper.local", senderName: "Teo" }))]);
    expect(mapChat(raw, { names })!.preview!.senderName).toBe("Teo");
    expect(namesIn({ participants: { items: [{ id: "@a:beeper.local", fullName: "Ana" }, { id: "@b:beeper.local", phoneNumber: "+15550201009" }, { id: "@me:beeper.com", fullName: "Owner", isSelf: true }, { id: "@c:beeper.local", fullName: "@c:beeper.local" }] }, preview: wa({ senderID: "@d:beeper.local", senderName: "Dee" }) })).toEqual([
      ["@a:beeper.local", "Ana"],
      ["@b:beeper.local", "+15550201009"],
      ["@d:beeper.local", "Dee"],
    ]);
    expect(namesIn(wa({ senderID: "@me:beeper.com", senderName: "Owner", isSender: true }))).toEqual([]);
    expect(namesIn(wa({ senderName: "@whatsapp_lid-1001:beeper.local" }))).toEqual([]);
    // The chat's own people come first.
    expect(mapChat({ ...raw, participants: { items: [{ id: "@whatsapp_lid-2:beeper.local", fullName: "Ed" }] } }, { names })!.preview!.senderName).toBe("Ed");
  });
  test("in a one-to-one chat the other person's unnamed messages carry the chat's name; the owner's do not", () => {
    const raw = { id: "!dm:beeper.local", accountID: "whatsapp.15550100001", network: "WhatsApp", title: "Jen", type: "single", participants: { items: [{ id: "@whatsapp_15550100003:beeper.local" }, { id: "@me:beeper.com", fullName: "Owner Test", isSelf: true }] } };
    const people = chatPeople(raw);
    expect(people.otherName).toBe("Jen");
    expect(mapMessage(wa({ senderID: "@whatsapp_15550100003:beeper.local", senderName: undefined }), people)!.senderName).toBe("Jen");
    expect(mapMessage(wa({ senderID: "@me:beeper.com", senderName: undefined, isSender: true }), people)!.senderName).toBeUndefined();
    expect(mapChat({ ...raw, preview: wa({ senderID: "@whatsapp_15550100003:beeper.local", senderName: undefined }) })!.preview!.senderName).toBe("Jen");
  });
});

describe("system lines (items 7 and 14)", () => {
  test("Beeper's iMessage templates become system lines with their people named", () => {
    const added = mapMessage(msg({ text: "{{sender}} added {{+15550201009}} to the conversation" }))!;
    expect(added.type).toBe("NOTICE");
    expect(added.text).toBe("Ana added +15550201009 to the conversation");
    valid(added);
    setContacts(new Map([["5550201009", "Dana Example"]]));
    expect(mapMessage(msg({ text: "{{sender}} removed {{+1 555 020 1009}} from the conversation" }))!.text).toBe("Ana removed Dana Example from the conversation");
    expect(mapMessage(msg({ text: "{{sender}} added {{someone@example.com}} to the conversation" }))!.text).toBe("Ana added someone@example.com to the conversation");
    const own = mapMessage(msg({ text: "{{sender}} unsent a message", isSender: true, senderName: undefined }))!;
    expect([own.type, own.text]).toEqual(["NOTICE", "You unsent a message"]);
    expect(mapMessage(msg({ text: "{{sender}} started sharing location", senderName: undefined }))!.text).toBe("Someone started sharing location");
    // The owner added by number: "you".
    expect(mapMessage(msg({ text: "{{sender}} added {{+15550100001}} to the conversation" }), { selfAddresses: new Set(["5550100001"]) })!.text).toBe("Ana added you to the conversation");
  });
  test("an add Beeper signs with the person added names them once", () => {
    // The owner's real shape: the owner's number as the sender and as the person added.
    const self = { selfAddresses: new Set(["5550100001"]) };
    const own = mapMessage(msg({ senderID: "imsg##participant:bd35", senderName: "+1 555-010-0001", text: "{{sender}} added {{+15550100001}} to the conversation" }), self)!;
    expect([own.type, own.text, own.isSender]).toEqual(["NOTICE", "You were added to the conversation", true]);
    expect(mapMessage(msg({ isSender: true, senderName: undefined, text: "{{sender}} removed {{imsg##participant:self9}} from the conversation" }), { selfIDs: new Set(["imsg##participant:self9"]) })!.text).toBe("You were removed from the conversation");
    setContacts(new Map([["5550201009", "Dana Example"]]));
    expect(mapMessage(msg({ senderName: "+1 555 020 1009", text: "{{sender}} added {{+15550201009}} to the conversation" }))!.text).toBe("Dana Example was added to the conversation");
    // The owner adding someone else, and someone adding the owner, stay as they were.
    expect(mapMessage(msg({ senderName: "+1 555-010-0001", text: "{{sender}} added {{+15550201009}} to the conversation" }), self)!.text).toBe("You added Dana Example to the conversation");
    expect(mapMessage(msg({ text: "{{sender}} added {{+15550100001}} to the conversation" }), self)!.text).toBe("Ana added you to the conversation");
  });
  test("a message someone typed with braces in it stays a message", () => {
    for (const text of ["{{name}} is the placeholder", "{{constructor.constructor('alert(1)')()}} ${7*7}", "hi {{sender}}", "{{sender}} line one\nline two"]) {
      const m = mapMessage(msg({ text }))!;
      expect(m.type).toBe("TEXT");
      expect(m.text).toBe(text);
    }
  });
  test("a hidden tapback keeps its own handling (no sender in the preview line), not a system line", () => {
    const m = mapMessage(msg({ text: "{{sender}} liked “hello”", isHidden: true }), { keepHidden: true })!;
    expect(m.text).toBe("liked “hello”");
    expect(m.type).toBe("TEXT");
  });
  test("a chat's list preview that is an event reads like the line in the chat", () => {
    const raw = { id: GROUP, accountID: "imessage_0a1b", network: "iMessage", title: "Crew", type: "group", participants: { items: [] }, unreadCount: 0, preview: msg({ text: "{{sender}} unsent a message" }) };
    const c = mapChat(raw)!;
    expect([c.preview!.type, c.preview!.text]).toEqual(["NOTICE", "Ana unsent a message"]);
  });
  test("the WhatsApp bridge's join, invite and leave lines and its call notice are system lines", () => {
    // As the bridge sends them: a join or leave from the person, a number from anyone, an invite from the owner.
    const people = chatPeople({ id: "!wa_group:beeper.local", type: "group", participants: { items: [{ id: "@whatsapp_lid-1009:beeper.local", fullName: "Kim" }] } });
    for (const [text, over] of [
      ["Jo joined the chat", { senderName: "Jo" }],
      ["Jo left the chat", { senderName: "Jo" }],
      ["+15550100004 was invited to the chat", { senderName: "Max" }],
      ["+15550100004 joined the chat", { senderName: "Rui" }],
      ["+15550100004 joined the chat", { senderName: "+15550100004" }],
      ["Lee was invited to the chat", { senderID: "@owner:beeper.com", senderName: undefined, isSender: true }],
      ["Kim was removed from the chat", { senderName: "Max" }],
    ] as const) {
      const m = mapMessage(wa({ text, ...over }), people)!;
      expect([m.type, m.text]).toEqual(["NOTICE", text]);
    }
    expect(mapMessage(wa({ text: "Incoming call. Use the WhatsApp app to answer." }))!).toMatchObject({ type: "NOTICE", text: "📞 Voice call" });
    expect(mapMessage(wa({ text: "Incoming video call. Use the WhatsApp app to answer." }))!).toMatchObject({ type: "NOTICE", text: "📹 Video call" });
    // What people write stays theirs; other networks' text is not read as WhatsApp's.
    for (const text of ["I joined the chat late", "I joined the chat", "we left the chat", "So happy Jo joined the chat today"]) expect(mapMessage(wa({ text }))!.type).toBe("TEXT");
    // Someone writing about another person (2026-11-06 review): Ana's own message, with her name on it.
    for (const text of ["My brother joined the chat", "Guess who joined the chat", "Mom left the chat", "lol nobody joined the chat", "Jo was invited to the chat"]) {
      const m = mapMessage(wa({ text }), people)!;
      expect([m.type, m.text, m.senderName]).toEqual(["TEXT", text, "Ana"]);
    }
    expect(mapMessage(wa({ text: "we left the chat", senderID: "@owner:beeper.com", isSender: true }))!.type).toBe("TEXT");
    expect(mapMessage(msg({ text: "Jo joined the chat" }))!.type).toBe("TEXT");
  });
  test("what a network bridge's bot writes is a system line; a person whose name ends in bot is not", () => {
    const x = (over: Record<string, unknown>) => msg({ chatID: "!x:beeper.local", accountID: "twitter", type: "TEXT", senderName: undefined, text: "Ana joined the group", ...over });
    expect(mapMessage(x({ senderID: "@twitterbot:beeper.local" }))!.type).toBe("NOTICE");
    expect(mapMessage(x({ senderID: "@robot:beeper.com" }))!.type).toBe("TEXT");
    const people = chatPeople({ id: "!x:beeper.local", type: "group", participants: { items: [{ id: "@helper:beeper.local", isNetworkBot: true }] } });
    expect(mapMessage(x({ senderID: "@helper:beeper.local" }), people)!.type).toBe("NOTICE");
    // Media from a bot stays media.
    expect(mapMessage(x({ senderID: "@twitterbot:beeper.local", type: "IMAGE" }))!.type).toBe("IMAGE");
  });
});

describe("text message threads Beeper lists as iMessage (item 25)", () => {
  const im = (title: string, over: Record<string, unknown> = {}) => ({ id: "imsg##thread:0f0f", accountID: "imessage_0a1b", network: "iMessage", title, type: "single", participants: { items: [{ id: "imsg##participant:cc" }] }, unreadCount: 0, ...over });
  test("short codes, Chinese 106 service numbers and Google business senders are text message threads", () => {
    for (const title of ["28849", "56782", "106575551234", "+86 1069 5551 2345"]) expect(mapChat(im(title))!.textMessage).toBe(true);
    // China Mobile's own service numbers (2026-11-06 review).
    for (const title of ["10086", "10086033", "10086910", "10086400210055", "125200201211001242"]) expect(mapChat(im(title))!.textMessage).toBe(true);
    expect(mapChat(im("Google", { participants: { items: [{ id: "imsg##participant:dd", email: "brand@rbm.goog" }] } }))!.textMessage).toBe(true);
    expect(mapChat(im("Google", { preview: msg({ chatID: "imsg##thread:0f0f", senderName: "brand@rbm.goog" }) }))!.textMessage).toBe(true);
    expect(parse(chatSummary, mapChat(im("28849"))).ok).toBe(true);
  });
  test("people, groups and other networks are not", () => {
    for (const c of [im("+1 555-020-1001"), im("Ana"), im("+86 138 5550 1234"), im("28849", { type: "group" }), im("28849", { network: "WhatsApp", id: "!w:beeper.local" })]) expect(mapChat(c)!.textMessage).toBeUndefined();
  });
});

describe("read_chat and list_chats against fake Beeper", () => {
  let fb: FakeBeeper;
  beforeAll(async () => {
    fb = await startFakeBeeper();
  });
  afterAll(() => fb.stop());
  afterEach(() => fb.reset());
  const actions = () => createActions(createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 }));
  const ok = <T>(r: { ok: boolean; data?: T; error?: unknown }): T => {
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
    return r.data as T;
  };
  const base = { accountID: "imessage", network: "iMessage", unreadCount: 0, isArchived: false, lastActivity: "2026-10-20T11:00:00.000Z" };
  const at = (n: number) => ({ timestamp: new Date(Date.parse("2026-10-20T10:00:00.000Z") + n * 60_000).toISOString(), sortKey: String(900_000 + n) });
  function seed() {
    const group = "imsg##thread:fake-crew";
    fb.state.chats.set(group, {
      ...base,
      id: group,
      localChatID: null,
      title: "Crew",
      type: "group",
      participants: { items: [{ id: "imsg##participant:ana", fullName: "Ana" }, { id: "imsg##participant:bo", phoneNumber: "+15550201009" }], hasMore: false, total: 4 },
    } as any);
    fb.state.messages.set(group, [
      { id: "g1", chatID: group, accountID: "imessage", senderID: "imsg##participant:ana", senderName: "Ana", text: "who is in", isSender: false, ...at(1) },
      // The owner, from the number of the WhatsApp account (fixture: +15550100001), which Beeper does not mark.
      { id: "g2", chatID: group, accountID: "imessage", senderID: "imsg##participant:own2", senderName: "+1 555-010-0001", text: "I got you", isSender: false, ...at(2) },
      { id: "g3", chatID: group, accountID: "imessage", senderID: "imsg##participant:own2", senderName: "+1 555-010-0001", text: "{{sender}} added {{+15550201009}} to the conversation", isSender: false, ...at(3) },
      { id: "g4", chatID: group, accountID: "imessage", senderID: "imsg##participant:bo", senderName: "imsg##participant:bo", text: "thanks", isSender: false, linkedMessageID: "g2", ...at(4) },
    ] as any);
    return group;
  }
  test("the owner's messages from another number, events as lines, names for unnamed senders; the result validates", async () => {
    const group = seed();
    const a = actions();
    ok(await a.status({}));
    const page = ok(await a.read_chat({ chatID: group, limit: 50 }));
    expect(parseActionResult("read_chat", page).ok).toBe(true);
    const by = new Map(page.items.map((m) => [m.id, m]));
    expect(by.get("g1")!.isSender).toBe(false);
    expect(by.get("g2")!.isSender).toBe(true);
    expect(by.get("g3")).toMatchObject({ type: "NOTICE", text: "You added +15550201009 to the conversation", isSender: true });
    expect(by.get("g4")!.senderName).toBe("+15550201009");
  });
  test("an ID the owner sent from in one chat marks the owner's messages in another", async () => {
    const a = actions();
    const one = "imsg##thread:fake-one";
    const two = "imsg##thread:fake-two";
    for (const id of [one, two]) fb.state.chats.set(id, { ...base, id, localChatID: null, title: id === one ? "Ana" : "Trip", type: id === one ? "single" : "group", participants: { items: [], hasMore: true, total: 9 } } as any);
    fb.state.messages.set(one, [{ id: "o1", chatID: one, accountID: "imessage", senderID: "imsg##participant:own3", text: "hi", isSender: true, ...at(1) }] as any);
    fb.state.messages.set(two, [{ id: "t1", chatID: two, accountID: "imessage", senderID: "imsg##participant:own3", text: "on my way", isSender: false, ...at(2) }] as any);
    expect(ok(await a.read_chat({ chatID: two, limit: 10 })).items[0]!.isSender).toBe(false);
    ok(await a.read_chat({ chatID: one, limit: 10 }));
    expect(ok(await a.read_chat({ chatID: two, limit: 10 })).items[0]!.isSender).toBe(true);
  });
  test("list_chats: a big group's preview is named from a chat on the same page, and from a message read before", async () => {
    const big = "!fake-big:beeper.local";
    const small = "!fake-small:beeper.local";
    const wab = { ...base, accountID: "whatsapp", network: "WhatsApp", localChatID: null, type: "group" };
    const listed = Array.from({ length: 20 }, (_, i) => ({ id: `@whatsapp_lid-${100 + i}:beeper.local`, fullName: `P${i}` }));
    fb.state.chats.set(big, { ...wab, id: big, title: "Builders", participants: { items: listed, hasMore: true, total: 142 } } as any);
    fb.state.messages.set(big, [{ id: "b1", chatID: big, accountID: "whatsapp", senderID: "@whatsapp_lid-2:beeper.local", senderName: "@whatsapp_lid-2:beeper.local", text: "see you there", isSender: false, type: "TEXT", ...at(1) }] as any);
    const a = actions();
    const preview = async () => ok(await a.list_chats({ limit: 50 })).items.find((c) => c.id === big)!.preview!;
    expect((await preview()).senderName).toBeUndefined();
    // Read in another chat where Beeper names them.
    const dm = "!fake-dm:beeper.local";
    fb.state.chats.set(dm, { ...wab, id: dm, title: "Teo", type: "single", participants: { items: [], hasMore: true, total: 2 } } as any);
    fb.state.messages.set(dm, [{ id: "d1", chatID: dm, accountID: "whatsapp", senderID: "@whatsapp_lid-2:beeper.local", senderName: "Teo", text: "hi", isSender: false, type: "TEXT", ...at(0) }] as any);
    ok(await a.read_chat({ chatID: dm, limit: 10 }));
    expect((await preview()).senderName).toBe("Teo");
    // A fresh connector: a smaller group on the same page lists them.
    fb.state.chats.delete(dm);
    fb.state.chats.set(small, { ...wab, id: small, title: "Crew", participants: { items: [{ id: "@whatsapp_lid-2:beeper.local", fullName: "Teo N" }], hasMore: false, total: 3 } } as any);
    const b = actions();
    const r = ok(await b.list_chats({ limit: 50 }));
    expect(parseActionResult("list_chats", r).ok).toBe(true);
    expect(r.items.find((c) => c.id === big)!.preview!.senderName).toBe("Teo N");
  });
  test("list_chats: a short code thread is a text message one; an event preview is a line with its people named", async () => {
    const group = seed();
    const sms = "imsg##thread:fake-short";
    fb.state.chats.set(sms, { ...base, id: sms, localChatID: null, title: "28849", type: "single", participants: { items: [{ id: "imsg##participant:sc" }], hasMore: false, total: 2 }, lastActivity: "2026-10-21T11:00:00.000Z" } as any);
    fb.state.messages.set(sms, [{ id: "s1", chatID: sms, accountID: "imessage", senderID: "imsg##participant:sc", senderName: "28849", text: "Your code is 123456", isSender: false, ...at(5) }] as any);
    const a = actions();
    ok(await a.status({}));
    const r = ok(await a.list_chats({ limit: 50 }));
    expect(parseActionResult("list_chats", r).ok).toBe(true);
    expect(r.items.find((c) => c.id === sms)!.textMessage).toBe(true);
    expect(r.items.filter((c) => c.textMessage).map((c) => c.id)).toEqual([sms]);
    const crew = r.items.find((c) => c.id === group)!;
    expect(crew.preview).toMatchObject({ id: "g4", senderName: "+15550201009" });
  });
});
