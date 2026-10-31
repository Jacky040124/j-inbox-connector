// Nothing is lost while the cloud link is down (it drops every hour or two): Beeper events wait in a
// small buffer and go out after the next welcome; the Gmail poller keeps its history position until
// its events were handed to a connected link. The cloud's `viewers` frame makes Gmail polling faster
// while a J-Inbox page is open.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { FAKE_GOOGLE_CLIENT, OWNER_EMAIL, THREADS, startFakeGoogle, type RunningFakeGoogle } from "@j-inbox/fake-google";
import { CAPABILITIES, MAX_EVENT_IDS, gmailChatID, parseConnectorFrame, type EventFrame } from "@j-inbox/protocol";
import { CloudLink } from "../src/cloud-link.ts";
import { resolvePaths, saveConfig } from "../src/config.ts";
import { EVENT_BUFFER_MAX, EventBuffer } from "../src/event-buffer.ts";
import { GmailPoller } from "../src/gmail/poller.ts";
import type { GmailSource } from "../src/gmail/source.ts";
import { FileSecretStore } from "../src/secrets.ts";
import { startService } from "../src/service.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const TS = "2026-10-31T10:00:00.000Z";
const later = (s: number) => new Date(Date.parse(TS) + s * 1000).toISOString();
type MessageFrame = Extract<EventFrame, { kind: "message" }>;
const msg = (chatID: string, ids: string[], ts = TS, othersAt?: string | null, op: MessageFrame["op"] = "upserted"): MessageFrame => ({ type: "event", kind: "message", op, chatID, messageIDs: ids, ts, ...(othersAt !== undefined ? { othersAt } : {}) });
const chat = (chatID: string, ts = TS): EventFrame => ({ type: "event", kind: "chat", op: "upserted", chatID, ts });

describe("EventBuffer", () => {
  test("one entry per chat and kind: message ids merged, the newest time kept; oldest first out", () => {
    const b = new EventBuffer();
    b.add(msg("c1", ["m1"]));
    b.add(chat("c2"));
    b.add(msg("c1", ["m2", "m1"], later(5)));
    b.add(chat("c2", later(3)));
    b.add(msg("c1", ["m9"], TS, undefined, "deleted"));
    const out: EventFrame[] = [];
    expect(b.flush((f) => (out.push(f), true))).toBe(3);
    expect(out).toEqual([msg("c1", ["m1", "m2"], later(5)), chat("c2", later(3)), msg("c1", ["m9"], TS, undefined, "deleted")]);
    for (const f of out) expect(parseConnectorFrame(JSON.stringify(f)).ok).toBe(true);
    expect(b.size).toBe(0);
  });
  test("othersAt: the newest time someone else wrote wins; null only if every one was the owner's; unknown stays unknown", () => {
    const merged = (a: string | null | undefined, c: string | null | undefined) => {
      const b = new EventBuffer();
      b.add(msg("c", ["m1"], TS, a));
      b.add(msg("c", ["m2"], TS, c));
      const out: EventFrame[] = [];
      b.flush((f) => (out.push(f), true));
      return (out[0] as { othersAt?: string | null }).othersAt;
    };
    expect(merged(later(1), later(2))).toBe(later(2));
    expect(merged(later(2), null)).toBe(later(2));
    expect(merged(null, later(1))).toBe(later(1));
    expect(merged(null, null)).toBeNull();
    expect(merged(null, undefined)).toBeUndefined();
    expect(merged(undefined, undefined)).toBeUndefined();
  });
  test("more ids than one event carries: a chat event instead; status events are never kept", () => {
    const b = new EventBuffer();
    b.add(msg("c", Array.from({ length: MAX_EVENT_IDS }, (_, i) => `a${i}`)));
    b.add(msg("c", ["extra"], later(1)));
    expect(b.add({ type: "event", kind: "status", ts: TS, beeper: { reachable: true, version: null } })).toBe(false);
    const out: EventFrame[] = [];
    b.flush((f) => (out.push(f), true));
    expect(out).toEqual([chat("c", later(1))]);
  });
  test("bounded: past the limit the chats quiet the longest go; a chat changing again moves to the end", () => {
    const b = new EventBuffer(3);
    for (const id of ["a", "b", "c"]) b.add(chat(id));
    b.add(chat("a", later(1)));
    b.add(chat("d"));
    expect(b.size).toBe(3);
    expect(b.dropped).toBe(1);
    const out: string[] = [];
    b.flush((f) => (out.push((f as { chatID: string }).chatID), true));
    expect(out).toEqual(["c", "a", "d"]);
    expect(b.dropped).toBe(0);
    expect(EVENT_BUFFER_MAX).toBe(200);
    const big = new EventBuffer();
    for (let i = 0; i < 1000; i++) big.add(chat(`x${i}`));
    expect(big.size).toBe(200);
  });
  test("a flush the link refuses part way keeps the rest for the next one", () => {
    const b = new EventBuffer();
    for (const id of ["a", "b", "c"]) b.add(chat(id));
    let n = 0;
    expect(b.flush(() => ++n <= 1)).toBe(1);
    expect(b.size).toBe(2);
    const out: string[] = [];
    b.flush((f) => (out.push((f as { chatID: string }).chatID), true));
    expect(out).toEqual(["b", "c"]);
  });
});

