// Local operation log (`j-inbox logs`): JSONL, metadata only. Every field is checked against a
// closed vocabulary (catalogue action names, error codes, lifecycle events, numbers), so message
// text, chat names, ids or tokens cannot end up here even by mistake. Size-rotated.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { ACTION_NAMES, ERROR_CODES, sanitizeLine, type ErrorCode } from "@j-inbox/protocol";

export const LIFECYCLE_EVENTS = [
  "service.started",
  "service.stopped",
  "cloud.connected",
  "cloud.disconnected",
  "cloud.stopped",
  "beeper.up",
  "beeper.down",
  "beeper.unauthorized",
  "paired",
  "unpaired",
  "setup.completed",
  "gmail.connected",
  "gmail.removed",
  "gmail.reauth",
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export type AuditEntry = {
  ts: string;
  event: "request" | LifecycleEvent;
  action?: string;
  ok?: boolean;
  code?: ErrorCode;
  ms?: number;
  closeCode?: number;
  /** Who asked, from the cloud's req.caller: the type and the Raft display name (never content). */
  caller?: "human" | "agent";
  callerName?: string;
};
export type RequestCaller = { type: "human" | "agent"; name?: string };

// Bidi overrides and invisible format characters would let a name spoof `j-inbox logs` output.
const FORMAT_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const CALLER_NAME_MAX = 64;
function cleanCallerName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const s = sanitizeLine(name.slice(0, 1000).replace(FORMAT_CHARS, ""), CALLER_NAME_MAX);
  return s || undefined;
}

const ACTIONS = new Set<string>([...ACTION_NAMES, "unknown"]);
const CODES = new Set<string>(ERROR_CODES);
const EVENTS = new Set<string>(["request", ...LIFECYCLE_EVENTS]);
const KEYS = new Set(["ts", "event", "action", "ok", "code", "ms", "closeCode", "caller", "callerName"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const int = (v: unknown, max: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;

export function isAuditEntry(e: unknown): e is AuditEntry {
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  const x = e as Record<string, unknown>;
  if (!Object.keys(x).every((k) => KEYS.has(k))) return false;
  if (typeof x.ts !== "string" || !ISO.test(x.ts) || typeof x.event !== "string" || !EVENTS.has(x.event)) return false;
  if (x.action !== undefined && (typeof x.action !== "string" || !ACTIONS.has(x.action))) return false;
  if (x.ok !== undefined && typeof x.ok !== "boolean") return false;
  if (x.code !== undefined && (typeof x.code !== "string" || !CODES.has(x.code))) return false;
  if (x.ms !== undefined && !int(x.ms, 86_400_000)) return false;
  if (x.closeCode !== undefined && !int(x.closeCode, 4999)) return false;
  if (x.caller !== undefined && x.caller !== "human" && x.caller !== "agent") return false;
  if (x.callerName !== undefined && (x.caller === undefined || typeof x.callerName !== "string" || cleanCallerName(x.callerName) !== x.callerName)) return false;
  return true;
}

export class AuditLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => number;

  constructor(o: { path: string; maxBytes?: number; keep?: number; now?: () => number }) {
    this.path = o.path;
    this.maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
    this.keep = Math.max(1, o.keep ?? 3);
    this.now = o.now ?? Date.now;
  }

  request(r: { action: string; ok: boolean; code?: ErrorCode; ms: number; caller?: RequestCaller }) {
    const who: Pick<AuditEntry, "caller" | "callerName"> = {};
    if (r.caller && (r.caller.type === "human" || r.caller.type === "agent")) {
      who.caller = r.caller.type;
      const name = cleanCallerName(r.caller.name);
      if (name) who.callerName = name;
    }
    this.write({ ts: this.ts(), event: "request", action: r.action, ok: r.ok, ...(r.code ? { code: r.code } : {}), ms: Math.round(r.ms), ...who });
  }

  lifecycle(event: LifecycleEvent, extra: { closeCode?: number } = {}) {
    this.write({ ts: this.ts(), event, ...(extra.closeCode !== undefined ? { closeCode: extra.closeCode } : {}) });
  }

  private ts() {
    return new Date(this.now()).toISOString();
  }

  private write(e: AuditEntry) {
    if (!isAuditEntry(e)) return;
    const line = JSON.stringify(e) + "\n";
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = statSync(this.path).size;
      } catch {}
      if (size > 0 && size + line.length > this.maxBytes) this.rotate();
      const fresh = !existsSync(this.path);
      appendFileSync(this.path, line, { mode: 0o600 });
      if (fresh) chmodSync(this.path, 0o600);
    } catch {
      // The log must never break the service.
    }
  }

  private rotate() {
    try {
      unlinkSync(`${this.path}.${this.keep}`);
    } catch {}
    for (let i = this.keep - 1; i >= 1; i--) {
      try {
        renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      } catch {}
    }
    renameSync(this.path, `${this.path}.1`);
  }

  /** The newest n valid entries, oldest first. */
  tail(n: number): AuditEntry[] {
    const out: AuditEntry[] = [];
    for (let i = 0; i <= this.keep && out.length < n; i++) {
      const p = i === 0 ? this.path : `${this.path}.${i}`;
      let raw: string;
      try {
        raw = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      const lines = raw.split("\n");
      for (let j = lines.length - 1; j >= 0 && out.length < n; j--) {
        if (!lines[j]) continue;
        try {
          const e = JSON.parse(lines[j]!);
          if (isAuditEntry(e)) out.push(e);
        } catch {}
      }
    }
    return out.reverse();
  }
}
