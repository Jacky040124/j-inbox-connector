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
  reflowPlain,
  splitQuoted,
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

describe("reading replies like Gmail: quoted history apart, hard wrapping undone", () => {
  const LYFT = [
    "Hi Jacky,",
    "",
    "Thanks for the details, this is really helpful. I will share it with the",
    "hiring manager and get back to you by Friday.",
    "",
    "Best,",
    "Priya",
    "",
    "On Thu, Oct 23, 2026 at 3:55 PM Jacky Zhong <jacky@example.com> wrote:",
    "",
    "> Hi Priya, here is what I did:",
    ">> *Workus AI*",
    ">>    - designed & implemented multilayer caching (redis cache aside +",
    ">>    localStorage) for a slow dashboard",
  ].join("\n");

  test("a reply splits at the attribution line; the quote keeps every line", () => {
    const r = splitQuoted(LYFT);
    expect(r.main).toBe(LYFT.split("\nOn Thu")[0]!.trimEnd());
    expect(r.quoted.startsWith("On Thu, Oct 23, 2026 at 3:55 PM Jacky Zhong <jacky@example.com> wrote:")).toBe(true);
    expect(r.quoted).toContain(">>    localStorage) for a slow dashboard");
  });
  test("other attribution forms: two lines, Chinese, Original Message, a trailing > block with a signature", () => {
    expect(splitQuoted("ok\n\nOn Mon, Oct 26, 2026 at 9:00 AM Very Long Name\n<x@example.com> wrote:\n> hi").main).toBe("ok");
    expect(splitQuoted("好的\n\n在 2026年10月26日 周一 09:00，张三 <z@example.com> 写道：\n> 你好").main).toBe("好的");
    expect(splitQuoted("Sure.\n\n-----Original Message-----\nFrom: a").main).toBe("Sure.");
    expect(splitQuoted("Sounds good\n\n> earlier text\n> more\n\n-- \nsig").main).toBe("Sounds good");
  });
  test("no quote, a quote in the middle, a forward, or nothing above the quote: all of it stays the text", () => {
    for (const t of ["just text\nwith lines", "see:\n> one quoted line\nand my answer below it\nmore answer\nstill more\nand more", "FYI\n\n---------- Forwarded message ---------\nFrom: a@example.com\n\nhello", "> only a quote\n> nothing else"]) {
      expect(splitQuoted(t)).toEqual({ main: t, quoted: "" });
    }
  });
  test("reflow joins wrapped prose, keeps short lines, lists, quotes, blank lines and colon lines", () => {
    const wrapped = "Thanks for the details, this is really helpful. I will share it with the\nhiring manager and get back to you by Friday.\n\nBest,\nPriya";
    expect(reflowPlain(wrapped)).toBe("Thanks for the details, this is really helpful. I will share it with the hiring manager and get back to you by Friday.\n\nBest,\nPriya");
    const list = "Steps we need to do every single time a package comes back from them:\n- go to their platform and update the task status on our dashboard\n- download the package\n1) one\n2) two";
    expect(reflowPlain(list)).toBe(list);
    const bullet = "   - designed & implemented multilayer caching (redis cache aside +\n   localStorage) for a slow dashboard";
    expect(reflowPlain(bullet)).toBe("   - designed & implemented multilayer caching (redis cache aside + localStorage) for a slow dashboard");
    const quoted = "> a quoted line that is long enough to look like it was wrapped by a\n> mail client";
    expect(reflowPlain(quoted)).toBe(quoted);
    expect(reflowPlain("short line\nnext line")).toBe("short line\nnext line");
    const code = "Here is the snippet I mentioned in the meeting this morning, below.\n    const x = 1;";
    expect(reflowPlain(code)).toBe(code);
  });
});
