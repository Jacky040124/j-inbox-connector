// get_media serves only asset URLs this connector itself returned (Beeper's /v1/assets/serve
// accepts arbitrary file:// URLs). The allowlist stores hashes only and is bounded.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetAllowlist } from "../src/assets.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "jinbox-assets-"));

describe("AssetAllowlist", () => {
  test("allows only URLs that were added", () => {
    const a = new AssetAllowlist();
    a.add("mxc://beeper.local/img_small");
    expect(a.has("mxc://beeper.local/img_small")).toBe(true);
    expect(a.has("mxc://beeper.local/img_other")).toBe(false);
    expect(a.has("file:///etc/passwd")).toBe(false);
  });
  test("file:// URLs match after percent-decoding normalisation, but not a different path", () => {
    const a = new AssetAllowlist();
    a.add("file:///Users/x/Library/Application%20Support/BeeperTexts/media/a.png");
    expect(a.has("file:///Users/x/Library/Application Support/BeeperTexts/media/a.png")).toBe(true);
    expect(a.has("file:///Users/x/Library/Application%20Support/BeeperTexts/media/b.png")).toBe(false);
  });
  test("is bounded: the oldest entries go first", () => {
    const a = new AssetAllowlist({ max: 3 });
    for (const n of [1, 2, 3, 4]) a.add(`mxc://h/${n}`);
    expect(a.size).toBe(3);
    expect(a.has("mxc://h/1")).toBe(false);
    expect(a.has("mxc://h/4")).toBe(true);
  });
  test("re-adding refreshes an entry so it is not evicted", () => {
    const a = new AssetAllowlist({ max: 2 });
    a.add("mxc://h/1");
    a.add("mxc://h/2");
    a.add("mxc://h/1");
    a.add("mxc://h/3");
    expect(a.has("mxc://h/1")).toBe(true);
    expect(a.has("mxc://h/2")).toBe(false);
  });
  test("entries expire after the TTL", () => {
    let now = 1000;
    const a = new AssetAllowlist({ ttlMs: 100, now: () => now });
    a.add("mxc://h/1");
    now += 99;
    expect(a.has("mxc://h/1")).toBe(true);
    now += 2;
    expect(a.has("mxc://h/1")).toBe(false);
  });
  test("ignores junk and huge input", () => {
    const a = new AssetAllowlist();
    a.add(undefined as any);
    a.add("x".repeat(100_000));
    expect(a.size).toBe(0);
    expect(a.has(123 as any)).toBe(false);
  });
  test("persists hashes only (no URL, no path) with mode 0600 and survives a restart", () => {
    const dir = tmp();
    const path = join(dir, "assets.json");
    const a = new AssetAllowlist({ path });
    a.add("file:///Users/secret-name/Library/media/photo%20of%20bob.png");
    a.flush();
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("secret-name");
    expect(raw).not.toContain("photo");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const b = new AssetAllowlist({ path });
    expect(b.has("file:///Users/secret-name/Library/media/photo%20of%20bob.png")).toBe(true);
  });
  test("a corrupt or hostile file is ignored, not trusted", () => {
    const dir = tmp();
    const path = join(dir, "assets.json");
    writeFileSync(path, "{not json");
    expect(new AssetAllowlist({ path }).size).toBe(0);
    writeFileSync(path, JSON.stringify({ v: 1, entries: [["not-a-hash", 1], [{ a: 1 }, 2], ["0".repeat(64), "x"]] }));
    expect(new AssetAllowlist({ path }).size).toBe(0);
  });
});
