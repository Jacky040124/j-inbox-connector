// Mixed paging (src/merge.ts), property style: random sources with random interleavings, page
// sizes, short pages, empty scan pages and failures, paged to the end through the real
// mergeCollect and its composite cursor. Every item exactly once, newest first.
import { describe, expect, test } from "bun:test";
import { makeError } from "@j-inbox/protocol";
import { SourceFailure, decodeMergeCursor, mergeCollect, type MergeItem, type MergeSource, type Merged, type SourcePage } from "../src/merge.ts";

/** Deterministic PRNG. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Item = { id: string; t: number };

/**
 * A source over a fixed newest-first list. Its own cursor is "o<offset>". It may return fewer
 * items than asked (short pages), and now and then none at all with hasMore (a scan budget ran out
 * on items it skipped), like Beeper and Gmail do.
 */
function listSource(id: string, rank: number, items: Item[], r: () => number, o: { emptyPages?: boolean; failEvery?: number } = {}): MergeSource<Item> & { calls: number } {
  const src = {
    id,
    rank,
    calls: 0,
    failure: { source: "gmail" as const, accountID: `gmail:${id}@example.com` },
    async fetch(cursor: string | null, limit: number): Promise<SourcePage<Item>> {
      src.calls++;
      if (o.failEvery && src.calls % o.failEvery === 0) throw new SourceFailure(makeError("UPSTREAM_DOWN", "flaky"));
      const start = cursor === null ? 0 : Number(/^o(\d+)$/.exec(cursor)![1]);
      if (o.emptyPages && r() < 0.15 && start < items.length) {
        // Scanned a stretch without a match: no items, but the position moved on by up to 3.
        const skip = Math.min(items.length - start, 1 + Math.floor(r() * 3));
        // Skipped items are not matches of this list: they are removed for good.
        items.splice(start, skip);
        return { items: [], hasMore: start < items.length, cursorAfter: () => (start < items.length ? `o${start}` : null) };
      }
      const n = Math.max(0, Math.min(limit, Math.floor(r() * (limit + 1)) || limit));
      const page = items.slice(start, start + n);
      const hasMore = start + page.length < items.length;
      return {
        items: page.map((x): MergeItem<Item> => ({ value: x, time: x.t, key: x.id })),
        hasMore,
        cursorAfter: (k) => (start + k < items.length ? `o${start + k}` : null),
      };
    },
  };
  return src;
}

async function walk(sources: MergeSource<Item>[], limit: number, scope = "s") {
  const out: Item[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 10_000; pages++) {
    const m: Merged<Item> | "bad" = await mergeCollect(sources, cursor, limit, scope);
    if (m === "bad") throw new Error("bad cursor");
    const n = m.taken.length;
    out.push(...m.taken.map((t) => t.item.value));
    const f: { hasMore: boolean; nextCursor: string | null } = m.finish(n);
    if (!f.hasMore) return { out, pages: pages + 1 };
    cursor = f.nextCursor;
  }
  throw new Error("did not finish");
}

function randomSources(seed: number) {
  const r = rng(seed);
  const k = 1 + Math.floor(r() * 4);
  const lists: Item[][] = [];
  for (let s = 0; s < k; s++) {
    const len = Math.floor(r() * 60);
    let t = 2_000_000 + Math.floor(r() * 1000);
    const list: Item[] = [];
    for (let i = 0; i < len; i++) {
      // Ties across and within sources happen on purpose.
      t -= Math.floor(r() * 3) * 1000;
      list.push({ id: `${s}-${i}`, t });
    }
    lists.push(list);
  }
  return { r, lists };
}

