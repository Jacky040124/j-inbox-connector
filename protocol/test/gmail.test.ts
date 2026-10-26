// Gmail additions (design/gmail-plan.md): ids, attachment URLs, email headers, compose_email,
// the cloud-only gmail_connect, failedSources, new error codes and the Google token proxy shapes.
import { describe, expect, test } from "bun:test";
import {
  ACTIONS,
  GMAIL_NETWORK,
  GOOGLE_PATHS,
  GOOGLE_SCOPE,
  approvalView,
  assetUrl,
  buildRaftManifest,
  emailHeaders,
  emailRecipient,
  gmailAccountID,
  gmailAssetURL,
  gmailChatID,
  googleTokenRequest,
  googleTokenResponse,
  httpStatusForError,
  isErrorCode,
  isGmailID,
  isRetryable,
  messageItem,
  normalizeGmailAddress,
  ownerNoticeText,
  parse,
  parseActionResult,
  parseCloudFrame,
  parseGmailAccountID,
  parseGmailAssetURL,
  parseGmailChatID,
  surfaceForPath,
  encodeFrame,
} from "../src/index.ts";
import { chat, message } from "./fixtures/examples.ts";

const EMAIL = "jacky@example.com";

describe("Gmail ids", () => {
  test("account and chat ids round-trip and stay valid protocol ids", () => {
    expect(gmailAccountID("Jacky@Example.com")).toBe("gmail:jacky@example.com");
    const id = gmailChatID(EMAIL, "18c2f0a1b2c3d4e5");
    expect(id).toBe("gmail:jacky@example.com:18c2f0a1b2c3d4e5");
    expect(parseGmailChatID(id)).toEqual({ email: EMAIL, threadId: "18c2f0a1b2c3d4e5" });
    expect(parseGmailAccountID("gmail:jacky@example.com")).toBe(EMAIL);
    expect(parse(messageItem, { ...message, chatID: id, accountID: gmailAccountID(EMAIL) }).ok).toBe(true);
    expect(isGmailID(id) && isGmailID("gmail:anything") && !isGmailID("imsg##thread:+1555")).toBe(true);
  });
  test("malformed ids are refused, never half-parsed", () => {
    for (const v of ["gmail:", "gmail:jacky@example.com", "gmail:jacky@example.com:", "gmail:JACKY@example.com:18c2", "gmail:jacky@example.com:18c2/../x", "gmail:a b@example.com:1", "gmail:jacky@example.com:1:2", "!room:beeper.local", null, 5])
      expect(parseGmailChatID(v)).toBeNull();
    for (const v of ["gmail:", "gmail:Jacky@example.com", "jacky@example.com", "gmail:jacky@example.com:1"]) expect(parseGmailAccountID(v)).toBeNull();
    expect(() => gmailChatID("not an address", "1")).toThrow();
    expect(() => gmailChatID(EMAIL, "../x")).toThrow();
  });
  test("normalizeGmailAddress", () => {
    expect(normalizeGmailAddress("  Jacky.Z+tag@Gmail.com ")).toBe("jacky.z+tag@gmail.com");
    for (const v of ["", "jacky", "@x.com", "a@b", "a@@b.com", "a b@c.com", 'a"b@c.com', "a@b.c", "x".repeat(300) + "@a.com", null]) expect(normalizeGmailAddress(v)).toBeNull();
  });
});

describe("gmail:// attachment URLs", () => {
  test("build, parse and pass assetUrl", () => {
    const url = gmailAssetURL("jacky+in@example.com", "18c2f0a1b2c3d4e5", "ANGjdJ8-abc_DEF");
    expect(url).toBe("gmail://jacky%2Bin%40example.com/18c2f0a1b2c3d4e5/ANGjdJ8-abc_DEF");
    expect(parse(assetUrl(), url).ok).toBe(true);
    expect(parseGmailAssetURL(url)).toEqual({ email: "jacky+in@example.com", messageId: "18c2f0a1b2c3d4e5", attachmentId: "ANGjdJ8-abc_DEF" });
  });
  test("traversal, extra segments, bad encodings and other hosts are refused", () => {
    for (const v of ["gmail://jacky%40example.com/../x", "gmail://jacky%40example.com/1/2/3", "gmail://jacky%40example.com/1/a%2F..", "gmail:///1/2", "gmail://%E0%A4%A/1/2", "gmail://jacky%40example.com/1/a b"]) {
      expect(parseGmailAssetURL(v)).toBeNull();
    }
    for (const v of ["gmail://jacky%40example.com/../x", "gmail://jacky%40example.com/1/2/3", "gmail://jacky%40example.com/1/a b", "gmail:/x/1/2"]) expect(parse(assetUrl(), v).ok).toBe(false);
    // Encoded differently from the canonical form: not one we minted.
    expect(parseGmailAssetURL("gmail://jacky@example.com/1/2")).toBeNull();
  });
});

