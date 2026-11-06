// Bridges, login flows and login sessions of the fake Beeper (GET /v1/bridges, GET
// /v1/bridges/{bridgeID}/login-flows, POST/GET/DELETE .../login-sessions, POST .../steps/{stepID}).
// Shapes follow vendor/beeper-client-api-spec.json (Bridge, LoginFlow, LoginSession, LoginStep).
// Where the spec is silent the fake makes a choice, noted here:
//   - A display step (QR code, code for the phone) moves on when the phone acts (`scan()` in tests).
//     POST .../steps/{stepID} {type: display_and_wait} holds until the session changes (or
//     `controls.loginWaitMs`), then answers the session, as mautrix's wait call does; GET answers at once.
//   - A wrong code or password: the step answers 200 with the same user_input step again and an
//     `error` {code, message}; the session goes on (a retry).
//   - A second session on a bridge that has one running answers 409 (a half-done sign-in blocks the next).
//   - A session expires after `controls.loginTTLMs`; Beeper then no longer knows it (404).
//   - Cancelled: DELETE answers {bridgeID, loginSessionID, status: "cancelled"}; GET keeps answering it as cancelled.
// The QR data, codes and cookies here are made-up markers, so tests can check none of them is ever logged.
import type { BAccount } from "./fixtures.ts";

type Provider = "cloud" | "self-hosted" | "local" | "platform-sdk";
export type BBridge = { id: string; type: string; provider: Provider; displayName: string; network: string; status: "available" | "connected" | "limit_reached" | "temporarily_unavailable" | "disabled"; supportsMultipleAccounts: boolean };
export type BLoginFlow = { id: string; name: string; description?: string };

/** Each network has a cloud bridge and usually an on-device ("local-") one, as Beeper Desktop 4.3 has them. */
export const BRIDGES: BBridge[] = [
  { id: "matrix", type: "matrix", provider: "platform-sdk", displayName: "Beeper", network: "Beeper", status: "connected", supportsMultipleAccounts: false },
  { id: "local-whatsapp", type: "whatsapp", provider: "local", displayName: "WhatsApp", network: "WhatsApp", status: "connected", supportsMultipleAccounts: true },
  { id: "whatsapp", type: "whatsapp", provider: "cloud", displayName: "WhatsApp", network: "WhatsApp", status: "available", supportsMultipleAccounts: false },
  { id: "local-telegram", type: "telegram", provider: "local", displayName: "Telegram", network: "Telegram", status: "available", supportsMultipleAccounts: true },
  { id: "telegram", type: "telegram", provider: "cloud", displayName: "Telegram", network: "Telegram", status: "available", supportsMultipleAccounts: false },
  { id: "local-signal", type: "signal", provider: "local", displayName: "Signal", network: "Signal", status: "available", supportsMultipleAccounts: true },
  { id: "signal", type: "signal", provider: "cloud", displayName: "Signal", network: "Signal", status: "available", supportsMultipleAccounts: false },
  { id: "local-discord", type: "discordgo", provider: "local", displayName: "Discord", network: "Discord", status: "available", supportsMultipleAccounts: true },
  { id: "discordgo", type: "discordgo", provider: "cloud", displayName: "Discord", network: "Discord", status: "connected", supportsMultipleAccounts: false },
  { id: "local-slack", type: "slackgo", provider: "local", displayName: "Slack", network: "Slack", status: "available", supportsMultipleAccounts: true },
  { id: "slackgo", type: "slackgo", provider: "cloud", displayName: "Slack", network: "Slack", status: "available", supportsMultipleAccounts: true },
  { id: "local-facebook", type: "meta", provider: "local", displayName: "Messenger", network: "Facebook", status: "available", supportsMultipleAccounts: true },
  { id: "facebookgo", type: "facebookgo", provider: "cloud", displayName: "Messenger", network: "Facebook", status: "available", supportsMultipleAccounts: false },
  { id: "local-instagram", type: "meta", provider: "local", displayName: "Instagram", network: "Instagram", status: "available", supportsMultipleAccounts: true },
  { id: "instagramgo", type: "instagramgo", provider: "cloud", displayName: "Instagram", network: "Instagram", status: "connected", supportsMultipleAccounts: false },
  { id: "linkedin", type: "linkedin", provider: "cloud", displayName: "LinkedIn", network: "LinkedIn", status: "connected", supportsMultipleAccounts: false },
  { id: "local-linkedin", type: "linkedin", provider: "local", displayName: "LinkedIn", network: "LinkedIn", status: "available", supportsMultipleAccounts: true },
  { id: "local-twitter", type: "twitter", provider: "local", displayName: "X", network: "Twitter", status: "connected", supportsMultipleAccounts: true },
  { id: "twitter", type: "twitter", provider: "cloud", displayName: "X", network: "Twitter", status: "available", supportsMultipleAccounts: false },
  { id: "imessage", type: "imessage", provider: "local", displayName: "iMessage", network: "iMessage", status: "connected", supportsMultipleAccounts: false },
  { id: "local-gmessages", type: "gmessages", provider: "local", displayName: "Google Messages", network: "Google Messages", status: "available", supportsMultipleAccounts: true },
  { id: "local-gvoice", type: "gvoice", provider: "local", displayName: "Google Voice", network: "Google Voice", status: "available", supportsMultipleAccounts: true },
  { id: "googlechat", type: "googlechat", provider: "cloud", displayName: "Google Chat", network: "Google Chat", status: "available", supportsMultipleAccounts: false },
  { id: "line", type: "line", provider: "cloud", displayName: "LINE", network: "LINE", status: "available", supportsMultipleAccounts: false },
  { id: "local-bluesky", type: "bluesky", provider: "local", displayName: "Bluesky", network: "Bluesky", status: "available", supportsMultipleAccounts: true },
];

