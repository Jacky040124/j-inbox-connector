import { describe, expect, test } from "bun:test";
import {
  API_ROUTES,
  CSRF_HEADER,
  LIVE_PATH,
  apiResponse,
  approvalDecisionRequest,
  approvalsResponse,
  auditEntry,
  auditResponse,
  devicesResponse,
  meResponse,
  parseLiveClientMessage,
  parseLiveServerMessage,
  webActionPath,
} from "../src/web.ts";
import { ACTION_NAMES } from "../src/actions.ts";
import { MAX_FRAME_BYTES } from "../src/limits.ts";
import { integer, object, parse } from "../src/schema.ts";

const s = JSON.stringify;

describe("routes", () => {
  test("every catalogue action has a web route", () => {
    for (const n of ACTION_NAMES) expect(webActionPath(n)).toBe(`/api/actions/${n}`);
  });
  test("route table is under /api and documents method + path", () => {
    for (const r of Object.values(API_ROUTES)) {
      expect(["GET", "POST"]).toContain(r.method);
      expect(r.path.startsWith("/api/")).toBe(true);
    }
    expect(LIVE_PATH).toBe("/live");
  });
  test("csrf header name is lower-case and custom", () => expect(CSRF_HEADER).toMatch(/^x-[a-z-]+$/));
});

describe("apiResponse", () => {
  const r = apiResponse(object({ n: integer({ min: 0, max: 9 }) }));
  test("ok and error shapes", () => {
    expect(parse(r, { ok: true, data: { n: 1 } }).ok).toBe(true);
    expect(parse(r, { ok: false, error: { code: "OFFLINE", message: "Your computer is offline." } }).ok).toBe(true);
  });
  test("mixed or malformed", () => {
    expect(parse(r, { ok: true, data: { n: 1 }, error: { code: "OFFLINE", message: "x" } }).ok).toBe(false);
    expect(parse(r, { ok: false, data: { n: 1 } }).ok).toBe(false);
    expect(parse(r, { ok: true, data: { n: 99 } }).ok).toBe(false);
    expect(parse(r, { ok: 1, data: { n: 1 } }).ok).toBe(false);
  });
});

describe("me / devices / approvals / audit", () => {
  const me = {
    user: { sub: "aaaaaaaa-0000-4000-8000-000000000001", name: "Jacky", picture: "https://api.raft.build/a.png", serverID: "dddddddd-0000-4000-8000-000000000004", serverSlug: "jackyland" },
    device: { id: "dev_1", name: "Mac mini", online: true, lastSeenAt: "2026-10-25T12:00:00Z", connectorVersion: "0.1.0" },
    pendingApprovals: 0,
  };
  test("me", () => {
    expect(parse(meResponse, me).ok).toBe(true);
    expect(parse(meResponse, { ...me, device: null }).ok).toBe(true);
    expect(parse(meResponse, { ...me, user: { ...me.user, picture: null } }).ok).toBe(true);
    expect(parse(meResponse, { ...me, user: { ...me.user, picture: "javascript:alert(1)" } }).ok).toBe(false);
    expect(parse(meResponse, { ...me, user: { ...me.user, type: "agent" } }).ok).toBe(false);
  });
  test("devices", () => {
    const d = { id: "dev_1", name: "Mac mini", createdAt: "2026-10-25T12:00:00Z", lastSeenAt: null, revoked: false, online: false, connectorVersion: null, platform: { os: "darwin", arch: "arm64" } };
    expect(parse(devicesResponse, { items: [d] }).ok).toBe(true);
    expect(parse(devicesResponse, { items: [{ ...d, tokenHash: "abc" }] }).ok).toBe(false);
  });
  test("approval decision", () => {
    expect(parse(approvalDecisionRequest, { decision: "approve" }).ok).toBe(true);
    expect(parse(approvalDecisionRequest, { decision: "deny" }).ok).toBe(true);
    expect(parse(approvalDecisionRequest, { decision: "APPROVE" }).ok).toBe(false);
    expect(parse(approvalDecisionRequest, {}).ok).toBe(false);
    expect(parse(approvalsResponse, { items: [] }).ok).toBe(true);
  });
  test("audit entries are metadata only", () => {
    const e = { at: "2026-10-25T12:00:00Z", actor: { type: "agent", id: "27a3edb7", name: "Longxia" }, action: "send_message", ok: false, errorCode: "OFFLINE" };
    expect(parse(auditEntry, e).ok).toBe(true);
    expect(parse(auditEntry, { ...e, ok: true, errorCode: undefined, durationMs: 120, approvalID: "apr_1" }).ok).toBe(true);
    for (const leak of [{ params: { text: "hi" } }, { text: "hi" }, { chatTitle: "Mom" }, { chatID: "x" }, { result: {} }]) expect(parse(auditEntry, { ...e, ...leak }).ok).toBe(false);
    expect(parse(auditEntry, { ...e, action: "Send Message!" }).ok).toBe(false);
    expect(parse(auditResponse, { items: [e], nextCursor: null }).ok).toBe(true);
  });
});

