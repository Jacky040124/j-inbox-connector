// Tokens live in the macOS Keychain via the `security` CLI. Tests drive KeychainStore against a
// fake runner (never the real Keychain) and check the secret never appears in argv.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore, KeychainStore, MemorySecretStore, isStorableSecret } from "../src/secrets.ts";
import type { RunResult, Runner } from "../src/runner.ts";

type Call = { cmd: string[]; stdin?: string };
function fakeSecurity() {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const run: Runner = async (cmd, o = {}): Promise<RunResult> => {
    calls.push({ cmd, stdin: o.stdin });
    expect(cmd[0]).toBe("/usr/bin/security");
    const arg = (flag: string, from: string[] = cmd) => from[from.indexOf(flag) + 1];
    if (cmd[1] === "-i") {
      // add-generic-password -U -a "acct" -s "svc" -w "value"
      const line = (o.stdin ?? "").trim();
      const toks = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
      expect(toks[0]).toBe("add-generic-password");
      items.set(`${arg("-s", toks)}|${arg("-a", toks)}`, arg("-w", toks)!);
      return { code: 0, stdout: "", stderr: "" };
    }
    const key = `${arg("-s")}|${arg("-a")}`;
    if (cmd[1] === "find-generic-password") return items.has(key) ? { code: 0, stdout: items.get(key)! + "\n", stderr: "" } : { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
    if (cmd[1] === "delete-generic-password") return items.delete(key) ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: "not found" };
    return { code: 1, stdout: "", stderr: "unknown" };
  };
  return { run, calls, items };
}

const TOKEN = "jid_" + "Q".repeat(43);

describe("KeychainStore", () => {
  test("set/get/delete round-trip through the security CLI", async () => {
    const f = fakeSecurity();
    const k = new KeychainStore({ run: f.run });
    expect(await k.get("device-token")).toBeNull();
    await k.set("device-token", TOKEN);
    expect(await k.get("device-token")).toBe(TOKEN);
    await k.delete("device-token");
    expect(await k.get("device-token")).toBeNull();
    await k.delete("device-token");
  });
  test("the secret is passed on stdin, never in argv (other processes can read argv)", async () => {
    const f = fakeSecurity();
    await new KeychainStore({ run: f.run }).set("beeper-token", "bpr_secret_value_123");
    for (const c of f.calls) expect(c.cmd.join(" ")).not.toContain("bpr_secret_value_123");
    expect(f.calls.some((c) => c.stdin?.includes("bpr_secret_value_123"))).toBe(true);
  });
  test("refuses values that could break out of the security -i command line", async () => {
    const k = new KeychainStore({ run: fakeSecurity().run });
    for (const bad of ['abc" -w "x', "abc\nadd-generic-password", "short", "has space inside", "x".repeat(5000), "tab\there", "quote'"]) await expect(k.set("beeper-token", bad)).rejects.toThrow();
  });
  test("refuses unknown secret names", async () => {
    const k = new KeychainStore({ run: fakeSecurity().run });
    await expect(k.set("other" as any, TOKEN)).rejects.toThrow();
  });
  test("security failures surface without leaking the secret", async () => {
    const run: Runner = async () => ({ code: 51, stdout: "", stderr: "User interaction is not allowed." });
    const err = await new KeychainStore({ run }).set("beeper-token", "bpr_secret_value_123").catch((e) => e as Error);
    expect(String(err)).toContain("Keychain");
    expect(String(err)).not.toContain("bpr_secret_value_123");
    await expect(new KeychainStore({ run }).get("beeper-token")).rejects.toThrow();
  });
  test("isStorableSecret accepts real token shapes", () => {
    expect(isStorableSecret(TOKEN)).toBe(true);
    expect(isStorableSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_+/=")).toBe(true);
    expect(isStorableSecret("")).toBe(false);
  });
});

describe("MemorySecretStore and FileSecretStore (test/dev backends)", () => {
  test("memory store round-trip", async () => {
    const m = new MemorySecretStore();
    await m.set("beeper-token", TOKEN);
    expect(await m.get("beeper-token")).toBe(TOKEN);
    await m.delete("beeper-token");
    expect(await m.get("beeper-token")).toBeNull();
  });
  test("file store is 0600 and survives a new instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jinbox-secrets-"));
    const path = join(dir, "secrets.json");
    await new FileSecretStore(path).set("device-token", TOKEN);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await new FileSecretStore(path).get("device-token")).toBe(TOKEN);
    writeFileSync(path, "garbage");
    expect(await new FileSecretStore(path).get("device-token")).toBeNull();
    expect(readFileSync(path, "utf8")).toBe("garbage");
  });
});
