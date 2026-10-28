// Cloud link: device-token upgrade, hello/welcome, request handling with deadlines, bounded
// concurrency and queue, cancel, heartbeat, reconnect with backoff, stop codes, graceful shutdown.
import { afterEach, describe, expect, test } from "bun:test";
import { CLOSE_CODES, makeError, parseConnectorFrame, type ErrorCode } from "@j-inbox/protocol";
import { CloudLink, type CloudLinkOptions } from "../src/cloud-link.ts";
import type { DispatchResult } from "../src/dispatcher.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const TOKEN = "jid_" + "A".repeat(43);
const clouds: FakeCloud[] = [];
const links: CloudLink[] = [];
afterEach(async () => {
  for (const l of links.splice(0)) await l.stop(0);
  for (const c of clouds.splice(0)) c.stop();
});

type Impl = (action: string, params: any, ctx: { signal?: AbortSignal }) => Promise<DispatchResult>;
const okRes = (data: unknown): DispatchResult => ({ kind: "res", ok: true, data });
const errRes = (code: ErrorCode): DispatchResult => ({ kind: "res", ok: false, error: makeError(code, code) });
const WRITES = new Set(["send_message", "react", "mark_read", "archive", "draft_reply"]);

function dispatcher(impl: Impl = async (a) => okRes({ echo: a })) {
  const calls: string[] = [];
  let running = 0;
  let maxRunning = 0;
  return {
    calls,
    get maxRunning() {
      return maxRunning;
    },
    get running() {
      return running;
    },
    isWrite: (a: string) => WRITES.has(a),
    async dispatch(action: string, params: unknown, ctx: { signal?: AbortSignal } = {}) {
      calls.push(action);
      running++;
      maxRunning = Math.max(maxRunning, running);
      try {
        return await impl(action, params, ctx);
      } finally {
        running--;
      }
    },
  };
}

/** Resolves after ms, or when the signal aborts (like a well-behaved action). */
const slow = (ms: number, then: DispatchResult = okRes({ slow: true })): Impl => (_a, _p, ctx) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(then), ms);
    ctx.signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve(errRes("TIMEOUT"));
    });
  });

async function setup(o: { cloud?: Parameters<typeof startFakeCloud>[0]; link?: Partial<CloudLinkOptions>; impl?: Impl } = {}) {
  const cloud = await startFakeCloud({ token: TOKEN, ...o.cloud });
  clouds.push(cloud);
  const d = dispatcher(o.impl);
  let welcomes = 0;
  const link = new CloudLink({
    url: cloud.url,
    token: TOKEN,
    deviceID: "dev_test1",
    connectorVersion: "0.1.0",
    hello: async () => ({ beeperVersion: "4.2.1", networks: ["iMessage", "WhatsApp"] }),
    dispatcher: d,
    onWelcome: () => void welcomes++,
    backoff: () => 30,
    ...o.link,
  });
  links.push(link);
  link.start();
  await cloud.waitFor(() => link.state.status === "connected", 3000, "connected");
  return { cloud, link, d, welcomes: () => welcomes };
}

describe("connect", () => {
  test("upgrades with the device token as a Bearer header and no Origin; hello is a valid frame", async () => {
    const { cloud, welcomes } = await setup();
    expect(cloud.upgrades[0]).toEqual({ auth: `Bearer ${TOKEN}`, origin: null });
    const hello = cloud.hello()!;
    expect(hello).toMatchObject({ type: "hello", deviceID: "dev_test1", connectorVersion: "0.1.0", beeperVersion: "4.2.1", networks: ["iMessage", "WhatsApp"], platform: { os: expect.any(String), arch: expect.any(String) } });
    expect(welcomes()).toBe(1);
  });
  test("hello survives a failing or hostile hello provider (null version, valid networks only)", async () => {
    const { cloud } = await setup({ link: { hello: async () => ({ beeperVersion: "x".repeat(500), networks: ["", "ok", "y".repeat(100), 5 as any] }) } });
    expect(cloud.hello()).toMatchObject({ beeperVersion: null, networks: ["ok"] });
    const c2 = await setup({ link: { hello: () => Promise.reject(new Error("beeper down")) } });
    expect(c2.cloud.hello()).toMatchObject({ beeperVersion: null, networks: [] });
  });
  test("refuses a non-loopback http:// cloud URL (the token must not travel in clear text)", () => {
    expect(() => new CloudLink({ url: "http://inbox.example.com", token: TOKEN, deviceID: "d", connectorVersion: "1", hello: async () => ({ beeperVersion: null, networks: [] }), dispatcher: dispatcher() })).toThrow();
  });
});

