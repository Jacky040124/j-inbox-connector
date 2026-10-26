// Review round 1 (2026-10-26) regressions for the protocol package:
// security-r1-SEC-3 (pairing start limits by network prefix, per-requester global cap, durable counters),
// spec-r1-F4 (typed 409 for a consumed or expired handoff), spec-r1-F5 (server_role is optional),
// stability-r1-R1-STAB-1 / R1-STAB-5 (reconnectable close codes), privacy-r1-PRIV-3 (session sub header).
import { describe, expect, test } from "bun:test";
import {
  CLOSE_CODES,
  MAX_PENDING_PAIR_CODES,
  MAX_PENDING_PAIR_CODES_HARD,
  MemoryGuardStore,
  PAIR_START_MAX_PER_IP,
  PAIR_START_MAX_PER_PREFIX,
  PAIR_START_WINDOW_MS,
  PairingGuard,
  SESSION_SUB_HEADER,
  handleRaftCallback,
  pairStartKeys,
  shouldReconnect,
  type CallbackDeps,
  type GuardStore,
  type RaftUserinfo,
} from "../src/index.ts";

describe("SEC-3: /pair/start limits by network prefix", () => {
  test("pairStartKeys: the full address plus /64 and /48 for IPv6, /24 for IPv4", () => {
    expect(pairStartKeys("2001:db8:abcd:12:1:2:3:4").map((k) => k.key)).toEqual(["ip:2001:db8:abcd:12:1:2:3:4", "v6/64:2001:db8:abcd:12", "v6/48:2001:db8:abcd"]);
    expect(pairStartKeys("2001:db8::1").map((k) => k.key)).toEqual(["ip:2001:db8::1", "v6/64:2001:db8:0:0", "v6/48:2001:db8:0"]);
    expect(pairStartKeys("2001:DB8:0:0::1").map((k) => k.key)).toEqual(["ip:2001:db8:0:0::1", "v6/64:2001:db8:0:0", "v6/48:2001:db8:0"]);
    expect(pairStartKeys("203.0.113.77").map((k) => k.key)).toEqual(["ip:203.0.113.77", "v4/24:203.0.113"]);
    expect(pairStartKeys("unknown").map((k) => k.key)).toEqual(["ip:unknown"]);
    expect(pairStartKeys("x".repeat(500))[0]!.key.length).toBeLessThanOrEqual(80);
  });

  test("an attacker rotating 1,000 addresses inside one IPv6 /64 gets only PAIR_START_MAX_PER_IP codes", () => {
    const g = new PairingGuard({ now: () => 0 });
    let ok = 0;
    for (let i = 0; i < 1000; i++) if (g.canStart(`2001:db8:abcd:12::${i.toString(16)}`, 0)) ok++;
    expect(ok).toBe(PAIR_START_MAX_PER_IP);
    // other /64s in the same /48 share a larger budget, then stop too
    let more = 0;
    for (let n = 0; n < 200; n++) for (let i = 0; i < 20; i++) if (g.canStart(`2001:db8:abcd:${(n + 100).toString(16)}::${i}`, 0)) more++;
    expect(ok + more).toBe(PAIR_START_MAX_PER_PREFIX);
    // a different network is unaffected
    expect(g.canStart("2001:db8:ffff:1::1", 0)).toBe(true);
    expect(g.canStart("198.51.100.4", 0)).toBe(true);
  });

  test("IPv4: one /24 shares PAIR_START_MAX_PER_PREFIX starts", () => {
    const g = new PairingGuard({ now: () => 0 });
    let ok = 0;
    for (let i = 0; i < 256; i++) if (g.canStart(`203.0.113.${i}`, 0)) ok++;
    expect(ok).toBe(PAIR_START_MAX_PER_PREFIX);
    expect(g.canStart("203.0.114.1", 0)).toBe(true);
  });

  test("the global pending cap refuses repeat requesters, not everyone", () => {
    let now = 0;
    const g = new PairingGuard({ now: () => now });
    expect(g.canStart("2001:db8:abcd:12::1", 0)).toBe(true);
    // the flood filled the pending table: the flooding network is refused ...
    expect(g.canStart("2001:db8:abcd:12::2", MAX_PENDING_PAIR_CODES)).toBe(false);
    expect(g.canStart("2001:db8:abcd:99::2", MAX_PENDING_PAIR_CODES)).toBe(false);
    // ... but a real user on another network still gets a code
    expect(g.canStart("198.51.100.4", MAX_PENDING_PAIR_CODES)).toBe(true);
    expect(g.canStart("198.51.100.4", MAX_PENDING_PAIR_CODES)).toBe(false);
    // a hard cap still bounds storage for everyone
    expect(g.canStart("192.0.2.1", MAX_PENDING_PAIR_CODES_HARD)).toBe(false);
    expect(g.canStart("192.0.2.1", Number.NaN)).toBe(false);
    now += PAIR_START_WINDOW_MS;
    expect(g.canStart("2001:db8:abcd:12::2", MAX_PENDING_PAIR_CODES)).toBe(true);
  });

  test("counters live in a GuardStore, so a new guard over the same store keeps them (Durable Object eviction)", () => {
    const store = new MemoryGuardStore();
    const a = new PairingGuard({ now: () => 0, store });
    for (let i = 0; i < PAIR_START_MAX_PER_IP; i++) expect(a.canStart("203.0.113.7", 0)).toBe(true);
    const who = { sessionID: "s1", sub: "u1", ip: "203.0.113.7" };
    for (let i = 0; i < 5; i++) a.recordFailure(who);
    const b = new PairingGuard({ now: () => 0, store });
    expect(b.canStart("203.0.113.7", 0)).toBe(false);
    expect(b.canAttempt({ ...who, sessionID: "fresh", ip: "192.0.2.9" })).toBe(false);
  });

  test("a custom store sees only the keys the guard computes (callers may hash them first)", () => {
    const seen = new Set<string>();
    const inner = new MemoryGuardStore();
    const store: GuardStore = {
      get: (k) => (seen.add(k), inner.get(k)),
      set: (k, v) => (seen.add(k), inner.set(k, v)),
      delete: (k) => inner.delete(k),
      size: () => inner.size(),
      evictOldest: (n) => inner.evictOldest(n),
    };
    const g = new PairingGuard({ now: () => 0, store });
    g.canStartKeys([{ key: "h1", max: 2 }], 0);
    g.canStartKeys([{ key: "h1", max: 2 }], 0);
    expect(g.canStartKeys([{ key: "h1", max: 2 }], 0)).toBe(false);
    expect([...seen].every((k) => k === "p:h1")).toBe(true);
  });
});