describe("GmailPoller hands over before it moves on", () => {
  const EMAIL = "owner@example.com";
  function stub() {
    let history: unknown[] = [];
    let latest = "100";
    const starts: string[] = [];
    const client = {
      path: (parts: string[], q?: Record<string, unknown>) => `${parts.join("/")}?${new URLSearchParams(q as Record<string, string>)}`,
      get: async (path: string) => {
        if (!path.startsWith("history")) return { ok: false, error: { code: "NOT_FOUND" } };
        starts.push(new URLSearchParams(path.split("?")[1]).get("startHistoryId")!);
        return { ok: true, body: { history, historyId: latest } };
      },
    };
    const s = { email: EMAIL, client, profile: async () => ({ ok: true, data: { emailAddress: EMAIL, historyId: "100" } }) } as unknown as GmailSource;
    return {
      s,
      starts,
      mail(threadId: string, id: string, at: string) {
        history = [...history, { messagesAdded: [{ message: { id, threadId, labelIds: ["INBOX"] } }] }];
        latest = at;
      },
    };
  }
  test("send refused (link down): the same changes are read and announced again next time; then it moves on", async () => {
    const st = stub();
    let up = false;
    const sent: EventFrame[] = [];
    const p = new GmailPoller({ sources: () => [st.s], send: (f) => (up ? (sent.push(f), true) : false) });
    await p.poll(st.s);
    st.mail("tA", "m1", "150");
    await p.poll(st.s);
    expect(sent).toEqual([]);
    up = true;
    await p.poll(st.s);
    expect(sent.map((e) => [e.kind, (e as { chatID: string }).chatID])).toEqual([
      ["message", gmailChatID(EMAIL, "tA")],
      ["chat", gmailChatID(EMAIL, "tA")],
    ]);
    expect(st.starts).toEqual(["100", "100"]);
    await p.poll(st.s);
    expect(st.starts).toEqual(["100", "100", "150"]);
  });
  test("canSend false: no history reads (only the first start point); pollAll after the welcome catches up", async () => {
    const st = stub();
    let up = false;
    const sent: EventFrame[] = [];
    const p = new GmailPoller({ sources: () => [st.s], send: (f) => (sent.push(f), true), canSend: () => up });
    await p.pollAll(); // the start point
    st.mail("tB", "m2", "160");
    await p.pollAll();
    await p.pollAll();
    expect(st.starts).toEqual([]);
    up = true;
    await p.pollAll();
    expect(st.starts).toEqual(["100"]);
    expect(sent.some((e) => (e as { chatID: string }).chatID === gmailChatID(EMAIL, "tB"))).toBe(true);
  });
  test("setActive: the faster interval while a page is open, a poll at once when it opens, back to idle after", async () => {
    const st = stub();
    const p = new GmailPoller({ sources: () => [st.s], send: () => true, intervalMs: 60_000, activeIntervalMs: 40 });
    expect(p.intervalMs).toBe(60_000);
    p.start();
    await Bun.sleep(20);
    p.setActive(true);
    expect(p.intervalMs).toBe(40);
    await Bun.sleep(200);
    const busy = st.starts.length;
    expect(busy).toBeGreaterThanOrEqual(3);
    p.setActive(false);
    expect(p.intervalMs).toBe(60_000);
    await Bun.sleep(150);
    expect(st.starts.length).toBeLessThanOrEqual(busy + 1);
    p.stop();
    // Never slower than idle, whatever the active value.
    expect(new GmailPoller({ sources: () => [], send: () => true, intervalMs: 50, activeIntervalMs: 10_000 }).intervalMs).toBe(50);
  });
});

