// The whole background service against fake Beeper and a fake cloud: requests, media allowlist,
// events, re-sync, Beeper down, revocation, audit and state files (metadata only).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET_URLS, CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { CLOSE_CODES } from "@j-inbox/protocol";
import { resolvePaths, saveConfig } from "../src/config.ts";
import { MemorySecretStore } from "../src/secrets.ts";
import { readState, startService, type Service } from "../src/service.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const TOKEN = "jid_" + "S".repeat(43);
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

async function boot(o: { paired?: boolean; beeperToken?: string | null; healthIntervalMs?: number } = {}) {
  const cloud = await startFakeCloud({ token: TOKEN });
  cleanup.push(() => cloud.stop());
  const paths = resolvePaths({ HOME: "/nonexistent", J_INBOX_CONFIG_DIR: mkdtempSync(join(tmpdir(), "jinbox-svc-")) });
  saveConfig(paths, { cloudURL: cloud.url, beeperURL: fb.url, ...(o.paired === false ? {} : { deviceID: "dev_svc1", deviceName: "Test Mac" }) });
  const secrets = new MemorySecretStore();
  if (o.beeperToken !== null) await secrets.set("beeper-token", o.beeperToken ?? fb.token);
  if (o.paired !== false) await secrets.set("device-token", TOKEN);
  const svc = await startService({ paths, secrets, version: "0.1.0", healthIntervalMs: o.healthIntervalMs ?? 60_000, backoff: () => 30 });
  cleanup.push(() => svc.stop(0));
  return { cloud, paths, svc, secrets };
}
const connected = (cloud: FakeCloud, svc: Service) => cloud.waitFor(() => svc.link?.state.status === "connected", 4000, "connected");

