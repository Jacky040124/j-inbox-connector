// Filtered paging over Beeper pages with the connector's own cursor (spec-r1-F7), stopping on
// empty pages (tests-r1-TQ4), and shrinking pages to fit one frame (tests-r1-TQ5).
import { describe, expect, test } from "bun:test";
import { MAX_CURSOR_LENGTH, MAX_FRAME_BYTES, cursor as cursorSchema, parse } from "@j-inbox/protocol";
import { CursorExpired, CursorTooLong, RequestAborted, collect, decodePagerCursor, encodePagerCursor, finishPage, fitToFrame, type BeeperPage } from "../src/pager.ts";
import { MAX_ID_LENGTH } from "@j-inbox/protocol";

const SCOPE = "test\u0000scope";

type Item = { id: string; n: number };
const ALL: Item[] = Array.from({ length: 100 }, (_, i) => ({ id: `i${i}`, n: i }));

/** In-memory Beeper: pages of `size`, cursor = index of the next item. */
function source(items: Item[], size = 7, opts: { emptyAfter?: number } = {}) {
  let fetches = 0;
  const fetchPage = async (b: string | null): Promise<BeeperPage<Item>> => {
    fetches++;
    const start = b === null ? 0 : Number(b);
    if (opts.emptyAfter !== undefined && start >= opts.emptyAfter) return { items: [], hasMore: false, oldestCursor: null };
    const page = items.slice(start, start + size);
    const end = start + page.length;
    return { items: page, hasMore: end < items.length, oldestCursor: page.length ? String(end) : null };
  };
  return { fetchPage, fetches: () => fetches };
}

async function walk(keep: (i: Item) => boolean, limit: number, src = source(ALL)) {
  const seen: Item[] = [];
  let cur: string | null = null;
  for (let guard = 0; guard < 200; guard++) {
    const r: Awaited<ReturnType<typeof collect<Item>>> = await collect<Item>({ cursor: cur ? decodePagerCursor(cur, SCOPE) : null, limit, fetchPage: src.fetchPage, keep, keyOf: (i) => i.id });
    const page: { items: Item[]; hasMore: boolean; nextCursor: string | null } = finishPage(r, r.items.length, SCOPE);
    seen.push(...page.items);
    if (!page.hasMore) return seen;
    cur = page.nextCursor!;
  }
  throw new Error("did not terminate");
}

describe("pager cursor", () => {
  test("round trips and is a valid protocol cursor", () => {
    for (const c of [{ b: null, k: null }, { b: "eyJrIjoiYyJ9", k: "AAAAAAAAAAAAAAAA" }, { b: "1725489123456|c29tZQ", k: "abcdefghijklmnop" }]) {
      const s = encodePagerCursor(c, SCOPE);
      expect(parse(cursorSchema(MAX_CURSOR_LENGTH), s).ok).toBe(true);
      expect(decodePagerCursor(s, SCOPE)).toEqual(c);
    }
  });
  test("garbage and foreign cursors decode to null (caller answers BAD_PARAMS)", () => {
    for (const s of ["", "abc", "j1.", "j2.", "j2.!!!", "j2." + btoa("[]"), "j2." + btoa('{"b":1,"k":null,"s":"x"}'), "j2." + btoa('{"b":null,"k":null,"s":"x","x":1}'), "j1." + btoa('{"b":null,"k":null}')]) expect(decodePagerCursor(s, SCOPE)).toBeNull();
  });
  // tests-r2-TQ2-02: a cursor only works for the scope (action + chat / filters) that minted it.
  test("a cursor from another scope decodes to null", () => {
    const s = encodePagerCursor({ b: "x", k: null }, "read_chat\u0000chatA");
    expect(decodePagerCursor(s, "read_chat\u0000chatA")).toEqual({ b: "x", k: null });
    expect(decodePagerCursor(s, "read_chat\u0000chatB")).toBeNull();
    expect(decodePagerCursor(s, "list_chats\u0000{}")).toBeNull();
  });
  // stability-r2-R2-4: cursor size must not depend on unbounded upstream sizes.
  test("maximal ids and long Beeper cursors still make a valid cursor (the item key is hashed)", async () => {
    const id = "語".repeat(MAX_ID_LENGTH);
    const items = Array.from({ length: 3 }, (_, i) => ({ id: id.slice(0, MAX_ID_LENGTH - 1) + i, n: i }));
    const r = await collect({ cursor: { b: "c".repeat(600), k: null }, limit: 1, fetchPage: async () => ({ items, hasMore: true, oldestCursor: "o".repeat(600) }), keep: () => true, keyOf: (i) => i.id });
    const page = finishPage(r, 1, SCOPE);
    expect(parse(cursorSchema(MAX_CURSOR_LENGTH), page.nextCursor).ok).toBe(true);
    const next = await collect({ cursor: decodePagerCursor(page.nextCursor!, SCOPE), limit: 1, fetchPage: async () => ({ items, hasMore: true, oldestCursor: "o".repeat(600) }), keep: () => true, keyOf: (i) => i.id });
    expect(next.items.map((i) => i.n)).toEqual([1]);
  });
  test("a Beeper cursor too long to wrap throws CursorTooLong (answered as non-retryable TOO_LARGE)", () => {
    expect(() => encodePagerCursor({ b: "x".repeat(MAX_CURSOR_LENGTH), k: null }, SCOPE)).toThrow(CursorTooLong);
  });
});

