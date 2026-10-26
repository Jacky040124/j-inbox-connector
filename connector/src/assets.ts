// The get_media allowlist: asset URLs this connector put into a result. Beeper's
// /v1/assets/serve streams any file:// path it is given, so the cloud (or anyone who reaches it)
// must not be able to name arbitrary local files. Only SHA-256 hashes are kept, in memory and
// optionally on disk (so images keep loading after a restart), bounded by count and age.
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_URL_LENGTH } from "@j-inbox/protocol";

export type AssetAllowlistOptions = { max?: number; ttlMs?: number; now?: () => number; path?: string };

const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** file:// URLs are compared after percent-decoding, so encoding variants of one path match. */
function canonical(url: string): string {
  if (!url.startsWith("file://")) return url;
  try {
    return "file://" + decodeURIComponent(url.slice(7));
  } catch {
    return url;
  }
}

export class AssetAllowlist {
  private entries = new Map<string, number>();
  private readonly max: number;
  private readonly ttl: number;
  private readonly now: () => number;
  private dirty = false;

  constructor(private readonly o: AssetAllowlistOptions = {}) {
    this.max = o.max ?? 50_000;
    this.ttl = o.ttlMs ?? 7 * 24 * 3600_000;
    this.now = o.now ?? Date.now;
    if (o.path) this.load(o.path);
  }

  get size(): number {
    return this.entries.size;
  }

  private key(url: unknown): string | null {
    if (typeof url !== "string" || url.length < 1 || url.length > MAX_URL_LENGTH) return null;
    return createHash("sha256").update(canonical(url)).digest("hex");
  }

  add(url: string): void {
    const k = this.key(url);
    if (!k) return;
    this.entries.delete(k);
    this.entries.set(k, this.now());
    this.dirty = true;
    for (const old of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(old);
    }
  }

  has(url: string): boolean {
    const k = this.key(url);
    if (!k) return false;
    const at = this.entries.get(k);
    if (at === undefined) return false;
    if (this.now() - at >= this.ttl) {
      this.entries.delete(k);
      this.dirty = true;
      return false;
    }
    return true;
  }

  private load(path: string) {
    try {
      const raw = readFileSync(path, "utf8");
      if (raw.length > MAX_FILE_BYTES) return;
      const j = JSON.parse(raw);
      if (!j || j.v !== 1 || !Array.isArray(j.entries)) return;
      const now = this.now();
      for (const e of j.entries) {
        if (!Array.isArray(e) || typeof e[0] !== "string" || !HASH_RE.test(e[0]) || !Number.isSafeInteger(e[1])) continue;
        if (now - e[1] < this.ttl) this.entries.set(e[0], e[1]);
      }
      while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    } catch {
      // missing or corrupt: start empty
    }
  }

  /** Write the hashes to disk (atomic, 0600). No-op without a path or when nothing changed. */
  flush(): void {
    const path = this.o.path;
    if (!path || !this.dirty) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify({ v: 1, entries: [...this.entries] }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    this.dirty = false;
  }
}
