// The background service (`j-inbox run`, started by launchd): Beeper client + whitelist dispatcher
// + cloud link + Beeper events + health checks + re-sync, with the local audit log and a small
// metadata-only state file that `j-inbox status` reads.
import { readFileSync } from "node:fs";
import type { EventFrame } from "@j-inbox/protocol";
import { createActions, createWriteDedupe } from "./actions.ts";
import { AssetAllowlist } from "./assets.ts";
import { AuditLog } from "./audit.ts";
import { createBeeperClient } from "./beeper-client.ts";
import { CloudLink, type LinkState, type SocketFactory } from "./cloud-link.ts";
import { gmailPollOverride, googleEndpoints, loadConfig, writeAtomic, type Paths } from "./config.ts";
import { createDispatcher } from "./dispatcher.ts";
import { BeeperEventStream, HealthMonitor, Reconciler } from "./events.ts";
import { FileIdempotencyJournal } from "./idempotency.ts";
import type { SecretStore } from "./secrets.ts";
import { cloudTokenRefresher } from "./gmail/client.ts";
import { createGmailService } from "./gmail/service.ts";

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
  version: "This connector is too old for the cloud. Update it (brew upgrade j-inbox).",
};

export function readState(p: Paths): ServiceState | null {
  try {
    const j = JSON.parse(readFileSync(p.stateFile, "utf8"));
    return j && j.v === 1 && typeof j.pid === "number" && j.cloud && j.beeper ? (j as ServiceState) : null;
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
  try {
    config = loadConfig(o.paths);
    google = googleEndpoints(o.env ?? {}, o.paths);
    pollMs = o.gmailPollIntervalMs ?? gmailPollOverride(o.env ?? {}, o.paths);
  } catch (e) {
    return exitNow("config_error", (e as Error).message);
  }
  const deviceToken = await o.secrets.get("device-token");
  if (!deviceToken || !config.deviceID) return exitNow("not_paired");
  const beeperToken = await o.secrets.get("beeper-token");
  if (!beeperToken) return exitNow("no_beeper_token");

  const audit = new AuditLog({ path: o.paths.auditFile });
  const startedAt = new Date().toISOString();
  const client = createBeeperClient({ baseURL: config.beeperURL, token: beeperToken });
  const assets = new AssetAllowlist({ path: o.paths.assetsFile });
  const idempotency = createWriteDedupe({ journal: new FileIdempotencyJournal(o.paths.idempotencyFile) });
  const actions = createActions(client, { connectorVersion: o.version, assets, idempotency });
  // Gmail: tokens in the Keychain, access tokens refreshed through the cloud (the client secret
  // cannot ship in this open-source connector), Gmail itself reached directly from this Mac.
  const gmail = createGmailService({
    secrets: o.secrets,
    path: o.paths.gmailFile,
    refresh: cloudTokenRefresher({ cloudURL: config.cloudURL, deviceToken, fetchImpl: o.fetchImpl }),
    gmailURL: google.gmailURL,
    oauthURL: google.oauthURL,
    fetchImpl: o.fetchImpl,
    pollIntervalMs: pollMs,
    log: (m) => log(m),
    onLifecycle: (e) => audit.lifecycle(e),
  });
  const dispatcher = createDispatcher({ actions, client, assets, gmail, idempotency });

  let link: CloudLink;
  const send = (f: EventFrame) => link.sendEvent(f);
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
    onOpen: () => void reconciler.run(),
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
      void reconciler.run();
      void gmail.pollNow();
    },
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
  }, 60_000);

  let stopping: Promise<void> | null = null;
  const stopAll = (graceMs: number) =>
    (stopping ??= (async () => {
      events.stop();
      health.stop();
      gmail.stopPolling();
      clearInterval(flushTimer);
      await link.stop(graceMs);
      try {
        assets.flush();
      } catch {}
      writeState();
      audit.lifecycle("service.stopped");
    })());

  audit.lifecycle("service.started");
  log(`j-inbox ${o.version}: starting (device ${config.deviceID})`);
  health.start();
  events.start();
  gmail.startPolling(send);
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
