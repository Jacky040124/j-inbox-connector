// Login with Raft callback rules (security-r2-SEC2-1), session kinds and surfaces
// (security-r2-SEC2-2, privacy-r2-P2-1) and session lifetimes (security-r2-SEC2-6).
import { describe, expect, test } from "bun:test";
import { AGENT_SESSION_MAX_AGE_SECONDS, HUMAN_SESSION_ABSOLUTE_SECONDS, HUMAN_SESSION_IDLE_SECONDS, LOGIN_INIT_TTL_SECONDS } from "../src/limits.ts";
import {
  agentSessionMaxAge,
  authorizeSurface,
  handleRaftCallback,
  loginInitCookieName,
  openLoginInit,
  sealLoginInit,
  sessionExpired,
  startHumanLogin,
  surfaceForPath,
  type CallbackDeps,
  type RaftUserinfo,
} from "../src/auth.ts";
import { API_ROUTES, AUTH_LOGOUT, LIVE_PATH, sessionCookie, sessionCookieName } from "../src/web.ts";
import { AGENT_ACTION_PATH_PREFIX, RAFT_CALLBACK_PATH } from "../src/agent.ts";
import { PAIR_PATHS } from "../src/pairing.ts";

const APP = "https://inbox.example.com";
const RAFT = "https://api.raft.test";
const SECRET = "test-login-secret-0123456789abcdef0123456789";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const jackyInfo: RaftUserinfo = { sub: "aaaaaaaa-0000-4000-8000-000000000001", type: "human", server_id: A, server_slug: "jackyland", server_role: "owner", name: "Jacky" };
const lunlunInfo: RaftUserinfo = { sub: "bbbbbbbb-0000-4000-8000-000000000002", type: "agent", server_id: A, server_slug: "jackyland", server_role: "member", name: "囵囵" };

const setCookies = (r: Response) => (r.headers as Headers & { getSetCookie(): string[] }).getSetCookie();

function deps(o: { info?: RaftUserinfo | null; nonce?: string | null; exchangeOk?: boolean; expiresIn?: number; now?: () => number } = {}) {
  const calls = { exchange: [] as { code: string; verifier: string | null }[], sessions: [] as unknown[] };
  const d: CallbackDeps = {
    appOrigin: APP,
    loginSecret: SECRET,
    now: o.now,
    exchange: async (code, verifier) => {
      calls.exchange.push({ code, verifier });
      return o.exchangeOk === false ? null : { accessToken: "tok", expiresIn: o.expiresIn ?? 3600, idTokenNonce: o.nonce ?? null };
    },
    userinfo: async () => (o.info === undefined ? jackyInfo : o.info),
    createSession: async (s) => (calls.sessions.push(s), `sess_${calls.sessions.length}`),
  };
  return { d, calls };
}

async function begin(now?: () => number) {
  const r = await startHumanLogin({ appOrigin: APP, raftOrigin: RAFT, clientId: "j-inbox", loginSecret: SECRET, now });
  const loc = new URL(r.headers.get("location")!);
  const cookie = setCookies(r)[0]!;
  return { r, loc, cookie, cookiePair: cookie.split(";")[0]! };
}

const callback = (q: Record<string, string>, cookie?: string) =>
  new Request(`${APP}${RAFT_CALLBACK_PATH}?${new URLSearchParams(q)}`, { headers: cookie ? { cookie } : {} });

