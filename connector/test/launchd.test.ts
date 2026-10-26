// launchd agent: plist generation and install/uninstall against a temp LaunchAgents dir and a fake
// launchctl. Never touches the real ~/Library/LaunchAgents.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHD_LABEL, generatePlist, installAgent, isAgentInstalled, uninstallAgent } from "../src/launchd.ts";
import type { Runner } from "../src/runner.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "jinbox-launchd-"));
function fakeLaunchctl(o: { failBootstrap?: boolean } = {}) {
  const calls: string[][] = [];
  const run: Runner = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] !== "/bin/launchctl") return { code: 127, stdout: "", stderr: "" };
    if (cmd[1] === "bootstrap" && o.failBootstrap) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
    if (cmd[1] === "bootout") return { code: 3, stdout: "", stderr: "No such process" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

describe("generatePlist", () => {
  const plist = generatePlist({ program: ["/opt/homebrew/bin/j-inbox", "run"], logDir: "/Users/t/Library/Logs/j-inbox", env: { J_INBOX_CONFIG_DIR: "/Users/t/x & <y>" } });
  test("restarts on crash but not after a clean exit, throttled, starts at login", () => {
    expect(plist).toContain(`<key>Label</key>\n  <string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    expect(plist).toContain("<string>/Users/t/Library/Logs/j-inbox/service.log</string>");
    expect(plist).toContain("<string>/opt/homebrew/bin/j-inbox</string>\n    <string>run</string>");
  });
  test("escapes XML and is well-formed (plutil-style check: balanced, no raw & or <)", () => {
    expect(plist).toContain("/Users/t/x &amp; &lt;y&gt;");
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
  test.if(process.platform === "darwin")("plutil -lint accepts it", async () => {
    const f = join(tmp(), "a.plist");
    await Bun.write(f, plist);
    const p = Bun.spawnSync(["/usr/bin/plutil", "-lint", f]);
    expect(p.exitCode).toBe(0);
  });
  test("never puts a token in the plist", () => {
    expect(() => generatePlist({ program: ["/bin/j"], logDir: "/l", env: { J_INBOX_DEVICE_TOKEN: "jid_x" } })).toThrow();
    expect(() => generatePlist({ program: ["/bin/j"], logDir: "/l", env: { X: "jid_" + "A".repeat(43) } })).toThrow();
  });
  test("refuses relative program paths and control characters", () => {
    expect(() => generatePlist({ program: ["j-inbox", "run"], logDir: "/l" })).toThrow();
    expect(() => generatePlist({ program: ["/bin/j\u0000"], logDir: "/l" })).toThrow();
  });
});

describe("install / uninstall", () => {
  test("writes the plist (0644) into the given dir and bootstraps it in the gui domain", async () => {
    const dir = tmp();
    const f = fakeLaunchctl();
    const r = await installAgent({ launchAgentsDir: dir, plist: "<plist/>", uid: 501, run: f.run });
    const path = join(dir, `${LAUNCHD_LABEL}.plist`);
    expect(r.path).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("<plist/>");
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(f.calls).toEqual([
      ["/bin/launchctl", "bootout", `gui/501/${LAUNCHD_LABEL}`],
      ["/bin/launchctl", "bootstrap", "gui/501", path],
      ["/bin/launchctl", "kickstart", `gui/501/${LAUNCHD_LABEL}`],
    ]);
    expect(await isAgentInstalled(dir)).toBe(true);
  });
  test("a failed bootstrap is reported (and the file stays for doctor to inspect)", async () => {
    const dir = tmp();
    await expect(installAgent({ launchAgentsDir: dir, plist: "<plist/>", uid: 501, run: fakeLaunchctl({ failBootstrap: true }).run })).rejects.toThrow(/launchctl/);
  });
  test("uninstall boots it out and removes the file; twice is fine", async () => {
    const dir = tmp();
    const f = fakeLaunchctl();
    await installAgent({ launchAgentsDir: dir, plist: "<plist/>", uid: 501, run: f.run });
    await uninstallAgent({ launchAgentsDir: dir, uid: 501, run: f.run });
    expect(existsSync(join(dir, `${LAUNCHD_LABEL}.plist`))).toBe(false);
    await uninstallAgent({ launchAgentsDir: dir, uid: 501, run: f.run });
    expect(await isAgentInstalled(dir)).toBe(false);
  });
});
