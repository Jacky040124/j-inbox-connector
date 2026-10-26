import { describe, expect, test } from "bun:test";
import {
  DEVICE_TOKEN_RE,
  PAIR_PATHS,
  USER_CODE_ALPHABET,
  generateDeviceCode,
  generateDeviceToken,
  generateUserCode,
  hashToken,
  normalizeUserCode,
  pairConfirmRequest,
  pairConfirmResponse,
  pairLookupResponse,
  pairPollRequest,
  pairPollResponse,
  pairStartRequest,
  pairStartResponse,
} from "../src/pairing.ts";
import { parse } from "../src/schema.ts";

describe("user codes", () => {
  test("format XXXX-XXXX from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateUserCode();
      expect(c).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
      for (const ch of c.replace("-", "")) expect(USER_CODE_ALPHABET).toContain(ch);
    }
  });
  test("alphabet has no vowels or look-alikes", () => {
    for (const ch of "AEIOU01OIL") expect(USER_CODE_ALPHABET.includes(ch) && "AEIOUL".includes(ch)).toBe(false);
  });
  test("no modulo bias: uses rejection sampling", () => {
    // A source that always returns 255 would bias toward the low letters if modulo were used.
    let calls = 0;
    const src = (n: number) => {
      calls++;
      return calls === 1 ? new Uint8Array(n).fill(255) : new Uint8Array(n).fill(1);
    };
    const c = generateUserCode(src);
    expect(c.replace("-", "")).toBe(USER_CODE_ALPHABET[1]!.repeat(8));
  });
  test("normalize is lenient on case, spaces and dashes", () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("  BCDF GHJK ")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
  });
  test("normalize rejects wrong length, foreign chars and hostile input", () => {
    for (const v of ["", "BCDF-GHJ", "BCDF-GHJKL", "AEIO-UBCD", "BCDF-GHJ1", "<scr-ipt>", "Ｂ".repeat(8), "BCDF\u0000GHJK", "x".repeat(10_000)]) expect(normalizeUserCode(v)).toBeNull();
    expect(normalizeUserCode(42 as any)).toBeNull();
  });
});

