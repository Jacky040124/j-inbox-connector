// The connector's link to its cloud room: wss://<app>/connect with the device token as a Bearer
// header. hello -> welcome, then answer req frames through the whitelist dispatcher under one
// deadline per request, with bounded concurrency and a bounded queue; stream get_media under
// ChunkWindow flow control; heartbeat; a connect timeout from socket creation to welcome;
// reconnect with backoffDelay (reset only after a stable connection), and after a long delay on
// 4410 SUPERSEDED; stop for good on 4403/4409/4426, and on 4401 only after it repeats (a token
// the cloud really rejects); graceful shutdown.
import {
  ACTIONS,
  CAPABILITIES,
  CLOSE_CODES,
  ChunkWindow,
  HEARTBEAT_TIMEOUT_MS,
  MAX_CONCURRENT_MEDIA_STREAMS,
  MAX_INFLIGHT_REQUESTS,
  MEDIA_TIMEOUT_MS,
  PROTOCOL_VERSION,
  backoffDelay,
  encodeFrame,
  mediaDeadlineMs,
  isActionName,
  isCloudAction,
  makeError,
  networkName,
  parse,
  parseCloudFrame,
  requestId,
  shouldReconnect,
  versionString,
  type ConnectorFrame,
  type ErrorBody,
  type ErrorCode,
  type EventFrame,
  type ReqFrame,
  type WelcomeFrame,
} from "@j-inbox/protocol";
import { requestContext } from "./actions.ts";
import type { DispatchResult } from "./dispatcher.ts";
import { pumpChunks } from "./media.ts";

export type LinkStatus = "idle" | "connecting" | "connected" | "disconnected" | "stopped";
export type StopReason = "shutdown" | "revoked" | "unauthenticated" | "replaced" | "version";
export type LinkState = { status: LinkStatus; since: number; closeCode?: number; reason?: StopReason };

export type RequestLog = { action: string; ok: boolean; code?: ErrorCode; ms: number; caller?: { type: "human" | "agent"; name?: string } };

/** The subset of WebSocket the link uses, so tests or other runtimes can supply one. */
export type SocketLike = {
  readyState: number;
  bufferedAmount?: number;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: any) => void) | null;
};
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export type CloudLinkOptions = {
  /** App origin, e.g. https://inbox.jackyzhonghq.com (http:// only for loopback dev servers). */
  url: string;
  token: string;
  deviceID: string;
  connectorVersion: string;
  /** Called before every hello. Failures and invalid values fall back to null / []. */
  hello: () => Promise<{ beeperVersion: string | null; networks: string[] }>;
  dispatcher: { dispatch(action: string, params: unknown, ctx?: { signal?: AbortSignal; deadline?: number }): Promise<DispatchResult>; isWrite(action: string): boolean };
  /** After every welcome (first connect and reconnects): re-sync, Beeper events are at-most-once. */
  onWelcome?: () => void;
  onState?: (s: LinkState) => void;
  onRequest?: (r: RequestLog) => void;
  log?: (msg: string, fields?: Record<string, string | number | boolean | null>) => void;
  backoff?: (attempt: number) => number;
  maxConcurrent?: number;
  maxPending?: number;
  welcomeTimeoutMs?: number;
  /** From socket creation to welcome (a stalled upgrade never fires onclose). Default 20 s. */
  connectTimeoutMs?: number;
  /** 4401s in a row (no welcome in between) before the link stops for good. Default 3. */
  unauthRetries?: number;
  /** Wait before reconnecting after 4410 SUPERSEDED (another socket of this device took over). Default 60 s. */
  supersededDelayMs?: number;
  /** A connection that lived this long resets the backoff. */
  stableMs?: number;
  heartbeatTimeoutMs?: number;
  /** Stop this long before the cloud's request timeout. */
  marginMs?: number;
  /** Events are dropped (never res frames) while this many bytes wait to be sent. */
  maxBufferedEventBytes?: number;
  socketFactory?: SocketFactory;
  platform?: { os: string; arch: string };
  /** Whole-stream limit for get_media (default protocol mediaDeadlineMs): a stuck stream frees its slot. */
  mediaDeadlineMs?: (size: number | null) => number;
};

