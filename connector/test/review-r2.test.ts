// Review round 2 (2026-10-26) regressions for the connector:
// stability-r2-STAB2-1 (a stale run.lock whose pid now belongs to another process),
// STAB2-2 (re-sync on the first Beeper subscription), STAB2-3 (status events are never dropped
// for backpressure; health is re-sent periodically), STAB2-6 (a lost approved answer is reported),
// tests-r2-R2-TQ-3 (the 4401 streak resets on welcome), spec-r2-R2-SPEC-1 (a signal stop exits
// non-zero so launchd restarts it), R2-SPEC-2 (the primary inbox lists chats with previews).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { CLOSE_CODES, type EventFrame } from "@j-inbox/protocol";
import { createActions } from "../src/actions.ts";
import { createBeeperClient } from "../src/beeper-client.ts";
import { CloudLink } from "../src/cloud-link.ts";
import { resolvePaths, saveConfig } from "../src/config.ts";
import { HealthMonitor } from "../src/events.ts";
import { acquireInstanceLock } from "../src/instance-lock.ts";
import { pairDevice } from "../src/pairing-client.ts";
import { parseEtime, pidHeldSince } from "../src/probe.ts";
import { MemorySecretStore } from "../src/secrets.ts";
import { exitCodeFor, startService } from "../src/service.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const TOKEN = "jid_" + "R".repeat(43);
let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper();
});
afterAll(() => fb.stop());
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  fb.reset();
  if (!fbUp) await fb.resume(), (fbUp = true);
});
let fbUp = true;

async function cloud(o: Parameters<typeof startFakeCloud>[0] = {}): Promise<FakeCloud> {
  const c = await startFakeCloud({ token: TOKEN, ...o });
  cleanups.push(() => c.stop());
  return c;
}

const dispatcher = { dispatch: async () => ({ kind: "res" as const, ok: true as const, data: {} }), isWrite: () => false };
function link(url: string, o: Partial<ConstructorParameters<typeof CloudLink>[0]> = {}) {
  const l = new CloudLink({ url, token: TOKEN, deviceID: "dev_r2", connectorVersion: "0.1.0", hello: async () => ({ beeperVersion: null, networks: [] }), dispatcher, backoff: () => 20, ...o });
  cleanups.push(() => l.stop(0));
  l.start();
  return l;
}

/** A real process that started now (so after any lock written earlier). */
function freshProcess() {
  const p = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  cleanups.push(() => p.kill("SIGKILL"));
  return p;
}

// ------------------------------------------------------------------ STAB2-1

describe("STAB2-1: a run.lock whose pid now belongs to another process is stale", () => {
  const lockDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "jinbox-lock2-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  test("pid 1 (launchd, EPERM) from a lock written before it started: taken over", () => {
    const dir = lockDir();
    writeFileSync(join(dir, "run.lock"), JSON.stringify({ pid: 1, startedAt: "2000-01-01T00:00:00.000Z" }));
    const l = acquireInstanceLock(dir);
    expect(l.ok).toBe(true);
    if (l.ok) l.release();
  });

  test("a live process that started after the lock was written (pid reused after a reboot or kill -9): taken over", async () => {
    const dir = lockDir();
    const p = freshProcess();
    await Bun.sleep(50);
    writeFileSync(join(dir, "run.lock"), JSON.stringify({ pid: p.pid, startedAt: new Date(Date.now() - 3600_000).toISOString() }));
    const l = acquireInstanceLock(dir);
    expect(l.ok).toBe(true);
    if (l.ok) l.release();
  });

  test("the real holder (started before it wrote the lock) still blocks a second run", () => {
    const dir = lockDir();
    const a = acquireInstanceLock(dir);
    expect(a.ok).toBe(true);
    expect(acquireInstanceLock(dir)).toMatchObject({ ok: false, pid: process.pid });
    if (a.ok) a.release();
    // also a lock written by hand for this (long-running) process
    writeFileSync(join(dir, "run.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    expect(acquireInstanceLock(dir)).toMatchObject({ ok: false, pid: process.pid });
  });

  test("status/doctor use the same check: a state.json pid that now belongs to a newer process is not the service", async () => {
    const p = freshProcess();
    await Bun.sleep(50);
    expect(pidHeldSince(p.pid, new Date(Date.now() - 3600_000).toISOString())).toBe(false);
    expect(pidHeldSince(1, "2000-01-01T00:00:00.000Z")).toBe(false);
    expect(pidHeldSince(process.pid, new Date().toISOString())).toBe(true);
    expect(pidHeldSince(99_999_999, new Date().toISOString())).toBe(false);
    // injected start times: equal or earlier is the holder; later is a reused pid
    expect(pidHeldSince(process.pid, 10_000, () => 9_000)).toBe(true);
    expect(pidHeldSince(process.pid, 10_000, () => 60_000)).toBe(false);
    // unknown start time (ps failed): keep the old answer (alive)
    expect(pidHeldSince(process.pid, 10_000, () => null)).toBe(true);
  });

  test("parseEtime: [[dd-]hh:]mm:ss", () => {
    expect(parseEtime("00:05")).toBe(5);
    expect(parseEtime("  12:34\n")).toBe(754);
    expect(parseEtime("01:00:00")).toBe(3600);
    expect(parseEtime("31-04:06:08")).toBe(31 * 86400 + 4 * 3600 + 6 * 60 + 8);
    for (const bad of ["", "abc", "1:2:3:4", "-5", "12", "<script>"]) expect(parseEtime(bad)).toBeNull();
  });
});