describe("k-way merge over random sources", () => {
  test("300 random interleavings: every item once, newest first", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { r, lists } = randomSources(seed);
      const expected = lists.flat();
      const sources = lists.map((l, i) => listSource(`s${i}`, i, [...l], r));
      const limit = 1 + Math.floor(r() * 12);
      const { out } = await walk(sources, limit);
      const ids = out.map((x) => x.id);
      expect(`${seed}: dupes ${ids.length - new Set(ids).size}`).toBe(`${seed}: dupes 0`);
      expect(`${seed}: ${[...ids].sort().join(",")}`).toBe(`${seed}: ${expected.map((x) => x.id).sort().join(",")}`);
      for (let i = 1; i < out.length; i++) if (out[i]!.t > out[i - 1]!.t) throw new Error(`seed ${seed}: order broken at ${i}`);
    }
  });

  test("with empty scan pages (a source moves on without items) nothing is skipped or repeated", async () => {
    for (let seed = 1000; seed < 1150; seed++) {
      const { r, lists } = randomSources(seed);
      const copies = lists.map((l) => [...l]);
      const sources = copies.map((l, i) => listSource(`s${i}`, i, l, r, { emptyPages: true }));
      const { out } = await walk(sources, 1 + Math.floor(r() * 8));
      // Items a source dropped while scanning are gone from its list; everything left came once.
      const ids = out.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(copies.flat().map((x) => x.id).sort());
    }
  });

  test("a source whose order is not by time stays consistent (effective time never rises within it)", async () => {
    const r = rng(7);
    const a = Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, t: 1000 - i * 10 + (i % 3 === 0 ? 25 : 0) }));
    const b = Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, t: 995 - i * 10 }));
    for (const limit of [1, 3, 7, 30]) {
      const { out } = await walk([listSource("a", 0, [...a], r), listSource("b", 1, [...b], r)], limit);
      expect(out.map((x) => x.id).sort()).toEqual([...a, ...b].map((x) => x.id).sort());
    }
  });

  test("a failing source is reported, keeps its place, and the other still pages", async () => {
    const r = rng(3);
    const a = Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, t: 10_000 - i * 7 }));
    const b = Array.from({ length: 25 }, (_, i) => ({ id: `b${i}`, t: 10_003 - i * 7 }));
    const flaky = listSource("b", 1, [...b], r, { failEvery: 2 });
    let cursor: string | null = null;
    const seen: string[] = [];
    let failures = 0;
    for (let i = 0; i < 200; i++) {
      const m: Merged<Item> | "bad" = await mergeCollect([listSource("a", 0, [...a], () => 0.99), flaky], cursor, 5, "s");
      if (m === "bad") throw new Error("bad");
      failures += m.failed.length;
      if (m.failed.length) expect(m.failed[0]).toMatchObject({ source: "gmail", accountID: "gmail:b@example.com", error: { code: "UPSTREAM_DOWN" } });
      seen.push(...m.taken.map((t) => t.item.value.id));
      const f: { hasMore: boolean; nextCursor: string | null } = m.finish(m.taken.length);
      if (!f.hasMore) break;
      cursor = f.nextCursor;
    }
    expect(failures).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
    // Every item of the healthy source came through.
    for (const x of a) expect(seen).toContain(x.id);
  });

  test("a smaller page than taken (frame fitting) resumes right after what was returned", async () => {
    const r = rng(11);
    const a = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, t: 500 - i }));
    const b = Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, t: 500 - i }));
    const srcs = [listSource("a", 0, [...a], () => 0.99), listSource("b", 1, [...b], () => 0.99)];
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let i = 0; i < 100; i++) {
      const m: Merged<Item> | "bad" = await mergeCollect(srcs, cursor, 6, "s");
      if (m === "bad") throw new Error("bad");
      const n = Math.max(1, Math.floor(r() * m.taken.length));
      seen.push(...m.taken.slice(0, n).map((t) => t.item.value.id));
      const f: { hasMore: boolean; nextCursor: string | null } = m.finish(n);
      if (!f.hasMore) break;
      cursor = f.nextCursor;
    }
    expect(seen.sort()).toEqual([...a, ...b].map((x) => x.id).sort());
  });

  test("cursors are bound to their scope and refuse garbage", async () => {
    const m: Merged<Item> | "bad" = await mergeCollect([listSource("a", 0, Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, t: 100 - i })), () => 0.99)], null, 3, "scope-1");
    if (m === "bad") throw new Error("bad");
    const c = m.finish(3).nextCursor!;
    expect(decodeMergeCursor(c, "scope-1")).not.toBeNull();
    expect(await mergeCollect([], c, 3, "scope-2")).toBe("bad");
    for (const g of ["jm.", "jm.e30", "j2.abc", "jm." + Buffer.from('{"s":"x","b":null,"p":{"__proto__":[null,0,null,[]]}}').toString("base64url"), "x".repeat(2000)]) expect(await mergeCollect([], g, 3, "scope-1")).toBe("bad");
  });

  test("a new item at the top shifts the source's positions: the boundary keeps the next page from repeating", async () => {
    const list = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, t: 100 - i * 10 }));
    const src = listSource("a", 0, list, () => 0.99);
    const p1 = await mergeCollect([src], null, 3, "s");
    if (p1 === "bad") throw new Error("bad");
    expect(p1.taken.map((t) => t.item.value.id)).toEqual(["a0", "a1", "a2"]);
    const c = p1.finish(3).nextCursor;
    // A chat got new activity and now sits on top: every offset moved down by one.
    list.unshift({ id: "new", t: 300 });
    // Offset 3 now points at a2 again (already returned): skipped; the rest follows once each.
    const rest: string[] = [];
    let cur = c;
    for (let i = 0; i < 10 && cur; i++) {
      const m: Merged<Item> | "bad" = await mergeCollect([src], cur, 3, "s");
      if (m === "bad") throw new Error("bad");
      rest.push(...m.taken.map((t) => t.item.value.id));
      cur = m.finish(m.taken.length).nextCursor;
    }
    expect(rest).toEqual(["a3", "a4", "a5"]);
  });
});
