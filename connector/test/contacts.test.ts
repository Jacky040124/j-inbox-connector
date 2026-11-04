// Names for iMessage's numbers, and the tapbacks Beeper hides.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapChat, mapMessage } from "../src/beeper-map.ts";
import { contactKey, contactName, isAddress, loadContacts, parseContacts, setContacts, watchContacts } from "../src/contacts.ts";

const THREAD = "imsg##thread:fba9721787ed5621fa69a03347db1b4e161d9bfeb03a923e";
const message = (over: Record<string, unknown> = {}) => ({
  id: "M1",
  chatID: THREAD,
  accountID: "imessage_9bed",
  senderID: "imsg##participant:84a7",
  senderName: "+1 613-555-0100",
  timestamp: "2026-11-03T21:14:52.517Z",
  sortKey: "1793740492517",
  text: "hello",
  ...over,
});
const group = (title: string, over: Record<string, unknown> = {}) => ({
  id: THREAD,
  accountID: "imessage_9bed",
  network: "iMessage",
  title,
  type: "group",
  participants: {
    items: [
      { id: "a", phoneNumber: "+16135550100" },
      { id: "b", phoneNumber: "+12365550101" },
      { id: "me", phoneNumber: "+17785550102", isSelf: true },
    ],
    total: 3,
  },
  ...over,
});
const OWN_TITLE = "+1 236-555-0101, +1 613-555-0100 & +1 778-555-0102";

afterEach(() => setContacts(new Map()));

describe("what counts as the same number", () => {
  test.each([
    ["+1 (613) 555-0100", "6135550100"],
    ["613.555.0100", "6135550100"],
    ["16135550100", "6135550100"],
    ["‪+1 613 555‐0100‬".replace("‐", "-"), "6135550100"],
    ["+86 138 0013 8000", "8613800138000"],
    ["Someone@Example.COM", "someone@example.com"],
  ])("%s", (input, key) => expect(contactKey(input)).toBe(key));

  test("names, short codes and empty strings are not addresses", () => {
    for (const s of ["Jacky", "Bigway but this is not a plan", "28849", "", "+", "a@b", "1 2 3"]) {
      expect(contactKey(s)).toBeNull();
      expect(isAddress(s)).toBe(false);
    }
  });
});

describe("contacts.json", () => {
  test("keeps the first name for a number, whatever its format; ignores what is not a name", () => {
    const m = parseContacts(JSON.stringify({ names: { "+1 613-555-0100": " Ada ", "6135550100": "Second", "not a number": "X", "2365550101": 5, "2365550102": "  ", "a@example.com": "Eve" } }));
    expect([...m]).toEqual([["6135550100", "Ada"], ["a@example.com", "Eve"]]);
  });

  test("a name cannot run past its limit", () => {
    expect(parseContacts(JSON.stringify({ names: { "6135550100": "x".repeat(5000) } })).get("6135550100")!.length).toBe(200);
  });

  test.each(['{"names":[1]}', '{"names":null}', '{"other":1}', "[]"])("%s has no names", (t) => expect(parseContacts(t).size).toBe(0));

  test("a broken or missing file leaves the names there are; a changed file replaces them", () => {
    const dir = mkdtempSync(join(tmpdir(), "contacts-"));
    const file = join(dir, "contacts.json");
    expect(loadContacts(file, -1)).toBe(-1);
    writeFileSync(file, JSON.stringify({ names: { "6135550100": "Ada" } }));
    const at = loadContacts(file, -1);
    expect(contactName("+1 613 555 0100")).toBe("Ada");
    writeFileSync(file, "{ not json");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    loadContacts(file, at);
    expect(contactName("+1 613 555 0100")).toBe("Ada");
    writeFileSync(file, JSON.stringify({ names: { "6135550100": "Grace" } }));
    utimesSync(file, new Date(), new Date(Date.now() + 9000));
    loadContacts(file, at);
    expect(contactName("+1 613 555 0100")).toBe("Grace");
  });

  test("the helper is only started if it is installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "contacts-"));
    const calls: string[][] = [];
    watchContacts({ file: join(dir, "c.json"), helperApp: join(dir, "None.app"), run: (c) => calls.push(c) }).stop();
    expect(calls).toEqual([]);
    const app = join(dir, "Helper.app");
    Bun.spawnSync(["mkdir", "-p", join(app, "Contents")]);
    writeFileSync(join(app, "Contents", "Info.plist"), "x");
    watchContacts({ file: join(dir, "c.json"), helperApp: app, run: (c) => calls.push(c) }).stop();
    expect(calls).toEqual([["/usr/bin/open", "-g", "-j", "-a", app, "--args", join(dir, "c.json")]]);
  });
});

