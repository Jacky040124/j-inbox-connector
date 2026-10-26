// Newest-first lists over several sources (Beeper, and each Gmail account): a k-way merge with a
// composite cursor, "jm." + base64url(JSON {s, b, p}):
//   s  hash of the scope (action + filters), so a cursor only works for the list that minted it
//   b  the boundary already returned: [effective time, source rank, item key hash] of the last item
//   p  per source: [its own cursor, done, floor, recent] (floor = effective time of its last
//      consumed item; recent = key hashes of its last few consumed items)
// Each page asks every unfinished source for up to `limit` items from its own position, merges
// them by (effective time desc, rank, key hash), and stops at `limit` or as soon as a source that
// has more is out of fetched items (its next item could be newer than anything left). A source's
// position advances exactly past the items it contributed, so with stable sources every item is
// returned once (no duplicates, no gaps). "Effective time" clamps a source's times to never rise
// within that source (a source whose own order is not strictly by time stays consistent). When a
// source's positions shift because something new arrived on top (offset-based paging), the items
// it hands out again are recognised by `recent` and skipped; a source that joins mid-way (an
// account added while paging) skips everything at or above the boundary. A source that fails is
// reported in `failed` and keeps its position; the others still answer.
import { createHash } from "node:crypto";
import { MAX_CURSOR_LENGTH, makeError, type ErrorBody } from "@j-inbox/protocol";
import { CursorTooLong } from "./pager.ts";

export type MergeItem<T> = { value: T; time: number; key: string; urls?: string[] };
export type SourcePage<T> = {
  items: MergeItem<T>[];
  hasMore: boolean;
  /** The source's own cursor that resumes right after its first n items; null when nothing is left after them. */
  cursorAfter(n: number): string | null;
  /**
   * With hasMore: everything this source has not returned yet is at or before this time (it looked
   * that far back). Lets the merge go on with newer items from the other sources instead of
   * stopping at a source whose scan ran out of time before finding anything.
   */
  horizon?: number;
};
export type FailedSource = { source: "beeper" | "gmail"; accountID?: string; error: ErrorBody };

/** Thrown (or returned through fetch's rejection) when a source cannot answer; the merge reports it. */
export class SourceFailure extends Error {
  constructor(readonly body: ErrorBody) {
    super(body.code);
  }
}

export type MergeSource<T> = {
  /** Stable short id for the cursor ("b", "g<hash>"). */
  id: string;
  /** Tie-break between sources at the same time. */
  rank: number;
  failure: Omit<FailedSource, "error">;
  fetch(cursor: string | null, limit: number): Promise<SourcePage<T>>;
};

type SrcState = [cursor: string | null, done: 0 | 1, floor: number | null, recent: string[]];
const RECENT = 4;
type Boundary = [time: number, rank: number, key: string];
type State = { s: string; b: Boundary | null; p: Record<string, SrcState> };

const PREFIX = "jm.";
const shortHash = (s: string, n: number) => createHash("sha256").update(s).digest().subarray(0, n).toString("base64url");
export const sourceKeyHash = (key: string) => shortHash(key, 9);

function toB64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export function encodeMergeCursor(st: State): string {
  const s = PREFIX + toB64url(JSON.stringify(st));
  if (s.length > MAX_CURSOR_LENGTH) throw new CursorTooLong();
  return s;
}

/** null for anything this connector did not mint for this scope. */
export function decodeMergeCursor(raw: string, scope: string): State | null {
  if (typeof raw !== "string" || !raw.startsWith(PREFIX) || raw.length > MAX_CURSOR_LENGTH) return null;
  try {
    const v = JSON.parse(Buffer.from(raw.slice(PREFIX.length), "base64url").toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join(",") !== "b,p,s") return null;
    if (v.s !== shortHash(scope, 9)) return null;
    const b = v.b;
    if (b !== null && !(Array.isArray(b) && b.length === 3 && Number.isFinite(b[0]) && Number.isSafeInteger(b[1]) && typeof b[2] === "string" && b[2].length <= 16)) return null;
    if (!v.p || typeof v.p !== "object" || Array.isArray(v.p)) return null;
    const p: Record<string, SrcState> = {};
    for (const [k, x] of Object.entries(v.p)) {
      if (!/^[A-Za-z0-9_-]{1,16}$/.test(k) || !Array.isArray(x) || x.length !== 4) return null;
      const [c, d, f, r] = x as unknown[];
      if (!(c === null || (typeof c === "string" && c.length > 0 && c.length <= MAX_CURSOR_LENGTH)) || (d !== 0 && d !== 1) || !(f === null || Number.isFinite(f))) return null;
      if (!Array.isArray(r) || r.length > RECENT || !r.every((h) => typeof h === "string" && /^[A-Za-z0-9_-]{1,16}$/.test(h))) return null;
      p[k] = [c as string | null, d as 0 | 1, f as number | null, r as string[]];
    }
    return { s: v.s, b, p };
  } catch {
    return null;
  }
}

export function isMergeCursor(raw: unknown): boolean {
  return typeof raw === "string" && raw.startsWith(PREFIX);
}

type Lane<T> = { src: MergeSource<T>; page: SourcePage<T> | null; error: ErrorBody | null; eff: number[]; skip: number; idx: number };

