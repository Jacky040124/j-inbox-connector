// Connecting chat apps (chat-login.ts) against fake Beeper's bridges, login flows and sessions:
// every kind of step, cancel, expiry, the page going away, reconnect, and nothing typed coming back.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { LOGIN_SECRETS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { CHAT_APP_KEYS, parseActionResult, type ChatLoginState } from "@j-inbox/protocol";
import { createBeeperClient } from "../src/beeper-client.ts";
import { createChatLogin, type ChatLogin, type SigninRequest, type SigninResult, type SigninWindows } from "../src/chat-login.ts";
import { createDispatcher } from "../src/dispatcher.ts";
import { createActions } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";

let fb: FakeBeeper;
let live: ChatLogin[] = [];
beforeAll(async () => {
  fb = await startFakeBeeper({ controls: { loginWaitMs: 1500 } });
});
afterAll(() => fb.stop());
afterEach(async () => {
  for (const l of live) await l.stop();
  live = [];
  // Cancels sent in the background land before the next test's fresh state.
  await Bun.sleep(80);
  fb.reset();
});

/** A sign-in window that answers what the test says, and remembers what it was asked. */
function fakeWindows(answer: (r: SigninRequest) => Promise<SigninResult> | SigninResult = () => ({ fields: { sessionid: LOGIN_SECRETS.cookieValue, csrftoken: LOGIN_SECRETS.cookieValue }, lastURL: "https://example.test/home" })) {
  const asked: SigninRequest[] = [];
  let closed = 0;
  const w: SigninWindows & { asked: SigninRequest[]; closed: () => number } = {
    asked,
    closed: () => closed,
    available: () => true,
    open(r) {
      asked.push(r);
      return { result: Promise.resolve(answer(r)), close: () => void closed++ };
    },
  };
  return w;
}

function make(o: { windows?: SigninWindows | null; now?: () => number } = {}) {
  const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 });
  const l = createChatLogin({ client, windows: o.windows === undefined ? fakeWindows() : o.windows, now: o.now, waitTimeoutMs: 3000 });
  live.push(l);
  return l;
}
const ok = <T>(r: { ok: boolean; data?: T; error?: { code: string } }): T => {
  if (!r.ok) throw new Error(`not ok: ${r.error?.code}`);
  return r.data as T;
};
const calls = (route: string) => fb.state.calls.filter((c) => c.route === route);
const STEP = "POST /v1/bridges/{bridgeID}/login-sessions/{loginSessionID}/steps/{stepID}";
const CREATE = "POST /v1/bridges/{bridgeID}/login-sessions";
const DELETE = "DELETE /v1/bridges/{bridgeID}/login-sessions/{loginSessionID}";

async function until(l: ChatLogin, sessionID: string, done: (s: ChatLoginState) => boolean, ms = 5000): Promise<ChatLoginState> {
  const end = Date.now() + ms;
  for (;;) {
    const s = ok(await l.chat_login_poll({ sessionID }));
    if (done(s) || Date.now() > end) return s;
    await Bun.sleep(50);
  }
}

describe("chat_apps", () => {
  test("only J-Inbox's apps, in its order; never Beeper's own account or other networks; the on-device bridge first", async () => {
    const apps = ok(await make().chat_apps({}));
    expect(parseActionResult("chat_apps", apps).ok).toBe(true);
    const keys = apps.items.map((a) => a.app);
    expect(keys).toEqual(CHAT_APP_KEYS.filter((k) => keys.includes(k)));
    expect(keys).toEqual(["whatsapp", "telegram", "instagram", "messenger", "linkedin", "x", "discord", "slack", "signal", "imessage"]);
    const json = JSON.stringify(apps);
    for (const never of ["matrix", "Beeper", "gvoice", "Google", "LINE", "bluesky"]) expect(json).not.toContain(never);
    const by = Object.fromEntries(apps.items.map((a) => [a.app, a]));
    // Instagram: the cloud account is listed, a new one would use the on-device bridge and its flow.
    expect(by.instagram!.onDevice).toBe(true);
    expect(by.instagram!.flows.map((f) => f.id)).toEqual(["instagram"]);
    expect(by.instagram!.accounts.map((a) => a.accountID)).toEqual(["instagramgo"]);
    expect(by.whatsapp!.flows.map((f) => f.id)).toEqual(["qr", "phone"]);
    expect(by.slack!.flows.map((f) => f.id)).toEqual(["email", "token", "app"]);
    expect(by.messenger!.flows[0]!.id).toBe("messenger-lite-android");
    expect(by.imessage!.flows).toEqual([]);
    // Signed out: Reconnect.
    expect(by.linkedin!.accounts[0]).toMatchObject({ accountID: "linkedin", needsReconnect: true, removable: true });
    // Only the bridges' own login-flows were read, and only for J-Inbox's apps.
    const flowsAsked = calls("GET /v1/bridges/{bridgeID}/login-flows").map((c) => c.params.bridgeID);
    expect(flowsAsked.sort()).toEqual(["local-discord", "local-facebook", "local-instagram", "local-linkedin", "local-signal", "local-slack", "local-telegram", "local-twitter", "local-whatsapp"]);
  });
});

