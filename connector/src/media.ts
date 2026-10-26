// get_media: only asset URLs this connector returned (AssetAllowlist), streamed from Beeper's
// /v1/assets/serve in MAX_CHUNK_BYTES chunk frames under ChunkWindow flow control, capped at
// MAX_MEDIA_BYTES (or the declared size). A failure part way ends with an error on the last chunk.
import {
  MAX_CHUNK_BYTES,
  MAX_MEDIA_BYTES,
  MEDIA_IDLE_TIMEOUT_MS,
  MEDIA_TIMEOUT_MS,
  MIME_RE,
  encodeBase64,
  makeError,
  type ChunkFrame,
  type ChunkWindow,
  type ErrorBody,
  type ErrorCode,
  type MediaHead,
} from "@j-inbox/protocol";
import type { BeeperClient } from "./beeper-client.ts";
import type { AssetAllowlist } from "./assets.ts";

export type MediaOpen = { ok: true; head: MediaHead; body: ReadableStream<Uint8Array>; cancel(): void } | { ok: false; error: ErrorBody };

function mimeOf(header: string | null): string {
  const base = (header ?? "").split(";")[0]!.trim().toLowerCase();
  return base.length >= 3 && base.length <= 255 && MIME_RE.test(base) ? base : "application/octet-stream";
}

export async function openMedia(client: BeeperClient, assets: AssetAllowlist, url: string, signal?: AbortSignal): Promise<MediaOpen> {
  if (!assets.has(url)) return { ok: false, error: makeError("NOT_ALLOWED", "This media URL was not returned by this connector. Reload the chat and use a URL from its result.") };
  const r = await client.stream(`/v1/assets/serve?${new URLSearchParams({ url })}`, { signal, headTimeoutMs: MEDIA_TIMEOUT_MS });
  if (!r.ok) return r;
  const body = r.res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  const cancel = () => void body.cancel().catch(() => {});
  const lenHeader = r.res.headers.get("content-length");
  const len = lenHeader !== null && /^\d{1,16}$/.test(lenHeader) ? Number(lenHeader) : null;
  if (len !== null && len > MAX_MEDIA_BYTES) {
    cancel();
    return { ok: false, error: makeError("TOO_LARGE", "This file is larger than J-Inbox relays (25 MiB).") };
  }
  return { ok: true, head: { mimeType: mimeOf(r.res.headers.get("content-type")), size: len }, body, cancel };
}

export type PumpOptions = {
  id: string;
  body: ReadableStream<Uint8Array>;
  /** Declared size (the head's), or null when unknown. */
  size: number | null;
  window: ChunkWindow;
  /** Returns false when the frame could not be sent (socket gone). */
  send: (f: ChunkFrame) => boolean | void;
  signal?: AbortSignal;
  idleMs?: number;
  maxBytes?: number;
};

class StreamFailure extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
class Stopped extends Error {}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  TOO_LARGE: "The file is larger than allowed.",
  TIMEOUT: "Beeper stopped sending the file.",
  BEEPER_DOWN: "Beeper failed while sending the file.",
  INTERNAL: "The file ended early.",
};

/** Sends the body as chunk frames. Resolves ok:false on any failure (after an error chunk when the socket still works). */
export async function pumpChunks(o: PumpOptions): Promise<{ ok: boolean; error?: ErrorCode; sent: number }> {
  const cap = Math.min(o.maxBytes ?? MAX_MEDIA_BYTES, o.size ?? Number.MAX_SAFE_INTEGER);
  const idleMs = o.idleMs ?? MEDIA_IDLE_TIMEOUT_MS;
  const reader = o.body.getReader();
  let seq = 0;
  let sent = 0;
  let total = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    void reader.cancel().catch(() => {});
  };
  o.signal?.addEventListener("abort", stop, { once: true });

  const emit = async (bytes: Uint8Array, last: boolean, error?: ErrorBody) => {
    try {
      await o.window.waitFor(seq, o.signal);
    } catch {
      throw new Stopped();
    }
    if (stopped) throw new Stopped();
    const frame: ChunkFrame = { type: "chunk", id: o.id, seq, data: bytes.length ? encodeBase64(bytes) : "", last, ...(error ? { error } : {}) };
    if (o.send(frame) === false) throw new Stopped();
    seq++;
    sent++;
  };

  const read = async (): Promise<Awaited<ReturnType<typeof reader.read>>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StreamFailure("TIMEOUT")), idleMs);
        }),
      ]);
    } catch (e) {
      if (stopped) throw new Stopped();
      throw e instanceof StreamFailure ? e : new StreamFailure("BEEPER_DOWN");
    } finally {
      clearTimeout(timer);
    }
  };

  let held: Uint8Array | null = null;
  let buf = new Uint8Array(0);
  try {
    if (o.signal?.aborted) throw new Stopped();
    for (;;) {
      const { value, done } = await read();
      if (stopped) throw new Stopped();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > cap) throw new StreamFailure("TOO_LARGE");
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
      while (buf.length >= MAX_CHUNK_BYTES) {
        const piece = buf.slice(0, MAX_CHUNK_BYTES);
        buf = buf.slice(MAX_CHUNK_BYTES);
        if (held) await emit(held, false);
        held = piece;
      }
    }
    if (o.size !== null && total !== o.size) throw new StreamFailure("INTERNAL");
    if (buf.length) {
      if (held) await emit(held, false);
      held = buf;
    }
    await emit(held ?? new Uint8Array(0), true);
    return { ok: true, sent };
  } catch (e) {
    void reader.cancel().catch(() => {});
    if (e instanceof StreamFailure) {
      try {
        await emit(new Uint8Array(0), true, makeError(e.code, MESSAGES[e.code] ?? "Media stream failed."));
      } catch {
        // socket or window gone: nothing more to tell
      }
      return { ok: false, error: e.code, sent };
    }
    return { ok: false, sent };
  } finally {
    o.signal?.removeEventListener("abort", stop);
  }
}
