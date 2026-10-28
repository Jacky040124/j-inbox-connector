// Beeper /v1/ws subscription with resubscribe after drops, the 30 s health check (status events,
// BEEPER_DOWN as reachable:false), and the re-sync that makes up for at-most-once delivery.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { parseConnectorFrame, type EventFrame } from "@j-inbox/protocol";
import { createBeeperClient } from "../src/beeper-client.ts";
import { BeeperEventStream, HealthMonitor, Reconciler, beeperWsURL, parseBeeperMessage } from "../src/events.ts";
import { othersAtOf } from "../src/beeper-ws.ts";

let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper();
});
afterAll(() => fb.stop());
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  fb.reset();
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

function stream(o: { token?: string } = {}) {
  const frames: EventFrame[] = [];
  const opens: boolean[] = [];
  const s = new BeeperEventStream({
    baseURL: fb.url,
    token: o.token ?? fb.token,
    onFrames: (f) => frames.push(...f),
    onOpen: (first) => opens.push(first),
    beeperVersion: () => "4.2.1",
    backoff: () => 30,
  });
  stops.push(() => s.stop());
  s.start();
  return { s, frames, opens };
}

describe("beeperWsURL", () => {
  test("derives ws://host/v1/ws from the API URL, loopback only", () => {
    expect(beeperWsURL("http://127.0.0.1:23373")).toBe("ws://127.0.0.1:23373/v1/ws");
    expect(beeperWsURL("http://localhost:23374/")).toBe("ws://localhost:23374/v1/ws");
    expect(() => beeperWsURL("http://evil.example:23373")).toThrow();
  });
});

describe("BeeperEventStream", () => {
  test("subscribes to all chats + app state and forwards metadata-only frames", async () => {
    const { frames } = stream();
    await waitFor(() => frames.some((f) => f.kind === "status"), 3000, "app state");
    fb.state.receive(CHAT_IDS.imessageAlice, { text: "TOP SECRET body" });
    await waitFor(() => frames.some((f) => f.kind === "message") && frames.some((f) => f.kind === "chat"), 3000, "events");
    for (const f of frames) expect(parseConnectorFrame(JSON.stringify(f)).ok).toBe(true);
    expect(JSON.stringify(frames)).not.toContain("TOP SECRET");
    expect(frames.find((f) => f.kind === "status")).toMatchObject({ beeper: { reachable: true, version: "4.2.1", appState: "ready" } });
  });
  test("after Beeper drops the socket it reconnects, resubscribes and reports a non-first open", async () => {
    const { frames, opens } = stream();
    await waitFor(() => opens.length === 1, 3000, "open");
    fb.dropWebSockets();
    await waitFor(() => opens.length === 2, 3000, "reopen");
    expect(opens).toEqual([true, false]);
    await waitFor(() => fb.wsClientCount() === 1, 2000, "client");
    const before = frames.length;
    await Bun.sleep(50);
    fb.state.receive(CHAT_IDS.imessageWeird, { text: "after reconnect" });
    await waitFor(() => frames.slice(before).some((f) => f.kind === "message"), 3000, "events after resubscribe");
  });
  test("Beeper down: keeps retrying with backoff, then recovers", async () => {
    const { opens } = stream();
    await waitFor(() => opens.length === 1, 3000, "open");
    await fb.pause();
    await Bun.sleep(150);
    await fb.resume();
    await waitFor(() => opens.length === 2, 3000, "reopen after resume");
  });
  test("a rejected token does not crash the stream (it keeps retrying quietly)", async () => {
    const { s, opens } = stream({ token: "wrong-token" });
    await Bun.sleep(200);
    expect(opens).toEqual([]);
    expect(s.connected).toBe(false);
  });
  test("stop closes the socket and stops reconnecting", async () => {
    const { s, opens } = stream();
    await waitFor(() => opens.length === 1, 3000, "open");
    s.stop();
    await waitFor(() => fb.wsClientCount() === 0, 2000, "closed");
    await Bun.sleep(150);
    expect(fb.wsClientCount()).toBe(0);
    expect(opens.length).toBe(1);
  });
});

describe("parseBeeperMessage", () => {
  const ctx = { beeperVersion: null, now: "2026-10-25T12:00:00.000Z" };
  test("hostile, malformed and oversized input yields no frames", () => {
    for (const m of ["", "{", "null", "[]", "42", JSON.stringify({ type: "message.upserted", chatID: "", ids: ["a"] }), JSON.stringify({ type: "message.upserted", chatID: "c\u0000", ids: ["a"] }), "x".repeat(2_000_000), JSON.stringify({ type: "__proto__" })])
      expect(parseBeeperMessage(m, ctx)).toEqual([]);
  });
  test("message text in a Beeper event never reaches the frame", () => {
    const f = parseBeeperMessage(JSON.stringify({ type: "message.upserted", chatID: "imsg##thread:+1", ids: ["m1"], entries: [{ text: "SECRET" }] }), ctx);
    expect(f).toHaveLength(1);
    expect(JSON.stringify(f)).not.toContain("SECRET");
  });
});

