// The request store (file drafts.json): the owner's instructions for agents stay on this computer,
// never in the cloud (protocol drafts.ts, delegations.ts). For "ask an agent to draft a reply" it
// keeps the instruction and the agent's draft (drq_ ids); for "delegate to an agent as a Raft task"
// the instruction only (dlg_ ids, since "delegations.v1"). The cloud keeps only the requests'
// metadata and asks for the texts with the cloud-only draft_store_* actions when the owner's page or
// the agent that was asked needs them. One JSON file, mode 0600 in a 0700 directory, written
// atomically on every change; bounded in count and size; a request is forgotten when the cloud says
// it was handled, or DRAFT_KEEP_MS (7 days) after it was made, whatever happened.
import { readFileSync } from "node:fs";
import { DRAFT_KEEP_MS, parse, storedDraft, uploadID, type StoredDraft } from "@j-inbox/protocol";
import { writeAtomic } from "./config.ts";

/** attachmentId: the upload (uploads.ts) the agent attached to its draft; its name and size live in the upload store. */
type Entry = Omit<StoredDraft, "attachment"> & { createdAt: number; deadline: number; updatedAt: number; attachmentId?: string };

/** The cloud keeps at most MAX_ACTIVE_DRAFTS (50) drafts and MAX_ACTIVE_DELEGATIONS (50) delegations open; room for those and some that were not purged yet. */
const MAX_ENTRIES = 200;
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
        const { createdAt, deadline, updatedAt, attachmentId, ...rest } = e as Record<string, unknown>;
        const d = parse(storedDraft, rest);
        if (!d.ok || d.value.attachment || ![createdAt, deadline, updatedAt].every((t) => Number.isSafeInteger(t) && (t as number) >= 0)) continue;
        if (attachmentId !== undefined && !parse(uploadID, attachmentId).ok) continue;
        this.entries.set(d.value.requestId, { ...d.value, createdAt: createdAt as number, deadline: deadline as number, updatedAt: updatedAt as number, ...(attachmentId ? { attachmentId: attachmentId as string } : {}) });
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

  /** Keep a request's instruction (a draft's or a delegation's; a request asked again replaces it). Throws if it cannot be written. */
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

  /** The uploads these requests carry (to forget them with the requests). */
  attachmentsOf(ids: readonly string[]): string[] {
    const out: string[] = [];
    for (const id of new Set(ids)) {
      const a = this.entries.get(id)?.attachmentId;
      if (a) out.push(a);
    }
    return out;
  }

  /** Is this request here (and not too old)? */
  has(requestId: string): boolean {
    const e = this.entries.get(requestId);
    return !!e && this.now() - e.createdAt < this.keepMs;
  }

  /** When the request was made (the upload store keeps a draft's file as long as the draft). */
  createdAt(requestId: string): number | null {
    return this.entries.get(requestId)?.createdAt ?? null;
  }

  /** The upload a draft carries, if any. */
  attachmentOf(requestId: string): string | undefined {
    return this.entries.get(requestId)?.attachmentId;
  }

  /** Keep the agent's draft (and the upload it attached, or none). false: no such draft request here (a delegation has no draft). Throws if it cannot be written. */
  setText(requestId: string, text: string, attachmentId?: string): boolean {
    this.purge();
    const e = this.entries.get(requestId);
    if (!e || !requestId.startsWith("drq_")) return false;
    const before = { ...e };
    e.text = text;
    if (attachmentId) e.attachmentId = attachmentId;
    else delete e.attachmentId;
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