describe("/live messages", () => {
  test("server -> browser", () => {
    for (const m of [
      { type: "snapshot", online: true, lastSeenAt: "2026-10-25T12:00:00Z", connectorVersion: "0.1.0", beeper: { reachable: true, version: "4.2.1" }, pendingApprovals: 1 },
      { type: "presence", online: false, lastSeenAt: "2026-10-25T12:00:00Z" },
      { type: "event", event: { type: "event", kind: "message", op: "upserted", chatID: "c1", messageIDs: ["m1"], ts: "2026-10-25T12:00:00Z" } },
      { type: "pong", t: 1 },
    ]) {
      const r = parseLiveServerMessage(s(m));
      if (!r.ok) throw new Error(JSON.stringify(r));
    }
    expect(parseLiveServerMessage(s({ type: "event", event: { type: "event", kind: "message", op: "upserted", chatID: "c1", messageIDs: ["m1"], ts: "2026-10-25T12:00:00Z", text: "leak" } })).ok).toBe(false);
    expect(parseLiveServerMessage(s({ type: "exec" })).ok).toBe(false);
  });
  test("browser -> server", () => {
    expect(parseLiveClientMessage(s({ type: "ping", t: 1 })).ok).toBe(true);
    for (const m of [{ type: "req", action: "send_message" }, { type: "ping" }, "ping", []]) expect(parseLiveClientMessage(s(m)).ok).toBe(false);
    expect(parseLiveClientMessage("{").ok).toBe(false);
    expect(parseLiveClientMessage("x".repeat(MAX_FRAME_BYTES + 1)).ok).toBe(false);
  });
});

import {
  API_NO_STORE_HEADERS,
  AUTH_LOGOUT,
  LOGOUT_RESPONSE_HEADERS,
  expiredSessionCookie,
  isAllowedUpgradeOrigin,
  localCacheKey,
  mediaRequest,
  mediaResponseHeaders,
  sessionCookie,
  sessionCookieName,
  shouldKeepLocalCache,
} from "../src/web.ts";

// security-r1-SEC-2 + privacy-r1-P2: media is fetched with POST (CSRF header, URL in the body)
// and served with headers that keep attacker bytes inert on the app origin.
describe("media route and response headers", () => {
  test("media is POST with the asset URL in a JSON body, never in the request line", () => {
    expect(API_ROUTES.media).toEqual({ method: "POST", path: "/api/media" });
    expect(parse(mediaRequest, { url: "mxc://beeper.local/abc" }).ok).toBe(true);
    for (const bad of [{}, { url: "https://evil.example/x.html" }, { url: "file:///etc/../passwd" }, { url: "mxc://a/b", extra: 1 }]) expect(parse(mediaRequest, bad).ok).toBe(false);
  });
  test("no GET route carries content in its path or query", () => {
    for (const r of Object.values(API_ROUTES)) if (r.method === "GET") expect(r.path).not.toMatch(/\{(url|chatID|messageID|query)\}/);
  });
  test("every media response is nosniff, sandboxed, uncached and same-origin only", () => {
    for (const mime of ["image/png", "text/html", "image/svg+xml", "application/pdf", "video/mp4", "application/octet-stream"]) {
      const h = mediaResponseHeaders(mime);
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["Content-Security-Policy"]).toBe("sandbox; default-src 'none'");
      expect(h["Cache-Control"]).toBe("no-store");
      expect(h["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    }
  });
  test("inert types render inline with their own type", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "audio/ogg", "audio/mpeg", "IMAGE/PNG"]) {
      const h = mediaResponseHeaders(mime);
      expect(h["Content-Type"]).toBe(mime.toLowerCase());
      expect(h["Content-Disposition"]).toBe("inline");
    }
  });
  test("active or unknown types are downloads of application/octet-stream", () => {
    for (const mime of ["text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml", "application/pdf", "text/javascript", "application/javascript", "text/plain", "multipart/x-mixed-replace", "image/png; charset=x", "application/zip", "nonsense"]) {
      const h = mediaResponseHeaders(mime);
      expect(`${mime} -> ${h["Content-Type"]}`).toBe(`${mime} -> application/octet-stream`);
      expect(h["Content-Disposition"]).toBe("attachment");
    }
  });
  test("no file name (attacker-chosen, possibly content) ends up in headers", () => {
    expect(JSON.stringify(mediaResponseHeaders("application/pdf"))).not.toContain("filename");
  });
});

