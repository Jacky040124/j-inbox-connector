// Bun HTTP + WebSocket server for the fake Beeper Client API (127.0.0.1 only).
import type { Server, ServerWebSocket } from "bun";
import { createBeeperHandler, defaultControls, type Controls, type FailRule, type HangRule } from "./handler.ts";
import { FakeBeeperState, type Call, type DomainEvent } from "./state.ts";

export const FAKE_BEEPER_TOKEN = "fake-beeper-token-0123456789abcdef";

type WSData = { subs: string[]; seq: number; appState: boolean; ready: boolean; readyTimer?: ReturnType<typeof setTimeout> };

/** Beeper app.state.updated states (spec WSAppStateUpdatedMessage). */
export type BeeperAppState = "needs-login" | "initializing" | "needs-cross-signing-setup" | "needs-verification" | "needs-secrets" | "needs-first-sync" | "ready";

function appStatePayload(state: BeeperAppState) {
  const ready = state === "ready";
  return {
    state,
    ...(state === "needs-login" ? {} : { matrix: { userID: "@jackytest:beeper.com", deviceID: "FAKEDEVICE", homeserver: "https://matrix.beeper.com" } }),
    e2ee: {
      initialized: ready,
      secretStorage: ready,
      crossSigning: ready,
      verified: ready,
      secrets: { masterKey: ready, selfSigningKey: ready, userSigningKey: ready, megolmBackupKey: ready, recoveryKey: ready },
      keyBackup: ready,
      firstSyncDone: ready,
      hasBackedUpRecoveryKey: ready,
    },
  };
}

export type FakeBeeperOptions = { port?: number; token?: string; controls?: Partial<Controls> };

export type FakeBeeper = {
  readonly url: string;
  readonly wsURL: string;
  readonly port: number;
  readonly token: string;
  readonly state: FakeBeeperState;
  readonly controls: Controls;
  /** Accept another bearer token (e.g. to test token rotation). */
  addToken(token: string): void;
  revokeToken(token: string): void;
  /** Inject an error response; matches by method/path/route template, `times` defaults to 1. */
  failNext(rule: FailRule): void;
  /** Never answer matching requests until releaseHangs(). */
  hangNext(rule: HangRule): void;
  releaseHangs(): void;
  /** Change Beeper's app state; clients subscribed with app.state get app.state.updated. */
  setAppState(state: BeeperAppState): void;
  readonly appState: BeeperAppState;
  /** Close every /v1/ws client abruptly (no close frame, like a crash). */
  dropWebSockets(): void;
  wsClientCount(): number;
  /** Non-GET calls the fake handled, in order. */
  writes(): Call[];
  /** Stop listening (connections refused) but keep state; resume() listens on the same port again. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Restore the fixture, default controls, and clear rules, hangs and call log. */
  reset(): void;
  stop(): void;
};

