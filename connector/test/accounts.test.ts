// status.accounts details and remove_account (owner-only; the cloud keeps agents out), against fake Beeper.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { parseActionResult } from "@j-inbox/protocol";
import { createBeeperClient } from "../src/beeper-client.ts";
import { createActions } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";
import { mapAccount } from "../src/beeper-map.ts";

let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper();
});
afterAll(() => fb.stop());
afterEach(() => fb.reset());

const make = () => createActions(createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 }), { assets: new AssetAllowlist() });

describe("status.accounts", () => {
  test("carry who you are on each network and whether the web page may remove it", async () => {
    const r = await make().status({});
    if (!r.ok) throw new Error(r.error.code);
    expect(parseActionResult("status", r.data).ok).toBe(true);
    const by = Object.fromEntries(r.data.accounts.map((a) => [a.accountID, a]));
    expect(by.matrix).toMatchObject({ network: "Beeper", removable: false });
    expect(by.instagramgo).toMatchObject({ removable: true });
    expect(by.instagramgo!.name).toBeTruthy();
  });
  test("mapAccount: names are single-line and capped; no loginID means not removable", () => {
    const a = mapAccount({ accountID: "x", loginID: "l", bridge: { id: "b", type: "x" }, status: "reconnect_required", statusText: "Sign in\nagain", user: { fullName: "A\u0000B " + "z".repeat(500) } })!;
    expect(a.name!.includes("\n") || a.name!.includes("\u0000")).toBe(false);
    expect(a.name!.length).toBeLessThanOrEqual(256);
    expect(a.statusText).toBe("Sign in again");
    expect(mapAccount({ accountID: "y", status: "connected", user: {} })!.removable).toBe(false);
  });
});

describe("remove_account", () => {
  test("a cloud account is removed on all devices and is gone from status", async () => {
    const a = make();
    const r = await a.remove_account({ accountID: "instagramgo" });
    if (!r.ok) throw new Error(r.error.code);
    expect(r.data).toEqual({ accountID: "instagramgo", removed: true, scope: "all-devices", affectedAccountIDs: ["instagramgo"] });
    expect(fb.state.calls.find((c) => c.route === "POST /v1/bridges/{bridgeID}/logins/{loginID}/remove")?.body).toEqual({ scope: "all-devices" });
    const s = await a.status({});
    expect(s.ok && s.data.accounts.some((x) => x.accountID === "instagramgo")).toBe(false);
  });
  test("a local bridge account is removed from this device only (the scope Beeper offers)", async () => {
    const r = await make().remove_account({ accountID: "local-whatsapp_ba_FAKEwa0001" });
    expect(r.ok && r.data.scope).toBe("current-device");
  });
  test("the Beeper account itself can't be removed, and Beeper is never asked to", async () => {
    const r = await make().remove_account({ accountID: "matrix" });
    expect(r.ok ? "ok" : r.error.code).toBe("NOT_ALLOWED");
    expect(fb.state.calls.filter((c) => c.route.includes("/remove"))).toEqual([]);
  });
  test("an unknown account is NOT_FOUND", async () => {
    const r = await make().remove_account({ accountID: "nope" });
    expect(r.ok ? "ok" : r.error.code).toBe("NOT_FOUND");
  });
});
