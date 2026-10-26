// What every command gets: injected dependencies (so tests never touch the real Keychain,
// launchd, Beeper CLI or home directory), resolved paths, the secret store and parsed flags.
import { AuditLog } from "../audit.ts";
import type { Paths } from "../config.ts";
import type { Prompt } from "../prompt.ts";
import type { Runner } from "../runner.ts";
import { FileSecretStore, KeychainStore, type SecretStore } from "../secrets.ts";

export type CliDeps = {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  run: Runner;
  fetchImpl: typeof fetch;
  prompt: Prompt;
  readStdin: () => Promise<string>;
  uid: number;
  sleep: (ms: number) => Promise<void>;
  isTTY: boolean;
  /** process.execPath and Bun.main, to build the launchd command line. */
  execPath: string;
  mainPath: string;
  hostname: () => string;
  portInUse: (port: number) => Promise<boolean>;
  /** Call cb on SIGINT/SIGTERM; returns an unsubscribe function. */
  /** cb gets the signal name (SIGINT / SIGTERM). */
  onSignal: (cb: (signal?: string) => void) => () => void;
};

export type Flags = Record<string, string | boolean | undefined>;

export type Ctx = { deps: CliDeps; paths: Paths; secrets: SecretStore; flags: Flags; json: boolean; audit: AuditLog };

export class UsageError extends Error {}

export function secretStore(deps: CliDeps, paths: Paths): SecretStore {
  const kind = deps.env.J_INBOX_SECRETS;
  if (kind === "file") {
    if (!paths.testMode) throw new Error("J_INBOX_SECRETS=file is for tests only and needs J_INBOX_CONFIG_DIR. Tokens belong in the macOS Keychain.");
    return new FileSecretStore(paths.secretsFile);
  }
  if (kind !== undefined && kind !== "keychain") throw new Error("J_INBOX_SECRETS must be keychain (default) or file (tests).");
  return new KeychainStore({ run: deps.run });
}

/** The command launchd should run: the compiled binary, or bun + this script during development. */
export function serviceProgram(deps: CliDeps): string[] {
  return deps.mainPath.startsWith("/$bunfs/") || deps.mainPath === deps.execPath ? [deps.execPath, "run"] : [deps.execPath, deps.mainPath, "run"];
}

export function defaultDeviceName(hostname: string): string {
  const base = hostname.replace(/\.local\.?$/i, "").replace(/[^\p{L}\p{N} ._'-]/gu, " ").replace(/\s+/g, " ").trim();
  return (base || "Mac").slice(0, 64);
}