// privacy-r1-P3: sign-out, no-store and per-user local cache.
describe("sign-out and caching rules", () => {
  test("logout is a CSRF-protected POST that clears cookie, cache and storage", () => {
    expect(AUTH_LOGOUT).toEqual({ method: "POST", path: "/auth/logout" });
    expect(LOGOUT_RESPONSE_HEADERS["Clear-Site-Data"]).toBe('"cache", "storage"');
    expect(LOGOUT_RESPONSE_HEADERS["Cache-Control"]).toBe("no-store");
  });
  test("every /api response is no-store", () => {
    expect(API_NO_STORE_HEADERS["Cache-Control"]).toBe("no-store");
  });
  test("session cookie: __Host- prefix, Secure, HttpOnly, SameSite=Lax, Path=/ on https; plain name on loopback http", () => {
    expect(sessionCookieName("https://inbox.jackyzhonghq.com")).toBe("__Host-jinbox_session");
    expect(sessionCookieName("http://127.0.0.1:8787")).toBe("jinbox_session");
    const c = sessionCookie("https://inbox.jackyzhonghq.com", "abc_123", 3600);
    expect(c).toBe("__Host-jinbox_session=abc_123; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=3600");
    expect(c).not.toMatch(/Domain=/i);
    expect(sessionCookie("http://127.0.0.1:8787", "abc", 60)).not.toContain("Secure");
    expect(expiredSessionCookie("https://inbox.jackyzhonghq.com")).toBe("__Host-jinbox_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0");
    expect(() => sessionCookie("https://x.example", "a;b", 1)).toThrow();
    expect(() => sessionCookie("http://evil.example", "a", 1)).toThrow();
  });
  test("local cache is namespaced by user sub and dropped on a different sub", () => {
    const jacky = "aaaaaaaa-0000-4000-8000-000000000001";
    const guest = "aaaaaaaa-0000-4000-8000-000000000002";
    expect(localCacheKey(jacky, "chats")).not.toBe(localCacheKey(guest, "chats"));
    expect(localCacheKey(jacky, "chats")).toContain(jacky);
    expect(shouldKeepLocalCache(jacky, jacky)).toBe(true);
    expect(shouldKeepLocalCache(jacky, guest)).toBe(false);
    expect(shouldKeepLocalCache(null, jacky)).toBe(false);
    expect(shouldKeepLocalCache(jacky, null)).toBe(false);
    expect(() => localCacheKey("", "chats")).toThrow();
  });
});

// security-r1-SEC-3: WebSocket upgrades check Origin (CORS does not apply to WebSockets).
describe("upgrade Origin checks", () => {
  const app = "https://inbox.jackyzhonghq.com";
  test("/live requires exactly the app origin", () => {
    expect(isAllowedUpgradeOrigin("live", app, app)).toBe(true);
    for (const o of [null, "", "null", "https://evil.jackyzhonghq.com", "https://finance.jackyzhonghq.com", "http://inbox.jackyzhonghq.com", "https://inbox.jackyzhonghq.com.evil.com", "https://inbox.jackyzhonghq.com:444", app + "/"])
      expect(`${o} ${isAllowedUpgradeOrigin("live", o, app)}`).toBe(`${o} false`);
  });
  test("/connect (the connector, not a browser) may omit Origin but never send a foreign one", () => {
    expect(isAllowedUpgradeOrigin("connect", null, app)).toBe(true);
    expect(isAllowedUpgradeOrigin("connect", app, app)).toBe(true);
    for (const o of ["https://finance.jackyzhonghq.com", "null", "", "https://evil.example"]) expect(isAllowedUpgradeOrigin("connect", o, app)).toBe(false);
  });
  test("the canonical origin is normalised and must itself be valid", () => {
    expect(isAllowedUpgradeOrigin("live", app, app + "/")).toBe(true);
    expect(isAllowedUpgradeOrigin("live", "HTTPS://INBOX.JACKYZHONGHQ.COM", app)).toBe(false);
    expect(() => isAllowedUpgradeOrigin("live", app, "not a url")).toThrow();
  });
});

// security-r2-SEC2-4: every HTML page of the app gets a strict CSP and cannot be framed.
import { WEB_HTML_HEADERS } from "../src/web.ts";
describe("WEB_HTML_HEADERS", () => {
  test("strict CSP, no framing, no referrer, nosniff, no caching", () => {
    expect(WEB_HTML_HEADERS["Content-Security-Policy"]).toBe("default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob:; media-src 'self' blob:");
    expect(WEB_HTML_HEADERS["X-Frame-Options"]).toBe("DENY");
    expect(WEB_HTML_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(WEB_HTML_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(WEB_HTML_HEADERS["Cache-Control"]).toBe("no-store");
    expect(WEB_HTML_HEADERS["Content-Security-Policy"]).not.toContain("unsafe");
  });
});
