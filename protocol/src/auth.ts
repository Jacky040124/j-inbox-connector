// Who may do what, and how they sign in.
//
// Login with Raft has one registered callback for humans and agents
// (docs.raft.build/developers/login-with-raft, "portable Agent Login boundary"):
// - Humans start at /auth/raft/login: we create login-init state (state, nonce, PKCE S256
//   verifier), seal it into a short-lived __Host- cookie and redirect to Raft's standard OIDC
//   authorize endpoint. The callback must find that cookie, a matching `state`, exchange the code
//   with the verifier and see the same nonce in the id_token. A human without valid login-init
//   state is refused: otherwise an attacker could log a victim's browser into the attacker's
//   account (login CSRF) and get the victim's Mac paired into the attacker's room.
// - Agents arrive with `?code=` only (no browser state). The callback exchanges the code without a
//   verifier and accepts the principal only if userinfo says type "agent". Agent identity is never
//   inferred from missing state, and invalid human state never falls back to the agent path.
//
// Sessions come in two kinds with two cookie names (web.ts sessionCookie). Each route belongs to
// one surface (surfaceForPath); authorizeSurface() runs on every request and refuses agents on
// the web surface and humans on the agent surface.
import { AGENT_ACTION_PATH_PREFIX, RAFT_CALLBACK_PATH, authorizeRoomAccess, canonicalOrigin, type AccessDecision, type Principal, type RoomBinding } from "./agent.ts";
import { AGENT_SESSION_MAX_AGE_SECONDS, HUMAN_SESSION_ABSOLUTE_SECONDS, HUMAN_SESSION_IDLE_SECONDS, LOGIN_INIT_TTL_SECONDS } from "./limits.ts";
import { PAIR_PATHS } from "./pairing.ts";
import { GOOGLE_PATHS } from "./gmail.ts";
import { AUTH_LOGOUT, LIVE_PATH, sessionCookie, type SessionKind } from "./web.ts";

// ---- login-init state (humans) ----

export type LoginInit = { state: string; nonce: string; verifier: string; createdAt: number };

const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const MAX_SEALED_LENGTH = 1024;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
const random43 = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("login secret must be at least 32 characters");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** PKCE S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function createLoginInit(now: number = Date.now()): LoginInit {
  return { state: random43(), nonce: random43(), verifier: random43(), createdAt: now };
}

/** `<base64url JSON>.<base64url HMAC-SHA256>`: tamper-evident, so it can live in a cookie. */
export async function sealLoginInit(init: LoginInit, secret: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(init)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** The login-init state, or null if it is malformed, forged or older than LOGIN_INIT_TTL_SECONDS. */
export async function openLoginInit(sealed: string, secret: string, now: number = Date.now()): Promise<LoginInit | null> {
  if (typeof sealed !== "string" || sealed.length > MAX_SEALED_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(sealed)) return null;
  const [body, sig] = sealed.split(".") as [string, string];
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const v = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (!v || typeof v !== "object") return null;
    const { state, nonce, verifier, createdAt } = v;
    if (![state, nonce, verifier].every((x) => typeof x === "string" && B64URL_43.test(x)) || !Number.isSafeInteger(createdAt)) return null;
    if (now < createdAt || now - createdAt >= LOGIN_INIT_TTL_SECONDS * 1000) return null;
    return { state, nonce, verifier, createdAt };
  } catch {
    return null;
  }
}