// Snooze's early return: did someone else write? Only one timestamp leaves the Mac.
describe("othersAt on message events", () => {
  const now = "2026-10-25T12:00:00.000Z";
  const ctx = { beeperVersion: null, now };
  const ev = (entries: unknown, extra: Record<string, unknown> = {}) => parseBeeperMessage(JSON.stringify({ type: "message.upserted", chatID: "imsg##thread:+1", ids: ["m1", "m2"], ...(entries === undefined ? {} : { entries }), ...extra }), ctx);
  const other = (ts: string, extra: Record<string, unknown> = {}) => ({ id: "m1", isSender: false, timestamp: ts, senderID: "@alice:x", senderName: "Alice SECRET", text: "SECRET", ...extra });
  const own = (ts: string) => ({ id: "m2", isSender: true, timestamp: ts, senderID: "@me:x", text: "mine" });
  test("someone else wrote: the newest such timestamp (never later than now)", () => {
    expect(othersAtOf([other("2026-10-25T11:58:00Z"), own("2026-10-25T11:59:30Z"), other("2026-10-25T11:59:00+00:00")], now)).toBe("2026-10-25T11:59:00.000Z");
    expect(othersAtOf([other("2030-01-01T00:00:00Z")], now)).toBe(now);
    const [f] = ev([other("2026-10-25T11:59:00Z")]);
    expect(f).toEqual({ type: "event", kind: "message", op: "upserted", chatID: "imsg##thread:+1", messageIDs: ["m1", "m2"], ts: now, othersAt: "2026-10-25T11:59:00.000Z" });
    expect(JSON.stringify(f)).not.toMatch(/SECRET|alice/);
    expect(parseConnectorFrame(JSON.stringify(f)).ok).toBe(true);
  });
  test("only the owner's own messages (and reactions): null", () => {
    expect(othersAtOf([own("2026-10-25T11:59:00Z")], now)).toBeNull();
    expect(othersAtOf([own("2026-10-25T11:59:00Z"), other("2026-10-25T11:59:00Z", { type: "REACTION" })], now)).toBeNull();
    expect(ev([own("2026-10-25T11:59:00Z")])[0]).toMatchObject({ othersAt: null });
  });
  test("not known: no entries, an entry without isSender or a time, or deletions", () => {
    for (const entries of [undefined, [], "x", [null], [[1]], [{ id: "m1", timestamp: "2026-10-25T11:59:00Z" }], [other("not a time")], [own("2026-10-25T11:59:00Z"), { id: "m3", isSender: "no" }]]) {
      expect(othersAtOf(entries, now)).toBeUndefined();
      const fs = ev(entries);
      expect(fs).toHaveLength(1);
      expect("othersAt" in fs[0]!).toBe(false);
    }
    // a known other wins over an unknown entry
    expect(othersAtOf([{ id: "m3" }, other("2026-10-25T11:00:00Z")], now)).toBe("2026-10-25T11:00:00.000Z");
    const del = parseBeeperMessage(JSON.stringify({ type: "message.deleted", chatID: "imsg##thread:+1", ids: ["m1"], entries: [other("2026-10-25T11:59:00Z")] }), ctx);
    expect("othersAt" in del[0]!).toBe(false);
  });
  test("every chunk of a big event carries it", () => {
    const ids = Array.from({ length: 150 }, (_, i) => `m${i}`);
    const fs = parseBeeperMessage(JSON.stringify({ type: "message.upserted", chatID: "imsg##thread:+1", ids, entries: [other("2026-10-25T11:59:00Z")] }), ctx);
    expect(fs.map((f) => (f as { othersAt?: unknown }).othersAt)).toEqual(["2026-10-25T11:59:00.000Z", "2026-10-25T11:59:00.000Z"]);
  });
  test("over the real socket: a message from someone else has othersAt, the owner's own send has null", async () => {
    const { frames } = stream();
    await waitFor(() => frames.some((f) => f.kind === "status"), 3000, "subscribed");
    const incoming = fb.state.receive(CHAT_IDS.imessageAlice, { text: "hello" });
    const got = await waitFor(() => frames.find((f) => f.kind === "message" && f.messageIDs.includes(incoming.id)), 3000, "incoming");
    expect((got as { othersAt?: string }).othersAt).toBe(new Date(Date.parse(incoming.timestamp)).toISOString());
    frames.length = 0;
    const chat = fb.state.chats.get(CHAT_IDS.imessageAlice)!;
    const mine = fb.state.sendOwn(chat, "mine", undefined, 0);
    const sent = await waitFor(() => frames.filter((f) => f.kind === "message" && f.messageIDs.includes(mine.id)).length >= 2 && frames, 3000, "own send and its settle");
    for (const f of sent.filter((x) => x.kind === "message")) expect((f as { othersAt?: unknown }).othersAt).toBeNull();
  });
});

