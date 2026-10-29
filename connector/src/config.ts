// Where the connector keeps things, and its (secret-free) config file.
//   config  ~/.config/j-inbox/config.json      cloud URL, Beeper URL, device id and name
//   data    ~/Library/Application Support/j-inbox   idempotency journal, asset allowlist (hashes), draft store, upload store, noise store
//   logs    ~/Library/Logs/j-inbox              audit.jsonl (metadata only), service.log
// J_INBOX_CONFIG_DIR moves all of it, including the LaunchAgents dir, under one directory (tests).
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ownId } from "@j-inbox/protocol";
import { parse } from "@j-inbox/protocol";

export const DEFAULT_CLOUD_URL = "https://inbox.jackyzhonghq.com";
export const DEFAULT_BEEPER_URL = "http://127.0.0.1:23373";

export type Paths = {
  configDir: string;
  configFile: string;
  stateFile: string;
  dataDir: string;
  logDir: string;
  auditFile: string;
  serviceLog: string;
  launchAgentsDir: string;
  secretsFile: string;
  idempotencyFile: string;
  assetsFile: string;
  /** Gmail accounts this connector runs (addresses and status; the tokens are in the Keychain). */
  gmailFile: string;
  /** Draft requests' instructions and drafts (drafts.ts): kept here, never in the cloud. */
  draftsFile: string;
  /** Files being sent (uploads.ts): kept here until sent, never in the cloud. */
  uploadsDir: string;
  /** The owner's definition of noise and the verdicts (noise/store.ts): kept here, never in the cloud. */
  noiseFile: string;
  /** Everything lives under J_INBOX_CONFIG_DIR. */
  testMode: boolean;
};

export function resolvePaths(env: Record<string, string | undefined>): Paths {
  const override = env.J_INBOX_CONFIG_DIR;
  const home = env.HOME;
  let configDir: string, dataDir: string, logDir: string, launchAgentsDir: string;
  if (override !== undefined) {
    if (!override || !isAbsolute(override)) throw new Error("J_INBOX_CONFIG_DIR must be an absolute path.");
    configDir = override;
    dataDir = join(override, "data");
    logDir = join(override, "logs");
    launchAgentsDir = join(override, "LaunchAgents");
  } else {
    if (!home || !isAbsolute(home)) throw new Error("HOME is not set.");
    configDir = join(home, ".config", "j-inbox");
    dataDir = join(home, "Library", "Application Support", "j-inbox");
    logDir = join(home, "Library", "Logs", "j-inbox");
    launchAgentsDir = join(home, "Library", "LaunchAgents");
  }
  return {
    configDir,
    configFile: join(configDir, "config.json"),
    stateFile: join(configDir, "state.json"),
    dataDir,
    logDir,
    auditFile: join(logDir, "audit.jsonl"),
    serviceLog: join(logDir, "service.log"),
    launchAgentsDir,
    secretsFile: join(configDir, "dev-secrets.json"),
    idempotencyFile: join(dataDir, "idempotency.json"),
    assetsFile: join(dataDir, "assets.json"),
    gmailFile: join(dataDir, "gmail.json"),
    draftsFile: join(dataDir, "drafts.json"),
    uploadsDir: join(dataDir, "uploads"),
    noiseFile: join(dataDir, "noise.json"),
    testMode: override !== undefined,
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function plainOrigin(raw: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${what} is not a valid URL.`);
  }
  if (u.username || u.password) throw new Error(`${what} must not contain a user name or password.`);
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new Error(`${what} must be just a scheme, host and port.`);
  return u;
}

/** The Beeper API must be on this computer: the token is sent to it in clear text. */
export function validateBeeperURL(raw: string): string {
  const u = plainOrigin(raw, "The Beeper URL");
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !LOOPBACK.has(u.hostname)) throw new Error("The Beeper URL must point at this computer, e.g. http://127.0.0.1:23373.");
  return u.origin;
}

export function validateCloudURL(raw: string): string {
  const u = plainOrigin(raw, "The cloud URL");
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return u.origin;
  throw new Error("The cloud URL must use https:// (http:// only for a local dev server on 127.0.0.1).");
}

export type Engine = "desktop" | "server";
export type Config = { cloudURL: string; beeperURL: string; deviceID?: string; deviceName?: string; engine?: Engine };
const KEYS = new Set(["cloudURL", "beeperURL", "deviceID", "deviceName", "engine"]);

function check(c: Record<string, unknown>): Config {
  for (const k of Object.keys(c)) if (!KEYS.has(k)) throw new Error(`Unknown config field "${k.slice(0, 32).replace(/[^\w-]/g, "?")}". Tokens are never stored in the config file.`);
  const out: Config = { cloudURL: validateCloudURL(String(c.cloudURL ?? DEFAULT_CLOUD_URL)), beeperURL: validateBeeperURL(String(c.beeperURL ?? DEFAULT_BEEPER_URL)) };
  if (c.deviceID !== undefined) {
    if (!parse(ownId, c.deviceID).ok) throw new Error("The config's deviceID is invalid. Run `j-inbox pair` again.");
    out.deviceID = c.deviceID as string;
  }
  if (c.deviceName !== undefined) {
    if (typeof c.deviceName !== "string" || c.deviceName.length < 1 || c.deviceName.length > 64 || /[\u0000-\u001f\u007f]/.test(c.deviceName)) throw new Error("The config's deviceName is invalid.");
    out.deviceName = c.deviceName;
  }
  if (c.engine !== undefined) {
    if (c.engine !== "desktop" && c.engine !== "server") throw new Error("The config's engine must be desktop or server.");
    out.engine = c.engine;
  }
  return out;
}

export function loadConfig(p: Paths): Config {
  let raw: string;
  try {
    raw = readFileSync(p.configFile, "utf8");
  } catch {
    return { cloudURL: DEFAULT_CLOUD_URL, beeperURL: DEFAULT_BEEPER_URL };
  }
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error(`${p.configFile} is not valid JSON. Fix or delete it, then run \`j-inbox setup\`.`);
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error(`${p.configFile} is not a config object.`);
  const { v, ...rest } = j as Record<string, unknown>;
  if (v !== 1) throw new Error(`${p.configFile} has an unknown version.`);
  return check(rest);
}

export function saveConfig(p: Paths, c: Config): void {
  const clean = check(c as Record<string, unknown>);
  writeAtomic(p.configFile, JSON.stringify({ v: 1, ...clean }, null, 2) + "\n");
}

export function writeAtomic(path: string, text: string, mode = 0o600): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, mode);
}

