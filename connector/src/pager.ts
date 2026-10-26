// Connector-side paging over Beeper pages (protocol README "Filtered paging" and "Big pages").
// Beeper has no network/pinned filter and returns pages of its own size, so the connector walks
// Beeper pages (cursor + direction=before), keeps what matches, and hands out its own cursor:
// "j2." + base64url(JSON {b: Beeper cursor of the page, k: hash of the last item's key, s: hash of
// the scope (action + chat or filters)}). Resuming refetches page b and continues right after
// item k, so no item is skipped. Hashing k keeps the cursor small whatever the id length.
import { createHash } from "node:crypto";
import { LIST_SCAN_BUDGET_MS, LIST_SCAN_MAX_PAGES, MAX_CURSOR_LENGTH, MAX_REQUEST_ID_LENGTH, encodeFrame } from "@j-inbox/protocol";

export type BeeperPage<T> = { items: T[]; hasMore: boolean; oldestCursor: string | null };
/** k is keyHash(item key), never the raw key. */
export type PagerCursor = { b: string | null; k: string | null };

const PREFIX = "j2.";

/** The Beeper cursor cannot be wrapped within MAX_CURSOR_LENGTH: answer TOO_LARGE (not retryable). */
export class CursorTooLong extends Error {
  constructor() {
    super("cursor too long");
  }
}
/** The item a cursor points after is gone from the newest pages: answer BAD_PARAMS, reload from the top. */
export class CursorExpired extends Error {
  constructor() {
    super("cursor expired");
  }
}

const shortHash = (s: string, bytes: number) => createHash("sha256").update(s).digest().subarray(0, bytes).toString("base64url");
export const keyHash = (key: string): string => shortHash(key, 12);
const scopeHash = (scope: string): string => shortHash(scope, 9);

function toB64url(text: string): string {
  let bin = "";
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodePagerCursor(c: PagerCursor, scope: string): string {
  const s = PREFIX + toB64url(JSON.stringify({ b: c.b, k: c.k, s: scopeHash(scope) }));
  if (s.length > MAX_CURSOR_LENGTH) throw new CursorTooLong();
  return s;
}

/** null for anything that is not a cursor this connector minted for this scope (answer BAD_PARAMS). */
export function decodePagerCursor(s: string, scope: string): PagerCursor | null {
  if (typeof s !== "string" || !s.startsWith(PREFIX) || s.length > MAX_CURSOR_LENGTH) return null;
  try {
    const v = JSON.parse(fromB64url(s.slice(PREFIX.length)));
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const keys = Object.keys(v).sort();
    if (keys.length !== 3 || keys[0] !== "b" || keys[1] !== "k" || keys[2] !== "s") return null;
    if (v.s !== scopeHash(scope)) return null;
    const okField = (x: unknown) => x === null || (typeof x === "string" && x.length > 0);
    return okField(v.b) && okField(v.k) ? { b: v.b, k: v.k } : null;
  } catch {
    return null;
  }
}

export type CollectOptions<T> = {
  cursor: PagerCursor | null;
  limit: number;
  /** Fetch one Beeper page; items in walk order (newest first). */
  fetchPage: (beeperCursor: string | null) => Promise<BeeperPage<T>>;
  keep: (item: T) => boolean;
  keyOf: (item: T) => string;
  budgetMs?: number;
  maxPages?: number;
  now?: () => number;
  /** The request's cancel/deadline signal: checked before every page. */
  signal?: AbortSignal;
  /** Epoch ms (same clock as `now`) by which the request must be answered; scanning stops before it. */
  deadline?: number;
};

/** The request was cancelled or its deadline passed: answer TIMEOUT. */
export class RequestAborted extends Error {
  constructor() {
    super("request aborted");
  }
}

export type Collected<T> = {
  items: T[];
  /** after[i]: the cursor that resumes right after items[i]. */
  after: PagerCursor[];
  /** More may exist beyond what was scanned. */
  hasMore: boolean;
  /** Where the next call should start when every collected item is returned. */
  resume: PagerCursor | null;
};

export async function collect<T>(o: CollectOptions<T>): Promise<Collected<T>> {
  const now = o.now ?? Date.now;
  const budget = o.budgetMs ?? LIST_SCAN_BUDGET_MS;
  const maxPages = o.maxPages ?? LIST_SCAN_MAX_PAGES;
  const t0 = now();
  const outOfTime = () => now() - t0 >= budget || (o.deadline !== undefined && now() >= o.deadline);
  let b = o.cursor?.b ?? null;
  let skipTo = o.cursor?.k ?? null;
  // A cursor minted on the newest page (b null) points into a page that new items keep pushing
  // down: walk older pages until the anchor shows up. On an older page (b set) the page itself is
  // stable; if the anchor vanished (deleted, moved to the top) restart that page: may repeat,
  // never skips, never jumps to newer items.
  const seekFromHead = skipTo !== null && b === null;
  const items: T[] = [];
  const after: PagerCursor[] = [];
  for (let pages = 1; ; pages++) {
    if (o.signal?.aborted) throw new RequestAborted();
    const page = await o.fetchPage(b);
    const pageHasMore = page.hasMore && page.items.length > 0 && typeof page.oldestCursor === "string";
    let start = 0;
    if (skipTo !== null) {
      const idx = page.items.findIndex((x) => keyHash(o.keyOf(x)) === skipTo);
      if (idx < 0 && seekFromHead) {
        if (!pageHasMore || pages >= maxPages || outOfTime()) throw new CursorExpired();
        b = page.oldestCursor;
        continue;
      }
      start = idx + 1;
      skipTo = null;
    }
    for (let i = start; i < page.items.length; i++) {
      const item = page.items[i]!;
      const here: PagerCursor = { b, k: keyHash(o.keyOf(item)) };
      if (o.keep(item)) {
        items.push(item);
        after.push(here);
      }
      if (items.length >= o.limit) {
        const moreInPage = i < page.items.length - 1;
        const hasMore = moreInPage || pageHasMore;
        return { items, after, hasMore, resume: !hasMore ? null : moreInPage ? here : { b: page.oldestCursor, k: null } };
      }
    }
    // An empty page ends the walk even if Beeper said hasMore (real iMessage history does this).
    if (!pageHasMore) return { items, after, hasMore: false, resume: null };
    b = page.oldestCursor;
    if (pages >= maxPages || outOfTime()) return { items, after, hasMore: true, resume: { b, k: null } };
  }
}

/** The first `n` collected items as a protocol page, with a cursor bound to `scope`. */
export function finishPage<T>(r: Collected<T>, n: number, scope: string): { items: T[]; hasMore: boolean; nextCursor: string | null } {
  if (n < r.items.length) {
    if (n < 1) throw new Error("finishPage needs at least one item to make progress");
    return { items: r.items.slice(0, n), hasMore: true, nextCursor: encodePagerCursor(r.after[n - 1]!, scope) };
  }
  return { items: r.items, hasMore: r.hasMore, nextCursor: r.hasMore && r.resume ? encodePagerCursor(r.resume, scope) : null };
}

/** Largest n <= total whose `res` frame (with build(n) as data) fits MAX_FRAME_BYTES; 0 if none. */
export function fitToFrame(total: number, build: (n: number) => unknown): number {
  if (total <= 0) return 0;
  const id = "x".repeat(MAX_REQUEST_ID_LENGTH);
  const fits = (n: number) => encodeFrame({ type: "res", id, ok: true, data: build(n) } as never).ok;
  if (fits(total)) return total;
  if (!fits(1)) return 0;
  let lo = 1;
  let hi = total - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