// ------------------------------------------------------------------ R2-TQ-3

describe("R2-TQ-3: 4401 stops the link only when it comes several times in a row", () => {
  test("more 4401s than unauthRetries, each followed by a successful welcome: never stopped", async () => {
    const c = await cloud();
    const l = link(c.url, { unauthRetries: 2 });
    await c.waitFor(() => l.state.status === "connected", 3000, "connected");
    for (let i = 1; i <= 5; i++) {
      c.close(CLOSE_CODES.UNAUTHENTICATED, "No hello received.");
      await c.waitFor(() => c.connections === i + 1 && l.state.status === "connected", 3000, `back ${i}`);
    }
    expect(l.state.status).toBe("connected");
  });

  test("consecutive 4401s with no welcome in between still stop it", async () => {
    const c = await cloud();
    c.state.closeOnOpen = CLOSE_CODES.UNAUTHENTICATED;
    const l = link(c.url, { unauthRetries: 2 });
    expect(await Promise.race([l.done, Bun.sleep(3000).then(() => null)])).toMatchObject({ status: "stopped", reason: "unauthenticated" });
  });
});

// ------------------------------------------------------------------ STAB2-3

describe("STAB2-3: Beeper health is never lost to backpressure", () => {
  test("under backpressure chat events are dropped, a status event still goes out", async () => {
    const c = await cloud();
    const l = link(c.url, { maxBufferedEventBytes: -1 });
    await c.waitFor(() => l.state.status === "connected", 3000, "connected");
    const ts = new Date().toISOString();
    expect(l.sendEvent({ type: "event", kind: "chat", op: "upserted", chatID: "c1", ts })).toBe(false);
    expect(l.sendEvent({ type: "event", kind: "status", ts, beeper: { reachable: true, version: "4.2.1", tokenValid: true } })).toBe(true);
    await c.waitFor(() => c.events().some((e: any) => e.kind === "status"), 2000, "status");
    expect(c.events().some((e: any) => e.kind === "chat")).toBe(false);
  });

  test("HealthMonitor re-sends the unchanged status every resendEvery checks", async () => {
    const seen: EventFrame[] = [];
    const h = new HealthMonitor({ client: createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 1000 }), intervalMs: 20, resendEvery: 3, onChange: (f) => seen.push(f) });
    cleanups.push(() => h.stop());
    h.start();
    const t0 = Date.now();
    while (seen.length < 3 && Date.now() - t0 < 3000) await Bun.sleep(10);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((f) => f.kind === "status" && f.beeper.reachable)).toBe(true);
  });
});

// ------------------------------------------------------------------ STAB2-2

describe("STAB2-2: the connector re-syncs when Beeper comes up after the connector", () => {
  test("started while Beeper is down: after Beeper starts, recent chats go to the cloud", async () => {
    const c = await cloud();
    const paths = resolvePaths({ HOME: "/nonexistent", J_INBOX_CONFIG_DIR: mkdtempSync(join(tmpdir(), "jinbox-r2svc-")) });
    saveConfig(paths, { cloudURL: c.url, beeperURL: fb.url, deviceID: "dev_r2svc", deviceName: "Test Mac" });
    const secrets = new MemorySecretStore();
    await secrets.set("beeper-token", fb.token);
    await secrets.set("device-token", TOKEN);
    await fb.pause();
    fbUp = false;
    const svc = await startService({ paths, secrets, version: "0.1.0", healthIntervalMs: 50, backoff: () => 30, log: () => {} });
    cleanups.push(() => svc.stop(0));
    await c.waitFor(() => svc.link?.state.status === "connected", 4000, "connected");
    await c.waitFor(() => c.events().some((e: any) => e.kind === "status" && e.beeper.reachable === false), 4000, "down status");
    await Bun.sleep(100);
    expect(c.events().filter((e: any) => e.kind === "chat").length).toBe(0);
    await fb.resume();
    fbUp = true;
    await c.waitFor(() => c.events().filter((e: any) => e.kind === "chat").length > 5, 5000, "re-sync after Beeper came up");
  });
});

