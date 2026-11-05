// The fixture's clock: fixed by default, where a test says otherwise.
import { describe, expect, test } from "bun:test";
import { CHAT_IDS, FIXTURE_NOW, buildFixture } from "../src/index.ts";

describe("buildFixture(now)", () => {
  const newest = (now?: number) => Math.max(...buildFixture(now).chats.map((c) => Date.parse(c.lastActivity!)));
  test("by default it stands at FIXTURE_NOW, as always", () => {
    expect(newest()).toBeLessThanOrEqual(FIXTURE_NOW);
    expect(newest()).toBeGreaterThan(FIXTURE_NOW - 3_600_000);
  });
  test("given a clock, the same chats and the same spread stand there", () => {
    const at = Date.parse("2030-01-01T00:00:00.000Z");
    const age = (f: ReturnType<typeof buildFixture>, now: number) => now - Date.parse(f.chats.find((c) => c.id === CHAT_IDS.media)!.lastActivity!);
    expect(age(buildFixture(at), at)).toBe(age(buildFixture(), FIXTURE_NOW));
    expect(buildFixture(at).chats.map((c) => c.id)).toEqual(buildFixture().chats.map((c) => c.id));
    expect(Date.parse(buildFixture(at).messages.get(CHAT_IDS.imessageAlice)!.at(-1)!.timestamp)).toBeGreaterThan(at - 24 * 3_600_000);
  });
});
