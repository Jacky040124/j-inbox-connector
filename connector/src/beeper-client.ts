// Minimal HTTP client for the local Beeper Client API. Encodes every id path segment, never
// follows redirects (the bearer token must not travel), bounds time and body size, and maps
// failures to protocol error codes without echoing anything Beeper said.
import { makeError, type ErrorBody, type ErrorCode } from "@j-inbox/protocol";

export type BeeperClientOptions = { baseURL: string; token: string; timeoutMs?: number; maxBodyBytes?: number; fetchImpl?: typeof fetch };
export type BeeperCall = { ok: true; status: number; body: any } | { ok: false; error: ErrorBody };
/** The request's cancel/deadline signal. Already aborted: the call is not made (TIMEOUT). */
export type CallOptions = { signal?: AbortSignal };
export type BeeperClient = {
  /** `/v1/chats/{chatID}[/rest...]` with every segment encodeURIComponent'ed. */
  chatPath(chatID: string, ...rest: string[]): string;
  get(pathAndQuery: string, o?: CallOptions): Promise<BeeperCall>;
  /** A state-changing call: lost answers become UNKNOWN_OUTCOME, never a retryable code. */
  write(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, o?: CallOptions): Promise<BeeperCall>;
  /**
   * A GET whose body the caller streams (get_media). The client's timeout covers only the wait
   * for the response head; after that the caller's signal governs. Non-2xx answers are failures.
   */
  stream(pathAndQuery: string, o?: CallOptions & { headTimeoutMs?: number }): Promise<BeeperStream>;
};
export type BeeperStream = { ok: true; status: number; res: Response } | { ok: false; error: ErrorBody };

/** `network: "not_sent"`: the request's deadline passed (or it was cancelled) before the call was made. */
type Failure = { status?: number; network?: "refused" | "timeout" | "other" | "not_sent"; write: boolean };

/**
 * Protocol code for a failed Beeper call. For writes, only answers that prove Beeper did nothing
 * (connection refused, 4xx) are anything but UNKNOWN_OUTCOME: a 5xx (502 "upstream dependency
 * returned an invalid response") may come after the message already went out.
 */
export function beeperErrorCode(f: Failure): ErrorCode {
  if (f.network === "not_sent") return "TIMEOUT";
  if (f.network === "refused") return "BEEPER_DOWN";
  if (f.network) return f.write ? "UNKNOWN_OUTCOME" : f.network === "timeout" ? "TIMEOUT" : "BEEPER_DOWN";
  const s = f.status ?? 0;
  if (s === 400) return "BAD_PARAMS";
  if (s === 401) return "BEEPER_UNAUTHORIZED"; // the connector's token was rejected; nothing ran
  if (s === 403) return "NOT_ALLOWED";
  if (s === 404) return "NOT_FOUND";
  if (s === 409 || s === 422) return "CONFLICT";
  if (s === 413) return "TOO_LARGE";
  if (s === 429) return "RATE_LIMITED";
  return f.write ? "UNKNOWN_OUTCOME" : "BEEPER_DOWN";
}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  BEEPER_DOWN: "Beeper is not reachable on this computer.",
  BEEPER_UNAUTHORIZED: "Beeper rejected the connector's access token. The owner should run `j-inbox doctor` to re-authorize.",
  TOO_LARGE: "Beeper's answer is too large.",
  UNKNOWN_OUTCOME: "Beeper did not confirm the change. It may or may not have happened; check before trying again.",
  TIMEOUT: "Beeper did not answer within the request's time.",
  CONFLICT: "The chat's current state does not allow this.",
  NOT_FOUND: "Not found in Beeper.",
};

function fail(f: Failure): BeeperCall {
  const code = beeperErrorCode(f);
  return { ok: false, error: makeError(code, MESSAGES[code] ?? (f.status ? `Beeper answered HTTP ${f.status}.` : "Beeper request failed.")) };
}

function networkKind(e: unknown): "refused" | "timeout" | "other" {
  const err = e as { name?: string; code?: string; cause?: { code?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  if (err?.code === "ConnectionRefused" || err?.code === "ECONNREFUSED" || err?.cause?.code === "ECONNREFUSED") return "refused";
  return "other";
}

/** The body as text, or null (stream cancelled) once it passes `max` bytes, with or without Content-Length. */
export async function readCapped(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

export function createBeeperClient(o: BeeperClientOptions): BeeperClient {
  const base = new URL(o.baseURL);
  const timeoutMs = o.timeoutMs ?? 15_000;
  const maxBody = o.maxBodyBytes ?? 20 * 1024 * 1024;
  const doFetch = o.fetchImpl ?? fetch;

  async function call(method: string, path: string, body: unknown, write: boolean, signal?: AbortSignal): Promise<BeeperCall> {
    const url = new URL(path, base);
    if (url.origin !== base.origin) return fail({ network: "other", write });
    if (signal?.aborted) return fail({ network: "not_sent", write });
    const headers: Record<string, string> = { authorization: `Bearer ${o.token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return fail({ network: networkKind(e), write });
    }
    let text: string;
    try {
      const read = await readCapped(res, maxBody);
      if (read === null) return fail({ status: 413, write });
      text = read;
    } catch (e) {
      return fail({ network: networkKind(e), write });
    }
    if (res.status < 200 || res.status > 299) return fail({ status: res.status, write });
    if (res.status === 204 || text === "") return { ok: true, status: res.status, body: null };
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) };
    } catch {
      return fail({ network: "other", write });
    }
  }

  async function stream(path: string, signal?: AbortSignal, headTimeoutMs?: number): Promise<BeeperStream> {
    const url = new URL(path, base);
    if (url.origin !== base.origin) return fail({ network: "other", write: false }) as BeeperStream;
    if (signal?.aborted) return fail({ network: "not_sent", write: false }) as BeeperStream;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(new DOMException("head timeout", "TimeoutError")), headTimeoutMs ?? timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, { method: "GET", headers: { authorization: `Bearer ${o.token}`, accept: "*/*" }, redirect: "manual", signal: ctl.signal });
    } catch (e) {
      return fail({ network: networkKind(e), write: false }) as BeeperStream;
    } finally {
      clearTimeout(timer);
      // The caller's signal bounds the wait for the head only. From here on the body is ended by
      // cancelling its reader (get_media's own cancel and deadlines), not by the head deadline.
      signal?.removeEventListener("abort", onAbort);
    }
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => {});
      return fail({ status: res.status, write: false }) as BeeperStream;
    }
    return { ok: true, status: res.status, res };
  }

  return {
    stream: (p, so) => stream(p, so?.signal, so?.headTimeoutMs),
    chatPath: (chatID, ...rest) => ["/v1/chats", encodeURIComponent(chatID), ...rest.map(encodeURIComponent)].join("/"),
    get: (p, o) => call("GET", p, undefined, false, o?.signal),
    write: (method, p, body, o) => call(method, p, body, true, o?.signal),
  };
}
