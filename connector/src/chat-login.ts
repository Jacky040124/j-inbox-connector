// Connecting chat apps from the owner's page (Settings > Chats), through Beeper's own sign-in:
// GET /v1/bridges (which bridges, their accounts), GET .../login-flows, and a login session
// (POST .../login-sessions, GET it, POST .../steps/{stepID}, DELETE it). Only J-Inbox's chat apps
// (protocol CHAT_APPS); Beeper's own account and every other network are never offered.
//
// What the owner types and a website's cookies pass through here to Beeper and nowhere else: they
// are never written to a file, never logged, and never sent back to the page. A QR code's data goes
// to the page (it has to be shown) and nowhere else. One sign-in at a time; one that nobody asks
// about for a minute (the page went away; five while the person is in the phone app) or that runs
// too long is cancelled on Beeper, and a sign-in window on the Mac closes with it. A cancel Beeper
// did not confirm is tried again, and a session whose start answered too late is cancelled when it
// does answer: nothing half-done is left to block the next attempt.
import {
  CHAT_APP_KEYS,
  CHAT_LOGIN_AWAY_MS,
  CHAT_LOGIN_IDLE_MS,
  CHAT_LOGIN_MAX_MS,
  CHAT_APP_NAMES,
  ACCOUNT_STATUSES,
  chatAppOf,
  isBeeperOwnAccount,
  makeError,
  parseActionResult,
  sanitizeLine,
  sanitizeText,
  type ActionParams,
  type ActionResult,
  type ChatApp,
  type ChatAppAccount,
  type ChatAppKey,
  type ChatLoginField,
  type ChatLoginState,
  type ChatLoginStep,
  type ConnectableChatApp,
  type ErrorBody,
} from "@j-inbox/protocol";
import type { BeeperCall, BeeperClient } from "./beeper-client.ts";
import { mapAccount } from "./beeper-map.ts";
import type { Outcome, RequestContext } from "./actions.ts";

type Raw = Record<string, any>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const enc = encodeURIComponent;
const err = (code: ErrorBody["code"], message: string): Outcome<never> => ({ ok: false, error: makeError(code, message) });

/** What a website sign-in step asks the sign-in window to collect (Beeper's cookies step, as is). */
export type SigninRequest = {
  /** The window's title: "J-Inbox: sign in to Instagram". */
  title: string;
  url: string;
  userAgent?: string;
  expectedFinalURLRegex?: string;
  fields: { id: string; name: string; type: "cookie" | "header" | "local_storage" }[];
  /** Beeper's helper script, opaque: run in the page as Beeper's docs say, never read here. */
  extractJS?: string;
};
/** What the window answers: the collected values (secrets: straight to Beeper), or that it was closed or failed. */
export type SigninResult = { fields: Record<string, string>; lastURL?: string } | { closed: true } | { failed: true };
export type SigninWindow = { readonly result: Promise<SigninResult>; close(): void };
/** The Mac's sign-in windows (signin-window.ts; a fake in tests). */
export type SigninWindows = { available(): boolean; open(r: SigninRequest): SigninWindow | null };

export type ChatLoginOptions = {
  client: BeeperClient;
  windows?: SigninWindows | null;
  now?: () => number;
  idleMs?: number;
  /** The idle limit while the step is in the phone app (a QR code, a code shown or sent). */
  awayMs?: number;
  maxMs?: number;
  /** How long Beeper may take to start a session (its own deadline, not the request's). */
  createTimeoutMs?: number;
  /** Waits before a cancel Beeper did not confirm is tried again. */
  cancelRetryMs?: number[];
  /** How long one background "wait for the phone" call may take (display steps). */
  waitTimeoutMs?: number;
  /** Ids for sessions (tests). */
  newID?: () => string;
};