/**
 * Google endpoints. Real Google by default; J_INBOX_GMAIL_API_URL / J_INBOX_GOOGLE_OAUTH_URL may
 * point at a loopback fake, and only in test mode (J_INBOX_CONFIG_DIR set), like J_INBOX_SECRETS=file.
 */
export function googleEndpoints(env: Record<string, string | undefined>, p: Paths): { gmailURL: string; oauthURL: string } {
  const pick = (key: string, fallback: string) => {
    const v = env[key];
    if (v === undefined || v === "") return fallback;
    if (!p.testMode) throw new Error(`${key} is only allowed together with J_INBOX_CONFIG_DIR (tests and local development).`);
    const u = plainOrigin(v, key);
    if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) throw new Error(`${key} must be a loopback http:// URL.`);
    return u.origin;
  };
  return { gmailURL: pick("J_INBOX_GMAIL_API_URL", "https://gmail.googleapis.com"), oauthURL: pick("J_INBOX_GOOGLE_OAUTH_URL", "https://oauth2.googleapis.com") };
}

/**
 * TypeSafe's API (Jev, for noise): https://api.typesafe.ai, or J_INBOX_TYPESAFE_URL, a loopback fake,
 * only in test mode (J_INBOX_CONFIG_DIR set), like the Google endpoints.
 */
export function typesafeURL(env: Record<string, string | undefined>, p: Paths): string {
  const v = env.J_INBOX_TYPESAFE_URL;
  if (v === undefined || v === "") return "https://api.typesafe.ai";
  if (!p.testMode) throw new Error("J_INBOX_TYPESAFE_URL is only allowed together with J_INBOX_CONFIG_DIR (tests and local development).");
  const u = plainOrigin(v, "J_INBOX_TYPESAFE_URL");
  if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) throw new Error("J_INBOX_TYPESAFE_URL must be a loopback http:// URL.");
  return u.origin;
}

/** J_INBOX_GMAIL_POLL_MS (tests only, with J_INBOX_CONFIG_DIR): a shorter Gmail history poll. undefined: the default. */
export function gmailPollOverride(env: Record<string, string | undefined>, p: Paths): number | undefined {
  const v = env.J_INBOX_GMAIL_POLL_MS;
  if (v === undefined || v === "") return undefined;
  if (!p.testMode) throw new Error("J_INBOX_GMAIL_POLL_MS is only allowed together with J_INBOX_CONFIG_DIR (tests and local development).");
  const n = Number(v);
  if (!Number.isInteger(n) || n < 200 || n > 600_000) throw new Error("J_INBOX_GMAIL_POLL_MS must be 200-600000.");
  return n;
}

/** J_INBOX_NOISE_DEBOUNCE_MS (tests only, with J_INBOX_CONFIG_DIR): a shorter collection window for the noise judge. undefined: the default. */
export function noiseDebounceOverride(env: Record<string, string | undefined>, p: Paths): number | undefined {
  const v = env.J_INBOX_NOISE_DEBOUNCE_MS;
  if (v === undefined || v === "") return undefined;
  if (!p.testMode) throw new Error("J_INBOX_NOISE_DEBOUNCE_MS is only allowed together with J_INBOX_CONFIG_DIR (tests and local development).");
  const n = Number(v);
  if (!Number.isInteger(n) || n < 50 || n > 60_000) throw new Error("J_INBOX_NOISE_DEBOUNCE_MS must be 50-60000.");
  return n;
}
