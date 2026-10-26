// Open-source package: self-contained (no imports outside this directory, no workspace packages),
// so it can be published next to the MIT connector without any closed code.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DIR = resolve(import.meta.dir, "..");

function files(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    if (n === "node_modules" || n.startsWith(".")) return [];
    const p = join(d, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|js|mjs)$/.test(n) ? [p] : [];
  });
}

const SPEC_RE = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;

describe("fake-beeper policy", () => {
  test("is MIT licensed with a LICENSE file and no dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(DIR, "package.json"), "utf8"));
    expect(pkg.license).toBe("MIT");
    expect(pkg.private).not.toBe(true);
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(readFileSync(join(DIR, "LICENSE"), "utf8")).toContain("MIT License");
  });
  test("imports only node/bun builtins and files inside this package", () => {
    for (const f of files(DIR))
      for (const m of readFileSync(f, "utf8").matchAll(SPEC_RE)) {
        const spec = (m[1] ?? m[2] ?? m[3] ?? m[4])!;
        if (spec.startsWith(".")) expect(`${f}: ${relative(DIR, resolve(f, "..", spec)).startsWith("..")}`).toBe(`${f}: false`);
        else expect(`${f}: ${spec}`).toMatch(/: (node:[a-z_/]+|bun|bun:test)$/);
      }
  });
});
