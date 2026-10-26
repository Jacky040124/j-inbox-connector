import { describe, expect, test } from "bun:test";
import {
  CLOSE_CODES,
  ChunkAssembler,
  backoffDelay,
  byteLength,
  decodeBase64,
  encodeBase64,
  encodeFrame,
  makeChunkFrames,
  parseCloudFrame,
  parseConnectorFrame,
  shouldReconnect,
} from "../src/frames.ts";
import { MAX_CHUNK_BASE64_LENGTH, MAX_CHUNK_BYTES, MAX_FRAME_BYTES, MAX_MEDIA_BYTES, PROTOCOL_VERSION } from "../src/limits.ts";
import { chatID } from "./fixtures/examples.ts";

const hello = {
  type: "hello",
  v: PROTOCOL_VERSION,
  deviceID: "dev_123",
  connectorVersion: "0.1.0",
  beeperVersion: "4.2.1",
  platform: { os: "darwin", arch: "arm64" },
  networks: ["WhatsApp", "iMessage"],
};
const res = { type: "res", id: "r1", ok: true, data: { chatID, pendingMessageID: "p1" } };
const resErr = { type: "res", id: "r1", ok: false, error: { code: "BEEPER_DOWN", message: "Beeper is not responding." } };
const msgEvent = { type: "event", kind: "message", op: "upserted", chatID, messageIDs: ["m1"], ts: "2026-10-25T12:00:00Z" };
const chatEvent = { type: "event", kind: "chat", op: "upserted", chatID, ts: "2026-10-25T12:00:00Z", unreadCount: 3 };
const statusEvent = { type: "event", kind: "status", ts: "2026-10-25T12:00:00Z", beeper: { reachable: false, version: null } };
const chunk = { type: "chunk", id: "r2", seq: 0, data: "aGVsbG8=", last: true };

const welcome = { type: "welcome", v: PROTOCOL_VERSION, serverTime: "2026-10-25T12:00:00Z", heartbeatMs: 25000, requestTimeoutMs: 15000, maxFrameBytes: MAX_FRAME_BYTES };
const req = { type: "req", id: "r1", action: "read_chat", params: { chatID } };

const s = (o: unknown) => JSON.stringify(o);