describe("a QR code (WhatsApp, Signal, Discord, Telegram)", () => {
  test("the code is shown, Beeper is waited on in the background, the phone scans, the account is there", async () => {
    const l = make();
    const s = ok(await l.chat_login_start({ app: "whatsapp", flowID: "qr" }));
    expect(s.status).toBe("waiting");
    expect(s.step).toMatchObject({ kind: "display", show: "qr" });
    const qr = (s.step as { data: string }).data;
    expect(qr).toStartWith("fake-qr-secret:");
    expect(calls(CREATE)[0]!.params.bridgeID).toBe("local-whatsapp");
    expect(calls(CREATE)[0]!.body).toEqual({ flowID: "qr" });
    await Bun.sleep(100);
    expect(calls(STEP).some((c) => (c.body as { type: string }).type === "display_and_wait")).toBe(true);
    // A new code replaces the old one.
    fb.logins.rotate();
    const next = await until(l, s.sessionID, (x) => x.step?.kind === "display" && (x.step as { data?: string }).data !== qr);
    expect((next.step as { data: string }).data).not.toBe(qr);
    fb.logins.scan();
    const done = await until(l, s.sessionID, (x) => x.status === "done");
    expect(done).toMatchObject({ status: "done", app: "whatsapp", account: { name: "New WhatsApp Account" } });
    expect(fb.state.accounts.some((a) => a.bridge.id === "local-whatsapp" && a.accountID.includes("FAKEnew"))).toBe(true);
  });
});

describe("codes", () => {
  test("Slack: the email, then the code; a wrong code asks again with retry; the right one connects", async () => {
    const l = make();
    const s = ok(await l.chat_login_start({ app: "slack", flowID: "email" }));
    expect(s).toMatchObject({ status: "input", step: { kind: "form", fields: [{ id: "email", kind: "email" }] } });
    const email = "owner-marker@example.com";
    const c = ok(await l.chat_login_submit({ sessionID: s.sessionID, stepID: (s.step as { stepID: string }).stepID, fields: { email } }));
    expect(c).toMatchObject({ status: "input", step: { kind: "form", fields: [{ id: "code", kind: "code" }] } });
    expect(c.retry).toBeUndefined();
    expect((c.step as { instructions: string }).instructions).toBe("Enter the code Slack sent to o***@example.com");
    const codeStep = (c.step as { stepID: string }).stepID;
    const wrong = ok(await l.chat_login_submit({ sessionID: s.sessionID, stepID: codeStep, fields: { code: "000000" } }));
    expect(wrong).toMatchObject({ status: "input", retry: true });
    // Still asking again on the next poll, until a new try.
    expect(ok(await l.chat_login_poll({ sessionID: s.sessionID })).retry).toBe(true);
    const right = ok(await l.chat_login_submit({ sessionID: s.sessionID, stepID: codeStep, fields: { code: LOGIN_SECRETS.slackCode } }));
    expect(right.status).toBe("done");
    // Nothing typed ever comes back.
    for (const r of [s, c, wrong, right]) for (const v of [email, "000000", LOGIN_SECRETS.slackCode]) expect(JSON.stringify(r)).not.toContain(v);
  });

  test("Telegram by phone: the number, then the code", async () => {
    const l = make();
    const s = ok(await l.chat_login_start({ app: "telegram", flowID: "phone" }));
    expect(s.step).toMatchObject({ kind: "form", fields: [{ id: "phone_number", kind: "tel" }] });
    const c = ok(await l.chat_login_submit({ sessionID: s.sessionID, stepID: (s.step as { stepID: string }).stepID, fields: { phone_number: "+15550100777" } }));
    expect(c.step).toMatchObject({ kind: "form", fields: [{ id: "code", kind: "code" }] });
    const done = ok(await l.chat_login_submit({ sessionID: s.sessionID, stepID: (c.step as { stepID: string }).stepID, fields: { code: LOGIN_SECRETS.telegramCode } }));
    expect(done.status).toBe("done");
  });

  test("WhatsApp by pairing code: the number, then a code to type on the phone", async () => {
    const l = make();
    const s = ok(await l.chat_login_start({ app: "whatsapp", flowID: "phone" }));
    const c = ok(await l.chat_login_submit({ sessionID: s.sessionID, stepID: (s.step as { stepID: string }).stepID, fields: { phone_number: "+15550100778" } }));
    expect(c.step).toMatchObject({ kind: "display", show: "code", data: LOGIN_SECRETS.whatsappPairing });
    fb.logins.scan();
    expect((await until(l, s.sessionID, (x) => x.status === "done")).status).toBe("done");
  });
});

