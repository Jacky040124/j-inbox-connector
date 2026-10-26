// Email text in and out (src/gmail/mime.ts): decoding what Gmail sends, building reply-all and new
// emails. Built messages are checked with fake-google's own MIME parser (an independent decoder).
import { describe, expect, test } from "bun:test";
import { decodeHeader, parseRaw, b64urlDecode } from "@j-inbox/fake-google";
import {
  buildMessage,
  decodeEncodedWords,
  emailHtmlToText,
  encodeHeaderValue,
  parseAddressList,
  rawForGmail,
  replyAllRecipients,
  replyReferences,
  replySubject,
  decodeEntities,
  decodeCharset,
} from "../src/gmail/mime.ts";

const SELF = "owner@example.com";

describe("decoding", () => {
  test("RFC 2047 B and Q words, adjacent words joined, other text kept", () => {
    expect(decodeEncodedWords("=?UTF-8?B?R3LDvMOfZQ==?= =?UTF-8?Q?_aus_Z=C3=BCrich?=")).toBe("Grüße aus Zürich");
    expect(decodeEncodedWords("Re: =?ISO-8859-1?Q?caf=E9?= time")).toBe("Re: café time");
    expect(decodeEncodedWords("=?UTF-8?B?not base64!?=")).toBe("=?UTF-8?B?not base64!?=");
    expect(decodeEncodedWords("plain")).toBe("plain");
  });
  test("charsets", () => {
    expect(decodeCharset(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), "iso-8859-1")).toBe("café");
    expect(decodeCharset(new TextEncoder().encode("ok"), "x-unknown-charset")).toBe("ok");
  });
  test("address lists: names, quotes, groups, comments, garbage dropped, lower case", () => {
    expect(parseAddressList('"Builder, Bob" <Bob@Example.com>, carol@example.com (Carol C), =?UTF-8?B?SsO8cmdlbg==?= <j@example.de>')).toEqual([
      { name: "Builder, Bob", address: "bob@example.com" },
      { name: "Carol C", address: "carol@example.com" },
      { name: "Jürgen", address: "j@example.de" },
    ]);
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
    expect(parseAddressList("team: a@example.com, b@example.com;")).toEqual([{ address: "a@example.com" }, { address: "b@example.com" }]);
    expect(parseAddressList("not an address, <>, x@y")).toEqual([]);
    expect(parseAddressList('"Evil\r\nBcc: x@evil.example" <e@example.com>')[0]!.name).not.toMatch(/[\r\n]/);
  });
  test("snippet entities and email HTML become plain text, never markup", () => {
    expect(decodeEntities("It&#39;s &lt;b&gt; &amp; more")).toBe("It's <b> & more");
    const t = emailHtmlToText('<html><head><style>p{}</style><title>x</title></head><body><p>Hi &amp; welcome</p><script>alert(1)</script><a href="https://e.x/r?a=1&amp;b=2">report</a><a href="javascript:alert(1)">click</a><ul><li>one</li></ul><!-- c --></body></html>');
    expect(t).toContain("Hi & welcome");
    expect(t).toContain("report (https://e.x/r?a=1&b=2)");
    expect(t).not.toContain("alert");
    expect(t).not.toContain("javascript:");
    expect(t).toContain("• one");
    expect(t).not.toMatch(/<[a-z]/i);
  });
});