describe("service", () => {
  test("not paired: exits cleanly (code 0) without dialing the cloud", async () => {
    const { svc, cloud } = await boot({ paired: false });
    expect(await svc.done).toMatchObject({ reason: "not_paired", exitCode: 0 });
    expect(cloud.connections).toBe(0);
  });
  test("no Beeper token: exits cleanly with a hint", async () => {
    const { svc } = await boot({ beeperToken: null });
    expect(await svc.done).toMatchObject({ reason: "no_beeper_token", exitCode: 0 });
  });
  test("connects, says hello with the real networks, answers requests through the whitelist", async () => {
    const { cloud, svc } = await boot();
    await connected(cloud, svc);
    expect(cloud.hello()).toMatchObject({ deviceID: "dev_svc1", connectorVersion: "0.1.0", beeperVersion: expect.any(String) });
    expect((cloud.hello() as any).networks).toContain("iMessage");
    const r = await cloud.req("read_chat", { chatID: CHAT_IDS.imessageWeird, limit: 3 });
    expect(r.res.ok).toBe(true);
    expect((r.res.data as any).items.length).toBe(3);
    expect((await cloud.req("nonexistent_action", {})).res.error?.code).toBe("NOT_ALLOWED");
  });
  test("on welcome: a status event and re-sync chat events (metadata only)", async () => {
    const { cloud, svc } = await boot();
    await connected(cloud, svc);
    await cloud.waitFor(() => cloud.events().some((e: any) => e.kind === "status") && cloud.events().filter((e: any) => e.kind === "chat").length > 5, 4000, "events");
    expect(JSON.stringify(cloud.events())).not.toContain("Alice Chen");
  });
  test("get_media works only for URLs a previous result carried", async () => {
    const { cloud, svc } = await boot();
    await connected(cloud, svc);
    expect((await cloud.req("get_media", { url: ASSET_URLS.imgSmall })).res.error?.code).toBe("NOT_ALLOWED");
    await cloud.req("read_chat", { chatID: CHAT_IDS.media, limit: 30 });
    const r = await cloud.req("get_media", { url: ASSET_URLS.imgSmall });
    expect(r.res.ok).toBe(true);
    expect(r.chunks.at(-1)!.last).toBe(true);
  });
  test("a new Beeper message reaches the cloud as a metadata-only event", async () => {
    const { cloud, svc } = await boot();
    await connected(cloud, svc);
    await cloud.waitFor(() => fb.wsClientCount() === 1, 3000, "beeper ws");
    await Bun.sleep(50);
    fb.state.receive(CHAT_IDS.imessageAlice, { text: "PRIVATE words here" });
    await cloud.waitFor(() => cloud.events().some((e: any) => e.kind === "message" && e.chatID === CHAT_IDS.imessageAlice), 3000, "message event");
    expect(cloud.raw.join("\n")).not.toContain("PRIVATE words");
  });
  test("after Beeper's socket drops, missed changes are re-synced", async () => {
    const { cloud, svc } = await boot();
    await connected(cloud, svc);
    await cloud.waitFor(() => fb.wsClientCount() === 1, 3000, "beeper ws");
    await cloud.waitFor(() => cloud.events().filter((e: any) => e.kind === "chat").length > 5, 3000, "initial sync");
    fb.controls.dropEvents = true;
    fb.dropWebSockets();
    fb.state.receive(CHAT_IDS.longHistory, { text: "missed" });
    fb.controls.dropEvents = false;
    await cloud.waitFor(() => cloud.events().some((e: any) => e.kind === "chat" && e.chatID === CHAT_IDS.longHistory && e.unreadCount === 4), 4000, "re-sync event");
  });
  test("Beeper going down is reported as a status event with reachable:false", async () => {
    const { cloud, svc } = await boot({ healthIntervalMs: 50 });
    await connected(cloud, svc);
    await fb.pause();
    try {
      await cloud.waitFor(() => cloud.events().some((e: any) => e.kind === "status" && e.beeper.reachable === false), 4000, "down event");
      expect((await cloud.req("list_chats", {})).res.error?.code).toBe("BEEPER_DOWN");
    } finally {
      await fb.resume();
    }
    await cloud.waitFor(() => (cloud.events().filter((e: any) => e.kind === "status").at(-1) as any)?.beeper.reachable === true, 4000, "up again");
  });
  test("revoked (4403): the service stops for good with exit code 0 and says why in the state file", async () => {
    const { cloud, svc, paths } = await boot();
    await connected(cloud, svc);
    cloud.close(CLOSE_CODES.REVOKED, "revoked");
    expect(await svc.done).toMatchObject({ reason: "revoked", exitCode: 0 });
    expect(readState(paths)?.cloud).toMatchObject({ status: "stopped", reason: "revoked" });
    await Bun.sleep(100);
    expect(cloud.connections).toBe(1);
  });
  test("audit and state files carry metadata only", async () => {
    const { cloud, svc, paths } = await boot();
    await connected(cloud, svc);
    await cloud.req("send_message", { chatID: CHAT_IDS.imessageAlice, text: "SECRET-SEND-TEXT", idempotencyKey: "svc_key_00001" });
    await cloud.req("search_messages", { query: "SECRET-QUERY" });
    await svc.stop(500);
    const audit = readFileSync(paths.auditFile, "utf8");
    expect(audit).toContain('"action":"send_message"');
    const state = readFileSync(paths.stateFile, "utf8");
    for (const f of [audit, state]) expect(f).not.toContain(CHAT_IDS.imessageAlice);
    // The idempotency journal keeps result ids on this Mac (by design), never text or tokens.
    for (const f of [audit, state, existsSync(paths.idempotencyFile) ? readFileSync(paths.idempotencyFile, "utf8") : ""]) {
      expect(f).not.toContain("SECRET");
      expect(f).not.toContain(TOKEN);
      expect(f).not.toContain(fb.token);
    }
    expect(readState(paths)?.cloud.status).toBe("stopped");
  });
  test("send_message keys survive a restart: the same key is not sent twice", async () => {
    const first = await boot();
    await connected(first.cloud, first.svc);
    const p = { chatID: CHAT_IDS.imessageAlice, text: "once", idempotencyKey: "restart_key_01" };
    expect((await first.cloud.req("send_message", p)).res.ok).toBe(true);
    await first.svc.stop(500);
    const svc2 = await startService({ paths: first.paths, secrets: first.secrets, version: "0.1.0", healthIntervalMs: 60_000, backoff: () => 30 });
    cleanup.push(() => svc2.stop(0));
    await connected(first.cloud, svc2);
    const again = await first.cloud.req("send_message", p);
    expect(again.res.ok).toBe(true);
    expect(fb.writes().filter((w) => w.route === "POST /v1/chats/{chatID}/messages").length).toBe(1);
  });
});
