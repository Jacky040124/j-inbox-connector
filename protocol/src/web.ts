// Browser <-> cloud: JSON HTTP API under /api and the /live WebSocket.
// Auth: the human's J-Inbox session cookie from Login with Raft (sessionCookie(..., "human"):
// __Host- prefix on https, HttpOnly, SameSite=Lax, Path=/). Every request on this surface runs
// authorizeSurface(principal, "web", binding) (auth.ts): only the room's human owner, never an
// agent session. Every non-GET /api request and POST /auth/logout must also send the CSRF_HEADER
// with value "1". Every /api response carries API_NO_STORE_HEADERS; every HTML page WEB_HTML_HEADERS.
// Request lines (path + query) never carry content: no chat ids, asset URLs, file names or text,
// because URLs end up in Worker logs, browser history and proxies. Such values go in POST bodies.
import {
  array,
  assetUrl,
  boolean,
  cursor,
  discriminated,
  enumOf,
  formatIssues,
  httpUrl,
  integer,
  isoDateTime,
  literal,
  nullable,
  object,
  optional,
  parse,
  string,
  type Infer,
  type Issue,
  type Schema,
} from "./schema.ts";
import { errorBody, errorCode } from "./errors.ts";
import { beeperHealth, ownId, versionString } from "./model.ts";
import { approvalView, canonicalOrigin } from "./agent.ts";
import { eventFrame } from "./frames.ts";
import type { ActionName } from "./actions.ts";
import { AGENT_SESSION_MAX_AGE_SECONDS, HUMAN_SESSION_ABSOLUTE_SECONDS, MAX_FRAME_BYTES } from "./limits.ts";

export const CSRF_HEADER = "x-j-inbox-csrf";
/**
 * The sub the browser bound its local cache to (from /api/me). Sent on every /api request after
 * boot; the cloud answers 401 UNAUTHENTICATED when it is not the session's sub, so a tab never
 * receives (and caches) another account's data after a login in another tab replaced the cookie.
 */
export const SESSION_SUB_HEADER = "x-j-inbox-sub";
export const LIVE_PATH = "/live";
/** Close codes the room uses on /live sockets (connector sockets use CLOSE_CODES). */
export const LIVE_CLOSE_CODES = {
  /** Evicted because the owner has too many /live sockets open: do not reconnect on your own. */
  TOO_MANY_TABS: 4429,
} as const;

export const API_ROUTES = {
  me: { method: "GET", path: "/api/me" },
  /** Body: the action's params. Response: apiResponse(action result). Humans never need approval. */
  action: { method: "POST", path: "/api/actions/{action}" },
  /**
   * Body: mediaRequest {url}. Response: raw bytes with mediaResponseHeaders(mimeType), or a JSON error.
   * POST (not GET) so the CSRF header is required and the asset URL never appears in a URL or log.
   * The web UI shows the bytes through a blob: object URL.
   */
  media: { method: "POST", path: "/api/media" },
  devices: { method: "GET", path: "/api/devices" },
  /**
   * Before answering {revoked:true} the room closes the device's live /connect socket with 4403
   * REVOKED and stops routing requests to it; in-flight requests to it fail (writes:
   * UNKNOWN_OUTCOME). Marking the D1 row alone is not enough: a connected socket would keep
   * receiving every req frame.
   */
  revokeDevice: { method: "POST", path: "/api/devices/{id}/revoke" },
  approvals: { method: "GET", path: "/api/approvals" },
  decideApproval: { method: "POST", path: "/api/approvals/{id}/decision" },
  /** Query: ?cursor&limit (limit 1-100, default 50). */
  audit: { method: "GET", path: "/api/audit" },
  pairLookup: { method: "POST", path: "/api/pair/lookup" },
  pairConfirm: { method: "POST", path: "/api/pair/confirm" },
  /** The owner's agent-access switch (on by default after pairing). Response: settingsResponse. */
  settings: { method: "GET", path: "/api/settings" },
  /** Body: settingsRequest. Response: settingsResponse. */
  updateSettings: { method: "POST", path: "/api/settings" },
} as const;

