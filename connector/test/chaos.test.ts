// Chaos: the real link + whitelist + Beeper client against fake Beeper and a hostile or flaky fake
// cloud. Dropped and garbled frames, 100 concurrent requests, slow / failing / oversized Beeper,
// unknown actions, reconnect storms; after every scenario nothing is left in flight.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ASSET_URLS, CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { parseConnectorFrame } from "@j-inbox/protocol";
import { createActions } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";
import { createBeeperClient } from "../src/beeper-client.ts";
import { CloudLink } from "../src/cloud-link.ts";
import { createDispatcher } from "../src/dispatcher.ts";
import { startFakeCloud, type FakeCloud, type Reply } from "./helpers/fake-cloud.ts";

const TOKEN = "jid_" + "Z".repeat(43);
let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper();
});
afterAll(() => fb.stop());
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  fb.reset();
});

async function rig(o: { requestTimeoutMs?: number; maxBodyBytes?: number; backoff?: (n: number) => number; maxConcurrent?: number; stableMs?: number } = {}) {
  const cloud = await startFakeCloud({ token: TOKEN, welcome: { requestTimeoutMs: o.requestTimeoutMs ?? 15_000 } });
  const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 10_000, ...(o.maxBodyBytes ? { maxBodyBytes: o.maxBodyBytes } : {}) });
  const assets = new AssetAllowlist();
  const dispatcher = createDispatcher({ actions: createActions(client, { assets }), client, assets });
  const link = new CloudLink({
    url: cloud.url,
    token: TOKEN,
    deviceID: "dev_chaos",
    connectorVersion: "0.1.0",
    hello: async () => ({ beeperVersion: null, networks: [] }),
    dispatcher,
    backoff: o.backoff ?? (() => 20),
    ...(o.maxConcurrent ? { maxConcurrent: o.maxConcurrent } : {}),
    ...(o.stableMs ? { stableMs: o.stableMs } : {}),
  });
  cleanup.push(() => cloud.stop());
  cleanup.push(() => link.stop(0));
  link.start();
  await cloud.waitFor(() => link.state.status === "connected", 4000, "connected");
  return { cloud, link, assets };
}

const idle = (link: CloudLink) => {
  const s = link.stats();
  return s.pending === 0 && s.queued === 0 && s.running === 0 && s.media === 0;
};
const settle = (cloud: FakeCloud, link: CloudLink, ms = 5000) => cloud.waitFor(() => idle(link), ms, `idle ${JSON.stringify(link.stats())}`);
const resFrames = (cloud: FakeCloud) => cloud.frames.filter((f) => f.frame.type === "res").map((f) => f.frame as any);

