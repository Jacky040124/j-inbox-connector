import { describe, expect, test } from "bun:test";
import { htmlToPlainText } from "../src/textutil.ts";

describe("htmlToPlainText", () => {
  test("a LinkedIn-style HTML body becomes paragraphs and lines", () => {
    const html = "<p>Hi Jacky</p><br><p>I'm Prabu, Modeling &amp; Simulation. </p><br><p>I'll cover:</p><p>• Automate</p><p>• Reduce costs</p><br><p>Best regards,</p><p>Prabu</p>";
    expect(htmlToPlainText(html)).toBe("Hi Jacky\n\nI'm Prabu, Modeling & Simulation.\n\nI'll cover:\n• Automate\n• Reduce costs\n\nBest regards,\nPrabu");
  });
  test("plain text, including text that merely mentions < and & or a made-up tag, is unchanged", () => {
    for (const s of ["a < b && c > d", "use &amp; in HTML", "<3 you", "x <foo> y", "1 &lt; 2", "a <b> c", "<p> is a tag", "e2e live <b>hello</b> 🚀", "see <div>x</div>"]) expect(htmlToPlainText(s)).toBe(s);
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
  test("text that does not start with a tag is left alone even if it contains HTML", () => {
    expect(htmlToPlainText('look: <a href="https://x.y">x</a>')).toBe('look: <a href="https://x.y">x</a>');
  });
});