type Session = {
  id: string;
  app: ConnectableChatApp;
  bridgeID: string;
  beeperID: string;
  /** Beeper's latest LoginSession body. */
  latest: Raw;
  startedAt: number;
  askedAt: number;
  macWindow: boolean;
  /** The ending, once over (Beeper said so, or this side ended it). */
  over: Pick<ChatLoginState, "status" | "problem" | "account"> | null;
  /** When it ended (an ended session stays readable a while after this or the page's last ask). */
  overAt: number;
  /** A last look at Beeper before an idle or run-limit cancel is under way. */
  checking: boolean;
  /** A form step a submit just failed on: it asks again with `retry`. */
  retryStep: string | null;
  window: SigninWindow | null;
  windowStep: string | null;
  waiting: boolean;
  /** Beeper refused a "wait for the phone" call: only GET from now on. */
  noWait: boolean;
  ctl: AbortController;
};

/** Beeper's field type -> how the page shows it. Beeper's types are suggestions (text, password, email, ...); unknown ones are text. */
function fieldKind(type: unknown, id: string): ChatLoginField["kind"] {
  const t = typeof type === "string" ? type.toLowerCase() : "";
  if (t === "password" || t === "token" || t === "secret") return "password";
  if (t === "email") return "email";
  if (t === "tel" || t === "phone" || t === "phone_number") return "tel";
  if (t === "2fa_code" || t === "code" || t === "otp") return "code";
  if (t === "url") return "url";
  if (!t && /code/i.test(id)) return "code";
  return "text";
}

function words(v: unknown, max: number): string | undefined {
  return typeof v === "string" ? sanitizeLine(v, max) || undefined : undefined;
}

function instructionsOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = sanitizeText(v).trim().slice(0, 1000);
  return t || undefined;
}

function prettyID(id: string): string {
  const s = id.replace(/^.*[./]/, "").replace(/[_-]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1, 200) : "Value";
}

const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/** The display a step shows (a QR code, a code, an emoji picture as data: URL only, or nothing). */
function displayStep(step: Raw): ChatLoginStep {
  const d = isObj(step.display) ? step.display : {};
  const base = { kind: "display" as const, stepID: String(step.stepID), ...(instructionsOf(step.instructions) ? { instructions: instructionsOf(step.instructions) } : {}) };
  if ((d.type === "qr" || d.type === "code") && typeof d.data === "string" && d.data.length > 0 && d.data.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(d.data)) return { ...base, show: d.type, data: d.data };
  const m = d.type === "emoji" && typeof d.imageURL === "string" ? DATA_IMAGE.exec(d.imageURL) : null;
  if (m && m[2]!.length <= 350_000) return { ...base, show: "emoji", image: m[2]!, imageType: m[1] as "image/png" };
  return { ...base, show: "nothing" };
}

function formStep(step: Raw): ChatLoginStep | null {
  const fields: ChatLoginField[] = [];
  for (const f of Array.isArray(step.fields) ? step.fields : []) {
    if (!isObj(f) || typeof f.id !== "string" || !/^[\x21-\x7e]{1,128}$/.test(f.id)) continue;
    const label = words(f.label, 200) ?? words(f.placeholder, 200) ?? prettyID(f.id);
    fields.push({
      id: f.id,
      label,
      kind: fieldKind(f.type, f.id),
      ...(words(f.placeholder, 200) ? { placeholder: words(f.placeholder, 200) } : {}),
      ...(f.optional === true ? { optional: true } : {}),
      ...(words(f.initialValue, 500) ? { initial: words(f.initialValue, 500) } : {}),
    });
    if (fields.length >= 10) break;
  }
  if (!fields.length) return null;
  return { kind: "form", stepID: String(step.stepID), fields, ...(instructionsOf(step.instructions) ? { instructions: instructionsOf(step.instructions) } : {}) };
}

/** A cookies step's URL: https, or http on this computer only (a local test page). */
function signinURL(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password) return null;
    if (u.protocol === "https:") return u;
    if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return u;
    return null;
  } catch {
    return null;
  }
}

