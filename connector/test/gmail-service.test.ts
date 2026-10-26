// Gmail inside the real background service: the cloud hands over an account once (gmail_connect),
// the token goes to the secret store and the address to gmail.json, chats and events flow over the
// cloud link, the hello carries "gmail.v1" and "Gmail", and nothing on disk holds email content.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { FAKE_GOOGLE_CLIENT, OWNER_EMAIL, THREADS, startFakeGoogle, type RunningFakeGoogle } from "@j-inbox/fake-google";
import { gmailPollOverride, googleEndpoints, resolvePaths, saveConfig } from "../src/config.ts";
import { GmailAccounts } from "../src/gmail/accounts.ts";
import { FileSecretStore, KeychainStore, MemorySecretStore, gmailSecretName } from "../src/secrets.ts";
import { startService } from "../src/service.ts";
import { startFakeCloud } from "./helpers/fake-cloud.ts";

const TOKEN = "jid_" + "G".repeat(43);
let fb: FakeBeeper;
let fg: RunningFakeGoogle;
beforeAll(async () => {
  fb = await startFakeBeeper();
  fg = await startFakeGoogle();
});
afterAll(() => {
  fb.stop();
  fg.stop();
});
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  fb.reset();
  fg.google.reset();
});

async function boot() {
  const cloud = await startFakeCloud({ token: TOKEN, google: { url: fg.url, clientId: FAKE_GOOGLE_CLIENT.id, clientSecret: FAKE_GOOGLE_CLIENT.secret } });
  cleanup.push(() => cloud.stop());
  const dir = mkdtempSync(join(tmpdir(), "jinbox-gsvc-"));
  const paths = resolvePaths({ HOME: "/nonexistent", J_INBOX_CONFIG_DIR: dir });
  saveConfig(paths, { cloudURL: cloud.url, beeperURL: fb.url, deviceID: "dev_gsvc", deviceName: "Test Mac" });
  const secrets = new FileSecretStore(paths.secretsFile);
  await secrets.set("beeper-token", fb.token);
  await secrets.set("device-token", TOKEN);
  const env = { J_INBOX_GMAIL_API_URL: fg.url, J_INBOX_GOOGLE_OAUTH_URL: fg.url };
  const svc = await startService({ paths, secrets, version: "0.1.0", healthIntervalMs: 60_000, backoff: () => 30, env, gmailPollIntervalMs: 100 });
  cleanup.push(() => svc.stop(0));
  await cloud.waitFor(() => svc.link?.state.status === "connected", 4000, "connected");
  return { cloud, paths, svc, secrets, dir };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("Gmail in the service", () => {
  test("gmail_connect from the cloud, then Gmail chats, live events and remove_account", async () => {
    const { cloud, paths, secrets, dir } = await boot();
    expect((cloud.hello() as any).capabilities).toContain("gmail.v1");
    const rt = fg.google.issueRefreshToken(OWNER_EMAIL);
    const c = await cloud.req("gmail_connect", { email: OWNER_EMAIL, refreshToken: rt });
    expect(c.res).toMatchObject({ ok: true, data: { accountID: `gmail:${OWNER_EMAIL}`, connected: true } });
    expect(await secrets.get(gmailSecretName(OWNER_EMAIL))).toBe(rt);
    expect(JSON.parse(readFileSync(paths.gmailFile, "utf8"))).toMatchObject({ v: 1, accounts: [{ email: OWNER_EMAIL, status: "connected" }] });
    expect(statSync(paths.gmailFile).mode & 0o777).toBe(0o600);

    const list = await cloud.req("list_chats", { inbox: "primary", limit: 30 });
    expect(list.res.ok).toBe(true);
    const ids = (list.res.data as any).items.map((x: any) => x.id);
    expect(ids.some((id: string) => id.startsWith("gmail:"))).toBe(true);
    expect(ids.some((id: string) => !id.startsWith("gmail:"))).toBe(true);

    // The poller has a start point; new mail becomes an event on the cloud link.
    await Bun.sleep(250);
    fg.google.deliver(OWNER_EMAIL, { threadId: THREADS.lunch, from: "Alice <alice@example.com>", subject: "Re: Lunch on Friday?", text: "PRIVATE-MAIL-TEXT" });
    await cloud.waitFor(() => cloud.events().some((e: any) => e.kind === "message" && e.chatID === `gmail:${OWNER_EMAIL}:${THREADS.lunch}`), 4000, "gmail event");
    expect(JSON.stringify(cloud.events())).not.toContain("PRIVATE-MAIL-TEXT");

    const send = await cloud.req("send_message", { chatID: `gmail:${OWNER_EMAIL}:${THREADS.lunch}`, text: "SENT-MAIL-TEXT", idempotencyKey: "idem-svc-00001" });
    expect(send.res.ok).toBe(true);

    // Nothing the connector wrote to disk holds mail content or a Google token (secrets file aside).
    const audit = readFileSync(paths.auditFile, "utf8");
    expect(audit).toContain("gmail.connected");
    for (const f of filesUnder(dir)) {
      if (f === paths.secretsFile) continue;
      const text = readFileSync(f, "utf8");
      for (const s of ["PRIVATE-MAIL-TEXT", "SENT-MAIL-TEXT", "Lunch on Friday", "alice@example.com", rt, "ya29."]) expect(`${f}: ${text.includes(s) ? s : "clean"}`).toBe(`${f}: clean`);
    }

    const rm = await cloud.req("remove_account", { accountID: `gmail:${OWNER_EMAIL}` });
    expect(rm.res.ok).toBe(true);
    expect(fg.google.isRevoked(rt)).toBe(true);
    expect(await secrets.get(gmailSecretName(OWNER_EMAIL))).toBeNull();
    expect(JSON.parse(readFileSync(paths.gmailFile, "utf8")).accounts).toEqual([]);
  });

  test("Google endpoint overrides are for tests only (loopback, with J_INBOX_CONFIG_DIR)", () => {
    const test_ = resolvePaths({ HOME: "/h", J_INBOX_CONFIG_DIR: "/tmp/x" });
    const real = resolvePaths({ HOME: "/h" });
    expect(googleEndpoints({}, real)).toEqual({ gmailURL: "https://gmail.googleapis.com", oauthURL: "https://oauth2.googleapis.com" });
    expect(() => googleEndpoints({ J_INBOX_GMAIL_API_URL: "http://127.0.0.1:1" }, real)).toThrow(/only allowed/);
    expect(() => googleEndpoints({ J_INBOX_GMAIL_API_URL: "https://evil.example" }, test_)).toThrow(/loopback/);
    expect(googleEndpoints({ J_INBOX_GOOGLE_OAUTH_URL: "http://127.0.0.1:9/" }, test_).oauthURL).toBe("http://127.0.0.1:9");
    expect(gmailPollOverride({}, real)).toBeUndefined();
    expect(() => gmailPollOverride({ J_INBOX_GMAIL_POLL_MS: "500" }, real)).toThrow(/only allowed/);
    expect(gmailPollOverride({ J_INBOX_GMAIL_POLL_MS: "500" }, test_)).toBe(500);
    expect(() => gmailPollOverride({ J_INBOX_GMAIL_POLL_MS: "5" }, test_)).toThrow();
  });
});

describe("Gmail tokens in the secret stores", () => {
  test("names are gmail:<lower-case address>; anything else is refused", async () => {
    const m = new MemorySecretStore();
    await m.set(gmailSecretName("a.b+c@example.com"), "1//0fake-token");
    expect(await m.get("gmail:a.b+c@example.com")).toBe("1//0fake-token");
    for (const bad of ["gmail:", "gmail:A@example.com", 'gmail:a"b@example.com', "gmail:a b@example.com", "gmail:x", "other"]) {
      await expect(m.set(bad as any, "1//0fake-token")).rejects.toThrow();
      await expect(m.get(bad as any)).rejects.toThrow();
    }
    expect(() => gmailSecretName("Upper@Example.com")).toThrow();
  });
  test("the Keychain gets the token on stdin, never in argv", async () => {
    const calls: { cmd: string[]; stdin?: string }[] = [];
    const k = new KeychainStore({
      run: async (cmd, o = {}) => {
        calls.push({ cmd, stdin: o.stdin });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await k.set(gmailSecretName(OWNER_EMAIL), "1//0fake-secret-token");
    expect(calls[0]!.cmd.join(" ")).not.toContain("1//0fake-secret-token");
    expect(calls[0]!.stdin).toContain(`-a "gmail:${OWNER_EMAIL}"`);
  });
  test("gmail.json keeps addresses and status only; a corrupt file means no accounts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jinbox-gacc-"));
    const path = join(dir, "gmail.json");
    const a = new GmailAccounts({ path, secrets: new MemorySecretStore() });
    await a.add(OWNER_EMAIL, "1//0fake-token-xyz");
    a.setStatus(OWNER_EMAIL, "reconnect_required");
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("1//0fake");
    expect(new GmailAccounts({ path, secrets: new MemorySecretStore() }).list()).toEqual([{ email: OWNER_EMAIL, status: "reconnect_required", addedAt: expect.any(String) }]);
    await Bun.write(path, "{not json");
    expect(new GmailAccounts({ path, secrets: new MemorySecretStore() }).list()).toEqual([]);
  });
});
