// Mail from another of the owner's mailboxes is the owner's: Gmail labels SENT only in the account that sent it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mapGmailMessage, mapGmailThread } from "../src/gmail/map.ts";
import { TodoStore } from "../src/todo/store.ts";
import { aliasesOf, clearOwnAddresses, forgetOwnAddresses, hasOtherOwnAddresses, isOwnAddress, ownSendName, sendAsNamesOf, setOwnAddresses } from "../src/gmail/own.ts";

const A = "a@gmail.com";
const B = "b@example.com";
const msg = (from: string, labels: string[] = ["INBOX", "UNREAD"], id = "m1") => ({
  id,
  threadId: "t1",
  internalDate: "1700000000000",
  labelIds: labels,
  snippet: "hi",
  payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "To", value: A }, { name: "Subject", value: "Hello" }], body: { data: btoa("hi") } },
});

beforeEach(clearOwnAddresses);
afterEach(clearOwnAddresses);

describe("the owner's addresses", () => {
  test("each account, its aliases, whatever the case; nobody else", () => {
    setOwnAddresses(A, []);
    setOwnAddresses(B, ["Alias@Example.com "]);
    expect(isOwnAddress(A, B)).toBe(true);
    expect(isOwnAddress("B@example.com", A)).toBe(true);
    expect(isOwnAddress("alias@example.com", A)).toBe(true);
    expect(isOwnAddress("someone@example.com", A)).toBe(false);
    expect(isOwnAddress(null, A)).toBe(false);
    expect(isOwnAddress("", A)).toBe(false);
  });

  test("a removed account is nobody's", () => {
    setOwnAddresses(B, ["alias@example.com"]);
    forgetOwnAddresses(B);
    expect(isOwnAddress(B, A)).toBe(false);
    expect(isOwnAddress("alias@example.com", A)).toBe(false);
  });

  test("whether a mailbox has anyone else to be", () => {
    setOwnAddresses(A, []);
    expect(hasOtherOwnAddresses(A)).toBe(false);
    setOwnAddresses(A, ["alias@example.com"]);
    expect(hasOtherOwnAddresses(A)).toBe(true);
    setOwnAddresses(A, []);
    setOwnAddresses(B, []);
    expect(hasOtherOwnAddresses(A)).toBe(true);
  });

  test("Gmail's answer", () => {
    expect(aliasesOf({ sendAs: [{ sendAsEmail: "x@y.z" }, { other: 1 }, null] })).toEqual(["x@y.z"]);
    for (const junk of [null, {}, { sendAs: "no" }, 5]) expect(aliasesOf(junk)).toEqual([]);
  });
});