type Entry = {
  id: string;
  action: string;
  gen: number;
  ctl: AbortController;
  answered: boolean;
  started: boolean;
  settled: boolean;
  media: boolean;
  window?: ChunkWindow;
  t0: number;
  caller?: RequestLog["caller"];
  timer?: ReturnType<typeof setTimeout>;
  /** Until dispatched: the params and the request's deadline context. */
  args?: { p: unknown; ctx: ReturnType<typeof requestContext>; minStartMs: number };
};

const OPEN = 1;
const SHUTDOWN_CODE = 1001;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function connectURL(appURL: string): string {
  const u = new URL(appURL);
  if (u.protocol === "https:") u.protocol = "wss:";
  else if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) u.protocol = "ws:";
  else throw new Error("The cloud URL must be https:// (http:// only for a loopback dev server).");
  if (u.username || u.password) throw new Error("The cloud URL must not carry credentials.");
  u.pathname = "/connect";
  u.search = "";
  u.hash = "";
  return u.toString();
}

const defaultFactory: SocketFactory = (url, headers) => new WebSocket(url, { headers } as any) as unknown as SocketLike;

const STOP_REASONS: Record<number, StopReason> = {
  [CLOSE_CODES.REVOKED]: "revoked",
  [CLOSE_CODES.UNAUTHENTICATED]: "unauthenticated",
  [CLOSE_CODES.REPLACED]: "replaced",
  [CLOSE_CODES.VERSION_UNSUPPORTED]: "version",
};
const SUPERSEDED_DELAY_MS = 60_000;

export class CloudLink {
  private ws: SocketLike | null = null;
  private gen = 0;
  private attempt = 0;
  private welcome: WelcomeFrame | null = null;
  private welcomedAt = 0;
  private lastRx = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private welcomeTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private unauthStreak = 0;
  private pending = new Map<string, Entry>();
  private queue: Entry[] = [];
  private running = 0;
  private mediaActive = 0;
  private stopping = false;
  private resolveDone!: (s: LinkState) => void;
  private readonly url: string;
  private readonly o: Required<Pick<CloudLinkOptions, "maxConcurrent" | "maxPending" | "welcomeTimeoutMs" | "connectTimeoutMs" | "unauthRetries" | "supersededDelayMs" | "stableMs" | "heartbeatTimeoutMs" | "maxBufferedEventBytes">> & CloudLinkOptions;
  /** Answers produced after their request was already answered (by the watchdog); for tests. */
  answeredLate = 0;
  state: LinkState = { status: "idle", since: Date.now() };
  readonly done: Promise<LinkState>;