describe("CloudLink: viewers", () => {
  const clouds: FakeCloud[] = [];
  const links: CloudLink[] = [];
  afterEach(async () => {
    for (const l of links.splice(0)) await l.stop(0);
    for (const c of clouds.splice(0)) c.stop();
  });
  test("the hello says viewers.v1; the count reaches onViewers; a dropped link is 0; a bad frame changes nothing", async () => {
    const cloud = await startFakeCloud({ token: "jid_" + "V".repeat(43) });
    clouds.push(cloud);
    const seen: number[] = [];
    const link = new CloudLink({
      url: cloud.url,
      token: "jid_" + "V".repeat(43),
      deviceID: "dev_view1",
      connectorVersion: "0.1.0",
      hello: async () => ({ beeperVersion: null, networks: [] }),
      dispatcher: { dispatch: async () => ({ kind: "res", ok: true, data: {} }), isWrite: () => false },
      onViewers: (n) => seen.push(n),
      backoff: () => 30,
    });
    links.push(link);
    link.start();
    await cloud.waitFor(() => link.state.status === "connected", 3000, "connected");
    expect((cloud.hello() as { capabilities: string[] }).capabilities).toContain(CAPABILITIES.viewers);
    cloud.send({ type: "viewers", count: 2 });
    await cloud.waitFor(() => seen.length === 1, 2000, "viewers");
    cloud.send({ type: "viewers", count: -1 });
    cloud.send({ type: "viewers", count: 1, tab: "x" });
    cloud.send({ type: "viewers", count: 0 });
    await cloud.waitFor(() => seen.length === 2, 2000, "viewers 0");
    expect(seen).toEqual([2, 0]);
    cloud.send({ type: "viewers", count: 3 });
    await cloud.waitFor(() => seen.length === 3, 2000, "viewers 3");
    cloud.close(1011);
    await cloud.waitFor(() => seen.length === 4, 2000, "dropped");
    expect(seen).toEqual([2, 0, 3, 0]);
    await cloud.waitFor(() => link.state.status === "connected", 3000, "reconnected");
  });
});