describe("a password (Messenger)", () => {
  test("a form with a masked password; a wrong one asks again; the right one connects", async () => {
    const l = make();
    const s = ok(await l.chat_login_start({ app: "messenger", flowID: "messenger-lite-android" }));
    expect(s.step).toMatchObject({ kind: "form", fields: [{ id: "username", kind: "text", label: "Email or phone" }, { id: "password", kind: "password" }] });
    const stepID = (s.step as { stepID: string }).stepID;
    const bad = ok(await l.chat_login_submit({ sessionID: s.sessionID, stepID, fields: { username: "o@example.com", password: "wrong-pass-marker" } }));
    expect(bad.retry).toBe(true);
    expect(JSON.stringify(bad)).not.toContain("wrong-pass-marker");
    const good = ok(await l.chat_login_submit({ sessionID: s.sessionID, stepID, fields: { username: "o@example.com", password: LOGIN_SECRETS.messengerPassword } }));
    expect(good.status).toBe("done");
  });
});

describe("a website sign-in (Instagram): a window on the Mac", () => {
  test("the window is asked for exactly Beeper's step; what it collects goes to Beeper, never to the page", async () => {
    const w = fakeWindows();
    const l = make({ windows: w });
    const s = ok(await l.chat_login_start({ app: "instagram" }));
    expect(s).toMatchObject({ status: "waiting", step: { kind: "browser", site: "127.0.0.1", window: "open" } });
    expect(calls(CREATE)[0]!.params.bridgeID).toBe("local-instagram");
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]).toMatchObject({ title: "J-Inbox: sign in to Instagram", fields: [{ id: "sessionid", name: "sessionid", type: "cookie" }, { id: "csrftoken", name: "csrftoken", type: "cookie" }], userAgent: expect.stringContaining("FakeBeeper"), extractJS: "(async () => ({}))()" });
    expect(w.asked[0]!.url).toEndWith("/fake-login/instagram");
    const done = await until(l, s.sessionID, (x) => x.status === "done");
    expect(done.status).toBe("done");
    const sent = calls(STEP).find((c) => (c.body as { type: string }).type === "cookies")!;
    expect(sent.body).toEqual({ type: "cookies", fields: { sessionid: LOGIN_SECRETS.cookieValue, csrftoken: LOGIN_SECRETS.cookieValue }, lastURL: "https://example.test/home", source: "webview" });
    expect(JSON.stringify(done)).not.toContain(LOGIN_SECRETS.cookieValue);
  });

  test("the window closed by the owner: cancelled on Beeper, and the page is told", async () => {
    const l = make({ windows: fakeWindows(() => ({ closed: true })) });
    const s = ok(await l.chat_login_start({ app: "instagram" }));
    const over = await until(l, s.sessionID, (x) => x.status !== "waiting");
    expect(over).toMatchObject({ status: "cancelled", problem: "window-closed" });
    await Bun.sleep(80);
    expect(calls(DELETE)).toHaveLength(1);
  });

  test("no sign-in window on this Mac: cancelled on Beeper, with why", async () => {
    const s = ok(await make({ windows: null }).chat_login_start({ app: "instagram" }));
    expect(s).toMatchObject({ status: "failed", problem: "no-window" });
    await Bun.sleep(50);
    expect(calls(DELETE)).toHaveLength(1);
  });

  test("asked for no window (the page is on a phone): no window, cancelled, needs the Mac", async () => {
    const w = fakeWindows();
    const s = ok(await make({ windows: w }).chat_login_start({ app: "instagram", macWindow: false }));
    expect(s).toMatchObject({ status: "cancelled", problem: "needs-mac" });
    expect(w.asked).toHaveLength(0);
  });
});

