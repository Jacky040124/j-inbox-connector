// The draft store: for "ask an agent to draft a reply", the owner's instruction and the agent's
// draft stay on this computer, never in the cloud (protocol drafts.ts). The cloud keeps only the
// request's metadata and asks for the texts with the cloud-only draft_store_* actions when the
// owner's page or the agent that was asked needs them. One JSON file, mode 0600 in a 0700
// directory, written atomically on every change; bounded in count and size; a request is forgotten
// when the cloud says it was handled, or DRAFT_KEEP_MS (7 days) after it was made, whatever happened.
import { readFileSync } from "node:fs";
import { DRAFT_KEEP_MS, parse, storedDraft, type StoredDraft } from "@j-inbox/protocol";
import { writeAtomic } from "./config.ts";

type Entry = StoredDraft & { createdAt: number; deadline: number; updatedAt: number };

/** The cloud keeps at most MAX_ACTIVE_DRAFTS (50) open; room for that and some that were not purged yet. */
const MAX_ENTRIES = 100;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class DraftStoreError extends Error {}

export class DraftStore {
  private entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly max: number;
  private readonly keepMs: number;

  constructor(private readonly o: { path?: string; now?: () => number; max?: number; keepMs?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.max = o.max ?? MAX_ENTRIES;
    this.keepMs = o.keepMs ?? DRAFT_KEEP_MS;
    if (o.path) this.load(o.path);
    if (this.purge()) this.saveQuietly();
  }

  get size(): number {
    return this.entries.size;
  }

  private load(path: string) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    if (raw.length > MAX_FILE_BYTES) return;
    try {
      const j = JSON.parse(raw);
      if (!j || j.v !== 1 || !Array.isArray(j.entries)) return;
      for (const e of j.entries.slice(-this.max)) {
        if (!e || typeof e !== "object") continue;
        const { createdAt, deadline, updatedAt, ...rest } = e as Record<string, unknown>;
        const d = parse(storedDraft, rest);
        if (!d.ok || ![createdAt, deadline, updatedAt].every((t) => Number.isSafeInteger(t) && (t as number) >= 0)) continue;
        this.entries.set(d.value.requestId, { ...d.value, createdAt: createdAt as number, deadline: deadline as number, updatedAt: updatedAt as number });
      }
    } catch {
      // An unreadable file is ignored (and replaced on the next write): the cloud then sees the requests as gone.
    }
  }

  /** Forget what is too old, then the oldest beyond the cap. True when something went. */
  private purge(): boolean {
    const now = this.now();
    let changed = false;
    for (const [id, e] of this.entries) if (now - e.createdAt >= this.keepMs) this.entries.delete(id), (changed = true);
    for (const id of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(id);
      changed = true;
    }
    return changed;
  }

  private save() {
    if (!this.o.path) return;
    const text = JSON.stringify({ v: 1, entries: [...this.entries.values()] });
    if (text.length > MAX_FILE_BYTES) throw new DraftStoreError("draft store too large");
    writeAtomic(this.o.path, text);
  }

  private saveQuietly() {
    try {
      this.save();
    } catch {}
  }

  /** Keep a request's instruction (a request asked again replaces it). Throws if it cannot be written. */
  put(p: { requestId: string; chatID: string; instruction: string; deadline: string }): void {
    const now = this.now();
    const before = this.entries.get(p.requestId);
    this.entries.delete(p.requestId);
    this.entries.set(p.requestId, { requestId: p.requestId, chatID: p.chatID, instruction: p.instruction, createdAt: before?.createdAt ?? now, deadline: Date.parse(p.deadline) || now, updatedAt: now });
    this.purge();
    try {
      this.save();
    } catch (e) {
      if (before) this.entries.set(p.requestId, before);
      else this.entries.delete(p.requestId);
      throw e;
    }
  }

  /** The requests that are here, in the order asked. */
  get(ids: readonly string[]): StoredDraft[] {
    if (this.purge()) this.saveQuietly();
    const out: StoredDraft[] = [];
    for (const id of new Set(ids)) {
      const e = this.entries.get(id);
      if (e) out.push(e.text === undefined ? { requestId: e.requestId, chatID: e.chatID, instruction: e.instruction } : { requestId: e.requestId, chatID: e.chatID, instruction: e.instruction, text: e.text });
    }
    return out;
  }

  /** Keep the agent's draft. false: no such request here. Throws if it cannot be written. */
  setText(requestId: string, text: string): boolean {
    this.purge();
    const e = this.entries.get(requestId);
    if (!e) return false;
    const before = { ...e };
    e.text = text;
    e.updatedAt = this.now();
    try {
      this.save();
    } catch (err) {
      this.entries.set(requestId, before);
      throw err;
    }
    return true;
  }

  /** Forget requests; how many were here. */
  delete(ids: readonly string[]): number {
    let n = 0;
    for (const id of new Set(ids)) if (this.entries.delete(id)) n++;
    if (n || this.purge()) this.save();
    return n;
  }
}
