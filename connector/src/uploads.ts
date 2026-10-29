// The upload store (directory uploads/): files the owner or an agent is sending through J-Inbox
// (protocol uploads.ts) stay on this computer, never in the cloud. The cloud mints an upl_ id and
// relays the bytes in order, one chunk per upload_store_chunk; the file is sent from here
// (send_message / compose_email attachmentId) or kept with an agent's draft (draft_store_set_text).
// One .bin file per upload and an index.json (name, type, size, owner tag, times), each 0600 in a
// 0700 directory; bounded in count and bytes. An upload is forgotten once it is sent, discarded or
// handled with its draft, UPLOAD_TTL_MS (1 h) after it began unless it is on a draft, and with its
// draft at the latest DRAFT_KEEP_MS (7 days) after that was made.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  DRAFT_KEEP_MS,
  MAX_STORED_UPLOADS,
  MAX_UPLOAD_STORE_BYTES,
  UPLOAD_TTL_MS,
  decodeBase64,
  makeError,
  parse,
  uploadInfo,
  uploadOwner,
  type ErrorBody,
  type ErrorCode,
  type UploadInfo,
} from "@j-inbox/protocol";
import { writeAtomic } from "./config.ts";

type Entry = UploadInfo & { owner: string; received: number; next: number; ready: boolean; createdAt: number; expiresAt: number; draftId?: string };

const MAX_INDEX_BYTES = 1024 * 1024;

export class UploadError extends Error {
  constructor(readonly body: ErrorBody) {
    super(body.code);
  }
}
const refuse = (code: ErrorCode, message: string) => new UploadError(makeError(code, message));
const GONE = "That file is no longer on this computer (a file waits 1 hour to be sent). Attach it again.";

export type UploadStoreOptions = {
  /** The directory (dataDir/uploads); without one everything stays in memory (tests). */
  dir?: string;
  now?: () => number;
  ttlMs?: number;
  max?: number;
  maxBytes?: number;
  /** Is this draft request still in the draft store? An upload whose draft is gone is forgotten. */
  draftAlive?: (requestId: string) => boolean;
};

export class UploadStore {
  private entries = new Map<string, Entry>();
  private memory = new Map<string, Uint8Array[]>();
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly max: number;
  private readonly maxBytes: number;

  constructor(private readonly o: UploadStoreOptions = {}) {
    this.now = o.now ?? Date.now;
    this.ttl = o.ttlMs ?? UPLOAD_TTL_MS;
    this.max = o.max ?? MAX_STORED_UPLOADS;
    this.maxBytes = o.maxBytes ?? MAX_UPLOAD_STORE_BYTES;
    if (o.dir) this.load(o.dir);
    this.purge();
  }

  get size(): number {
    return this.entries.size;
  }

  private file(id: string): string {
    return join(this.o.dir!, `${id}.bin`);
  }