describe("cancel, expiry, failure, the page going away", () => {
  test("Cancel cancels the session on Beeper and closes the window; it can start again at once", async () => {
    const w = fakeWindows(() => new Promise(() => {}));
    const l = make({ windows: w });
    const s = ok(await l.chat_login_start({ app: "instagram" }));
    expect(ok(await l.chat_login_cancel({ sessionID: s.sessionID }))).toEqual({ sessionID: s.sessionID, cancelled: true });
    expect(calls(DELETE)).toHaveLength(1);
    expect(w.closed()).toBe(1);
    expect(ok(await l.chat_login_poll({ sessionID: s.sessionID })).status).toBe("cancelled");
    // Idempotent.
    expect(ok(await l.chat_login_cancel({ sessionID: s.sessionID })).cancelled).toBe(true);
    expect(calls(DELETE)).toHaveLength(1);
    expect(ok(await l.chat_login_start({ app: "instagram" })).status).toBe("waiting");
  });

  test("a second start cancels the first, so a half-done sign-in never blocks the next", async () => {
    const l = make();
    const a = ok(await l.chat_login_start({ app: "slack" }));
    const b = ok(await l.chat_login_start({ app: "slack" }));
    expect(b.status).toBe("input");
    expect(calls(DELETE)).toHaveLength(1);
    expect(ok(await l.chat_login_poll({ sessionID: a.sessionID })).status).toBe("cancelled");
  });

  test("Beeper's own expiry: the next ask says expired", async () => {
    const l = make();
    const s = ok(await l.chat_login_start({ app: "slack" }));
    fb.logins.expire();
    expect(ok(await l.chat_login_poll({ sessionID: s.sessionID })).status).toBe("expired");
  });

  test("a sign-in that fails at the network says failed, without Beeper's words", async () => {
    const l = make();
    const s = ok(await l.chat_login_start({ app: "signal" }));
    fb.logins.fail();
    const over = await until(l, s.sessionID, (x) => x.status !== "waiting");
    expect(over).toEqual({ sessionID: s.sessionID, app: "signal", status: "failed" });
  });

  test("nobody asks for a minute (the page closed): cancelled on Beeper; too long: expired", async () => {
    let t = 1_000_000;
    const l = make({ now: () => t });
    const a = ok(await l.chat_login_start({ app: "slack" }));
    t += 61_000;
    l.sweep();
    await Bun.sleep(100);
    expect(calls(DELETE)).toHaveLength(1);
    expect(l.active()).toBe(0);
    const b = ok(await l.chat_login_start({ app: "slack" }));
    for (let i = 0; i < 12; i++) {
      t += 55_000;
      await l.chat_login_poll({ sessionID: b.sessionID });
      l.sweep();
    }
    await Bun.sleep(50);
    expect(ok(await l.chat_login_poll({ sessionID: b.sessionID })).status).toBe("expired");
    expect(a.sessionID).not.toBe(b.sessionID);
  });

  test("an unknown session is NOT_FOUND", async () => {
    const r = await make().chat_login_poll({ sessionID: "cl_unknown000000" });
    expect(r.ok ? "ok" : r.error.code).toBe("NOT_FOUND");
  });

  test("stopping the connector cancels what runs", async () => {
    const l = make();
    await l.chat_login_start({ app: "slack" });
    await l.stop();
    expect(calls(DELETE)).toHaveLength(1);
  });
});

describe("reconnect", () => {
  test("an account that needs it runs the same sign-in on its own bridge, with its accountID and loginID", async () => {
    fb.state.accounts = fb.state.accounts.map((a) => (a.accountID === "discordgo" ? { ...a, status: "reconnect_required" } : a));
    const l = make();
    const apps = ok(await l.chat_apps({}));
    expect(apps.items.find((a) => a.app === "discord")!.accounts[0]).toMatchObject({ accountID: "discordgo", needsReconnect: true });
    const s = ok(await l.chat_login_start({ app: "discord", flowID: "qr", accountID: "discordgo" }));
    expect(calls(CREATE)[0]).toMatchObject({ params: { bridgeID: "discordgo" }, body: { flowID: "qr", accountID: "discordgo", loginID: "discordgo" } });
    fb.logins.scan();
    expect((await until(l, s.sessionID, (x) => x.status === "done")).status).toBe("done");
    expect(fb.state.accounts.find((a) => a.accountID === "discordgo")!.status).toBe("connected");
  });

  test("Beeper's own account is never reconnected, and an account of another app is not this app's", async () => {
    const l = make();
    const a = await l.chat_login_start({ app: "discord", accountID: "matrix" });
    expect(a.ok ? "ok" : a.error.code).toBe("NOT_FOUND");
    const b = await l.chat_login_start({ app: "discord", accountID: "instagramgo" });
    expect(b.ok ? "ok" : b.error.code).toBe("NOT_FOUND");
    expect(calls(CREATE)).toHaveLength(0);
  });
});

