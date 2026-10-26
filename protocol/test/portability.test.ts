import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as P from "../src/index.ts";

const SRC = join(import.meta.dir, "..", "src");
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));

describe("protocol is portable (Workers, Bun, browsers) and dependency-free", () => {
  test("only relative imports", () => {
    for (const f of files) {
      const src = readFileSync(join(SRC, f), "utf8");
      for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) expect(m[1]!.startsWith("./")).toBe(true);
    }
  });
  test("no runtime-specific globals", () => {
    for (const f of files) {
      const src = readFileSync(join(SRC, f), "utf8");
      for (const bad of [/\bBun\./, /\bprocess\./, /\brequire\(/, /\bBuffer\b/, /node:/, /\bDeno\./]) expect(`${f}: ${bad.test(src)}`).toBe(`${f}: false`);
    }
  });
  test("bundles for the browser target", async () => {
    const out = await Bun.build({ entrypoints: [join(SRC, "index.ts")], target: "browser" });
    expect(out.success).toBe(true);
  });
  test("index re-exports the main entry points", () => {
    for (const k of ["ACTIONS", "parseActionParams", "parseConnectorFrame", "parseCloudFrame", "buildRaftManifest", "pairPollResponse", "meResponse", "PROTOCOL_VERSION", "ERROR_CODES", "sanitizeText"]) expect(k in P).toBe(true);
  });
});