describe("frames the cloud receives (from the connector)", () => {
  test("valid frames parse", () => {
    for (const f of [hello, { ...hello, capabilities: ["media.v1"], beeperVersion: null }, { type: "ping", t: 1 }, { type: "pong", t: 1 }, res, resErr, msgEvent, chatEvent, statusEvent, chunk, { ...chunk, last: true, data: "", error: { code: "TOO_LARGE", message: "too big" } }]) {
      const r = parseConnectorFrame(s(f));
      if (!r.ok) throw new Error(`${s(f)} -> ${JSON.stringify(r)}`);
    }
  });
  test("frames only the cloud may send are rejected", () => {
    for (const f of [welcome, req, { type: "cancel", id: "r1" }]) expect(parseConnectorFrame(s(f)).ok).toBe(false);
  });
  test("malformed JSON", () => {
    for (const t of ["", "{", "null", "[]", '"hello"', "1", "{'type':'ping'}", "\u0000"]) {
      const r = parseConnectorFrame(t);
      expect(r.ok).toBe(false);
    }
    const r = parseConnectorFrame("{");
    expect(!r.ok && r.error).toBe("BAD_JSON");
  });
  test("unknown type and extra fields", () => {
    expect(parseConnectorFrame(s({ type: "exec", cmd: "rm -rf /" })).ok).toBe(false);
    expect(parseConnectorFrame(s({ ...hello, admin: true })).ok).toBe(false);
    expect(parseConnectorFrame(s({ ...msgEvent, text: "message body must not ride on events" })).ok).toBe(false);
  });
  test("res must be either data or error", () => {
    expect(parseConnectorFrame(s({ type: "res", id: "r1", ok: true })).ok).toBe(false);
    expect(parseConnectorFrame(s({ type: "res", id: "r1", ok: false })).ok).toBe(false);
    expect(parseConnectorFrame(s({ type: "res", id: "r1", ok: true, data: {}, error: { code: "INTERNAL", message: "x" } })).ok).toBe(false);
    expect(parseConnectorFrame(s({ type: "res", id: "r1", ok: false, data: {}, error: { code: "INTERNAL", message: "x" } })).ok).toBe(false);
    expect(parseConnectorFrame(s({ type: "res", id: "r1", ok: "true", data: {} })).ok).toBe(false);
  });
  test("bad request ids", () => {
    for (const id of ["", "a b", "x".repeat(65), "../../", 5, null]) expect(parseConnectorFrame(s({ ...res, id })).ok).toBe(false);
  });
  test("chunk rules", () => {
    expect(parseConnectorFrame(s({ ...chunk, seq: -1 })).ok).toBe(false);
    expect(parseConnectorFrame(s({ ...chunk, seq: 1.5 })).ok).toBe(false);
    expect(parseConnectorFrame(s({ ...chunk, data: "not base64!" })).ok).toBe(false);
    expect(parseConnectorFrame(s({ ...chunk, last: false, error: { code: "INTERNAL", message: "x" } })).ok).toBe(false);
  });
  test("event rules", () => {
    expect(parseConnectorFrame(s({ ...msgEvent, messageIDs: [] })).ok).toBe(false);
    expect(parseConnectorFrame(s({ ...msgEvent, messageIDs: Array.from({ length: 101 }, (_, i) => `m${i}`) })).ok).toBe(false);
    expect(parseConnectorFrame(s({ ...msgEvent, kind: "typing" })).ok).toBe(false);
    expect(parseConnectorFrame(s({ ...msgEvent, op: "edited" })).ok).toBe(false);
    expect(parseConnectorFrame(s({ ...chatEvent, unreadCount: -1 })).ok).toBe(false);
  });
  test("hello rules", () => {
    expect(parseConnectorFrame(s({ ...hello, v: 0 })).ok).toBe(false);
    expect(parseConnectorFrame(s({ ...hello, v: "1" })).ok).toBe(false);
    expect(parseConnectorFrame(s({ ...hello, networks: Array.from({ length: 51 }, () => "X") })).ok).toBe(false);
    expect(parseConnectorFrame(s({ ...hello, deviceID: "<script>" })).ok).toBe(false);
  });
  test("future protocol versions still parse so the cloud can answer VERSION_UNSUPPORTED", () => {
    const r = parseConnectorFrame(s({ ...hello, v: 2 }));
    expect(r.ok).toBe(true);
  });
  test("oversized frames are rejected before JSON parsing", () => {
    const big = s({ ...res, data: { blob: "x".repeat(MAX_FRAME_BYTES) } });
    const t0 = performance.now();
    const r = parseConnectorFrame(big);
    expect(!r.ok && r.error).toBe("TOO_LARGE");
    expect(performance.now() - t0).toBeLessThan(50);
  });
  test("multi-byte characters count as bytes, not code units", () => {
    const n = Math.floor(MAX_FRAME_BYTES / 3);
    const r = parseConnectorFrame(s({ ...res, data: { blob: "中".repeat(n) } }));
    expect(!r.ok && r.error).toBe("TOO_LARGE");
  });
  test("binary input: valid UTF-8 parses, invalid UTF-8 fails", () => {
    expect(parseConnectorFrame(new TextEncoder().encode(s({ type: "ping", t: 1 }))).ok).toBe(true);
    expect(parseConnectorFrame(new Uint8Array([0x7b, 0xff, 0x7d])).ok).toBe(false);
    expect(parseConnectorFrame(new TextEncoder().encode(s({ type: "ping", t: 1 })).buffer).ok).toBe(true);
  });
  test("deeply nested data does not crash", () => {
    const deep = "[".repeat(50_000) + "]".repeat(50_000);
    const r = parseConnectorFrame(`{"type":"res","id":"r1","ok":true,"data":${deep}}`);
    expect(r.ok).toBe(false);
  });
  test("__proto__ in a frame is rejected", () => {
    expect(parseConnectorFrame('{"type":"ping","t":1,"__proto__":{"x":1}}').ok).toBe(false);
  });
});

