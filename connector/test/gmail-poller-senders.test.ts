// The Gmail poller's othersAt (snooze's early return) from the labels Gmail history carries:
// mail without SENT is someone else's, SENT is the owner's, no labels at all is "not known".
import { describe, expect, test } from "bun:test";
import { gmailChatID, parseConnectorFrame, type EventFrame } from "@j-inbox/protocol";
import { GmailPoller } from "../src/gmail/poller.ts";
import type { GmailSource } from "../src/gmail/source.ts";

const EMAIL = "owner@example.com";

function stubSource(history: unknown[]): GmailSource {
  const client = {
    path: (parts: string[]) => parts.join("/"),
    get: async (path: string) => (path.startsWith("history") ? { ok: true, body: { history, historyId: "200" } } : { ok: false, error: { code: "NOT_FOUND" } }),
  };
  return { email: EMAIL, client, profile: async () => ({ ok: true, data: { emailAddress: EMAIL, historyId: "100" } }) } as unknown as GmailSource;
}

type MessageFrame = Extract<EventFrame, { kind: "message" }>;

async function poll(history: unknown[]): Promise<MessageFrame[]> {
  const events: EventFrame[] = [];
  const s = stubSource(history);
  const p = new GmailPoller({ sources: () => [s], send: (f) => (events.push(f), true) });
  await p.poll(s); // records the start point
  await p.poll(s);
  return events.filter((e): e is MessageFrame => e.kind === "message");
}

const added = (id: string, threadId: string, labelIds?: string[]) => ({ messagesAdded: [{ message: { id, threadId, ...(labelIds ? { labelIds } : {}) } }] });

describe("Gmail othersAt", () => {
  test("per thread: someone else's mail beats the owner's, the owner's alone is null, no labels is unknown", async () => {
    const ev = await poll([added("m1", "tA", ["SENT"]), added("m2", "tA", ["INBOX", "UNREAD"]), added("m3", "tB", ["SENT"]), added("m4", "tC"), added("m5", "tD", ["SENT"]), added("m6", "tD")]);
    const by = (t: string) => ev.find((e) => e.chatID === gmailChatID(EMAIL, t))!;
    expect(by("tA").othersAt).toBe(by("tA").ts);
    expect(by("tB").othersAt).toBeNull();
    expect("othersAt" in by("tC")).toBe(false);
    expect("othersAt" in by("tD")).toBe(false);
    for (const e of ev) expect(parseConnectorFrame(JSON.stringify(e)).ok).toBe(true);
  });
  test("deletions and label changes never carry it", async () => {
    const ev = await poll([{ messagesDeleted: [{ message: { id: "m1", threadId: "tA", labelIds: ["INBOX"] } }] }, { labelsAdded: [{ message: { id: "m2", threadId: "tB", labelIds: ["INBOX"] }, labelIds: ["STARRED"] }] }]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ op: "deleted" });
    expect("othersAt" in ev[0]!).toBe(false);
  });
});
