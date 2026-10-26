// Integrate round: the additive changes the connector, cloud and web builders asked for.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_ROUTES,
  WEB_HTML_HEADERS,
  WEB_PAGES,
  settingsRequest,
  settingsResponse,
  webPagePath,
  webPageURL,
} from "../src/web.ts";
import { CAPABILITIES, parseCloudFrame, parseConnectorFrame, encodeFrame } from "../src/frames.ts";
import { PAIR_PATHS, pairRevokeResponse, isSameOriginVerificationURL } from "../src/pairing.ts";
import { parse } from "../src/schema.ts";
import { PROTOCOL_VERSION } from "../src/limits.ts";

const s = JSON.stringify;
const req = { type: "req", id: "r1", action: "list_chats", params: {} };

describe("req.caller (optional, for the connector's local audit log)", () => {
  test("a req without caller still parses (old clouds)", () => {
    expect(parseCloudFrame(s(req)).ok).toBe(true);
  });
  test("human and agent callers parse, with or without a name", () => {
    for (const caller of [{ type: "human" }, { type: "agent" }, { type: "agent", name: "龙虾" }, { type: "human", name: "Jacky Zhong" }]) {
      const r = parseCloudFrame(s({ ...req, caller }));
      expect(r.ok).toBe(true);
      if (r.ok && r.value.type === "req") expect(r.value.caller).toEqual(caller as never);
    }
  });
  test("anything else in caller is refused", () => {
    for (const caller of [
      { type: "connector" },
      { type: "system" },
      { type: "agent", name: "" },
      { type: "agent", name: "x".repeat(201) },
      { type: "agent", name: "a\nb" },
      { type: "agent", name: "\u0000" },
      { type: "agent", sub: "agent_1" },
      { type: "agent", name: 5 },
      "agent",
      null,
      [],
    ])
      expect(parseCloudFrame(s({ ...req, caller })).ok).toBe(false);
  });
  test("encodeFrame accepts a req with a caller", () => {
    expect(encodeFrame({ type: "req", id: "r1", action: "status", params: {}, caller: { type: "agent", name: "囵囵" } }).ok).toBe(true);
  });
});

describe("hello capabilities", () => {
  test("CAPABILITIES.media is media.v1 and a hello carrying it parses", () => {
    expect(CAPABILITIES.media).toBe("media.v1");
    const hello = { type: "hello", v: PROTOCOL_VERSION, deviceID: "dev_1", connectorVersion: "0.1.0", beeperVersion: null, platform: { os: "darwin", arch: "arm64" }, networks: [], capabilities: Object.values(CAPABILITIES) };
    expect(parseConnectorFrame(s(hello)).ok).toBe(true);
  });
});

describe("POST /pair/revoke", () => {
  test("path and response", () => {
    expect(PAIR_PATHS.revoke).toBe("/pair/revoke");
    expect(parse(pairRevokeResponse, { revoked: true }).ok).toBe(true);
    for (const bad of [{ revoked: false }, {}, { revoked: true, extra: 1 }]) expect(parse(pairRevokeResponse, bad).ok).toBe(false);
  });
});

describe("verificationURL origin", () => {
  test("must equal the configured app origin exactly", () => {
    expect(isSameOriginVerificationURL("https://inbox.jackyzhonghq.com/pair", "https://inbox.jackyzhonghq.com")).toBe(true);
    expect(isSameOriginVerificationURL("http://127.0.0.1:8787/pair", "http://127.0.0.1:8787/")).toBe(true);
    for (const [u, app] of [
      ["https://evil.example/pair", "https://inbox.jackyzhonghq.com"],
      ["https://inbox.jackyzhonghq.com.evil.example/pair", "https://inbox.jackyzhonghq.com"],
      ["http://inbox.jackyzhonghq.com/pair", "https://inbox.jackyzhonghq.com"],
      ["http://localhost:8787/pair", "http://127.0.0.1:8787"],
      ["not a url", "https://inbox.jackyzhonghq.com"],
      ["https://inbox.jackyzhonghq.com/pair", "not a url"],
    ])
      expect(isSameOriginVerificationURL(u!, app!)).toBe(false);
  });
});

describe("settings route", () => {
  test("GET and POST /api/settings with {agentAccess}", () => {
    expect(API_ROUTES.settings).toEqual({ method: "GET", path: "/api/settings" });
    expect(API_ROUTES.updateSettings).toEqual({ method: "POST", path: "/api/settings" });
    for (const v of [true, false]) {
      expect(parse(settingsResponse, { agentAccess: v }).ok).toBe(true);
      expect(parse(settingsRequest, { agentAccess: v }).ok).toBe(true);
    }
    for (const bad of [{}, { agentAccess: "no" }, { agentAccess: 1 }, { agentAccess: true, more: 1 }]) {
      expect(parse(settingsRequest, bad).ok).toBe(false);
      expect(parse(settingsResponse, bad).ok).toBe(false);
    }
  });
});

describe("web page paths (shared by the cloud's links and the UI router)", () => {
  test("constants", () => {
    expect(WEB_PAGES).toEqual({ inbox: "/", pair: "/pair", approvals: "/approvals", approval: "/approvals/{id}", accounts: "/settings/accounts", devices: "/settings/devices", activity: "/settings/activity", general: "/settings/general" });
  });
  test("webPagePath fills only J-Inbox's own ids", () => {
    expect(webPagePath("approval", "apr_1-x")).toBe("/approvals/apr_1-x");
    expect(webPagePath("devices")).toBe("/settings/devices");
    for (const bad of ["", "a/b", "../x", "a b", "x".repeat(65), "imsg##thread:+1", "%2F"]) expect(() => webPagePath("approval", bad)).toThrow();
    expect(() => webPagePath("approval")).toThrow();
    expect(() => webPagePath("devices", "x")).toThrow();
  });
  test("webPageURL joins with the canonical app origin", () => {
    expect(webPageURL("https://inbox.jackyzhonghq.com/", "approval", "apr_1")).toBe("https://inbox.jackyzhonghq.com/approvals/apr_1");
    expect(webPageURL("http://127.0.0.1:8787", "approvals")).toBe("http://127.0.0.1:8787/approvals");
  });
});

describe("HTML CSP allows blob: media only", () => {
  test("img-src and media-src add blob:, nothing else is loosened", () => {
    const csp = WEB_HTML_HEADERS["Content-Security-Policy"];
    expect(csp).toBe("default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob:; media-src 'self' blob:");
    expect(csp).not.toMatch(/unsafe|\*|script-src[^;]*blob:|data:/);
  });
});

describe("TextDecoder options are explicit (Workers types require ignoreBOM)", () => {
  test("frames.ts passes ignoreBOM", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "frames.ts"), "utf8");
    expect(src).toContain('new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })');
  });
});