describe("requests", () => {
  test("answers a req with the dispatcher's result", async () => {
    const { cloud } = await setup();
    const r = await cloud.req("status", {});
    expect(r.res).toEqual({ type: "res", id: r.res.id, ok: true, data: { echo: "status" } });
  });
  test("the req's optional caller reaches onRequest (for the local audit log); without one there is none", async () => {
    const logs: any[] = [];
    const { cloud } = await setup({ link: { onRequest: (r) => logs.push(r) } });
    cloud.send({ type: "req", id: "rc1", action: "status", params: {}, caller: { type: "agent", name: "龙虾" } });
    await cloud.waitFor(() => logs.length === 1, 3000, "first log");
    await cloud.req("status", {});
    await cloud.waitFor(() => logs.length === 2, 3000, "second log");
    expect(logs[0]).toMatchObject({ action: "status", ok: true, caller: { type: "agent", name: "龙虾" } });
    expect(logs[1].caller).toBeUndefined();
  });
  test("hello announces the protocol's capabilities", async () => {
    const { cloud } = await setup();
    const { CAPABILITIES } = await import("@j-inbox/protocol");
    expect((cloud.hello() as any).capabilities).toEqual(Object.values(CAPABILITIES));
  });
  test("unknown actions are NOT_ALLOWED; non-object params BAD_PARAMS; garbage ignored; link stays up", async () => {
    const { cloud, d, link } = await setup();
    cloud.sendRaw("{not json");
    cloud.sendRaw(JSON.stringify({ type: "nonsense" }));
    cloud.sendRaw(new Uint8Array([0xff, 0xfe, 0x00]));
    const unknown = await cloud.req("delete_everything", {});
    expect(unknown.res.error?.code).toBe("NOT_ALLOWED");
    const proto = await cloud.req("__proto__", {});
    expect(proto.res.error?.code).toBe("NOT_ALLOWED");
    // The cloud's own actions (the snooze store) are never the connector's to run.
    const snooze = await cloud.req("snooze_chat", { chatID: "imsg##thread:+1", until: new Date(Date.now() + 3600_000).toISOString() });
    expect(snooze.res.error?.code).toBe("NOT_ALLOWED");
    const bad = await cloud.req("list_chats", "params");
    expect(bad.res.error?.code).toBe("BAD_PARAMS");
    expect(d.calls).toEqual([]);
    expect((await cloud.req("status")).res.ok).toBe(true);
    expect(link.state.status).toBe("connected");
  });
  test("a req whose id is invalid gets no answer (nothing to address) and does not crash", async () => {
    const { cloud, d } = await setup();
    cloud.send({ type: "req", id: "bad id!", action: "status", params: {} });
    cloud.send({ type: "req", id: "x".repeat(65), action: "status", params: {} });
    await Bun.sleep(50);
    expect(d.calls).toEqual([]);
    expect(cloud.frames.filter((f) => f.frame.type === "res")).toEqual([]);
  });
  test("a slow read answers TIMEOUT within requestTimeoutMs; a write in flight answers UNKNOWN_OUTCOME", async () => {
    const hang: Impl = () => new Promise(() => {});
    const { cloud, link } = await setup({ cloud: { welcome: { requestTimeoutMs: 1000 } }, impl: hang });
    const t0 = Date.now();
    const r = await cloud.req("read_chat", { chatID: "x" });
    expect(r.res.error?.code).toBe("TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(1000);
    const w = await cloud.req("send_message", { chatID: "x", text: "y" });
    expect(w.res.error?.code).toBe("UNKNOWN_OUTCOME");
    expect(link.answeredLate).toBe(0);
  });
  test("the action gets an abort signal at its deadline, and the pending map drains", async () => {
    const { cloud, link } = await setup({ cloud: { welcome: { requestTimeoutMs: 1000 } }, impl: slow(60_000) });
    await cloud.req("list_chats", {});
    await cloud.waitFor(() => link.pendingCount === 0, 2000, "drain");
  });
  test("bounded concurrency: never more than maxConcurrent dispatches at once, all answered", async () => {
    const { cloud, d } = await setup({ impl: slow(40), link: { maxConcurrent: 3 } });
    const rs = await Promise.all(Array.from({ length: 12 }, () => cloud.req("status")));
    expect(rs.every((r) => r.res.ok)).toBe(true);
    expect(d.maxRunning).toBe(3);
  });
  test("past maxPending, requests are RATE_LIMITED at once and never dispatched", async () => {
    const { cloud, d, link } = await setup({ impl: slow(200), link: { maxConcurrent: 2, maxPending: 4 } });
    const rs = await Promise.all(Array.from({ length: 10 }, () => cloud.req("status")));
    const codes = rs.map((r) => (r.res.ok ? "ok" : r.res.error!.code));
    expect(codes.filter((c) => c === "ok").length).toBe(4);
    expect(codes.filter((c) => c === "RATE_LIMITED").length).toBe(6);
    expect(d.calls.length).toBe(4);
    await cloud.waitFor(() => link.pendingCount === 0, 2000, "drain");
  });
  test("a queued request whose deadline passes is answered TIMEOUT and never dispatched", async () => {
    const { cloud, d } = await setup({ cloud: { welcome: { requestTimeoutMs: 1000 } }, impl: slow(5000), link: { maxConcurrent: 1 } });
    const [a, b] = await Promise.all([cloud.req("status"), cloud.req("status")]);
    expect(a.res.error?.code).toBe("TIMEOUT");
    expect(b.res.error?.code).toBe("TIMEOUT");
    expect(d.calls.length).toBe(1);
  });
  test("cancel aborts the action and sends no answer", async () => {
    let aborted = false;
    const impl: Impl = (_a, _p, ctx) =>
      new Promise((resolve) =>
        ctx.signal?.addEventListener("abort", () => {
          aborted = true;
          resolve(errRes("TIMEOUT"));
        }),
      );
    const { cloud, link } = await setup({ impl });
    cloud.send({ type: "req", id: "c1", action: "list_chats", params: {} });
    await cloud.waitFor(() => link.pendingCount === 1, 1000, "pending");
    cloud.send({ type: "cancel", id: "c1" });
    await cloud.waitFor(() => aborted, 1000, "aborted");
    await cloud.waitFor(() => link.pendingCount === 0, 1000, "drain");
    await Bun.sleep(30);
    expect(cloud.frames.filter((f) => f.frame.type === "res")).toEqual([]);
  });
  test("a duplicate req id while the first is pending is not dispatched twice", async () => {
    const { cloud, d } = await setup({ impl: slow(100) });
    cloud.send({ type: "req", id: "dup1", action: "send_message", params: {} });
    cloud.send({ type: "req", id: "dup1", action: "send_message", params: {} });
    await Bun.sleep(250);
    expect(d.calls.length).toBe(1);
    expect(cloud.frames.filter((f) => f.frame.type === "res").length).toBe(1);
  });
  test("a result too big for one frame is answered TOO_LARGE", async () => {
    const { cloud } = await setup({ impl: async () => okRes({ blob: "x".repeat(1_100_000) }) });
    expect((await cloud.req("status")).res.error?.code).toBe("TOO_LARGE");
  });
  test("every frame the connector sends is valid per the protocol", async () => {
    const { cloud } = await setup();
    await cloud.req("status");
    for (const t of cloud.raw) expect(parseConnectorFrame(t).ok).toBe(true);
    expect(cloud.bad).toEqual([]);
  });
});

describe("media", () => {
  const bytes = new Uint8Array(3 * 256 * 1024 + 17).map((_, i) => i % 251);
  const mediaImpl: Impl = async () => ({
    kind: "media",
    head: { mimeType: "image/png", size: bytes.length },
    body: new ReadableStream({ start: (c) => (c.enqueue(bytes), c.close()) }),
    cancel() {},
  });
  test("get_media sends the head, then acked chunks that add up to the file", async () => {
    const { cloud, link } = await setup({ impl: mediaImpl });
    const r = await cloud.req("get_media", { url: "mxc://x/y" });
    expect(r.res.data).toEqual({ mimeType: "image/png", size: bytes.length });
    const got = Buffer.concat(r.chunks.map((c) => Buffer.from(c.data, "base64")));
    expect(got.equals(Buffer.from(bytes))).toBe(true);
    await cloud.waitFor(() => link.pendingCount === 0, 1000, "drain");
  });
  test("without acks the stream stalls at the window; cancel ends it and drains", async () => {
    const big = new Uint8Array(20 * 256 * 1024);
    const { cloud, link } = await setup({
      cloud: { autoAck: false },
      impl: async () => ({ kind: "media", head: { mimeType: "video/mp4", size: big.length }, body: new ReadableStream({ start: (c) => (c.enqueue(big), c.close()) }), cancel() {} }),
    });
    cloud.send({ type: "req", id: "m1", action: "get_media", params: { url: "mxc://x/y" } });
    await cloud.waitFor(() => cloud.frames.filter((f) => f.frame.type === "chunk").length === 8, 2000, "window");
    await Bun.sleep(100);
    expect(cloud.frames.filter((f) => f.frame.type === "chunk").length).toBe(8);
    cloud.send({ type: "cancel", id: "m1" });
    await cloud.waitFor(() => link.pendingCount === 0, 1000, "drain");
  });
  test("a stream the cloud neither acks nor cancels is abandoned at the media deadline (slot released)", async () => {
    const big = new Uint8Array(20 * 256 * 1024);
    const { cloud, link } = await setup({
      cloud: { autoAck: false },
      link: { mediaDeadlineMs: () => 200 },
      impl: async () => ({ kind: "media", head: { mimeType: "video/mp4", size: big.length }, body: new ReadableStream({ start: (c) => (c.enqueue(big), c.close()) }), cancel() {} }),
    });
    cloud.send({ type: "req", id: "stuck1", action: "get_media", params: { url: "mxc://x/y" } });
    await cloud.waitFor(() => cloud.frames.filter((f) => f.frame.type === "chunk").length === 8, 2000, "window full");
    await cloud.waitFor(() => link.pendingCount === 0, 2000, "released");
    expect(link.stats().media).toBe(0);
  });
  test("more than MAX_CONCURRENT_MEDIA_STREAMS at once is RATE_LIMITED", async () => {
    const big = new Uint8Array(20 * 256 * 1024);
    const { cloud } = await setup({
      cloud: { autoAck: false },
      impl: async () => ({ kind: "media", head: { mimeType: "video/mp4", size: big.length }, body: new ReadableStream({ start: (c) => (c.enqueue(big), c.close()) }), cancel() {} }),
    });
    for (let i = 0; i < 4; i++) cloud.send({ type: "req", id: `ms${i}`, action: "get_media", params: { url: "mxc://x/y" } });
    await cloud.waitFor(() => cloud.frames.filter((f) => f.frame.type === "res").length === 4, 2000, "heads");
    const r = await cloud.req("get_media", { url: "mxc://x/y" });
    expect(r.res.error?.code).toBe("RATE_LIMITED");
  });
});

test("media slots are released after cancel and after a socket loss", async () => {
  const big = new Uint8Array(20 * 256 * 1024);
  const { cloud, link } = await setup({
    cloud: { autoAck: false },
    impl: async () => ({ kind: "media", head: { mimeType: "video/mp4", size: big.length }, body: new ReadableStream({ start: (c) => (c.enqueue(big), c.close()) }), cancel() {} }),
  });
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 4; i++) cloud.send({ type: "req", id: `s${round}_${i}`, action: "get_media", params: { url: "mxc://x/y" } });
    await cloud.waitFor(() => link.pendingCount === 4, 2000, "4 streams");
    if (round === 1) {
      cloud.terminate();
      await cloud.waitFor(() => link.state.status === "connected" && cloud.open === 1, 3000, "back");
    } else for (let i = 0; i < 4; i++) cloud.send({ type: "cancel", id: `s${round}_${i}` });
    await cloud.waitFor(() => link.pendingCount === 0, 2000, "released");
  }
  cloud.state.autoAck = true;
  const r = await cloud.req("get_media", { url: "mxc://x/y" });
  expect(r.res.ok).toBe(true);
});

