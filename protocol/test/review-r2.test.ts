// Review round 2 (2026-10-26) contract additions:
// stability-r2-STAB2-3 (the room tells browsers to refetch after it dropped connector events),
// stability-r2-STAB2-4 (a /live socket evicted for too many tabs gets a terminal close code).
import { describe, expect, test } from "bun:test";
import { CLOSE_CODES, LIVE_CLOSE_CODES, parseLiveServerMessage } from "../src/index.ts";

describe("STAB2-3: /live resync message", () => {
  test("{type:'resync'} with a known reason parses; anything extra does not", () => {
    const ok = parseLiveServerMessage(JSON.stringify({ type: "resync", reason: "events_dropped" }));
    expect(ok.ok).toBe(true);
    expect(parseLiveServerMessage(JSON.stringify({ type: "resync", reason: "because" })).ok).toBe(false);
    expect(parseLiveServerMessage(JSON.stringify({ type: "resync", reason: "events_dropped", chatID: "c1" })).ok).toBe(false);
  });
});

describe("STAB2-4: /live close codes", () => {
  test("TOO_MANY_TABS is its own 44xx code, distinct from every connector close code", () => {
    expect(LIVE_CLOSE_CODES.TOO_MANY_TABS).toBe(4429);
    expect(Object.values(CLOSE_CODES)).not.toContain(LIVE_CLOSE_CODES.TOO_MANY_TABS as never);
  });
});