export function loginInitCookieName(origin: string): string {
  return canonicalOrigin(origin).startsWith("https:") ? "__Host-jinbox_login" : "jinbox_login";
}
function loginInitCookie(origin: string, value: string, maxAge: number): string {
  const secure = canonicalOrigin(origin).startsWith("https:");
  // SameSite=Lax: Raft's redirect back is a top-level GET navigation, which carries Lax cookies.
  return `${loginInitCookieName(origin)}=${value}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${maxAge}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header || header.length > 16_384) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** GET /auth/raft/login: set the login-init cookie and redirect to Raft's OIDC authorize endpoint. */
export async function startHumanLogin(o: { appOrigin: string; raftOrigin: string; clientId: string; loginSecret: string; scope?: string; now?: () => number; /** From Raft's discovery document; defaults to <raftOrigin>/api/oauth/authorize. */ authorizationEndpoint?: string | null }): Promise<Response> {
  const app = canonicalOrigin(o.appOrigin);
  const init = createLoginInit((o.now ?? Date.now)());
  const url = new URL(o.authorizationEndpoint ?? "/api/oauth/authorize", o.raftOrigin);
  for (const k of ["response_type", "client_id", "redirect_uri", "scope", "state", "nonce", "code_challenge", "code_challenge_method"]) url.searchParams.delete(k);
  const keep = [...url.searchParams.entries()];
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: app + RAFT_CALLBACK_PATH,
    scope: o.scope ?? "openid profile",
    state: init.state,
    nonce: init.nonce,
    code_challenge: await pkceChallenge(init.verifier),
    code_challenge_method: "S256",
  }).toString();
  for (const [k, v] of keep) url.searchParams.append(k, v);
  const headers = new Headers({ location: url.toString(), "cache-control": "no-store" });
  headers.append("set-cookie", loginInitCookie(app, await sealLoginInit(init, o.loginSecret), LOGIN_INIT_TTL_SECONDS));
  return new Response(null, { status: 302, headers });
}

// ---- callback ----

/** The userinfo fields J-Inbox relies on (Raft returns more). */
export type RaftUserinfo = { sub: string; type: "human" | "agent"; server_id: string; server_slug?: string; /** Only "when available" at Raft. */ server_role?: string | null; name?: string | null };

export type CallbackDeps = {
  appOrigin: string;
  loginSecret: string;
  /** Exchange the code at Raft's token endpoint (with code_verifier when not null). null = refused. The id_token must already be verified (JWKS, iss, aud, exp); pass its nonce. */
  exchange(code: string, codeVerifier: string | null): Promise<{ accessToken: string; expiresIn: number; idTokenNonce?: string | null } | null>;
  userinfo(accessToken: string): Promise<RaftUserinfo | null>;
  /** Store a server-side session and return its id (the cookie value). */
  createSession(s: { kind: SessionKind; principal: Principal; name: string | null; createdAt: number; expiresAt: number }): Promise<string>;
  now?: () => number;
};

const CODE_RE = /^[A-Za-z0-9._~-]{1,512}$/;

/** Why a callback was refused: a stable code for `error` (Raft's CLI shows `error` and `hint`). */
export type CallbackRefusal = "BAD_CODE" | "LOGIN_INVALID" | "HANDOFF_EXPIRED" | "IDENTITY_UNUSABLE" | "WRONG_PRINCIPAL" | "NONCE_MISMATCH" | "TOKEN_EXPIRED";

/**
 * Typed refusal (docs.raft.build Login with Raft, "Rejecting a login"): flat string `error` and
 * `hint`; `code`/`message` repeat them for older readers. No Set-Cookie.
 */
function refuse(status: number, error: CallbackRefusal, hint: string): Response {
  return new Response(JSON.stringify({ ok: false, error, hint, code: error, message: hint }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function principalFrom(info: RaftUserinfo | null): Principal | null {
  if (!info || typeof info !== "object") return null;
  const ok = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 128;
  // server_role is "when available" at Raft; a missing one is "" (canBindRoom then refuses).
  if ((info.type !== "human" && info.type !== "agent") || !ok(info.sub) || !ok(info.server_id) || (info.server_role !== undefined && info.server_role !== null && typeof info.server_role !== "string")) return null;
  return { type: info.type, sub: info.sub, serverID: info.server_id, role: typeof info.server_role === "string" ? info.server_role.slice(0, 64) : "" };
}

function equalStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * GET /auth/raft/callback for humans and agents. Every refusal is 4xx with no Set-Cookie.
 * Humans: 302 to "/" with the human session cookie. Agents: 200 JSON with the agent session cookie.
 */
export async function handleRaftCallback(req: Request, d: CallbackDeps): Promise<Response> {
  const now = (d.now ?? Date.now)();
  const app = canonicalOrigin(d.appOrigin);
  const q = new URL(req.url).searchParams;
  const code = q.get("code");
  if (!code || !CODE_RE.test(code)) return refuse(400, "BAD_CODE", "Missing or malformed Raft code. Run raft integration login --service j-inbox again, or sign in from the J-Inbox page.");
  const state = q.get("state");
  const rawInit = readCookie(req, loginInitCookieName(app));

  let human: LoginInit | null = null;
  if (rawInit !== null) {
    // A browser that started a human login. Never turn a bad human attempt into the agent path.
    human = await openLoginInit(rawInit, d.loginSecret, now);
    if (!human) return refuse(400, "LOGIN_INVALID", "Login expired or invalid. Start again from the sign-in page.");
    if (!state || !equalStrings(state, human.state)) return refuse(400, "LOGIN_INVALID", "Login state does not match. Start again from the sign-in page.");
  } else if (state !== null) {
    return refuse(400, "LOGIN_INVALID", "Login expired or invalid. Start again from the sign-in page.");
  }

  const token = await d.exchange(code, human ? human.verifier : null);
  if (!token || typeof token.accessToken !== "string" || !token.accessToken) return refuse(409, "HANDOFF_EXPIRED", human ? "This sign-in expired or was already used. Start again from the J-Inbox page." : "This login handoff expired or was already used. Run raft integration login --service j-inbox again.");
  const info = await d.userinfo(token.accessToken);
  const principal = principalFrom(info);
  if (!principal) return refuse(403, "IDENTITY_UNUSABLE", "Raft did not return a usable identity.");

  if (human) {
    if (principal.type !== "human") return refuse(403, "WRONG_PRINCIPAL", "This sign-in is for people. Agents sign in with raft integration login --service j-inbox.");
    if (typeof token.idTokenNonce !== "string" || !equalStrings(token.idTokenNonce, human.nonce)) return refuse(403, "NONCE_MISMATCH", "Login nonce does not match. Start again from the J-Inbox page.");
    const expiresAt = now + HUMAN_SESSION_ABSOLUTE_SECONDS * 1000;
    const id = await d.createSession({ kind: "human", principal, name: info?.name ?? null, createdAt: now, expiresAt });
    const headers = new Headers({ location: "/", "cache-control": "no-store" });
    headers.append("set-cookie", sessionCookie(app, id, HUMAN_SESSION_ABSOLUTE_SECONDS, "human"));
    headers.append("set-cookie", loginInitCookie(app, "", 0));
    return new Response(null, { status: 302, headers });
  }

  // No login-init state: only an agent proven by userinfo may sign in this way.
  if (principal.type !== "agent") return refuse(403, "WRONG_PRINCIPAL", "People sign in from the J-Inbox page. This link is not valid on its own.");
  const maxAge = agentSessionMaxAge(token.expiresIn);
  if (maxAge <= 0) return refuse(400, "TOKEN_EXPIRED", "Raft returned an expired token. Run raft integration login --service j-inbox again.");
  const id = await d.createSession({ kind: "agent", principal, name: info?.name ?? null, createdAt: now, expiresAt: now + maxAge * 1000 });
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  headers.append("set-cookie", sessionCookie(app, id, maxAge, "agent"));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// ---- session lifetimes ----

/** Agent session length: the Raft token's own lifetime, never above AGENT_SESSION_MAX_AGE_SECONDS. */
export function agentSessionMaxAge(tokenExpiresInSeconds: number): number {
  if (!Number.isFinite(tokenExpiresInSeconds) || tokenExpiresInSeconds <= 0) return 0;
  return Math.min(Math.floor(tokenExpiresInSeconds), AGENT_SESSION_MAX_AGE_SECONDS);
}

export type StoredSession = { kind: SessionKind; createdAt: number; lastSeenAt: number; expiresAt: number };

/**
 * Check on every request before trusting a stored session. Agents: past expiresAt (the token's
 * expiry) or AGENT_SESSION_MAX_AGE_SECONDS after login, they must log in again (which re-checks
 * membership, grant and installation at Raft). Humans: HUMAN_SESSION_IDLE_SECONDS idle or
 * HUMAN_SESSION_ABSOLUTE_SECONDS after login. Anything malformed is expired.
 */
export function sessionExpired(s: StoredSession, now: number): boolean {
  if (!s || (s.kind !== "human" && s.kind !== "agent")) return true;
  if (![s.createdAt, s.lastSeenAt, s.expiresAt, now].every(Number.isFinite)) return true;
  if (now >= s.expiresAt) return true;
  if (s.kind === "agent") return now - s.createdAt >= AGENT_SESSION_MAX_AGE_SECONDS * 1000;
  return now - s.lastSeenAt >= HUMAN_SESSION_IDLE_SECONDS * 1000 || now - s.createdAt >= HUMAN_SESSION_ABSOLUTE_SECONDS * 1000;
}

// ---- surfaces ----

/** web: the owner's browser API (/api/*, /live, /auth/logout). agent: /api/raft/actions/*. connector: pairing and /connect (device credentials). */
export type Surface = "web" | "agent" | "connector" | "public";

export function surfaceForPath(pathname: string): Surface {
  if (pathname.startsWith(AGENT_ACTION_PATH_PREFIX)) return "agent";
  if (pathname === PAIR_PATHS.start || pathname === PAIR_PATHS.poll || pathname === "/connect" || pathname === GOOGLE_PATHS.token) return "connector";
  if (pathname.startsWith("/api/") || pathname === LIVE_PATH || pathname === AUTH_LOGOUT.path || pathname === GOOGLE_PATHS.start || pathname === GOOGLE_PATHS.callback) return "web";
  return "public";
}

/** The session kind a surface reads. Never read the other kind's cookie on a surface. */
export function sessionKindForSurface(surface: Surface): SessionKind | null {
  return surface === "web" ? "human" : surface === "agent" ? "agent" : null;
}

/**
 * Run on every request of a session surface, after sessionExpired(). web: only the room's human
 * owner (an agent must never approve its own request, send without approval, read the audit log
 * or other agents' pending text, or open /live). agent: only agents on the bound server.
 */
export function authorizeSurface(p: Principal, surface: Surface, binding: RoomBinding | null): AccessDecision {
  const want = surface === "web" ? "human" : surface === "agent" ? "agent" : null;
  if (!want || !p || p.type !== want) return { ok: false, code: "NOT_ALLOWED" };
  return authorizeRoomAccess(p, binding);
}