describe("through the dispatcher", () => {
  test("the actions run, and their results are the protocol's", async () => {
    const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 });
    const assets = new AssetAllowlist();
    const chatLogin = make();
    const d = createDispatcher({ actions: createActions(client, { assets }), client, assets, chatLogin });
    const r = await d.dispatch("chat_login_start", { app: "slack" });
    expect(r.kind === "res" && r.ok).toBe(true);
    const bad = await d.dispatch("chat_login_start", { app: "matrix" });
    expect(bad.kind === "res" && !bad.ok && bad.error.code).toBe("BAD_PARAMS");
  });
});

describe("nothing half-done is left on Beeper", () => {
  /** A client whose Beeper answers `slow` calls only after `ms` (Beeper has already acted), and fails the first `failDeletes` cancels at the network. */
  function slowClient(o: { slow?: (method: string, url: string) => boolean; ms?: number; failDeletes?: number }) {
    let failDeletes = o.failDeletes ?? 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE" && failDeletes > 0) {
        failDeletes--;
        throw new TypeError("fetch failed");
      }
      const res = await fetch(url, { ...init, signal: undefined });
      if (o.slow?.(method, String(url))) await Bun.sleep(o.ms ?? 0);
      if (init?.signal?.aborted) throw init.signal.reason;
      return res;
    }) as typeof fetch;
    return createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000, fetchImpl });
  }
  const active = () => [...fb.logins.sessions.values()].filter((s) => ["waiting_for_input", "waiting_for_display", "waiting_for_cookies"].includes(s.status));

  test("a start Beeper answers after the request's deadline: that session is cancelled when the answer comes, and the next start works", async () => {
    let slow = true;
    const client = slowClient({ slow: (m, u) => slow && m === "POST" && /login-sessions$/.test(u), ms: 400 });
    const l = createChatLogin({ client, windows: null, waitTimeoutMs: 3000 });
    live.push(l);
    const first = await l.chat_login_start({ app: "signal", flowID: "qr", macWindow: false }, { signal: AbortSignal.timeout(100) });
    expect(first.ok ? "ok" : first.error.code).toBe("BEEPER_DOWN");
    // Beeper made it; its answer is still on the way.
    expect(active()).toHaveLength(1);
    await Bun.sleep(600);
    expect(calls(DELETE)).toHaveLength(1);
    expect(active()).toHaveLength(0);
    slow = false;
    const second = await l.chat_login_start({ app: "signal", flowID: "qr", macWindow: false }, { signal: AbortSignal.timeout(3000) });
    expect(ok(second).status).toBe("waiting");
  });

  test("a request already out of time does not start a session at all", async () => {
    const l = make();
    const ctl = new AbortController();
    ctl.abort();
    const r = await l.chat_login_start({ app: "slack" }, { signal: ctl.signal });
    expect(r.ok ? "ok" : r.error.code).toBe("TIMEOUT");
    expect(calls(CREATE)).toHaveLength(0);
  });

  test("a cancel Beeper did not get is tried again, so it does not block the next start", async () => {
    const client = slowClient({ failDeletes: 1 });
    const l = createChatLogin({ client, windows: null, waitTimeoutMs: 3000, cancelRetryMs: [60_000] });
    live.push(l);
    const a = ok(await l.chat_login_start({ app: "slack" }));
    expect(ok(await l.chat_login_cancel({ sessionID: a.sessionID })).cancelled).toBe(true);
    // The cancel never reached Beeper: its session still runs there.
    expect(calls(DELETE)).toHaveLength(0);
    expect(active()).toHaveLength(1);
    // The next start cancels it first (before its timer would), then starts.
    expect(ok(await l.chat_login_start({ app: "slack" })).status).toBe("input");
    expect(calls(DELETE)).toHaveLength(1);
    expect(active()).toHaveLength(1);
  });

  test("the retry runs by itself when Beeper is back", async () => {
    const client = slowClient({ failDeletes: 1 });
    const l = createChatLogin({ client, windows: null, waitTimeoutMs: 3000, cancelRetryMs: [50] });
    live.push(l);
    const a = ok(await l.chat_login_start({ app: "slack" }));
    await l.chat_login_cancel({ sessionID: a.sessionID });
    expect(active()).toHaveLength(1);
    await Bun.sleep(250);
    expect(calls(DELETE)).toHaveLength(1);
    expect(active()).toHaveLength(0);
  });
});