/** Flows by bridge id, as measured on Beeper Desktop 4.3 (2026-11); cloud bridges offer the same as their local twin here. */
export const LOGIN_FLOWS: Record<string, BLoginFlow[]> = {
  "local-whatsapp": [
    { id: "qr", name: "QR code", description: "Scan a QR code with the WhatsApp app" },
    { id: "phone", name: "Pairing code", description: "Type a code into the WhatsApp app" },
  ],
  "local-telegram": [
    { id: "phone", name: "Phone number" },
    { id: "qr", name: "QR code" },
    { id: "bot", name: "Bot token" },
    { id: "manual", name: "Manual" },
  ],
  "local-signal": [{ id: "qr", name: "QR code" }],
  "local-discord": [
    { id: "token", name: "Token" },
    { id: "qr", name: "QR code" },
    { id: "DEBUG_USERINPUT_token", name: "Token (debug)" },
  ],
  "local-slack": [
    { id: "email", name: "Email" },
    { id: "token", name: "Token" },
    { id: "app", name: "Slack app" },
  ],
  line: [{ id: "email", name: "Email login" }],
  "local-facebook": [
    { id: "messenger-lite-android", name: "Messenger Lite" },
    { id: "facebook", name: "Facebook" },
    { id: "messenger", name: "Messenger" },
  ],
  "local-gmessages": [{ id: "google", name: "Google account" }],
  googlechat: [{ id: "browser", name: "Browser" }],
  "local-gvoice": [{ id: "cookies", name: "Cookies" }],
  "local-instagram": [{ id: "instagram", name: "Instagram" }],
  "local-linkedin": [{ id: "cookies", name: "Cookies" }],
  linkedin: [{ id: "cookies", name: "Cookies" }],
  "local-twitter": [{ id: "cookies", name: "Cookies" }],
  twitter: [{ id: "cookies", name: "Cookies" }],
};
for (const [cloud, local] of [["whatsapp", "local-whatsapp"], ["telegram", "local-telegram"], ["signal", "local-signal"], ["discordgo", "local-discord"], ["slackgo", "local-slack"], ["facebookgo", "local-facebook"], ["instagramgo", "local-instagram"]] as const) LOGIN_FLOWS[cloud] = LOGIN_FLOWS[local]!;