export const settingsResponse = object({ agentAccess: boolean() });
export const settingsRequest = object({ agentAccess: boolean() });
export type SettingsResponse = Infer<typeof settingsResponse>;
export type SettingsRequest = Infer<typeof settingsRequest>;

/**
 * Pages of the web UI. The cloud serves index.html for each and builds its links from them
 * (approveURL, owner notices); the UI routes on the same paths. Only J-Inbox's own ids appear.
 */
export const WEB_PAGES = {
  inbox: "/",
  pair: "/pair",
  approvals: "/approvals",
  approval: "/approvals/{id}",
  devices: "/settings/devices",
  activity: "/settings/activity",
} as const;
export type WebPage = keyof typeof WEB_PAGES;

const OWN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function webPagePath(page: WebPage, id?: string): string {
  const tpl: string = WEB_PAGES[page];
  if (tpl === undefined) throw new Error("unknown page");
  if (!tpl.includes("{id}")) {
    if (id !== undefined) throw new Error("this page takes no id");
    return tpl;
  }
  if (typeof id !== "string" || !OWN_ID_RE.test(id)) throw new Error("invalid id");
  return tpl.replace("{id}", id);
}

export function webPageURL(appOrigin: string, page: WebPage, id?: string): string {
  return canonicalOrigin(appOrigin) + webPagePath(page, id);
}

/** Sign out: expire the session cookie (expiredSessionCookie), drop the server-side session, send LOGOUT_RESPONSE_HEADERS. CSRF header required. */
export const AUTH_LOGOUT = { method: "POST", path: "/auth/logout" } as const;

export const mediaRequest = object({ url: assetUrl() });
export type MediaRequest = Infer<typeof mediaRequest>;

/** On every /api response (JSON and media). */
export const API_NO_STORE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

export const LOGOUT_RESPONSE_HEADERS = { "Clear-Site-Data": '"cache", "storage"', "Cache-Control": "no-store" } as const;

// Types a browser only ever renders as inert media. Everything else (html, svg, xml, pdf, scripts,
// text, unknown) is served as an application/octet-stream download.
const INLINE_MEDIA_RE = /^(?:image\/(?:png|jpeg|gif|webp)|video\/(?:mp4|webm)|audio\/[a-z0-9][a-z0-9.+-]{0,126})$/;

/**
 * Headers for every /api/media response (the app origin). Attacker-supplied bytes (a contact can
 * send any file) must never run as a page here: nosniff, sandbox CSP, no inline rendering of
 * active types, no caching, and no attacker-chosen file name in headers.
 */
