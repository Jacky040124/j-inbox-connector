// Write deduplication: `action:chat:idempotencyKey -> result`, so a retried send_message / react
// replays the first result instead of reaching Beeper twice (protocol README "No double sends").
// A key reused with different parameters is a conflict, never a replay. With a journal, keys
// survive a connector restart: a write that was in flight when the process died answers
// `interrupted()` (UNKNOWN_OUTCOME) and is never dispatched again.
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { IDEMPOTENCY_MAX_ENTRIES, IDEMPOTENCY_TTL_MS } from "@j-inbox/protocol";

/** One journal record. `k` is a hash of the cache key; nothing in it is message text. */
export type JournalEntry = { k: string; fp: string; state: "inflight" | "done"; at: number; result?: unknown };

export interface IdempotencyJournal {
  read(): JournalEntry[];
  /** Replace the journal with this snapshot durably (throws if it cannot). */
  write(entries: JournalEntry[]): void;
}

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;

/** JSON file journal, written atomically (temp file + fsync + rename), mode 0600 in a 0700 directory. */
export class FileIdempotencyJournal implements IdempotencyJournal {
  constructor(private readonly path: string) {}

  read(): JournalEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    if (raw.length > MAX_JOURNAL_BYTES) return [];
    try {
      const j = JSON.parse(raw);
      if (!j || j.v !== 1 || !Array.isArray(j.entries)) return [];
      return j.entries.filter(
        (e: any): e is JournalEntry =>
          !!e && typeof e === "object" && typeof e.k === "string" && HASH_RE.test(e.k) && typeof e.fp === "string" && e.fp.length <= 128 && (e.state === "inflight" || e.state === "done") && Number.isSafeInteger(e.at),
      );
    } catch {
      return [];
    }
  }

  write(entries: JournalEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify({ v: 1, entries }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    try {
      const dfd = openSync(dirname(this.path), "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // directory fsync is best effort (not supported everywhere)
    }
  }
}

export const hashKey = (s: string): string => createHash("sha256").update(s).digest("hex");

type Entry<R> = { at: number; fp: string; promise: Promise<R>; settled: boolean; stored?: unknown };

export type IdempotencyOptions<R> = {
  ttlMs?: number;
  max?: number;
  now?: () => number;
  /** Return false for results that prove nothing happened (e.g. BEEPER_DOWN), so a retry runs again. */
  remember?: (result: R) => boolean;
  /** Result for a key reused with a different fingerprint. Default: throws IdempotencyConflict. */
  conflict?: () => R;
  /** Persist keys across restarts. */
  journal?: IdempotencyJournal;
  /** Result for a key found in flight in the journal at startup (the outcome is unknown). Required with a journal. */
  interrupted?: () => R;
  /** Journal form of a result (ids only, no text) and back. Default: the result itself. */
  encode?: (result: R) => unknown;
  decode?: (stored: unknown) => R | undefined;
};

export class IdempotencyConflict extends Error {
  constructor() {
    super("idempotency key reused with different parameters");
  }
}

export class IdempotencyCache<R> {
  private entries = new Map<string, Entry<R>>();
  private readonly ttl: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly remember: (r: R) => boolean;
  private readonly opts: IdempotencyOptions<R>;

  constructor(opts: IdempotencyOptions<R> = {}) {
    this.opts = opts;
    this.ttl = opts.ttlMs ?? IDEMPOTENCY_TTL_MS;
    this.max = opts.max ?? IDEMPOTENCY_MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
    this.remember = opts.remember ?? (() => true);
    if (opts.journal) {
      if (!opts.interrupted) throw new Error("a journal needs an interrupted() result");
      const now = this.now();
      for (const e of opts.journal.read()) {
        if (now - e.at >= this.ttl || this.entries.has(e.k)) continue;
        const replay = e.state === "done" ? (opts.decode ? opts.decode(e.result) : (e.result as R)) : undefined;
        const r = replay ?? opts.interrupted();
        // An in-flight write stays "done with unknown outcome" from now on; it is never re-sent.
        this.entries.set(e.k, { at: e.at, fp: e.fp, settled: true, promise: Promise.resolve(r), stored: opts.encode ? opts.encode(r) : r });
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Runs `fn` once per live key; later callers with the same key and fingerprint get the same
   * result (also while the first is in flight). A different fingerprint gets `conflict()`.
   * With a journal, the key is durably recorded as in flight before `fn` runs; if that fails, `fn`
   * does not run and the returned promise rejects.
   */
  run(key: string, fn: () => Promise<R>, o: { fingerprint?: string } = {}): Promise<R> {
    const id = this.opts.journal ? hashKey(key) : key;
    const fp = o.fingerprint ?? "";
    const now = this.now();
    const hit = this.entries.get(id);
    if (hit && (!hit.settled || now - hit.at < this.ttl)) {
      if (hit.fp === fp) return hit.promise;
      return this.opts.conflict ? Promise.resolve(this.opts.conflict()) : Promise.reject(new IdempotencyConflict());
    }
    if (hit) this.entries.delete(id);

    const entry: Entry<R> = { at: now, fp, settled: false, promise: Promise.resolve() as Promise<R> };
    this.entries.set(id, entry);
    this.evict(now);
    try {
      this.persist();
    } catch (e) {
      this.entries.delete(id);
      return Promise.reject(e);
    }
    entry.promise = (async () => {
      try {
        const r = await fn();
        entry.settled = true;
        entry.at = this.now();
        if (!this.remember(r)) {
          if (this.entries.get(id) === entry) this.entries.delete(id);
        } else entry.stored = this.opts.encode ? this.opts.encode(r) : r;
        this.persistQuietly();
        return r;
      } catch (e) {
        if (this.entries.get(id) === entry) this.entries.delete(id);
        this.persistQuietly();
        throw e;
      }
    })();
    return entry.promise;
  }

  private snapshot(): JournalEntry[] {
    const out: JournalEntry[] = [];
    for (const [k, e] of this.entries)
      out.push(e.settled ? { k, fp: e.fp, state: "done", at: e.at, ...(e.stored !== undefined ? { result: e.stored } : {}) } : { k, fp: e.fp, state: "inflight", at: e.at });
    return out;
  }

  private persist() {
    this.opts.journal?.write(this.snapshot());
  }

  private persistQuietly() {
    try {
      this.persist();
    } catch {
      // The in-flight record is already on disk; failing to record the outcome keeps it
      // "in flight", which after a restart answers UNKNOWN_OUTCOME: safe, never a double send.
    }
  }

  private evict(now: number) {
    for (const [k, e] of this.entries) if (e.settled && now - e.at >= this.ttl) this.entries.delete(k);
    // Oldest settled first (Map keeps insertion order); never drop an in-flight write.
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.max) break;
      if (e.settled) this.entries.delete(k);
    }
  }
}
