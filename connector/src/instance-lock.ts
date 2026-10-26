// One `j-inbox run` per config dir. Two processes for the same device would fight over the cloud
// connection and both rewrite the idempotency journal. The lock is a pid file created atomically
// (O_EXCL); a file whose pid is no longer alive (a crash), or now belongs to a process that started
// after the lock was written (the pid was reused after a reboot or kill -9), is taken over.
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pidHeldSince, psProcessStart, type ProcessStart } from "./probe.ts";

export type InstanceLock = { ok: true; path: string; release(): void } | { ok: false; path: string; pid: number | null };

const LOCK_FILE = "run.lock";

function holder(path: string): { pid: number; startedAt: unknown } | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && Number.isSafeInteger(v.pid) ? { pid: v.pid, startedAt: v.startedAt } : null;
  } catch {
    return null;
  }
}

function create(path: string): boolean {
  // Write a private temp file, then hard-link it into place: link() fails if the lock exists, so
  // a reader never sees a half-written lock.
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

export function acquireInstanceLock(dir: string, o: { processStart?: ProcessStart } = {}): InstanceLock {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (create(path)) {
      let released = false;
      return {
        ok: true,
        path,
        release() {
          if (released) return;
          released = true;
          if (holder(path)?.pid === process.pid)
            try {
              unlinkSync(path);
            } catch {}
        },
      };
    }
    const h = holder(path);
    if (h !== null && pidHeldSince(h.pid, h.startedAt, o.processStart ?? psProcessStart)) return { ok: false, path, pid: h.pid };
    // Stale (the holder died or its pid was reused) or unreadable: remove it and try once more.
    try {
      unlinkSync(path);
    } catch {}
  }
  return { ok: false, path, pid: holder(path)?.pid ?? null };
}