describe("frames the connector receives (from the cloud)", () => {
  test("valid", () => {
    for (const f of [welcome, req, { type: "cancel", id: "r1" }, { type: "ping", t: 5 }, { type: "pong", t: 5 }]) {
      const r = parseCloudFrame(s(f));
      if (!r.ok) throw new Error(JSON.stringify(r));
    }
  });
  test("req with a non-catalogue action is rejected at frame level", () => {
    for (const action of ["delete_everything", "__proto__", "SEND_MESSAGE", ""]) expect(parseCloudFrame(s({ ...req, action })).ok).toBe(false);
  });
  test("req params must be a JSON object (shape checked later per action)", () => {
    expect(parseCloudFrame(s({ ...req, params: [] })).ok).toBe(false);
    expect(parseCloudFrame(s({ ...req, params: "x" })).ok).toBe(false);
    expect(parseCloudFrame(s({ ...req, params: { anything: 1 } })).ok).toBe(true);
  });
  test("frames only the connector may send are rejected", () => {
    for (const f of [hello, res, chunk, msgEvent]) expect(parseCloudFrame(s(f)).ok).toBe(false);
  });
});

describe("encodeFrame", () => {
  test("round trips", () => {
    const e = encodeFrame(res as any);
    expect(e.ok).toBe(true);
    if (e.ok) expect(JSON.parse(e.value)).toEqual(res);
  });
  test("refuses invalid frames", () => {
    expect(encodeFrame({ type: "nope" } as any).ok).toBe(false);
  });
  test("refuses oversized frames", () => {
    const r = encodeFrame({ type: "res", id: "r1", ok: true, data: { blob: "x".repeat(MAX_FRAME_BYTES) } } as any);
    expect(!r.ok && r.error).toBe("TOO_LARGE");
  });
});

describe("byteLength", () => {
  test("counts UTF-8 bytes", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("中")).toBe(3);
    expect(byteLength("😀")).toBe(4);
  });
});

describe("base64 helpers", () => {
  test("round trip arbitrary bytes", () => {
    const bytes = new Uint8Array(1000).map((_, i) => (i * 37) % 256);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    expect(encodeBase64(new Uint8Array())).toBe("");
  });
  test("decode rejects invalid input", () => {
    expect(() => decodeBase64("@@@")).toThrow();
  });
});

describe("makeChunkFrames + ChunkAssembler", () => {
  test("split and reassemble", () => {
    const bytes = new Uint8Array(MAX_CHUNK_BYTES * 2 + 10).map((_, i) => i % 251);
    const frames = makeChunkFrames("r9", bytes);
    expect(frames.length).toBe(3);
    expect(frames.map((f) => f.last)).toEqual([false, false, true]);
    for (const f of frames) expect(parseConnectorFrame(JSON.stringify(f)).ok).toBe(true);
    const a = new ChunkAssembler({ expectedSize: bytes.length });
    for (const f of frames) expect(a.push(f).error).toBeUndefined();
    expect(a.done).toBe(true);
    expect(a.bytes()).toEqual(bytes);
  });
  test("empty file is one empty last chunk", () => {
    const frames = makeChunkFrames("r9", new Uint8Array());
    expect(frames).toEqual([{ type: "chunk", id: "r9", seq: 0, data: "", last: true }]);
  });
  test("out of order chunk is an error", () => {
    const frames = makeChunkFrames("r9", new Uint8Array(MAX_CHUNK_BYTES + 1));
    const a = new ChunkAssembler({ expectedSize: MAX_CHUNK_BYTES + 1 });
    expect(a.push(frames[1]!).error).toBe("BAD_PARAMS");
  });
  test("duplicate chunk is an error", () => {
    const frames = makeChunkFrames("r9", new Uint8Array(MAX_CHUNK_BYTES + 1));
    const a = new ChunkAssembler({ expectedSize: MAX_CHUNK_BYTES + 1 });
    a.push(frames[0]!);
    expect(a.push(frames[0]!).error).toBe("BAD_PARAMS");
  });
  test("more bytes than declared is TOO_LARGE", () => {
    const frames = makeChunkFrames("r9", new Uint8Array(100));
    const a = new ChunkAssembler({ expectedSize: 50 });
    expect(a.push(frames[0]!).error).toBe("TOO_LARGE");
  });
  test("fewer bytes than declared on last chunk is an error", () => {
    const frames = makeChunkFrames("r9", new Uint8Array(10));
    const a = new ChunkAssembler({ expectedSize: 50 });
    expect(a.push(frames[0]!).error).toBe("INTERNAL");
  });
  test("a chunk carrying an error ends the stream with that error", () => {
    const a = new ChunkAssembler({ expectedSize: 50 });
    expect(a.push({ type: "chunk", id: "x", seq: 0, data: "", last: true, error: { code: "BEEPER_DOWN", message: "gone" } }).error).toBe("BEEPER_DOWN");
  });
  test("cannot exceed MAX_MEDIA_BYTES even if declared larger", () => {
    const a = new ChunkAssembler({ expectedSize: MAX_MEDIA_BYTES + 10 });
    expect(a.error).toBe("TOO_LARGE");
  });
  test("pushing after done is an error", () => {
    const frames = makeChunkFrames("r9", new Uint8Array(1));
    const a = new ChunkAssembler({ expectedSize: 1 });
    a.push(frames[0]!);
    expect(a.push(frames[0]!).error).toBe("BAD_PARAMS");
  });
  test("streaming mode passes chunks through without buffering", () => {
    const frames = makeChunkFrames("r9", new Uint8Array(MAX_CHUNK_BYTES + 5));
    const seen: number[] = [];
    const a = new ChunkAssembler({ expectedSize: MAX_CHUNK_BYTES + 5, onBytes: (b) => seen.push(b.length) });
    for (const f of frames) a.push(f);
    expect(seen).toEqual([MAX_CHUNK_BYTES, 5]);
    expect(() => a.bytes()).toThrow();
  });
});

