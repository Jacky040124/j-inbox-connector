import { describe, expect, test } from "bun:test";
import {
  ACTIONS,
  AGENT_CATALOGUE_ACTIONS,
  CAPABILITIES,
  CHAT_APP_FLOWS,
  CHAT_APP_KEYS,
  CHAT_APP_NAMES,
  CONNECTABLE_CHAT_APPS,
  buildRaftManifest,
  chatApp,
  chatAppOf,
  chatLoginState,
  isAgentActionName,
  isBeeperOwnAccount,
  parse,
  parseActionParams,
  parseActionResult,
  pickFlow,
} from "../src/index.ts";

const SID = "cl_0123456789abcdef";
const NAMES = ["chat_apps", "chat_login_start", "chat_login_poll", "chat_login_submit", "chat_login_cancel"] as const;

describe("chat login actions", () => {
  test("owner only: never for agents, never in the manifest, never one an approval could open", () => {
    for (const n of NAMES) {
      expect(ACTIONS[n].humanOnly).toBe(true);
      expect(ACTIONS[n].needsApprovalForAgents).toBe(false);
      expect(isAgentActionName(n)).toBe(false);
      expect(AGENT_CATALOGUE_ACTIONS as readonly string[]).not.toContain(n);
    }
    const manifest = JSON.stringify(buildRaftManifest({ origin: "https://inbox.example.test", service: "j-inbox" }));
    for (const n of NAMES) expect(manifest).not.toContain(n);
  });

  test("a capability of its own, so an older connector is never asked", () => {
    expect(CAPABILITIES.chatLogin).toBe("chat-login.v1");
  });

  test("exactly the ten apps, in the page's order, and iMessage is never connected from the page", () => {
    expect([...CHAT_APP_KEYS]).toEqual(["whatsapp", "telegram", "instagram", "messenger", "linkedin", "x", "discord", "slack", "signal", "imessage"]);
    expect(CHAT_APP_KEYS.map((k) => CHAT_APP_NAMES[k])).toEqual(["WhatsApp", "Telegram", "Instagram", "Messenger", "LinkedIn", "X", "Discord", "Slack", "Signal", "iMessage"]);
    expect(CONNECTABLE_CHAT_APPS as string[]).not.toContain("imessage");
    expect(parseActionParams("chat_login_start", { app: "imessage" }).ok).toBe(false);
  });

  test("bridges map to apps by id and type, never by display name; Beeper's own and other networks map to nothing", () => {
    expect(chatAppOf({ id: "local-whatsapp", type: "whatsapp" })).toBe("whatsapp");
    expect(chatAppOf({ id: "local-facebook", type: "meta" })).toBe("messenger");
    expect(chatAppOf({ id: "local-instagram", type: "meta" })).toBe("instagram");
    expect(chatAppOf({ id: "instagramgo", type: "instagramgo" })).toBe("instagram");
    expect(chatAppOf({ id: "discordgo", type: "discordgo" })).toBe("discord");
    expect(chatAppOf({ id: "slackgo.T1-U1", type: "slackgo" })).toBe("slack");
    expect(chatAppOf({ id: "local-twitter", type: "twitter" })).toBe("x");
    expect(chatAppOf({ id: "matrix", type: "matrix" })).toBeNull();
    expect(chatAppOf({ id: "local-gvoice", type: "gvoice" })).toBeNull();
    expect(chatAppOf({ id: "line", type: "line" })).toBeNull();
    // A display name is never a key.
    expect(chatAppOf({ id: "weird", type: "weird", displayName: "WhatsApp" } as never)).toBeNull();
    expect(isBeeperOwnAccount({ accountID: "matrix" })).toBe(true);
    expect(isBeeperOwnAccount({ accountID: "abc", bridge: { id: "matrix", type: "matrix" } })).toBe(true);
    expect(isBeeperOwnAccount({ accountID: "abc", bridge: { id: "hungry", type: "MATRIX" } })).toBe(true);
    expect(isBeeperOwnAccount({ accountID: "local-whatsapp_ba_1", bridge: { id: "local-whatsapp", type: "whatsapp" } })).toBe(false);
  });

  test("flows: QR on a computer, codes on a phone, and none where a phone cannot", () => {
    const offered = [{ id: "qr" }, { id: "phone" }];
    expect(pickFlow(CHAT_APP_FLOWS.whatsapp.computer, offered)).toBe("qr");
    expect(pickFlow(CHAT_APP_FLOWS.whatsapp.phone as string[], offered)).toBe("phone");
    expect(CHAT_APP_FLOWS.signal.phone).toBe("computer");
    expect(CHAT_APP_FLOWS.discord.phone).toBe("computer");
    expect(CHAT_APP_FLOWS.instagram.phone).toBe("mac");
    expect(pickFlow(["messenger-lite-android"], [{ id: "facebook" }])).toBeUndefined();
  });

  test("a step is a display, a form or a website sign-in on the Mac; a website's cookies never have a shape here", () => {
    const ok = (v: unknown) => parse(chatLoginState, { sessionID: SID, app: "whatsapp", ...(v as object) }).ok;
    expect(ok({ status: "waiting", step: { kind: "display", stepID: "x", show: "qr", data: "tg://login?token=abc" } })).toBe(true);
    expect(ok({ status: "waiting", step: { kind: "display", stepID: "x", show: "code", data: "ABCD-EFGH" } })).toBe(true);
    expect(ok({ status: "waiting", step: { kind: "display", stepID: "x", show: "emoji", image: "iVBORw0KGgo=", imageType: "image/png" } })).toBe(true);
    expect(ok({ status: "waiting", step: { kind: "display", stepID: "x", show: "emoji", image: "<svg>", imageType: "image/png" } })).toBe(false);
    expect(ok({ status: "input", step: { kind: "form", stepID: "x", fields: [] } })).toBe(false);
    expect(ok({ status: "input", step: { kind: "form", stepID: "x", fields: [{ id: "p", label: "Password", kind: "password" }] } })).toBe(true);
    expect(ok({ status: "waiting", step: { kind: "browser", stepID: "x", site: "www.instagram.com", window: "open" } })).toBe(true);
    // Nothing else rides along: no URL, script or cookie, no typed value, none of Beeper's ids.
    expect(ok({ status: "waiting", step: { kind: "browser", stepID: "x", site: "https://www.instagram.com/accounts/login", window: "open" } })).toBe(false);
    expect(ok({ status: "waiting", step: { kind: "browser", stepID: "x", site: "a.test", window: "open", extractJS: "x" } })).toBe(false);
    expect(ok({ status: "waiting", step: { kind: "cookies", stepID: "x", url: "https://example.test" } })).toBe(false);
    expect(ok({ status: "input", step: { kind: "form", stepID: "x", fields: [{ id: "p", label: "P", kind: "text", value: "typed" }] } })).toBe(false);
    expect(ok({ status: "done", loginSessionID: "123" })).toBe(false);
    expect(ok({ status: "done", account: { name: "Someone", accountID: "x" } })).toBe(false);
    expect(ok({ status: "failed", problem: "window-closed" })).toBe(true);
    expect(ok({ status: "failed", message: "free text from Beeper" })).toBe(false);
  });

  test("an app row carries accounts by id, never Beeper's bridge ids or login ids", () => {
    const base = { app: "whatsapp", state: "available", onDevice: true, flows: [], accounts: [] };
    expect(parse(chatApp, base).ok).toBe(true);
    expect(parse(chatApp, { ...base, app: "beeper" }).ok).toBe(false);
    expect(parse(chatApp, { ...base, bridgeID: "local-whatsapp" }).ok).toBe(false);
    expect(parse(chatApp, { ...base, accounts: [{ accountID: "a", status: "connected", needsReconnect: false, removable: true, loginID: "l" }] }).ok).toBe(false);
  });

  test("what the owner types is checked by shape only, and an invalid value is never repeated in the answer", () => {
    const secret = "123456-not-in-errors";
    const r = parseActionParams("chat_login_submit", { sessionID: SID, stepID: "s", fields: { code: secret, ["x".repeat(200)]: secret } });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(secret);
    const r2 = parseActionParams("chat_login_submit", { sessionID: SID, stepID: "s", fields: { code: 5 } });
    expect(r2.ok).toBe(false);
    expect(parseActionResult("chat_login_cancel", { sessionID: SID, cancelled: true }).ok).toBe(true);
  });
});