describe("reply-all", () => {
  const base = {
    from: [{ name: "Bob", address: "bob@example.com" }],
    replyTo: [],
    to: [{ address: SELF }, { name: "Carol", address: "carol@example.com" }],
    cc: [{ address: "dave@example.com" }, { address: "CAROL@example.com" }, { address: SELF.toUpperCase() }],
    subject: "Project kickoff",
    messageId: "<m2@example.com>",
    references: "<m1@example.com>",
  };
  test("sender + To in To, Cc in Cc, minus the owner and duplicates (case-insensitive)", () => {
    expect(replyAllRecipients(base, SELF)).toEqual({ to: [{ name: "Bob", address: "bob@example.com" }, { name: "Carol", address: "carol@example.com" }], cc: [{ address: "dave@example.com" }] });
  });
  test("Reply-To replaces the sender; the owner's own message goes to its recipients again", () => {
    expect(replyAllRecipients({ ...base, replyTo: [{ address: "list@example.com" }] }, SELF).to[0]).toEqual({ address: "list@example.com" });
    expect(replyAllRecipients({ ...base, from: [{ address: SELF }], to: [{ address: "kim@example.com" }], cc: [] }, SELF)).toEqual({ to: [{ address: "kim@example.com" }], cc: [] });
    expect(replyAllRecipients({ ...base, from: [{ address: SELF }], to: [{ address: SELF }], cc: [] }, SELF)).toEqual({ to: [{ address: SELF }], cc: [] });
  });
  test("subject and threading headers", () => {
    expect(replySubject("Project kickoff")).toBe("Re: Project kickoff");
    expect(replySubject("RE: x")).toBe("RE: x");
    expect(replySubject("")).toBe("Re:");
    expect(replyReferences(base)).toEqual({ inReplyTo: "<m2@example.com>", references: "<m1@example.com> <m2@example.com>" });
    const long = Array.from({ length: 40 }, (_, i) => `<r${i}@x>`).join(" ");
    const r = replyReferences({ messageId: "<last@x>", references: long });
    expect(r.references.split(" ")).toHaveLength(20);
    expect(r.references.startsWith("<r0@x>")).toBe(true);
    expect(r.references.endsWith("<last@x>")).toBe(true);
  });
});

describe("building messages", () => {
  test("UTF-8 subject and names are RFC 2047, the body is base64 UTF-8, lines end in CRLF", () => {
    const msg = buildMessage({ from: SELF, to: [{ name: "Jürgen Groß", address: "j@example.de" }, { name: "Bob, Jr.", address: "bob@example.com" }], cc: [{ address: "c@example.com" }], subject: "Grüße 🇨🇭 " + "x".repeat(80), text: "Hallo\nzwei Zeilen 👋", inReplyTo: "<a@b>", references: "<z@b> <a@b>" });
    expect(msg.split("\r\n\r\n")[0]!.split("\r\n").every((l) => !l.includes("\n"))).toBe(true);
    expect(msg).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    const parsed = parseRaw(b64urlDecode(rawForGmail(msg))!)!;
    const h = (n: string) => parsed.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    expect(decodeHeader(h("subject"))).toBe("Grüße 🇨🇭 " + "x".repeat(80));
    expect(decodeHeader(h("to"))).toContain("Jürgen Groß <j@example.de>");
    expect(h("to")).toContain('"Bob, Jr." <bob@example.com>');
    expect(h("cc")).toBe("c@example.com");
    expect(h("in-reply-to")).toBe("<a@b>");
    expect(h("references")).toBe("<z@b> <a@b>");
    expect(parsed.transferEncoding).toBe("base64");
    expect(parsed.text).toBe("Hallo\r\nzwei Zeilen 👋");
  });
  test("hostile values cannot add header lines", () => {
    const msg = buildMessage({ from: SELF, to: [{ name: 'Eve"\r\nBcc: spy@evil.example', address: "eve@example.com" }], cc: [], subject: "Hi\r\nBcc: spy@evil.example", text: "body\r\n\r\nBcc: no", inReplyTo: "<x>\r\nBcc: y", references: "<a> \r\nBcc: z" });
    const head = msg.split("\r\n\r\n")[0]!;
    expect(head).not.toMatch(/^Bcc:/im);
    // Not even inside an encoded word: the subject a recipient sees is one line.
    const subject = parseRaw(b64urlDecode(rawForGmail(msg))!)!.headers.find((h) => h.name === "Subject")!.value;
    expect(decodeHeader(subject)).toBe("Hi Bcc: spy@evil.example");
    expect(head).not.toContain("In-Reply-To");
    expect(head).not.toContain("References");
    expect(() => buildMessage({ from: SELF, to: [{ address: "a@b.com\r\nBcc: x@y.z" }], cc: [], subject: "s", text: "t" })).toThrow();
    expect(() => buildMessage({ from: SELF, to: [], cc: [], subject: "s", text: "t" })).toThrow();
  });
  test("long subjects are split into several encoded words that each stay short", () => {
    const v = encodeHeaderValue("ü".repeat(200));
    for (const w of v.split("\r\n ")) expect(w.length).toBeLessThanOrEqual(75);
    expect(decodeHeader(v.replace(/\r\n /g, " "))).toBe("ü".repeat(200));
  });
});
