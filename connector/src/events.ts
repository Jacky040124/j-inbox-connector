// Beeper -> cloud events. BeeperEventStream keeps a /v1/ws subscription alive (resubscribing after
// every drop): it waits for the server's `ready`, sends `subscriptions.set` with a requestID, and
// counts as subscribed only when `subscriptions.updated` echoes ["*"]; an `error` for the `app`
// key is retried once without it; a handshake that does not finish in time is closed and retried; HealthMonitor checks Beeper every 30 s and reports changes as status events
// (reachable:false is "Beeper down") and re-sends it every few checks; Reconciler refetches
// recent chats after every subscription (also the first: Beeper may have come up after us),
// because Beeper's socket is at-most-once. Every frame is metadata only.
import { BEEPER_APP_STATES, BEEPER_HEALTH_INTERVAL_MS, backoffDelay, eventFrame, parse, sanitizeLine, type BeeperHealth, type EventFrame } from "@j-inbox/protocol";
import type { BeeperClient } from "./beeper-client.ts";
import { mapBeeperEvent, parseBeeperControl, subscribeCommand } from "./beeper-ws.ts";
import { mapChat } from "./beeper-map.ts";
import type { SocketFactory, SocketLike } from "./cloud-link.ts";

const MAX_BEEPER_MESSAGE_BYTES = 1_000_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function beeperWsURL(baseURL: string): string {
  const u = new URL(baseURL);
  if (!LOOPBACK.has(u.hostname)) throw new Error("Beeper must be on this computer (127.0.0.1).");
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/v1/ws";
  u.search = "";
  u.hash = "";
  return u.toString();
}

