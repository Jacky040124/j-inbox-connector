// Pairing a connector to a Raft user: a device-code flow (like RFC 8628).
// 1. connector  POST /pair/start            -> deviceCode (secret) + userCode (shown on screen)
// 2. human      opens verificationURL, signs in with Raft, TYPES the code shown in the terminal
//               (no link ever carries it), POST /api/pair/lookup {userCode} to see which device
//               asks (with facts the cloud observed and whether it replaces a paired computer), then
//               POST /api/pair/confirm {userCode, approve, replaceDeviceID?}
// 3. connector  POST /pair/poll {deviceCode} every `interval` seconds until approved/denied/expired.
//               On approval it receives deviceID + deviceToken once; the cloud stores only hashToken(deviceToken).
import { boolean, discriminated, httpUrl, integer, isoDateTime, literal, nullable, object, optional, refine, string, type Infer } from "./schema.ts";
import { ownId, versionString } from "./model.ts";
import { PAIRING_CODE_TTL_SECONDS } from "./limits.ts";
import { makeError, type ErrorBody } from "./errors.ts";

export const PAIR_PATHS = {
  start: "/pair/start",
  poll: "/pair/poll",
  page: "/pair",
  lookup: "/api/pair/lookup",
  confirm: "/api/pair/confirm",
  /** POST with `Authorization: Bearer <deviceToken>`: the connector revokes itself (unpair, uninstall). */
  revoke: "/pair/revoke",
} as const;

/**
 * /pair/start, /pair/poll and /pair/revoke answer with the bare objects below (no apiResponse
 * wrapper); errors are `{ok:false, error}` with httpStatusForError. Connectors may accept both.
 */
export const pairRevokeResponse = object({ revoked: literal(true) });
export type PairRevokeResponse = Infer<typeof pairRevokeResponse>;

/**
 * The connector shows verificationURL only when its origin equals the app origin it was configured
 * with (exactly: scheme, host and port; 127.0.0.1 and localhost differ). A cloud that answers with
 * another site's link is treated as phishing and pairing stops.
 */