/** What the fake's sign-ins accept. */
export const LOGIN_SECRETS = { telegramCode: "24680", slackCode: "135790", messengerPassword: "fake-password-ok", whatsappPairing: "FAKE-PAIR", cookieValue: "fake-cookie-value" } as const;

type Field = { id: string; label?: string; type?: string; placeholder?: string; optional?: boolean; initialValue?: string };
type Step =
  | { type: "user_input"; stepID: string; fields: Field[]; instructions?: string }
  | { type: "display_and_wait"; stepID: string; display: { type: "qr" | "code"; data: string } | { type: "nothing" }; instructions?: string }
  | { type: "cookies"; stepID: string; url: string; fields: { id: string; name: string; type: "cookie" | "header" | "local_storage" }[]; expectedFinalURLRegex?: string; userAgent?: string; extractJS?: string; instructions?: string };

export type BLoginSession = {
  bridgeID: string;
  loginSessionID: string;
  flowID: string;
  status: "waiting_for_input" | "waiting_for_cookies" | "waiting_for_display" | "complete" | "cancelled" | "failed";
  /** Script position: what comes after the current step. */
  stage: string;
  step: Step | null;
  error?: { code: string; message: string };
  accountID?: string;
  loginID?: string;
  createdAt: number;
  expiresAt: number;
  qrRound: number;
  /** Values the owner sent earlier in the flow (the fake's own memory, like the real bridge's). */
  memo: Record<string, string>;
  account?: BAccount;
};

const ACTIVE = new Set(["waiting_for_input", "waiting_for_cookies", "waiting_for_display"]);

function mask(email: string): string {
  const [user, host] = email.split("@");
  return user && host ? `${user[0]}***@${host}` : "your email";
}

export class FakeLogins {
  sessions = new Map<string, BLoginSession>();
  private n = 0;
  private waiters = new Set<() => void>();

  constructor(
    private readonly accounts: () => BAccount[],
    private readonly setAccounts: (a: BAccount[]) => void,
    private readonly now: () => number,
    private readonly base: () => string,
  ) {}

  bridges(): (BBridge & { accounts: BAccount[]; activeAccountCount: number })[] {
    return BRIDGES.map((b) => {
      const accounts = this.accounts().filter((a) => a.bridge?.id === b.id);
      const status = b.status === "available" && accounts.length ? "connected" : b.status;
      return { ...b, status, accounts: structuredClone(accounts), activeAccountCount: accounts.length };
    });
  }

  bridge(id: string) {
    return this.bridges().find((b) => b.id === id) ?? null;
  }