describe("device codes and tokens", () => {
  test("device code is 43 base64url chars and unique", () => {
    const a = generateDeviceCode();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateDeviceCode()).not.toBe(a);
  });
  test("device token format", () => {
    const t = generateDeviceToken();
    expect(t).toMatch(DEVICE_TOKEN_RE);
    expect(DEVICE_TOKEN_RE.test("jid_short")).toBe(false);
    expect(DEVICE_TOKEN_RE.test(t + "x")).toBe(false);
  });
  test("hashToken is stable sha-256 hex and differs per token", async () => {
    const h = await hashToken("jid_abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken("jid_abc")).toBe(h);
    expect(await hashToken("jid_abd")).not.toBe(h);
    expect(await hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("pairing shapes", () => {
  const start = { deviceName: "Jacky's Mac mini", connectorVersion: "0.1.0", platform: { os: "darwin", arch: "arm64" } };
  test("start request", () => {
    expect(parse(pairStartRequest, start).ok).toBe(true);
    expect(parse(pairStartRequest, { ...start, deviceName: "" }).ok).toBe(false);
    expect(parse(pairStartRequest, { ...start, deviceName: "x".repeat(65) }).ok).toBe(false);
    expect(parse(pairStartRequest, { ...start, deviceName: "a\nb" }).ok).toBe(false);
    expect(parse(pairStartRequest, { ...start, userID: "someone-else" }).ok).toBe(false);
  });
  test("start response", () => {
    const r = { deviceCode: generateDeviceCode(), userCode: "BCDF-GHJK", verificationURL: "https://inbox.example/pair", verificationURLComplete: "https://inbox.example/pair", expiresIn: 600, interval: 5 };
    expect(parse(pairStartResponse, r).ok).toBe(true);
    // security-r2-SEC2-3: no link may carry the code; the owner types the code shown in the terminal.
    expect(parse(pairStartResponse, { ...r, verificationURLComplete: "https://inbox.example/pair?code=BCDF-GHJK" }).ok).toBe(false);
    expect(parse(pairStartResponse, { ...r, verificationURLComplete: "https://inbox.example/pair#BCDF-GHJK" }).ok).toBe(false);
    expect(parse(pairStartResponse, { ...r, verificationURLComplete: "https://inbox.example/pair/BCDFGHJK" }).ok).toBe(false);
    expect(parse(pairStartResponse, { ...r, verificationURL: "http://evil.example/pair" }).ok).toBe(false);
    expect(parse(pairStartResponse, { ...r, userCode: "bcdf-ghjk" }).ok).toBe(false);
    expect(parse(pairStartResponse, { ...r, interval: 0 }).ok).toBe(false);
  });
  test("poll request/response", () => {
    expect(parse(pairPollRequest, { deviceCode: generateDeviceCode() }).ok).toBe(true);
    expect(parse(pairPollRequest, { deviceCode: "short" }).ok).toBe(false);
    for (const v of [
      { status: "pending" },
      { status: "slow_down", interval: 10 },
      { status: "approved", deviceID: "dev_1", deviceToken: generateDeviceToken(), owner: { name: "Jacky", serverSlug: "jackyland" } },
      { status: "denied" },
      { status: "expired" },
    ])
      expect(parse(pairPollResponse, v).ok).toBe(true);
    expect(parse(pairPollResponse, { status: "approved", deviceID: "dev_1" }).ok).toBe(false);
    expect(parse(pairPollResponse, { status: "pending", deviceToken: generateDeviceToken() }).ok).toBe(false);
    expect(parse(pairPollResponse, { status: "approved", deviceID: "dev_1", deviceToken: "bad", owner: { name: null, serverSlug: "x" } }).ok).toBe(false);
  });
  const lookup = {
    deviceName: "Mac",
    connectorVersion: "0.1.0",
    platform: { os: "darwin", arch: "arm64" },
    expiresAt: "2026-10-25T12:10:00Z",
    requestedAt: "2026-10-25T12:00:00Z",
    requester: { ip: "203.0.113.0/24", country: "DE" },
    replaces: null,
    signedInAs: { name: "Jacky", serverSlug: "jackyland" },
  };
  test("lookup and confirm", () => {
    expect(parse(pairLookupResponse, lookup).ok).toBe(true);
    expect(parse(pairConfirmRequest, { userCode: "BCDF-GHJK", approve: true }).ok).toBe(true);
    expect(parse(pairConfirmRequest, { userCode: "BCDF-GHJK" }).ok).toBe(false);
    expect(parse(pairConfirmRequest, { userCode: "BCDF-GHJK", approve: "yes" }).ok).toBe(false);
    expect(parse(pairConfirmResponse, { device: { id: "dev_1", name: "Mac" } }).ok).toBe(true);
    expect(parse(pairConfirmResponse, { device: null }).ok).toBe(true);
  });
  test("paths", () => {
    expect(PAIR_PATHS.start).toBe("/pair/start");
    expect(PAIR_PATHS.poll).toBe("/pair/poll");
    expect(PAIR_PATHS.confirm.startsWith("/api/")).toBe(true);
    expect(PAIR_PATHS.lookup.startsWith("/api/")).toBe(true);
  });
});

// security-r2-SEC2-3: the owner sees cloud-observed facts, who they are signed in as, and must
// explicitly confirm replacing an existing computer.
import { approximateIP, checkPairConfirm, pairLookupFailure } from "../src/pairing.ts";
describe("pair lookup shows facts the attacker cannot choose", () => {
  test("lookup requires requestedAt, requester, replaces and the signed-in identity", () => {
    const base = { deviceName: "Jacky's Mac mini", connectorVersion: "0.1.0", platform: { os: "darwin", arch: "arm64" }, expiresAt: "2026-10-25T12:10:00Z" };
    expect(parse(pairLookupResponse, base).ok).toBe(false);
    const full = { ...base, requestedAt: "2026-10-25T12:00:00Z", requester: { ip: "203.0.113.0/24", country: null }, replaces: { id: "dev_old", name: "Old Mac", online: true }, signedInAs: { name: null, serverSlug: "jackyland" } };
    expect(parse(pairLookupResponse, full).ok).toBe(true);
    expect(parse(pairLookupResponse, { ...full, requester: { ip: "203.0.113.7", country: "DEU" } }).ok).toBe(false);
  });
  test("approximateIP keeps a /24 (IPv4) or /48 (IPv6) and rejects garbage", () => {
    expect(approximateIP("203.0.113.77")).toBe("203.0.113.0/24");
    expect(approximateIP("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd::/48");
    expect(approximateIP("::1")).toBe("::/48");
    for (const bad of [null, "", "999.1.1.1", "1.2.3", "<script>", "x".repeat(100), "1.2.3.4\n"]) expect(approximateIP(bad as any)).toBeNull();
  });
  test("replacing a paired computer needs replaceDeviceID naming it", () => {
    const existing = { id: "dev_old", name: "Jacky's Mac mini" };
    expect(checkPairConfirm(null, { userCode: "BCDF-GHJK", approve: true })).toEqual({ ok: true });
    expect(checkPairConfirm(existing, { userCode: "BCDF-GHJK", approve: true })).toEqual({ ok: false, code: "CONFLICT" });
    expect(checkPairConfirm(existing, { userCode: "BCDF-GHJK", approve: true, replaceDeviceID: "dev_other" })).toEqual({ ok: false, code: "CONFLICT" });
    expect(checkPairConfirm(existing, { userCode: "BCDF-GHJK", approve: true, replaceDeviceID: "dev_old" })).toEqual({ ok: true });
    expect(checkPairConfirm(existing, { userCode: "BCDF-GHJK", approve: false })).toEqual({ ok: true });
    expect(parse(pairConfirmRequest, { userCode: "BCDF-GHJK", approve: true, replaceDeviceID: "dev_old" }).ok).toBe(true);
  });
  test("a wrong, expired, used or invalidated code all get the same answer", () => {
    expect(pairLookupFailure()).toEqual(pairLookupFailure());
    expect(pairLookupFailure().code).toBe("NOT_FOUND");
  });
});

// security-r2-SEC2-7: attempt limits on lookup/confirm and on /pair/start.
import { PAIR_ATTEMPT_WINDOW_MS, PAIR_CODE_MAX_FAILED_CONFIRMS, PAIR_MAX_FAILED_ATTEMPTS, PAIR_START_MAX_PER_IP, PAIR_START_WINDOW_MS, MAX_PENDING_PAIR_CODES, PairingGuard } from "../src/pairing.ts";
describe("PairingGuard", () => {
  const who = (o: Partial<{ sessionID: string; sub: string; ip: string }> = {}) => ({ sessionID: "s1", sub: "u1", ip: "203.0.113.7", ...o });
  test("after PAIR_MAX_FAILED_ATTEMPTS failures a session is locked out for the window", () => {
    let now = 1_000_000;
    const g = new PairingGuard({ now: () => now });
    for (let i = 0; i < PAIR_MAX_FAILED_ATTEMPTS; i++) {
      expect(g.canAttempt(who())).toBe(true);
      g.recordFailure(who());
    }
    expect(g.canAttempt(who())).toBe(false);
    now += PAIR_ATTEMPT_WINDOW_MS;
    expect(g.canAttempt(who())).toBe(true);
  });
  test("the limit applies per session, per Raft user and per IP: rotating any two does not help", () => {
    const g = new PairingGuard({ now: () => 0 });
    for (let i = 0; i < PAIR_MAX_FAILED_ATTEMPTS; i++) g.recordFailure(who({ sessionID: `s${i}`, ip: `198.51.100.${i}` }));
    expect(g.canAttempt(who({ sessionID: "fresh", ip: "192.0.2.1" }))).toBe(false); // same user
    const h = new PairingGuard({ now: () => 0 });
    for (let i = 0; i < PAIR_MAX_FAILED_ATTEMPTS; i++) h.recordFailure(who({ sessionID: `s${i}`, sub: `u${i}` }));
    expect(h.canAttempt(who({ sessionID: "fresh", sub: "fresh" }))).toBe(false); // same IP
  });
  test("a pending code is invalidated after PAIR_CODE_MAX_FAILED_CONFIRMS refused confirms", () => {
    const g = new PairingGuard({ now: () => 0 });
    for (let i = 0; i < PAIR_CODE_MAX_FAILED_CONFIRMS - 1; i++) expect(g.recordRefusedConfirm("BCDF-GHJK")).toBe(false);
    expect(g.recordRefusedConfirm("BCDF-GHJK")).toBe(true);
  });
  test("/pair/start is limited per IP and by a global cap on pending codes", () => {
    let now = 0;
    const g = new PairingGuard({ now: () => now });
    for (let i = 0; i < PAIR_START_MAX_PER_IP; i++) expect(g.canStart("203.0.113.7", 0)).toBe(true);
    expect(g.canStart("203.0.113.7", 0)).toBe(false);
    expect(g.canStart("203.0.113.8", 0)).toBe(true);
    expect(g.canStart("203.0.113.9", MAX_PENDING_PAIR_CODES)).toBe(false);
    now += PAIR_START_WINDOW_MS;
    expect(g.canStart("203.0.113.7", 0)).toBe(true);
  });
  test("memory stays bounded under a flood of distinct keys", () => {
    const g = new PairingGuard({ now: () => 0 });
    for (let i = 0; i < 50_000; i++) g.recordFailure(who({ sessionID: `s${i}`, sub: `u${i}`, ip: `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}` }));
    expect(g.size).toBeLessThanOrEqual(30_000);
  });
});
