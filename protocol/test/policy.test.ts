import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, importsOf, pkgJson, sourceFiles, targetPackage } from "../../scripts/policy.ts";

describe("protocol policy", () => {
  test("is MIT licensed with a LICENSE file and no dependencies", () => {
    const p = pkgJson("protocol");
    expect(p.license).toBe("MIT");
    expect(p.dependencies ?? {}).toEqual({});
    expect(readFileSync(join(ROOT, "protocol", "LICENSE"), "utf8")).toContain("MIT License");
  });
  test("never imports another workspace package", () => {
    for (const f of sourceFiles(join(ROOT, "protocol")))
      for (const spec of importsOf(f)) {
        const t = targetPackage(f, spec);
        if (t && t !== "protocol" && t !== "scripts") throw new Error(`${f} imports ${spec}`);
      }
  });
});
