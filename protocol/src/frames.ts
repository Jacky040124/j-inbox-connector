// Connector <-> cloud WebSocket frames (wss://<app>/connect).
// The connector authenticates the upgrade request with `Authorization: Bearer <deviceToken>`
// and sends `hello` first; the cloud answers `welcome` (or closes with a CLOSE_CODES value).
import {
  array,
  base64,
  boolean,
  discriminated,
  enumOf,
  formatIssues,
  integer,
  isoDateTime,
  jsonObject,
  jsonValue,
  literal,
  nullable,
  object,
  optional,
  parse,
  refine,
  string,
  type Infer,
  type Issue,
  type Result,
} from "./schema.ts";
import { CONNECTOR_ACTION_NAMES } from "./actions.ts";
import { errorBody, type ErrorCode } from "./errors.ts";
import { beeperHealth, chatID, messageID, networkName, ownId, versionString } from "./model.ts";
import {
  MAX_CHUNKS,
  MAX_CHUNK_BASE64_LENGTH,
  MAX_CHUNK_BYTES,
  MAX_EVENT_IDS,
  MAX_FRAME_BYTES,
  MAX_MEDIA_BYTES,
  MAX_REQUEST_ID_LENGTH,
  MEDIA_MAX_TOTAL_MS,
  MEDIA_MIN_BYTES_PER_SECOND,
  MEDIA_TIMEOUT_MS,
  MEDIA_WINDOW_CHUNKS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
} from "./limits.ts";

export const requestId = string({ min: 1, max: MAX_REQUEST_ID_LENGTH, pattern: /^[A-Za-z0-9_-]+$/, format: "request-id" });
const epochMs = integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
const JSON_LIMITS = { maxDepth: 32, maxKeys: 50_000 };

// ---- connector -> cloud ----

/**
 * Values for hello.capabilities. "media.v1": get_media streams chunks under ack flow control
 * (ChunkWindow). "gmail.v1": the connector runs Gmail accounts (gmail_connect, compose_email, Gmail chats).
 * "drafts.v1": the connector keeps draft requests' texts (draft_store_put / _get / _set_text / _delete).
 * "delegations.v1": its request store also takes delegation requests (dlg_ ids) in draft_store_put / _get / _delete.
 * "attachments.v1": it keeps uploads (upload_store_*, discard_upload), sends them (send_message /
 * compose_email attachmentId) and keeps one with a draft (draft_store_set_text attachmentId).
 */
export const CAPABILITIES = { media: "media.v1", gmail: "gmail.v1", drafts: "drafts.v1", delegations: "delegations.v1", attachments: "attachments.v1" } as const;

export const helloFrame = object({
  type: literal("hello"),
  /** Protocol version the connector speaks. The cloud closes with VERSION_UNSUPPORTED if it cannot serve it. */
  v: integer({ min: 1, max: 1000 }),
  deviceID: ownId,
  connectorVersion: versionString,
  beeperVersion: nullable(versionString),
  platform: object({ os: string({ min: 1, max: 32 }), arch: string({ min: 1, max: 32 }) }),
  /** Connected network display names, e.g. ["WhatsApp","iMessage"]. */
  networks: array(networkName, { max: 50 }),
  /** Optional feature flags for additive evolution, e.g. "media.v1". */
  capabilities: optional(array(string({ min: 1, max: 64, pattern: /^[a-z0-9._-]+$/ }), { max: 32 })),
});

export const resFrame = refine(
  object({
    type: literal("res"),
    id: requestId,
    ok: boolean(),
    data: optional(jsonValue(JSON_LIMITS)),
    error: optional(errorBody),
  }),
  (f) => {
    if (f.ok && (f.data === undefined || f.error !== undefined)) return "ok res must carry data and no error";
    if (!f.ok && (f.error === undefined || f.data !== undefined)) return "failed res must carry error and no data";
    return null;
  },
);

export const chunkFrame = refine(
  object({
    type: literal("chunk"),
    id: requestId,
    seq: integer({ min: 0, max: MAX_CHUNKS }),
    data: base64({ max: MAX_CHUNK_BASE64_LENGTH }),
    last: boolean(),
    /** Only on the last chunk: the stream failed part way. */
    error: optional(errorBody),
  }),
  (f) => (f.error && !f.last ? "error is only allowed on the last chunk" : null),
);

