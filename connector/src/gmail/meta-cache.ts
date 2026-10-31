// Gmail thread metadata (threads.get format=metadata) by account and thread id, valid while the
// thread's historyId from threads.list is unchanged: the lists ask for the same threads again and
// again, and each fetch costs time and Gmail quota. Kept in memory and, in the service, in one 0600
// file in the connector's data directory so a restart starts warm. Only what format=metadata
// returns for the list headers is kept (ids, labels, dates, the From/To/Cc/Subject/Date/Message-ID
// headers and Gmail's snippet), never a body; a draft's snippet (the owner's unsent text) is
// never kept. The file is AES-256-GCM sealed with a key from the Keychain (`gmail-cache-key`), so
// no email text is on disk in the clear; without the key the cache is memory only. Bounded by
// entries and bytes, least recently used first out; a file that does not open or validate is
// ignored and rewritten.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeAtomic } from "../config.ts";
import type { GMessage, GThread } from "./map.ts";

export const META_CACHE_MAX_ENTRIES = 3000;
export const META_CACHE_MAX_BYTES = 6 * 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024;
const MAX_MESSAGES = 300;
const MAX_HEADER_VALUE = 4000;
const MAX_SNIPPET = 500;
const MAX_LABELS = 40;
const KEPT_HEADERS = new Set(["from", "to", "cc", "subject", "date", "message-id"]);
const ID_RE = /^[A-Za-z0-9]{1,64}$/;
const HISTORY_RE = /^\d{1,20}$/;
const LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WRITE_DELAY_MS = 5_000;

type Entry = { historyId: string; thread: GThread; bytes: number };

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The part of a metadata thread that is kept: list headers and labels, no body; drafts without their snippet. null if it does not look like one. */
export function keptThread(raw: unknown): GThread | null {
  if (!isObj(raw) || typeof raw.id !== "string" || !ID_RE.test(raw.id) || !Array.isArray(raw.messages) || raw.messages.length > MAX_MESSAGES) return null;
  const messages: GMessage[] = [];
  for (const m of raw.messages) {
    if (!isObj(m) || typeof m.id !== "string" || !ID_RE.test(m.id)) return null;
    const labelIds = Array.isArray(m.labelIds) ? m.labelIds.filter((l: unknown): l is string => typeof l === "string" && LABEL_RE.test(l)).slice(0, MAX_LABELS) : [];
    const draft = labelIds.includes("DRAFT");
    const headers = isObj(m.payload) && Array.isArray(m.payload.headers) ? m.payload.headers : [];
    const kept = headers
      .filter((h: unknown): h is { name: string; value: string } => isObj(h) && typeof h.name === "string" && typeof h.value === "string" && KEPT_HEADERS.has(h.name.toLowerCase()))
      .slice(0, 24)
      .map((h: { name: string; value: string }) => ({ name: h.name, value: h.value.slice(0, MAX_HEADER_VALUE) }));
    const out: GMessage = { id: m.id, ...(typeof m.threadId === "string" && ID_RE.test(m.threadId) ? { threadId: m.threadId } : {}), labelIds, payload: { headers: kept } };
    if (typeof m.internalDate === "string" && /^\d{1,15}$/.test(m.internalDate)) out.internalDate = m.internalDate;
    if (!draft && typeof m.snippet === "string") out.snippet = m.snippet.slice(0, MAX_SNIPPET);
    messages.push(out);
  }
  return { id: raw.id, messages };
}

export class ThreadMetaCache {
  private m = new Map<string, Entry>();
  private bytes = 0;
  private dirty = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  private path: string | null = null;
  private key: Uint8Array | null = null;

  /** `path` and a 32-byte `key` together: kept on disk (sealed); otherwise memory only (see persistTo). */
  constructor(private readonly o: { path?: string; key?: Uint8Array | null; maxEntries?: number; maxBytes?: number; writeDelayMs?: number } = {}) {
    this.maxEntries = o.maxEntries ?? META_CACHE_MAX_ENTRIES;
    this.maxBytes = o.maxBytes ?? META_CACHE_MAX_BYTES;
    if (o.path && o.key) this.persistTo(o.path, o.key);
  }