/** Order: newer first, then lower rank, then key hash. Negative when a comes first. */
function cmp(a: Boundary, b: Boundary): number {
  return b[0] - a[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

export type Merged<T> = {
  /** Merged items in order (at most `limit`), with their source and asset URLs. */
  taken: { item: MergeItem<T>; source: string }[];
  failed: FailedSource[];
  /** Page answer for the first n taken items (n may be smaller, e.g. to fit a frame). */
  finish(n: number): { hasMore: boolean; nextCursor: string | null };
};

export async function mergeCollect<T>(sources: MergeSource<T>[], cursor: string | null, limit: number, scope: string): Promise<Merged<T> | "bad"> {
  const st: State = cursor === null ? { s: shortHash(scope, 9), b: null, p: {} } : (decodeMergeCursor(cursor, scope) as State);
  if (!st) return "bad";
  const lanes: Lane<T>[] = await Promise.all(
    sources
      .filter((s) => st.p[s.id]?.[1] !== 1)
      .map(async (src): Promise<Lane<T>> => {
        try {
          const page = await src.fetch(st.p[src.id]?.[0] ?? null, limit);
          return { src, page, error: null, eff: [], skip: 0, idx: 0 };
        } catch (e) {
          if (e instanceof SourceFailure) return { src, page: null, error: e.body, eff: [], skip: 0, idx: 0 };
          return { src, page: null, error: makeError("INTERNAL", "This source failed while listing."), eff: [], skip: 0, idx: 0 };
        }
      }),
  );
  for (const l of lanes) {
    if (!l.page) continue;
    const known = st.p[l.src.id];
    let prev = known?.[2] ?? Number.POSITIVE_INFINITY;
    l.eff = l.page.items.map((it) => (prev = Math.min(Number.isFinite(it.time) ? it.time : 0, prev)));
    if (known) {
      // Handed out again because its positions shifted (something new on top): skip.
      const recent = new Set(known[3]);
      while (l.skip < l.eff.length && recent.has(sourceKeyHash(l.page.items[l.skip]!.key))) l.skip++;
    } else if (st.b) {
      // A source that joined after the first page: what sorts at or above the boundary is in the
      // part of the list already returned.
      while (l.skip < l.eff.length && cmp([l.eff[l.skip]!, l.src.rank, sourceKeyHash(l.page.items[l.skip]!.key)], st.b) <= 0) l.skip++;
    }
    l.idx = l.skip;
  }
  const taken: { item: MergeItem<T>; source: string; lane: Lane<T>; at: Boundary }[] = [];
  const live = lanes.filter((l) => l.page);
  while (taken.length < limit) {
    // A source that has more but no fetched items left blocks everything at or before its horizon
    // (everything, without one): its next item could be that new.
    let blockAt = Number.NEGATIVE_INFINITY;
    for (const l of live) if (l.idx >= l.page!.items.length && l.page!.hasMore) blockAt = Math.max(blockAt, l.page!.horizon ?? Number.POSITIVE_INFINITY);
    if (blockAt === Number.POSITIVE_INFINITY) break;
    let best: Lane<T> | null = null;
    let bestAt: Boundary | null = null;
    for (const l of live) {
      if (l.idx >= l.page!.items.length) continue;
      const at: Boundary = [l.eff[l.idx]!, l.src.rank, sourceKeyHash(l.page!.items[l.idx]!.key)];
      if (!bestAt || cmp(at, bestAt) < 0) (best = l), (bestAt = at);
    }
    if (!best || !bestAt) break;
    if (bestAt[0] <= blockAt) break;
    taken.push({ item: best.page!.items[best.idx]!, source: best.src.id, lane: best, at: bestAt });
    best.idx++;
  }
  return {
    taken: taken.map((t) => ({ item: t.item, source: t.source })),
    failed: lanes.filter((l) => l.error).map((l) => ({ ...l.src.failure, error: l.error! })),
    finish(n: number) {
      const k = Math.max(0, Math.min(n, taken.length));
      const p: Record<string, SrcState> = {};
      // Sources not asked this time (done, or gone from the list) keep their state.
      for (const [id, s] of Object.entries(st.p)) if (sources.some((x) => x.id === id)) p[id] = s;
      let open = false;
      for (const l of lanes) {
        const old: SrcState = st.p[l.src.id] ?? [null, 0, null, []];
        if (!l.page) {
          p[l.src.id] = old;
          continue;
        }
        const mine = taken.slice(0, k).filter((t) => t.lane === l).length;
        const consumed = l.skip + mine;
        if (consumed === 0 && l.page.items.length > 0) {
          p[l.src.id] = old;
          open = true;
          continue;
        }
        const next = l.page.cursorAfter(consumed);
        const done = next === null;
        const recent = [...old[3], ...l.page.items.slice(l.skip, consumed).map((it) => sourceKeyHash(it.key))].slice(-RECENT);
        // A source that gave nothing but looked back to its horizon: its later items sort no higher.
        const floor = consumed > 0 ? l.eff[consumed - 1]! : l.page.horizon !== undefined ? Math.min(l.page.horizon, old[2] ?? Number.POSITIVE_INFINITY) : old[2];
        p[l.src.id] = [next, done ? 1 : 0, floor, recent];
        if (!done) open = true;
      }
      const b = k > 0 ? taken[k - 1]!.at : st.b;
      const next: State = { s: st.s, b, p };
      return { hasMore: open, nextCursor: open ? encodeMergeCursor(next) : null };
    },
  };
}