export function isSameOriginVerificationURL(verificationURL: string, appOrigin: string): boolean {
  try {
    return new URL(verificationURL).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

/** RFC 8628 section 6.1: consonants only, no vowels (no accidental words), no 0/O 1/I/L confusion. */
export const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ";
const USER_CODE_RE = new RegExp(`^[${USER_CODE_ALPHABET}]{4}-[${USER_CODE_ALPHABET}]{4}$`);
export const DEVICE_CODE_RE = /^[A-Za-z0-9_-]{43}$/;
export const DEVICE_TOKEN_RE = /^jid_[A-Za-z0-9_-]{43}$/;

type RandomSource = (n: number) => Uint8Array;
const defaultRandom: RandomSource = (n) => crypto.getRandomValues(new Uint8Array(n));

export function generateUserCode(random: RandomSource = defaultRandom): string {
  const n = USER_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < 8) {
    for (const b of random(16)) {
      if (b >= limit) continue;
      out += USER_CODE_ALPHABET[b % n];
      if (out.length === 8) break;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Canonical "XXXX-XXXX" or null. Accepts lower case, spaces and dashes. */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  if (compact.length !== 8) return null;
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return USER_CODE_RE.test(code) ? code : null;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 256-bit secret the connector polls with. */
export function generateDeviceCode(): string {
  return base64url(defaultRandom(32));
}

/** Long-lived device credential, sent as `Authorization: Bearer <token>` on /connect. */
export function generateDeviceToken(): string {
  return "jid_" + base64url(defaultRandom(32));
}

/** SHA-256 hex. Store this, never the token itself. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const deviceName = string({ min: 1, max: 64 });
const platform = object({ os: string({ min: 1, max: 32 }), arch: string({ min: 1, max: 32 }) });
const userCode = string({ min: 9, max: 9, pattern: USER_CODE_RE, format: "user-code" });
const deviceCode = string({ min: 43, max: 43, pattern: DEVICE_CODE_RE, format: "device-code" });
const deviceToken = string({ min: 47, max: 47, pattern: DEVICE_TOKEN_RE, format: "device-token" });

export const pairStartRequest = object({ deviceName, connectorVersion: versionString, platform });
/**
 * verificationURLComplete equals verificationURL (kept for RFC 8628 clients): a link that carries
 * the code would let anyone who sends the owner a link skip the one step only the owner can do,
 * typing the code shown in their own terminal.
 */
export const pairStartResponse = refine(
  object({
    deviceCode,
    userCode,
    verificationURL: httpUrl(),
    verificationURLComplete: httpUrl(),
    expiresIn: integer({ min: 1, max: PAIRING_CODE_TTL_SECONDS }),
    interval: integer({ min: 1, max: 60 }),
  }),
  (r) => (r.verificationURLComplete === r.verificationURL && !/[?#]/.test(r.verificationURL) ? null : "verification URLs must not carry the user code"),
);

export const pairPollRequest = object({ deviceCode });
export const pairPollResponse = discriminated("status", {
  pending: object({ status: literal("pending") }),
  slow_down: object({ status: literal("slow_down"), interval: integer({ min: 1, max: 120 }) }),
  approved: object({
    status: literal("approved"),
    deviceID: ownId,
    deviceToken,
    owner: object({ name: nullable(string({ min: 0, max: 200 })), serverSlug: string({ min: 1, max: 100 }) }),
  }),
  denied: object({ status: literal("denied") }),
  expired: object({ status: literal("expired") }),
});

export const pairLookupRequest = object({ userCode });
/**
 * deviceName, connectorVersion and platform come from whoever called /pair/start (possibly an
 * attacker). The page must show next to them what the cloud itself observed (requestedAt,
 * requester), which computer this would replace, and prominently who is signed in to which server.
 */
export const pairLookupResponse = object({
  deviceName,
  connectorVersion: versionString,
  platform,
  expiresAt: isoDateTime(),
  requestedAt: isoDateTime(),
  /** approximateIP() of the /pair/start caller and its country (CF-IPCountry), when known. */
  requester: object({ ip: nullable(string({ min: 1, max: 64 })), country: nullable(string({ min: 2, max: 2, pattern: /^[A-Z]{2}$/ })) }),
  /** The computer currently paired to this room, which approving would replace (and disconnect). */
  replaces: nullable(object({ id: ownId, name: deviceName, online: boolean() })),
  signedInAs: object({ name: nullable(string({ min: 0, max: 200 })), serverSlug: string({ min: 1, max: 100 }) }),
});
/** replaceDeviceID: required (and must name the paired computer) when the room already has one. */
export const pairConfirmRequest = object({ userCode, approve: boolean(), replaceDeviceID: optional(ownId) });
export const pairConfirmResponse = object({ device: nullable(object({ id: ownId, name: deviceName })) });

export type PairStartRequest = Infer<typeof pairStartRequest>;
export type PairStartResponse = Infer<typeof pairStartResponse>;
export type PairPollRequest = Infer<typeof pairPollRequest>;
export type PairPollResponse = Infer<typeof pairPollResponse>;
export type PairLookupRequest = Infer<typeof pairLookupRequest>;
export type PairLookupResponse = Infer<typeof pairLookupResponse>;
export type PairConfirmRequest = Infer<typeof pairConfirmRequest>;
export type PairConfirmResponse = Infer<typeof pairConfirmResponse>;

export type ExistingDevice = { id: string; name: string } | null;

/** Approving a pairing that replaces a paired computer needs replaceDeviceID naming it, else CONFLICT. Denying is always fine. */
export function checkPairConfirm(existing: ExistingDevice, req: PairConfirmRequest): { ok: true } | { ok: false; code: "CONFLICT" } {
  if (!req.approve || !existing) return { ok: true };
  return req.replaceDeviceID === existing.id ? { ok: true } : { ok: false, code: "CONFLICT" };
}

/** IPv4 -> a.b.c.0/24, IPv6 -> first 48 bits; null for anything else. Shown to the owner, never stored. */
export function approximateIP(ip: unknown): string | null {
  if (typeof ip !== "string" || ip.length > 64) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255) ? `${Number(v4[1])}.${Number(v4[2])}.${Number(v4[3])}.0/24` : null;
  if (!/^[0-9a-fA-F:]{2,39}$/.test(ip) || !ip.includes(":") || (ip.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  if (left.some((g) => g.length < 1 || g.length > 4) || right.some((g) => g.length < 1 || g.length > 4)) return null;
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const first = groups.slice(0, 3).map((g) => parseInt(g, 16).toString(16));
  return `${first.join(":")}::/48`.replace(/^0:0:0::/, "::").replace(/:0::\/48$/, "::/48");
}

/** The same answer for a wrong, expired, used or invalidated code (no oracle). Over the limit: RATE_LIMITED. */
export function pairLookupFailure(): ErrorBody {
  return makeError("NOT_FOUND", "Code not found or expired. Type the code shown in your terminal, or run j-inbox pair again.");
}

// ---- attempt limits (RFC 8628 section 5.1) ----

/** Failed lookups/confirms allowed per session, per Raft user and per IP within the window. */
export const PAIR_MAX_FAILED_ATTEMPTS = 5;
export const PAIR_ATTEMPT_WINDOW_MS = 10 * 60_000;
/** A pending code is invalidated after this many refused confirms (e.g. by someone who may not bind). */
export const PAIR_CODE_MAX_FAILED_CONFIRMS = 3;
/** /pair/start calls per window: per full address and per IPv6 /64 (one subscriber). */
export const PAIR_START_MAX_PER_IP = 10;
/** /pair/start calls per window per wider network: IPv6 /48 or IPv4 /24. */
export const PAIR_START_MAX_PER_PREFIX = 30;
export const PAIR_START_WINDOW_MS = 60 * 60_000;
/** Once this many codes are pending, only networks with no start in the window may start one. */
export const MAX_PENDING_PAIR_CODES = 10_000;
/** Above this, nobody may start (bounds storage). */
export const MAX_PENDING_PAIR_CODES_HARD = 100_000;
const GUARD_MAX_KEYS = 30_000;
const MAX_KEY_PART = 64;

/** Where PairingGuard keeps its counters. Synchronous so it works over a Durable Object's SQLite. */
export interface GuardStore {
  get(key: string): number[] | undefined;
  /** Store and mark as most recently used. */
  set(key: string, hits: number[]): void;
  delete(key: string): void;
  size(): number;
  /** Drop the `n` least recently used keys. */
  evictOldest(n: number): void;
}

export class MemoryGuardStore implements GuardStore {
  private m = new Map<string, number[]>();
  get(key: string) {
    return this.m.get(key);
  }
  set(key: string, hits: number[]) {
    this.m.delete(key);
    this.m.set(key, hits);
  }
  delete(key: string) {
    this.m.delete(key);
  }
  size() {
    return this.m.size;
  }
  evictOldest(n: number) {
    for (const k of this.m.keys()) {
      if (n-- <= 0) break;
      this.m.delete(k);
    }
  }
}

export type StartKey = { key: string; max: number };

function ipv6Groups(ip: string): string[] | null {
  if (!/^[0-9a-fA-F:]{2,39}$/.test(ip) || !ip.includes(":") || (ip.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  if (left.some((g) => g.length < 1 || g.length > 4) || right.some((g) => g.length < 1 || g.length > 4)) return null;
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16).toString(16)) : null;
}

/**
 * The counters a /pair/start from `ip` is charged to: the address itself, and its networks
 * (IPv6 /64 and /48, IPv4 /24), so rotating addresses inside one allocation does not help.
 */
export function pairStartKeys(ip: string): StartKey[] {
  const raw = typeof ip === "string" ? ip.slice(0, MAX_KEY_PART).toLowerCase() : "unknown";
  const keys: StartKey[] = [{ key: `ip:${raw}`, max: PAIR_START_MAX_PER_IP }];
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (v4 && v4.slice(1).every((o) => Number(o) <= 255)) keys.push({ key: `v4/24:${Number(v4[1])}.${Number(v4[2])}.${Number(v4[3])}`, max: PAIR_START_MAX_PER_PREFIX });
  const g = v4 ? null : ipv6Groups(raw);
  if (g) keys.push({ key: `v6/64:${g.slice(0, 4).join(":")}`, max: PAIR_START_MAX_PER_IP }, { key: `v6/48:${g.slice(0, 3).join(":")}`, max: PAIR_START_MAX_PER_PREFIX });
  return keys;
}

/**
 * Sliding-window counters for pairing over a GuardStore (memory by default; the cloud passes a
 * durable store so limits survive restarts). Every lookup/confirm calls canAttempt() first and
 * recordFailure() on a miss, and every /pair/start calls canStart().
 */
export class PairingGuard {
  private readonly store: GuardStore;
  private readonly now: () => number;

  constructor(o: { now?: () => number; store?: GuardStore } = {}) {
    this.now = o.now ?? Date.now;
    this.store = o.store ?? new MemoryGuardStore();
  }

  get size(): number {
    return this.store.size();
  }

  private recent(key: string, windowMs: number): number[] {
    const t = this.now();
    const all = this.store.get(key);
    if (!all) return [];
    const list = all.filter((x) => t - x < windowMs);
    if (!list.length) this.store.delete(key);
    return list;
  }

  private add(key: string) {
    const list = this.store.get(key) ?? [];
    list.push(this.now());
    this.store.set(key, list.slice(-64));
    // Least recently used keys go first: memory stays bounded under a flood.
    const over = this.store.size() - GUARD_MAX_KEYS;
    if (over > 0) this.store.evictOldest(over);
  }

  private static keys(w: { sessionID: string; sub: string; ip: string }): string[] {
    return [`s:${w.sessionID}`, `u:${w.sub}`, `i:${w.ip}`];
  }

  /** False once the session, the Raft user or the IP has PAIR_MAX_FAILED_ATTEMPTS failures in the window: answer RATE_LIMITED. */
  canAttempt(w: { sessionID: string; sub: string; ip: string }): boolean {
    return PairingGuard.keys(w).every((k) => this.recent(k, PAIR_ATTEMPT_WINDOW_MS).length < PAIR_MAX_FAILED_ATTEMPTS);
  }

  recordFailure(w: { sessionID: string; sub: string; ip: string }): void {
    for (const k of PairingGuard.keys(w)) this.add(k);
  }

  /** Count a refused confirm against a pending code; true when the code must now be invalidated. */
  recordRefusedConfirm(userCode: string): boolean {
    const k = `c:${userCode}`;
    this.add(k);
    return this.recent(k, PAIRING_CODE_TTL_SECONDS * 1000).length >= PAIR_CODE_MAX_FAILED_CONFIRMS;
  }

  /** May this IP start a pairing, given how many codes are pending in total? Records the start when true. */
  canStart(ip: string, pendingCodes: number): boolean {
    return this.canStartKeys(pairStartKeys(ip), pendingCodes);
  }

  /**
   * canStart over precomputed (possibly hashed) keys. Each key has its own budget. While
   * MAX_PENDING_PAIR_CODES codes are pending, a requester whose networks already started one in
   * the window is refused, so a flood blocks the flooder rather than everyone.
   */
  canStartKeys(keys: StartKey[], pendingCodes: number): boolean {
    if (!Number.isFinite(pendingCodes) || pendingCodes >= MAX_PENDING_PAIR_CODES_HARD || !keys.length) return false;
    const counts = keys.map((k) => this.recent(`p:${k.key}`, PAIR_START_WINDOW_MS).length);
    if (keys.some((k, i) => counts[i]! >= k.max)) return false;
    if (pendingCodes >= MAX_PENDING_PAIR_CODES && counts.some((n) => n > 0)) return false;
    for (const k of keys) this.add(`p:${k.key}`);
    return true;
  }
}