describe("human login start (SEC2-1)", () => {
  test("redirects to the standard authorize endpoint with state, nonce and PKCE S256, and sets a short-lived __Host- login-init cookie", async () => {
    const { r, loc, cookie } = await begin();
    expect(r.status).toBe(302);
    expect(loc.origin + loc.pathname).toBe(`${RAFT}/api/oauth/authorize`);
    const q = loc.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("j-inbox");
    expect(q.get("redirect_uri")).toBe(APP + RAFT_CALLBACK_PATH);
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(cookie.startsWith(loginInitCookieName(APP) + "=")).toBe(true);
    expect(loginInitCookieName(APP)).toBe("__Host-jinbox_login");
    for (const attr of ["Path=/", "HttpOnly", "SameSite=Lax", "Secure", `Max-Age=${LOGIN_INIT_TTL_SECONDS}`]) expect(cookie).toContain(attr);
    expect(cookie).not.toContain("Domain");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  test("two logins get different state, nonce and verifier", async () => {
    const a = await begin();
    const b = await begin();
    expect(a.loc.searchParams.get("state")).not.toBe(b.loc.searchParams.get("state"));
    expect(a.loc.searchParams.get("code_challenge")).not.toBe(b.loc.searchParams.get("code_challenge"));
  });
  test("the sealed login-init is tamper-evident and expires", async () => {
    let now = 1_000_000;
    const sealed = await sealLoginInit({ state: "s".repeat(43), nonce: "n".repeat(43), verifier: "v".repeat(43), createdAt: now }, SECRET);
    expect(await openLoginInit(sealed, SECRET, now)).toMatchObject({ state: "s".repeat(43) });
    expect(await openLoginInit(sealed, "other-secret-0123456789abcdef0123456789", now)).toBeNull();
    const [body, sig] = sealed.split(".");
    expect(await openLoginInit(`${body}x.${sig}`, SECRET, now)).toBeNull();
    expect(await openLoginInit("garbage", SECRET, now)).toBeNull();
    expect(await openLoginInit("a".repeat(5000), SECRET, now)).toBeNull();
    now += LOGIN_INIT_TTL_SECONDS * 1000;
    expect(await openLoginInit(sealed, SECRET, now)).toBeNull();
  });
});

describe("Raft callback (SEC2-1): humans need the login-init state, agents are proven by userinfo", () => {
  test("a human with matching state, verifier and nonce gets a human session", async () => {
    const { loc, cookiePair } = await begin();
    const { d, calls } = deps({ nonce: loc.searchParams.get("nonce") });
    const r = await handleRaftCallback(callback({ code: "c1", state: loc.searchParams.get("state")! }, cookiePair), d);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    expect(calls.exchange[0]!.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookies = setCookies(r);
    expect(cookies.some((c) => c.startsWith(`${sessionCookieName(APP, "human")}=sess_1;`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${loginInitCookieName(APP)}=;`) && c.includes("Max-Age=0"))).toBe(true);
    expect(calls.sessions[0]).toMatchObject({ kind: "human", principal: { type: "human", sub: jackyInfo.sub, serverID: A, role: "owner" } });
  });
  test("login CSRF: a human code without login-init state gets 4xx and no Set-Cookie at all", async () => {
    const { d, calls } = deps({ info: jackyInfo });
    const r = await handleRaftCallback(callback({ code: "mallorys-code" }), d);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(setCookies(r)).toEqual([]);
    expect(calls.sessions).toEqual([]);
  });
  test("login CSRF via a forced /auth/raft/login: the attacker's state does not match, nothing is exchanged", async () => {
    const { cookiePair } = await begin(); // victim's browser was sent through the login route
    for (const q of [{ code: "mallorys-code" }, { code: "mallorys-code", state: "A".repeat(43) }] as Record<string, string>[]) {
      const { d, calls } = deps();
      const r = await handleRaftCallback(callback(q, cookiePair), d);
      expect(r.status).toBe(400);
      expect(setCookies(r)).toEqual([]);
      expect(calls.exchange).toEqual([]);
    }
  });
  test("an invalid, tampered or expired login-init cookie never falls back to the agent path", async () => {
    let now = 5_000_000;
    const { loc, cookiePair } = await begin(() => now);
    const state = loc.searchParams.get("state")!;
    const name = loginInitCookieName(APP);
    for (const cookie of [`${name}=garbage`, `${name}=${cookiePair.split("=")[1]}x`, `${name}=`]) {
      const { d, calls } = deps({ info: lunlunInfo });
      const r = await handleRaftCallback(callback({ code: "c", state }, cookie), d);
      expect(r.status).toBe(400);
      expect(setCookies(r)).toEqual([]);
      expect(calls.exchange).toEqual([]);
    }
    now += LOGIN_INIT_TTL_SECONDS * 1000 + 1;
    const { d } = deps({ now: () => now });
    expect((await handleRaftCallback(callback({ code: "c", state }, cookiePair), d)).status).toBe(400);
  });
  test("a state parameter without a login-init cookie is refused", async () => {
    const { d, calls } = deps({ info: lunlunInfo });
    expect((await handleRaftCallback(callback({ code: "c", state: "x".repeat(43) }), d)).status).toBe(400);
    expect(calls.exchange).toEqual([]);
  });
  test("human flow: userinfo saying agent, or a wrong or missing nonce, is refused", async () => {
    for (const o of [{ info: lunlunInfo, nonce: "ok" }, { nonce: "wrong-nonce" }, { nonce: null }]) {
      const { loc, cookiePair } = await begin();
      const { d, calls } = deps({ ...o, nonce: o.nonce === "ok" ? loc.searchParams.get("nonce") : o.nonce });
      const r = await handleRaftCallback(callback({ code: "c", state: loc.searchParams.get("state")! }, cookiePair), d);
      expect(r.status).toBe(403);
      expect(setCookies(r).some((c) => c.startsWith(sessionCookieName(APP, "human")))).toBe(false);
      expect(calls.sessions).toEqual([]);
    }
  });
  test("an agent handoff (code only) gets an agent session cookie, capped at the Raft token lifetime and 1 h", async () => {
    for (const expiresIn of [3600, 600, 86_400]) {
      const { d, calls } = deps({ info: lunlunInfo, expiresIn });
      const r = await handleRaftCallback(callback({ code: "agent-code" }), d);
      expect(r.status).toBe(200);
      expect(calls.exchange[0]!.verifier).toBeNull();
      const cookie = setCookies(r).find((c) => c.startsWith(sessionCookieName(APP, "agent") + "="))!;
      expect(cookie).toBeDefined();
      expect(cookie).toContain(`Max-Age=${Math.min(expiresIn, AGENT_SESSION_MAX_AGE_SECONDS)}`);
      expect(cookie).toContain("Path=/");
      expect(calls.sessions[0]).toMatchObject({ kind: "agent", principal: { type: "agent", sub: lunlunInfo.sub } });
    }
  });
  test("exchange or userinfo failures, missing or hostile codes and malformed userinfo mint nothing", async () => {
    const cases: [Record<string, string>, Parameters<typeof deps>[0]][] = [
      [{}, {}],
      [{ code: "" }, {}],
      [{ code: "x".repeat(5000) }, {}],
      [{ code: "<script>" }, {}],
      [{ code: "c" }, { exchangeOk: false }],
      [{ code: "c" }, { info: null }],
      [{ code: "c" }, { info: { ...lunlunInfo, type: "robot" as any } }],
      [{ code: "c" }, { info: { ...lunlunInfo, server_id: "" } }],
      [{ code: "c" }, { info: { ...lunlunInfo, sub: undefined as any } }],
    ];
    for (const [q, o] of cases) {
      const { d, calls } = deps(o);
      const r = await handleRaftCallback(callback(q), d);
      expect(`${JSON.stringify(q).slice(0, 40)} ${r.status >= 400}`).toBe(`${JSON.stringify(q).slice(0, 40)} true`);
      expect(setCookies(r)).toEqual([]);
      expect(calls.sessions).toEqual([]);
    }
  });
});

describe("session kinds and surfaces (SEC2-2, P2-1)", () => {
  test("human and agent sessions use different cookie names", () => {
    expect(sessionCookieName(APP, "human")).toBe("__Host-jinbox_session");
    expect(sessionCookieName(APP, "agent")).toBe("__Host-jinbox_agent");
    expect(sessionCookieName("http://127.0.0.1:8787", "agent")).toBe("jinbox_agent");
    expect(sessionCookieName(APP)).toBe("__Host-jinbox_session");
  });
  test("every browser route, /live and /auth/logout are the web surface; /api/raft/actions/* is the agent surface", () => {
    for (const r of Object.values(API_ROUTES)) expect(`${r.path} ${surfaceForPath(r.path.replace(/\{[a-z]+\}/g, "x"))}`).toBe(`${r.path} web`);
    expect(surfaceForPath(LIVE_PATH)).toBe("web");
    expect(surfaceForPath(AUTH_LOGOUT.path)).toBe("web");
    expect(surfaceForPath("/api/actions/send_message")).toBe("web");
    expect(surfaceForPath("/api/approvals/apr_1/decision")).toBe("web");
    expect(surfaceForPath(AGENT_ACTION_PATH_PREFIX + "send_message")).toBe("agent");
    expect(surfaceForPath("/api/raft/actionsx")).toBe("web");
    expect(surfaceForPath(PAIR_PATHS.start)).toBe("connector");
    expect(surfaceForPath(PAIR_PATHS.poll)).toBe("connector");
    expect(surfaceForPath("/connect")).toBe("connector");
    expect(surfaceForPath("/")).toBe("public");
  });
  const jacky = { type: "human" as const, sub: jackyInfo.sub, serverID: A, role: "owner" };
  const lunlun = { type: "agent" as const, sub: lunlunInfo.sub, serverID: A, role: "member" };
  const adminAgent = { type: "agent" as const, sub: "bbbbbbbb-0000-4000-8000-000000000009", serverID: A, role: "admin" };
  const intruder = { type: "agent" as const, sub: "dddddddd-0000-4000-8000-000000000001", serverID: B, role: "member" };
  const guest = { type: "human" as const, sub: "aaaaaaaa-0000-4000-8000-000000000002", serverID: A, role: "member" };
  const binding = { ownerSub: jacky.sub, serverID: A };
  test("an agent session is NOT_ALLOWED on every web route: approve its own send, send without approval, read audit, open /live", () => {
    for (const path of ["/api/approvals/apr_1/decision", "/api/actions/send_message", "/api/audit", "/api/approvals", LIVE_PATH, "/api/me", "/api/pair/confirm", "/api/devices/d1/revoke", AUTH_LOGOUT.path]) {
      for (const agent of [lunlun, adminAgent]) expect(authorizeSurface(agent, surfaceForPath(path), binding)).toEqual({ ok: false, code: "NOT_ALLOWED" });
      expect(authorizeSurface(jacky, surfaceForPath(path), binding)).toEqual({ ok: true });
      expect(authorizeSurface(guest, surfaceForPath(path), binding)).toEqual({ ok: false, code: "NOT_ALLOWED" });
    }
  });
  test("the agent surface takes only agents on the bound server; humans are refused there", () => {
    const s = surfaceForPath(AGENT_ACTION_PATH_PREFIX + "read_chat");
    expect(authorizeSurface(lunlun, s, binding)).toEqual({ ok: true });
    expect(authorizeSurface(jacky, s, binding)).toEqual({ ok: false, code: "NOT_ALLOWED" });
    expect(authorizeSurface(intruder, s, binding)).toEqual({ ok: false, code: "NOT_ALLOWED" });
    expect(authorizeSurface(lunlun, s, null)).toEqual({ ok: false, code: "NOT_FOUND" });
  });
  test("connector and public surfaces never accept a session principal", () => {
    expect(authorizeSurface(jacky, "connector", binding).ok).toBe(false);
    expect(authorizeSurface(lunlun, "public", binding).ok).toBe(false);
  });
});

describe("session lifetimes (SEC2-6)", () => {
  test("agents at most 1 h (the Raft token lifetime); humans have an idle timeout and an absolute cap", () => {
    expect(AGENT_SESSION_MAX_AGE_SECONDS).toBe(3600);
    expect(HUMAN_SESSION_IDLE_SECONDS).toBeLessThan(HUMAN_SESSION_ABSOLUTE_SECONDS);
    expect(HUMAN_SESSION_ABSOLUTE_SECONDS).toBeLessThanOrEqual(7 * 24 * 3600);
    expect(agentSessionMaxAge(3600)).toBe(3600);
    expect(agentSessionMaxAge(120)).toBe(120);
    expect(agentSessionMaxAge(999_999)).toBe(3600);
    expect(agentSessionMaxAge(Number.NaN)).toBe(0);
    expect(agentSessionMaxAge(-5)).toBe(0);
  });
  test("cookies cannot outlive their kind's cap", () => {
    expect(() => sessionCookie(APP, "abc", AGENT_SESSION_MAX_AGE_SECONDS + 1, "agent")).toThrow();
    expect(() => sessionCookie(APP, "abc", HUMAN_SESSION_ABSOLUTE_SECONDS + 1, "human")).toThrow();
    expect(sessionCookie(APP, "abc", 3600, "agent")).toStartWith("__Host-jinbox_agent=abc;");
    expect(() => sessionCookie(APP, "abc", 30 * 24 * 3600)).toThrow();
  });
  test("server-side expiry: agents after 1 h or the token expiry, humans after idle or absolute limits", () => {
    const t0 = 1_000_000_000;
    const h = { kind: "human" as const, createdAt: t0, lastSeenAt: t0, expiresAt: t0 + HUMAN_SESSION_ABSOLUTE_SECONDS * 1000 };
    expect(sessionExpired(h, t0 + 1000)).toBe(false);
    expect(sessionExpired(h, t0 + HUMAN_SESSION_IDLE_SECONDS * 1000)).toBe(true);
    expect(sessionExpired({ ...h, lastSeenAt: t0 + HUMAN_SESSION_ABSOLUTE_SECONDS * 1000 - 10 }, t0 + HUMAN_SESSION_ABSOLUTE_SECONDS * 1000)).toBe(true);
    const a = { kind: "agent" as const, createdAt: t0, lastSeenAt: t0, expiresAt: t0 + 600_000 };
    expect(sessionExpired(a, t0 + 599_999)).toBe(false);
    expect(sessionExpired(a, t0 + 600_000)).toBe(true);
    expect(sessionExpired({ ...a, expiresAt: t0 + 10 * 3600_000 }, t0 + 3600_000)).toBe(true);
    expect(sessionExpired({ ...a, kind: "robot" as any }, t0)).toBe(true);
    expect(sessionExpired({ ...a, createdAt: Number.NaN }, t0)).toBe(true);
  });
});