function parseJSON(text: unknown): unknown {
  if (typeof text !== "string" || text.length > MAX_BEEPER_MESSAGE_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseBeeperMessage(text: string, ctx: { beeperVersion: string | null; now: string }): EventFrame[] {
  const msg = parseJSON(text);
  return msg === undefined ? [] : mapBeeperEvent(msg, ctx);
}

const defaultFactory: SocketFactory = (url, headers) => new WebSocket(url, { headers } as any) as unknown as SocketLike;

export type BeeperEventStreamOptions = {
  baseURL: string;
  token: string;
  onFrames: (frames: EventFrame[]) => void;
  /** Every successful (re)subscription; first is true only for the first one. Re-sync when false. */
  onOpen?: (first: boolean) => void;
  beeperVersion: () => string | null;
  backoff?: (attempt: number) => number;
  stableMs?: number;
  /** From socket creation to a confirmed subscription. Default 20 s. */
  handshakeTimeoutMs?: number;
  socketFactory?: SocketFactory;
  log?: (msg: string, fields?: Record<string, string | number | boolean | null>) => void;
};

export class BeeperEventStream {
  private ws: SocketLike | null = null;
  private gen = 0;
  private attempt = 0;
  private opens = 0;
  private openedAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  /** Cleared for the rest of this stream's life once Beeper refuses the `app` key. */
  private withApp = true;
  private stopped = true;
  private readonly url: string;

  constructor(private readonly o: BeeperEventStreamOptions) {
    this.url = beeperWsURL(o.baseURL);
  }

  get connected(): boolean {
    return this.ws !== null && this.openedAt > 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.handshakeTimer);
    this.gen++;
    try {
      this.ws?.close(1000);
    } catch {}
    this.ws = null;
  }

  private connect() {
    if (this.stopped) return;
    const gen = ++this.gen;
    this.openedAt = 0;
    let ws: SocketLike;
    try {
      ws = (this.o.socketFactory ?? defaultFactory)(this.url, { authorization: `Bearer ${this.o.token}` });
    } catch {
      return this.retry(gen);
    }
    this.ws = ws;
    let requestID: string | null = null;
    let retriedWithoutApp = false;
    const subscribe = () => {
      requestID = `jinbox-sub-${this.gen}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        ws.send(JSON.stringify(subscribeCommand(requestID, this.withApp)));
      } catch {
        this.drop(gen, "send failed");
      }
    };
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => {
      if (gen === this.gen && !this.openedAt) this.drop(gen, "handshake timed out");
    }, this.o.handshakeTimeoutMs ?? 20_000);
    // Nothing is sent on open: the spec says to subscribe after the server's `ready`.
    ws.onopen = () => {};
    ws.onmessage = (ev) => {
      if (gen !== this.gen) return;
      const msg = parseJSON(ev.data);
      if (msg === undefined) return;
      const c = parseBeeperControl(msg);
      if (c) {
        if (c.kind === "ready") {
          if (!this.openedAt && requestID === null) subscribe();
        } else if (c.kind === "subscribed") {
          if (this.openedAt || (c.requestID !== null && c.requestID !== requestID)) return;
          if (!c.all) return this.drop(gen, "subscription not confirmed");
          clearTimeout(this.handshakeTimer);
          this.openedAt = Date.now();
          const first = this.opens++ === 0;
          this.o.log?.("beeper: events subscribed", { first, appState: this.withApp });
          try {
            this.o.onOpen?.(first);
          } catch {}
        } else if (!this.openedAt && (c.requestID === null || c.requestID === requestID)) {
          this.o.log?.("beeper: subscription refused", { code: c.code });
          if (this.withApp && !retriedWithoutApp && (c.code === "INVALID_PAYLOAD" || c.code === "INVALID_COMMAND")) {
            retriedWithoutApp = true;
            this.withApp = false;
            this.o.log?.("beeper: subscribing without app state");
            subscribe();
          } else this.drop(gen, "subscription refused");
        }
        return;
      }
      const frames = mapBeeperEvent(msg, { beeperVersion: this.o.beeperVersion(), now: new Date().toISOString() });
      if (frames.length)
        try {
          this.o.onFrames(frames);
        } catch {}
    };
    ws.onclose = () => this.retry(gen);
    ws.onerror = () => {};
  }

  /** Close this socket and go to the retry path now (a dead peer may never send a close). */
  private drop(gen: number, why: string) {
    if (gen !== this.gen) return;
    this.o.log?.("beeper: events socket reset", { why });
    const ws = this.ws;
    try {
      if (ws?.terminate) ws.terminate();
      else ws?.close(1000);
    } catch {}
    this.retry(gen);
  }

  private retry(gen: number) {
    if (gen !== this.gen || this.stopped) return;
    this.gen++;
    this.ws = null;
    clearTimeout(this.handshakeTimer);
    if (this.openedAt && Date.now() - this.openedAt >= (this.o.stableMs ?? 30_000)) this.attempt = 0;
    this.openedAt = 0;
    const delay = (this.o.backoff ?? backoffDelay)(this.attempt++);
    this.timer = setTimeout(() => this.connect(), delay);
  }
}

export type HealthMonitorOptions = {
  client: BeeperClient;
  intervalMs?: number;
  /** A status event, sent whenever reachable / version / tokenValid / appState change. */
  onChange?: (f: EventFrame) => void;
  /** Also re-send the unchanged status every this many checks (default 10, 5 min), in case one was lost on the way. */
  resendEvery?: number;
};

export class HealthMonitor {
  private health: BeeperHealth = { reachable: false, version: null };
  private appState: BeeperHealth["appState"];
  private known = false;
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<BeeperHealth> | null = null;
  private checksSinceEmit = 0;

  constructor(private readonly o: HealthMonitorOptions) {}

  get current(): BeeperHealth {
    return this.withAppState(this.health);
  }

  private withAppState(h: BeeperHealth): BeeperHealth {
    return h.reachable && this.appState ? { ...h, appState: this.appState } : h;
  }

  statusFrame(): EventFrame {
    return { type: "event", kind: "status", ts: new Date().toISOString(), beeper: this.current };
  }

  start() {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.o.intervalMs ?? BEEPER_HEALTH_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  setAppState(state: unknown) {
    const s = (BEEPER_APP_STATES as readonly string[]).includes(state as string) ? (state as BeeperHealth["appState"]) : "unknown";
    if (s === this.appState) return;
    this.appState = s;
    // Before the first check, health is unknown: emitting now would report Beeper as down.
    if (this.known) this.emit();
  }

  private emit() {
    this.checksSinceEmit = 0;
    const f = this.statusFrame();
    if (parse(eventFrame, f).ok) this.o.onChange?.(f);
  }

  /** One check (concurrent callers share it). */
  check(): Promise<BeeperHealth> {
    if (!this.running)
      this.running = this.probe().finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async probe(): Promise<BeeperHealth> {
    const info = await this.o.client.get("/v1/info");
    let next: BeeperHealth;
    if (!info.ok) next = { reachable: false, version: null };
    else {
      const raw = (info.body as any)?.app?.version;
      const version = typeof raw === "string" ? sanitizeLine(raw, 64) || null : null;
      const acc = await this.o.client.get("/v1/accounts");
      next = acc.ok ? { reachable: true, version, tokenValid: true } : acc.error.code === "BEEPER_UNAUTHORIZED" ? { reachable: true, version, tokenValid: false } : { reachable: false, version: null };
    }
    if (!next.reachable) this.appState = undefined;
    const changed = !this.known || next.reachable !== this.health.reachable || next.version !== this.health.version || next.tokenValid !== this.health.tokenValid;
    this.health = next;
    this.known = true;
    if (changed || ++this.checksSinceEmit >= Math.max(1, this.o.resendEvery ?? 10)) this.emit();
    return this.current;
  }
}

/** After a reconnect, tell the cloud about every recent chat that changed since it last heard. */
export class Reconciler {
  private seen = new Map<string, string>();
  private running: Promise<number> | null = null;

  constructor(private readonly o: { client: BeeperClient; send: (f: EventFrame) => boolean; limit?: number }) {}

  run(): Promise<number> {
    if (!this.running)
      this.running = this.once().finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async once(): Promise<number> {
    const r = await this.o.client.get(`/v1/chats?limit=${this.o.limit ?? 50}`);
    if (!r.ok || !Array.isArray((r.body as any)?.items)) return 0;
    let n = 0;
    const ts = new Date().toISOString();
    for (const raw of (r.body as any).items as unknown[]) {
      const c = mapChat(raw);
      if (!c) continue;
      const fp = `${c.lastActivity}|${c.unreadCount}|${c.isArchived}|${c.isMarkedUnread ?? ""}`;
      if (this.seen.get(c.id) === fp) continue;
      const f: EventFrame = { type: "event", kind: "chat", op: "upserted", chatID: c.id, ts, unreadCount: c.unreadCount };
      if (!parse(eventFrame, f).ok || !this.o.send(f)) continue;
      this.seen.set(c.id, fp);
      n++;
    }
    while (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value!);
    return n;
  }
}