describe("chaos", () => {
  test("100 concurrent mixed requests: each answered exactly once with a valid frame; over the cap is RATE_LIMITED, never dropped", async () => {
    fb.controls.latencyMs = 20;
    const { cloud, link } = await rig();
    const actions = [
      () => ["list_chats", { limit: 5 }],
      () => ["read_chat", { chatID: CHAT_IDS.longHistory, limit: 10 }],
      () => ["unread_summary", {}],
      () => ["search_messages", { query: "dinner" }],
      () => ["status", {}],
    ] as const;
    const replies = await Promise.all(Array.from({ length: 100 }, (_, i) => cloud.req(...(actions[i % actions.length]!() as unknown as [string, unknown]), { timeoutMs: 15_000 })));
    const codes = replies.map((r) => (r.res.ok ? "ok" : r.res.error!.code));
    expect(codes.every((c) => c === "ok" || c === "RATE_LIMITED")).toBe(true);
    expect(codes.filter((c) => c === "ok").length).toBeGreaterThanOrEqual(32);
    const ids = resFrames(cloud).map((f) => f.id);
    expect(new Set(ids).size).toBe(100);
    expect(ids.length).toBe(100);
    for (const t of cloud.raw) expect(parseConnectorFrame(t).ok).toBe(true);
    await settle(cloud, link);
  }, 30_000);
  test("100 requests in waves under the in-flight cap all succeed", async () => {
    const { cloud, link } = await rig();
    for (let w = 0; w < 4; w++) {
      const rs = await Promise.all(Array.from({ length: 25 }, () => cloud.req("list_chats", { limit: 3 })));
      expect(rs.every((r) => r.res.ok)).toBe(true);
    }
    await settle(cloud, link);
  }, 30_000);
  test("garbled, truncated, binary, deeply nested, oversized and prototype-polluting frames: ignored or refused, link stays up", async () => {
    const { cloud, link } = await rig();
    const junk: (string | Uint8Array)[] = [
      "",
      "{",
      "null",
      "[]",
      '{"type":"req"}',
      '{"type":"req","id":"g1","action":"read_chat","params":{"chatID":"' + "x".repeat(600) + '"}}',
      '{"type":"req","id":"g2","action":"status","params":[]}',
      '{"type":"req","id":"g3","action":"status","params":{},"extra":1}',
      '{"type":"req","id":"g4","action":"status","params":{"__proto__":{"polluted":true}}}',
      '{"__proto__":{"polluted":true},"type":"ping","t":1}',
      "[".repeat(20_000) + "]".repeat(20_000),
      JSON.stringify({ type: "req", id: "g5", action: "list_chats", params: { query: "x".repeat(1_100_000) } }),
      new Uint8Array([0xc3, 0x28, 0xa0, 0xa1]),
      new Uint8Array(2048).fill(0xff),
      '{"type":"ack","id":"nope","seq":3}',
      '{"type":"cancel","id":"nope"}',
      '{"type":"welcome","v":1,"serverTime":"2026-10-25T00:00:00.000Z","heartbeatMs":1000,"requestTimeoutMs":1000,"maxFrameBytes":1024}',
      '{"type":"pong","t":-1}',
      "\u0000\u0001\u0002",
    ];
    for (const j of junk) cloud.sendRaw(j);
    for (let i = 0; i < 200; i++) cloud.send({ type: "ping", t: i });
    const r = await cloud.req("list_chats", { limit: 2 });
    expect(r.res.ok).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
    expect(link.state.status).toBe("connected");
    const answered = new Map(resFrames(cloud).map((f) => [f.id, f.error?.code]));
    expect(answered.get("g1")).toBe("BAD_PARAMS");
    expect(answered.get("g2")).toBe("BAD_PARAMS");
    expect(answered.get("g3")).toBe("BAD_PARAMS");
    expect(answered.get("g4")).toBe("BAD_PARAMS");
    expect(fb.state.calls.filter((c) => c.route !== "GET /v1/chats")).toEqual([]);
    await settle(cloud, link);
  }, 30_000);
  test("1000 unknown actions: all NOT_ALLOWED, Beeper never called", async () => {
    const { cloud, link } = await rig();
    const names = ["delete_chat", "rm", "exec", "shell", "__proto__", "constructor", "hasOwnProperty", "whoami", "approval_status", "STATUS"];
    const rs = await Promise.all(Array.from({ length: 1000 }, (_, i) => cloud.req(names[i % names.length]!, {}, { timeoutMs: 15_000 })));
    expect(rs.every((r) => r.res.error?.code === "NOT_ALLOWED")).toBe(true);
    expect(fb.state.calls).toEqual([]);
    await settle(cloud, link);
  }, 30_000);
  test("the cloud drops the socket mid-traffic, repeatedly: no crash, reconnects, nothing leaks, answers resume", async () => {
    fb.controls.latencyMs = 30;
    const { cloud, link } = await rig();
    for (let round = 0; round < 5; round++) {
      const pending = Array.from({ length: 20 }, () => cloud.req("read_chat", { chatID: CHAT_IDS.longHistory, limit: 20 }, { timeoutMs: 1500 }).catch(() => null));
      await Bun.sleep(10 + round * 7);
      cloud.terminate();
      await Promise.all(pending);
      await cloud.waitFor(() => link.state.status === "connected" && cloud.open === 1, 4000, "reconnected");
    }
    const r = await cloud.req("list_chats", { limit: 2 });
    expect(r.res.ok).toBe(true);
    await settle(cloud, link);
  }, 30_000);
  test("reconnect storm: a cloud that closes right after welcome is retried with growing delays, not in a tight loop", async () => {
    const attempts: number[] = [];
    const { cloud, link } = await rig({ backoff: (n) => (attempts.push(n), Math.min(10 * 2 ** n, 160)), stableMs: 60_000 });
    let closing = true;
    const t0 = Date.now();
    const killer = (async () => {
      while (closing) {
        if (cloud.open) cloud.close(1011, "storm");
        await Bun.sleep(2);
      }
    })();
    await Bun.sleep(1200);
    closing = false;
    await killer;
    const n = cloud.connections;
    expect(n).toBeLessThan(15);
    expect(attempts.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Date.now() - t0).toBeGreaterThan(1000);
    await cloud.waitFor(() => link.state.status === "connected", 4000, "calm again");
    expect((await cloud.req("status")).res.ok).toBe(true);
    await settle(cloud, link);
  }, 30_000);
  test("slow Beeper: TIMEOUT before the cloud's deadline, no late answers, nothing left running", async () => {
    fb.controls.latencyMs = 3000;
    const { cloud, link } = await rig({ requestTimeoutMs: 1000 });
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: 10 }, () => cloud.req("read_chat", { chatID: CHAT_IDS.imessageAlice })));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(rs.every((r) => r.res.error?.code === "TIMEOUT")).toBe(true);
    await Bun.sleep(300);
    expect(resFrames(cloud).length).toBe(10);
    expect(link.answeredLate).toBe(0);
    await settle(cloud, link, 4000);
  }, 30_000);
  test("Beeper 500s: reads BEEPER_DOWN (retryable), writes UNKNOWN_OUTCOME and a same-key retry is not re-sent", async () => {
    const { cloud, link } = await rig();
    fb.failNext({ route: "/v1/chats", status: 500, times: 50 });
    expect((await cloud.req("list_chats", {})).res.error?.code).toBe("BEEPER_DOWN");
    fb.failNext({ route: "/v1/chats/{chatID}/messages", method: "POST", status: 500 });
    const p = { chatID: CHAT_IDS.imessageAlice, text: "hello", idempotencyKey: "chaos_key_0001" };
    expect((await cloud.req("send_message", p)).res.error?.code).toBe("UNKNOWN_OUTCOME");
    expect((await cloud.req("send_message", p)).res.error?.code).toBe("UNKNOWN_OUTCOME");
    expect(fb.writes().length).toBe(1);
    await settle(cloud, link);
  }, 30_000);
  test("oversized and malformed Beeper answers: TOO_LARGE / BEEPER_DOWN, never a crash or a half frame", async () => {
    const { cloud, link } = await rig({ maxBodyBytes: 256 * 1024 });
    fb.failNext({ route: "/v1/chats", status: 200, rawBody: JSON.stringify({ items: [], pad: "x".repeat(600 * 1024) }) });
    expect((await cloud.req("list_chats", {})).res.error?.code).toBe("TOO_LARGE");
    fb.failNext({ route: "/v1/chats", status: 200, rawBody: "{not json" });
    expect((await cloud.req("list_chats", {})).res.error?.code).toBe("BEEPER_DOWN");
    fb.failNext({ route: "/v1/chats", status: 200, rawBody: JSON.stringify({ items: "nope" }) });
    expect((await cloud.req("list_chats", {})).res.error?.code).toBe("BEEPER_DOWN");
    fb.failNext({ route: "/v1/chats", status: 200, rawBody: JSON.stringify({ items: [{ id: 5 }, null, "x", { id: "ok", accountID: "a", title: "<script>" }], hasMore: false }) });
    const r = await cloud.req("list_chats", {});
    expect(r.res.ok).toBe(true);
    expect((r.res.data as any).items.length).toBe(1);
    await settle(cloud, link);
  }, 30_000);
  test("Beeper goes away mid-media-stream and media cancel storms: every stream ends, media slots return to 0", async () => {
    const { cloud, link, assets } = await rig();
    assets.add(ASSET_URLS.videoBig);
    cloud.state.autoAck = false;
    for (let i = 0; i < 4; i++) cloud.send({ type: "req", id: `mv${i}`, action: "get_media", params: { url: ASSET_URLS.videoBig } });
    await cloud.waitFor(() => link.stats().media === 4, 3000, "4 streams");
    for (let i = 0; i < 4; i++) cloud.send({ type: "cancel", id: `mv${i}` });
    await settle(cloud, link);
    cloud.state.autoAck = true;
    const replies: Promise<Reply>[] = [];
    for (let i = 0; i < 3; i++) replies.push(cloud.req("get_media", { url: ASSET_URLS.videoBig }, { timeoutMs: 10_000 }));
    const done = await Promise.all(replies);
    for (const r of done) expect(r.chunks.at(-1)!.last).toBe(true);
    await settle(cloud, link);
  }, 30_000);
  test("the cloud vanishes while media and requests are in flight: everything is released", async () => {
    fb.controls.latencyMs = 50;
    const { cloud, link, assets } = await rig();
    assets.add(ASSET_URLS.videoBig);
    cloud.state.autoAck = false;
    cloud.send({ type: "req", id: "mx1", action: "get_media", params: { url: ASSET_URLS.videoBig } });
    for (let i = 0; i < 10; i++) cloud.send({ type: "req", id: `rx${i}`, action: "list_chats", params: {} });
    await Bun.sleep(30);
    cloud.terminate();
    await cloud.waitFor(() => link.state.status === "connected", 4000, "back");
    await settle(cloud, link);
  }, 30_000);
});