function cookieFields(step: Raw): SigninRequest["fields"] | null {
  const out: SigninRequest["fields"] = [];
  for (const f of Array.isArray(step.fields) ? step.fields : []) {
    if (!isObj(f) || typeof f.id !== "string" || !f.id || f.id.length > 128) continue;
    const type = f.type === "header" || f.type === "local_storage" ? f.type : "cookie";
    const name = typeof f.name === "string" && f.name ? f.name.slice(0, 256) : f.id;
    out.push({ id: f.id, name, type });
    if (out.length >= 32) break;
  }
  return out.length ? out : null;
}

/** Who the owner is on the account a session connected. */
function accountName(raw: Raw): string | undefined {
  const acc = isObj(raw.account) ? raw.account : isObj(raw.currentStep) && isObj(raw.currentStep.account) ? raw.currentStep.account : null;
  const u = acc && isObj(acc.user) ? acc.user : isObj(raw.login) && isObj(raw.login.user) ? raw.login.user : null;
  if (!u) return undefined;
  return [u.fullName, u.username, u.phoneNumber, u.email].map((v) => words(v, 200)).find((v) => v);
}

function bridgesIn(body: unknown): Raw[] {
  const items = isObj(body) && Array.isArray(body.items) ? body.items : Array.isArray(body) ? body : [];
  return items.filter((b: unknown): b is Raw => isObj(b) && typeof b.id === "string" && b.id.length > 0 && b.id.length <= 200);
}

/** The bridge a new account of an app would use: one that can take it, on this computer first. */
export function bridgeForNew(bridges: Raw[]): Raw | null {
  const can = bridges.filter((b) => b.status === "available" || (b.status === "connected" && (b.supportsMultipleAccounts === true || !(Number(b.activeAccountCount) > 0))));
  return can.find((b) => b.provider === "local") ?? can.find((b) => b.provider === "cloud") ?? can[0] ?? null;
}

const NEEDS_RECONNECT = new Set(["connection_required", "reconnect_required", "attention_required"]);

function appAccount(raw: Raw): ChatAppAccount | null {
  const a = mapAccount(raw);
  if (!a) return null;
  return {
    accountID: a.accountID,
    ...(a.name ? { name: a.name } : {}),
    status: (ACCOUNT_STATUSES as readonly string[]).includes(a.status) ? a.status : "unknown",
    ...(a.statusText ? { statusText: a.statusText } : {}),
    needsReconnect: NEEDS_RECONNECT.has(a.status),
    removable: a.removable === true,
  };
}

/** The promise's answer, or "late" once the signal fires first. */
function beforeAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T | "late"> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve("late");
  return new Promise((resolve) => {
    const onAbort = () => resolve("late");
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve("late");
      },
    );
  });
}

let seq = 0;
const randomID = () => `cl_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}${(++seq).toString(36)}`;