describe("HealthMonitor", () => {
  const client = () => createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 1000 });
  test("reachable with version and a valid token", async () => {
    const h = new HealthMonitor({ client: client() });
    expect(await h.check()).toEqual({ reachable: true, version: expect.any(String), tokenValid: true });
  });
  test("a rejected token: reachable, tokenValid false", async () => {
    const h = new HealthMonitor({ client: createBeeperClient({ baseURL: fb.url, token: "nope", timeoutMs: 1000 }) });
    expect(await h.check()).toMatchObject({ reachable: true, tokenValid: false });
  });
  test("Beeper down is reachable:false and a status event goes out on the change, and again on recovery", async () => {
    const seen: EventFrame[] = [];
    const h = new HealthMonitor({ client: client(), intervalMs: 40, onChange: (f) => seen.push(f) });
    stops.push(() => h.stop());
    h.start();
    await waitFor(() => seen.length === 1, 2000, "first");
    expect(seen[0]).toMatchObject({ type: "event", kind: "status", beeper: { reachable: true } });
    await fb.pause();
    await waitFor(() => seen.length === 2, 3000, "down");
    expect(seen[1]).toMatchObject({ kind: "status", beeper: { reachable: false, version: null } });
    await Bun.sleep(150);
    expect(seen.length).toBe(2);
    await fb.resume();
    await waitFor(() => seen.length === 3, 3000, "up");
    expect(seen[2]).toMatchObject({ beeper: { reachable: true } });
    for (const f of seen) expect(parseConnectorFrame(JSON.stringify(f)).ok).toBe(true);
  });
  test("app state from the Beeper socket is merged into later status events", async () => {
    const seen: EventFrame[] = [];
    const h = new HealthMonitor({ client: client(), onChange: (f) => seen.push(f) });
    await h.check();
    h.setAppState("needs-login");
    expect(seen.at(-1)).toMatchObject({ beeper: { appState: "needs-login" } });
    expect(h.statusFrame()).toMatchObject({ kind: "status", beeper: { reachable: true, appState: "needs-login" } });
  });
  test("app state that arrives before the first check emits nothing (no false 'Beeper down' at startup)", async () => {
    const seen: EventFrame[] = [];
    const h = new HealthMonitor({ client: client(), onChange: (f) => seen.push(f) });
    h.setAppState("ready");
    expect(seen).toEqual([]);
    await h.check();
    expect(seen.map((f) => (f as any).beeper.reachable)).toEqual([true]);
    expect(seen[0]).toMatchObject({ beeper: { reachable: true, appState: "ready" } });
  });
  test("a hung Beeper counts as down after the check timeout", async () => {
    fb.hangNext({ route: "/v1/info", times: 5 });
    const h = new HealthMonitor({ client: createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 200 }) });
    const t0 = Date.now();
    expect((await h.check()).reachable).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("Reconciler", () => {
  test("first run emits a chat event per recent chat; later runs only for chats that changed", async () => {
    const sent: EventFrame[] = [];
    const r = new Reconciler({ client: createBeeperClient({ baseURL: fb.url, token: fb.token }), send: (f) => (sent.push(f), true) });
    const n = await r.run();
    expect(n).toBeGreaterThan(5);
    expect(sent.every((f) => f.kind === "chat" && f.op === "upserted")).toBe(true);
    sent.length = 0;
    expect(await r.run()).toBe(0);
    fb.state.receive(CHAT_IDS.longHistory, { text: "missed while offline" });
    expect(await r.run()).toBe(1);
    expect(sent).toEqual([expect.objectContaining({ kind: "chat", chatID: CHAT_IDS.longHistory, unreadCount: 4 })]);
    expect(JSON.stringify(sent)).not.toContain("missed while offline");
  });
  test("Beeper down: no events, no throw", async () => {
    const sent: EventFrame[] = [];
    const r = new Reconciler({ client: createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 500 }), send: (f) => (sent.push(f), true) });
    await fb.pause();
    try {
      expect(await r.run()).toBe(0);
    } finally {
      await fb.resume();
    }
  });
  test("an event the cloud did not take (send false) is retried on the next run", async () => {
    let accept = false;
    const sent: EventFrame[] = [];
    const r = new Reconciler({ client: createBeeperClient({ baseURL: fb.url, token: fb.token }), send: (f) => (accept ? (sent.push(f), true) : false) });
    await r.run();
    accept = true;
    expect(await r.run()).toBeGreaterThan(5);
  });
});