const eventTs = isoDateTime();
export const messageEvent = object({
  type: literal("event"),
  kind: literal("message"),
  op: enumOf(["upserted", "deleted"] as const),
  chatID,
  messageIDs: array(messageID, { min: 1, max: MAX_EVENT_IDS }),
  ts: eventTs,
  /**
   * Optional (added 2026-10-28, for snooze's early return): who sent the upserted messages, as far
   * as the connector knows. A time: the newest timestamp among them sent by someone else (not the
   * owner). null: none was (the owner's own sends, their status updates). Absent: not known (an
   * older connector, Beeper sent no message entries, deletions). Metadata only, never a sender.
   */
  othersAt: optional(nullable(isoDateTime())),
});
export const chatEvent = object({
  type: literal("event"),
  kind: literal("chat"),
  op: enumOf(["upserted", "deleted"] as const),
  chatID,
  ts: eventTs,
  unreadCount: optional(integer({ min: 0, max: 1_000_000_000 })),
});
export const statusEvent = object({
  type: literal("event"),
  kind: literal("status"),
  ts: eventTs,
  beeper: beeperHealth,
});
/** Metadata only. Message text never rides on events: clients refetch with read_chat. */
export const eventFrame = discriminated("kind", { message: messageEvent, chat: chatEvent, status: statusEvent });

export const pingFrame = object({ type: literal("ping"), t: epochMs });
export const pongFrame = object({ type: literal("pong"), t: epochMs });

export const connectorFrame = discriminated("type", {
  hello: helloFrame,
  ping: pingFrame,
  pong: pongFrame,
  res: resFrame,
  chunk: chunkFrame,
  event: eventFrame,
});

// ---- cloud -> connector ----

export const welcomeFrame = object({
  type: literal("welcome"),
  v: integer({ min: 1, max: 1000 }),
  serverTime: isoDateTime(),
  heartbeatMs: integer({ min: 1000, max: 600_000 }),
  requestTimeoutMs: integer({ min: 1000, max: 600_000 }),
  maxFrameBytes: integer({ min: 1024, max: MAX_FRAME_BYTES }),
});

/**
 * params is any bounded JSON object here; the connector validates it with parseActionParams and
 * answers BAD_PARAMS. The cloud's own actions (CLOUD_ACTION_NAMES, the snooze store) never ride here.
 */
export const reqFrame = object({
  type: literal("req"),
  id: requestId,
  action: enumOf(CONNECTOR_ACTION_NAMES),
  params: jsonObject(JSON_LIMITS),
  /**
   * Optional (added 2026-10-26): who asked, for the connector's local audit log only. The name is
   * the Raft display name (sanitizeLine'd by the cloud), never a chat or message value.
   */
  caller: optional(object({ type: enumOf(["human", "agent"] as const), name: optional(string({ min: 1, max: 200 })) })),
});

/** The cloud no longer needs the answer (caller gone or timed out). */
export const cancelFrame = object({ type: literal("cancel"), id: requestId });

/** Flow control for get_media: the cloud has written chunk `seq` onward; the connector may send up to seq + MEDIA_WINDOW_CHUNKS. */
export const ackFrame = object({ type: literal("ack"), id: requestId, seq: integer({ min: 0, max: MAX_CHUNKS }) });

export const cloudFrame = discriminated("type", {
  welcome: welcomeFrame,
  req: reqFrame,
  cancel: cancelFrame,
  ack: ackFrame,
  ping: pingFrame,
  pong: pongFrame,
});

export type HelloFrame = Infer<typeof helloFrame>;
export type ResFrame = Infer<typeof resFrame>;
export type ChunkFrame = Infer<typeof chunkFrame>;
export type EventFrame = Infer<typeof eventFrame>;
export type MessageEvent = Infer<typeof messageEvent>;
export type ChatEvent = Infer<typeof chatEvent>;
export type StatusEvent = Infer<typeof statusEvent>;
export type PingFrame = Infer<typeof pingFrame>;
export type PongFrame = Infer<typeof pongFrame>;
export type ConnectorFrame = Infer<typeof connectorFrame>;
export type WelcomeFrame = Infer<typeof welcomeFrame>;
export type ReqFrame = Infer<typeof reqFrame>;
export type CancelFrame = Infer<typeof cancelFrame>;
export type AckFrame = Infer<typeof ackFrame>;
export type CloudFrame = Infer<typeof cloudFrame>;
export type AnyFrame = ConnectorFrame | CloudFrame;

export type FrameError = "TOO_LARGE" | "BAD_JSON" | "BAD_FRAME";
export type FrameResult<T> = { ok: true; value: T } | { ok: false; error: FrameError; message: string; issues?: Issue[] };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function byteLength(s: string): number {
  return encoder.encode(s).byteLength;
}

/** True when the UTF-8 form of `s` is at most `max` bytes, without encoding short strings. */
function fitsBytes(s: string, max: number): boolean {
  if (s.length > max) return false;
  if (s.length * 3 <= max) return true;
  return byteLength(s) <= max;
}