  private changed() {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  /** Resolves when any session changes, or after `ms`. */
  waitChange(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** A session as GET returns it, or null when Beeper no longer knows it (expired). */
  get(id: string): BLoginSession | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (ACTIVE.has(s.status) && this.now() > s.expiresAt) {
      this.sessions.delete(id);
      this.changed();
      return null;
    }
    return s;
  }

  create(bridgeID: string, body: { flowID?: string; accountID?: string; loginID?: string }, ttlMs: number): { session: BLoginSession } | { status: number; code: string; message: string } {
    const bridge = this.bridge(bridgeID);
    if (!bridge) return { status: 404, code: "NOT_FOUND", message: "Bridge not found" };
    const flows = LOGIN_FLOWS[bridgeID] ?? [];
    if (body.flowID !== undefined && !flows.some((f) => f.id === body.flowID)) return { status: 400, code: "VALIDATION_ERROR", message: "Unknown flowID" };
    const flowID = body.flowID ?? flows[0]?.id;
    if (!flowID) return { status: 422, code: "UNPROCESSABLE", message: "This bridge has no login flow" };
    if (body.accountID !== undefined && !bridge.accounts.some((a) => a.accountID === body.accountID)) return { status: 404, code: "NOT_FOUND", message: "Account not found" };
    if (body.accountID === undefined && body.loginID === undefined && (bridge.status === "limit_reached" || (bridge.accounts.length > 0 && !bridge.supportsMultipleAccounts))) return { status: 409, code: "CONFLICT", message: "Account limit reached" };
    for (const s of this.sessions.values()) if (s.bridgeID === bridgeID && ACTIVE.has(s.status) && this.now() <= s.expiresAt) return { status: 409, code: "CONFLICT", message: "A login session is already in progress for this bridge" };
    const t = this.now();
    const s: BLoginSession = { bridgeID, loginSessionID: `ls_${++this.n}_${bridgeID}`, flowID, status: "waiting_for_input", stage: "start", step: null, createdAt: t, expiresAt: t + ttlMs, qrRound: 0, memo: {}, ...(body.accountID ? { accountID: body.accountID } : {}), ...(body.loginID ? { loginID: body.loginID } : {}) };
    this.enter(s, this.firstStage(bridge.type, bridgeID, flowID));
    this.sessions.set(s.loginSessionID, s);
    this.changed();
    return { session: s };
  }

  private firstStage(type: string, bridgeID: string, flowID: string): string {
    if (flowID === "qr") return "qr";
    if (bridgeID.endsWith("whatsapp") && flowID === "phone") return "wa-phone";
    if (bridgeID.endsWith("telegram") && flowID === "phone") return "tg-phone";
    if (type === "slackgo" && flowID === "email") return "slack-email";
    if (flowID === "messenger-lite-android") return "messenger-password";
    if (flowID === "token" || flowID === "DEBUG_USERINPUT_token" || flowID === "bot") return "token";
    return "cookies";
  }

  /** Enter a script stage: its step and status. */
  private enter(s: BLoginSession, stage: string) {
    s.stage = stage;
    s.error = undefined;
    const id = (x: string) => `fi.mau.${s.bridgeID.replace(/^local-/, "")}.${x}`;
    switch (stage) {
      case "qr":
        s.status = "waiting_for_display";
        s.step = { type: "display_and_wait", stepID: id("qr"), display: { type: "qr", data: `fake-qr-secret:${s.loginSessionID}:${s.qrRound}` }, instructions: "Scan the QR code with your phone" };
        return;
      case "wa-phone":
        s.status = "waiting_for_input";
        s.step = { type: "user_input", stepID: id("phone"), fields: [{ id: "phone_number", label: "Phone number", type: "phone_number", placeholder: "+1 555 0100" }], instructions: "Enter your phone number" };
        return;
      case "wa-code":
        s.status = "waiting_for_display";
        s.step = { type: "display_and_wait", stepID: id("code"), display: { type: "code", data: LOGIN_SECRETS.whatsappPairing }, instructions: "Enter this code in WhatsApp on your phone" };
        return;
      case "tg-phone":
        s.status = "waiting_for_input";
        s.step = { type: "user_input", stepID: id("phone"), fields: [{ id: "phone_number", label: "Phone number", type: "phone_number" }] };
        return;
      case "tg-code":
        s.status = "waiting_for_input";
        s.step = { type: "user_input", stepID: id("code"), fields: [{ id: "code", label: "Code", type: "2fa_code" }], instructions: "Enter the code Telegram sent you" };
        return;
      case "slack-email":
        s.status = "waiting_for_input";
        s.step = { type: "user_input", stepID: id("email"), fields: [{ id: "email", label: "Email", type: "email" }] };
        return;
      case "slack-code":
        s.status = "waiting_for_input";
        s.step = { type: "user_input", stepID: id("code"), fields: [{ id: "code", label: "6-digit code", type: "2fa_code" }], instructions: `Enter the code Slack sent to ${mask(s.memo.email ?? "")}` };
        return;
      case "messenger-password":
        s.status = "waiting_for_input";
        s.step = { type: "user_input", stepID: id("password"), fields: [{ id: "username", label: "Email or phone", type: "username" }, { id: "password", label: "Password", type: "password" }] };
        return;
      case "token":
        s.status = "waiting_for_input";
        s.step = { type: "user_input", stepID: id("token"), fields: [{ id: "token", label: "Token", type: "token" }] };
        return;
      case "cookies": {
        s.status = "waiting_for_cookies";
        const site = s.bridgeID.replace(/^local-/, "").replace(/go$/, "");
        s.step = {
          type: "cookies",
          stepID: id("cookies"),
          url: `${this.base()}/fake-login/${site}`,
          fields: [
            { id: "sessionid", name: "sessionid", type: "cookie" },
            { id: "csrftoken", name: "csrftoken", type: "cookie" },
          ],
          expectedFinalURLRegex: `^${this.base().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/fake-login/${site}/home`,
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) FakeBeeper",
          extractJS: "(async () => ({}))()",
        };
        return;
      }
    }
  }

