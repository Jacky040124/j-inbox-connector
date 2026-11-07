// The sanitizer reads every Gmail message the connector reads, thousands in a first build: it must give
// back what it takes. Bun 1.3.13 kept every HTMLRewriter onEndTag callback alive forever (fixed in 1.4.0),
// which cost about 0.6 MB a thread read: 792 MB on the owner's Mac mid-build. Counted in objects the
// engine keeps (not in bytes or time), so the check does not depend on the machine.
import { describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { sanitizeEmail } from "../src/gmail/email-html.ts";

const NEWSLETTER =
  "<html><body>" +
  "<table><tr><td style='color:#222'><p>Hello world, some text here for the newsletter.</p><a href='https://x.example.com/a'>link</a></td></tr></table>".repeat(200) +
  "</body></html>";

function kept() {
  Bun.gc(true);
  return heapStats().protectedObjectCount;
}

describe("the sanitizer gives back what it takes", () => {
  test("Bun is 1.4 or later (1.3.x leaks HTMLRewriter's end-tag handlers)", () => {
    const [major, minor] = Bun.version.split(".").map(Number);
    expect(major! > 1 || (major === 1 && minor! >= 4)).toBe(true);
  });

  test("200 newsletters of about 1,000 elements each leave nothing kept", () => {
    expect(sanitizeEmail(NEWSLETTER)).not.toBeNull();
    const before = kept();
    for (let i = 0; i < 200; i++) sanitizeEmail(NEWSLETTER);
    // 1.3.13: about 200,000 more (one per element with an end tag, per email).
    expect(kept() - before).toBeLessThan(1_000);
  });
});