// ------------------------------------------------------------------ STAB2-6

describe("STAB2-6: an approved answer lost on the way is not reported as an expired code", () => {
  test("pending, then a 5xx poll, then expired: the message says it may have been approved", async () => {
    const c = await cloud();
    c.pair.startResponse = { status: 200, body: { deviceCode: "D".repeat(43), userCode: "BCDF-GHJK", verificationURL: `${c.url}/pair`, verificationURLComplete: `${c.url}/pair`, expiresIn: 600, interval: 5 } };
    c.pair.pollQueue = [{ status: 200, body: { status: "pending" } }, { status: 500, body: { ok: false, error: { code: "INTERNAL", message: "x" } } }, { status: 200, body: { status: "expired" } }];
    const r = await pairDevice({ cloudURL: c.url, deviceName: "Mac", connectorVersion: "0.1.0", platform: { os: "darwin", arch: "arm64" }, onCode: () => {}, sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, reason: "expired" });
    if (!r.ok) {
      expect(r.message).toMatch(/approved/i);
      expect(r.message).toMatch(/lost/i);
      expect(r.message).toContain("j-inbox pair");
    }
  });

  test("a plain expiry (no failed poll before it) keeps the plain message", async () => {
    const c = await cloud();
    c.pair.startResponse = { status: 200, body: { deviceCode: "D".repeat(43), userCode: "BCDF-GHJK", verificationURL: `${c.url}/pair`, verificationURLComplete: `${c.url}/pair`, expiresIn: 600, interval: 5 } };
    c.pair.pollQueue = [{ status: 200, body: { status: "pending" } }, { status: 200, body: { status: "expired" } }];
    const r = await pairDevice({ cloudURL: c.url, deviceName: "Mac", connectorVersion: "0.1.0", platform: { os: "darwin", arch: "arm64" }, onCode: () => {}, sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, reason: "expired", message: "The code expired. Run `j-inbox pair` again." });
  });
});

// ------------------------------------------------------------------ R2-SPEC-1

describe("R2-SPEC-1: a stop by signal exits non-zero, so launchd (KeepAlive SuccessfulExit=false) restarts it", () => {
  test("exit codes: SIGTERM 143, SIGINT 130; stay-down reasons 0; nothing else 0", () => {
    expect(exitCodeFor("shutdown", "SIGTERM")).toBe(143);
    expect(exitCodeFor("shutdown", "SIGINT")).toBe(130);
    for (const r of ["not_paired", "no_beeper_token", "revoked", "replaced", "unauthenticated", "version"] as const) expect(exitCodeFor(r, "SIGTERM")).toBe(0);
    expect(exitCodeFor("shutdown", null)).not.toBe(0);
    expect(exitCodeFor("config_error", null)).toBe(0);
  });
});

// ------------------------------------------------------------------ R2-SPEC-2

describe("R2-SPEC-2: All chats and Unread (inbox primary) carry the last-message preview", () => {
  const actions = () => createActions(createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 }));
  test("inbox primary: previews present, archived and low-priority chats left out, read from GET /v1/chats", async () => {
    const r = await actions().list_chats({ inbox: "primary", limit: 50 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const withPreview = r.data.items.filter((c) => c.preview && c.preview.text);
    expect(withPreview.length).toBeGreaterThan(5);
    expect(r.data.items.some((c) => c.id === CHAT_IDS.archived)).toBe(false);
    expect(r.data.items.every((c) => !c.isArchived && !c.isLowPriority)).toBe(true);
  });
  test("inbox primary + unreadOnly: only unread chats, still with previews", async () => {
    const r = await actions().list_chats({ inbox: "primary", unreadOnly: true, limit: 50 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.data.items.length).toBeGreaterThan(0);
    expect(r.data.items.every((c) => c.unreadCount > 0 || c.isMarkedUnread)).toBe(true);
    expect(r.data.items.some((c) => c.preview && c.preview.text)).toBe(true);
  });
  test("paging the primary inbox visits every primary chat once", async () => {
    const a = actions();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const r = await a.list_chats({ inbox: "primary", limit: 3, ...(cursor ? { cursor } : {}) });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      seen.push(...r.data.items.map((c) => c.id));
      if (!r.data.hasMore) break;
      cursor = r.data.nextCursor!;
    }
    expect(new Set(seen).size).toBe(seen.length);
    const all = await a.list_chats({ inbox: "primary", limit: 100 });
    if (!all.ok) throw new Error("list");
    expect(seen.sort()).toEqual(all.data.items.map((c) => c.id).sort());
  });
});
