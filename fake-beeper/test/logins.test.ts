// Bridges and sign-ins (src/logins.ts): what tests of the connector rely on, over HTTP like a client.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { LOGIN_SECRETS, startFakeBeeper, type FakeBeeper } from "../src/index.ts";

let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper({ controls: { loginWaitMs: 2000 } });
});
afterAll(() => fb.stop());
afterEach(() => fb.reset());

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(fb.url + path, { method, headers: { authorization: `Bearer ${fb.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const step = (b: string, s: { loginSessionID: string; currentStep: { stepID: string } }, body: unknown) => call("POST", `/v1/bridges/${b}/login-sessions/${s.loginSessionID}/steps/${encodeURIComponent(s.currentStep.stepID)}`, body);

describe("bridges", () => {
  test("each network's bridges, their accounts from /v1/accounts, and an account removed is gone from its bridge", async () => {
    const { body } = await call("GET", "/v1/bridges");
    const ig = body.items.filter((b: any) => b.network === "Instagram");
    expect(ig.map((b: any) => [b.id, b.provider])).toEqual([["local-instagram", "local"], ["instagramgo", "cloud"]]);
    expect(ig[1].accounts.map((a: any) => a.accountID)).toEqual(["instagramgo"]);
    fb.state.accounts = fb.state.accounts.filter((a) => a.accountID !== "instagramgo");
    expect((await call("GET", "/v1/bridges/instagramgo")).body.accounts).toEqual([]);
  });
});

describe("sign-ins", () => {
  test("a QR code: the wait call holds until the phone scans, then answers complete with the new account", async () => {
    const s = (await call("POST", "/v1/bridges/local-whatsapp/login-sessions", { flowID: "qr" })).body;
    expect(s.currentStep.display.data).toStartWith("fake-qr-secret:");
    const waiting = step("local-whatsapp", s, { type: "display_and_wait" });
    await Bun.sleep(100);
    expect(fb.logins.scan()).toBe(true);
    const done = (await waiting).body;
    expect(done.status).toBe("complete");
    expect(fb.state.accounts.some((a) => a.accountID === done.account.accountID)).toBe(true);
  });

  test("a wrong code answers the same step with an error; the right one completes", async () => {
    let s = (await call("POST", "/v1/bridges/local-telegram/login-sessions", { flowID: "phone" })).body;
    s = (await step("local-telegram", s, { type: "user_input", fields: { phone_number: "+15550100999" } })).body;
    const stepID = s.currentStep.stepID;
    const wrong = (await step("local-telegram", s, { type: "user_input", fields: { code: "1" } })).body;
    expect(wrong).toMatchObject({ status: "waiting_for_input", currentStep: { stepID }, error: { code: "FI.MAU.LOGIN_INVALID" } });
    expect((await step("local-telegram", wrong, { type: "user_input", fields: { code: LOGIN_SECRETS.telegramCode } })).body.status).toBe("complete");
  });

  test("the wrong step, the wrong type or a missing field is refused and changes nothing", async () => {
    const s = (await call("POST", "/v1/bridges/local-slack/login-sessions", {})).body;
    expect((await call("POST", `/v1/bridges/local-slack/login-sessions/${s.loginSessionID}/steps/other`, { type: "user_input", fields: { email: "a@example.com" } })).status).toBe(409);
    expect((await step("local-slack", s, { type: "cookies", fields: {} })).status).toBe(400);
    expect((await step("local-slack", s, { type: "user_input", fields: {} })).status).toBe(400);
    expect((await call("GET", `/v1/bridges/local-slack/login-sessions/${s.loginSessionID}`)).body.currentStep.stepID).toBe(s.currentStep.stepID);
  });

  test("cookies: the site's own values complete it, anything else fails it", async () => {
    const a = (await call("POST", "/v1/bridges/local-instagram/login-sessions", {})).body;
    expect((await step("local-instagram", a, { type: "cookies", fields: { sessionid: "x", csrftoken: "y" }, source: "webview" })).body.status).toBe("failed");
    const b = (await call("POST", "/v1/bridges/local-instagram/login-sessions", {})).body;
    expect((await step("local-instagram", b, { type: "cookies", fields: { sessionid: LOGIN_SECRETS.cookieValue, csrftoken: LOGIN_SECRETS.cookieValue }, lastURL: "https://example.test/", source: "webview" })).body.status).toBe("complete");
  });

  test("cancel, expiry and a busy bridge", async () => {
    const s = (await call("POST", "/v1/bridges/local-signal/login-sessions", {})).body;
    expect((await call("POST", "/v1/bridges/local-signal/login-sessions", {})).status).toBe(409);
    expect((await call("DELETE", `/v1/bridges/local-signal/login-sessions/${s.loginSessionID}`)).body).toEqual({ bridgeID: "local-signal", loginSessionID: s.loginSessionID, status: "cancelled" });
    const t = (await call("POST", "/v1/bridges/local-signal/login-sessions", {})).body;
    fb.logins.expire(t.loginSessionID);
    expect((await call("GET", `/v1/bridges/local-signal/login-sessions/${t.loginSessionID}`)).status).toBe(404);
    expect((await call("POST", "/v1/bridges/local-signal/login-sessions", {})).status).toBe(200);
  });

  test("a reconnect marks the account connected and adds none", async () => {
    fb.state.accounts = fb.state.accounts.map((a) => (a.accountID === "linkedin" ? { ...a, status: "reconnect_required" } : a));
    const n = fb.state.accounts.length;
    const s = (await call("POST", "/v1/bridges/linkedin/login-sessions", { accountID: "linkedin", loginID: "linkedin" })).body;
    expect(s).toMatchObject({ accountID: "linkedin", loginID: "linkedin", currentStep: { type: "cookies" } });
    await step("linkedin", s, { type: "cookies", fields: { sessionid: LOGIN_SECRETS.cookieValue, csrftoken: LOGIN_SECRETS.cookieValue } });
    expect(fb.state.accounts.length).toBe(n);
    expect(fb.state.accounts.find((a) => a.accountID === "linkedin")!.status).toBe("connected");
  });
});
