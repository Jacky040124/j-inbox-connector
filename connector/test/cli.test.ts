// The j-inbox CLI, driven in-process with fake programs (beeper, launchctl, security, pmset), fake
// Beeper and a fake cloud. Never the real Keychain, launchd, Beeper CLI or ~/Library.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { main, type CliDeps } from "../src/cli.ts";
import { resolvePaths, saveConfig, loadConfig } from "../src/config.ts";
import { LAUNCHD_LABEL } from "../src/launchd.ts";
import { FileSecretStore } from "../src/secrets.ts";
import type { RunOptions, Runner } from "../src/runner.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";
import { CONNECTOR_VERSION } from "../src/version.ts";

let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper();
});
afterAll(() => fb.stop());
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  fb.reset();
});

const DEVICE_TOKEN = "jid_" + "C".repeat(43);

type Programs = { calls: { cmd: string[]; o?: RunOptions }[]; run: Runner; pmsetSleep: number; beeperInstalled: boolean; beeperSetupExit: number };
function programs(): Programs {
  const p: Programs = {
    calls: [],
    pmsetSleep: 0,
    beeperInstalled: true,
    beeperSetupExit: 0,
    run: async (cmd, o) => {
      p.calls.push({ cmd, o });
      if (cmd[0] === "/bin/launchctl") return cmd[1] === "bootout" ? { code: 3, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" };
      if (cmd[0] === "/usr/bin/pmset") return { code: 0, stdout: `System-wide power settings:\nCurrently in use:\n sleep                ${p.pmsetSleep}\n displaysleep         10\n`, stderr: "" };
      if (cmd[0] === "beeper") {
        if (!p.beeperInstalled) return { code: 127, stdout: "", stderr: "beeper: not found" };
        if (cmd[1] === "--version") return { code: 0, stdout: "beeper-cli/0.6.2 darwin-arm64\n", stderr: "" };
        if (cmd[1] === "setup") return { code: p.beeperSetupExit, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd[0] === "/usr/bin/security") throw new Error("tests must not use the Keychain");
      return { code: 127, stdout: "", stderr: "not found" };
    },
  };
  return p;
}

/** The real Beeper Desktop listens on 23373 on this Mac: no test may ever reach it. */
const REAL_BEEPER_PORTS = new Set(["23373", "23374"]);
/** Hosts tests tried to reach that are not loopback (e.g. the production cloud URL). Never fetched. */
const blockedHosts: string[] = [];
const guardedFetch = (async (input: any, init?: any) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (REAL_BEEPER_PORTS.has(u.port)) throw new Error("test tried to reach a real Beeper port");
  if (u.hostname !== "127.0.0.1") {
    blockedHosts.push(u.hostname);
    throw new TypeError("fetch failed (tests only reach 127.0.0.1)");
  }
  return fetch(input, init);
}) as typeof fetch;

function harness(o: { cloud?: FakeCloud; stdin?: string; secretAnswers?: (string | null)[]; confirm?: boolean; inUse?: number[]; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jinbox-cli-"));
  const env: Record<string, string> = { HOME: "/nonexistent-home", J_INBOX_CONFIG_DIR: dir, J_INBOX_SECRETS: "file", ...o.env };
  const out: string[] = [];
  const err: string[] = [];
  const prog = programs();
  const answers = [...(o.secretAnswers ?? [])];
  const deps: CliDeps = {
    env,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    run: prog.run,
    fetchImpl: guardedFetch,
    prompt: {
      line: async () => null,
      secret: async () => (answers.length ? answers.shift()! : null),
      confirm: async () => o.confirm ?? true,
    },
    readStdin: async () => o.stdin ?? "",
    uid: 501,
    sleep: async () => {},
    isTTY: false,
    execPath: "/opt/homebrew/bin/j-inbox",
    mainPath: "/$bunfs/root/j-inbox",
    hostname: () => "Jackys-Mac-mini.local",
    portInUse: async (port) => (o.inUse ?? []).includes(port),
    onSignal: () => () => {},
  };
  const paths = resolvePaths(env);
  const secrets = new FileSecretStore(paths.secretsFile);
  const text = () => out.join("\n");
  return { deps, out, err, text, prog, paths, secrets, dir, cli: (...argv: string[]) => main(argv, deps) };
}

async function pairedHarness(cloud?: FakeCloud) {
  const h = harness({ cloud });
  saveConfig(h.paths, { cloudURL: cloud?.url ?? "https://inbox.jackyzhonghq.com", beeperURL: fb.url, deviceID: "dev_cli1", deviceName: "Test Mac" });
  await h.secrets.set("beeper-token", fb.token);
  await h.secrets.set("device-token", DEVICE_TOKEN);
  return h;
}

async function fakeCloud(withPairing = true) {
  const c = await startFakeCloud({ token: DEVICE_TOKEN });
  cleanup.push(() => c.stop());
  if (withPairing) {
    c.pair.startResponse = { status: 200, body: { deviceCode: "E".repeat(43), userCode: "MNPQ-RSTV", verificationURL: `${c.url}/pair`, verificationURLComplete: `${c.url}/pair`, expiresIn: 600, interval: 5 } };
    c.pair.pollQueue = [{ status: 200, body: { status: "pending" } }, { status: 200, body: { status: "approved", deviceID: "dev_new1", deviceToken: DEVICE_TOKEN, owner: { name: "Jacky", serverSlug: "jackyland" } } }];
  }
  return c;
}

describe("help and version", () => {
  test("--help lists every command; unknown command is a usage error (exit 2)", async () => {
    const h = harness();
    expect(await h.cli("--help")).toBe(0);
    for (const c of ["setup", "run", "status", "logs", "pair", "unpair", "doctor", "uninstall"]) expect(h.text()).toContain(c);
    expect(await h.cli("frobnicate")).toBe(2);
    expect(await h.cli()).toBe(0);
  });
  test("--version prints the connector version", async () => {
    const h = harness();
    expect(await h.cli("--version")).toBe(0);
    expect(h.text()).toContain(CONNECTOR_VERSION);
  });
  test("unknown flags are refused rather than ignored", async () => {
    const h = harness();
    expect(await h.cli("status", "--bogus")).toBe(2);
    expect(await h.cli("logs", "-n", "abc")).toBe(2);
  });
  test("the file secret backend is refused outside a test config dir", async () => {
    const h = harness();
    delete h.deps.env.J_INBOX_CONFIG_DIR;
    h.deps.env.HOME = h.dir;
    expect(await h.cli("status")).toBe(1);
    expect(h.err.join("\n")).toContain("J_INBOX_SECRETS");
  });
});

describe("status", () => {
  test("not set up: says what to do", async () => {
    const h = harness();
    saveConfig(h.paths, { cloudURL: "https://inbox.jackyzhonghq.com", beeperURL: "http://127.0.0.1:1" });
    await h.cli("status");
    expect(h.text()).toMatch(/Beeper token\s+missing/);
    expect(h.text()).toContain("j-inbox setup");
  });
  test("set up and paired, service not running: Beeper healthy, cloud not connected", async () => {
    const h = await pairedHarness();
    const code = await h.cli("status", "--json");
    const j = JSON.parse(h.text());
    expect(j.beeper).toMatchObject({ url: fb.url, reachable: true, tokenValid: true, version: expect.any(String) });
    expect(j.paired).toEqual({ deviceID: "dev_cli1", deviceName: "Test Mac" });
    expect(j.service).toMatchObject({ installed: false, running: false });
    expect(code).toBe(1);
    expect(h.text()).not.toContain(DEVICE_TOKEN);
    expect(h.text()).not.toContain(fb.token);
  });
  test("with the service running and connected: everything ok, exit 0", async () => {
    const cloud = await fakeCloud(false);
    const h = await pairedHarness(cloud);
    const { startService } = await import("../src/service.ts");
    const svc = await startService({ paths: h.paths, secrets: h.secrets, version: CONNECTOR_VERSION, healthIntervalMs: 60_000, log: () => {} });
    cleanup.push(() => svc.stop(0));
    await cloud.waitFor(() => svc.link?.state.status === "connected", 4000, "connected");
    await Bun.sleep(20);
    h.out.length = 0;
    await h.cli("status");
    expect(h.text()).toMatch(/Cloud\s+connected/);
    expect(h.text()).toMatch(/Beeper\s+ok/);
  });
  test("Beeper down and a rejected Beeper token are told apart", async () => {
    const h = await pairedHarness();
    await h.secrets.set("beeper-token", "wrong-token-123");
    await h.cli("status", "--json");
    expect(JSON.parse(h.text()).beeper).toMatchObject({ reachable: true, tokenValid: false });
    h.out.length = 0;
    saveConfig(h.paths, { ...loadConfig(h.paths), beeperURL: "http://127.0.0.1:1" });
    await h.cli("status", "--json");
    expect(JSON.parse(h.text()).beeper).toMatchObject({ reachable: false });
  });
  test("a corrupt config file is reported, not a crash", async () => {
    const h = harness();
    writeFileSync(h.paths.configFile, "{broken");
    expect(await h.cli("status")).toBe(1);
    expect(h.err.join("\n")).toContain("not valid JSON");
  });
});

describe("pair / unpair", () => {
  test("pair shows the code and URL, stores the token in the secret store and the id in config", async () => {
    const cloud = await fakeCloud();
    const h = harness();
    saveConfig(h.paths, { cloudURL: cloud.url, beeperURL: fb.url });
    expect(await h.cli("pair", "--name", "Studio Mac")).toBe(0);
    expect(h.text()).toContain("MNPQ-RSTV");
    expect(h.text()).toContain(`${cloud.url}/pair`);
    expect(h.text()).toContain("jackyland");
    expect(h.text()).not.toContain(DEVICE_TOKEN);
    expect(await h.secrets.get("device-token")).toBe(DEVICE_TOKEN);
    expect(loadConfig(h.paths)).toMatchObject({ deviceID: "dev_new1", deviceName: "Studio Mac" });
    expect(readFileSync(h.paths.configFile, "utf8")).not.toContain("jid_");
    expect((cloud.pair.starts[0] as any).deviceName).toBe("Studio Mac");
  });
  test("pair when already paired needs --force", async () => {
    const cloud = await fakeCloud();
    const h = await pairedHarness(cloud);
    expect(await h.cli("pair")).toBe(1);
    expect(h.text() + h.err.join("")).toContain("--force");
    expect(cloud.pair.starts.length).toBe(0);
    expect(await h.cli("pair", "--force")).toBe(0);
    expect(loadConfig(h.paths).deviceID).toBe("dev_new1");
  });
  test("a denied pairing leaves the computer unpaired (exit 1)", async () => {
    const cloud = await fakeCloud();
    cloud.pair.pollQueue = [{ status: 200, body: { status: "denied" } }];
    const h = harness();
    saveConfig(h.paths, { cloudURL: cloud.url, beeperURL: fb.url });
    expect(await h.cli("pair")).toBe(1);
    expect(await h.secrets.get("device-token")).toBeNull();
  });
  test("pair restarts the launchd agent when it is installed", async () => {
    const cloud = await fakeCloud();
    const h = harness();
    saveConfig(h.paths, { cloudURL: cloud.url, beeperURL: fb.url });
    await Bun.write(join(h.paths.launchAgentsDir, `${LAUNCHD_LABEL}.plist`), "<plist/>");
    await h.cli("pair");
    expect(h.prog.calls.some((c) => c.cmd.join(" ") === `/bin/launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`)).toBe(true);
  });
  test("unpair removes the token and device id and reminds to remove it in the web UI when the cloud cannot be reached", async () => {
    const h = await pairedHarness();
    expect(await h.cli("unpair")).toBe(0);
    expect(await h.secrets.get("device-token")).toBeNull();
    expect(loadConfig(h.paths).deviceID).toBeUndefined();
    expect(h.text()).toMatch(/web/i);
    expect(h.text()).toContain("Settings > Devices");
    expect(await h.cli("unpair")).toBe(0);
    expect(blockedHosts).toContain("inbox.jackyzhonghq.com");
  });
  test("unpair revokes the device in the cloud with its own token first (POST /pair/revoke)", async () => {
    const cloud = await fakeCloud();
    const h = await pairedHarness(cloud);
    expect(await h.cli("unpair")).toBe(0);
    expect(cloud.pair.revokes).toEqual([{ auth: `Bearer ${DEVICE_TOKEN}` }]);
    expect(cloud.tokens.has(DEVICE_TOKEN)).toBe(false);
    expect(await h.secrets.get("device-token")).toBeNull();
    expect(h.text()).toMatch(/revoked in the cloud/i);
    expect(h.text()).not.toContain("Settings > Devices");
    expect(h.text() + h.err.join("")).not.toContain(DEVICE_TOKEN);
  });
  test("unpair when the cloud refuses the token still forgets it locally and asks to remove it in the web page", async () => {
    const cloud = await fakeCloud();
    cloud.tokens.clear();
    const h = await pairedHarness(cloud);
    expect(await h.cli("unpair")).toBe(0);
    expect(cloud.pair.revokes.length).toBe(1);
    expect(await h.secrets.get("device-token")).toBeNull();
    expect(h.text()).toContain("Settings > Devices");
  });
  test("unpair with no token stored calls no cloud", async () => {
    const cloud = await fakeCloud();
    const h = harness();
    saveConfig(h.paths, { cloudURL: cloud.url, beeperURL: fb.url });
    expect(await h.cli("unpair")).toBe(0);
    expect(cloud.pair.revokes).toEqual([]);
  });
});

describe("logs", () => {
  test("shows who asked when the cloud said so", async () => {
    const h = harness();
    const { AuditLog } = await import("../src/audit.ts");
    const a = new AuditLog({ path: h.paths.auditFile });
    a.request({ action: "read_chat", ok: true, ms: 9, caller: { type: "agent", name: "龙虾" } });
    a.request({ action: "send_message", ok: true, ms: 9, caller: { type: "human" } });
    a.request({ action: "status", ok: true, ms: 9 });
    expect(await h.cli("logs")).toBe(0);
    const lines = h.out.join("\n").trim().split("\n");
    expect(lines[0]).toContain("agent 龙虾");
    expect(lines[1]).toContain("human");
    expect(lines[2]).not.toMatch(/agent|human/);
  });
  test("shows recent audit entries (metadata only); -n limits; --json is machine readable", async () => {
    const h = harness();
    const { AuditLog } = await import("../src/audit.ts");
    const a = new AuditLog({ path: h.paths.auditFile });
    for (let i = 0; i < 5; i++) a.request({ action: "send_message", ok: i % 2 === 0, ...(i % 2 ? { code: "UNKNOWN_OUTCOME" as const } : {}), ms: 100 + i });
    expect(await h.cli("logs", "-n", "3")).toBe(0);
    const lines = h.out.join("\n").trim().split("\n");
    expect(lines.length).toBe(3);
    expect(lines[2]).toContain("send_message");
    h.out.length = 0;
    await h.cli("logs", "--json");
    expect(h.text().trim().split("\n").map((l) => JSON.parse(l)).length).toBe(5);
  });
  test("no log yet: a friendly message", async () => {
    const h = harness();
    expect(await h.cli("logs")).toBe(0);
    expect(h.text()).toMatch(/No activity/);
  });
});

describe("doctor", () => {
  test("reports each problem with a fix, and fails when Beeper is unreachable", async () => {
    const h = harness();
    saveConfig(h.paths, { cloudURL: "http://127.0.0.1:1", beeperURL: "http://127.0.0.1:1" });
    h.prog.pmsetSleep = 10;
    expect(await h.cli("doctor")).toBe(1);
    const t = h.text();
    expect(t).toMatch(/\[fail\].*Beeper token/);
    expect(t).toMatch(/\[fail\].*not paired/i);
    expect(t).toMatch(/\[warn\].*sleep/i);
    expect(t).toContain("j-inbox pair");
  });
  test("all good: exit 0 (with the service running and connected)", async () => {
    const cloud = await fakeCloud(false);
    const h = await pairedHarness(cloud);
    await Bun.write(join(h.paths.launchAgentsDir, `${LAUNCHD_LABEL}.plist`), "<plist/>");
    const { startService } = await import("../src/service.ts");
    const svc = await startService({ paths: h.paths, secrets: h.secrets, version: CONNECTOR_VERSION, healthIntervalMs: 60_000, log: () => {} });
    cleanup.push(() => svc.stop(0));
    await cloud.waitFor(() => svc.link?.state.status === "connected", 4000, "connected");
    await Bun.sleep(20);
    const code = await h.cli("doctor", "--json");
    const j = JSON.parse(h.text());
    expect(j.checks.filter((c: any) => c.level === "fail")).toEqual([]);
    expect(code).toBe(0);
  });
  test("a revoked computer is diagnosed with the fix", async () => {
    const h = await pairedHarness();
    writeFileSync(h.paths.stateFile, JSON.stringify({ v: 1, pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cloud: { status: "stopped", since: new Date().toISOString(), closeCode: 4403, reason: "revoked" }, beeper: { reachable: true, version: "x" } }));
    await h.cli("doctor");
    expect(h.text()).toMatch(/\[fail\].*removed/i);
  });
});

describe("setup", () => {
  test("Desktop engine: token from stdin is verified, stored, config written, paired, agent installed", async () => {
    const cloud = await fakeCloud();
    const h = harness({ stdin: fb.token + "\n" });
    const code = await h.cli("setup", "--engine", "desktop", "--beeper-url", fb.url, "--beeper-token-stdin", "--cloud-url", cloud.url, "--yes");
    expect(code).toBe(0);
    expect(await h.secrets.get("beeper-token")).toBe(fb.token);
    expect(await h.secrets.get("device-token")).toBe(DEVICE_TOKEN);
    expect(loadConfig(h.paths)).toMatchObject({ cloudURL: cloud.url, beeperURL: fb.url, engine: "desktop", deviceID: "dev_new1" });
    const plist = readFileSync(join(h.paths.launchAgentsDir, `${LAUNCHD_LABEL}.plist`), "utf8");
    expect(plist).toContain("<string>/opt/homebrew/bin/j-inbox</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain(`<string>${h.dir}</string>`);
    expect(plist).not.toContain(fb.token);
    expect(h.prog.calls.some((c) => c.cmd[0] === "/bin/launchctl" && c.cmd[1] === "bootstrap")).toBe(true);
    expect(h.prog.calls.filter((c) => c.cmd[0] === "beeper")).toEqual([]);
    expect(h.text()).not.toContain(fb.token);
  });
  test("a rejected token is asked again (interactive), then accepted", async () => {
    const cloud = await fakeCloud();
    const h = harness({ secretAnswers: ["wrong-token-1234", fb.token] });
    h.deps.isTTY = true;
    expect(await h.cli("setup", "--engine", "desktop", "--beeper-url", fb.url, "--cloud-url", cloud.url, "--no-service", "--yes")).toBe(0);
    expect(h.text()).toMatch(/rejected/i);
    expect(await h.secrets.get("beeper-token")).toBe(fb.token);
  });
  test("a token Beeper rejects is never stored", async () => {
    const h = harness({ stdin: "wrong-token-1234" });
    expect(await h.cli("setup", "--engine", "desktop", "--beeper-url", fb.url, "--beeper-token-stdin", "--skip-pair", "--no-service", "--yes")).toBe(1);
    expect(await h.secrets.get("beeper-token")).toBeNull();
  });
  test("Server engine: installs Beeper Server through the beeper CLI (mocked) on the chosen port", async () => {
    const cloud = await fakeCloud();
    const h = harness({ stdin: fb.token });
    const code = await h.cli("setup", "--engine", "server", "--beeper-port", String(fb.port), "--beeper-token-stdin", "--cloud-url", cloud.url, "--no-service", "--yes");
    expect(code).toBe(0);
    const beeper = h.prog.calls.filter((c) => c.cmd[0] === "beeper").map((c) => c.cmd.join(" "));
    expect(beeper).toEqual(["beeper --version", `beeper targets add server j-inbox --port ${fb.port}`, "beeper setup --server --install --target j-inbox", "beeper targets enable j-inbox"]);
    expect(h.prog.calls.find((c) => c.cmd[1] === "setup")!.o?.inherit).toBe(true);
    expect(loadConfig(h.paths)).toMatchObject({ engine: "server", beeperURL: fb.url });
  });
  test("Server engine picks 23374 when Beeper Desktop holds 23373 (no HTTP probe, only the port check)", async () => {
    const h = harness({ stdin: "irrelevant-token", inUse: [23373] });
    h.prog.beeperSetupExit = 9; // stop right after the install step
    await h.cli("setup", "--engine", "server", "--beeper-token-stdin", "--yes");
    expect(h.prog.calls.map((c) => c.cmd.join(" "))).toContain("beeper targets add server j-inbox --port 23374");
  });
  test("Server engine without the beeper CLI: explains how to install it and stops", async () => {
    const h = harness({ confirm: false });
    h.prog.beeperInstalled = false;
    expect(await h.cli("setup", "--engine", "server", "--yes")).toBe(1);
    expect(h.text() + h.err.join("\n")).toContain("brew install beeper/tap/cli");
  });
  test("beeper setup failing stops the wizard before anything is stored", async () => {
    const h = harness({ stdin: fb.token });
    h.prog.beeperSetupExit = 3;
    expect(await h.cli("setup", "--engine", "server", "--beeper-token-stdin", "--yes")).toBe(1);
    expect(await h.secrets.get("beeper-token")).toBeNull();
  });
  test("refuses a non-loopback Beeper URL", async () => {
    const h = harness({ stdin: fb.token });
    expect(await h.cli("setup", "--engine", "desktop", "--beeper-url", "http://10.0.0.2:23373", "--beeper-token-stdin", "--yes")).toBe(1);
  });
  test("warns when the Mac is set to sleep", async () => {
    const cloud = await fakeCloud();
    const h = harness({ stdin: fb.token });
    h.prog.pmsetSleep = 15;
    await h.cli("setup", "--engine", "desktop", "--beeper-url", fb.url, "--beeper-token-stdin", "--cloud-url", cloud.url, "--no-service", "--yes");
    expect(h.text()).toMatch(/sleep/i);
  });
});

describe("uninstall", () => {
  test("removes the agent, both tokens and the J-Inbox directories; leaves Beeper alone", async () => {
    const h = await pairedHarness();
    await Bun.write(join(h.paths.launchAgentsDir, `${LAUNCHD_LABEL}.plist`), "<plist/>");
    await Bun.write(h.paths.auditFile, "");
    expect(await h.cli("uninstall", "--yes")).toBe(0);
    expect(existsSync(join(h.paths.launchAgentsDir, `${LAUNCHD_LABEL}.plist`))).toBe(false);
    expect(await new FileSecretStore(h.paths.secretsFile).get("beeper-token")).toBeNull();
    expect(existsSync(h.paths.configFile)).toBe(false);
    expect(existsSync(h.paths.logDir)).toBe(false);
    expect(h.prog.calls.filter((c) => c.cmd[0] === "beeper")).toEqual([]);
    expect(h.text()).toContain("beeper targets remove j-inbox");
  });
  test("asks first without --yes, and does nothing when declined", async () => {
    const h = await pairedHarness();
    h.deps.prompt.confirm = async () => false;
    h.deps.isTTY = true;
    expect(await h.cli("uninstall")).toBe(1);
    expect(existsSync(h.paths.configFile)).toBe(true);
  });
  test("revokes the device in the cloud before removing the token", async () => {
    const cloud = await fakeCloud();
    const h = await pairedHarness(cloud);
    expect(await h.cli("uninstall", "--yes")).toBe(0);
    expect(cloud.pair.revokes).toEqual([{ auth: `Bearer ${DEVICE_TOKEN}` }]);
    expect(h.text()).toMatch(/revoked in the cloud/i);
    expect(h.text()).not.toContain("Settings > Devices");
  });
  test("--keep-config keeps the config file", async () => {
    const h = await pairedHarness();
    expect(await h.cli("uninstall", "--yes", "--keep-config")).toBe(0);
    expect(existsSync(h.paths.configFile)).toBe(true);
    expect(await new FileSecretStore(h.paths.secretsFile).get("device-token")).toBeNull();
  });
});

describe("run", () => {
  test("unpaired: exits 0 with a message (launchd will not restart it)", async () => {
    const h = harness();
    expect(await h.cli("run")).toBe(0);
    expect(h.err.join("\n")).toContain("not paired");
  });
  test("runs until a signal, then shuts down gracefully and exits 128 + signal (launchd restarts it)", async () => {
    const cloud = await fakeCloud(false);
    const h = await pairedHarness(cloud);
    let fire: ((sig?: string) => void) | null = null;
    h.deps.onSignal = (cb) => ((fire = cb), () => {});
    const p = h.cli("run");
    await cloud.waitFor(() => cloud.open === 1 && cloud.hello(), 4000, "connected");
    await Bun.sleep(50);
    fire!("SIGTERM");
    expect(await p).toBe(143);
    await cloud.waitFor(() => cloud.open === 0, 2000, "closed");
    expect(cloud.closeCodes).toContain(1001);
  });
  // stability-r1-R1-STAB-5: a second `run` for the same config dir must not start (it would take
  // over the cloud connection and rewrite the idempotency journal), and must not exit 0.
  test("a second run while one is running exits non-zero with a clear message; the first keeps its connection", async () => {
    const cloud = await fakeCloud(false);
    const h = await pairedHarness(cloud);
    let fire: (() => void) | null = null;
    h.deps.onSignal = (cb) => ((fire = cb), () => {});
    const first = h.cli("run");
    await cloud.waitFor(() => cloud.open === 1 && cloud.hello(), 4000, "connected");
    const errBefore = h.err.length;
    const second = await h.cli("run");
    expect(second).not.toBe(0);
    expect(h.err.slice(errBefore).join("\n")).toMatch(/already running.*pid \d+/i);
    expect(cloud.connections).toBe(1);
    fire!();
    expect(await first).toBe(143);
    // the lock was released: a later run starts
    let fire2: ((sig?: string) => void) | null = null;
    h.deps.onSignal = (cb) => ((fire2 = cb), () => {});
    const third = h.cli("run");
    await cloud.waitFor(() => cloud.connections === 2 && cloud.open === 1, 4000, "third connected");
    fire2!("SIGINT");
    expect(await third).toBe(130);
  });
});