function decodeInput(data: string | ArrayBuffer | ArrayBufferView): FrameResult<string> {
  if (typeof data === "string") return fitsBytes(data, MAX_FRAME_BYTES) ? { ok: true, value: data } : { ok: false, error: "TOO_LARGE", message: "frame too large" };
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength > MAX_FRAME_BYTES) return { ok: false, error: "TOO_LARGE", message: "frame too large" };
  try {
    return { ok: true, value: decoder.decode(bytes) };
  } catch {
    return { ok: false, error: "BAD_FRAME", message: "frame is not valid UTF-8" };
  }
}

function parseWith<T>(schema: Parameters<typeof parse<T>>[0], data: string | ArrayBuffer | ArrayBufferView): FrameResult<T> {
  const text = decodeInput(data);
  if (!text.ok) return text;
  let json: unknown;
  try {
    json = JSON.parse(text.value);
  } catch {
    return { ok: false, error: "BAD_JSON", message: "frame is not JSON" };
  }
  const r: Result<T> = parse(schema, json);
  if (!r.ok) return { ok: false, error: "BAD_FRAME", message: formatIssues(r.issues), issues: r.issues };
  return { ok: true, value: r.value };
}

/** Parse a frame received by the cloud from a connector. */
export function parseConnectorFrame(data: string | ArrayBuffer | ArrayBufferView): FrameResult<ConnectorFrame> {
  return parseWith(connectorFrame, data);
}

/** Parse a frame received by the connector from the cloud. */
export function parseCloudFrame(data: string | ArrayBuffer | ArrayBufferView): FrameResult<CloudFrame> {
  return parseWith(cloudFrame, data);
}

/** Validate and serialize a frame. Refuses invalid or oversized frames instead of sending them. */
export function encodeFrame(frame: AnyFrame): FrameResult<string> {
  const r = parse(connectorFrame, frame);
  if (!r.ok && !parse(cloudFrame, frame).ok) return { ok: false, error: "BAD_FRAME", message: formatIssues(r.issues), issues: r.issues };
  let text: string;
  try {
    text = JSON.stringify(frame);
  } catch {
    return { ok: false, error: "BAD_FRAME", message: "frame is not serializable" };
  }
  if (!fitsBytes(text, MAX_FRAME_BYTES)) return { ok: false, error: "TOO_LARGE", message: "frame too large" };
  return { ok: true, value: text };
}

// ---- media chunks ----

export function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  return btoa(bin);
}

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Split a whole file into chunk frames (seq 0..n, last on the final one). */
export function makeChunkFrames(id: string, bytes: Uint8Array): ChunkFrame[] {
  if (bytes.length === 0) return [{ type: "chunk", id, seq: 0, data: "", last: true }];
  const frames: ChunkFrame[] = [];
  for (let off = 0, seq = 0; off < bytes.length; off += MAX_CHUNK_BYTES, seq++) {
    const end = Math.min(off + MAX_CHUNK_BYTES, bytes.length);
    frames.push({ type: "chunk", id, seq, data: encodeBase64(bytes.subarray(off, end)), last: end === bytes.length });
  }
  return frames;
}

/**
 * Receives chunk frames for one get_media request. Checks order, size against the declared size
 * (or a running MAX_MEDIA_BYTES cap when the size is unknown). Pass onBytes to stream instead of
 * buffering; the cloud uses accept(), which waits for onBytes before returning the `ack` to send.
 */
export class ChunkAssembler {
  private next = 0;
  private received = 0;
  private parts: Uint8Array[] = [];
  done = false;
  error: ErrorCode | undefined;

  constructor(private readonly opts: { expectedSize: number | null; onBytes?: (bytes: Uint8Array) => unknown }) {
    const size = opts.expectedSize;
    if (size !== null && (!(size >= 0) || size > MAX_MEDIA_BYTES)) this.error = "TOO_LARGE";
  }

  /** Synchronous: does not wait for onBytes. Fine for buffered mode and tests. */
  push(frame: ChunkFrame): { error?: ErrorCode } {
    const r = this.take(frame);
    if (r.error) return r;
    if (this.opts.onBytes) void this.opts.onBytes(r.bytes!);
    else this.parts.push(r.bytes!);
    return this.finish(frame);
  }

  /** Validates, waits until onBytes has consumed the bytes, then returns the ack frame to send. */
  async accept(frame: ChunkFrame): Promise<{ error?: ErrorCode; ack?: AckFrame }> {
    const r = this.take(frame);
    if (r.error) return { error: r.error };
    try {
      if (this.opts.onBytes) await this.opts.onBytes(r.bytes!);
      else this.parts.push(r.bytes!);
    } catch {
      return this.fail("INTERNAL");
    }
    const f = this.finish(frame);
    return f.error ? f : { ack: { type: "ack", id: frame.id, seq: frame.seq } };
  }

