// Gmail REST client for one account. Access tokens come from the cloud's token proxy (the web
// client secret cannot ship in this open-source connector): POST <cloud>/google/token with the
// device token, body {refreshToken}. Tokens live in memory only. A 401 from Gmail refreshes once
// and retries once (a 401 proves nothing ran). Bodies are read with a byte cap; ids are encoded;
// redirects are refused (the bearer token must not travel); failures map to protocol codes
// without echoing anything Google said.
import { GOOGLE_PATHS, googleTokenResponse, isErrorCode, makeError, parse, type ErrorBody, type ErrorCode } from "@j-inbox/protocol";
import { readCapped } from "../beeper-client.ts";

export const DEFAULT_GMAIL_API_URL = "https://gmail.googleapis.com";
export const DEFAULT_GOOGLE_OAUTH_URL = "https://oauth2.googleapis.com";
/** How long a refused refresh token is not tried again (the account shows reconnect_required meanwhile). */
export const REAUTH_BACKOFF_MS = 5 * 60_000;

export type TokenResult = { ok: true; accessToken: string; expiresIn: number } | { ok: false; error: ErrorBody };
export type RefreshFn = (refreshToken: string, signal?: AbortSignal) => Promise<TokenResult>;
export type GCall = { ok: true; status: number; body: any } | { ok: false; error: ErrorBody };
export type GCallOptions = { signal?: AbortSignal };

const err = (code: ErrorCode, message: string): { ok: false; error: ErrorBody } => ({ ok: false, error: makeError(code, message) });

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  UPSTREAM_DOWN: "Gmail is not reachable right now.",
  REAUTH_REQUIRED: "Google no longer accepts J-Inbox's access to this Gmail account. Reconnect it in Settings > Accounts.",
  UNKNOWN_OUTCOME: "Gmail did not confirm the change. It may or may not have happened; check before trying again.",
  TIMEOUT: "Gmail did not answer within the request's time.",
  NOT_FOUND: "Not found in Gmail.",
  RATE_LIMITED: "Gmail asked J-Inbox to slow down. Try again in a moment.",
  NOT_ALLOWED: "Gmail refused this.",
  BAD_PARAMS: "Gmail refused the request as invalid.",
  CONFLICT: "The thread's current state does not allow this.",
  TOO_LARGE: "Gmail's answer is too large.",
};
const fail = (code: ErrorCode) => err(code, MESSAGES[code] ?? "Gmail request failed.");

function networkKind(e: unknown): "refused" | "timeout" | "other" {
  const x = e as { name?: string; code?: string; cause?: { code?: string } };
  if (x?.name === "TimeoutError" || x?.name === "AbortError") return "timeout";
  if (x?.code === "ConnectionRefused" || x?.code === "ECONNREFUSED" || x?.cause?.code === "ECONNREFUSED") return "refused";
  return "other";
}

/**
 * Protocol code for a failed Gmail call. Like Beeper's: for writes only answers that prove nothing
 * happened (refused connection, 4xx) are anything but UNKNOWN_OUTCOME.
 */
export function gmailErrorCode(f: { status?: number; network?: "refused" | "timeout" | "other" | "not_sent"; write: boolean; reason?: string }): ErrorCode {
  if (f.network === "not_sent") return "TIMEOUT";
  if (f.network === "refused") return "UPSTREAM_DOWN";
  if (f.network) return f.write ? "UNKNOWN_OUTCOME" : f.network === "timeout" ? "TIMEOUT" : "UPSTREAM_DOWN";
  const s = f.status ?? 0;
  if (s === 400) return "BAD_PARAMS";
  if (s === 401) return "REAUTH_REQUIRED";
  if (s === 403) return /rateLimit|RateLimit|quota/i.test(f.reason ?? "") ? "RATE_LIMITED" : f.reason === "insufficientPermissions" ? "REAUTH_REQUIRED" : "NOT_ALLOWED";
  if (s === 404) return "NOT_FOUND";
  if (s === 409) return "CONFLICT";
  if (s === 413) return "TOO_LARGE";
  if (s === 429) return "RATE_LIMITED";
  return f.write ? "UNKNOWN_OUTCOME" : "UPSTREAM_DOWN";
}