describe("email headers on messages", () => {
  const headers = { subject: "Lunch?", from: { name: "Alice Chen", address: "alice@example.com" }, to: [{ address: EMAIL }], cc: [] };
  test("optional email object validates", () => {
    expect(parse(messageItem, { ...message, email: headers }).ok).toBe(true);
    expect(parse(emailHeaders, { ...headers, to: [{ address: "undisclosed-recipients:;" }] }).ok).toBe(true);
  });
  test("strict: no line breaks, no extra fields, bounded", () => {
    expect(parse(emailHeaders, { ...headers, subject: "a\r\nBcc: x@y.z" }).ok).toBe(false);
    expect(parse(emailHeaders, { ...headers, from: { address: "a b@c.d" } }).ok).toBe(false);
    expect(parse(emailHeaders, { ...headers, bcc: [] }).ok).toBe(false);
    expect(parse(emailHeaders, { ...headers, to: Array.from({ length: 101 }, () => ({ address: "a@b.c" })) }).ok).toBe(false);
  });
  test("emailRecipient takes a bare address only (header injection is impossible)", () => {
    for (const v of ["a@example.com", "first.last+tag@sub.example.co.uk", "ü@例え.jp"]) expect(parse(emailRecipient, v).ok).toBe(true);
    for (const v of ["a", "a@b", "<a@b.com>", "A <a@b.com>", "a@b.com,c@d.com", "a@b.com\r\nBcc: x@y.z", "a@b.com;", '"a"@b.com', "a@b..com", "a@.com"]) expect(parse(emailRecipient, v).ok).toBe(false);
  });
});

describe("new error codes", () => {
  test("NOT_SUPPORTED, REAUTH_REQUIRED, UPSTREAM_DOWN", () => {
    for (const c of ["NOT_SUPPORTED", "REAUTH_REQUIRED", "UPSTREAM_DOWN"]) expect(isErrorCode(c)).toBe(true);
    expect(httpStatusForError("NOT_SUPPORTED")).toBe(422);
    // 5xx, never 401: the web page signs out on 401.
    expect(httpStatusForError("REAUTH_REQUIRED")).toBe(502);
    expect(httpStatusForError("UPSTREAM_DOWN")).toBe(502);
    for (const a of [undefined, "read_chat", "send_message", "compose_email"]) {
      expect(isRetryable("NOT_SUPPORTED", a)).toBe(false);
      expect(isRetryable("REAUTH_REQUIRED", a)).toBe(false);
      expect(isRetryable("UPSTREAM_DOWN", a)).toBe(true);
    }
  });
});

describe("mixed sources: failedSources", () => {
  const failed = [{ source: "gmail", accountID: "gmail:jacky@example.com", error: { code: "REAUTH_REQUIRED", message: "Reconnect this Gmail account in Settings." } }];
  test("list_chats, unread_summary and search_messages may name failed sources", () => {
    expect(parseActionResult("list_chats", { items: [chat], hasMore: false, nextCursor: null, failedSources: failed }).ok).toBe(true);
    expect(parseActionResult("unread_summary", { totalUnreadChats: 0, totalUnreadMessages: 0, items: [], truncated: false, failedSources: [{ source: "beeper", error: { code: "BEEPER_DOWN", message: "Beeper is down." } }] }).ok).toBe(true);
    expect(parseActionResult("search_messages", { items: [], chats: {}, hasMore: false, nextCursor: null, failedSources: failed }).ok).toBe(true);
  });
  test("strict shape", () => {
    expect(parseActionResult("list_chats", { items: [], hasMore: false, nextCursor: null, failedSources: [{ source: "imap", error: { code: "INTERNAL", message: "x" } }] }).ok).toBe(false);
    expect(parseActionResult("list_chats", { items: [], hasMore: false, nextCursor: null, failedSources: [{ source: "gmail", error: { code: "INTERNAL", message: "x" }, token: "x" }] }).ok).toBe(false);
  });
});

