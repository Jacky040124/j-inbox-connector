// get_media: allowlist, head, chunking with flow control, size caps, mid-stream failures.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ASSET_URLS, CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { ChunkAssembler, ChunkWindow, MAX_CHUNK_BYTES, MAX_MEDIA_BYTES, MEDIA_WINDOW_CHUNKS, parseConnectorFrame, type ChunkFrame } from "@j-inbox/protocol";
import { createBeeperClient } from "../src/beeper-client.ts";
import { AssetAllowlist } from "../src/assets.ts";
import { openMedia, pumpChunks } from "../src/media.ts";

let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper();
});
afterAll(() => fb.stop());
afterEach(() => fb.reset());

const client = (fetchImpl?: typeof fetch) => createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 3000, ...(fetchImpl ? { fetchImpl } : {}) });
const allowed = (...urls: string[]) => {
  const a = new AssetAllowlist();
  for (const u of urls) a.add(u);
  return a;
};

/** Collect frames; ack each one immediately (like a fast cloud) unless told not to. */
function sink(o: { autoAck?: boolean } = {}) {
  const window = new ChunkWindow();
  const frames: ChunkFrame[] = [];
  const send = (f: ChunkFrame) => {
    expect(parseConnectorFrame(JSON.stringify(f)).ok).toBe(true);
    frames.push(f);
    if (o.autoAck !== false) queueMicrotask(() => window.ack(f.seq));
    return true;
  };
  return { window, frames, send };
}

function streamOf(parts: Uint8Array[], o: { delayMs?: number; failAfter?: number } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    async pull(c) {
      if (o.delayMs) await Bun.sleep(o.delayMs);
      if (o.failAfter !== undefined && i >= o.failAfter) return c.error(new Error("connection reset"));
      if (i >= parts.length) return c.close();
      c.enqueue(parts[i++]!);
    },
  });
}

describe("openMedia", () => {
  test("a URL the connector never returned is NOT_ALLOWED and Beeper is never asked", async () => {
    const r = await openMedia(client(), new AssetAllowlist(), "file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_ALLOWED");
    expect(fb.state.calls.filter((c) => c.route.includes("assets"))).toEqual([]);
  });
  test("an allowed image: head with mime and size, URL passed as an encoded query parameter", async () => {
    const r = await openMedia(client(), allowed(ASSET_URLS.avatar1), ASSET_URLS.avatar1);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.head.mimeType).toBe("image/png");
    expect(r.head.size).toBeGreaterThan(0);
    r.cancel();
    const call = fb.state.calls.find((c) => c.route === "GET /v1/assets/serve")!;
    expect(call.query.url).toEqual([ASSET_URLS.avatar1]);
  });
  test("over MAX_MEDIA_BYTES by Content-Length is TOO_LARGE before any chunk", async () => {
    const r = await openMedia(client(), allowed(ASSET_URLS.fileHuge), ASSET_URLS.fileHuge);
    expect(r.ok ? "ok" : r.error.code).toBe("TOO_LARGE");
  });
  test("missing asset is NOT_FOUND; Beeper down is BEEPER_DOWN", async () => {
    const missing = "mxc://beeper.local/missing_asset";
    expect(((await openMedia(client(), allowed(missing), missing)) as any).error.code).toBe("NOT_FOUND");
    await fb.pause();
    try {
      expect(((await openMedia(client(), allowed(ASSET_URLS.imgSmall), ASSET_URLS.imgSmall)) as any).error.code).toBe("BEEPER_DOWN");
    } finally {
      await fb.resume();
    }
  });
  test("a hostile or missing Content-Type becomes application/octet-stream", async () => {
    const f = (async () => new Response("abc", { headers: { "content-type": "<script>alert(1)</script>" } })) as unknown as typeof fetch;
    const r = await openMedia(client(f), allowed(ASSET_URLS.imgSmall), ASSET_URLS.imgSmall);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.head.mimeType).toBe("application/octet-stream");
    const g = (async () => new Response("abc", { headers: { "content-type": "Image/PNG; charset=binary" } })) as unknown as typeof fetch;
    const r2 = await openMedia(client(g), allowed(ASSET_URLS.imgSmall), ASSET_URLS.imgSmall);
    if (!r2.ok) throw new Error(r2.error.code);
    expect(r2.head.mimeType).toBe("image/png");
  });
  test("the request's head deadline does not cut the body short (long downloads keep going)", async () => {
    const ctl = new AbortController();
    const r = await openMedia(client(), allowed(ASSET_URLS.videoBig), ASSET_URLS.videoBig, ctl.signal);
    if (!r.ok) throw new Error(r.error.code);
    ctl.abort();
    const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
    expect(bytes.length).toBe(r.head.size!);
  });
  test("a cancel before the head arrives aborts the Beeper request", async () => {
    fb.hangNext({ route: "/v1/assets/serve" });
    const ctl = new AbortController();
    const p = openMedia(client(), allowed(ASSET_URLS.imgSmall), ASSET_URLS.imgSmall, ctl.signal);
    await Bun.sleep(50);
    ctl.abort();
    const r = await p;
    expect(r.ok).toBe(false);
  });
  test("a redirect from Beeper is refused (the token must not travel)", async () => {
    fb.failNext({ route: "/v1/assets/serve", status: 302, headers: { location: "http://example.com/x" } });
    const r = await openMedia(client(), allowed(ASSET_URLS.imgSmall), ASSET_URLS.imgSmall);
    expect(r.ok).toBe(false);
  });
});