export async function startFakeBeeper(opts: FakeBeeperOptions = {}): Promise<FakeBeeper> {
  let state = new FakeBeeperState();
  const tokens = new Set([opts.token ?? FAKE_BEEPER_TOKEN]);
  const controls: Controls = { ...defaultControls(), ...opts.controls };
  const failRules: FailRule[] = [];
  const hangRules: HangRule[] = [];
  const hangs = new Set<() => void>();
  const clients = new Set<ServerWebSocket<WSData>>();
  let port = opts.port ?? 0;
  let server: Server<WSData> | null = null;
  let unsubscribe: () => void = () => {};
  let appState: BeeperAppState = "ready";
  const sendAppState = (ws: ServerWebSocket<WSData>) =>
    ws.send(JSON.stringify({ type: "app.state.updated", seq: ws.data.seq++, ts: new Date().toISOString(), appState: appStatePayload(appState) }));

  const baseURL = () => `http://127.0.0.1:${port}`;
  const handler = createBeeperHandler({ state: () => state, controls, tokens, failRules, hangRules, hangs, baseURL });

  const fanOut = (e: DomainEvent) => {
    if (controls.dropEvents) return;
    for (const ws of clients) {
      if (!ws.data.subs.includes("*") && !ws.data.subs.includes(e.chatID)) continue;
      const msg: Record<string, unknown> = { type: e.type, seq: ws.data.seq++, ts: new Date().toISOString(), chatID: e.chatID, ids: e.ids };
      if (e.entries) msg.entries = e.entries;
      ws.send(JSON.stringify(msg));
    }
  };
  const bindState = () => {
    unsubscribe();
    unsubscribe = state.onEvent(fanOut);
  };
  bindState();

  const listen = () => {
    server = Bun.serve<WSData>({
      hostname: "127.0.0.1",
      port,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/ws") {
          const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
          if (!m || !tokens.has(m[1]!)) return new Response(JSON.stringify({ message: "Access token is missing or invalid", code: "UNAUTHORIZED" }), { status: 401 });
          if (srv.upgrade(req, { data: { subs: [], seq: 0, appState: false, ready: false } })) return undefined;
          return new Response("Upgrade failed", { status: 400 });
        }
        return handler(req);
      },
      websocket: {
        open(ws) {
          clients.add(ws);
          const ready = () => {
            ws.data.ready = true;
            if (clients.has(ws)) ws.send(JSON.stringify({ type: "ready", version: 1, chatIDs: [] }));
          };
          if (controls.wsNoReady) return;
          if (controls.wsReadyDelayMs > 0) ws.data.readyTimer = setTimeout(ready, controls.wsReadyDelayMs);
          else ready();
        },
        message(ws, raw) {
          const err = (code: string, message: string, requestID?: unknown): void => {
            ws.send(JSON.stringify({ type: "error", ...(typeof requestID === "string" ? { requestID } : {}), code, message }));
          };
          let msg: any;
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return err("INVALID_PAYLOAD", "Message is not valid JSON");
          }
          if (!ws.data.ready) return; // not ready yet: dropped without an answer
          if (!msg || typeof msg !== "object" || Array.isArray(msg)) return err("INVALID_PAYLOAD", "Message must be an object");
          if (msg.type !== "subscriptions.set") return err("INVALID_COMMAND", "Unknown command", msg.requestID);
          const ids = msg.chatIDs ?? [];
          const extra = Object.keys(msg).filter((k) => !["type", "requestID", "chatIDs", "app"].includes(k));
          if (!Array.isArray(ids) || !ids.every((x: unknown) => typeof x === "string") || extra.length) return err("INVALID_PAYLOAD", "Invalid subscriptions.set payload", msg.requestID);
          if (ids.includes("*") && ids.length > 1) return err("INVALID_PAYLOAD", '"*" cannot be combined with chat IDs', msg.requestID);
          const app = msg.app;
          if (app !== undefined && controls.wsRejectApp) return err("INVALID_PAYLOAD", "Unrecognized key: app", msg.requestID);
          if (app !== undefined && (!app || typeof app !== "object" || Array.isArray(app) || typeof app.state !== "boolean" || Object.keys(app).length !== 1))
            return err("INVALID_PAYLOAD", "app must be {state: boolean}", msg.requestID);
          ws.data.subs = ids;
          ws.data.appState = app?.state === true;
          if (controls.wsSilentSubscribe) return;
          ws.send(JSON.stringify({ type: "subscriptions.updated", ...(typeof msg.requestID === "string" ? { requestID: msg.requestID } : {}), chatIDs: ids, ...(app ? { app: { state: app.state } } : {}) }));
          if (ws.data.appState) sendAppState(ws);
          return;
        },
        close(ws) {
          clearTimeout(ws.data.readyTimer);
          clients.delete(ws);
        },
      },
    });
    port = server.port!;
  };
  listen();

  const releaseHangs = () => {
    for (const r of hangs) r();
    hangs.clear();
  };

  return {
    get url() {
      return baseURL();
    },
    get wsURL() {
      return `ws://127.0.0.1:${port}/v1/ws`;
    },
    get port() {
      return port;
    },
    token: opts.token ?? FAKE_BEEPER_TOKEN,
    get state() {
      return state;
    },
    controls,
    addToken: (t) => void tokens.add(t),
    revokeToken: (t) => void tokens.delete(t),
    failNext: (rule) => void failRules.push({ ...rule }),
    hangNext: (rule) => void hangRules.push({ ...rule }),
    releaseHangs,
    setAppState(state) {
      appState = state;
      for (const ws of clients) if (ws.data.appState) sendAppState(ws);
    },
    get appState() {
      return appState;
    },
    dropWebSockets() {
      for (const ws of [...clients]) {
        clients.delete(ws);
        ws.terminate();
      }
    },
    wsClientCount: () => clients.size,
    writes: () => state.calls.filter((c) => c.method !== "GET"),
    async pause() {
      releaseHangs();
      for (const ws of [...clients]) ws.terminate();
      clients.clear();
      server?.stop(true);
      server = null;
    },
    async resume() {
      if (!server) listen();
    },
    reset() {
      releaseHangs();
      failRules.length = 0;
      hangRules.length = 0;
      Object.assign(controls, defaultControls(), opts.controls);
      appState = "ready";
      state = new FakeBeeperState();
      bindState();
    },
    stop() {
      releaseHangs();
      unsubscribe();
      for (const ws of [...clients]) ws.terminate();
      server?.stop(true);
      server = null;
    },
  };
}
