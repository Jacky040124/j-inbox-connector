// Sync ("sync.v1") in the whole background service, against fake Beeper and a fake cloud: the
// hello says sync.v1 once inbox.db is open and its first build has started; the first build fills
// the window; sync_pull answers a snapshot then deltas that rebuild what inbox.db holds; Beeper's
// changes and the owner's own actions go out as `sync` frames, the latter with the request's opId;
// nothing is kept for a link that is down; a restart keeps the epoch.
import { afterAll, afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { FAKE_GOOGLE_CLIENT, OWNER_EMAIL, THREADS, startFakeGoogle, type RunningFakeGoogle } from "@j-inbox/fake-google";
import { MAX_FRAME_BYTES, parse, syncPullResult, type SyncChange, type SyncPullResult } from "@j-inbox/protocol";
import { resolvePaths, saveConfig, type Paths } from "../src/config.ts";
import { MemorySecretStore } from "../src/secrets.ts";
import { startService } from "../src/service.ts";
import { InboxDB } from "../src/inbox/db.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";
import { Replica, plain } from "./helpers/replica.ts";

// Random runs, whole services and first builds: slower than bun's 5 s default on a CI machine.
setDefaultTimeout(30_000);

const TOKEN = "jid_" + "Y".repeat(43);
let fb: FakeBeeper;
let fg: RunningFakeGoogle;
beforeAll(async () => {
  // The fixture's clock is the real one: the window is reckoned from now.
  fb = await startFakeBeeper({ fixtureNow: Date.now() });
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

const keys = new Map<string, Uint8Array>();
/** inbox.db as the service keeps it (sealed with its key). */
const openDB = (paths: Paths) => InboxDB.open({ path: paths.inboxFile, key: keys.get(paths.inboxFile) });

async function boot(o: { paths?: Paths; cloud?: FakeCloud; secrets?: MemorySecretStore } = {}) {
  const cloud = o.cloud ?? (await startFakeCloud({ token: TOKEN, google: { url: fg.url, clientId: FAKE_GOOGLE_CLIENT.id, clientSecret: FAKE_GOOGLE_CLIENT.secret } }));
  if (!o.cloud) cleanup.push(() => cloud.stop());
  const paths = o.paths ?? resolvePaths({ HOME: "/nonexistent", J_INBOX_CONFIG_DIR: mkdtempSync(join(tmpdir(), "jinbox-sync-")) });
  saveConfig(paths, { cloudURL: cloud.url, beeperURL: fb.url, deviceID: "dev_sync1", deviceName: "Test Mac" });
  // The same Keychain across a restart: inbox.db is sealed with its inbox-key.
  const secrets = o.secrets ?? new MemorySecretStore();
  await secrets.set("beeper-token", fb.token);
  await secrets.set("device-token", TOKEN);
  const env = { J_INBOX_GMAIL_API_URL: fg.url, J_INBOX_GOOGLE_OAUTH_URL: fg.url };
  const svc = await startService({ paths, secrets, version: "0.1.0", healthIntervalMs: 60_000, backoff: () => 30, noiseDebounceMs: 50, inboxPaceMs: 0, env, gmailPollIntervalMs: 100 });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await svc.stop(0);
  };
  cleanup.push(stop);
  await cloud.waitFor(() => svc.link?.state.status === "connected", 4000, "connected");
  // The service made inbox.db's key in the Keychain; the test opens inbox.db with it (any other key would make it again).
  keys.set(paths.inboxFile, Buffer.from((await secrets.get("inbox-key"))!, "base64url"));
  return { cloud, paths, svc, stop, secrets };
}

const pull = async (cloud: FakeCloud, params: Record<string, unknown>): Promise<SyncPullResult> => {
  const r = await cloud.req("sync_pull", params);
  if (!r.res.ok) throw new Error(`sync_pull: ${r.res.error?.code}`);
  expect(parse(syncPullResult, r.res.data).ok).toBe(true);
  return r.res.data as SyncPullResult;
};

/** What a page does with no replica: snapshot pages, then deltas until up to date. */
async function syncPage(cloud: FakeCloud, replica = new Replica()): Promise<Replica> {
  if (replica.epoch === null) {
    const all: any[] = [];
    let r = await pull(cloud, {});
    for (;;) {
      if (r.kind !== "snapshot") throw new Error("snapshot expected");
      all.push(...r.chats);
      if (!r.next) break;
      r = await pull(cloud, { page: r.next });
    }
    replica.replace(r.epoch, r.head, all);
  }
  for (;;) {
    const d = await pull(cloud, { epoch: replica.epoch, cursor: replica.cursor });
    if (d.kind !== "delta") throw new Error("delta expected");
    replica.applyAll(d.changes);
    if (!d.more) return replica;
  }
}

/** The first build is done (or, with `key`, that source's: build:gmail:<address>). */
const built = (paths: Paths, key?: string) => {
  const db = openDB(paths);
  try {
    return key ? JSON.parse(db.meta(key) ?? "{}").done === true : !!db.meta("build.done");
  } finally {
    db.close();
  }
};
const changesIn = (cloud: FakeCloud): SyncChange[] => cloud.syncs().flatMap((f) => f.changes);

describe("sync in the service", () => {
  test("hello says sync.v1; the first build fills inbox.db (0600, in the data dir) with the window; a snapshot and deltas rebuild it", async () => {
    const { cloud, paths, svc, stop } = await boot();
    expect((cloud.hello() as any).capabilities).toContain("sync.v1");
    expect(paths.inboxFile).toBe(join(paths.dataDir, "inbox.db"));
    await cloud.waitFor(() => built(paths), 15_000, "first build");
    expect(statSync(paths.inboxFile).mode & 0o777).toBe(0o600);
    const page = await syncPage(cloud);
    // Every chat in the window, with its newest messages; the archived fixture chat's activity is long ago, so it is not there.
    const ids = [...page.chats.keys()];
    expect(ids).toContain(CHAT_IDS.imessageAlice);
    expect(ids).toContain(CHAT_IDS.longHistory);
    expect(page.messages.get(CHAT_IDS.longHistory)!.size).toBe(50);
    // The chat as read_chat answers it (decorated: the To do flag), the messages the newest 50.
    const rc = await cloud.req("read_chat", { chatID: CHAT_IDS.longHistory, limit: 50 });
    const read = rc.res.data as any;
    expect(page.chats.get(CHAT_IDS.longHistory)).toMatchObject({ id: read.chat.id, title: read.chat.title, unreadCount: read.chat.unreadCount, todo: read.chat.todo });
    expect([...page.messages.get(CHAT_IDS.longHistory)!.keys()].sort()).toEqual(read.items.map((m: any) => m.id).sort());
    // Every frame the connector sent was valid and under a frame's size.
    expect(cloud.bad).toEqual([]);
    for (const raw of cloud.raw) expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    await stop();
    const db = openDB(paths);
    expect(plain(page.state())).toEqual(plain(db.dump()));
    db.close();
    expect(svc.link).toBeTruthy();
  });

  test("a new Beeper message goes out as a sync frame with the message; a page that applies the frames stays equal to inbox.db", async () => {
    const { cloud, paths } = await boot();
    await cloud.waitFor(() => built(paths), 15_000, "first build");
    const page = await syncPage(cloud);
    await cloud.waitFor(() => fb.wsClientCount() === 1, 3000, "beeper ws");
    const from = cloud.syncs().length;
    const m = fb.state.receive(CHAT_IDS.imessageAlice, { text: "sync me please" });
    await cloud.waitFor(() => changesIn(cloud).some((c) => c.op === "messages.upsert" && c.messages.some((x) => x.id === m.id)), 5000, "sync frame");
    const frames = cloud.syncs().slice(from);
    const change = frames.flatMap((f) => f.changes).find((c) => c.op === "messages.upsert" && c.messages.some((x) => x.id === m.id))!;
    expect(change).toMatchObject({ op: "messages.upsert", chatID: CHAT_IDS.imessageAlice });
    expect((change as any).messages.find((x: any) => x.id === m.id).text).toBe("sync me please");
    expect(change.opId).toBeUndefined();
    // The page applies the pushed frames in seq order (no gap after its cursor) and has what inbox.db has.
    for (const c of frames.flatMap((f) => f.changes)) {
      if (c.seq <= page.cursor) continue;
      expect(c.seq).toBe(page.cursor + 1);
      page.apply(c);
    }
    expect(page.chats.get(CHAT_IDS.imessageAlice)!.preview?.id).toBe(m.id);
    const again = await syncPage(cloud, page);
    expect(again.cursor).toBe(page.cursor);
  });

  test("the owner's actions: the changes they cause carry the request's opId (send, mark read, To do), and are in inbox.db when the answer comes", async () => {
    const { cloud, paths } = await boot();
    await cloud.waitFor(() => built(paths), 15_000, "first build");
    const page = await syncPage(cloud);
    const send = await cloud.req("send_message", { chatID: CHAT_IDS.pinnedUnread, text: "from the page", idempotencyKey: "sync_key_0001" }, { opId: "op_send00001" });
    expect(send.res.ok).toBe(true);
    // Already in inbox.db: a delta pulled right after the answer has it, with the opId.
    const d = await pull(cloud, { epoch: page.epoch, cursor: page.cursor });
    const mine = d.kind === "delta" ? d.changes.filter((c) => c.opId === "op_send00001") : [];
    expect(mine.some((c) => c.op === "messages.upsert" && c.messages.some((x) => x.text === "from the page" && x.isSender))).toBe(true);
    await cloud.waitFor(() => changesIn(cloud).some((c) => c.opId === "op_send00001"), 3000, "pushed with the opId");

    const read = await cloud.req("mark_read", { chatID: CHAT_IDS.muted }, { opId: "op_read00001" });
    expect(read.res.ok).toBe(true);
    await cloud.waitFor(() => changesIn(cloud).some((c) => c.opId === "op_read00001"), 3000, "mark_read change");
    const up = changesIn(cloud).find((c) => c.opId === "op_read00001" && c.op === "chat.upsert") as Extract<SyncChange, { op: "chat.upsert" }>;
    expect(up.chat).toMatchObject({ id: CHAT_IDS.muted, unreadCount: 0 });

    const todo = await cloud.req("set_todo", { chatID: CHAT_IDS.imessageWeird, todo: true }, { opId: "op_todo00001" });
    expect(todo.res.ok).toBe(true);
    await cloud.waitFor(() => changesIn(cloud).some((c) => c.opId === "op_todo00001"), 3000, "set_todo change");
    expect(changesIn(cloud).find((c) => c.opId === "op_todo00001")).toMatchObject({ op: "chat.upsert", chat: { id: CHAT_IDS.imessageWeird, todo: true } });
    // A request without one: its changes carry none.
    await cloud.req("set_todo", { chatID: CHAT_IDS.imessageWeird, todo: false });
    await cloud.waitFor(() => changesIn(cloud).some((c) => c.op === "chat.upsert" && c.chat.id === CHAT_IDS.imessageWeird && c.chat.todo === false), 3000, "untagged");
    expect(changesIn(cloud).find((c) => c.op === "chat.upsert" && c.chat.id === CHAT_IDS.imessageWeird && c.chat.todo === false)!.opId).toBeUndefined();
  });

  test("a chat archived and deleted at Beeper leaves the replica", async () => {
    const { cloud, paths } = await boot();
    await cloud.waitFor(() => built(paths), 15_000, "first build");
    const page = await syncPage(cloud);
    expect(page.chats.has(CHAT_IDS.readOnly)).toBe(true);
    await cloud.waitFor(() => fb.wsClientCount() === 1, 3000, "beeper ws");
    fb.state.deleteChat(CHAT_IDS.readOnly);
    await cloud.waitFor(() => changesIn(cloud).some((c) => c.op === "chat.remove" && c.chatID === CHAT_IDS.readOnly), 5000, "chat.remove");
    await syncPage(cloud, page);
    expect(page.chats.has(CHAT_IDS.readOnly)).toBe(false);
  });

  test("while the cloud link is down, sync frames are not kept: after the welcome the page catches up by cursor; a restart keeps the epoch", async () => {
    const cloud = await startFakeCloud({ token: TOKEN });
    cleanup.push(() => cloud.stop());
    const first = await boot({ cloud });
    await cloud.waitFor(() => built(first.paths), 15_000, "first build");
    const page = await syncPage(cloud);
    await cloud.waitFor(() => fb.wsClientCount() === 1, 3000, "beeper ws");
    cloud.state.autoWelcome = false;
    cloud.close(1012);
    await cloud.waitFor(() => first.svc.link?.state.status !== "connected", 3000, "down");
    const before = cloud.syncs().length;
    const m = fb.state.receive(CHAT_IDS.imessageAlice, { text: "while down" });
    // inbox.db took it in, with nobody to tell.
    await Bun.sleep(300);
    cloud.state.autoWelcome = true;
    cloud.welcomeNow();
    await cloud.waitFor(() => first.svc.link?.state.status === "connected", 4000, "up again");
    await Bun.sleep(200);
    expect(cloud.syncs().slice(before).flatMap((f) => f.changes).some((c) => c.op === "messages.upsert" && c.messages.some((x) => x.id === m.id))).toBe(false);
    await syncPage(cloud, page);
    expect(page.messages.get(CHAT_IDS.imessageAlice)!.has(m.id)).toBe(true);
    // A restart: the same inbox.db, the same epoch; the page goes on with a delta.
    await first.stop();
    const second = await boot({ cloud, paths: first.paths, secrets: first.secrets });
    expect(existsSync(first.paths.inboxFile)).toBe(true);
    const d = await pull(cloud, { epoch: page.epoch, cursor: page.cursor });
    expect(d.kind).toBe("delta");
    expect(d.epoch).toBe(page.epoch!);
    expect(second.svc.link).toBeTruthy();
  });

  test("Gmail: an account connected later gets its own build; new mail goes out as a change; a removed account's threads leave, with the opId", async () => {
    const { cloud, paths } = await boot();
    await cloud.waitFor(() => built(paths), 15_000, "first build");
    const rt = fg.google.issueRefreshToken(OWNER_EMAIL);
    expect((await cloud.req("gmail_connect", { email: OWNER_EMAIL, refreshToken: rt })).res.ok).toBe(true);
    const lunch = `gmail:${OWNER_EMAIL}:${THREADS.lunch}`;
    const archived = `gmail:${OWNER_EMAIL}:${THREADS.archived}`;
    await cloud.waitFor(() => changesIn(cloud).some((c) => c.op === "chat.upsert" && c.chat.id === lunch), 10_000, "gmail threads built");
    await cloud.waitFor(() => built(paths, `build:gmail:${OWNER_EMAIL}`), 15_000, "gmail build done");
    const page = await syncPage(cloud);
    expect(page.chats.get(lunch)).toMatchObject({ id: lunch, network: "Gmail" });
    // Archived, but recent: in the window.
    expect(page.chats.has(archived)).toBe(true);
    fg.google.deliver(OWNER_EMAIL, { threadId: THREADS.lunch, from: "Alice <alice@example.com>", subject: "Re: Lunch on Friday?", text: "SYNCED-MAIL-TEXT" });
    await cloud.waitFor(() => changesIn(cloud).some((c) => c.op === "messages.upsert" && c.chatID === lunch && c.messages.some((m) => m.text?.includes("SYNCED-MAIL-TEXT"))), 5000, "mail as a change");
    const rm = await cloud.req("remove_account", { accountID: `gmail:${OWNER_EMAIL}` }, { opId: "op_rmacct001" });
    expect(rm.res.ok).toBe(true);
    await syncPage(cloud, page);
    expect([...page.chats.keys()].filter((id) => id.startsWith("gmail:"))).toEqual([]);
    expect(changesIn(cloud).filter((c) => c.op === "chat.remove" && c.chatID.startsWith("gmail:")).every((c) => c.opId === "op_rmacct001")).toBe(true);
    // Connected again, it is built again (its progress went with it).
    const db = openDB(paths);
    expect(db.meta(`build:gmail:${OWNER_EMAIL}`)).toBeUndefined();
    db.close();
  });
});
