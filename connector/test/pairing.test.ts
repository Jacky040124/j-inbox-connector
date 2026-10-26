// Device-code pairing client against a fake cloud: start -> show code -> poll -> token.
import { afterEach, describe, expect, test } from "bun:test";
import { pairDevice } from "../src/pairing-client.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const clouds: FakeCloud[] = [];
afterEach(() => {
  for (const c of clouds.splice(0)) c.stop();
});
const cloud = async () => {
  const c = await startFakeCloud();
  clouds.push(c);
  return c;
};

const DEVICE_CODE = "D".repeat(43);
const TOKEN = "jid_" + "T".repeat(43);
const start = (url: string, over: Record<string, unknown> = {}) => ({
  status: 200,
  body: { deviceCode: DEVICE_CODE, userCode: "BCDF-GHJK", verificationURL: `${url}/pair`, verificationURLComplete: `${url}/pair`, expiresIn: 600, interval: 5, ...over },
});
const approved = { status: 200, body: { status: "approved", deviceID: "dev_abc", deviceToken: TOKEN, owner: { name: "Jacky", serverSlug: "jackyland" } } };

function run(c: FakeCloud, over: Partial<Parameters<typeof pairDevice>[0]> = {}) {
  const shown: unknown[] = [];
  const sleeps: number[] = [];
  const p = pairDevice({
    cloudURL: c.url,
    deviceName: "Jacky's Mac mini",
    connectorVersion: "0.1.0",
    platform: { os: "darwin", arch: "arm64" },
    onCode: (x) => shown.push(x),
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  });
  return { p, shown, sleeps };
}

describe("pairDevice", () => {
  test("approved after pending and slow_down: returns the token once, honours the intervals", async () => {
    const c = await cloud();
    c.pair.startResponse = start(c.url);
    c.pair.pollQueue = [{ status: 200, body: { status: "pending" } }, { status: 200, body: { status: "slow_down", interval: 10 } }, { status: 200, body: { status: "pending" } }, approved];
    const { p, shown, sleeps } = run(c);
    const r = await p;
    expect(r).toEqual({ ok: true, deviceID: "dev_abc", deviceToken: TOKEN, owner: { name: "Jacky", serverSlug: "jackyland" } });
    expect(shown).toEqual([{ userCode: "BCDF-GHJK", verificationURL: `${c.url}/pair`, expiresIn: 600 }]);
    expect(sleeps).toEqual([5000, 5000, 10000, 10000]);
    expect(c.pair.starts[0]).toEqual({ deviceName: "Jacky's Mac mini", connectorVersion: "0.1.0", platform: { os: "darwin", arch: "arm64" } });
    expect(c.pair.polls.every((x) => JSON.stringify(x) === JSON.stringify({ deviceCode: DEVICE_CODE }))).toBe(true);
  });
  test("accepts the apiResponse envelope {ok:true,data} as well", async () => {
    const c = await cloud();
    c.pair.startResponse = { status: 200, body: { ok: true, data: start(c.url).body } };
    c.pair.pollQueue = [{ status: 200, body: { ok: true, data: approved.body } }];
    expect((await run(c).p).ok).toBe(true);
  });
  test("denied and expired end the flow", async () => {
    for (const status of ["denied", "expired"] as const) {
      const c = await cloud();
      c.pair.startResponse = start(c.url);
      c.pair.pollQueue = [{ status: 200, body: { status } }];
      expect(await run(c).p).toMatchObject({ ok: false, reason: status });
    }
  });
  test("gives up as expired when the code's lifetime runs out while pending", async () => {
    const c = await cloud();
    c.pair.startResponse = start(c.url, { expiresIn: 12, interval: 5 });
    let now = 0;
    const r = await run(c, { now: () => now, sleep: async (ms) => void (now += ms) }).p;
    expect(r).toMatchObject({ ok: false, reason: "expired" });
    expect(c.pair.polls.length).toBeLessThanOrEqual(3);
  });
  test("a code inside the verification link is refused (the owner must type it)", async () => {
    const c = await cloud();
    c.pair.startResponse = start(c.url, { verificationURLComplete: `${c.url}/pair?code=BCDF-GHJK` });
    expect(await run(c).p).toMatchObject({ ok: false, reason: "error" });
  });
  test("a verification URL on another origin is refused (phishing)", async () => {
    const c = await cloud();
    c.pair.startResponse = start(c.url, { verificationURL: "https://evil.example/pair", verificationURLComplete: "https://evil.example/pair" });
    const r = await run(c).p;
    expect(r).toMatchObject({ ok: false, reason: "error" });
    expect(c.pair.polls).toEqual([]);
  });
  test("a malformed approved answer is not accepted as a token", async () => {
    const c = await cloud();
    c.pair.startResponse = start(c.url);
    c.pair.pollQueue = [{ status: 200, body: { status: "approved", deviceID: "dev_abc", deviceToken: "short", owner: { name: null, serverSlug: "x" } } }, approved];
    const r = await run(c).p;
    expect(r.ok).toBe(true);
    expect(c.pair.polls.length).toBe(2);
  });
  test("transient poll failures (5xx, garbage) keep polling; a 4xx error stops", async () => {
    const c = await cloud();
    c.pair.startResponse = start(c.url);
    c.pair.pollQueue = [{ status: 503, body: "down" }, { status: 200, body: "<html>" }, approved];
    expect((await run(c).p).ok).toBe(true);
    const c2 = await cloud();
    c2.pair.startResponse = start(c2.url);
    c2.pair.pollQueue = [{ status: 400, body: { ok: false, error: { code: "BAD_PARAMS", message: "bad" } } }];
    expect(await run(c2).p).toMatchObject({ ok: false, reason: "error" });
  });
  test("start refused (rate limit) or cloud unreachable: a clear error, no crash", async () => {
    const c = await cloud();
    c.pair.startResponse = { status: 429, body: { ok: false, error: { code: "RATE_LIMITED", message: "Too many" } } };
    expect(await run(c).p).toMatchObject({ ok: false, reason: "error", message: expect.stringContaining("RATE_LIMITED") });
    const r = await pairDevice({ cloudURL: "http://127.0.0.1:1", deviceName: "x", connectorVersion: "0.1.0", platform: { os: "darwin", arch: "arm64" }, onCode: () => {}, sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, reason: "error" });
  });
  test("an invalid device name is cleaned to something the cloud accepts", async () => {
    const c = await cloud();
    c.pair.startResponse = start(c.url);
    c.pair.pollQueue = [approved];
    await run(c, { deviceName: "Evil\u0000<b>name</b>\n" + "x".repeat(100) }).p;
    const name = (c.pair.starts[0] as any).deviceName as string;
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toMatch(/[\u0000-\u001f]/);
  });
  test("the signal aborts polling", async () => {
    const c = await cloud();
    c.pair.startResponse = start(c.url);
    const ctl = new AbortController();
    const { p } = run(c, { signal: ctl.signal, sleep: (ms) => Bun.sleep(5) });
    await Bun.sleep(40);
    ctl.abort();
    expect(await p).toMatchObject({ ok: false, reason: "cancelled" });
  });
});
