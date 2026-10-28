import { describe, expect, test } from "bun:test";
import { htmlToPlainText } from "../src/textutil.ts";

describe("htmlToPlainText", () => {
  test("a LinkedIn-style HTML body becomes paragraphs and lines", () => {
    const html = "<p>Hi Jacky</p><br><p>I'm Prabu, Modeling &amp; Simulation. </p><br><p>I'll cover:</p><p>• Automate</p><p>• Reduce costs</p><br><p>Best regards,</p><p>Prabu</p>";
    expect(htmlToPlainText(html)).toBe("Hi Jacky\n\nI'm Prabu, Modeling & Simulation.\n\nI'll cover:\n• Automate\n• Reduce costs\n\nBest regards,\nPrabu");
  });
  test("plain text, including text that merely mentions < and & or a made-up tag, is unchanged", () => {
    for (const s of ["a < b && c > d", "<3 you", "x <foo> y", "a <b> c", "<p> is a tag", "e2e live <b>hello</b> 🚀", "see <div>x</div>", "AT&T", "&copy; stays"]) expect(htmlToPlainText(s)).toBe(s);
  });
  test("plain text with the basic escaped characters is decoded (X, some SMS senders)", () => {
    expect(htmlToPlainText("Drake is my goat &amp; he's")).toBe("Drake is my goat & he's");
    expect(htmlToPlainText("Msg&amp;Data rates may apply")).toBe("Msg&Data rates may apply");
    expect(htmlToPlainText("1 &lt; 2 &quot;ok&quot; it&#39;s")).toBe('1 < 2 "ok" it\'s');
    expect(htmlToPlainText("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });
  test("WhatsApp / X bridge bodies: text with <br> and links anywhere become lines (real chats, 2026-10-28)", () => {
    expect(htmlToPlainText("Feel free to add me<br>@theloudmell<br><br>If you guys are interested, dm! <br>")).toBe("Feel free to add me\n@theloudmell\n\nIf you guys are interested, dm!");
    expect(htmlToPlainText('Sign up! <br>PSA: it is 10$.<br><br><a href="https://luma.com/9pjp?a=1&amp;b=2">https://luma.com/9pjp?a=1&amp;b=2</a>')).toBe("Sign up!\nPSA: it is 10$.\n\nhttps://luma.com/9pjp?a=1&b=2");
    expect(htmlToPlainText("if anyone's in sf! <br><br>lmk :)<br><a>luma.com/udcuuz69</a>")).toBe("if anyone's in sf!\n\nlmk :)\nluma.com/udcuuz69");
    expect(htmlToPlainText('look: <a href="https://x.y/z">the doc</a>')).toBe("look: the doc (https://x.y/z)");
  });
  test("a mention linking to matrix.to reads as the name", () => {
    expect(htmlToPlainText('<a href="https://matrix.to/#/@jackyzhong:beeper.com">@JackyZhong0124</a> + <a href="https://matrix.to/#/@twitter_1:beeper.local">@imnotchalk</a> you guys coming?')).toBe("@JackyZhong0124 + @imnotchalk you guys coming?");
  });
  test("lists, links, entities and attributes", () => {
    expect(htmlToPlainText('<div><ul><li>one</li><li><a href="https://x.y">two</a></li></ul></div>')).toBe("• one\n• two (https://x.y)");
    expect(htmlToPlainText("<p><b>&lt;script&gt;</b> &#39;q&#x27; &nbsp;&#128512;</p>")).toBe("<script> 'q'  😀");
    expect(htmlToPlainText("<p>bad &#xD800; &#99999999; &bogus;</p>")).toBe("bad &#xD800; &#99999999; &bogus;");
  });
  test("output never re-creates tags from encoded input in a way that is then stripped again", () => {
    expect(htmlToPlainText("<p>&lt;p&gt;hi&lt;/p&gt;</p>")).toBe("<p>hi</p>");
  });
});

describe("htmlToPlainText: shared posts and links (Instagram)", () => {
  test("a body that starts with <strong> and ends in a link becomes text plus the bare link", () => {
    const html = '<strong>gdgutsg LARPING MEETS HACKATHON!!\n\nAre you a seasoned LARPer …</strong><p><a href="https://www.instagram.com/p/DewgZgURy_3/?is_sponsored=false&amp;x=1" rel="noopener noreferrer" target="_blank">https://www.instagram.com/p/DewgZgURy_3/</a></p>';
    expect(htmlToPlainText(html)).toBe("gdgutsg LARPING MEETS HACKATHON!!\n\nAre you a seasoned LARPer …\nhttps://www.instagram.com/p/DewgZgURy_3/?is_sponsored=false&x=1");
  });
  test("a link whose text differs keeps both", () => {
    expect(htmlToPlainText('<p>See <a href="https://x.y/z">the post</a></p>')).toBe("See the post (https://x.y/z)");
  });
  test("text that does not start with a tag and has no line break or link is left alone", () => {
    expect(htmlToPlainText("look: <b>x</b> and <i>y</i>")).toBe("look: <b>x</b> and <i>y</i>");
  });
});

import { parseSharedPost } from "../src/textutil.ts";
import { parse } from "../src/schema.ts";
import { sharedPost } from "../src/model.ts";

describe("parseSharedPost", () => {
  const ig = '<strong>gdgutsg LARPING MEETS HACKATHON!!\n\nAre you a seasoned LARPer …</strong><p><a href="https://www.instagram.com/p/DewgZgURy_3/?is_sponsored=false&amp;x=1" rel="noopener noreferrer" target="_blank">https://www.instagram.com/p/DewgZgURy_3/</a></p>';
  test("an Instagram share: author, caption and link, valid per the protocol", () => {
    const p = parseSharedPost(ig)!;
    expect(p).toEqual({ network: "Instagram", author: "gdgutsg", caption: "LARPING MEETS HACKATHON!!\n\nAre you a seasoned LARPer …", url: "https://www.instagram.com/p/DewgZgURy_3/?is_sponsored=false&x=1" });
    expect(parse(sharedPost, p).ok).toBe(true);
  });
  test("not a share: plain text, other hosts, http links, javascript links, extra text after the link", () => {
    for (const s of [
      "hello",
      '<strong>a b</strong><p><a href="https://evil.example/p/1">x</a></p>',
      '<strong>a b</strong><p><a href="http://www.instagram.com/p/1">x</a></p>',
      '<strong>a b</strong><p><a href="javascript:alert(1)">x</a></p>',
      '<strong>a b</strong><p><a href="https://www.instagram.com/p/1">x</a></p> and more',
      '<strong>a b</strong><p><a href="https://www.instagram.com.evil.com/p/1">x</a></p>',
    ])
      expect(parseSharedPost(s)).toBeNull();
  });
  test("markup inside the caption stays text", () => {
    const p = parseSharedPost('<strong>bob &lt;script&gt;alert(1)&lt;/script&gt;</strong><a href="https://www.instagram.com/reel/X/">x</a>')!;
    expect(p.caption).toBe("<script>alert(1)</script>");
  });
});