  bytes(): Uint8Array {
    if (this.opts.onBytes) throw new Error("streaming assembler does not buffer");
    if (!this.done) throw new Error("stream not complete");
    const out = new Uint8Array(this.received);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    this.parts = [out];
    return out;
  }

  private take(frame: ChunkFrame): { error?: ErrorCode; bytes?: Uint8Array } {
    if (this.error) return { error: this.error };
    if (this.done || frame.seq !== this.next) return this.fail("BAD_PARAMS");
    if (frame.error) return this.fail(frame.error.code);
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(frame.data);
    } catch {
      return this.fail("BAD_PARAMS");
    }
    if (bytes.length > MAX_CHUNK_BYTES) return this.fail("TOO_LARGE");
    this.received += bytes.length;
    if (this.received > (this.opts.expectedSize ?? MAX_MEDIA_BYTES)) return this.fail("TOO_LARGE");
    this.next++;
    return { bytes };
  }

  private finish(frame: ChunkFrame): { error?: ErrorCode } {
    if (this.error) return { error: this.error };
    if (frame.last) {
      if (this.opts.expectedSize !== null && this.received !== this.opts.expectedSize) return this.fail("INTERNAL");
      this.done = true;
    }
    return {};
  }

  private fail(code: ErrorCode) {
    this.error = code;
    this.parts = [];
    return { error: code };
  }
}

/**
 * Connector side of get_media flow control: chunk `seq` may be sent only while
 * seq <= lastAck + window. Await waitFor(seq) before sending each chunk.
 */
export class ChunkWindow {
  private lastAck = -1;
  private closed = false;
  private waiters: { seq: number; resolve: () => void; reject: (e: Error) => void; detach: () => void }[] = [];

  constructor(private readonly window: number = MEDIA_WINDOW_CHUNKS) {}

  canSend(seq: number): boolean {
    return !this.closed && seq <= this.lastAck + this.window;
  }

  ack(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq <= this.lastAck || seq > MAX_CHUNKS) return;
    this.lastAck = seq;
    const ready = this.waiters.filter((w) => this.canSend(w.seq));
    this.waiters = this.waiters.filter((w) => !this.canSend(w.seq));
    for (const w of ready) {
      w.detach();
      w.resolve();
    }
  }

  /** Each wait removes its abort listener when it settles, so a long-lived signal does not collect them. */
  waitFor(seq: number, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("media stream closed"));
    if (signal?.aborted) return Promise.reject(new Error("media stream aborted"));
    if (this.canSend(seq)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error("media stream aborted"));
      };
      const w = { seq, resolve, reject, detach: () => signal?.removeEventListener("abort", onAbort) };
      this.waiters.push(w);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Cancel or socket loss: every pending waitFor rejects. */
  close(): void {
    this.closed = true;
    for (const w of this.waiters) {
      w.detach();
      w.reject(new Error("media stream closed"));
    }
    this.waiters = [];
  }
}

/** Total deadline for one get_media stream: head time plus transfer at MEDIA_MIN_BYTES_PER_SECOND, capped. Unknown size gets the cap. */
export function mediaDeadlineMs(size: number | null): number {
  if (size === null) return MEDIA_MAX_TOTAL_MS;
  const bytes = Number.isFinite(size) && size > 0 ? size : 0;
  return Math.min(MEDIA_MAX_TOTAL_MS, MEDIA_TIMEOUT_MS + Math.ceil((bytes / MEDIA_MIN_BYTES_PER_SECOND) * 1000));
}

// ---- connection lifecycle ----

export const CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  BAD_FRAME: 4400,
  UNAUTHENTICATED: 4401,
  REVOKED: 4403,
  HEARTBEAT_TIMEOUT: 4408,
  /** No hello in time (sleep, slow network): a timeout like a missed heartbeat, so reconnect. Never sent for a rejected token. */
  HELLO_TIMEOUT: 4408,
  /** Another computer was paired to this inbox; this one should stop. */
  REPLACED: 4409,
  /** The same device connected again (a newer socket, or a second process); this socket closes. Reconnect, after a long backoff. */
  SUPERSEDED: 4410,
  TOO_LARGE: 4413,
  VERSION_UNSUPPORTED: 4426,
} as const;

const NO_RECONNECT = new Set<number>([CLOSE_CODES.UNAUTHENTICATED, CLOSE_CODES.REVOKED, CLOSE_CODES.VERSION_UNSUPPORTED, CLOSE_CODES.REPLACED]);

export function shouldReconnect(closeCode: number): boolean {
  return !NO_RECONNECT.has(closeCode);
}

/** Exponential backoff 1s, 2s, 4s ... capped at 60s, with +/-20% jitter. `attempt` starts at 0. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.min(Math.floor(attempt), 30) : 0;
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** n);
  const jittered = base * (0.8 + 0.4 * random());
  return Math.round(Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS, jittered)));
}
