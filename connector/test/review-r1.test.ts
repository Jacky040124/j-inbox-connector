// Review round 1 (2026-10-26) regressions for the connector:
// stability-r1-R1-STAB-1 (a 4401 is re-checked before stopping), R1-STAB-2 (connect timeouts on
// both sockets), R1-STAB-5 (single-instance lock, SUPERSEDED reconnects), spec-r1-F1 (Beeper
// /v1/ws: subscribe after `ready`, check `subscriptions.updated` / `error`).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { CLOSE_CODES, type EventFrame } from "@j-inbox/protocol";
import { CloudLink, type SocketLike } from "../src/cloud-link.ts";
import { BeeperEventStream } from "../src/events.ts";
import { acquireInstanceLock } from "../src/instance-lock.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const TOKEN = "jid_" + "A".repeat(43);
const clouds: FakeCloud[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const c of clouds.splice(0)) c.stop();
});

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 3000, what = "condition"): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await Bun.sleep(5);
  }
}

const dispatcher = { dispatch: async () => ({ kind: "res" as const, ok: true as const, data: {} }), isWrite: () => false };

function link(url: string, o: Partial<ConstructorParameters<typeof CloudLink>[0]> = {}) {
  const l = new CloudLink({ url, token: TOKEN, deviceID: "dev_test1", connectorVersion: "0.1.0", hello: async () => ({ beeperVersion: null, networks: [] }), dispatcher, backoff: () => 20, ...o });
  cleanups.push(() => l.stop(0));
  l.start();
  return l;
}

/** A socket that never opens and never closes (a lost NAT mapping, a captive network). */
function blackHole() {
  const made: SocketLike[] = [];
  const factory = () => {
    const s: SocketLike = { readyState: 0, send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
    made.push(s);
    return s;
  };
  return { made, factory };
}

describe("R1-STAB-1: a 4401 is not final on its own", () => {
  test("one 4401 (e.g. an old cloud's late-hello close) is retried and the link comes back", async () => {
    const cloud = await startFakeCloud({ token: TOKEN });
    clouds.push(cloud);
    const l = link(cloud.url);
    await cloud.waitFor(() => l.state.status === "connected", 3000, "connected");
    cloud.close(CLOSE_CODES.UNAUTHENTICATED, "No hello received.");
    await cloud.waitFor(() => cloud.connections === 2 && l.state.status === "connected", 3000, "back");
  });

  test("a cloud that keeps refusing the token stops the link after a few tries", async () => {
    const cloud = await startFakeCloud({ token: TOKEN });
    clouds.push(cloud);
    cloud.state.closeOnOpen = CLOSE_CODES.UNAUTHENTICATED;
    const l = link(cloud.url, { unauthRetries: 2 });
    const final = await Promise.race([l.done, Bun.sleep(3000).then(() => null)]);
    expect(final).toMatchObject({ status: "stopped", reason: "unauthenticated", closeCode: CLOSE_CODES.UNAUTHENTICATED });
    expect(cloud.connections).toBe(3);
  });
});

describe("R1-STAB-2: connect timeouts", () => {
  test("cloud: a socket that never opens is given up after connectTimeoutMs and the link tries again", async () => {
    const bh = blackHole();
    const l = link("http://127.0.0.1:9", { socketFactory: bh.factory, connectTimeoutMs: 100 });
    await waitFor(() => bh.made.length >= 3, 3000, "retries");
    expect(["connecting", "disconnected"]).toContain(l.state.status);
  });

  test("cloud: an open socket that never gets a welcome is also given up (connect timer covers open + welcome)", async () => {
    const cloud = await startFakeCloud({ token: TOKEN, autoWelcome: false });
    clouds.push(cloud);
    link(cloud.url, { connectTimeoutMs: 150, welcomeTimeoutMs: 60_000 });
    await cloud.waitFor(() => cloud.connections >= 2, 3000, "retry");
  });

  test("Beeper /v1/ws: a socket that never opens is given up and retried", async () => {
    const bh = blackHole();
    const s = new BeeperEventStream({ baseURL: "http://127.0.0.1:9", token: "t", onFrames: () => {}, beeperVersion: () => null, backoff: () => 20, socketFactory: bh.factory, handshakeTimeoutMs: 100 });
    cleanups.push(() => s.stop());
    s.start();
    await waitFor(() => bh.made.length >= 3, 3000, "retries");
    expect(s.connected).toBe(false);
  });
});

describe("R1-STAB-5: SUPERSEDED and the single-instance lock", () => {
  test("4410 (this device connected again) reconnects after a long delay instead of exiting", async () => {
    const cloud = await startFakeCloud({ token: TOKEN });
    clouds.push(cloud);
    const l = link(cloud.url, { supersededDelayMs: 200 });
    await cloud.waitFor(() => l.state.status === "connected", 3000, "connected");
    const t0 = Date.now();
    cloud.close(CLOSE_CODES.SUPERSEDED, "This computer connected again.");
    await cloud.waitFor(() => l.state.status === "disconnected", 1000, "disconnected");
    expect(l.state.closeCode).toBe(CLOSE_CODES.SUPERSEDED);
    await cloud.waitFor(() => cloud.connections === 2 && l.state.status === "connected", 3000, "back");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
  });

  test("4409 (another computer was paired) still stops for good", async () => {
    const cloud = await startFakeCloud({ token: TOKEN });
    clouds.push(cloud);
    const l = link(cloud.url);
    await cloud.waitFor(() => l.state.status === "connected", 3000, "connected");
    cloud.close(CLOSE_CODES.REPLACED, "replaced");
    expect(await l.done).toMatchObject({ status: "stopped", reason: "replaced" });
  });

  test("only one process per config dir holds the lock; it is released on exit and taken over when stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jinbox-lock-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const a = acquireInstanceLock(dir);
    expect(a.ok).toBe(true);
    const b = acquireInstanceLock(dir);
    expect(b).toMatchObject({ ok: false, pid: process.pid });
    if (a.ok) a.release();
    const c = acquireInstanceLock(dir);
    expect(c.ok).toBe(true);
    if (c.ok) c.release();
    // a lock left by a process that died is taken over
    await Bun.write(join(dir, "run.lock"), JSON.stringify({ pid: 999_999_99, startedAt: 1 }));
    const d = acquireInstanceLock(dir);
    expect(d.ok).toBe(true);
    if (d.ok) d.release();
    // garbage in the lock file is not a live process either
    await Bun.write(join(dir, "run.lock"), "<script>");
    const e = acquireInstanceLock(dir);
    expect(e.ok).toBe(true);
    if (e.ok) e.release();
  });
});

