import { describe, expect, test } from "bun:test";
import {
  array,
  assetUrl,
  base64,
  boolean,
  cursor,
  discriminated,
  enumOf,
  httpUrl,
  id,
  integer,
  isoDateTime,
  jsonObject,
  literal,
  nullable,
  object,
  optional,
  parse,
  record,
  refine,
  string,
  text,
  formatIssues,
  type Infer,
} from "../src/schema.ts";
import { parseActionResult } from "../src/actions.ts";
import { chat, message } from "./fixtures/examples.ts";

const ok = <T>(r: { ok: boolean; value?: T }) => {
  expect(r.ok).toBe(true);
  return r.value as T;
};
const bad = (r: { ok: boolean; issues?: { path: (string | number)[]; message: string }[] }) => {
  expect(r.ok).toBe(false);
  return r.issues!;
};

describe("string", () => {
  const s = string({ min: 1, max: 5 });
  test("accepts within bounds", () => expect(ok(parse(s, "abc"))).toBe("abc"));
  test("rejects non-strings", () => {
    for (const v of [1, null, undefined, {}, [], true, Symbol.iterator.toString]) bad(parse(s, v));
  });
  test("rejects too short and too long", () => {
    bad(parse(s, ""));
    bad(parse(s, "abcdef"));
  });
  test("length is counted in UTF-16 code units", () => {
    expect(parse(string({ max: 2 }), "😀").ok).toBe(true);
    expect(parse(string({ max: 1 }), "😀").ok).toBe(false);
  });
  test("rejects control characters by default", () => {
    bad(parse(s, "a\u0000b"));
    bad(parse(s, "a\nb"));
    bad(parse(s, "a\u007fb"));
    bad(parse(s, "a\u0085b"));
  });
  test("pattern is enforced", () => {
    const p = string({ max: 10, pattern: /^[a-z]+$/ });
    ok(parse(p, "abc"));
    bad(parse(p, "ABC"));
  });
  test("rejects lone surrogates", () => {
    bad(parse(string({ max: 10 }), "a\ud800b"));
    bad(parse(string({ max: 10 }), "\udc00"));
  });
  test("huge strings fail fast on length", () => {
    const huge = "x".repeat(5_000_000);
    const t0 = performance.now();
    bad(parse(s, huge));
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe("text", () => {
  const t = text({ min: 1, max: 20 });
  test("allows newlines, tabs, RTL marks, emoji and markup as data", () => {
    for (const v of ["line1\nline2", "a\tb", "‮evil", "مرحبا", "👩‍👩‍👧‍👦", "<script>alert(1)</script>".slice(0, 20)]) ok(parse(t, v));
  });
  test("still rejects NUL and other C0 controls", () => {
    bad(parse(t, "a\u0000"));
    bad(parse(t, "a\u0007"));
  });
  test("rejects whitespace-only when min >= 1", () => {
    bad(parse(t, "   \n\t "));
  });
});

describe("id", () => {
  const i = id(64);
  test("accepts Beeper-style ids including ## and !:", () => {
    for (const v of ["imsg##thread:+15550001111", "!abc:beeper.local", "local-whatsapp_ba_X", "1343993"]) ok(parse(i, v));
  });
  test("rejects empty, whitespace, control, too long", () => {
    for (const v of ["", " ", "a b", "a\nb", "x".repeat(65), "​"]) bad(parse(i, v));
  });
});

describe("integer", () => {
  const n = integer({ min: 1, max: 100 });
  test("bounds and integrality", () => {
    ok(parse(n, 1));
    ok(parse(n, 100));
    for (const v of [0, 101, 1.5, NaN, Infinity, -Infinity, "5", null, 2 ** 60]) bad(parse(n, v));
  });
});

describe("boolean / literal / enumOf", () => {
  test("boolean is strict", () => {
    ok(parse(boolean(), true));
    for (const v of ["true", 1, 0, null]) bad(parse(boolean(), v));
  });
  test("literal", () => {
    ok(parse(literal(1), 1));
    bad(parse(literal(1), 2));
    bad(parse(literal("a"), "A"));
  });
  test("enumOf", () => {
    const e = enumOf(["a", "b"] as const);
    ok(parse(e, "a"));
    bad(parse(e, "c"));
    bad(parse(e, "toString"));
    bad(parse(e, "__proto__"));
  });
});

describe("array", () => {
  const a = array(integer({ min: 0, max: 9 }), { max: 3 });
  test("valid", () => expect(ok(parse(a, [1, 2, 3]))).toEqual([1, 2, 3]));
  test("too many items", () => {
    bad(parse(a, [1, 2, 3, 4]));
  });
  test("bad item reports index path", () => {
    const issues = bad(parse(a, [1, "x"]));
    expect(issues[0]!.path).toEqual([1]);
  });
  test("non arrays and array-likes", () => {
    for (const v of [{ length: 1, 0: 1 }, "abc", null]) bad(parse(a, v));
  });
  test("min", () => {
    bad(parse(array(boolean(), { min: 1, max: 2 }), []));
  });
  test("sparse arrays are rejected", () => {
    const sparse = [1, , 3];
    bad(parse(a, sparse));
  });
});

describe("object", () => {
  const o = object({ a: string({ max: 5 }), b: optional(integer({ min: 0, max: 5 })) });
  type O = Infer<typeof o>;
  test("valid with and without optional", () => {
    const v: O = ok(parse(o, { a: "x" }));
    expect(v).toEqual({ a: "x" });
    expect(ok(parse(o, { a: "x", b: 2 }))).toEqual({ a: "x", b: 2 });
  });
  test("missing required", () => {
    const issues = bad(parse(o, {}));
    expect(issues[0]!.path).toEqual(["a"]);
  });
  test("extra fields rejected", () => {
    const issues = bad(parse(o, { a: "x", c: 1 }));
    expect(issues[0]!.path).toEqual(["c"]);
  });
  test("__proto__ smuggling via JSON is rejected", () => {
    bad(parse(o, JSON.parse('{"a":"x","__proto__":{"admin":true}}')));
    bad(parse(o, JSON.parse('{"a":"x","constructor":{"prototype":{}}}')));
  });
  test("explicit undefined for optional is dropped, null is rejected", () => {
    expect(ok(parse(o, { a: "x", b: undefined }))).toEqual({ a: "x" });
    bad(parse(o, { a: "x", b: null }));
  });
  test("non plain objects rejected", () => {
    for (const v of [null, [], "x", new Date(), new Map(), Object.create({ a: "x" })]) bad(parse(o, v));
  });
  test("output is a fresh object", () => {
    const input = { a: "x" };
    const out = ok(parse(o, input));
    expect(out).not.toBe(input);
  });
  test("nested paths", () => {
    const n = object({ inner: object({ x: boolean() }) });
    const issues = bad(parse(n, { inner: { x: "no" } }));
    expect(issues[0]!.path).toEqual(["inner", "x"]);
  });
});

describe("nullable / record / discriminated", () => {
  test("nullable", () => {
    const n = nullable(integer({ min: 0, max: 1 }));
    expect(ok(parse(n, null))).toBe(null);
    bad(parse(n, undefined));
  });
  test("record bounds keys and size", () => {
    const r = record(id(10), boolean(), { max: 2 });
    ok(parse(r, { a: true, b: false }));
    bad(parse(r, { a: true, b: false, c: true }));
    bad(parse(r, { "": true }));
    bad(parse(r, { a: "x" }));
    bad(parse(r, JSON.parse('{"__proto__":true}')));
  });
  test("discriminated union", () => {
    const d = discriminated("type", {
      a: object({ type: literal("a"), x: integer({ min: 0, max: 1 }) }),
      b: object({ type: literal("b"), y: boolean() }),
    });
    ok(parse(d, { type: "a", x: 1 }));
    ok(parse(d, { type: "b", y: true }));
    bad(parse(d, { type: "c" }));
    bad(parse(d, { type: "a", y: true }));
    bad(parse(d, { type: "toString" }));
    bad(parse(d, "a"));
  });
});

describe("specialised strings", () => {
  test("isoDateTime requires a timezone and a real date", () => {
    ok(parse(isoDateTime(), "2026-10-25T12:00:00Z"));
    ok(parse(isoDateTime(), "2026-10-25T12:00:00.123+02:00"));
    for (const v of ["2026-10-25", "2026-10-25T12:00:00", "2026-13-45T12:00:00Z", "yesterday", 1730000000]) bad(parse(isoDateTime(), v));
  });
  test("cursor is printable ASCII and bounded", () => {
    ok(parse(cursor(), "1725489123456|c29tZUltc2dQYWdl"));
    for (const v of ["", "a b", "é", "x".repeat(1025)]) bad(parse(cursor(), v));
  });
  test("base64 is strict", () => {
    ok(parse(base64({ max: 100 }), "aGVsbG8="));
    ok(parse(base64({ max: 100 }), ""));
    for (const v of ["aGVsbG8", "aGV$bG8=", "aGVsbG8=\n", "a===", "x".repeat(101)]) bad(parse(base64({ max: 100 }), v));
  });
  test("assetUrl only allows Beeper media schemes and no traversal", () => {
    for (const v of ["mxc://beeper.com/abc", "localmxc://local-whatsapp/abc", "file:///Users/x/Library/Application%20Support/BeeperTexts/media/a.jpg"]) ok(parse(assetUrl(), v));
    for (const v of [
      "https://evil.example/x.png",
      "javascript:alert(1)",
      "file:///etc/passwd/../x",
      "file:///Users/x/%2e%2e/secret",
      "mxc://",
      "data:text/html,<script>",
      "MXC://upper/case",
      "file://remote-host/share/x",
    ])
      bad(parse(assetUrl(), v));
  });
});

describe("jsonObject", () => {
  const j = jsonObject({ maxDepth: 3, maxKeys: 5 });
  test("plain JSON objects pass", () => {
    ok(parse(j, { a: 1, b: [1, { c: null }] }));
  });
  test("non-objects fail", () => {
    for (const v of [[], null, "x", 1]) bad(parse(j, v));
  });
  test("too deep fails without blowing the stack", () => {
    let deep: unknown = {};
    for (let i = 0; i < 100_000; i++) deep = { d: deep };
    bad(parse(j, deep));
  });
  test("too many keys fails", () => {
    bad(parse(j, { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }));
  });
  test("non-JSON values fail", () => {
    for (const v of [{ a: undefined }, { a: () => 1 }, { a: NaN }, { a: new Date() }, { a: 1n }]) bad(parse(j, v));
  });
});

describe("issue reporting", () => {
  test("issues are capped", () => {
    const a = array(boolean(), { max: 10_000 });
    const issues = bad(parse(a, Array.from({ length: 5000 }, () => "x")));
    expect(issues.length).toBeLessThanOrEqual(20);
  });
  test("messages do not echo the offending value", () => {
    const secret = "SECRET-VALUE-123";
    const issues = bad(parse(integer({ min: 0, max: 1 }), secret));
    expect(JSON.stringify(issues)).not.toContain(secret);
  });
});

describe("refine", () => {
  const range = refine(object({ lo: integer({ min: 0, max: 10 }), hi: integer({ min: 0, max: 10 }) }), (v: { lo: number; hi: number }) => (v.lo <= v.hi ? null : "lo must be <= hi"));
  test("passes when the check passes", () => {
    ok(parse(range, { lo: 1, hi: 2 }));
  });
  test("fails with the check message", () => {
    const issues = bad(parse(range, { lo: 3, hi: 2 }));
    expect(issues[0]!.message).toBe("lo must be <= hi");
  });
  test("inner validation runs first", () => {
    bad(parse(range, { lo: "x", hi: 2 }));
  });
});

describe("discriminated on a boolean key", () => {
  const r = discriminated("ok", {
    true: object({ ok: literal(true), data: integer({ min: 0, max: 9 }) }),
    false: object({ ok: literal(false), error: string({ max: 10 }) }),
  });
  test("both branches", () => {
    ok(parse(r, { ok: true, data: 1 }));
    ok(parse(r, { ok: false, error: "x" }));
  });
  test("string 'true' is not boolean true", () => {
    bad(parse(r, { ok: "true", data: 1 }));
  });
  test("cross-branch fields rejected", () => {
    bad(parse(r, { ok: true, error: "x" }));
  });
});

describe("httpUrl", () => {
  test("https anywhere, http only on loopback", () => {
    for (const v of ["https://inbox.jackyzhonghq.com/pair?code=ABCD-EFGH", "http://127.0.0.1:8787/x", "http://localhost:8787", "http://[::1]:1/"]) ok(parse(httpUrl(), v));
  });
  test("rejects other schemes, credentials, fragments, remote http, garbage", () => {
    for (const v of ["http://evil.example/", "javascript:alert(1)", "https://user:pass@x.com/", "https://x.com/#frag", "ftp://x.com", "not a url", "https://", "//x.com/a", "https://x.com/" + "a".repeat(2100)]) bad(parse(httpUrl(), v));
  });
});

// privacy-r1-P1: issue paths must not carry record keys (chat ids = phone numbers) or unknown keys (arbitrary text).
describe("issue paths never echo input keys", () => {
  const phoneChat = "imsg##thread:+15551234567";
  const sentence = "Hey Bob, the password is hunter2";
  test("record entries are reported under a placeholder, not the raw key", () => {
    const r = parseActionResult("search_messages", { items: [message], chats: { [phoneChat]: { id: "x" } }, hasMore: false, nextCursor: null });
    expect(r.ok).toBe(false);
    const text = formatIssues((r as any).issues);
    expect(text).not.toContain("+15551234567");
    expect(text).not.toContain(phoneChat);
    expect(text).toContain("chats.");
    expect(text).toContain("is required");
  });
  test("an invalid record key is reported without echoing it", () => {
    const r = parse(record(id(64), boolean(), { max: 5 }), { "has space +15551234567": true });
    expect(r.ok).toBe(false);
    expect(formatIssues((r as any).issues)).not.toContain("15551234567");
  });
  test("an unknown sentence-like key is reported at the parent path without echoing it", () => {
    const r = parseActionResult("list_chats", { items: [chat], hasMore: false, nextCursor: null, [sentence]: 1 });
    expect(r.ok).toBe(false);
    const text = formatIssues((r as any).issues);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("unknown field");
  });
  test("an unknown key with a phone number or email is not echoed", () => {
    for (const k of ["+15551234567", "alice@example.com", "x".repeat(41), "ünïcode", "a b"]) {
      const r = parse(object({ a: boolean() }), { a: true, [k]: 1 });
      expect(formatIssues((r as any).issues)).not.toContain(k);
    }
  });
  test("short identifier-like unknown keys are still named, to keep errors useful", () => {
    const r = parse(object({ a: boolean() }), { a: true, injected: 1 });
    expect(formatIssues((r as any).issues)).toBe("injected: unknown field");
  });
});