/** The connector's way to a fresh access token: the cloud's stateless proxy. */
export function cloudTokenRefresher(o: { cloudURL: string; deviceToken: string; fetchImpl?: typeof fetch; timeoutMs?: number }): RefreshFn {
  const doFetch = o.fetchImpl ?? fetch;
  const url = new URL(GOOGLE_PATHS.token, new URL(o.cloudURL).origin);
  return async (refreshToken, signal) => {
    let res: Response;
    try {
      const timer = AbortSignal.timeout(o.timeoutMs ?? 15_000);
      res = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${o.deviceToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ refreshToken }),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timer]) : timer,
      });
    } catch {
      return err("UPSTREAM_DOWN", "J-Inbox could not refresh Gmail access (the J-Inbox cloud is not reachable).");
    }
    const text = await readCapped(res, 64 * 1024).catch(() => null);
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    if (res.ok) {
      const data = body && body.ok === true && "data" in body ? body.data : body;
      const r = parse(googleTokenResponse, data);
      return r.ok ? { ok: true, accessToken: r.value.accessToken, expiresIn: r.value.expiresIn } : err("UPSTREAM_DOWN", "The J-Inbox cloud sent an unreadable token answer.");
    }
    const code = body?.error?.code;
    if (isErrorCode(code)) return err(code, code === "REAUTH_REQUIRED" ? MESSAGES.REAUTH_REQUIRED! : code === "RATE_LIMITED" ? MESSAGES.RATE_LIMITED! : "J-Inbox could not refresh Gmail access.");
    return err("UPSTREAM_DOWN", "J-Inbox could not refresh Gmail access.");
  };
}

