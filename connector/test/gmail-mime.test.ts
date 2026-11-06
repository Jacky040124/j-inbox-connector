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
  hasVisibleText,
} from "../src/gmail/mime.ts";
import { mapGmailMessage, messageBody, type GPart } from "../src/gmail/map.ts";

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
    const msg = buildMessage({ from: { address: SELF }, to: [{ name: "Jürgen Groß", address: "j@example.de" }, { name: "Bob, Jr.", address: "bob@example.com" }], cc: [{ address: "c@example.com" }], subject: "Grüße 🇨🇭 " + "x".repeat(80), text: "Hallo\nzwei Zeilen 👋", inReplyTo: "<a@b>", references: "<z@b> <a@b>" });
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
    const msg = buildMessage({ from: { address: SELF }, to: [{ name: 'Eve"\r\nBcc: spy@evil.example', address: "eve@example.com" }], cc: [], subject: "Hi\r\nBcc: spy@evil.example", text: "body\r\n\r\nBcc: no", inReplyTo: "<x>\r\nBcc: y", references: "<a> \r\nBcc: z" });
    const head = msg.split("\r\n\r\n")[0]!;
    expect(head).not.toMatch(/^Bcc:/im);
    // Not even inside an encoded word: the subject a recipient sees is one line.
    const subject = parseRaw(b64urlDecode(rawForGmail(msg))!)!.headers.find((h) => h.name === "Subject")!.value;
    expect(decodeHeader(subject)).toBe("Hi Bcc: spy@evil.example");
    expect(head).not.toContain("In-Reply-To");
    expect(head).not.toContain("References");
    expect(() => buildMessage({ from: { address: SELF }, to: [{ address: "a@b.com\r\nBcc: x@y.z" }], cc: [], subject: "s", text: "t" })).toThrow();
    expect(() => buildMessage({ from: { address: SELF }, to: [], cc: [], subject: "s", text: "t" })).toThrow();
  });
  test("From carries the name the owner sends under, cleaned and encoded like To and Cc; without one, the bare address", () => {
    const from = (name: string | undefined) => {
      const msg = buildMessage({ from: { ...(name !== undefined ? { name } : {}), address: SELF }, to: [{ address: "a@example.com" }], cc: [], subject: "s", text: "t" });
      return { head: msg.split("\r\n\r\n")[0]!, value: parseRaw(b64urlDecode(rawForGmail(msg))!)!.headers.find((h) => h.name === "From")!.value };
    };
    expect(from("Pat Owner").value).toBe(`Pat Owner <${SELF}>`);
    expect(from("Owner, Pat").value).toBe(`"Owner, Pat" <${SELF}>`);
    const intl = from("Zoë Ôwner 王");
    expect(intl.value).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeHeader(intl.value)).toBe(`Zoë Ôwner 王 <${SELF}>`);
    expect(from(undefined).value).toBe(SELF);
    expect(from("").value).toBe(SELF);
    const hostile = from('Pat"\r\nBcc: spy@evil.example');
    expect(hostile.head).not.toMatch(/^Bcc:/im);
    expect(hostile.value).toBe(`"Pat\\" Bcc: spy@evil.example" <${SELF}>`);
    expect(() => buildMessage({ from: { name: "Pat", address: "not an address" }, to: [{ address: "a@example.com" }], cc: [], subject: "s", text: "t" })).toThrow();
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

describe("a text/plain part that shows nothing", () => {
  const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64url");
  const part = (mimeType: string, text: string): GPart => ({ mimeType, headers: [{ name: "Content-Type", value: `${mimeType}; charset=utf-8` }], body: { size: text.length, data: b64(text) } });
  const mail = (...parts: GPart[]): GPart => ({ mimeType: "multipart/alternative", parts });
  // As the real A bank email has it: an empty body tag and thousands of U+034F.
  const JUNK = `<body></body>\r\n${"\u034f".repeat(6000)}\r\n${"\u200b\u200c\u00ad\ufeff".repeat(500)}\r\n`;
  const HTML = "<html><head><style>p{color:red}</style></head><body><p>Your statement is <b>ready</b>.</p></body></html>";

  test("the HTML part is the text, whichever part comes first, also deep in the message", () => {
    expect(messageBody(mail(part("text/plain", JUNK), part("text/html", HTML)))).toBe("Your statement is ready.");
    expect(messageBody(mail(part("text/html", HTML), part("text/plain", JUNK)))).toBe("Your statement is ready.");
    expect(messageBody({ mimeType: "multipart/mixed", parts: [mail(part("text/plain", JUNK), part("text/html", HTML))] })).toBe("Your statement is ready.");
  });
  test("mapped: the message has the HTML's words, with none of the junk", () => {
    const m = mapGmailMessage({ id: "m1", threadId: "t1", internalDate: "1700000000000", labelIds: ["INBOX"], payload: { ...mail(part("text/plain", JUNK), part("text/html", HTML)), headers: [{ name: "From", value: "A bank <a@bank.example>" }] } }, "owner@example.com");
    expect(m?.text).toBe("Your statement is ready.");
  });
  test("with no HTML part it stays as it was", () => {
    expect(messageBody(part("text/plain", "<body></body>"))).toBe("<body></body>");
  });
  test("real short messages keep their plain part, however short", () => {
    for (const real of ["ok", "好", "はい", "네", "👍", "🇨🇦", "1️⃣", "👨‍👩‍👧", "<3", "a < b", "?", ".", "😀\u200d", "مرحبا", "שלום", "สวัสดี", "ॐ"]) {
      expect(hasVisibleText(real)).toBe(true);
      expect(messageBody(mail(part("text/plain", real), part("text/html", HTML)))).toBe(real);
    }
  });
  test("what counts as nothing", () => {
    for (const none of ["", " ", "\r\n\t", "<body></body>", "<p><br/></p>", "<!-- a comment -->", "<style>p{color:red}</style>", "&nbsp;&#160;&zwnj;", "\u034f\u034f", "\u200b\u2060\ufeff", "\u3164\ufe0f", "\u2800\u2800", "<body>\u034f</body>"]) expect(hasVisibleText(none)).toBe(false);
  });
  // A plain part with an HTML sibling: it runs on the connector's main loop for every read of such a mail.
  for (const [name, plain] of Object.entries({ "unterminated comments": "<!--".repeat(500_000), "unterminated styles": "<style>".repeat(285_000), "open tags": "<a ".repeat(660_000), "less-thans": "<".repeat(2_000_000), "script after script": "<script>".repeat(250_000) }))
    test(`hasVisibleText is linear: ${name} at the 2 MB cap`, () => {
      const t0 = performance.now();
      hasVisibleText(plain);
      expect(performance.now() - t0).toBeLessThan(1500);
    });
});

describe("emailHtmlToText on what would stall a regular expression", () => {
  // It runs on the connector's main loop for every HTML-only email read. These were minutes at this size.
  const SIZE = 2_000_000;
  const cases: Record<string, string> = {
    "unterminated comments": "<!--".repeat(SIZE / 4),
    "unterminated styles": "<style>".repeat(SIZE / 7),
    "links without an end": '<a href="x">'.repeat(SIZE / 12),
    "a long run of blanks": " ".repeat(SIZE) + "x",
    "blanks before no newline": ("x" + " ".repeat(1000)).repeat(SIZE / 1001),
    "less-thans": "<".repeat(SIZE),
    "open tags": "<a ".repeat(SIZE / 3),
  };
  for (const [name, html] of Object.entries(cases))
    test(name, () => {
      const t0 = performance.now();
      emailHtmlToText(html);
      expect(performance.now() - t0).toBeLessThan(1500);
    });
});