describe("F1: Beeper /v1/ws handshake per the spec", () => {
  let fb: FakeBeeper;
  beforeAll(async () => {
    fb = await startFakeBeeper();
  });
  afterAll(() => fb.stop());
  afterEach(() => fb.reset());

  function stream(o: { handshakeTimeoutMs?: number } = {}) {
    const frames: EventFrame[] = [];
    const opens: boolean[] = [];
    const logs: string[] = [];
    const s = new BeeperEventStream({
      baseURL: fb.url,
      token: fb.token,
      onFrames: (f) => frames.push(...f),
      onOpen: (first) => opens.push(first),
      beeperVersion: () => "4.2.1",
      backoff: () => 30,
      log: (m) => logs.push(m),
      ...o,
    });
    cleanups.push(() => s.stop());
    s.start();
    return { s, frames, opens, logs };
  }

  test("subscribes only after `ready` (a Beeper that drops early commands still gets subscribed)", async () => {
    fb.controls.wsReadyDelayMs = 300;
    const { s, opens, frames } = stream();
    await Bun.sleep(150);
    expect(s.connected).toBe(false);
    expect(opens).toEqual([]);
    await waitFor(() => opens.length === 1, 3000, "subscribed");
    expect(s.connected).toBe(true);
    await waitFor(() => frames.some((f) => f.kind === "status"), 3000, "app state");
  });

  test("an `error` for the app key: subscribes again without it, and events flow", async () => {
    fb.controls.wsRejectApp = true;
    const { s, opens, frames, logs } = stream();
    await waitFor(() => opens.length === 1, 3000, "subscribed");
    expect(s.connected).toBe(true);
    expect(logs.some((l) => /without app state/.test(l))).toBe(true);
    const { CHAT_IDS } = await import("@j-inbox/fake-beeper");
    fb.state.receive(CHAT_IDS.imessageAlice, { text: "hello" });
    await waitFor(() => frames.some((f) => f.kind === "message"), 3000, "events");
  });

  test("never `ready`, or no `subscriptions.updated`: not connected, closes and retries", async () => {
    fb.controls.wsNoReady = true;
    const a = stream({ handshakeTimeoutMs: 150 });
    await Bun.sleep(500);
    expect(a.s.connected).toBe(false);
    expect(a.opens).toEqual([]);
    a.s.stop();
    fb.controls.wsNoReady = false;
    fb.controls.wsSilentSubscribe = true;
    const b = stream({ handshakeTimeoutMs: 150 });
    await Bun.sleep(500);
    expect(b.s.connected).toBe(false);
    expect(b.opens).toEqual([]);
    // once Beeper answers, the stream recovers on its own
    fb.controls.wsSilentSubscribe = false;
    await waitFor(() => b.opens.length === 1, 3000, "recovered");
  });
});