describe("close codes and reconnect policy", () => {
  test("codes are in the private 4000-4999 range except standard ones", () => {
    for (const [k, v] of Object.entries(CLOSE_CODES)) if (!["NORMAL", "GOING_AWAY"].includes(k)) expect(v >= 4000 && v < 5000).toBe(true);
  });
  test("no reconnect after auth failure, revocation or version mismatch", () => {
    expect(shouldReconnect(CLOSE_CODES.UNAUTHENTICATED)).toBe(false);
    expect(shouldReconnect(CLOSE_CODES.REVOKED)).toBe(false);
    expect(shouldReconnect(CLOSE_CODES.VERSION_UNSUPPORTED)).toBe(false);
    expect(shouldReconnect(CLOSE_CODES.REPLACED)).toBe(false);
  });
  test("reconnect on network-ish closes", () => {
    for (const c of [1000, 1001, 1006, 1011, CLOSE_CODES.HEARTBEAT_TIMEOUT, CLOSE_CODES.BAD_FRAME, CLOSE_CODES.TOO_LARGE]) expect(shouldReconnect(c)).toBe(true);
  });
  test("backoff doubles from 1s and caps at 60s, with jitter within bounds", () => {
    expect(backoffDelay(0, () => 0.5)).toBe(1000);
    expect(backoffDelay(1, () => 0.5)).toBe(2000);
    expect(backoffDelay(2, () => 0.5)).toBe(4000);
    expect(backoffDelay(10, () => 0.5)).toBe(60000);
    expect(backoffDelay(1000, () => 0.5)).toBe(60000);
    for (const r of [0, 0.999]) {
      const d = backoffDelay(3, () => r);
      expect(d).toBeGreaterThanOrEqual(8000 * 0.8);
      expect(d).toBeLessThanOrEqual(8000 * 1.2);
    }
    expect(backoffDelay(-5, () => 0.5)).toBe(1000);
    expect(backoffDelay(NaN, () => 0.5)).toBe(1000);
  });
});

// stability-r1-R1-03: media flow control, idle timeout scaled by size, unknown size.
import { ChunkWindow, mediaDeadlineMs } from "../src/frames.ts";
import { MAX_CONCURRENT_MEDIA_STREAMS, MEDIA_IDLE_TIMEOUT_MS, MEDIA_MAX_TOTAL_MS, MEDIA_TIMEOUT_MS, MEDIA_WINDOW_CHUNKS } from "../src/limits.ts";
import { parseActionResult } from "../src/actions.ts";