export type GmailClientOptions = {
  email: string;
  refreshToken: () => Promise<string | null>;
  refresh: RefreshFn;
  baseURL?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  /** Google refused the refresh token (invalid_grant): the account needs reconnecting. */
  onReauth?: () => void;
  /** A refresh worked again after onReauth. */
  onHealthy?: () => void;
  now?: () => number;
  /** Gmail's per-user quota is about 25 thread/message reads a second: stay below it (default 12/s). */
  maxRequestsPerSecond?: number;
  /** Waits for GET retries after Gmail says "slow down" (default 1 s, then 3 s). Tests pass shorter ones. */
  retryDelaysMs?: number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type GmailClient = ReturnType<typeof createGmailClient>;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export function createGmailClient(o: GmailClientOptions) {
  const base = new URL(o.baseURL ?? DEFAULT_GMAIL_API_URL);
  const doFetch = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 15_000;
  const maxBody = o.maxBodyBytes ?? 48 * 1024 * 1024;
  let access: { token: string; expiresAt: number } | null = null;
  // After Google refused the refresh token, answer REAUTH_REQUIRED at once for a while instead of
  // asking the cloud (and Google) again on every list and poll.
  let reauthUntil = 0;
  let refreshing: Promise<{ ok: true; token: string } | { ok: false; error: ErrorBody }> | null = null;

  async function token(signal?: AbortSignal, force = false): Promise<{ ok: true; token: string } | { ok: false; error: ErrorBody }> {
    if (!force && access && access.expiresAt - now() > 60_000) return { ok: true, token: access.token };
    if (now() < reauthUntil) return err("REAUTH_REQUIRED", MESSAGES.REAUTH_REQUIRED!);
    if (force) access = null;
    refreshing ??= (async () => {
      const rt = await o.refreshToken().catch(() => null);
      if (!rt) return err("REAUTH_REQUIRED", MESSAGES.REAUTH_REQUIRED!);
      const r = await o.refresh(rt, signal);
      if (!r.ok) {
        if (r.error.code === "REAUTH_REQUIRED") {
          reauthUntil = now() + REAUTH_BACKOFF_MS;
          o.onReauth?.();
        }
        return r;
      }
      access = { token: r.accessToken, expiresAt: now() + r.expiresIn * 1000 };
      o.onHealthy?.();
      return { ok: true as const, token: r.accessToken };
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  // Requests start at most `perSecond` a second (a sliding one-second window), so a list that fetches
  // many threads at once does not trip Gmail's per-user rate limit.
  const perSecond = Math.max(1, o.maxRequestsPerSecond ?? 12);
  const sleep = o.sleep ?? defaultSleep;
  const starts: number[] = [];
  async function pace(signal?: AbortSignal) {
    for (;;) {
      const t = now();
      while (starts.length && t - starts[0]! >= 1000) starts.shift();
      if (starts.length < perSecond) {
        starts.push(t);
        return;
      }
      await sleep(1000 - (t - starts[0]!) + 1, signal);
      if (signal?.aborted) return;
    }
  }
  const retryDelays = o.retryDelaysMs ?? [1000, 3000];

  async function call(method: string, path: string, body: unknown, write: boolean, ctx: GCallOptions, retried = false): Promise<GCall> {
    // Reads that Gmail answered with "slow down" are tried again after a short wait; writes never
    // are (a write may have happened).
    for (let attempt = 0; ; attempt++) {
      const r = await callOnce(method, path, body, write, ctx, retried);
      if (write || r.ok || r.error.code !== "RATE_LIMITED" || attempt >= retryDelays.length || ctx.signal?.aborted) return r;
      await sleep(retryDelays[attempt]!, ctx.signal);
    }
  }

  async function callOnce(method: string, path: string, body: unknown, write: boolean, ctx: GCallOptions, retried = false): Promise<GCall> {
    const url = new URL(path, base);
    if (url.origin !== base.origin) return fail("BAD_PARAMS");
    if (ctx.signal?.aborted) return fail("TIMEOUT");
    const t = await token(ctx.signal);
    if (!t.ok) return t;
    if (ctx.signal?.aborted) return fail("TIMEOUT");
    await pace(ctx.signal);
    if (ctx.signal?.aborted) return fail("TIMEOUT");
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: { authorization: `Bearer ${t.token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return fail(gmailErrorCode({ network: networkKind(e), write }));
    }
    let text: string | null;
    try {
      text = await readCapped(res, maxBody);
    } catch (e) {
      return fail(gmailErrorCode({ network: networkKind(e), write }));
    }
    if (text === null) return fail("TOO_LARGE");
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) return fail(write ? "UNKNOWN_OUTCOME" : "UPSTREAM_DOWN");
    }
    if (res.status === 401 && !retried) {
      // The access token expired or was revoked early: one fresh token, one more try (nothing ran).
      const again = await token(ctx.signal, true);
      if (!again.ok) return again;
      return callOnce(method, path, body, write, ctx, true);
    }
    if (res.status < 200 || res.status > 299) {
      const reason = typeof json?.error?.errors?.[0]?.reason === "string" ? json.error.errors[0].reason : undefined;
      const code = gmailErrorCode({ status: res.status, write, reason });
      if (code === "REAUTH_REQUIRED") o.onReauth?.();
      return fail(code);
    }
    return { ok: true, status: res.status, body: json };
  }

  const enc = encodeURIComponent;
  return {
    email: o.email,
    /** `/gmail/v1/users/me/<segments...>` with every segment encoded, plus a query. */
    path(segments: string[], query?: Record<string, string | string[] | undefined>): string {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query ?? {})) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, x);
      const s = q.toString();
      return `/gmail/v1/users/me/${segments.map(enc).join("/")}${s ? `?${s}` : ""}`;
    },
    get: (path: string, ctx: GCallOptions = {}) => call("GET", path, undefined, false, ctx),
    write: (path: string, body: unknown, ctx: GCallOptions = {}) => call("POST", path, body, true, ctx),
    /** Forget the cached access token and any refusal (e.g. after the account was reconnected). */
    reset() {
      access = null;
      reauthUntil = 0;
    },
  };
}

/** Revoke a refresh token at Google (needs no client secret). True when Google confirmed or already did not know it. */
export async function revokeAtGoogle(o: { token: string; oauthURL?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<boolean> {
  const url = new URL("/revoke", o.oauthURL ?? DEFAULT_GOOGLE_OAUTH_URL);
  try {
    const res = await (o.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: o.token }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    });
    await res.body?.cancel().catch(() => {});
    // 400 invalid_token: already revoked or expired, which is the state we want.
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}
