// The email frame's contract: its policy, its document, what the parent may believe of it, and that
// no way but the owner's page leads to the action.
import { describe, expect, test } from "bun:test";
import {
  ACTIONS,
  API_ROUTES,
  CAPABILITIES,
  EMAIL_FRAME_MAX_HEIGHT,
  EMAIL_FRAME_MIN_HEIGHT,
  EMAIL_FRAME_PATH,
  EMAIL_FRAME_SANDBOX,
  WEB_HTML_HEADERS,
  appHtmlHeaders,
  buildRaftManifest,
  emailFrameClose,
  emailFrameCsp,
  emailFrameFailure,
  emailFrameHeaders,
  emailFrameOpen,
  emailFramePath,
  emailFrameRequest,
  emailFrameTicket,
  emailFrameTicketOf,
  isAgentActionName,
  isEmailFrameTicket,
  parse,
  parseEmailFrameMessage,
  surfaceForPath,
} from "../src/index.ts";

const TICKET = "A".repeat(43);
const NONCE = "bm9uY2Utbm9uY2Utbm9uY2U";
const open = emailFrameOpen({ nonce: NONCE, endMark: "end-mark-1", appOrigin: "https://inbox.example" });

describe("the frame's policy", () => {
  test("exactly what the design asks, the nonce in one place", () => {
    expect(emailFrameCsp(NONCE)).toBe(`sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src data:; script-src 'nonce-${NONCE}'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`);
  });
  test("the sandbox never has allow-same-origin, allow-forms or allow-top-navigation, in the element's or the CSP's", () => {
    for (const s of [EMAIL_FRAME_SANDBOX, emailFrameCsp(NONCE)]) expect(s).not.toMatch(/allow-same-origin|allow-forms|allow-top-navigation|allow-modals|allow-downloads/);
  });
  test("no script source but the nonce: no 'self', no https:, no inline, no eval", () => {
    const script = emailFrameCsp(NONCE).split("; ").find((d) => d.startsWith("script-src"))!;
    expect(script).toBe(`script-src 'nonce-${NONCE}'`);
    expect(emailFrameCsp(NONCE)).not.toMatch(/unsafe-eval|connect-src|frame-src|child-src/);
  });
  test("headers: no-store, no-referrer, nosniff, CORP, typed as HTML in UTF-8", () => {
    expect(emailFrameHeaders(NONCE)).toMatchObject({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": emailFrameCsp(NONCE) });
  });
  test("the app's own CSP: frames only from exactly the frame's path; script-src 'self' and the rest as they were", () => {
    const csp = appHtmlHeaders("https://inbox.example/")["Content-Security-Policy"]!;
    expect(csp).toBe(`${WEB_HTML_HEADERS["Content-Security-Policy"]}; frame-src https://inbox.example/email-frame/`);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe|frame-src[^;]*'self'|\*/);
    expect(appHtmlHeaders("https://inbox.example")["X-Frame-Options"]).toBe("DENY");
  });
});

describe("the frame's document", () => {
  test("the nonce appears once, before where the email goes, and never in the end", () => {
    expect(open.split(NONCE)).toHaveLength(2);
    expect(open.endsWith("</script>")).toBe(true);
    expect(emailFrameClose("end-mark-1")).not.toContain(NONCE);
    expect(emailFrameClose("end-mark-1")).not.toContain("<script");
  });
  test("one script, posting only to the app's origin, never with a wildcard", () => {
    expect(open.match(/<script/g)).toHaveLength(1);
    expect(open).toContain('w.parent.postMessage({jinboxEmail:T,type:"hello"},"https://inbox.example",[c.port2])');
    expect(open).not.toContain('"*"');
    // All else down its own channel, made before a byte of the email exists.
    expect(open).toContain("function send(m){m.jinboxEmail=T;post(m)}");
    expect(open.match(/postMessage/g)).toHaveLength(2);
  });
  test("no <base> of ours (in Chromium a base target lets a form out as a popup), and the page says it is light", () => {
    expect(open).not.toContain("<base");
    expect(open).toContain('<meta name="color-scheme" content="light">');
  });
  test("the script checks its end mark and the key's isTrusted", () => {
    expect(open).toContain('byId("end-mark-1")');
    expect(open).toContain("e.isTrusted");
  });
  test("a failure says its code, cleaned, and carries no marker", () => {
    const f = emailFrameFailure({ nonce: NONCE, code: 'TOO_LARGE"><img src=x>', appOrigin: "https://inbox.example" });
    expect(f).toContain('code:"TOO_LARGE"');
    expect(f).not.toContain("<img");
    expect(f.split(NONCE)).toHaveLength(2);
  });
  test("the app's origin is written as a string, so it cannot end the script", () => {
    expect(emailFrameOpen({ nonce: NONCE, endMark: "e", appOrigin: 'x"+alert(1)+"' })).toContain('"x\\"+alert(1)+\\""');
  });
});

describe("what the parent believes", () => {
  const T = "tok_123";
  const msg = (m: object, t = T) => ({ jinboxEmail: t, ...m });
  test("hello, and a place in the email, clamped", () => {
    expect(parseEmailFrameMessage(msg({ type: "hello" }), T)).toEqual({ type: "hello" });
    expect(parseEmailFrameMessage(msg({ type: "place", top: 120 }), T)).toEqual({ type: "place", top: 120 });
    expect(parseEmailFrameMessage(msg({ type: "place", top: 1e12 }), T)).toEqual({ type: "place", top: EMAIL_FRAME_MAX_HEIGHT });
    for (const top of [NaN, "1", null]) expect(parseEmailFrameMessage(msg({ type: "place", top }), T)).toBeNull();
  });
  test("the four messages", () => {
    expect(parseEmailFrameMessage(msg({ type: "ready" }), T)).toEqual({ type: "ready" });
    expect(parseEmailFrameMessage(msg({ type: "height", height: 412.2 }), T)).toEqual({ type: "height", height: 413 });
    expect(parseEmailFrameMessage(msg({ type: "fail", code: "NOT_FOUND" }), T)).toEqual({ type: "fail", code: "NOT_FOUND" });
    expect(parseEmailFrameMessage(msg({ type: "key", key: "j", code: "KeyJ", shiftKey: true }), T)).toEqual({ type: "key", init: { key: "j", code: "KeyJ", repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, bubbles: true, cancelable: true } });
  });
  test("a wrong or missing token is nothing, and no token is never a match", () => {
    expect(parseEmailFrameMessage(msg({ type: "ready" }, "other"), T)).toBeNull();
    expect(parseEmailFrameMessage({ type: "ready" }, T)).toBeNull();
    expect(parseEmailFrameMessage({ type: "ready", jinboxEmail: "" }, "")).toBeNull();
  });
  test("forged heights are clamped; not numbers are refused", () => {
    expect(parseEmailFrameMessage(msg({ type: "height", height: 1e12 }), T)).toEqual({ type: "height", height: EMAIL_FRAME_MAX_HEIGHT });
    expect(parseEmailFrameMessage(msg({ type: "height", height: -5 }), T)).toEqual({ type: "height", height: EMAIL_FRAME_MIN_HEIGHT });
    for (const height of [NaN, Infinity, "400", null, {}, undefined]) expect(parseEmailFrameMessage(msg({ type: "height", height }), T)).toBeNull();
  });
  test("other shapes are nothing: unknown types, not objects, long strings, smuggled fields are not kept", () => {
    for (const bad of [null, undefined, 1, "ready", [], msg({ type: "navigate", url: "https://evil.example" }), msg({ type: "key", key: "j".repeat(33), code: "KeyJ" }), msg({ type: "key", key: 1, code: "KeyJ" }), msg({ type: "fail", code: "x".repeat(33) })]) expect(parseEmailFrameMessage(bad, T)).toBeNull();
    expect(parseEmailFrameMessage(msg({ type: "ready", url: "https://evil.example", __proto__: { x: 1 } }), T)).toEqual({ type: "ready" });
    const k = parseEmailFrameMessage(msg({ type: "key", key: "e", code: "KeyE", metaKey: "yes", target: "x", view: "y" }), T) as unknown as { init: Record<string, unknown> };
    expect(k.init.metaKey).toBe(false);
    expect(Object.keys(k.init)).not.toContain("target");
  });
});

describe("the ticket and the action", () => {
  test("a ticket is 43 URL-safe characters; its URL names nothing else", () => {
    expect(isEmailFrameTicket(TICKET)).toBe(true);
    for (const bad of ["", "a", TICKET + "A", "../" + TICKET.slice(3), "A".repeat(42) + "/", 1, null]) expect(isEmailFrameTicket(bad)).toBe(false);
    expect(emailFramePath(TICKET)).toBe(EMAIL_FRAME_PATH + TICKET);
    expect(emailFrameTicketOf(emailFramePath(TICKET))).toBe(TICKET);
    for (const bad of ["/email-frame/", "/email-frame/x", `/email-frame/${TICKET}/x`, `/other/${TICKET}`]) expect(emailFrameTicketOf(bad)).toBeNull();
  });
  test("request and answer are strict", () => {
    expect(parse(emailFrameRequest, { chatID: "gmail:a@b.co:1", messageID: "1" }).ok).toBe(true);
    for (const bad of [{}, { chatID: "x" }, { chatID: "x", messageID: "y", url: "z" }]) expect(parse(emailFrameRequest, bad).ok).toBe(false);
    expect(parse(emailFrameTicket, { ticket: TICKET, expiresAt: "2026-11-04T10:00:00Z" }).ok).toBe(true);
    expect(parse(emailFrameTicket, { ticket: "x", expiresAt: "2026-11-04T10:00:00Z" }).ok).toBe(false);
  });
  test("get_email_html: owner only, cloud only, a read, streamed; no agent way to it; its own capability", () => {
    const a = ACTIONS.get_email_html as unknown as { humanOnly: boolean; cloudOnly: boolean; write: boolean; streamed: boolean; needsApprovalForAgents: boolean };
    expect([a.humanOnly, a.cloudOnly, a.write, a.streamed, a.needsApprovalForAgents]).toEqual([true, true, false, true, false]);
    expect(isAgentActionName("get_email_html")).toBe(false);
    expect(JSON.stringify(buildRaftManifest({ origin: "https://inbox.example", service: "j-inbox" }))).not.toContain("get_email_html");
    expect(CAPABILITIES.emailHtml).toBe("email-html.v1");
    expect(API_ROUTES.emailFrame).toEqual({ method: "POST", path: "/api/email/frame" });
  });
  test("the frame's path is on the human surface", () => {
    expect(surfaceForPath(emailFramePath(TICKET))).toBe("web");
  });
});