describe("compose_email and gmail_connect", () => {
  test("compose_email is a write that agents need approval for, with a per-agent cap", () => {
    const d = ACTIONS.compose_email;
    expect([d.write, d.needsApprovalForAgents, d.humanOnly ?? false]).toEqual([true, true, false]);
    expect(d.rateLimitPerMinute).toBeGreaterThan(0);
  });
  test("gmail_connect is cloud-only: never in the agent manifest", () => {
    const m = buildRaftManifest({ origin: "https://inbox.jackyzhonghq.com", service: "j-inbox" });
    const names = m.actions.map((a) => a.name);
    expect(names).not.toContain("gmail_connect");
    const compose = m.actions.find((a) => a.name === "compose_email")!;
    expect(compose.description).toMatch(/pending_approval/);
    expect(compose.parameters.to!.type).toBe("array");
  });
  test("the connector may receive both in req frames", () => {
    for (const [action, params] of [
      ["gmail_connect", { email: EMAIL, refreshToken: "1//0gFAKE" }],
      ["compose_email", { accountID: "gmail:jacky@example.com", to: ["a@example.com"], subject: "s", text: "t" }],
    ] as const) {
      const e = encodeFrame({ type: "req", id: "r1", action, params });
      expect(e.ok).toBe(true);
      expect(parseCloudFrame(e.ok ? e.value : "").ok).toBe(true);
    }
  });
  test("approval view shows recipients and subject for compose_email; notices name the action only", () => {
    const v = {
      id: "apr_1",
      action: "compose_email",
      status: "pending",
      createdAt: "2026-10-26T10:00:00.000Z",
      expiresAt: "2026-10-26T10:10:00.000Z",
      decidedAt: null,
      requestedBy: { type: "agent", id: "a1", name: "龙虾" },
      target: { chatID: "gmail:jacky@example.com", chatTitle: "New email", network: GMAIL_NETWORK },
      preview: { text: "Hi Alice", email: { to: ["alice@example.com"], cc: [], subject: "Lunch" } },
    };
    expect(parse(approvalView, v).ok).toBe(true);
    expect(parse(approvalView, { ...v, preview: { ...v.preview, email: { to: ["x"], cc: [], subject: "s" } } }).ok).toBe(false);
    const text = ownerNoticeText({ kind: "approval_requested", agentName: "龙虾", action: "compose_email", approveURL: "https://inbox.jackyzhonghq.com/approvals/apr_1", expiresAt: v.expiresAt });
    expect(text).toContain("send a new email");
    expect(text).not.toContain("alice");
  });
});

describe("Sign in with Google and the token proxy", () => {
  test("scopes are exactly openid email gmail.modify", () => {
    expect(GOOGLE_SCOPE).toBe("openid email https://www.googleapis.com/auth/gmail.modify");
  });
  test("surfaces: start and callback are the owner's web surface, the token proxy is the connector's", () => {
    expect(surfaceForPath(GOOGLE_PATHS.start)).toBe("web");
    expect(surfaceForPath(GOOGLE_PATHS.callback)).toBe("web");
    expect(surfaceForPath(GOOGLE_PATHS.token)).toBe("connector");
  });
  test("token request and response are strict", () => {
    expect(parse(googleTokenRequest, { refreshToken: "1//0gFAKE-refresh" }).ok).toBe(true);
    expect(parse(googleTokenRequest, { refreshToken: "1//0gFAKE-refresh", email: EMAIL }).ok).toBe(false);
    expect(parse(googleTokenRequest, { refreshToken: "bad token" }).ok).toBe(false);
    expect(parse(googleTokenResponse, { accessToken: "ya29.FAKE-access", expiresIn: 3599 }).ok).toBe(true);
    expect(parse(googleTokenResponse, { accessToken: "ya29.FAKE-access", expiresIn: 3599, refreshToken: "x" }).ok).toBe(false);
  });
});
