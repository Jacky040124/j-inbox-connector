// Paths and config: overridable for tests, no secrets in config, Beeper only on loopback,
// cloud only over https (or a loopback dev server).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CLOUD_URL, loadConfig, resolvePaths, saveConfig, validateBeeperURL, validateCloudURL } from "../src/config.ts";

describe("resolvePaths", () => {
  test("defaults: ~/.config/j-inbox, Application Support, Logs, LaunchAgents", () => {
    const p = resolvePaths({ HOME: "/Users/t" });
    expect(p.configDir).toBe("/Users/t/.config/j-inbox");
    expect(p.dataDir).toBe("/Users/t/Library/Application Support/j-inbox");
    expect(p.logDir).toBe("/Users/t/Library/Logs/j-inbox");
    expect(p.launchAgentsDir).toBe("/Users/t/Library/LaunchAgents");
    expect(p.testMode).toBe(false);
  });
  test("J_INBOX_CONFIG_DIR puts everything (including the LaunchAgents dir) under it", () => {
    const p = resolvePaths({ HOME: "/Users/t", J_INBOX_CONFIG_DIR: "/tmp/x" });
    expect(p.configDir).toBe("/tmp/x");
    expect(p.dataDir).toBe("/tmp/x/data");
    expect(p.logDir).toBe("/tmp/x/logs");
    expect(p.launchAgentsDir).toBe("/tmp/x/LaunchAgents");
    expect(p.testMode).toBe(true);
  });
  test("relative or empty overrides are refused", () => {
    expect(() => resolvePaths({ HOME: "/Users/t", J_INBOX_CONFIG_DIR: "rel/dir" })).toThrow();
    expect(() => resolvePaths({})).toThrow();
  });
});

describe("URL rules", () => {
  test("Beeper must be loopback http(s)", () => {
    expect(validateBeeperURL("http://127.0.0.1:23373")).toBe("http://127.0.0.1:23373");
    expect(validateBeeperURL("http://localhost:23374/")).toBe("http://localhost:23374");
    for (const bad of ["http://192.168.1.2:23373", "https://evil.example", "file:///x", "http://127.0.0.1.evil.com:1", "http://user:pw@127.0.0.1:1", "javascript:alert(1)", ""]) expect(() => validateBeeperURL(bad)).toThrow();
  });
  test("cloud must be https, or http on loopback", () => {
    expect(validateCloudURL("https://inbox.jackyzhonghq.com")).toBe("https://inbox.jackyzhonghq.com");
    expect(validateCloudURL("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    for (const bad of ["http://inbox.jackyzhonghq.com", "ftp://x", "https://u:p@x.com", "https://x.com/path?q=1"]) expect(() => validateCloudURL(bad)).toThrow();
    expect(DEFAULT_CLOUD_URL).toBe("https://inbox.jackyzhonghq.com");
  });
});

describe("config file", () => {
  test("round-trips, 0600, never stores token-looking fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "jinbox-cfg-"));
    const paths = resolvePaths({ HOME: "/Users/t", J_INBOX_CONFIG_DIR: dir });
    saveConfig(paths, { cloudURL: "http://127.0.0.1:8787", beeperURL: "http://127.0.0.1:23374", deviceID: "dev_1", deviceName: "Jacky's Mac mini", engine: "server" });
    expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
    expect(loadConfig(paths)).toEqual({ cloudURL: "http://127.0.0.1:8787", beeperURL: "http://127.0.0.1:23374", deviceID: "dev_1", deviceName: "Jacky's Mac mini", engine: "server" });
    expect(() => saveConfig(paths, { cloudURL: DEFAULT_CLOUD_URL, beeperURL: "http://127.0.0.1:23373", deviceToken: "jid_x" } as any)).toThrow();
    expect(readFileSync(paths.configFile, "utf8")).not.toContain("jid_");
  });
  test("missing file gives defaults; corrupt or hostile file is an error, not silently trusted", () => {
    const dir = mkdtempSync(join(tmpdir(), "jinbox-cfg-"));
    const paths = resolvePaths({ HOME: "/Users/t", J_INBOX_CONFIG_DIR: dir });
    expect(loadConfig(paths)).toEqual({ cloudURL: DEFAULT_CLOUD_URL, beeperURL: "http://127.0.0.1:23373" });
    writeFileSync(paths.configFile, "{nope");
    expect(() => loadConfig(paths)).toThrow();
    writeFileSync(paths.configFile, JSON.stringify({ v: 1, cloudURL: DEFAULT_CLOUD_URL, beeperURL: "http://10.0.0.5:23373" }));
    expect(() => loadConfig(paths)).toThrow(/127\.0\.0\.1/);
    writeFileSync(paths.configFile, JSON.stringify({ v: 1, cloudURL: DEFAULT_CLOUD_URL, beeperURL: "http://127.0.0.1:23373", deviceID: "bad id <x>" }));
    expect(() => loadConfig(paths)).toThrow();
  });
});