  private load(dir: string) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, "index.json"), "utf8");
    } catch {
      return;
    }
    if (raw.length > MAX_INDEX_BYTES) return;
    try {
      const j = JSON.parse(raw);
      if (!j || j.v !== 1 || !Array.isArray(j.entries)) return;
      for (const e of j.entries.slice(-this.max)) {
        if (!e || typeof e !== "object") continue;
        const { owner, received, next, ready, createdAt, expiresAt, draftId, ...info } = e as Record<string, unknown>;
        const i = parse(uploadInfo, info);
        const nums = [received, next, createdAt, expiresAt].every((t) => Number.isSafeInteger(t) && (t as number) >= 0);
        if (!i.ok || !nums || !parse(uploadOwner, owner).ok || typeof ready !== "boolean" || (draftId !== undefined && typeof draftId !== "string")) continue;
        this.entries.set(i.value.uploadId, { ...i.value, owner: owner as string, received: received as number, next: next as number, ready, createdAt: createdAt as number, expiresAt: expiresAt as number, ...(draftId ? { draftId: draftId as string } : {}) });
      }
    } catch {
      // An unreadable index is ignored (and replaced on the next write); purge() removes the orphaned files.
    }
  }

  private save() {
    if (!this.o.dir) return;
    writeAtomic(join(this.o.dir, "index.json"), JSON.stringify({ v: 1, entries: [...this.entries.values()] }));
  }

  private saveQuietly() {
    try {
      this.save();
    } catch {}
  }

  private removeFile(id: string) {
    this.memory.delete(id);
    if (this.o.dir) rmSync(this.file(id), { force: true });
  }

  /** Forget what expired, what lost its draft, and files no entry names. True when something went. */
  purge(): boolean {
    const now = this.now();
    let changed = false;
    for (const [id, e] of this.entries) {
      const orphan = e.draftId !== undefined && this.o.draftAlive !== undefined && !this.o.draftAlive(e.draftId);
      if (now >= e.expiresAt || orphan) {
        this.entries.delete(id);
        this.removeFile(id);
        changed = true;
      }
    }
    if (this.o.dir && existsSync(this.o.dir)) {
      for (const name of readdirSync(this.o.dir)) {
        const m = /^(upl_[A-Za-z0-9_-]+)\.bin$/.exec(name);
        if (m && !this.entries.has(m[1]!)) rmSync(join(this.o.dir, name), { force: true });
      }
    }
    if (changed) this.saveQuietly();
    return changed;
  }

  /** upload_store_begin: a new, empty upload. */
  begin(p: { uploadId: string; owner: string; fileName: string; mimeType: string; size: number }): void {
    this.purge();
    if (this.entries.has(p.uploadId)) throw refuse("CONFLICT", "This upload exists already.");
    if (this.entries.size >= this.max) throw refuse("TOO_LARGE", "Too many files are waiting to be sent from this computer. Send or discard some first.");
    const total = [...this.entries.values()].reduce((n, e) => n + e.size, 0);
    if (total + p.size > this.maxBytes) throw refuse("TOO_LARGE", "The files waiting to be sent from this computer are too large together. Send or discard some first.");
    const now = this.now();
    const e: Entry = { uploadId: p.uploadId, fileName: p.fileName, mimeType: p.mimeType, size: p.size, owner: p.owner, received: 0, next: 0, ready: false, createdAt: now, expiresAt: now + this.ttl };
    if (this.o.dir) {
      mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
      closeSync(openSync(this.file(p.uploadId), "w", 0o600));
    } else this.memory.set(p.uploadId, []);
    this.entries.set(p.uploadId, e);
    try {
      this.save();
    } catch (err) {
      this.entries.delete(p.uploadId);
      this.removeFile(p.uploadId);
      throw err;
    }
  }

  /** upload_store_chunk: the next piece, in order, never past the declared size. */
  chunk(p: { uploadId: string; owner: string; index: number; data: string }): { received: number } {
    const e = this.entries.get(p.uploadId);
    if (!e || e.owner !== p.owner || this.now() >= e.expiresAt) throw refuse("NOT_FOUND", "No such upload in progress on this computer.");
    if (e.ready) throw refuse("CONFLICT", "This upload is finished already.");
    if (p.index !== e.next) throw refuse("BAD_PARAMS", `Send the chunks in order: chunk ${e.next} is next.`);
    const bytes = decodeBase64(p.data);
    if (e.received + bytes.length > e.size) throw refuse("TOO_LARGE", "More bytes than the size given at upload_begin.");
    if (this.o.dir) {
      const fd = openSync(this.file(p.uploadId), "a", 0o600);
      try {
        writeSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
    } else this.memory.get(p.uploadId)!.push(bytes);
    e.received += bytes.length;
    e.next++;
    this.saveQuietly();
    return { received: e.received };
  }

  /** upload_store_commit: every byte is here; the upload may be sent or put on a draft. */
  commit(p: { uploadId: string; owner: string }): UploadInfo {
    const e = this.entries.get(p.uploadId);
    if (!e || e.owner !== p.owner || this.now() >= e.expiresAt) throw refuse("NOT_FOUND", "No such upload on this computer.");
    if (e.received !== e.size) throw refuse("BAD_PARAMS", `Bytes are missing: ${e.received} of ${e.size} arrived.`);
    if (!e.ready) {
      e.ready = true;
      this.save();
    }
    return infoOf(e);
  }

  /** A finished upload's name, type and size (null when it is not here). */
  info(id: string): UploadInfo | null {
    const e = this.entries.get(id);
    return e && e.ready && this.now() < e.expiresAt ? infoOf(e) : null;
  }

  /** A finished upload with its bytes, to send it. Throws NOT_FOUND when it is gone. */
  read(id: string): UploadInfo & { bytes: Uint8Array } {
    const e = this.entries.get(id);
    if (!e || !e.ready || this.now() >= e.expiresAt) throw refuse("NOT_FOUND", GONE);
    let bytes: Uint8Array;
    if (this.o.dir) {
      try {
        bytes = new Uint8Array(readFileSync(this.file(id)));
      } catch {
        throw refuse("NOT_FOUND", GONE);
      }
    } else {
      const parts = this.memory.get(id) ?? [];
      bytes = new Uint8Array(e.received);
      let off = 0;
      for (const b of parts) bytes.set(b, off), (off += b.length);
    }
    if (bytes.length !== e.size) throw refuse("NOT_FOUND", GONE);
    return { ...infoOf(e), bytes };
  }

  /**
   * Put a finished upload on a draft: only its owner's (an agent attaches only what it uploaded),
   * not on another draft. It then lives as long as the draft (DRAFT_KEEP_MS after `draftCreatedAt`).
   */
  claim(id: string, owner: string, requestId: string, draftCreatedAt: number): boolean {
    const e = this.entries.get(id);
    if (!e || !e.ready || e.owner !== owner || this.now() >= e.expiresAt || (e.draftId !== undefined && e.draftId !== requestId)) return false;
    e.draftId = requestId;
    e.expiresAt = Math.max(e.expiresAt, draftCreatedAt + DRAFT_KEEP_MS);
    this.save();
    return true;
  }

  /** Forget uploads (sent, or their draft was handled); how many were here. */
  delete(ids: readonly string[]): number {
    let n = 0;
    for (const id of new Set(ids)) {
      if (!this.entries.delete(id)) continue;
      this.removeFile(id);
      n++;
    }
    if (n) this.saveQuietly();
    return n;
  }

  /** discard_upload: the owner removed a file from the composer. One on a draft stays with the draft. */
  discard(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.draftId !== undefined) return false;
    return this.delete([id]) === 1;
  }
}

function infoOf(e: Entry): UploadInfo {
  return { uploadId: e.uploadId, fileName: e.fileName, mimeType: e.mimeType, size: e.size };
}
