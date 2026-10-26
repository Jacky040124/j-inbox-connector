// The single-file binary (bun build --compile, darwin-arm64): builds, prints help and version, and
// runs `status` against fake Beeper with the test secret backend (never the real Keychain).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { resolvePaths, saveConfig } from "../src/config.ts";
import { FileSecretStore } from "../src/secrets.ts";
import { CONNECTOR_VERSION } from "../src/version.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const PKG = resolve(import.meta.dir, "..");
const native = process.platform === "darwin" && process.arch === "arm64";
let bin = "";
let binDir = "";
let fb: FakeBeeper;
let cloud: FakeCloud;

beforeAll(async () => {
  fb = await startFakeBeeper();
  cloud = await startFakeCloud();
  if (!native) return;
  binDir = join(PKG, "dist", `test-${process.pid}-${Date.now()}`);
  bin = join(binDir, "j-inbox");
  mkdirSync(binDir, { recursive: true });
  // cwd = the output dir: bun 1.3 leaves a temp .bun-build file in the working directory.
  const b = Bun.spawnSync(["bun", "build", "--compile", "--target=bun-darwin-arm64", join(PKG, "src", "cli.ts"), "--outfile", bin], { cwd: binDir, stderr: "pipe", stdout: "pipe" });
  if (b.exitCode !== 0) throw new Error(`build failed: ${b.stderr.toString()}`);
}, 300_000);
afterAll(() => {
  fb?.stop();
  cloud?.stop();
  if (binDir) rmSync(binDir, { recursive: true, force: true });
});

// Async: the fakes run in this process, so a blocking spawn would starve them.
async function runBin(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn([bin, ...args], { env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home", ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

describe.if(native)("compiled binary", () => {
  test("--help lists the commands and exits 0", async () => {
    const r = await runBin(["--help"]);
    expect(r.code).toBe(0);
    for (const c of ["setup", "run", "status", "logs", "pair", "unpair", "doctor", "uninstall"]) expect(r.out).toContain(c);
  });
  test("--version", async () => {
    expect((await runBin(["--version"])).out.trim()).toBe(CONNECTOR_VERSION);
  });
  test("status against fake Beeper (test config dir + file secrets): Beeper ok, token valid, not paired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jinbox-bin-cfg-"));
    const paths = resolvePaths({ J_INBOX_CONFIG_DIR: dir });
    saveConfig(paths, { cloudURL: cloud.url, beeperURL: fb.url });
    await new FileSecretStore(paths.secretsFile).set("beeper-token", fb.token);
    const r = await runBin(["status", "--json"], { J_INBOX_CONFIG_DIR: dir, J_INBOX_SECRETS: "file" });
    const j = JSON.parse(r.out);
    expect(j.beeper).toMatchObject({ reachable: true, tokenValid: true });
    expect(j.paired).toBeNull();
    expect(r.code).toBe(1);
    expect(r.out + r.err).not.toContain(fb.token);
    const text = await runBin(["status"], { J_INBOX_CONFIG_DIR: dir, J_INBOX_SECRETS: "file" });
    expect(text.out).toContain("j-inbox pair");
  });
  // spec-r2-R2-SPEC-1: launchd's KeepAlive (SuccessfulExit=false) restarts only a non-zero exit, so
  // a plain `kill` (or Activity Monitor's Quit) must not exit 0.
  test("`run` as a real process: connects, answers through the whitelist, exits 143 on SIGTERM with close 1001", async () => {
    const token = "jid_" + "A".repeat(43);
    const dir = mkdtempSync(join(tmpdir(), "jinbox-bin-run-"));
    const paths = resolvePaths({ J_INBOX_CONFIG_DIR: dir });
    saveConfig(paths, { cloudURL: cloud.url, beeperURL: fb.url, deviceID: "dev_bin1", deviceName: "Bin Mac" });
    const secrets = new FileSecretStore(paths.secretsFile);
    await secrets.set("beeper-token", fb.token);
    await secrets.set("device-token", token);
    const before = cloud.connections;
    const p = Bun.spawn([bin, "run"], { env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home", J_INBOX_CONFIG_DIR: dir, J_INBOX_SECRETS: "file" }, stdout: "pipe", stderr: "pipe" });
    try {
      await cloud.waitFor(() => cloud.connections > before && cloud.open > 0 && cloud.hello(cloud.connections), 10_000, "binary connected");
      await Bun.sleep(100);
      const r = await cloud.req("list_chats", { limit: 2 });
      expect(r.res.ok).toBe(true);
      expect((await cloud.req("rm_rf", {})).res.error?.code).toBe("NOT_ALLOWED");
      p.kill("SIGTERM");
      expect(await p.exited).toBe(143);
      await cloud.waitFor(() => cloud.closeCodes.includes(1001), 3000, "close 1001");
      const log = await new Response(p.stderr).text();
      expect(log).not.toContain(token);
      expect(log).not.toContain(fb.token);
    } finally {
      p.kill("SIGKILL");
    }
  }, 30_000);
  test("an unknown command exits 2", async () => {
    expect((await runBin(["nope"])).code).toBe(2);
  });
});