describe("pumpChunks", () => {
  test("a 3 MiB video arrives intact in <= 256 KiB chunks that the protocol assembler accepts", async () => {
    const r = await openMedia(client(), allowed(ASSET_URLS.videoBig), ASSET_URLS.videoBig);
    if (!r.ok) throw new Error(r.error.code);
    const s = sink();
    const out = await pumpChunks({ id: "m1", body: r.body, size: r.head.size, window: s.window, send: s.send });
    expect(out.ok).toBe(true);
    const asm = new ChunkAssembler({ expectedSize: r.head.size });
    for (const f of s.frames) expect(asm.push(f).error).toBeUndefined();
    expect(asm.done).toBe(true);
    expect(asm.bytes().length).toBe(r.head.size!);
    expect(s.frames.every((f) => Buffer.from(f.data, "base64").length <= MAX_CHUNK_BYTES)).toBe(true);
    expect(s.frames.at(-1)!.last).toBe(true);
    expect(s.frames.filter((f) => f.last).length).toBe(1);
  });
  test("never more than MEDIA_WINDOW_CHUNKS beyond the last ack; resumes when acked", async () => {
    const r = await openMedia(client(), allowed(ASSET_URLS.videoBig), ASSET_URLS.videoBig);
    if (!r.ok) throw new Error(r.error.code);
    const s = sink({ autoAck: false });
    const done = pumpChunks({ id: "m2", body: r.body, size: r.head.size, window: s.window, send: s.send });
    await Bun.sleep(150);
    expect(s.frames.length).toBe(MEDIA_WINDOW_CHUNKS);
    s.window.ack(3);
    await Bun.sleep(50);
    expect(s.frames.length).toBe(MEDIA_WINDOW_CHUNKS + 4);
    for (let i = 0; i < 20; i++) s.window.ack(i);
    expect((await done).ok).toBe(true);
    expect(s.frames.at(-1)!.last).toBe(true);
  });
  test("an empty file is one empty last chunk", async () => {
    const s = sink();
    expect((await pumpChunks({ id: "m3", body: streamOf([]), size: 0, window: s.window, send: s.send })).ok).toBe(true);
    expect(s.frames).toEqual([{ type: "chunk", id: "m3", seq: 0, data: "", last: true }]);
  });
  test("without Content-Length the running total is capped: TOO_LARGE on the last chunk", async () => {
    const big = new Uint8Array(1024 * 1024);
    const s = sink();
    const out = await pumpChunks({ id: "m4", body: streamOf(Array.from({ length: 30 }, () => big)), size: null, window: s.window, send: s.send, maxBytes: 3 * 1024 * 1024 });
    expect(out.ok).toBe(false);
    const last = s.frames.at(-1)!;
    expect(last.last).toBe(true);
    expect(last.error?.code).toBe("TOO_LARGE");
    expect(s.frames.reduce((n, f) => n + Buffer.from(f.data, "base64").length, 0)).toBeLessThanOrEqual(3 * 1024 * 1024);
  });
  test("default cap is MAX_MEDIA_BYTES", () => {
    expect(MAX_MEDIA_BYTES).toBe(25 * 1024 * 1024);
  });
  test("Beeper resetting mid-stream ends with an error chunk, not a hang", async () => {
    const s = sink();
    const out = await pumpChunks({ id: "m5", body: streamOf([new Uint8Array(300_000), new Uint8Array(300_000)], { failAfter: 1 }), size: 600_000, window: s.window, send: s.send });
    expect(out.ok).toBe(false);
    expect(s.frames.at(-1)).toMatchObject({ last: true, error: { code: "BEEPER_DOWN" } });
  });
  test("fewer bytes than declared is an error, never a silently short file", async () => {
    const s = sink();
    const out = await pumpChunks({ id: "m6", body: streamOf([new Uint8Array(10)]), size: 20, window: s.window, send: s.send });
    expect(out.ok).toBe(false);
    expect(s.frames.at(-1)!.error?.code).toBe("INTERNAL");
  });
  test("more bytes than declared stops at the declared size with TOO_LARGE", async () => {
    const s = sink();
    const out = await pumpChunks({ id: "m7", body: streamOf([new Uint8Array(30)]), size: 20, window: s.window, send: s.send });
    expect(out.ok).toBe(false);
    expect(s.frames.at(-1)!.error?.code).toBe("TOO_LARGE");
  });
  test("a Beeper that goes silent mid-stream ends with TIMEOUT after the idle limit", async () => {
    const s = sink();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(5)); } });
    const out = await pumpChunks({ id: "m8", body, size: 10, window: s.window, send: s.send, idleMs: 100 });
    expect(out.ok).toBe(false);
    expect(s.frames.at(-1)!.error?.code).toBe("TIMEOUT");
  });
  test("cancel (signal) stops the stream and releases Beeper's body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await Bun.sleep(5);
        c.enqueue(new Uint8Array(MAX_CHUNK_BYTES));
      },
      cancel() {
        cancelled = true;
      },
    });
    const s = sink({ autoAck: false });
    const ctl = new AbortController();
    const p = pumpChunks({ id: "m9", body, size: null, window: s.window, send: s.send, signal: ctl.signal });
    await Bun.sleep(100);
    ctl.abort();
    const out = await p;
    expect(out.ok).toBe(false);
    expect(cancelled).toBe(true);
  });
  test("a closed socket (send returns false) stops the stream", async () => {
    let n = 0;
    const window = new ChunkWindow();
    const out = await pumpChunks({ id: "m10", body: streamOf(Array.from({ length: 10 }, () => new Uint8Array(MAX_CHUNK_BYTES))), size: null, window, send: () => ++n < 2 });
    expect(out.ok).toBe(false);
    expect(n).toBe(2);
  });
  test("chunks of the media chat round-trip for every fixture asset under the cap", async () => {
    for (const url of [ASSET_URLS.imgSmall, ASSET_URLS.imgMedium, ASSET_URLS.voice, ASSET_URLS.pdf, ASSET_URLS.empty]) {
      const r = await openMedia(client(), allowed(url), url);
      if (!r.ok) throw new Error(`${url} ${r.error.code}`);
      const s = sink();
      expect((await pumpChunks({ id: "rt", body: r.body, size: r.head.size, window: s.window, send: s.send })).ok).toBe(true);
      const asm = new ChunkAssembler({ expectedSize: r.head.size });
      for (const f of s.frames) asm.push(f);
      expect(asm.done).toBe(true);
    }
    expect(CHAT_IDS.media).toBeTruthy();
  });
});