describe("F4: rejected handoffs answer typed JSON; an expired or reused code is 409", () => {
  const SECRET = "test-login-secret-0123456789abcdef0123456789";
  const agent: RaftUserinfo = { sub: "bbbbbbbb-0000-4000-8000-000000000002", type: "agent", server_id: "11111111-1111-4111-8111-111111111111", server_slug: "jackyland", server_role: "member", name: "囵囵" };
  const deps = (o: { exchangeOk?: boolean; info?: RaftUserinfo | null } = {}): CallbackDeps => ({
    appOrigin: "https://inbox.example.com",
    loginSecret: SECRET,
    exchange: async () => (o.exchangeOk === false ? null : { accessToken: "tok", expiresIn: 3600, idTokenNonce: null }),
    userinfo: async () => (o.info === undefined ? agent : o.info),
    createSession: async () => "sess",
  });
  const cb = (q: string) => new Request(`https://inbox.example.com/auth/raft/callback?${q}`);

  test("expired or already used agent handoff code: 409 with string error and hint", async () => {
    const r = await handleRaftCallback(cb("code=used-code"), deps({ exchangeOk: false }));
    expect(r.status).toBe(409);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b.error).toBe("HANDOFF_EXPIRED");
    expect(typeof b.hint).toBe("string");
    expect(b.hint as string).toContain("raft integration login");
    expect(b.ok).toBe(false);
  });

  test("every other refusal also has flat string error and hint fields", async () => {
    const cases: [string, Partial<{ exchangeOk: boolean; info: RaftUserinfo | null }>, number][] = [
      ["", {}, 400],
      ["code=%3Cscript%3E", {}, 400],
      ["code=c", { info: null }, 403],
      ["code=c", { info: { ...agent, type: "human" } }, 403],
      ["code=c&state=" + "x".repeat(43), {}, 400],
    ];
    for (const [q, o, status] of cases) {
      const r = await handleRaftCallback(cb(q), deps(o));
      expect(r.status).toBe(status);
      const b = (await r.json()) as Record<string, unknown>;
      expect(typeof b.error).toBe("string");
      expect(typeof b.hint).toBe("string");
      expect((b.error as string).length).toBeLessThanOrEqual(64);
      expect(b.error).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe("F5: userinfo without server_role", () => {
  test("an agent without server_role still signs in (role is never used for agents)", async () => {
    const info = { sub: "bbbbbbbb-0000-4000-8000-000000000002", type: "agent", server_id: "11111111-1111-4111-8111-111111111111", server_slug: "jackyland", name: "囵囵" } as RaftUserinfo;
    const sessions: unknown[] = [];
    const r = await handleRaftCallback(new Request("https://inbox.example.com/auth/raft/callback?code=c"), {
      appOrigin: "https://inbox.example.com",
      loginSecret: "test-login-secret-0123456789abcdef0123456789",
      exchange: async () => ({ accessToken: "tok", expiresIn: 3600 }),
      userinfo: async () => info,
      createSession: async (s) => (sessions.push(s), "sess"),
    });
    expect(r.status).toBe(200);
    expect(sessions[0]).toMatchObject({ principal: { type: "agent", role: "" } });
  });
  test("a non-string server_role is still refused", async () => {
    const info = { sub: "b", type: "agent", server_id: "s", server_role: 7 } as unknown as RaftUserinfo;
    const r = await handleRaftCallback(new Request("https://inbox.example.com/auth/raft/callback?code=c"), {
      appOrigin: "https://inbox.example.com",
      loginSecret: "test-login-secret-0123456789abcdef0123456789",
      exchange: async () => ({ accessToken: "tok", expiresIn: 3600 }),
      userinfo: async () => info,
      createSession: async () => "sess",
    });
    expect(r.status).toBe(403);
  });
});

describe("R1-STAB-1 / R1-STAB-5: close codes a live connector recovers from", () => {
  test("a missing hello is a timeout (reconnect), not an auth failure", () => {
    expect(CLOSE_CODES.HELLO_TIMEOUT).toBe(CLOSE_CODES.HEARTBEAT_TIMEOUT);
    expect(shouldReconnect(CLOSE_CODES.HELLO_TIMEOUT)).toBe(true);
  });
  test("the same device connecting again closes the older socket with SUPERSEDED, which reconnects", () => {
    expect(CLOSE_CODES.SUPERSEDED).toBe(4410);
    expect(shouldReconnect(CLOSE_CODES.SUPERSEDED)).toBe(true);
    expect(shouldReconnect(CLOSE_CODES.REPLACED)).toBe(false);
  });
});

describe("PRIV-3: the browser names the session it is bound to", () => {
  test("SESSION_SUB_HEADER is a lowercase custom header", () => {
    expect(SESSION_SUB_HEADER).toBe("x-j-inbox-sub");
  });
});
