// The shipped Beeper client: never leaks the token through redirects or path tricks, bounds memory
// on chunked bodies (stability-r2-R2-9, tests-r2-TQ2-03), maps 5xx on writes to UNKNOWN_OUTCOME
// (spec-r2-R2-SPEC-1) and 401 to a distinct, non-retryable BEEPER_UNAUTHORIZED (spec-r2-R2-SPEC-5).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { isRetryable } from "@j-inbox/protocol";
import { beeperErrorCode, createBeeperClient } from "../src/beeper-client.ts";

let fb: FakeBeeper;
let trap: ReturnType<typeof Bun.serve>;
const trapped: { method: string; auth: string | null }[] = [];
let lying: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  fb = await startFakeBeeper();
  trap = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      trapped.push({ method: req.method, auth: req.headers.get("authorization") });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });
  lying = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/big-cl") return new Response("x".repeat(2 * 1024 * 1024), { headers: { "content-type": "application/json" } });
      if (path === "/chunked") {
        // Endless body without Content-Length: only a running byte count can stop it.
        const block = new Uint8Array(64 * 1024).fill(0x61);
        let timer: ReturnType<typeof setInterval>;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            timer = setInterval(() => {
              try {
                c.enqueue(block);
              } catch {
                clearInterval(timer);
              }
            }, 2);
          },
          cancel() {
            clearInterval(timer);
          },
        });
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
      if (path === "/multibyte") {
        const bytes = new TextEncoder().encode(JSON.stringify({ s: "語".repeat(400 * 1024) }));
        return new Response(new ReadableStream({ start: (c) => (c.enqueue(bytes), c.close()) }), { headers: { "content-type": "application/json" } });
      }
      return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    },
  });
});
afterAll(() => {
  fb.stop();
  trap.stop(true);
  lying.stop(true);
});
afterEach(() => {
  fb.reset();
  trapped.length = 0;
});

const trapURL = () => `http://127.0.0.1:${trap.port}/stolen`;

describe("token never leaves the Beeper origin", () => {
  test("a redirect from Beeper is not followed, for GET and for writes", async () => {
    const c = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 2000 });
    fb.failNext({ method: "GET", status: 302, headers: { location: trapURL() } });
    const r1 = await c.get("/v1/accounts");
    fb.failNext({ method: "POST", status: 307, headers: { location: trapURL() } });
    const r2 = await c.write("POST", c.chatPath(CHAT_IDS.imessageAlice, "messages"), { text: "x" });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    await Bun.sleep(50);
    expect(trapped).toEqual([]);
  });
  test("a path that escapes the origin (//evil.host, absolute URL) is refused before fetch", async () => {
    const seen: string[] = [];
    const spy = (async (u: any) => (seen.push(String(u)), new Response("{}"))) as unknown as typeof fetch;
    const c = createBeeperClient({ baseURL: fb.url, token: fb.token, fetchImpl: spy });
    for (const p of ["//evil.host/v1/chats", `http://127.0.0.1:${trap.port}/x`, "https://evil.host/"]) {
      expect((await c.get(p)).ok).toBe(false);
      expect((await c.write("POST", p, {})).ok).toBe(false);
    }
    expect(seen).toEqual([]);
  });
});

describe("body size cap bounds memory", () => {
  test("Content-Length over the cap is TOO_LARGE without reading", async () => {
    const c = createBeeperClient({ baseURL: `http://127.0.0.1:${lying.port}`, token: "t", maxBodyBytes: 1024 * 1024 });
    const r = await c.get("/big-cl");
    expect(r.ok ? null : r.error.code).toBe("TOO_LARGE");
  });
  test("an endless chunked body is cut off as soon as it passes the cap (no buffering until timeout)", async () => {
    const c = createBeeperClient({ baseURL: `http://127.0.0.1:${lying.port}`, token: "t", maxBodyBytes: 1024 * 1024, timeoutMs: 8_000 });
    const t0 = performance.now();
    const r = await c.get("/chunked");
    expect(r.ok ? null : r.error.code).toBe("TOO_LARGE");
    expect(performance.now() - t0).toBeLessThan(4000);
  });
  test("the cap counts bytes, not UTF-16 units", async () => {
    // ~1.2 MiB of UTF-8 but only ~400k UTF-16 units.
    const c = createBeeperClient({ baseURL: `http://127.0.0.1:${lying.port}`, token: "t", maxBodyBytes: 1024 * 1024 });
    const r = await c.get("/multibyte");
    expect(r.ok ? null : r.error.code).toBe("TOO_LARGE");
  });
  test("a body under the cap still parses", async () => {
    const c = createBeeperClient({ baseURL: `http://127.0.0.1:${lying.port}`, token: "t", maxBodyBytes: 1024 * 1024 });
    const r = await c.get("/small");
    expect(r.ok && r.body).toEqual({ ok: true });
  });
});

describe("status mapping", () => {
  test("Beeper 5xx on a write may have happened: UNKNOWN_OUTCOME, never retryable", () => {
    for (const status of [500, 502, 503, 504]) {
      const code = beeperErrorCode({ status, write: true });
      expect(`${status} ${code}`).toBe(`${status} UNKNOWN_OUTCOME`);
      expect(isRetryable(code, "send_message")).toBe(false);
    }
  });
  test("Beeper 5xx on a read is BEEPER_DOWN", () => {
    for (const status of [500, 502, 503]) expect(beeperErrorCode({ status, write: false })).toBe("BEEPER_DOWN");
  });
  test("Beeper 401 (token revoked) is BEEPER_UNAUTHORIZED for reads and writes, and not retryable", () => {
    expect(beeperErrorCode({ status: 401, write: false })).toBe("BEEPER_UNAUTHORIZED");
    expect(beeperErrorCode({ status: 401, write: true })).toBe("BEEPER_UNAUTHORIZED");
    expect(isRetryable("BEEPER_UNAUTHORIZED", "read_chat")).toBe(false);
  });
  test("a revoked token against the fake gives BEEPER_UNAUTHORIZED with a fix-it message", async () => {
    const c = createBeeperClient({ baseURL: fb.url, token: "not-a-valid-token" });
    const r = await c.get("/v1/accounts");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("BEEPER_UNAUTHORIZED");
      expect(r.error.message).toMatch(/doctor/);
    }
  });
});