export function mediaResponseHeaders(mimeType: string): Record<string, string> {
  const mime = typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
  const inline = INLINE_MEDIA_RE.test(mime);
  return {
    "Content-Type": inline ? mime : "application/octet-stream",
    "Content-Disposition": inline ? "inline" : "attachment",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

/**
 * On every HTML response of the app (/, /pair, the approval page, ...). The approve and pair pages
 * act on one click, so they must never be framed (clickjacking), and the UI renders hostile chat
 * text, so no inline script may ever run. Images and media are shown through blob: object URLs
 * made from POST /api/media, so img-src and media-src also allow blob: (and nothing else).
 */
export const WEB_HTML_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob:; media-src 'self' blob:",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
} as const;

// ---- session cookies ----
// Two kinds, two names, two server-side stores (or a stored kind that is checked): the web surface
// reads only the human cookie, /api/raft/actions/* only the agent cookie, and authorizeSurface()
// refuses the wrong principal type on each. The agent cookie keeps Path=/ (required by the
// __Host- prefix, and what the Raft CLI is known to send to action URLs); the name and the
// server-side kind check keep it off the web surface.

export type SessionKind = "human" | "agent";

const COOKIE_VALUE_RE = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_AGE_CAP: Record<SessionKind, number> = { human: HUMAN_SESSION_ABSOLUTE_SECONDS, agent: AGENT_SESSION_MAX_AGE_SECONDS };

/** `__Host-` (Secure, Path=/, no Domain) on https so sibling subdomains cannot set or shadow it; plain name on loopback http dev. */
export function sessionCookieName(origin: string, kind: SessionKind = "human"): string {
  if (kind !== "human" && kind !== "agent") throw new Error("invalid session kind");
  const base = kind === "human" ? "jinbox_session" : "jinbox_agent";
  return canonicalOrigin(origin).startsWith("https:") ? `__Host-${base}` : base;
}

/** Max-Age may not exceed the kind's cap (agents AGENT_SESSION_MAX_AGE_SECONDS, humans HUMAN_SESSION_ABSOLUTE_SECONDS). */
export function sessionCookie(origin: string, value: string, maxAgeSeconds: number, kind: SessionKind = "human"): string {
  if (!COOKIE_VALUE_RE.test(value)) throw new Error("invalid session cookie value");
  const name = sessionCookieName(origin, kind);
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > MAX_AGE_CAP[kind]) throw new Error("invalid max-age");
  const secure = canonicalOrigin(origin).startsWith("https:");
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${maxAgeSeconds}`;
}

export function expiredSessionCookie(origin: string, kind: SessionKind = "human"): string {
  const secure = canonicalOrigin(origin).startsWith("https:");
  return `${sessionCookieName(origin, kind)}=; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=0`;
}

// ---- browser-side cache (plan 2.5: instant open) ----

/**
 * Any IndexedDB / localStorage entry is keyed by the user's Raft `sub`. The UI keeps cached data
 * only while /api/me returns the same sub (shouldKeepLocalCache), and wipes it on logout, on any
 * 401, and on a sub mismatch, before rendering anything from it.
 */
export function localCacheKey(sub: string, key: string): string {
  if (typeof sub !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sub)) throw new Error("invalid sub");
  if (typeof key !== "string" || !/^[a-z0-9_.:-]{1,128}$/i.test(key)) throw new Error("invalid cache key");
  return `jinbox:v1:${sub}:${key}`;
}

export function shouldKeepLocalCache(cachedSub: string | null, meSub: string | null): boolean {
  return typeof cachedSub === "string" && cachedSub.length > 0 && cachedSub === meSub;
}

// ---- WebSocket upgrade Origin checks ----

/**
 * CORS does not protect WebSockets and SameSite=Lax cookies ride on same-site upgrades, so a page
 * on a sibling subdomain could open /live as the owner. /live: Origin must equal the app origin
 * exactly. /connect: the connector (not a browser) authenticates with a Bearer token and may omit
 * Origin, but a present Origin must still be the app origin. Reject with 403 otherwise.
 */
export function isAllowedUpgradeOrigin(path: "live" | "connect", origin: string | null, appOrigin: string): boolean {
  const app = canonicalOrigin(appOrigin);
  if (origin === null || origin === undefined) return path === "connect";
  return origin === app;
}

export function webActionPath(action: ActionName): string {
  return `/api/actions/${action}`;
}

/** `{ok:true, data}` or `{ok:false, error}`; HTTP status follows httpStatusForError. */
export function apiResponse<T>(data: Schema<T>) {
  return discriminated("ok", {
    true: object({ ok: literal(true), data }),
    false: object({ ok: literal(false), error: errorBody }),
  });
}

const name = nullable(string({ min: 0, max: 200 }));

export const meResponse = object({
  user: object({
    sub: string({ min: 1, max: 128 }),
    name,
    picture: nullable(httpUrl()),
    serverID: string({ min: 1, max: 128 }),
    serverSlug: string({ min: 1, max: 100 }),
  }),
  device: nullable(
    object({ id: ownId, name: string({ min: 1, max: 64 }), online: boolean(), lastSeenAt: nullable(isoDateTime()), connectorVersion: nullable(versionString) }),
  ),
  pendingApprovals: integer({ min: 0, max: 10_000 }),
});

export const deviceView = object({
  id: ownId,
  name: string({ min: 1, max: 64 }),
  createdAt: isoDateTime(),
  lastSeenAt: nullable(isoDateTime()),
  revoked: boolean(),
  online: boolean(),
  connectorVersion: nullable(versionString),
  platform: nullable(object({ os: string({ min: 1, max: 32 }), arch: string({ min: 1, max: 32 }) })),
});
export const devicesResponse = object({ items: array(deviceView, { max: 100 }) });
export const revokeDeviceResponse = object({ revoked: literal(true) });

export const approvalsResponse = object({ items: array(approvalView, { max: 100 }) });
export const approvalDecisionRequest = object({ decision: enumOf(["approve", "deny"] as const) });
export const approvalDecisionResponse = object({ approval: approvalView });

/** Metadata only: never params, message text, chat names/ids or media. */
export const auditEntry = object({
  at: isoDateTime(),
  actor: object({ type: enumOf(["human", "agent", "connector", "system"] as const), id: string({ min: 1, max: 128 }), name }),
  /** Catalogue action name or a lifecycle verb like login, pair, revoke, approval.approve. */
  action: string({ min: 1, max: 64, pattern: /^[a-z][a-z0-9_.]*$/ }),
  ok: boolean(),
  errorCode: optional(errorCode),
  approvalID: optional(ownId),
  durationMs: optional(integer({ min: 0, max: 86_400_000 })),
});
export const auditResponse = object({ items: array(auditEntry, { max: 100 }), nextCursor: nullable(cursor()) });

// ---- /live ----

const epochMs = integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

export const liveServerMessage = discriminated("type", {
  /** First message after connect. */
  snapshot: object({
    type: literal("snapshot"),
    online: boolean(),
    lastSeenAt: nullable(isoDateTime()),
    connectorVersion: nullable(versionString),
    beeper: nullable(beeperHealth),
    pendingApprovals: integer({ min: 0, max: 10_000 }),
  }),
  /** Connector connected or disconnected. On online=true after offline, refetch what is on screen. */
  presence: object({ type: literal("presence"), online: boolean(), lastSeenAt: nullable(isoDateTime()) }),
  /** A connector event relayed as-is (metadata only). */
  event: object({ type: literal("event"), event: eventFrame }),
  /** An approval was created or changed. */
  approval: object({ type: literal("approval"), approval: approvalView }),
  pong: object({ type: literal("pong"), t: epochMs }),
  /** The room dropped connector events (rate limit): refetch what is on screen. */
  resync: object({ type: literal("resync"), reason: enumOf(["events_dropped"] as const) }),
});

export const liveClientMessage = discriminated("type", {
  ping: object({ type: literal("ping"), t: epochMs }),
});

export type MeResponse = Infer<typeof meResponse>;
export type DeviceView = Infer<typeof deviceView>;
export type DevicesResponse = Infer<typeof devicesResponse>;
export type ApprovalsResponse = Infer<typeof approvalsResponse>;
export type ApprovalDecisionRequest = Infer<typeof approvalDecisionRequest>;
export type AuditEntry = Infer<typeof auditEntry>;
export type AuditResponse = Infer<typeof auditResponse>;
export type LiveServerMessage = Infer<typeof liveServerMessage>;
export type LiveClientMessage = Infer<typeof liveClientMessage>;

const MAX_LIVE_CLIENT_BYTES = 4096;
type LiveResult<T> = { ok: true; value: T } | { ok: false; message: string; issues?: Issue[] };

function parseJsonMessage<T>(schema: Schema<T>, text: string, maxChars: number): LiveResult<T> {
  if (typeof text !== "string" || text.length > maxChars) return { ok: false, message: "message too large" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: "not JSON" };
  }
  const r = parse(schema, json);
  return r.ok ? r : { ok: false, message: formatIssues(r.issues), issues: r.issues };
}

export function parseLiveServerMessage(text: string): LiveResult<LiveServerMessage> {
  return parseJsonMessage(liveServerMessage, text, MAX_FRAME_BYTES);
}

export function parseLiveClientMessage(text: string): LiveResult<LiveClientMessage> {
  return parseJsonMessage(liveClientMessage, text, MAX_LIVE_CLIENT_BYTES);
}
