// Quick, read-only checks used by status, doctor and setup.
import { connect } from "node:net";
import { sanitizeLine } from "@j-inbox/protocol";
import { createBeeperClient } from "./beeper-client.ts";

export type BeeperProbe = { url: string; reachable: boolean; version: string | null; name: string | null; tokenValid?: boolean; accounts?: number };

/** GET /v1/info (no token needed) and, with a token, GET /v1/accounts. Never writes. */
export async function probeBeeper(url: string, token: string | null, fetchImpl: typeof fetch = fetch, timeoutMs = 3000): Promise<BeeperProbe> {
  const client = createBeeperClient({ baseURL: url, token: token ?? "none", timeoutMs, maxBodyBytes: 2 * 1024 * 1024, fetchImpl });
  const info = await client.get("/v1/info");
  if (!info.ok) return { url, reachable: false, version: null, name: null };
  const app = (info.body as any)?.app;
  const out: BeeperProbe = {
    url,
    reachable: true,
    version: typeof app?.version === "string" ? sanitizeLine(app.version, 64) || null : null,
    name: typeof app?.name === "string" ? sanitizeLine(app.name, 64) || null : null,
  };
  if (!token) return out;
  const acc = await client.get("/v1/accounts");
  if (acc.ok) {
    const list = Array.isArray(acc.body) ? acc.body : Array.isArray((acc.body as any)?.items) ? (acc.body as any).items : [];
    return { ...out, tokenValid: true, accounts: list.length };
  }
  if (acc.error.code === "BEEPER_UNAUTHORIZED") return { ...out, tokenValid: false };
  return { ...out, reachable: false };
}

/** Something accepts TCP connections on 127.0.0.1:port (no HTTP request is made). */
export function portInUse(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Beeper Server's port: 23373 unless something (Beeper Desktop) holds it, else the first free one from 23374. */
export async function pickServerPort(inUse: (port: number) => Promise<boolean>): Promise<number | null> {
  if (!(await inUse(23373))) return 23373;
  for (let p = 23374; p < 23400; p++) if (!(await inUse(p))) return p;
  return null;
}

export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/** Seconds from `ps -o etime=` output: [[dd-]hh:]mm:ss. null for anything else. */
export function parseEtime(raw: string): number | null {
  const m = /^\s*(?:(?:(\d{1,5})-)?(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(raw);
  if (!m) return null;
  const [d, h, mm, ss] = [m[1], m[2], m[3], m[4]].map((x) => (x === undefined ? 0 : Number(x)));
  return d! * 86400 + h! * 3600 + mm! * 60 + ss!;
}

/** When a process started (epoch ms), or null when it cannot be told. */
export type ProcessStart = (pid: number) => number | null;

export const psProcessStart: ProcessStart = (pid) => {
  try {
    const r = Bun.spawnSync(["/bin/ps", "-o", "etime=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    if (r.exitCode !== 0) return null;
    const s = parseEtime(r.stdout.toString());
    return s === null ? null : Date.now() - s * 1000;
  } catch {
    return null;
  }
};

/**
 * `pid` is alive and can be the process that recorded `startedAt` (a lock or state file). A pid is
 * reused after a reboot, kill -9 or crash: a process that started after the record was written
 * cannot have written it. etime has one-second steps, hence the slack.
 */
export function pidHeldSince(pid: unknown, startedAt: unknown, processStart: ProcessStart = psProcessStart): boolean {
  if (!pidAlive(pid)) return false;
  const t = typeof startedAt === "number" ? startedAt : typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(t)) return true;
  const started = processStart(pid as number);
  return started === null || started <= t + 2000;
}