  constructor(opts: CloudLinkOptions) {
    this.url = connectURL(opts.url);
    this.o = { maxConcurrent: 8, maxPending: MAX_INFLIGHT_REQUESTS, welcomeTimeoutMs: 10_000, connectTimeoutMs: 20_000, unauthRetries: 3, supersededDelayMs: SUPERSEDED_DELAY_MS, stableMs: 30_000, heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS, maxBufferedEventBytes: 4 * 1024 * 1024, ...opts };
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Internal counters, for tests and `status`: all four return to 0 when nothing is in flight. */
  stats(): { pending: number; queued: number; running: number; media: number } {
    return { pending: this.pending.size, queued: this.queue.length, running: this.running, media: this.mediaActive };
  }

  start(): void {
    if (this.state.status !== "idle") return;
    this.connect();
  }

  private setState(s: Omit<LinkState, "since">) {
    this.state = { ...s, since: Date.now() };
    this.o.onState?.(this.state);
    if (s.status === "stopped") this.resolveDone(this.state);
  }

  private log(msg: string, fields?: Record<string, string | number | boolean | null>) {
    this.o.log?.(msg, fields);
  }

  private connect() {
    if (this.stopping) return;
    const gen = ++this.gen;
    this.setState({ status: "connecting" });
    let ws: SocketLike;
    try {
      ws = (this.o.socketFactory ?? defaultFactory)(this.url, { authorization: `Bearer ${this.o.token}` });
    } catch {
      this.onClosed(gen, 1006);
      return;
    }
    this.ws = ws;
    this.welcome = null;
    // Covers the upgrade and the welcome: a request lost after sleep or a Wi-Fi change may never
    // produce onopen or onclose.
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (gen === this.gen && !this.welcome) {
        this.log("cloud: connect timed out");
        this.drop(gen, CLOSE_CODES.HEARTBEAT_TIMEOUT);
      }
    }, this.o.connectTimeoutMs);
    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.lastRx = Date.now();
      void this.sendHello(gen);
      this.welcomeTimer = setTimeout(() => {
        if (gen === this.gen && !this.welcome) {
          this.log("cloud: no welcome");
          this.drop(gen, 4408);
        }
      }, this.o.welcomeTimeoutMs);
    };
    ws.onmessage = (ev) => {
      if (gen !== this.gen) return;
      this.lastRx = Date.now();
      this.onFrame(ev.data);
    };
    ws.onclose = (ev) => this.onClosed(gen, ev?.code ?? 1006);
    ws.onerror = () => {
      // onclose follows
    };
  }

  private async sendHello(gen: number) {
    let info: { beeperVersion: string | null; networks: string[] } = { beeperVersion: null, networks: [] };
    try {
      info = await Promise.race([this.o.hello(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("hello timeout")), 5000))]);
    } catch {
      // Beeper down: still connect, the status events will say so
    }
    if (gen !== this.gen) return;
    const beeperVersion = typeof info?.beeperVersion === "string" && parse(versionString, info.beeperVersion).ok ? info.beeperVersion : null;
    const networks = (Array.isArray(info?.networks) ? info.networks : []).filter((n) => parse(networkName, n).ok).slice(0, 50);
    this.sendFrame({
      type: "hello",
      v: PROTOCOL_VERSION,
      deviceID: this.o.deviceID,
      connectorVersion: this.o.connectorVersion,
      beeperVersion,
      platform: this.o.platform ?? { os: process.platform.slice(0, 32) || "unknown", arch: process.arch.slice(0, 32) || "unknown" },
      networks,
      capabilities: Object.values(CAPABILITIES),
    });
  }

  private onFrame(data: unknown) {
    const input = typeof data === "string" ? data : data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? (data as ArrayBuffer) : String(data);
    const r = parseCloudFrame(input as string);
    if (!r.ok) return this.onBadFrame(input, r.error);
    const f = r.value;
    switch (f.type) {
      case "welcome":
        return this.onWelcome(f);
      case "ping":
        return void this.sendFrame({ type: "pong", t: f.t });
      case "pong":
        return;
      case "req":
        return this.onReq(f);
      case "cancel":
        return this.onCancel(f.id);
      case "ack":
        return this.pending.get(f.id)?.window?.ack(f.seq);
    }
  }

  /** Answer what can be addressed (a req with a valid id), drop the rest. */
  private onBadFrame(input: unknown, error: string) {
    if (error === "TOO_LARGE" || typeof input !== "string") return;
    let j: any;
    try {
      j = JSON.parse(input);
    } catch {
      return;
    }
    if (!j || typeof j !== "object" || j.type !== "req" || !parse(requestId, j.id).ok || this.pending.has(j.id)) return;
    // The cloud's own actions (the snooze store) are never the connector's to run.
    const known = isActionName(j.action) && !isCloudAction(j.action);
    this.sendRes(j.id, { kind: "res", ok: false, error: makeError(known ? "BAD_PARAMS" : "NOT_ALLOWED", known ? "Invalid request." : "This action is not allowed.") });
    this.o.onRequest?.({ action: known ? j.action : "unknown", ok: false, code: known ? "BAD_PARAMS" : "NOT_ALLOWED", ms: 0 });
  }

  private onWelcome(f: WelcomeFrame) {
    if (this.welcome) return;
    this.welcome = f;
    this.welcomedAt = Date.now();
    this.unauthStreak = 0;
    clearTimeout(this.welcomeTimer);
    clearTimeout(this.connectTimer);
    this.setState({ status: "connected" });
    this.log("cloud: connected");
    const gen = this.gen;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (gen !== this.gen) return;
      if (Date.now() - this.lastRx > this.o.heartbeatTimeoutMs) {
        this.log("cloud: heartbeat timeout");
        return this.drop(gen, CLOSE_CODES.HEARTBEAT_TIMEOUT);
      }
      this.sendFrame({ type: "ping", t: Date.now() });
    }, Math.min(f.heartbeatMs, Math.max(50, Math.floor(this.o.heartbeatTimeoutMs / 2))));
    try {
      this.o.onWelcome?.();
    } catch {
      // reconcile errors must not break the link
    }
  }

  /** Close this socket and handle it as closed right away (a dead TCP peer may never send a close). */
  private drop(gen: number, code: number) {
    const ws = this.ws;
    try {
      if (ws?.terminate) ws.terminate();
      else ws?.close(code);
    } catch {}
    this.onClosed(gen, code);
  }

  private onClosed(gen: number, code: number) {
    if (gen !== this.gen) return;
    this.gen++; // late events from this socket are ignored from now on
    this.ws = null;
    clearTimeout(this.welcomeTimer);
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeatTimer);
    const lived = this.welcome ? Date.now() - this.welcomedAt : 0;
    const wasWelcomed = !!this.welcome;
    this.welcome = null;
    this.abandonAll();
    if (this.stopping) return;
    // A 4401 can come from a cloud that closed a slow hello with it (older clouds) or a passing
    // fault: only the same answer several times in a row means the credential is really rejected.
    if (code === CLOSE_CODES.UNAUTHENTICATED && ++this.unauthStreak <= this.o.unauthRetries) {
      const delay = (this.o.backoff ?? backoffDelay)(this.attempt++);
      this.setState({ status: "disconnected", closeCode: code });
      this.log("cloud: credential refused, checking again", { code, retryMs: delay, attempt: this.unauthStreak });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      return;
    }
    const stopReason = STOP_REASONS[code];
    if (!shouldReconnect(code) || stopReason) {
      this.log("cloud: closed for good", { code });
      this.setState({ status: "stopped", closeCode: code, reason: stopReason ?? "unauthenticated" });
      return;
    }
    if (wasWelcomed && lived >= this.o.stableMs) this.attempt = 0;
    // Another socket of this device (a second process) took over: do not fight it every second.
    const delay = code === CLOSE_CODES.SUPERSEDED ? Math.max(this.o.supersededDelayMs, (this.o.backoff ?? backoffDelay)(this.attempt++)) : (this.o.backoff ?? backoffDelay)(this.attempt++);
    if (code === CLOSE_CODES.SUPERSEDED) this.log("cloud: another connection of this computer took over; retrying later", { retryMs: delay });
    this.setState({ status: "disconnected", closeCode: code });
    this.log("cloud: disconnected", { code, retryMs: delay });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** The socket is gone: nobody can receive these answers. Reads stop now; writes run to their deadline (aborting a POST mid-flight helps no one) and their results are dropped. */
  private abandonAll() {
    for (const e of this.pending.values()) {
      e.answered = true;
      clearTimeout(e.timer);
      e.window?.close();
      if (!this.o.dispatcher.isWrite(e.action) || !e.started) e.ctl.abort();
      if (e.settled || !e.started) this.finish(e);
    }
    this.queue = [];
  }

  private onCancel(id: string) {
    const e = this.pending.get(id);
    if (!e) return;
    e.answered = true;
    clearTimeout(e.timer);
    e.ctl.abort();
    e.window?.close();
    if (!e.started) {
      this.queue = this.queue.filter((q) => q !== e);
      this.finish(e);
    }
  }

  private onReq(f: ReqFrame) {
    if (this.pending.has(f.id)) return;
    if (this.stopping) return this.sendRes(f.id, { kind: "res", ok: false, error: makeError("OFFLINE", "The connector is shutting down. Try again shortly.") });
    const media = ACTIONS[f.action].streamed;
    if (this.pending.size >= this.o.maxPending) return this.refuse(f, "Too many requests in flight on this computer.");
    if (media && this.mediaActive >= MAX_CONCURRENT_MEDIA_STREAMS) return this.refuse(f, "Too many media downloads at once.");
    const e: Entry = { id: f.id, action: f.action, gen: this.gen, ctl: new AbortController(), answered: false, started: false, settled: false, media, t0: Date.now(), caller: f.caller };
    this.pending.set(f.id, e);
    if (media) this.mediaActive++;
    const timeoutMs = media ? MEDIA_TIMEOUT_MS : (this.welcome?.requestTimeoutMs ?? 15_000);
    const margin = this.o.marginMs ?? Math.min(1000, Math.floor(timeoutMs / 10));
    const ctx = requestContext({ timeoutMs, marginMs: margin, cancel: e.ctl.signal });
    // Watchdog: answer before the cloud gives up, whatever the action is doing.
    e.timer = setTimeout(() => {
      if (e.answered) return;
      const code: ErrorCode = e.started && this.o.dispatcher.isWrite(e.action) ? "UNKNOWN_OUTCOME" : "TIMEOUT";
      this.answer(e, { kind: "res", ok: false, error: makeError(code, code === "TIMEOUT" ? "The request ran out of time on this computer." : "The change was sent to Beeper but did not finish in time. Check before trying again.") });
      e.ctl.abort();
      if (!e.started) this.finish(e);
    }, Math.max(1, timeoutMs - Math.floor(margin / 2)));
    e.args = { p: f.params, ctx, minStartMs: Math.min(250, Math.floor(timeoutMs / 10)) };
    this.queue.push(e);
    this.pump();
  }

  private refuse(f: ReqFrame, message: string) {
    this.sendRes(f.id, { kind: "res", ok: false, error: makeError("RATE_LIMITED", message) });
    this.o.onRequest?.({ action: f.action, ok: false, code: "RATE_LIMITED", ms: 0, ...(f.caller ? { caller: f.caller } : {}) });
  }

  private pump() {
    while (this.running < this.o.maxConcurrent && this.queue.length) {
      const e = this.queue.shift()!;
      const args = e.args;
      e.args = undefined;
      if (e.answered || !args) {
        this.finish(e);
        continue;
      }
      if (args.ctx.signal.aborted || args.ctx.deadline - Date.now() < args.minStartMs) {
        // Its deadline passed (or nearly) while it waited in the queue: never dispatch it.
        this.answer(e, { kind: "res", ok: false, error: makeError("TIMEOUT", "The request waited too long on this computer.") });
        this.finish(e);
        continue;
      }
      this.running++;
      e.started = true;
      void this.run(e, args.p, args.ctx).finally(() => {
        this.running--;
        this.finish(e);
        this.pump();
      });
    }
  }

  private finish(e: Entry) {
    e.settled = true;
    clearTimeout(e.timer);
    if (this.pending.get(e.id) === e) {
      this.pending.delete(e.id);
      if (e.media) this.mediaActive--;
    }
  }

  private async run(e: Entry, params: unknown, ctx: ReturnType<typeof requestContext>) {
    let r: DispatchResult;
    try {
      r = await this.o.dispatcher.dispatch(e.action, params, ctx);
    } catch {
      r = { kind: "res", ok: false, error: makeError("INTERNAL", "The connector failed while handling this request.") };
    }
    if (r.kind !== "media") {
      if (e.answered) this.answeredLate++;
      else this.answer(e, r);
      return;
    }
    if (e.answered) {
      r.cancel();
      return;
    }
    clearTimeout(e.timer);
    e.window = new ChunkWindow();
    if (!this.answer(e, { kind: "res", ok: true, data: r.head })) {
      r.cancel();
      return;
    }
    const limit = setTimeout(() => e.ctl.abort(), (this.o.mediaDeadlineMs ?? mediaDeadlineMs)(r.head.size));
    try {
      const out = await pumpChunks({
        id: e.id,
        body: r.body,
        size: r.head.size,
        window: e.window,
        signal: e.ctl.signal,
        send: (frame) => e.gen === this.gen && this.sendFrame(frame),
      });
      if (!out.ok) r.cancel();
    } finally {
      clearTimeout(limit);
    }
  }

  /** Send the answer for an entry once, on the socket it arrived on. */
  private answer(e: Entry, r: Extract<DispatchResult, { kind: "res" }>): boolean {
    if (e.answered) return false;
    e.answered = true;
    this.o.onRequest?.({ action: e.action, ok: r.ok, ...(r.ok ? {} : { code: r.error.code }), ms: Date.now() - e.t0, ...(e.caller ? { caller: e.caller } : {}) });
    if (e.gen !== this.gen) return false;
    return this.sendRes(e.id, r);
  }

  private sendRes(id: string, r: Extract<DispatchResult, { kind: "res" }>): boolean {
    const frame: ConnectorFrame = r.ok ? { type: "res", id, ok: true, data: r.data as any } : { type: "res", id, ok: false, error: r.error };
    const enc = encodeFrame(frame);
    if (enc.ok) return this.sendText(enc.value);
    const error: ErrorBody = enc.error === "TOO_LARGE" ? makeError("TOO_LARGE", "The answer is too large to send.") : makeError("INTERNAL", "The connector produced an invalid answer.");
    const fallback = encodeFrame({ type: "res", id, ok: false, error });
    return fallback.ok && this.sendText(fallback.value);
  }

  private sendFrame(frame: ConnectorFrame): boolean {
    const enc = encodeFrame(frame);
    if (!enc.ok) return false;
    return this.sendText(enc.value);
  }

  private sendText(text: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Metadata-only event to the cloud. Dropped (false) unless connected; Beeper events are
   * at-most-once anyway. Under backpressure chat/message events are dropped, never a (rare, small)
   * Beeper status event: the owner's "Beeper is not running" banner depends on it.
   */
  sendEvent(f: EventFrame): boolean {
    if (this.state.status !== "connected" || !this.ws) return false;
    if (f.kind !== "status" && (this.ws.bufferedAmount ?? 0) > this.o.maxBufferedEventBytes) return false;
    return this.sendFrame(f);
  }

  /** Stop taking requests, let running ones finish for up to graceMs, then close with 1001. */
  async stop(graceMs = 5000): Promise<void> {
    if (this.state.status === "stopped") return; // already closed for good (revoked, replaced, ...)
    if (this.stopping) return void (await this.done.catch(() => {}));
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    for (const e of this.queue) {
      if (!e.answered) this.answer(e, { kind: "res", ok: false, error: makeError("OFFLINE", "The connector is shutting down. Try again shortly.") });
    }
    for (const e of [...this.queue]) this.finish(e);
    this.queue = [];
    const t0 = Date.now();
    while ([...this.pending.values()].some((e) => e.started && !e.settled && !e.media) && Date.now() - t0 < graceMs) await Bun.sleep(10);
    for (const e of this.pending.values()) {
      e.ctl.abort();
      e.window?.close();
    }
    const ws = this.ws;
    this.gen++;
    try {
      ws?.close(SHUTDOWN_CODE, "connector shutting down");
    } catch {}
    this.ws = null;
    clearTimeout(this.welcomeTimer);
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeatTimer);
    const t1 = Date.now();
    while (this.pending.size && Date.now() - t1 < 500) await Bun.sleep(5);
    for (const e of [...this.pending.values()]) this.finish(e);
    this.setState({ status: "stopped", reason: "shutdown" });
  }
}