describe("names in chats and messages", () => {
  test("a sender's number becomes their name; without a contact it stays", () => {
    expect(mapMessage(message())!.senderName).toBe("+1 613-555-0100");
    setContacts(new Map([["6135550100", "Ada"]]));
    expect(mapMessage(message())!.senderName).toBe("Ada");
    expect(mapMessage(message({ senderName: "+1 613-555-9999" }))!.senderName).toBe("+1 613-555-9999");
    expect(mapMessage(message({ senderName: "Real Name" }))!.senderName).toBe("Real Name");
  });

  test("a name from Contacts is cleaned like any other", () => {
    setContacts(new Map([["6135550100", "A\u0000da\n<b>"]]));
    expect(mapMessage(message())!.senderName).not.toMatch(/[\u0000\n]/);
  });

  test("a single chat's title", () => {
    setContacts(new Map([["6135550100", "Ada"], ["a@example.com", "Eve"]]));
    const chat = (title: string) => mapChat({ id: THREAD, accountID: "x", title, type: "single" })!.title;
    expect(chat("+1 613-555-0100")).toBe("Ada");
    expect(chat("A@example.com")).toBe("Eve");
    expect(chat("+1 613-555-9999")).toBe("+1 613-555-9999");
    expect(chat("28849")).toBe("28849");
    expect(chat("Google")).toBe("Google");
  });

  test("a group titled with numbers: names, some still numbers, and never the owner's own", () => {
    expect(mapChat(group(OWN_TITLE))!.title).toBe("+1 236-555-0101 & +1 613-555-0100");
    setContacts(new Map([["6135550100", "Ada"]]));
    expect(mapChat(group(OWN_TITLE))!.title).toBe("+1 236-555-0101 & Ada");
    setContacts(new Map([["6135550100", "Ada"], ["2365550101", "Bob"]]));
    expect(mapChat(group(OWN_TITLE))!.title).toBe("Bob & Ada");
  });

  test("a group with a real name keeps it, even with a comma", () => {
    setContacts(new Map([["6135550100", "Ada"]]));
    expect(mapChat(group("Lunch, maybe"))!.title).toBe("Lunch, maybe");
    expect(mapChat(group("+1 613-555-0100, friends"))!.title).toBe("+1 613-555-0100, friends");
  });

  test("the preview's sender gets the name too", () => {
    setContacts(new Map([["6135550100", "Ada"]]));
    expect(mapChat(group("Team", { preview: message() }))!.preview!.senderName).toBe("Ada");
  });
});

describe("iMessage's tapback, which Beeper sends as a hidden message", () => {
  const tapback = message({ isHidden: true, text: "{{sender}} loved &quot;jobs r coming our way 🫡&quot;", linkedMessageID: "M0" });

  test("is not a message in the history", () => {
    expect(mapMessage(tapback)).toBeNull();
  });

  test("as a chat's preview it reads properly", () => {
    expect(mapChat(group("Team", { preview: tapback }))!.preview!.text).toBe('loved "jobs r coming our way 🫡"');
  });

  test("somebody typing {{sender}} in a real message keeps it", () => {
    expect(mapMessage(message({ text: "the {{sender}} template" }))!.text).toBe("the {{sender}} template");
  });
});