describe("collect", () => {
  test("a sparse filter walks many Beeper pages and returns every match exactly once", async () => {
    const got = await walk((i) => i.n % 10 === 3, 3);
    expect(got.map((i) => i.n)).toEqual([3, 13, 23, 33, 43, 53, 63, 73, 83, 93]);
  });
  test("stopping in the middle of a Beeper page resumes right after the last item returned", async () => {
    const got = await walk(() => true, 5);
    expect(got.map((i) => i.n)).toEqual(ALL.map((i) => i.n));
  });
  test("no matches at all: one answer with zero items and no more pages", async () => {
    const r = await collect({ cursor: null, limit: 5, fetchPage: source(ALL).fetchPage, keep: () => false, keyOf: (i) => i.id, maxPages: 100 });
    expect(r.items).toEqual([]);
    expect(finishPage(r, 0, SCOPE)).toEqual({ items: [], hasMore: false, nextCursor: null });
  });
  test("the scan budget stops early with hasMore and a cursor past what was scanned", async () => {
    const src = source(ALL);
    const r = await collect({ cursor: null, limit: 5, fetchPage: src.fetchPage, keep: (i) => i.n > 90, keyOf: (i) => i.id, maxPages: 2 });
    expect(src.fetches()).toBe(2);
    expect(r.items).toEqual([]);
    const p = finishPage(r, 0, SCOPE);
    expect(p.hasMore).toBe(true);
    expect(decodePagerCursor(p.nextCursor!, SCOPE)).toEqual({ b: "14", k: null });
  });
  test("a scan cut short reports its horizon (the last item it looked at) only when timeOf is given", async () => {
    const src = source(ALL);
    const r = await collect({ cursor: null, limit: 5, fetchPage: src.fetchPage, keep: (i) => i.n > 90, keyOf: (i) => i.id, maxPages: 2, timeOf: (i) => 1000 - i.n });
    expect(r.hasMore).toBe(true);
    expect(r.horizon).toBe(1000 - 13);
    const plain = await collect({ cursor: null, limit: 5, fetchPage: source(ALL).fetchPage, keep: (i) => i.n > 90, keyOf: (i) => i.id, maxPages: 2 });
    expect(plain.horizon).toBeUndefined();
    // Finished walks and walks stopped by the limit have no horizon.
    expect((await collect({ cursor: null, limit: 3, fetchPage: source(ALL).fetchPage, keep: () => true, keyOf: (i) => i.id, timeOf: (i) => 1000 - i.n })).horizon).toBeUndefined();
  });
  test("a time budget is honoured too", async () => {
    let t = 0;
    const src = source(ALL);
    const r = await collect({ cursor: null, limit: 50, fetchPage: async (b) => ((t += 1000), src.fetchPage(b)), keep: () => false, keyOf: (i) => i.id, budgetMs: 2500, now: () => t });
    expect(src.fetches()).toBe(3);
    expect(r.hasMore).toBe(true);
  });
  // stability-r2-R2-3: the request deadline bounds the scan too, and an aborted request stops it.
  test("the request deadline stops the scan like the budget does", async () => {
    let t = 0;
    const src = source(ALL);
    const r = await collect({ cursor: null, limit: 50, fetchPage: async (b) => ((t += 1000), src.fetchPage(b)), keep: () => false, keyOf: (i) => i.id, budgetMs: 60_000, maxPages: 100, deadline: 2500, now: () => t });
    expect(src.fetches()).toBe(3);
    expect(r.hasMore).toBe(true);
  });
  test("an aborted request signal stops before the next page", async () => {
    const ctl = new AbortController();
    const src = source(ALL);
    const run = collect({ cursor: null, limit: 50, fetchPage: async (b) => (ctl.abort(), src.fetchPage(b)), keep: () => false, keyOf: (i) => i.id, signal: ctl.signal });
    await expect(run).rejects.toBeInstanceOf(RequestAborted);
    expect(src.fetches()).toBe(1);
  });
  test("an empty Beeper page ends the walk even when the previous page said hasMore (real iMessage)", async () => {
    const src = source(ALL, 20, { emptyAfter: 20 });
    const r = await collect({ cursor: null, limit: 30, fetchPage: src.fetchPage, keep: () => true, keyOf: (i) => i.id });
    expect(r.items.length).toBe(20);
    expect(r.hasMore).toBe(false);
    expect(src.fetches()).toBe(2);
  });
  test("a resume key that vanished from an older page (item moved) restarts that page instead of skipping", async () => {
    const r = await collect({ cursor: { b: "7", k: "gone-gone-gone-g" }, limit: 3, fetchPage: source(ALL).fetchPage, keep: () => true, keyOf: (i) => i.id });
    expect(r.items.map((i) => i.n)).toEqual([7, 8, 9]);
  });
  // spec-r2-R2-SPEC-2: a cursor minted inside the newest page must not restart at the (new) top.
  test("new items pushed the anchor off the first Beeper page: resume walks older pages and continues after it", async () => {
    const items: Item[] = Array.from({ length: 101 }, (_, i) => ({ id: `m${100 - i}`, n: 100 - i })); // m100 (newest) .. m0
    const src = source(items, 20);
    const first = await collect({ cursor: null, limit: 5, fetchPage: src.fetchPage, keep: () => true, keyOf: (i) => i.id });
    expect(first.items.map((i) => i.id)).toEqual(["m100", "m99", "m98", "m97", "m96"]);
    const cursor = finishPage(first, 5, SCOPE).nextCursor!;
    for (let n = 101; n <= 125; n++) items.unshift({ id: `m${n}`, n }); // 25 new messages arrive
    const second = await collect({ cursor: decodePagerCursor(cursor, SCOPE), limit: 5, fetchPage: src.fetchPage, keep: () => true, keyOf: (i) => i.id });
    expect(second.items.map((i) => i.id)).toEqual(["m95", "m94", "m93", "m92", "m91"]);
  });
  test("an anchor that is gone for good is CursorExpired (BAD_PARAMS), never a silent restart at the top", async () => {
    const items: Item[] = Array.from({ length: 40 }, (_, i) => ({ id: `m${40 - i}`, n: 40 - i }));
    const src = source(items, 20);
    const first = await collect({ cursor: null, limit: 2, fetchPage: src.fetchPage, keep: () => true, keyOf: (i) => i.id });
    const cursor = decodePagerCursor(finishPage(first, 2, SCOPE).nextCursor!, SCOPE);
    items.splice(1, 1); // the anchor (m39) is deleted
    await expect(collect({ cursor, limit: 2, fetchPage: src.fetchPage, keep: () => true, keyOf: (i) => i.id })).rejects.toBeInstanceOf(CursorExpired);
  });
});

describe("fitToFrame", () => {
  const blob = (n: number) => ({ items: Array.from({ length: n }, () => "語".repeat(4000)) });
  test("returns all items when they fit", () => {
    expect(fitToFrame(3, blob)).toBe(3);
  });
  test("returns the largest count whose res frame fits", () => {
    const n = fitToFrame(200, blob);
    expect(n).toBeGreaterThan(10);
    expect(n).toBeLessThan(200);
    expect(JSON.stringify(blob(n)).length * 3).toBeLessThan(MAX_FRAME_BYTES * 1.01);
    expect(fitToFrame(n + 1, blob)).toBe(n);
  });
  test("returns 0 when even one item is too big", () => {
    expect(fitToFrame(5, (n) => ({ x: "a".repeat(MAX_FRAME_BYTES * n) }))).toBe(0);
  });
  test("zero items is zero", () => {
    expect(fitToFrame(0, blob)).toBe(0);
  });
});
