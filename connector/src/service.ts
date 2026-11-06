// The background service (`j-inbox run`, started by launchd): Beeper client + whitelist dispatcher
// + cloud link + Beeper events + health checks + re-sync + the noise judge (every conversation with
// new activity, Beeper's or Gmail's, is asked about) + To do, with the local audit log and a small
// metadata-only state file that `j-inbox status` reads.
import { watchContacts } from "./contacts.ts";
import { readFileSync } from "node:fs";
import type { EventFrame } from "@j-inbox/protocol";
import { createActions, createWriteDedupe } from "./actions.ts";
import { AssetAllowlist } from "./assets.ts";
import { AuditLog } from "./audit.ts";
import { createBeeperClient } from "./beeper-client.ts";
import { CloudLink, type LinkState, type SocketFactory } from "./cloud-link.ts";
import { gmailPollOverride, googleEndpoints, loadConfig, noiseDebounceOverride, noiseSendersWaitOverride, signinHelperExecutable, typesafeURL, writeAtomic, type Paths } from "./config.ts";
import { createChatLogin } from "./chat-login.ts";
import { createSigninWindows, signinExecutable } from "./signin-window.ts";
import { createDispatcher } from "./dispatcher.ts";
import { BeeperEventStream, HealthMonitor, Reconciler } from "./events.ts";
import { EventBuffer } from "./event-buffer.ts";
import { FileIdempotencyJournal } from "./idempotency.ts";
import { DraftStore } from "./drafts.ts";
import { UploadStore } from "./uploads.ts";
import type { SecretStore } from "./secrets.ts";
import { cloudTokenRefresher } from "./gmail/client.ts";
import { createGmailService } from "./gmail/service.ts";
import { NoiseStore } from "./noise/store.ts";
import { NoiseJudge } from "./noise/judge.ts";
import { SenderRules } from "./noise/senders.ts";
import { isAnyOwnAddress } from "./gmail/own.ts";
import { TodoStore } from "./todo/store.ts";
import { TodoTracker } from "./todo/tracker.ts";
import { GmailAccounts } from "./gmail/accounts.ts";
import { ThreadMetaCache } from "./gmail/meta-cache.ts";
import { isStorableSecret } from "./secrets.ts";
import { randomBytes } from "node:crypto";
import { UPDATE_COMMAND } from "./version.ts";

export type ServiceOptions = {
  paths: Paths;
  secrets: SecretStore;
  version: string;
  socketFactory?: SocketFactory;
  healthIntervalMs?: number;
  backoff?: (attempt: number) => number;
  log?: (line: string) => void;
  /** Environment for the Google endpoint overrides (tests only; see googleEndpoints). */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  gmailPollIntervalMs?: number;
  /** While a J-Inbox page is open (tests; default GMAIL_POLL_ACTIVE_INTERVAL_MS). */
  gmailActivePollIntervalMs?: number;
  /** The noise judge's collection window (tests). */
  noiseDebounceMs?: number;
};

export type ExitReason = "not_paired" | "no_beeper_token" | "config_error" | "shutdown" | "revoked" | "unauthenticated" | "replaced" | "version";
export type ServiceExit = { reason: ExitReason; exitCode: number; message?: string };

export type ServiceState = {
  v: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
  cloud: { status: LinkState["status"]; since: string; closeCode?: number; reason?: string };
  beeper: { reachable: boolean; version: string | null; tokenValid?: boolean; appState?: string };
};

export type Service = {
  link: CloudLink | null;
  done: Promise<ServiceExit>;
  stop(graceMs?: number): Promise<void>;
};

/** Reasons to stay down: exit 0, so launchd (KeepAlive SuccessfulExit=false) does not restart. */
const STAY_DOWN = new Set<ExitReason>(["not_paired", "no_beeper_token", "config_error", "revoked", "unauthenticated", "replaced", "version"]);

/**
 * Process exit code. 0 only for the stay-down reasons; a stop by a signal (kill, Activity Monitor's
 * Quit) is 128 + the signal number, so launchd restarts the job. `launchctl bootout` removes the
 * job itself, so uninstall still stops it for good.
 */