  private complete(s: BLoginSession) {
    s.status = "complete";
    s.step = null;
    const bridge = this.bridge(s.bridgeID)!;
    if (s.accountID) {
      this.setAccounts(this.accounts().map((a) => (a.accountID === s.accountID ? { ...a, status: "connected" } : a)));
      s.account = this.accounts().find((a) => a.accountID === s.accountID);
    } else {
      const n = this.n + 100;
      const acc: BAccount = {
        accountID: `${s.bridgeID}_ba_FAKEnew${n}`,
        loginID: `ba_FAKEnew${n}`,
        bridge: { id: bridge.id, type: bridge.type, provider: bridge.provider },
        network: bridge.network,
        user: { id: `new${n}`, fullName: `New ${bridge.displayName} Account`, ...(s.memo.phone ? { phoneNumber: s.memo.phone } : {}), isSelf: true },
        status: "connected",
      };
      this.setAccounts([...this.accounts(), acc]);
      s.account = acc;
    }
    this.changed();
  }

  /** POST .../steps/{stepID}. */
  submit(s: BLoginSession, stepID: string, body: { type?: unknown; fields?: unknown; lastURL?: unknown; source?: unknown }): { ok: true } | { status: number; code: string; message: string } {
    if (!ACTIVE.has(s.status) || !s.step) return { status: 409, code: "CONFLICT", message: "The login session is not waiting for a step" };
    if (s.step.stepID !== stepID) return { status: 409, code: "CONFLICT", message: "Not the current step" };
    if (body.type !== s.step.type) return { status: 400, code: "VALIDATION_ERROR", message: `This step takes type ${s.step.type}` };
    const fields = body.fields === undefined ? {} : body.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.values(fields).every((v) => typeof v === "string")) return { status: 400, code: "VALIDATION_ERROR", message: "fields must map ids to strings" };
    const f = fields as Record<string, string>;
    if (s.step.type === "display_and_wait") return { ok: true };
    for (const field of s.step.fields) if (!(field as { optional?: boolean }).optional && !f[field.id]) return { status: 400, code: "VALIDATION_ERROR", message: `Missing field ${field.id}` };
    const wrong = (message: string) => {
      s.error = { code: "FI.MAU.LOGIN_INVALID", message };
      this.changed();
      return { ok: true } as const;
    };
    switch (s.stage) {
      case "wa-phone":
        s.memo.phone = f.phone_number!;
        this.enter(s, "wa-code");
        break;
      case "tg-phone":
        s.memo.phone = f.phone_number!;
        this.enter(s, "tg-code");
        break;
      case "tg-code":
        if (f.code !== LOGIN_SECRETS.telegramCode) return wrong("Invalid code");
        this.complete(s);
        break;
      case "slack-email":
        s.memo.email = f.email!;
        this.enter(s, "slack-code");
        break;
      case "slack-code":
        if (f.code !== LOGIN_SECRETS.slackCode) return wrong("Invalid code");
        this.complete(s);
        break;
      case "messenger-password":
        if (f.password !== LOGIN_SECRETS.messengerPassword) return wrong("Wrong password");
        this.complete(s);
        break;
      case "token":
        this.complete(s);
        break;
      case "cookies":
        if (Object.values(f).some((v) => v !== LOGIN_SECRETS.cookieValue)) {
          s.status = "failed";
          s.step = null;
          s.error = { code: "FI.MAU.LOGIN_FAILED", message: "The cookies were not accepted" };
          break;
        }
        this.complete(s);
        break;
    }
    this.changed();
    return { ok: true };
  }

  cancel(s: BLoginSession) {
    if (ACTIVE.has(s.status)) {
      s.status = "cancelled";
      s.step = null;
    }
    this.changed();
  }

  /** Tests: the phone scanned the QR code, or typed the pairing code. */
  scan(id?: string): boolean {
    const s = this.pick(id, (x) => x.status === "waiting_for_display");
    if (!s) return false;
    this.complete(s);
    return true;
  }

  /** Tests: the QR code is replaced by a new one, as WhatsApp does every 20 s or so. */
  rotate(id?: string): boolean {
    const s = this.pick(id, (x) => x.stage === "qr" && x.status === "waiting_for_display");
    if (!s) return false;
    s.qrRound++;
    this.enter(s, "qr");
    this.changed();
    return true;
  }

  /** Tests: the network refused the sign-in. */
  fail(id?: string): boolean {
    const s = this.pick(id, (x) => ACTIVE.has(x.status));
    if (!s) return false;
    s.status = "failed";
    s.step = null;
    s.error = { code: "FI.MAU.LOGIN_FAILED", message: "Login failed" };
    this.changed();
    return true;
  }

  /** Tests: the session runs out now. */
  expire(id?: string): boolean {
    const s = this.pick(id, (x) => ACTIVE.has(x.status));
    if (!s) return false;
    s.expiresAt = this.now() - 1;
    this.changed();
    return true;
  }

  private pick(id: string | undefined, ok: (s: BLoginSession) => boolean): BLoginSession | undefined {
    if (id) {
      const s = this.sessions.get(id);
      return s && ok(s) ? s : undefined;
    }
    return [...this.sessions.values()].reverse().find(ok);
  }

  /** The LoginSession body (spec schema). */
  view(s: BLoginSession) {
    const out: Record<string, unknown> = { bridgeID: s.bridgeID, loginSessionID: s.loginSessionID, status: s.status };
    if (s.step) out.currentStep = structuredClone(s.step);
    if (s.status === "complete") out.currentStep = { type: "complete", ...(s.account ? { account: structuredClone(s.account) } : {}), instructions: "Connected" };
    if (s.account) out.account = structuredClone(s.account);
    if (s.accountID) out.accountID = s.accountID;
    if (s.loginID) out.loginID = s.loginID;
    if (s.error) out.error = { ...s.error };
    return out;
  }
}

/** The fake website a cookies step opens: sets the two cookies, then goes to its "home" (the final URL). */
export function fakeLoginPage(url: URL): Response | null {
  const m = /^\/fake-login\/([a-z]+)(\/home)?$/.exec(url.pathname);
  if (!m) return null;
  if (m[2]) return new Response(`<!doctype html><title>${m[1]} home</title><p>Signed in.</p>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  // ?slow=1: a page a person would see for a moment (the cookies come with it), then its home.
  const slow = url.searchParams.get("slow") === "1";
  const headers = new Headers(slow ? { "content-type": "text/html; charset=utf-8" } : { location: `/fake-login/${m[1]}/home` });
  headers.append("set-cookie", `sessionid=${LOGIN_SECRETS.cookieValue}; Path=/; HttpOnly`);
  headers.append("set-cookie", `csrftoken=${LOGIN_SECRETS.cookieValue}; Path=/`);
  if (slow) return new Response(`<!doctype html><meta http-equiv="refresh" content="2;url=/fake-login/${m[1]}/home"><title>Sign in</title><p>Signing in to ${m[1]}...</p>`, { headers });
  return new Response(null, { status: 302, headers });
}
