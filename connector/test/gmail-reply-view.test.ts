// A Gmail reply as J-Inbox shows it: the new text (wrapping undone) and the quoted history apart.
import { describe, expect, test } from "bun:test";
import { b64urlEncode } from "@j-inbox/fake-google";
import { parseActionResult } from "@j-inbox/protocol";
import { mapGmailMessage } from "../src/gmail/map.ts";

const ME = "owner@example.com";
const msg = (text: string) => ({
  id: "18c2f0a1b2c3d4e5",
  threadId: "18c2f0a1b2c3d4e5",
  labelIds: ["INBOX", "UNREAD"],
  internalDate: String(Date.UTC(2026, 9, 26, 12)),
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "Priya <priya@lyft.example>" },
      { name: "To", value: ME },
      { name: "Subject", value: "Re: Hello" },
      { name: "Date", value: "Mon, 26 Oct 2026 12:00:00 +0000" },
      { name: "Content-Type", value: "text/plain; charset=utf-8" },
    ],
    body: { data: b64urlEncode(new TextEncoder().encode(text)) },
  },
});

describe("Gmail reply view", () => {
  test("text is the new part, unwrapped; quotedText holds the history; both valid per the protocol", () => {
    const body = [
      "Thanks for the details, this is really helpful. I will share it with the",
      "hiring manager and get back to you by Friday.",
      "",
      "On Thu, Oct 23, 2026 at 3:55 PM Jacky <owner@example.com> wrote:",
      "> Hi Priya,",
      ">> earlier",
    ].join("\r\n");
    const m = mapGmailMessage(msg(body), ME)!;
    expect(m.text).toBe("Thanks for the details, this is really helpful. I will share it with the hiring manager and get back to you by Friday.");
    expect(m.quotedText).toBe("On Thu, Oct 23, 2026 at 3:55 PM Jacky <owner@example.com> wrote:\n> Hi Priya,\n>> earlier");
    expect(m.textTruncated).toBeUndefined();
    const page = { chat: { id: m.chatID, accountID: m.accountID, network: "Gmail", title: "Re: Hello", type: "single", unreadCount: 1, isPinned: false, isMuted: false, isArchived: false, lastActivity: m.timestamp }, items: [m], hasMore: false, nextCursor: null };
    expect(parseActionResult("read_chat", page).ok).toBe(true);
  });
  test("a long history no longer pushes the new text out (it used to be cut at the size limit)", () => {
    const history = Array.from({ length: 400 }, (_, i) => `>>>> line ${i} of the old thread that keeps going and going`).join("\n");
    const m = mapGmailMessage(msg(`Short answer.\n\nOn Mon, Oct 20, 2026 at 1:00 PM X <x@example.com> wrote:\n${history}`), ME)!;
    expect(m.text).toBe("Short answer.");
    expect(m.textTruncated).toBeUndefined();
    expect(m.quotedText!.length).toBeLessThanOrEqual(20_000);
  });
  test("a long email (an application form, a newsletter) is kept up to 20,000 characters, not cut at the chat limit", () => {
    const long = Array.from({ length: 150 }, (_, i) => `Question ${i}: please describe a project you are proud of.`).join("\n\n");
    expect(long.length).toBeGreaterThan(4000);
    const m = mapGmailMessage(msg(long), ME)!;
    expect(m.text).toBe(long);
    expect(m.textTruncated).toBeUndefined();
    const huge = mapGmailMessage(msg("x ".repeat(15_000)), ME)!;
    expect(huge.textTruncated).toBe(true);
    expect(huge.text!.length).toBeLessThanOrEqual(20_000);
  });
});
