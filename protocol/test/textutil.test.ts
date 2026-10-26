import { describe, expect, test } from "bun:test";
import { sanitizeLine, sanitizeText, truncateText } from "../src/textutil.ts";
import { makeError, errorBody } from "../src/errors.ts";
import { parse, string, text } from "../src/schema.ts";

describe("truncateText", () => {
  test("short strings unchanged", () => expect(truncateText("hello", 10)).toEqual({ text: "hello", truncated: false }));
  test("cuts at the limit", () => expect(truncateText("abcdef", 3)).toEqual({ text: "abc", truncated: true }));
  test("never splits a surrogate pair", () => {
    const r = truncateText("ab😀cd", 3);
    expect(r.text).toBe("ab");
    expect(parse(text({ max: 3 }), r.text).ok).toBe(true);
  });
});

describe("sanitizeText", () => {
  test("keeps newlines, tabs, emoji, RTL, markup", () => {
    const s = "a\nb\tc 👩‍👩‍👧 ‮x <script>alert(1)</script>";
    expect(sanitizeText(s)).toBe(s);
  });
  test("removes NUL and other disallowed controls, repairs lone surrogates", () => {
    const out = sanitizeText("a\u0000b\u0007c\ud800d\u0085e");
    expect(out).toBe("abc�de");
    expect(parse(text({ max: 100 }), out).ok).toBe(true);
  });
});

describe("sanitizeLine", () => {
  test("collapses newlines and controls to spaces and truncates", () => {
    const out = sanitizeLine("Family\nChat\u0000!\r\n", 100);
    expect(out).toBe("Family Chat !");
    expect(parse(string({ max: 100 }), out).ok).toBe(true);
  });
  test("result always validates as a single-line string", () => {
    const hostile = "\u0000\u0001\n".repeat(1000) + "😀".repeat(1000) + "\ud800";
    const out = sanitizeLine(hostile, 50);
    expect(parse(string({ max: 50 }), out).ok).toBe(true);
  });
});

describe("makeError", () => {
  test("clamps long messages without breaking unicode", () => {
    const e = makeError("INTERNAL", "😀".repeat(600));
    expect(parse(errorBody, e).ok).toBe(true);
  });
  test("strips control characters", () => {
    const e = makeError("BAD_PARAMS", "bad\nthing\u0000");
    expect(parse(errorBody, e).ok).toBe(true);
    expect(e.message).toBe("bad thing");
  });
  test("empty message falls back to the code", () => expect(makeError("TIMEOUT", "\n").message).toBe("TIMEOUT"));
});