describe("heartbeat", () => {
  test("pings at the welcome's heartbeat and answers the cloud's pings", async () => {
    const { cloud } = await setup({ cloud: { welcome: { heartbeatMs: 1000 } } });
    cloud.send({ type: "ping", t: 123 });
    await cloud.waitFor(() => cloud.frames.some((f) => f.frame.type === "pong" && (f.frame as any).t === 123), 1000, "pong");
    await cloud.waitFor(() => cloud.frames.some((f) => f.frame.type === "ping"), 2000, "ping");
  });
  test("a silent cloud is declared dead after heartbeatTimeoutMs and the link reconnects", async () => {
    const { cloud } = await setup({ cloud: { welcome: { heartbeatMs: 1000 } }, link: { heartbeatTimeoutMs: 300 } });
    cloud.state.silent = true;
    await cloud.waitFor(() => cloud.connections >= 2, 3000, "reconnect");
  });
});

describe("reconnect", () => {
  test("after an abnormal close it reconnects, says hello again and re-runs onWelcome", async () => {
    const { cloud, welcomes, link } = await setup();
    cloud.terminate();
    await cloud.waitFor(() => welcomes() === 2, 3000, "second welcome");
    expect(cloud.connections).toBe(2);
    expect(link.state.status).toBe("connected");
  });
  test("backoff grows across failed attempts and resets after a stable connection", async () => {
    const attempts: number[] = [];
    const { cloud, link } = await setup({ link: { backoff: (n) => (attempts.push(n), 20), stableMs: 200 } });
    cloud.state.rejectUpgrades = 3;
    cloud.terminate();
    await cloud.waitFor(() => cloud.connections === 2 && link.state.status === "connected", 3000, "back");
    expect(attempts).toEqual([0, 1, 2, 3]);
    await Bun.sleep(300);
    cloud.terminate();
    await cloud.waitFor(() => cloud.connections === 3, 3000, "third");
    expect(attempts.at(-1)).toBe(0);
  });
  test("a cloud that accepts and drops at once does not reset the backoff (no reconnect storm)", async () => {
    const attempts: number[] = [];
    const { cloud } = await setup({ link: { backoff: (n) => (attempts.push(n), 20), stableMs: 10_000 } });
    for (let i = 0; i < 4; i++) {
      const before = cloud.connections;
      cloud.terminate();
      await cloud.waitFor(() => cloud.connections > before && cloud.open > 0, 3000, "reconnect");
      await Bun.sleep(20);
    }
    expect(attempts).toEqual([0, 1, 2, 3]);
  });
  test("no welcome within welcomeTimeoutMs: close and try again", async () => {
    const { cloud } = await setup({ link: { welcomeTimeoutMs: 150 } }).catch(() => ({ cloud: clouds.at(-1)! }));
    cloud.state.autoWelcome = false;
    cloud.terminate();
    await cloud.waitFor(() => cloud.connections >= 3, 3000, "retries");
  });
  for (const [name, code, reason] of [
    ["revoked", CLOSE_CODES.REVOKED, "revoked"],
    ["replaced", CLOSE_CODES.REPLACED, "replaced"],
    ["version", CLOSE_CODES.VERSION_UNSUPPORTED, "version"],
  ] as const) {
    test(`close ${code} (${name}) stops the link for good`, async () => {
      const { cloud, link } = await setup();
      cloud.close(code, name);
      const final = await link.done;
      expect(final).toMatchObject({ status: "stopped", reason, closeCode: code });
      await Bun.sleep(150);
      expect(cloud.connections).toBe(1);
    });
  }
  // 4401 stops only when it repeats: test/review-r1.test.ts (stability-r1-R1-STAB-1).
  test("in-flight requests are dropped on a socket loss: the late answer never goes to the new socket", async () => {
    const { cloud, link } = await setup({ impl: slow(200) });
    cloud.send({ type: "req", id: "lost1", action: "list_chats", params: {} });
    await cloud.waitFor(() => link.pendingCount === 1, 1000, "pending");
    cloud.terminate();
    await cloud.waitFor(() => cloud.connections === 2 && link.state.status === "connected", 3000, "back");
    await Bun.sleep(300);
    expect(cloud.frames.filter((f) => f.frame.type === "res" && (f.frame as any).id === "lost1")).toEqual([]);
    expect(link.pendingCount).toBe(0);
  });
});