describe("the name the owner sends under", () => {
  const answer = {
    sendAs: [
      { sendAsEmail: "B@Example.com", displayName: "Pat Owner", replyToAddress: "", signature: "", isPrimary: true, isDefault: true },
      { sendAsEmail: "work@example.org", displayName: "Pat at Work", isDefault: false, treatAsAlias: true },
      { sendAsEmail: "alias@example.com", displayName: "", isDefault: false, treatAsAlias: true },
      { sendAsEmail: "odd@example.com", displayName: "Pat\r\nBcc: x@y.z" },
      { displayName: "nobody" },
      null,
    ],
  };

  test("each address's display name from Gmail's answer; an alias without one goes out under the primary's, as Gmail does", () => {
    expect([...sendAsNamesOf(answer)]).toEqual([
      ["b@example.com", "Pat Owner"],
      ["work@example.org", "Pat at Work"],
      ["alias@example.com", "Pat Owner"],
      ["odd@example.com", "Pat Bcc: x@y.z"],
    ]);
    expect([...sendAsNamesOf({ sendAs: [{ sendAsEmail: B, displayName: "", isPrimary: true }, { sendAsEmail: "alias@example.com" }] })]).toEqual([]);
    for (const junk of [null, {}, { sendAs: "no" }, 5]) expect(sendAsNamesOf(junk).size).toBe(0);
  });

  test("a primary without a name is Gmail's default, the Google account's name: the account name given, for it and its nameless aliases", () => {
    const fresh = { sendAs: [{ sendAsEmail: B, displayName: "", isPrimary: true }, { sendAsEmail: "work@example.org", displayName: "Pat at Work" }, { sendAsEmail: "alias@example.com", displayName: "" }] };
    expect([...sendAsNamesOf(fresh, "Pat Owner")]).toEqual([
      [B, "Pat Owner"],
      ["work@example.org", "Pat at Work"],
      ["alias@example.com", "Pat Owner"],
    ]);
    // A "send mail as" name of its own wins; a hostile one is one clean line.
    expect(sendAsNamesOf(answer, "Someone Else").get("b@example.com")).toBe("Pat Owner");
    expect(sendAsNamesOf(fresh, "Pat\r\nBcc: x@y.z").get(B)).toBe("Pat Bcc: x@y.z");
    expect([...sendAsNamesOf(fresh, "")]).toEqual([["work@example.org", "Pat at Work"]]);
  });

  test("kept per account until Gmail answers again or the account goes; nothing known: no name", () => {
    expect(ownSendName(B)).toBe("");
    setOwnAddresses(B, aliasesOf(answer), sendAsNamesOf(answer));
    expect(ownSendName(B)).toBe("Pat Owner");
    expect(ownSendName(B, "Work@example.org")).toBe("Pat at Work");
    expect(ownSendName(A)).toBe("");
    // The service's placeholder before a refresh (no answer yet) keeps what was known.
    setOwnAddresses(B, []);
    expect(ownSendName(B)).toBe("Pat Owner");
    setOwnAddresses(B, [], new Map());
    expect(ownSendName(B)).toBe("");
    setOwnAddresses(B, [], sendAsNamesOf(answer));
    forgetOwnAddresses(B);
    expect(ownSendName(B)).toBe("");
  });
});

describe("in a thread", () => {
  test("from another of the owner's mailboxes: it is theirs, and not someone else's writing", () => {
    setOwnAddresses(A, []);
    setOwnAddresses(B, []);
    expect(mapGmailMessage(msg(`Jacky <${B}>`), A)!.isSender).toBe(true);
    expect(mapGmailMessage(msg("Tina <tina@example.org>"), A)!.isSender).toBe(false);
    expect(mapGmailMessage(msg(`x <${A}>`), A)!.isSender).toBe(true);
    expect(mapGmailMessage(msg("Tina <tina@example.org>", ["SENT"]), A)!.isSender).toBe(true);
  });

  test("without knowing the other mailbox it stays someone else's", () => {
    expect(mapGmailMessage(msg(`Jacky <${B}>`), A)!.isSender).toBe(false);
  });

  test("To do: a thread from another of the owner's mailboxes stays out; someone writing in it brings it in", () => {
    setOwnAddresses(A, []);
    setOwnAddresses(B, []);
    const key = "gmail:" + A;
    const now = Date.now();
    let clock = now;
    const store = new TodoStore({ now: () => clock });
    store.meet(key);
    store.finishFirstRun(key);
    clock = now + 60_000;
    const late = (m: ReturnType<typeof msg>, at: number) => ({ ...m, internalDate: String(at) });
    const own = mapGmailThread({ id: "t1", messages: [late(msg(`Jacky <${B}>`), now + 1000)] }, A)!;
    store.see(own);
    expect(store.isTodo(own.id)).toBe(false);
    const other = mapGmailThread({ id: "t1", messages: [late(msg(`Jacky <${B}>`), now + 1000), late(msg("Tina <tina@example.org>", ["INBOX", "UNREAD"], "m2"), now + 2000)] }, A)!;
    store.see(other);
    expect(store.isTodo(other.id)).toBe(true);
  });
});
