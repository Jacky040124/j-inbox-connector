// Where the tokens live: the Beeper API token, the J-Inbox device token and one Google refresh
// token per Gmail account (`gmail:<address>`). On macOS they go to the login Keychain through
// /usr/bin/security; the value is written via `security -i` on stdin so it never shows up in a
// process list. Never in config files or logs.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeGmailAddress } from "@j-inbox/protocol";
import type { Runner } from "./runner.ts";

export type SecretName = "beeper-token" | "device-token" | `gmail:${string}`;
/** The fixed names; Gmail accounts add `gmail:<address>` (gmailSecretName). */
export const SECRET_NAMES: readonly SecretName[] = ["beeper-token", "device-token"];

/** Keychain account for a Gmail account's refresh token. */
export function gmailSecretName(email: string): SecretName {
  const v = normalizeGmailAddress(email);
  if (!v || v !== email) throw new Error("invalid Gmail address");
  return `gmail:${v}`;
}
export const KEYCHAIN_SERVICE = "build.jsuite.j-inbox";

export interface SecretStore {
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
}

/** Bearer-token alphabets only: no whitespace, quotes or backslashes (they would break `security -i` parsing). */
export function isStorableSecret(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9._~+/=:-]{8,4096}$/.test(v);
}

function checkName(name: string): asserts name is SecretName {
  if (SECRET_NAMES.includes(name as SecretName)) return;
  // gmail:<address>: only plain lower-case addresses (no quotes or spaces that could break `security -i`).
  if (typeof name === "string" && name.startsWith("gmail:") && normalizeGmailAddress(name.slice(6)) === name.slice(6)) return;
  throw new Error("unknown secret name");
}

const SECURITY = "/usr/bin/security";
const NOT_FOUND = 44;

export class KeychainStore implements SecretStore {
  private readonly run: Runner;
  private readonly service: string;

  constructor(o: { run: Runner; service?: string }) {
    this.run = o.run;
    this.service = o.service ?? KEYCHAIN_SERVICE;
  }

  async get(name: SecretName): Promise<string | null> {
    checkName(name);
    const r = await this.run([SECURITY, "find-generic-password", "-a", name, "-s", this.service, "-w"], { timeoutMs: 15_000 });
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(`Keychain read failed (security exit ${r.code}). Is the login keychain unlocked?`);
    const v = r.stdout.replace(/\r?\n$/, "");
    return v.length ? v : null;
  }

  async set(name: SecretName, value: string): Promise<void> {
    checkName(name);
    if (!isStorableSecret(value)) throw new Error("This token has characters J-Inbox cannot store safely.");
    const line = `add-generic-password -U -a "${name}" -s "${this.service}" -l "J-Inbox ${name}" -w "${value}"\n`;
    const r = await this.run([SECURITY, "-i"], { stdin: line, timeoutMs: 15_000 });
    if (r.code !== 0) throw new Error(`Keychain write failed (security exit ${r.code}). Is the login keychain unlocked?`);
  }

  async delete(name: SecretName): Promise<void> {
    checkName(name);
    const r = await this.run([SECURITY, "delete-generic-password", "-a", name, "-s", this.service], { timeoutMs: 15_000 });
    if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error(`Keychain delete failed (security exit ${r.code}).`);
  }
}

export class MemorySecretStore implements SecretStore {
  private m = new Map<SecretName, string>();
  async get(name: SecretName) {
    checkName(name);
    return this.m.get(name) ?? null;
  }
  async set(name: SecretName, value: string) {
    checkName(name);
    if (!isStorableSecret(value)) throw new Error("invalid secret");
    this.m.set(name, value);
  }
  async delete(name: SecretName) {
    checkName(name);
    this.m.delete(name);
  }
}

/** Development and test backend only (J_INBOX_SECRETS=file with J_INBOX_CONFIG_DIR): a 0600 JSON file. */
export class FileSecretStore implements SecretStore {
  constructor(private readonly path: string) {}

  private read(): Record<string, string> {
    try {
      const j = JSON.parse(readFileSync(this.path, "utf8"));
      return j && typeof j === "object" && !Array.isArray(j) ? j : {};
    } catch {
      return {};
    }
  }

  private write(v: Record<string, string>) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(v));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  async get(name: SecretName) {
    checkName(name);
    const v = this.read()[name];
    return isStorableSecret(v) ? v : null;
  }
  async set(name: SecretName, value: string) {
    checkName(name);
    if (!isStorableSecret(value)) throw new Error("invalid secret");
    this.write({ ...this.read(), [name]: value });
  }
  async delete(name: SecretName) {
    checkName(name);
    const all = this.read();
    if (!(name in all)) return;
    delete all[name];
    this.write(all);
  }
}