  /** From now on keep the cache in `path`, sealed with `key` (once; the first Gmail account got its key). What the file holds is loaded. */
  persistTo(path: string, key: Uint8Array) {
    if (this.path || key.length !== 32) return;
    this.path = path;
    this.key = key;
    const had = this.m.size;
    this.load(path);
    if (had) this.changed();
  }

  get persistent(): boolean {
    return this.path !== null;
  }

  get size(): number {
    return this.m.size;
  }

  private static key(email: string, threadId: string) {
    return `${email}\u0000${threadId}`;
  }

  get(email: string, threadId: string, historyId: string | undefined): GThread | null {
    if (!historyId) return null;
    const k = ThreadMetaCache.key(email, threadId);
    const e = this.m.get(k);
    if (!e || e.historyId !== historyId) return null;
    this.m.delete(k);
    this.m.set(k, e);
    return e.thread;
  }

  /** Keep a fetched thread; returns what is kept (what get() will answer), or null when it is not kept. */
  set(email: string, threadId: string, historyId: string | undefined, thread: unknown): GThread | null {
    if (!historyId || !HISTORY_RE.test(historyId) || !ID_RE.test(threadId)) return null;
    const t = keptThread(thread);
    if (!t || t.id !== threadId) return null;
    const k = ThreadMetaCache.key(email, threadId);
    const bytes = JSON.stringify(t).length + k.length + 32;
    this.drop(k);
    if (bytes > MAX_ENTRY_BYTES) return null;
    this.m.set(k, { historyId, thread: t, bytes });
    this.bytes += bytes;
    this.trim();
    this.changed();
    return t;
  }

  /** Forget an account's threads (it was removed). */
  forget(email: string) {
    for (const k of [...this.m.keys()]) if (k.startsWith(`${email}\u0000`)) this.drop(k);
    this.changed();
  }

  private drop(k: string) {
    const e = this.m.get(k);
    if (!e) return;
    this.bytes -= e.bytes;
    this.m.delete(k);
  }

  private trim() {
    while (this.m.size > this.maxEntries || this.bytes > this.maxBytes) this.drop(this.m.keys().next().value!);
  }

  private changed() {
    if (!this.path) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.o.writeDelayMs ?? WRITE_DELAY_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Write the file now if anything changed (the service calls it on stop). */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.path || !this.dirty) return;
    this.dirty = false;
    const entries = [...this.m].map(([k, e]) => {
      const i = k.indexOf("\u0000");
      return [k.slice(0, i), k.slice(i + 1), e.historyId, e.thread] as const;
    });
    try {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", this.key!, iv);
      const data = Buffer.concat([c.update(JSON.stringify({ v: 1, entries }), "utf8"), c.final()]);
      writeAtomic(this.path, JSON.stringify({ v: 1, alg: "A256GCM", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") }));
    } catch {
      // a full disk loses the warm start, nothing else
    }
  }

  private load(path: string) {
    let j: any;
    try {
      const text = readFileSync(path, "utf8");
      if (text.length > this.maxBytes * 3) return;
      const box = JSON.parse(text);
      if (!isObj(box) || box.v !== 1 || box.alg !== "A256GCM" || typeof box.iv !== "string" || typeof box.tag !== "string" || typeof box.data !== "string") return;
      const d = createDecipheriv("aes-256-gcm", this.key!, Buffer.from(box.iv, "base64"));
      d.setAuthTag(Buffer.from(box.tag, "base64"));
      j = JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, "base64")), d.final()]).toString("utf8"));
    } catch {
      return;
    }
    if (!isObj(j) || j.v !== 1 || !Array.isArray(j.entries)) return;
    for (const e of j.entries) {
      if (!Array.isArray(e) || e.length !== 4) continue;
      const [email, threadId, historyId, thread] = e;
      if (typeof email !== "string" || email.length > 320 || email.includes("\u0000") || typeof threadId !== "string" || typeof historyId !== "string") continue;
      this.set(email, threadId, historyId, thread);
    }
    this.dirty = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