describe("the person is in the phone app", () => {
  test("a code shown for the phone is not cancelled after a minute without an ask, only after five", async () => {
    let t = 1_000_000;
    const l = make({ now: () => t });
    const s = ok(await l.chat_login_start({ app: "whatsapp", flowID: "phone", macWindow: false }));
    const c = ok(await l.chat_login_submit({ sessionID: s.sessionID, stepID: (s.step as { stepID: string }).stepID, fields: { phone_number: "+15550100778" } }));
    expect(c.step).toMatchObject({ kind: "display", show: "code" });
    // In WhatsApp for more than a minute: the browser in the background asks nothing.
    t += 61_000;
    l.sweep();
    await Bun.sleep(100);
    expect(calls(DELETE)).toHaveLength(0);
    expect(ok(await l.chat_login_poll({ sessionID: s.sessionID })).status).toBe("waiting");
    t += 5 * 60_000 + 1000;
    l.sweep();
    await Bun.sleep(100);
    expect(calls(DELETE)).toHaveLength(1);
    expect(l.active()).toBe(0);
  });

  test("the phone finishes while the page is in the background: connected, not cancelled; the page learns it when it is back", async () => {
    let t = 1_000_000;
    const l = make({ now: () => t });
    const s = ok(await l.chat_login_start({ app: "whatsapp", flowID: "phone", macWindow: false }));
    const before = fb.state.accounts.length;
    const c = ok(await l.chat_login_submit({ sessionID: s.sessionID, stepID: (s.step as { stepID: string }).stepID, fields: { phone_number: "+15550100778" } }));
    expect(c.step).toMatchObject({ kind: "display", show: "code" });
    t += 90_000;
    l.sweep();
    await Bun.sleep(100);
    expect(calls(DELETE)).toHaveLength(0);
    // The person types the code on the phone; the background wait (or Beeper's own state) says complete.
    expect(fb.logins.scan()).toBe(true);
    await Bun.sleep(3500);
    l.sweep();
    await Bun.sleep(200);
    expect(calls(DELETE)).toHaveLength(0);
    expect(fb.state.accounts.length).toBe(before + 1);
    expect(l.active()).toBe(0);
    // Back in the browser a few minutes later: it is done, not "over" or expired.
    t += 3 * 60_000;
    l.sweep();
    expect(ok(await l.chat_login_poll({ sessionID: s.sessionID })).status).toBe("done");
  });

  test("Beeper finished before the idle or the run limit: asked first, never cancelled", async () => {
    let t = 1_000_000;
    const l = createChatLogin({ client: createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 }), windows: null, now: () => t, waitTimeoutMs: 60_000 });
    live.push(l);
    const s = ok(await l.chat_login_start({ app: "signal", macWindow: false }));
    expect(s.step).toMatchObject({ kind: "display", show: "qr" });
    // Scanned, and the run limit passes before anyone hears of it.
    expect(fb.logins.scan()).toBe(true);
    t += 11 * 60_000;
    l.sweep();
    await Bun.sleep(300);
    expect(calls(DELETE)).toHaveLength(0);
    expect(ok(await l.chat_login_poll({ sessionID: s.sessionID })).status).toBe("done");
  });

  test("a form asking for a code sent to the phone waits as long", async () => {
    let t = 1_000_000;
    const l = make({ now: () => t });
    const s = ok(await l.chat_login_start({ app: "telegram", flowID: "phone" }));
    const c = ok(await l.chat_login_submit({ sessionID: s.sessionID, stepID: (s.step as { stepID: string }).stepID, fields: { phone_number: "+15550100777" } }));
    expect(c.step).toMatchObject({ kind: "form", fields: [{ kind: "code" }] });
    t += 3 * 60_000;
    l.sweep();
    await Bun.sleep(100);
    expect(calls(DELETE)).toHaveLength(0);
    expect(l.active()).toBe(1);
  });
});