describe("media flow control (ack frames)", () => {
  test("the cloud may send ack {id, seq}; the connector may not", () => {
    expect(parseCloudFrame(s({ type: "ack", id: "r2", seq: 3 })).ok).toBe(true);
    expect(parseConnectorFrame(s({ type: "ack", id: "r2", seq: 3 })).ok).toBe(false);
    for (const bad of [{ type: "ack", id: "r2" }, { type: "ack", id: "r2", seq: -1 }, { type: "ack", id: "r2", seq: 1.5 }, { type: "ack", id: "a b", seq: 1 }, { type: "ack", id: "r2", seq: 1, extra: 1 }])
      expect(parseCloudFrame(s(bad)).ok).toBe(false);
    expect(encodeFrame({ type: "ack", id: "r2", seq: 0 } as any).ok).toBe(true);
  });
  test("accept() awaits a slow consumer before acking, so the window really bounds memory", async () => {
    const bytes = new Uint8Array(MAX_CHUNK_BYTES * 3);
    const frames = makeChunkFrames("r9", bytes);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = new ChunkAssembler({ expectedSize: bytes.length, onBytes: () => gate });
    let settled = false;
    const p = a.accept(frames[0]!).then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    release();
    expect(await p).toEqual({ ack: { type: "ack", id: "r9", seq: 0 } });
    expect((await a.accept(frames[1]!)).ack?.seq).toBe(1);
    expect((await a.accept(frames[2]!)).ack?.seq).toBe(2);
    expect(a.done).toBe(true);
  });
  test("accept() reports errors without acking", async () => {
    const frames = makeChunkFrames("r9", new Uint8Array(MAX_CHUNK_BYTES + 1));
    const a = new ChunkAssembler({ expectedSize: MAX_CHUNK_BYTES + 1, onBytes: async () => {} });
    expect(await a.accept(frames[1]!)).toEqual({ error: "BAD_PARAMS" });
  });
  test("a consumer that throws fails the stream with INTERNAL", async () => {
    const frames = makeChunkFrames("r9", new Uint8Array(10));
    const a = new ChunkAssembler({ expectedSize: 10, onBytes: async () => { throw new Error("writer closed"); } });
    expect(await a.accept(frames[0]!)).toEqual({ error: "INTERNAL" });
  });
  test("ChunkWindow: the connector sends at most MEDIA_WINDOW_CHUNKS ahead of the last ack", async () => {
    const w = new ChunkWindow();
    for (let seq = 0; seq < MEDIA_WINDOW_CHUNKS; seq++) expect(w.canSend(seq)).toBe(true);
    expect(w.canSend(MEDIA_WINDOW_CHUNKS)).toBe(false);
    let opened = false;
    const waiting = w.waitFor(MEDIA_WINDOW_CHUNKS).then(() => (opened = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(opened).toBe(false);
    w.ack(0);
    await waiting;
    expect(opened).toBe(true);
    expect(w.canSend(MEDIA_WINDOW_CHUNKS + 1)).toBe(false);
  });
  test("ChunkWindow ignores stale or bogus acks and fails waiters on close", async () => {
    const w = new ChunkWindow(2);
    w.ack(1);
    w.ack(0); // stale
    expect(w.canSend(3)).toBe(true);
    expect(w.canSend(4)).toBe(false);
    for (const bogus of [-1, 1.5, Number.NaN, 10_000_000]) w.ack(bogus);
    expect(w.canSend(4)).toBe(false);
    const p = w.waitFor(10);
    w.close();
    await expect(p).rejects.toThrow(/closed/);
    await expect(w.waitFor(11)).rejects.toThrow(/closed/);
  });
  test("ChunkWindow wait honours an abort signal", async () => {
    const w = new ChunkWindow(1);
    const ac = new AbortController();
    const p = w.waitFor(5, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
    await expect(w.waitFor(6, ac.signal)).rejects.toThrow(/aborted/);
  });
});

describe("media timing and sizes", () => {
  test("deadline grows with size instead of a fixed 60 s to the last chunk", () => {
    expect(mediaDeadlineMs(0)).toBeGreaterThanOrEqual(MEDIA_TIMEOUT_MS);
    // a 25 MiB file over a 2 Mbit/s uplink (about 105 s of transfer) must fit
    expect(mediaDeadlineMs(MAX_MEDIA_BYTES)).toBeGreaterThan(MEDIA_TIMEOUT_MS + 105_000);
    expect(mediaDeadlineMs(MAX_MEDIA_BYTES)).toBeLessThanOrEqual(MEDIA_MAX_TOTAL_MS);
    expect(mediaDeadlineMs(null)).toBe(MEDIA_MAX_TOTAL_MS);
    expect(mediaDeadlineMs(-5)).toBeGreaterThanOrEqual(MEDIA_TIMEOUT_MS);
    expect(MEDIA_IDLE_TIMEOUT_MS).toBeLessThan(MEDIA_TIMEOUT_MS);
  });
  test("size may be null (no Content-Length); the assembler then enforces a running cap", () => {
    expect(parseActionResult("get_media", { mimeType: "video/mp4", size: null }).ok).toBe(true);
    const frames = makeChunkFrames("r9", new Uint8Array(MAX_CHUNK_BYTES + 3));
    const a = new ChunkAssembler({ expectedSize: null });
    for (const f of frames) expect(a.push(f).error).toBeUndefined();
    expect(a.done).toBe(true);
    expect(a.bytes().length).toBe(MAX_CHUNK_BYTES + 3);
  });
  test("unknown size still stops at MAX_MEDIA_BYTES", () => {
    const a = new ChunkAssembler({ expectedSize: null, onBytes: () => {} });
    const data = encodeBase64(new Uint8Array(MAX_CHUNK_BYTES));
    let err: string | undefined;
    for (let seq = 0; seq <= MAX_MEDIA_BYTES / MAX_CHUNK_BYTES && !err; seq++) err = a.push({ type: "chunk", id: "r", seq, data, last: false }).error;
    expect(err).toBe("TOO_LARGE");
  });
  test("bounded memory: concurrent streams x window stays far below the 128 MB Durable Object limit", () => {
    expect(MAX_CONCURRENT_MEDIA_STREAMS).toBeLessThanOrEqual(8);
    const worst = MAX_CONCURRENT_MEDIA_STREAMS * MEDIA_WINDOW_CHUNKS * (MAX_CHUNK_BYTES + MAX_CHUNK_BASE64_LENGTH * 2);
    expect(worst).toBeLessThan(32 * 1024 * 1024);
  });
});

// stability-r2-R2-11: waitFor must not leave abort listeners on a long-lived signal.
describe("ChunkWindow abort listeners", () => {
  function countingSignal() {
    const ctl = new AbortController();
    const live = new Set<unknown>();
    const signal = ctl.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    (signal as any).addEventListener = (t: string, fn: any, o?: any) => (t === "abort" && live.add(fn), add(t, fn, o));
    (signal as any).removeEventListener = (t: string, fn: any, o?: any) => (t === "abort" && live.delete(fn), remove(t, fn, o));
    return { signal, ctl, live };
  }
  test("waits resolved by ack() remove their listener", async () => {
    const { signal, live } = countingSignal();
    const w = new ChunkWindow(1);
    for (let seq = 1; seq <= 90; seq++) {
      const p = w.waitFor(seq, signal); // blocks: seq > lastAck + 1
      expect(live.size).toBe(1);
      w.ack(seq - 1);
      await p;
    }
    expect(live.size).toBe(0);
  });
  test("waits rejected by close() remove their listener too", async () => {
    const { signal, live } = countingSignal();
    const w = new ChunkWindow(1);
    const pending = [5, 6, 7].map((s) => w.waitFor(s, signal).catch(() => "closed"));
    expect(live.size).toBe(3);
    w.close();
    expect(await Promise.all(pending)).toEqual(["closed", "closed", "closed"]);
    expect(live.size).toBe(0);
  });
  test("abort still rejects a pending wait", async () => {
    const { signal, ctl } = countingSignal();
    const w = new ChunkWindow(1);
    const p = w.waitFor(9, signal);
    ctl.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});