export function createChatLogin(o: ChatLoginOptions) {
  const client = o.client;
  const now = o.now ?? Date.now;
  const idleMs = o.idleMs ?? CHAT_LOGIN_IDLE_MS;
  const awayMs = o.awayMs ?? CHAT_LOGIN_AWAY_MS;
  const maxMs = o.maxMs ?? CHAT_LOGIN_MAX_MS;
  const waitTimeoutMs = o.waitTimeoutMs ?? 120_000;
  const createTimeoutMs = o.createTimeoutMs ?? 60_000;
  const cancelRetryMs = o.cancelRetryMs ?? [2_000, 10_000, 30_000, 60_000];
  const sessions = new Map<string, Session>();
  const call = (ctx: RequestContext) => ({ signal: ctx.signal });
  const pathOf = (bridgeID: string, beeperID: string) => `/v1/bridges/${enc(bridgeID)}/login-sessions/${enc(beeperID)}`;
  const sessionPath = (s: Session) => pathOf(s.bridgeID, s.beeperID);

  /** Beeper sessions whose cancel Beeper did not confirm (it was not reachable): tried again, and before every start. */
  const unconfirmed = new Map<string, { bridgeID: string; beeperID: string; tries: number; timer?: ReturnType<typeof setTimeout> }>();
  const CANCEL_AGAIN = new Set<string>(["UNKNOWN_OUTCOME", "TIMEOUT", "BEEPER_DOWN", "RATE_LIMITED", "INTERNAL"]);

  /** Cancels a session on Beeper. Gone already (404) or refused for good: done. Not reachable: tried again later. */
  async function cancelAt(bridgeID: string, beeperID: string): Promise<void> {
    const key = `${bridgeID}\n${beeperID}`;
    const was = unconfirmed.get(key);
    if (was?.timer) clearTimeout(was.timer);
    const r = await client.write("DELETE", pathOf(bridgeID, beeperID), undefined, { timeoutMs: 10_000 }).catch(() => null);
    if (r && (r.ok || !CANCEL_AGAIN.has(r.error.code))) {
      unconfirmed.delete(key);
      return;
    }
    const u = unconfirmed.get(key) ?? { bridgeID, beeperID, tries: 0 };
    if (u.tries >= cancelRetryMs.length) {
      unconfirmed.delete(key);
      return;
    }
    const wait = cancelRetryMs[u.tries]!;
    u.tries++;
    u.timer = setTimeout(() => {
      if (unconfirmed.get(key) === u) void cancelAt(bridgeID, beeperID);
    }, wait);
    (u.timer as { unref?: () => void }).unref?.();
    unconfirmed.set(key, u);
  }

  /** Ends a session here: the window closes, Beeper cancels it (tried again if Beeper does not confirm), and polls get `ending`. */
  async function end(s: Session, ending: NonNullable<Session["over"]>, cancelAtBeeper: boolean) {
    if (!s.over) {
      s.over = ending;
      s.overAt = now();
    }
    s.window?.close();
    s.window = null;
    s.ctl.abort();
    if (cancelAtBeeper) await cancelAt(s.bridgeID, s.beeperID);
  }

  /**
   * Whether Beeper's latest answer ended the session (connected, cancelled, failed); if so it is
   * over here too, whoever learnt it (a poll, the background wait for the phone, a website step).
   */
  function settle(s: Session): boolean {
    if (s.over) return true;
    const r = s.latest;
    const step = isObj(r.currentStep) ? r.currentStep : null;
    let ending: NonNullable<Session["over"]> | null = null;
    if (r.status === "complete" || step?.type === "complete") {
      const name = accountName(r);
      ending = { status: "done", account: name ? { name } : {} };
    } else if (r.status === "cancelled") ending = { status: "cancelled" };
    else if (r.status === "failed") ending = { status: "failed" };
    if (!ending) return false;
    void end(s, ending, false);
    return true;
  }

  /** Beeper's session body -> what the page sees; opens a sign-in window for a website step. */
  function stateOf(s: Session): ChatLoginState {
    const base = { sessionID: s.id, app: s.app };
    if (settle(s)) return { ...base, ...s.over! };
    const r = s.latest;
    const step = isObj(r.currentStep) ? r.currentStep : null;
    if (step?.type === "user_input" && typeof step.stepID === "string") {
      const form = formStep(step);
      if (form) return { ...base, status: "input", step: form, ...(s.retryStep === step.stepID ? { retry: true as const } : {}) };
    }
    if (step?.type === "display_and_wait" && typeof step.stepID === "string") {
      waitForPhone(s, step.stepID);
      return { ...base, status: "waiting", step: displayStep(step) };
    }
    if (step?.type === "cookies" && typeof step.stepID === "string") return websiteStep(s, step);
    return { ...base, status: "waiting" };
  }

  function websiteStep(s: Session, step: Raw): ChatLoginState {
    const base = { sessionID: s.id, app: s.app };
    const url = signinURL(step.url);
    const fields = cookieFields(step);
    if (!url || !fields) {
      void end(s, { status: "failed" }, true);
      return { ...base, ...s.over! };
    }
    const site = url.hostname.slice(0, 253);
    if (!s.macWindow) {
      void end(s, { status: "cancelled", problem: "needs-mac" }, true);
      return { ...base, ...s.over! };
    }
    if (s.windowStep !== step.stepID) {
      s.windowStep = String(step.stepID);
      s.window?.close();
      s.window = null;
      const windows = o.windows;
      const w = windows && windows.available()
        ? windows.open({
            title: `J-Inbox: sign in to ${CHAT_APP_NAMES[s.app]}`,
            url: url.href,
            fields,
            ...(typeof step.userAgent === "string" && step.userAgent && step.userAgent.length <= 1000 ? { userAgent: step.userAgent } : {}),
            ...(typeof step.expectedFinalURLRegex === "string" && step.expectedFinalURLRegex.length <= 2000 ? { expectedFinalURLRegex: step.expectedFinalURLRegex } : {}),
            ...(typeof step.extractJS === "string" && step.extractJS.length <= 100_000 ? { extractJS: step.extractJS } : {}),
          })
        : null;
      if (!w) {
        void end(s, { status: "failed", problem: "no-window" }, true);
        return { ...base, ...s.over! };
      }
      s.window = w;
      const stepID = String(step.stepID);
      void w.result.then(async (r) => {
        if (s.over || s.window !== w) return;
        s.window = null;
        if ("closed" in r) return end(s, { status: "cancelled", problem: "window-closed" }, true);
        if ("failed" in r) return end(s, { status: "failed", problem: "no-window" }, true);
        // The website's values, straight to Beeper: never kept, never logged.
        const out = await client.write("POST", `${sessionPath(s)}/steps/${enc(stepID)}`, { type: "cookies", fields: r.fields, ...(r.lastURL && r.lastURL.length <= 4096 ? { lastURL: r.lastURL } : {}), source: "webview" }, { signal: s.ctl.signal, timeoutMs: 60_000 });
        if (s.over) return;
        if (out.ok && isObj(out.body)) {
          s.latest = out.body;
          settle(s);
        } else void end(s, { status: "failed" }, true);
      });
    }
    return { ...base, status: "waiting", step: { kind: "browser", stepID: String(step.stepID), site, window: "open" } };
  }

  /**
   * A display step (a QR code, a code for the phone): Beeper's mautrix sign-ins move on once a
   * client waits on the step (POST .../steps/{stepID} {type: display_and_wait}), which answers with
   * the next state. Run that in the background while the page asks with GET; one at a time.
   */
  function waitForPhone(s: Session, stepID: string) {
    if (s.waiting || s.noWait || s.over) return;
    s.waiting = true;
    void (async () => {
      try {
        const t0 = now();
        const out = await client.write("POST", `${sessionPath(s)}/steps/${enc(stepID)}`, { type: "display_and_wait" }, { signal: s.ctl.signal, timeoutMs: waitTimeoutMs });
        if (s.over) return;
        if (out.ok && isObj(out.body)) {
          s.latest = out.body;
          if (settle(s)) return;
          // An answer at once with the same step: Beeper does not hold the call; do not ask in a tight loop.
          if (now() - t0 < 1000 && isObj(out.body.currentStep) && out.body.currentStep.stepID === stepID) await new Promise((r) => setTimeout(r, 3000));
        } else if (!out.ok && ["BAD_PARAMS", "CONFLICT", "NOT_FOUND", "NOT_ALLOWED"].includes(out.error.code)) {
          s.noWait = true;
        } else await new Promise((r) => setTimeout(r, 1000));
      } finally {
        s.waiting = false;
      }
      // Still on a display step: wait again (the QR code was replaced, or the call ran out of time).
      if (!s.over && sessions.get(s.id) === s && isObj(s.latest.currentStep) && s.latest.currentStep.type === "display_and_wait") waitForPhone(s, String(s.latest.currentStep.stepID));
    })();
  }

  function ended(s: Session) {
    return s.over !== null;
  }

  /**
   * Whether the person is likely in another app: a display step (a QR code to scan, a code to type
   * on the phone) or a form asking for a code that was sent to them. A phone's browser does not ask
   * while it is in the background, so such a step gets the longer idle limit.
   */
  function away(s: Session): boolean {
    const step = isObj(s.latest.currentStep) ? s.latest.currentStep : null;
    if (step?.type === "display_and_wait") return true;
    if (step?.type !== "user_input" || !Array.isArray(step.fields)) return false;
    return step.fields.some((f: unknown) => isObj(f) && typeof f.id === "string" && fieldKind(f.type, f.id) === "code");
  }

  /**
   * Past a limit: unless Beeper already finished it (the phone did, while the page was in the
   * background), it is cancelled on Beeper. Beeper is asked first, so a connected account is never
   * reported as expired or cancelled.
   */
  async function limit(s: Session, ending: NonNullable<Session["over"]>, forget: boolean) {
    if (s.checking || settle(s)) return;
    s.checking = true;
    try {
      const r = await client.get(sessionPath(s), { timeoutMs: 10_000 }).catch(() => null);
      if (s.over) return;
      if (r?.ok && isObj(r.body)) {
        s.latest = r.body;
        if (settle(s)) return;
      }
      await end(s, ending, true);
      if (forget) sessions.delete(s.id);
    } finally {
      s.checking = false;
    }
  }

  /** Over sessions stay readable a while (the page's next ask, also from a phone back from the background), then go. */
  function sweep() {
    const t = now();
    for (const s of sessions.values()) {
      if (ended(s) || settle(s)) {
        if (t - Math.max(s.askedAt, s.overAt) > awayMs) sessions.delete(s.id);
        continue;
      }
      if (t - s.startedAt > maxMs) void limit(s, { status: "expired" }, false);
      else if (t - s.askedAt > (away(s) ? awayMs : idleMs)) void limit(s, { status: "cancelled" }, true);
    }
  }
  const timer = setInterval(sweep, 5_000);
  (timer as { unref?: () => void }).unref?.();

  async function bridges(ctx: RequestContext): Promise<Raw[] | ErrorBody> {
    const r = await client.get("/v1/bridges", call(ctx));
    return r.ok ? bridgesIn(r.body) : r.error;
  }

  async function chat_apps(_p: ActionParams<"chat_apps">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"chat_apps">>> {
    const all = await bridges(ctx);
    if (!Array.isArray(all)) return { ok: false, error: all };
    const byApp = new Map<ChatAppKey, Raw[]>();
    for (const b of all) {
      const app = chatAppOf(b);
      if (!app) continue;
      byApp.set(app, [...(byApp.get(app) ?? []), b]);
    }
    const apps = CHAT_APP_KEYS.filter((k) => byApp.has(k));
    const items: ChatApp[] = await Promise.all(
      apps.map(async (app): Promise<ChatApp> => {
        const list = byApp.get(app)!;
        const accounts: ChatAppAccount[] = [];
        const seen = new Set<string>();
        for (const b of list)
          for (const raw of Array.isArray(b.accounts) ? b.accounts : []) {
            if (!isObj(raw) || isBeeperOwnAccount(raw)) continue;
            const a = appAccount({ ...raw, bridge: isObj(raw.bridge) ? raw.bridge : { id: b.id, type: b.type, provider: b.provider } });
            if (a && !seen.has(a.accountID) && accounts.length < 20) {
              seen.add(a.accountID);
              accounts.push(a);
            }
          }
        const pick = app === "imessage" ? null : bridgeForNew(list);
        let flows: ChatApp["flows"] = [];
        if (pick) {
          const f = await client.get(`/v1/bridges/${enc(pick.id)}/login-flows`, call(ctx));
          const raw = f.ok && isObj(f.body) && Array.isArray(f.body.items) ? f.body.items : [];
          flows = raw
            .filter((x: unknown): x is Raw => isObj(x) && typeof x.id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(x.id))
            .slice(0, 8)
            .map((x: Raw) => ({ id: x.id, name: words(x.name, 100) ?? x.id.slice(0, 100) }));
        }
        const full = !pick && list.some((b) => b.status === "limit_reached" || b.status === "connected");
        return { app, state: pick ? "available" : full ? "full" : "unavailable", onDevice: pick ? pick.provider === "local" : list.some((b) => b.provider === "local"), flows, accounts };
      }),
    );
    const checked = parseActionResult("chat_apps", { items });
    return checked.ok ? { ok: true, data: checked.value } : err("INTERNAL", "Beeper sent chat apps J-Inbox could not read.");
  }

  async function chat_login_start(p: ActionParams<"chat_login_start">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"chat_login_start">>> {
    // One sign-in at a time: an earlier one is cancelled first (and any cancel Beeper did not confirm), so it never blocks this one.
    await Promise.all([
      ...[...sessions.values()].filter((s) => !ended(s)).map((s) => end(s, { status: "cancelled" }, true)),
      ...[...unconfirmed.values()].map((u) => cancelAt(u.bridgeID, u.beeperID)),
    ]);
    const all = await bridges(ctx);
    if (!Array.isArray(all)) return { ok: false, error: all };
    const mine = all.filter((b) => chatAppOf(b) === p.app);
    let bridge: Raw | null;
    const body: Record<string, string> = {};
    if (p.accountID) {
      bridge = mine.find((b) => Array.isArray(b.accounts) && b.accounts.some((a: unknown) => isObj(a) && a.accountID === p.accountID)) ?? null;
      const acc = bridge?.accounts.find((a: Raw) => isObj(a) && a.accountID === p.accountID);
      if (!bridge || !acc || isBeeperOwnAccount(acc)) return err("NOT_FOUND", `That ${CHAT_APP_NAMES[p.app]} account is not in Beeper on this computer any more.`);
      body.accountID = p.accountID;
      if (typeof acc.loginID === "string" && acc.loginID) body.loginID = acc.loginID;
    } else {
      bridge = bridgeForNew(mine);
      if (!bridge) return err("NOT_SUPPORTED", `Beeper cannot add a ${CHAT_APP_NAMES[p.app]} account on this computer right now.`);
    }
    if (p.flowID) body.flowID = p.flowID;
    if (ctx.signal?.aborted) return err("TIMEOUT", "Beeper did not start the sign-in in time. Try again.");
    // The start runs on its own deadline, not the request's: if Beeper answers after the page was
    // answered, that session is cancelled at once, so it never blocks the next attempt.
    const bridgeID = String(bridge.id);
    const creating = client.write("POST", `/v1/bridges/${enc(bridgeID)}/login-sessions`, body, { timeoutMs: createTimeoutMs });
    const r: BeeperCall | "late" = await beforeAbort(creating, ctx.signal);
    if (r === "late") {
      void creating.then((late) => {
        if (late.ok && isObj(late.body) && typeof late.body.loginSessionID === "string" && late.body.loginSessionID) return cancelAt(bridgeID, late.body.loginSessionID);
      }, () => undefined);
      return err("BEEPER_DOWN", "Beeper did not start the sign-in in time. Try again.");
    }
    if (!r.ok) {
      if (r.error.code === "CONFLICT") return err("CONFLICT", "Beeper is still finishing another sign-in. Try again in a minute.");
      return { ok: false, error: r.error.code === "UNKNOWN_OUTCOME" ? makeError("BEEPER_DOWN", "Beeper did not start the sign-in. Try again.") : r.error };
    }
    if (!isObj(r.body) || typeof r.body.loginSessionID !== "string" || !r.body.loginSessionID) return err("BEEPER_DOWN", "Beeper did not start the sign-in. Try again.");
    const t = now();
    const s: Session = { id: (o.newID ?? randomID)(), app: p.app, bridgeID, beeperID: r.body.loginSessionID, latest: r.body, startedAt: t, askedAt: t, macWindow: p.macWindow !== false, over: null, overAt: 0, checking: false, retryStep: null, window: null, windowStep: null, waiting: false, noWait: false, ctl: new AbortController() };
    sessions.set(s.id, s);
    return answer(s);
  }

  function answer(s: Session): Outcome<ChatLoginState> {
    const checked = parseActionResult("chat_login_poll", stateOf(s));
    if (checked.ok) return { ok: true, data: checked.value };
    void end(s, { status: "failed" }, true);
    return { ok: true, data: { sessionID: s.id, app: s.app, status: "failed" } };
  }

  const gone = () => err("NOT_FOUND", "This sign-in is over. Start again.");

  async function chat_login_poll(p: ActionParams<"chat_login_poll">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"chat_login_poll">>> {
    const s = sessions.get(p.sessionID);
    if (!s) return gone();
    s.askedAt = now();
    if (ended(s)) return answer(s);
    const r = await client.get(sessionPath(s), call(ctx));
    if (ended(s)) return answer(s);
    if (!r.ok) {
      // Beeper no longer knows it: it expired there.
      if (r.error.code === "NOT_FOUND") {
        await end(s, { status: "expired" }, false);
        return answer(s);
      }
      return { ok: false, error: r.error };
    }
    if (isObj(r.body)) s.latest = r.body;
    return answer(s);
  }

  async function chat_login_submit(p: ActionParams<"chat_login_submit">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"chat_login_submit">>> {
    const s = sessions.get(p.sessionID);
    if (!s) return gone();
    s.askedAt = now();
    if (ended(s)) return answer(s);
    const step = isObj(s.latest.currentStep) ? s.latest.currentStep : null;
    if (!step || step.type !== "user_input" || step.stepID !== p.stepID) return answer(s);
    // The owner's values go to Beeper and nowhere else (never logged; the answer carries none of them).
    const r = await client.write("POST", `${sessionPath(s)}/steps/${enc(p.stepID)}`, { type: "user_input", fields: p.fields }, call(ctx));
    if (ended(s)) return answer(s);
    if (r.ok && isObj(r.body)) {
      s.latest = r.body;
      const next = isObj(r.body.currentStep) ? r.body.currentStep : null;
      s.retryStep = r.body.status === "waiting_for_input" && next?.stepID === p.stepID ? p.stepID : null;
      return answer(s);
    }
    if (!r.ok && (r.error.code === "BAD_PARAMS" || r.error.code === "CONFLICT" || r.error.code === "NOT_ALLOWED")) {
      // Refused (a wrong code): where does the sign-in stand now?
      const now2 = await client.get(sessionPath(s), call(ctx));
      if (now2.ok && isObj(now2.body)) {
        s.latest = now2.body;
        const next = isObj(now2.body.currentStep) ? now2.body.currentStep : null;
        s.retryStep = next?.type === "user_input" && next.stepID === p.stepID ? p.stepID : null;
        return answer(s);
      }
      if (!now2.ok && now2.error.code === "NOT_FOUND") {
        await end(s, { status: "expired" }, false);
        return answer(s);
      }
    }
    if (!r.ok && r.error.code === "NOT_FOUND") {
      await end(s, { status: "expired" }, false);
      return answer(s);
    }
    return { ok: false, error: r.ok ? makeError("BEEPER_DOWN", "Beeper sent an unexpected answer.") : r.error };
  }

  async function chat_login_cancel(p: ActionParams<"chat_login_cancel">, _ctx: RequestContext = {}): Promise<Outcome<ActionResult<"chat_login_cancel">>> {
    const s = sessions.get(p.sessionID);
    if (s) {
      s.askedAt = now();
      if (!ended(s)) await end(s, { status: "cancelled" }, true);
    }
    return { ok: true, data: { sessionID: p.sessionID, cancelled: true } };
  }

  return {
    chat_apps,
    chat_login_start,
    chat_login_poll,
    chat_login_submit,
    chat_login_cancel,
    /** Tests: run the idle and expiry check now. */
    sweep,
    /** Sessions still running (tests, shutdown). */
    active: () => [...sessions.values()].filter((s) => !ended(s)).length,
    /** The connector stops: every sign-in is cancelled on Beeper and its window closes. */
    async stop() {
      clearInterval(timer);
      for (const u of unconfirmed.values()) if (u.timer) clearTimeout(u.timer);
      await Promise.all([...sessions.values()].filter((s) => !ended(s)).map((s) => end(s, { status: "cancelled" }, true)));
    },
  };
}

export type ChatLogin = ReturnType<typeof createChatLogin>;