describe("events and shutdown", () => {
  test("sendEvent works only while connected", async () => {
    const { cloud, link } = await setup();
    const ev = { type: "event", kind: "chat", op: "upserted", chatID: "imsg##thread:+1", ts: new Date().toISOString(), unreadCount: 2 } as const;
    expect(link.sendEvent(ev)).toBe(true);
    await cloud.waitFor(() => cloud.events().length === 1, 1000, "event");
    await link.stop(0);
    expect(link.sendEvent(ev)).toBe(false);
  });
  test("an invalid event is refused locally, never sent", async () => {
    const { cloud, link } = await setup();
    expect(link.sendEvent({ type: "event", kind: "message", op: "upserted", chatID: "x", messageIDs: [], ts: "now" } as any)).toBe(false);
    await Bun.sleep(30);
    expect(cloud.events()).toEqual([]);
  });
  test("graceful stop: in-flight requests finish and are answered, then the socket closes 1001", async () => {
    const { cloud, link } = await setup({ impl: slow(150) });
    const pending = cloud.req("status");
    await cloud.waitFor(() => link.pendingCount === 1, 1000, "pending");
    const stopped = link.stop(2000);
    const r = await pending;
    expect(r.res.ok).toBe(true);
    await stopped;
    expect(link.state).toMatchObject({ status: "stopped", reason: "shutdown" });
    await cloud.waitFor(() => cloud.open === 0, 1000, "closed");
    expect(cloud.closeCodes).toEqual([1001]);
    await Bun.sleep(100);
    expect(cloud.connections).toBe(1);
  });
  test("stop with a short grace aborts what is still running", async () => {
    const { link, cloud } = await setup({ impl: slow(60_000) });
    cloud.send({ type: "req", id: "long1", action: "list_chats", params: {} });
    await cloud.waitFor(() => link.pendingCount === 1, 1000, "pending");
    const t0 = Date.now();
    await link.stop(100);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(link.pendingCount).toBe(0);
  });
});
