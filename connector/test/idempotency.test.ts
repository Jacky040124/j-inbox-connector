// stability-r1-R1-01: the connector never calls Beeper twice for the same write key.
import { describe, expect, test } from "bun:test";
import { IdempotencyCache } from "../src/idempotency.ts";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

describe("IdempotencyCache", () => {
  test("a repeated key replays the first result without running again", async () => {
    const c = new IdempotencyCache<string>();
    let runs = 0;
    const fn = async () => `r${++runs}`;
    expect(await c.run("send_message:k1", fn)).toBe("r1");
    expect(await c.run("send_message:k1", fn)).toBe("r1");
    expect(runs).toBe(1);
    expect(await c.run("send_message:k2", fn)).toBe("r2");
  });
  test("a duplicate that arrives while the first is in flight shares it", async () => {
    const c = new IdempotencyCache<string>();
    const d = deferred<string>();
    let runs = 0;
    const fn = () => (runs++, d.promise);
    const a = c.run("k", fn);
    const b = c.run("k", fn);
    d.resolve("done");
    expect(await Promise.all([a, b])).toEqual(["done", "done"]);
    expect(runs).toBe(1);
  });
  test("results the caller marks as not-done are forgotten so a retry runs", async () => {
    const c = new IdempotencyCache<{ code?: string }>({ remember: (r) => r.code !== "BEEPER_DOWN" });
    let runs = 0;
    expect(await c.run("k", async () => (runs++, { code: "BEEPER_DOWN" }))).toEqual({ code: "BEEPER_DOWN" });
    expect(await c.run("k", async () => (runs++, {}))).toEqual({});
    expect(await c.run("k", async () => (runs++, { code: "X" }))).toEqual({});
    expect(runs).toBe(2);
  });
  test("a thrown error is not remembered and is rethrown", async () => {
    const c = new IdempotencyCache<string>();
    await expect(c.run("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await c.run("k", async () => "ok")).toBe("ok");
  });
  test("entries expire after the TTL", async () => {
    let now = 0;
    const c = new IdempotencyCache<string>({ ttlMs: 1000, now: () => now });
    let runs = 0;
    await c.run("k", async () => `r${++runs}`);
    now = 999;
    expect(await c.run("k", async () => `r${++runs}`)).toBe("r1");
    now = 1000;
    expect(await c.run("k", async () => `r${++runs}`)).toBe("r2");
  });
  test("size is bounded; the oldest settled entries go first, in-flight ones are kept", async () => {
    const c = new IdempotencyCache<string>({ max: 3 });
    const d = deferred<string>();
    const inflight = c.run("inflight", () => d.promise);
    for (let i = 0; i < 10; i++) await c.run(`k${i}`, async () => `v${i}`);
    expect(c.size).toBeLessThanOrEqual(3);
    let reran = false;
    const again = c.run("inflight", async () => ((reran = true), "second"));
    d.resolve("first");
    expect(await again).toBe("first");
    expect(await inflight).toBe("first");
    expect(reran).toBe(false);
  });
  test("hostile keys are just strings (no prototype tricks)", async () => {
    const c = new IdempotencyCache<string>();
    expect(await c.run("__proto__", async () => "a")).toBe("a");
    expect(await c.run("constructor", async () => "b")).toBe("b");
    expect(await c.run("__proto__", async () => "c")).toBe("a");
  });
});

// stability-r2-R2-2 / tests-r2-TQ2-01: a key reused with different parameters is a conflict, never a replay.
describe("IdempotencyCache fingerprints", () => {
  test("the same key with a different fingerprint answers the conflict result and does not run", async () => {
    const c = new IdempotencyCache<string>({ conflict: () => "CONFLICT" });
    let runs = 0;
    expect(await c.run("k", async () => `r${++runs}`, { fingerprint: "a" })).toBe("r1");
    expect(await c.run("k", async () => `r${++runs}`, { fingerprint: "b" })).toBe("CONFLICT");
    expect(await c.run("k", async () => `r${++runs}`, { fingerprint: "a" })).toBe("r1");
    expect(runs).toBe(1);
  });
  test("a conflicting duplicate that arrives while the first is in flight is refused too", async () => {
    const c = new IdempotencyCache<string>({ conflict: () => "CONFLICT" });
    const d = deferred<string>();
    const a = c.run("k", () => d.promise, { fingerprint: "a" });
    expect(await c.run("k", async () => "other", { fingerprint: "b" })).toBe("CONFLICT");
    d.resolve("first");
    expect(await a).toBe("first");
  });
});

// stability-r2-R2-1: the cache survives a connector restart through an on-disk journal.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIdempotencyJournal } from "../src/idempotency.ts";

describe("IdempotencyCache with a FileIdempotencyJournal (restart safety)", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "jinbox-idem-"));
    dirs.push(d);
    return join(d, "sub", "idempotency.json");
  };
  const make = (path: string, now = () => Date.now()) =>
    new IdempotencyCache<{ ok: boolean; v?: string; code?: string }>({
      journal: new FileIdempotencyJournal(path),
      now,
      interrupted: () => ({ ok: false, code: "UNKNOWN_OUTCOME" }),
      conflict: () => ({ ok: false, code: "CONFLICT" }),
      remember: (r) => r.code !== "BEEPER_DOWN",
    });
  const cleanup = () => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  };

  test("the in-flight state is on disk before the write runs", async () => {
    const path = tmp();
    const c = make(path);
    let seenOnDisk = "";
    await c.run("send_message\u0000chat\u0000key_1", async () => ((seenOnDisk = readFileSync(path, "utf8")), { ok: true, v: "p1" }), { fingerprint: "f1" });
    expect(seenOnDisk).toContain('"inflight"');
    expect(readFileSync(path, "utf8")).toContain('"done"');
    cleanup();
  });
  test("a write that was in flight when the process died answers interrupted after restart, and never runs again", async () => {
    const path = tmp();
    const first = make(path);
    void first.run("k", () => new Promise(() => {}), { fingerprint: "f" }); // process "dies" mid-write
    const second = make(path);
    let reran = false;
    expect(await second.run("k", async () => ((reran = true), { ok: true }), { fingerprint: "f" })).toEqual({ ok: false, code: "UNKNOWN_OUTCOME" });
    expect(reran).toBe(false);
    cleanup();
  });
  test("a finished write replays its stored result after restart; a different fingerprint is still a conflict", async () => {
    const path = tmp();
    await make(path).run("k", async () => ({ ok: true, v: "p1" }), { fingerprint: "f" });
    const again = make(path);
    expect(await again.run("k", async () => ({ ok: true, v: "p2" }), { fingerprint: "f" })).toEqual({ ok: true, v: "p1" });
    expect(await again.run("k", async () => ({ ok: true, v: "p3" }), { fingerprint: "g" })).toEqual({ ok: false, code: "CONFLICT" });
    cleanup();
  });
  test("results that prove nothing happened are removed from the journal, so a retry after restart runs", async () => {
    const path = tmp();
    await make(path).run("k", async () => ({ ok: false, code: "BEEPER_DOWN" }), { fingerprint: "f" });
    expect(await make(path).run("k", async () => ({ ok: true, v: "p2" }), { fingerprint: "f" })).toEqual({ ok: true, v: "p2" });
    cleanup();
  });
  test("entries older than the TTL are dropped on load", async () => {
    const path = tmp();
    let now = 1_000_000;
    await make(path, () => now).run("k", async () => ({ ok: true, v: "p1" }), { fingerprint: "f" });
    now += 60 * 60_000;
    expect(await make(path, () => now).run("k", async () => ({ ok: true, v: "p2" }), { fingerprint: "f" })).toEqual({ ok: true, v: "p2" });
    cleanup();
  });
  test("the journal holds hashes, never raw keys or chat ids, and is private to the user", async () => {
    const path = tmp();
    await make(path).run("send_message\u0000imsg##thread:+15551234567\u0000my_secret_key_123", async () => ({ ok: true, v: "p1" }), { fingerprint: "f" });
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("my_secret_key_123");
    expect(text).not.toContain("+15551234567");
    expect(Bun.file(path).size).toBeGreaterThan(0);
    const { statSync } = await import("node:fs");
    expect(statSync(path).mode & 0o077).toBe(0);
    cleanup();
  });
  test("a corrupt or hostile journal file loads as empty instead of crashing", async () => {
    for (const body of ["{not json", "[]", JSON.stringify({ v: 1, entries: [{ k: 1 }, null, { k: "__proto__", fp: "x", state: "done", at: 1 }] }), "x".repeat(10_000)]) {
      const path = tmp();
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body);
      expect(await make(path).run("k", async () => ({ ok: true, v: "fresh" }), { fingerprint: "f" })).toEqual({ ok: true, v: "fresh" });
    }
    cleanup();
  });
  test("if the journal cannot be written, the write is not dispatched", async () => {
    const path = tmp();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(path, ".."), { recursive: true });
    chmodSync(join(path, ".."), 0o500);
    let ran = false;
    try {
      await expect(make(path).run("k", async () => ((ran = true), { ok: true }), { fingerprint: "f" })).rejects.toThrow();
      expect(ran).toBe(false);
    } finally {
      chmodSync(join(path, ".."), 0o700);
      cleanup();
    }
    expect(existsSync(path)).toBe(false);
  });
});