export function exitCodeFor(reason: ExitReason, signal: string | null): number {
  if (STAY_DOWN.has(reason)) return 0;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

const MESSAGES: Partial<Record<ExitReason, string>> = {
  not_paired: "This computer is not paired. Run `j-inbox pair`.",
  no_beeper_token: "No Beeper access token. Run `j-inbox setup`.",
  revoked: "This computer was removed in the J-Inbox web page. Run `j-inbox pair` to pair it again.",
  unauthenticated: "The cloud did not accept this computer's credential. Run `j-inbox pair`.",
  replaced: "Another computer was paired in this one's place. Run `j-inbox pair` to switch back.",
  version: `This connector is too old for the cloud. Update it: ${UPDATE_COMMAND}`,
};

export function readState(p: Paths): ServiceState | null {
  try {
    const j = JSON.parse(readFileSync(p.stateFile, "utf8"));
    return j && j.v === 1 && typeof j.pid === "number" && j.cloud && j.beeper ? (j as ServiceState) : null;
  } catch {
    return null;
  }
}

/**
 * The key that seals the Gmail metadata cache file: from the Keychain, made there (32 random bytes)
 * the first time the service runs a Gmail account. null (the cache stays in memory) when there is
 * no Gmail account or the Keychain cannot be used.
 */
async function gmailCacheKey(secrets: SecretStore, paths: Paths, create: boolean): Promise<Uint8Array | null> {
  try {
    let k = await secrets.get("gmail-cache-key");
    if (!k) {
      if (!create && !new GmailAccounts({ path: paths.gmailFile, secrets }).list().length) return null;
      k = randomBytes(32).toString("base64url");
      await secrets.set("gmail-cache-key", k);
    }
    const b = isStorableSecret(k) ? Buffer.from(k, "base64url") : null;
    return b && b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

export async function startService(o: ServiceOptions): Promise<Service> {
  const log = o.log ?? ((line: string) => console.error(`${new Date().toISOString()} ${line}`));
  const exitNow = (reason: ExitReason, message?: string): Service => {
    log(`j-inbox: ${message ?? MESSAGES[reason]}`);
    return { link: null, done: Promise.resolve({ reason, exitCode: exitCodeFor(reason, null), message: message ?? MESSAGES[reason] }), stop: async () => {} };
  };

  let config;
  let google: { gmailURL: string; oauthURL: string };
  let pollMs: number | undefined;
  let signinExe = "";
  let jevURL: string;
  let noiseDebounceMs: number | undefined;
  let sendersWaitMs: number | undefined;
  try {
    config = loadConfig(o.paths);
    google = googleEndpoints(o.env ?? {}, o.paths);
    jevURL = typesafeURL(o.env ?? {}, o.paths);
    noiseDebounceMs = o.noiseDebounceMs ?? noiseDebounceOverride(o.env ?? {}, o.paths);
    sendersWaitMs = noiseSendersWaitOverride(o.env ?? {}, o.paths);
    pollMs = o.gmailPollIntervalMs ?? gmailPollOverride(o.env ?? {}, o.paths);
    signinExe = signinHelperExecutable(o.env ?? {}, o.paths, signinExecutable);
  } catch (e) {
    return exitNow("config_error", (e as Error).message);
  }
  const deviceToken = await o.secrets.get("device-token");
  if (!deviceToken || !config.deviceID) return exitNow("not_paired");
  const beeperToken = await o.secrets.get("beeper-token");
  if (!beeperToken) return exitNow("no_beeper_token");

  const contacts = watchContacts({ file: o.paths.contactsFile, helperApp: o.paths.contactsHelperApp, run: (cmd) => Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }) });
  const audit = new AuditLog({ path: o.paths.auditFile });
  const startedAt = new Date().toISOString();
  const client = createBeeperClient({ baseURL: config.beeperURL, token: beeperToken });
  const assets = new AssetAllowlist({ path: o.paths.assetsFile });
  const idempotency = createWriteDedupe({ journal: new FileIdempotencyJournal(o.paths.idempotencyFile) });
  const noise = new NoiseStore({ path: o.paths.noiseFile });
  // A verdict that moves a chat in or out of Low priority is announced like any change (metadata only), so open pages refetch.
  const noiseMoved = (ids: string[]) => {
    const ts = new Date().toISOString();
    for (const chatID of ids) emit({ type: "event", kind: "chat", op: "upserted", chatID, ts });
  };
  const sourcesNow = () => gmail.sources().filter((s) => gmail.status(s.email) !== "reconnect_required");
  // The noise list of senders: Gmail only, with what it costs paced (noise/senders.ts).
  const senders = new SenderRules({
    store: noise,
    sources: sourcesNow,
    known: (email) => gmail.has(email),
    isOwn: isAnyOwnAddress,
    ownAddressesReady: () => gmail.refreshOwnAddresses(),
    onChange: noiseMoved,
    log: (m) => log(m),
    ...(sendersWaitMs !== undefined ? { timing: { startDelayMs: sendersWaitMs } } : {}),
  });
  // Late-bound: the tracker walks Beeper and Gmail through what is built next.
  const todo: TodoTracker = new TodoTracker({
    store: new TodoStore({ path: o.paths.todoFile, log: (m) => log(m) }),
    noise,
    beeperPage: (cursor, ctx) => actions.internals.chatsPage(cursor, ctx),
    gmail: sourcesNow,
    readChat: (p, ctx) => readChat(p, ctx),
    onChange: (chatID, flag) => emit({ type: "event", kind: "chat", op: "upserted", chatID, ts: new Date().toISOString(), todo: flag }),
    log: (m) => log(m),
  });
  const actions = createActions(client, { connectorVersion: o.version, assets, idempotency, noise, todo });
  // Gmail: tokens in the Keychain, access tokens refreshed through the cloud (the client secret
  // cannot ship in this open-source connector), Gmail itself reached directly from this Mac.
  const metaCache = new ThreadMetaCache({ path: o.paths.gmailCacheFile, key: await gmailCacheKey(o.secrets, o.paths, false) });
  const gmail = createGmailService({
    metaCache,
    secrets: o.secrets,
    path: o.paths.gmailFile,
    refresh: cloudTokenRefresher({ cloudURL: config.cloudURL, deviceToken, fetchImpl: o.fetchImpl }),
    gmailURL: google.gmailURL,
    oauthURL: google.oauthURL,
    fetchImpl: o.fetchImpl,
    pollIntervalMs: pollMs,
    activePollIntervalMs: o.gmailActivePollIntervalMs,
    log: (m) => log(m),
    onLifecycle: (e) => {
      audit.lifecycle(e);
      // The first Gmail account: from now on its list metadata is kept on disk too (sealed).
      if (e === "gmail.connected" && !metaCache.persistent) void gmailCacheKey(o.secrets, o.paths, true).then((k) => k && metaCache.persistTo(o.paths.gmailCacheFile, k));
      if (e === "gmail.connected") void todo.sync();
    },
    onNewAccount: (email) => todo.meetAccount(email),
    onChat: (c) => senders.seeChat(c),
    beforeAnnounce: (s, ids) => senders.lookAt(s, ids),
    onOwnAddresses: () => senders.ownAddressesChanged(),
  });
  const drafts = new DraftStore({ path: o.paths.draftsFile });
  const uploads = new UploadStore({ dir: o.paths.uploadsDir, draftAlive: (id) => drafts.has(id) });
  // Jev reads conversations through the dispatcher's router; the key is read from the Keychain each batch.
  let readChat: ConstructorParameters<typeof NoiseJudge>[0]["readChat"] = async () => ({ ok: false, error: { code: "INTERNAL", message: "starting" } });
  const judge = new NoiseJudge({
    store: noise,
    readChat: (p, ctx) => readChat(p, ctx),
    apiKey: () => o.secrets.get("typesafe-api-key"),
    url: jevURL,
    fetchImpl: o.fetchImpl,
    debounceMs: noiseDebounceMs,
    log: (m) => log(m),
    onChange: noiseMoved,
  });
  // Connecting chat apps from the page: Beeper's own sign-in, and for a website sign-in a window on this Mac.
  const chatLogin = createChatLogin({ client, windows: createSigninWindows({ executable: signinExe }) });
  const dispatcher = createDispatcher({ actions, client, assets, gmail, idempotency, drafts, uploads, noise, judge, todo, senders, chatLogin });
  readChat = dispatcher.readChat;

  let link: CloudLink;
  // Chat and message events while the cloud link is down wait here (bounded) for the next welcome.
  const pending = new EventBuffer();
  const connected = () => link?.state.status === "connected";
  const emit = (f: EventFrame) => link.sendEvent(f) || (!connected() && pending.add(f));
  // New activity (a message in, or the owner's own out) is judged again, and To do hears who wrote; the event goes on as before.
  const touch = (f: EventFrame) => {
    if (f.kind === "message" && f.op === "upserted") judge.touch(f.chatID, f.messageIDs);
    todo.event(f);
  };
  const send = (f: EventFrame) => (touch(f), emit(f));
  // Gmail keeps its own place in history instead: true only when the event really went out.
  const sendNow = (f: EventFrame) => (touch(f), link.sendEvent(f));
  let lastBeeper = "";
  const health = new HealthMonitor({
    client,
    intervalMs: o.healthIntervalMs,
    onChange: (f) => {
      send(f);
      if (f.kind !== "status") return;
      const b = f.beeper;
      const label = !b.reachable ? "beeper.down" : b.tokenValid === false ? "beeper.unauthorized" : "beeper.up";
      if (label !== lastBeeper) {
        lastBeeper = label;
        audit.lifecycle(label);
        log(`beeper: ${label.slice(7)}`);
      }
      writeState();
    },
  });
  const reconciler = new Reconciler({ client, send });
  const events = new BeeperEventStream({
    baseURL: config.beeperURL,
    token: beeperToken,
    beeperVersion: () => health.current.version,
    backoff: o.backoff,
    onFrames: (frames) => {
      for (const f of frames) {
        if (f.kind === "status") health.setAppState(f.beeper.appState);
        else send(f);
      }
    },
    // Every subscription, the first too: when Beeper starts after the connector, the welcome-time
    // re-sync found it down and sent nothing. Chats already reported are skipped by the Reconciler.
    onOpen: () => {
      void reconciler.run();
      void todo.sync();
    },
    log: (m) => log(m),
  });

  const writeState = () => {
    const s = link?.state;
    const h = health.current;
    const state: ServiceState = {
      v: 1,
      pid: process.pid,
      startedAt,
      updatedAt: new Date().toISOString(),
      cloud: { status: s?.status ?? "idle", since: new Date(s?.since ?? Date.now()).toISOString(), ...(s?.closeCode !== undefined ? { closeCode: s.closeCode } : {}), ...(s?.reason ? { reason: s.reason } : {}) },
      beeper: { reachable: h.reachable, version: h.version, ...(h.tokenValid !== undefined ? { tokenValid: h.tokenValid } : {}), ...(h.appState ? { appState: h.appState } : {}) },
    };
    try {
      writeAtomic(o.paths.stateFile, JSON.stringify(state) + "\n");
    } catch {}
  };

  link = new CloudLink({
    url: config.cloudURL,
    token: deviceToken,
    deviceID: config.deviceID,
    connectorVersion: o.version,
    dispatcher,
    socketFactory: o.socketFactory,
    backoff: o.backoff,
    hello: async () => {
      const h = await health.check();
      const gmailNetworks = gmail.emails().length ? ["Gmail"] : [];
      if (!h.reachable || h.tokenValid === false) return { beeperVersion: h.version, networks: gmailNetworks };
      const st = await actions.status({});
      return { beeperVersion: h.version, networks: [...new Set([...(st.ok ? (st.data.networks ?? []) : []), ...gmailNetworks])].sort() };
    },
    onWelcome: () => {
      send(health.statusFrame());
      const flushed = pending.flush((f) => link.sendEvent(f));
      if (flushed) log(`cloud: sent ${flushed} events kept while disconnected`);
      void reconciler.run();
      void gmail.pollNow();
      void todo.sync();
    },
    onViewers: (count) => gmail.setViewers(count),
    onRequest: (r) => audit.request(r),
    onState: (s) => {
      if (s.status === "connected") audit.lifecycle("cloud.connected");
      else if (s.status === "disconnected") audit.lifecycle("cloud.disconnected", s.closeCode !== undefined ? { closeCode: s.closeCode } : {});
      else if (s.status === "stopped") audit.lifecycle("cloud.stopped", s.closeCode !== undefined ? { closeCode: s.closeCode } : {});
      writeState();
    },
    log: (m, f) => log(f ? `${m} ${JSON.stringify(f)}` : m),
  });

  const flushTimer = setInterval(() => {
    try {
      assets.flush();
    } catch {}
    try {
      uploads.purge();
    } catch {}
  }, 60_000);

  let stopping: Promise<void> | null = null;
  const stopAll = (graceMs: number) =>
    (stopping ??= (async () => {
      contacts.stop();
      events.stop();
      health.stop();
      gmail.stopPolling();
      judge.stop();
      senders.stop();
      todo.stop();
      clearInterval(flushTimer);
      // Sign-ins in progress are cancelled on Beeper, and a sign-in window closes.
      await chatLogin.stop().catch(() => {});
      await link.stop(graceMs);
      try {
        assets.flush();
      } catch {}
      writeState();
      audit.lifecycle("service.stopped");
    })());

  audit.lifecycle("service.started");
  log(`j-inbox ${o.version}: starting (device ${config.deviceID})`);
  todo.start();
  senders.start();
  health.start();
  events.start();
  gmail.startPolling(sendNow, connected);
  link.start();
  writeState();

  const done = link.done.then(async (s): Promise<ServiceExit> => {
    await stopAll(0);
    const reason: ExitReason = s.reason ?? "shutdown";
    if (reason !== "shutdown") log(`j-inbox: ${MESSAGES[reason]}`);
    return { reason, exitCode: exitCodeFor(reason, null), ...(MESSAGES[reason] ? { message: MESSAGES[reason] } : {}) };
  });

  return { link, done, stop: (graceMs = 5000) => stopAll(graceMs) };
}