describe("the service while the cloud link is down", () => {
  const TOKEN = "jid_" + "D".repeat(43);
  let fb: FakeBeeper;
  let fg: RunningFakeGoogle;
  beforeAll(async () => {
    fb = await startFakeBeeper();
    fg = await startFakeGoogle();
  });
  afterAll(() => {
    fb.stop();
    fg.stop();
  });
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0).reverse()) await c();
    fb.reset();
    fg.google.reset();
  });
  async function boot(o: { pollMs?: number; activeMs?: number } = {}) {
    const cloud = await startFakeCloud({ token: TOKEN, google: { url: fg.url, clientId: FAKE_GOOGLE_CLIENT.id, clientSecret: FAKE_GOOGLE_CLIENT.secret } });
    cleanup.push(() => cloud.stop());
    const paths = resolvePaths({ HOME: "/nonexistent", J_INBOX_CONFIG_DIR: mkdtempSync(join(tmpdir(), "jinbox-stale-")) });
    saveConfig(paths, { cloudURL: cloud.url, beeperURL: fb.url, deviceID: "dev_stale1", deviceName: "Test Mac" });
    const secrets = new FileSecretStore(paths.secretsFile);
    await secrets.set("beeper-token", fb.token);
    await secrets.set("device-token", TOKEN);
    const env = { J_INBOX_GMAIL_API_URL: fg.url, J_INBOX_GOOGLE_OAUTH_URL: fg.url };
    const svc = await startService({ paths, secrets, version: "0.1.0", healthIntervalMs: 60_000, backoff: () => 30, env, gmailPollIntervalMs: o.pollMs ?? 100, gmailActivePollIntervalMs: o.activeMs, noiseDebounceMs: 50 });
    cleanup.push(() => svc.stop(0));
    await cloud.waitFor(() => svc.link?.state.status === "connected", 4000, "connected");
    return { cloud, svc, paths };
  }
  const onConn = (cloud: FakeCloud, n: number) => cloud.frames.filter((f) => f.n === n && f.frame.type === "event").map((f) => f.frame as EventFrame);
  async function drop(cloud: FakeCloud, svc: Awaited<ReturnType<typeof boot>>["svc"]) {
    cloud.state.rejectUpgrades = 1000;
    cloud.close(1011);
    await cloud.waitFor(() => svc.link?.state.status !== "connected", 2000, "down");
  }
  async function back(cloud: FakeCloud, svc: Awaited<ReturnType<typeof boot>>["svc"]) {
    const n = cloud.connections;
    cloud.state.rejectUpgrades = 0;
    await cloud.waitFor(() => svc.link?.state.status === "connected" && cloud.connections > n, 4000, "back");
    return cloud.connections;
  }

  test("a Beeper message while the link is down reaches the cloud after the reconnect", async () => {
    const { cloud, svc } = await boot();
    await cloud.waitFor(() => fb.wsClientCount() === 1, 3000, "beeper ws");
    await drop(cloud, svc);
    fb.state.receive(CHAT_IDS.imessageAlice, { text: "WHILE-THE-CLOUD-WAS-AWAY" });
    await Bun.sleep(100);
    const n = await back(cloud, svc);
    await cloud.waitFor(() => onConn(cloud, n).some((e) => e.kind === "message" && e.chatID === CHAT_IDS.imessageAlice), 3000, "kept event");
    expect(JSON.stringify(cloud.frames)).not.toContain("WHILE-THE-CLOUD-WAS-AWAY");
  });

  test("Gmail mail while the link is down is announced after the reconnect (the poller did not skip it)", async () => {
    const { cloud, svc } = await boot({ pollMs: 80 });
    const rt = fg.google.issueRefreshToken(OWNER_EMAIL);
    expect((await cloud.req("gmail_connect", { email: OWNER_EMAIL, refreshToken: rt })).res.ok).toBe(true);
    await Bun.sleep(300); // a start point
    await drop(cloud, svc);
    fg.google.deliver(OWNER_EMAIL, { threadId: THREADS.lunch, from: "Alice <alice@example.com>", subject: "Re: Lunch", text: "while away" });
    await Bun.sleep(400);
    const historyWhileDown = fg.google.requests.filter((r) => r.path.endsWith("/history")).length;
    await Bun.sleep(300);
    // Not polled while nobody could hear it.
    expect(fg.google.requests.filter((r) => r.path.endsWith("/history")).length).toBe(historyWhileDown);
    const n = await back(cloud, svc);
    const id = gmailChatID(OWNER_EMAIL, THREADS.lunch);
    await cloud.waitFor(() => onConn(cloud, n).some((e) => e.kind === "message" && e.chatID === id), 3000, "gmail event after reconnect");
  });

  test("viewers: Gmail every few seconds while a page is open, and at once when it opens", async () => {
    const { cloud } = await boot({ pollMs: 60_000, activeMs: 60_000 });
    const rt = fg.google.issueRefreshToken(OWNER_EMAIL);
    expect((await cloud.req("gmail_connect", { email: OWNER_EMAIL, refreshToken: rt })).res.ok).toBe(true);
    await cloud.waitFor(() => fg.google.requests.some((r) => r.path.endsWith("/profile")), 3000, "start point");
    await Bun.sleep(100);
    fg.google.deliver(OWNER_EMAIL, { threadId: THREADS.kickoff, from: "Bob <bob@example.com>", subject: "Re: Kickoff", text: "hello" });
    const id = gmailChatID(OWNER_EMAIL, THREADS.kickoff);
    await Bun.sleep(300);
    expect(cloud.events().some((e: any) => e.chatID === id)).toBe(false);
    cloud.send({ type: "viewers", count: 1 });
    await cloud.waitFor(() => cloud.events().some((e: any) => e.kind === "message" && e.chatID === id), 3000, "polled when the page opened");
  });
});
