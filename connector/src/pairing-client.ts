// Connector side of device-code pairing (protocol/src/pairing.ts): POST /pair/start, show the
// 8-letter code and the verification URL (the owner types the code; no link carries it), poll
// POST /pair/poll every `interval` seconds, honour slow_down, stop on approved/denied/expired.
// The device token is returned to the caller once and never logged.
import { PAIR_PATHS, isSameOriginVerificationURL, pairPollResponse, pairRevokeResponse, pairStartResponse, parse, sanitizeLine, type PairPollResponse } from "@j-inbox/protocol";

export type PairResult =
  | { ok: true; deviceID: string; deviceToken: string; owner: { name: string | null; serverSlug: string } }
  | { ok: false; reason: "denied" | "expired" | "error" | "cancelled"; message: string };

export type PairOptions = {
  cloudURL: string;
  deviceName: string;
  connectorVersion: string;
  platform: { os: string; arch: string };
  onCode: (c: { userCode: string; verificationURL: string; expiresIn: number }) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
};

/** The protocol does not pin an envelope for /pair/*: accept the bare object or {ok:true,data}. */
function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body) && (body as any).ok === true && "data" in (body as any)) return (body as any).data;
  return body;
}

function errorCodeOf(body: unknown): string | null {
  const code = (body as any)?.error?.code;
  return typeof code === "string" && /^[A-Z_]{2,32}$/.test(code) ? code : null;
}

export function cleanDeviceName(name: string): string {
  return sanitizeLine(name, 64) || "Mac";
}

export async function pairDevice(o: PairOptions): Promise<PairResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = o.now ?? Date.now;
  const origin = new URL(o.cloudURL).origin;
  const fail = (reason: "denied" | "expired" | "error" | "cancelled", message: string): PairResult => ({ ok: false, reason, message });

  const post = async (path: string, body: unknown): Promise<{ status: number; body: unknown } | null> => {
    try {
      const res = await doFetch(new URL(path, origin), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      if (text.length > 64 * 1024) return { status: res.status, body: null };
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: null };
      }
    } catch {
      return null;
    }
  };

  const started = await post(PAIR_PATHS.start, { deviceName: cleanDeviceName(o.deviceName), connectorVersion: o.connectorVersion, platform: o.platform });
  if (o.signal?.aborted) return fail("cancelled", "Pairing cancelled.");
  if (!started) return fail("error", `Could not reach ${origin}. Check the internet connection and try again.`);
  if (started.status < 200 || started.status > 299) return fail("error", `The cloud refused to start pairing (${errorCodeOf(started.body) ?? `HTTP ${started.status}`}).`);
  const s = parse(pairStartResponse, unwrap(started.body));
  if (!s.ok) return fail("error", "The cloud sent an invalid pairing answer.");
  const info = s.value;
  if (!isSameOriginVerificationURL(info.verificationURL, origin)) return fail("error", "The cloud sent a verification link for another website. Pairing stopped.");
  o.onCode({ userCode: info.userCode, verificationURL: info.verificationURL, expiresIn: info.expiresIn });

  const deadline = now() + info.expiresIn * 1000;
  let interval = info.interval;
  // A poll that got no usable answer may have been the one that carried the token (the cloud hands
  // it out once): an "expired" right after it means the owner probably approved this computer.
  let lastPollLost = false;
  const LOST = "This computer may have been approved, but the answer with its key was lost on the way. Run `j-inbox pair` again (if the web page asks, confirm that the new pairing replaces this one).";
  for (;;) {
    if (o.signal?.aborted) return fail("cancelled", "Pairing cancelled.");
    if (now() + interval * 1000 > deadline) return fail("expired", "The code expired. Run `j-inbox pair` again.");
    await sleep(interval * 1000);
    if (o.signal?.aborted) return fail("cancelled", "Pairing cancelled.");
    const r = await post(PAIR_PATHS.poll, { deviceCode: info.deviceCode });
    if (o.signal?.aborted) return fail("cancelled", "Pairing cancelled.");
    if (!r || r.status >= 500) {
      lastPollLost = true;
      continue;
    }
    if (r.status >= 400) {
      const code = errorCodeOf(r.body);
      if (code === "RATE_LIMITED") {
        interval = Math.min(60, interval + 5);
        continue;
      }
      return fail("error", `The cloud refused the pairing (${code ?? `HTTP ${r.status}`}).`);
    }
    const p = parse(pairPollResponse, unwrap(r.body));
    if (!p.ok) {
      lastPollLost = true;
      continue;
    }
    const v: PairPollResponse = p.value;
    const lostBefore = lastPollLost;
    lastPollLost = false;
    switch (v.status) {
      case "pending":
        break;
      case "slow_down":
        interval = Math.max(interval, v.interval);
        break;
      case "approved":
        return { ok: true, deviceID: v.deviceID, deviceToken: v.deviceToken, owner: v.owner };
      case "denied":
        return fail("denied", "The pairing was denied in the J-Inbox web page.");
      case "expired":
        return fail("expired", lostBefore ? LOST : "The code expired. Run `j-inbox pair` again.");
    }
  }
}

/**
 * POST /pair/revoke with the device's own token: the cloud forgets this computer and closes its
 * /connect socket (4403). Used by unpair and uninstall before the token is deleted locally.
 */
export async function revokeDevice(o: { cloudURL: string; deviceToken: string; fetchImpl?: typeof fetch }): Promise<{ ok: true } | { ok: false; message: string }> {
  const doFetch = o.fetchImpl ?? fetch;
  let origin: string;
  try {
    origin = new URL(o.cloudURL).origin;
  } catch {
    return { ok: false, message: "The cloud URL is not valid." };
  }
  try {
    const res = await doFetch(new URL(PAIR_PATHS.revoke, origin), {
      method: "POST",
      headers: { authorization: `Bearer ${o.deviceToken}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text.length <= 64 * 1024 ? JSON.parse(text) : null;
    } catch {}
    if (res.ok && parse(pairRevokeResponse, unwrap(body)).ok) return { ok: true };
    return { ok: false, message: `The cloud refused (${errorCodeOf(body) ?? `HTTP ${res.status}`}).` };
  } catch {
    return { ok: false, message: `Could not reach ${origin}.` };
  }
}
