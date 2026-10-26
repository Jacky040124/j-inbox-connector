// Open-source boundary. Self-contained on purpose (no import from the repo's root scripts/), so this
// package and its tests can be published alone. src and tests may import only: node/bun builtins,
// files inside connector/, and workspace packages whose package.json says "license": "MIT".
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const DIR = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(DIR, "package.json"), "utf8"));

function sourceFiles(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    if (n === "node_modules" || n === "dist" || n.startsWith(".")) return [];
    const p = join(d, n);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx|js|mjs|jsx)$/.test(n) ? [p] : [];
  });
}

export function importsOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm))
    out.push((m[1] ?? m[2] ?? m[3] ?? m[4])!);
  return out;
}

/** License of an installed package, found by walking up node_modules like the resolver does. */
function licenseOf(name: string, from: string): string | null {
  for (let d = from; ; d = dirname(d)) {
    const p = join(d, "node_modules", ...name.split("/"), "package.json");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")).license ?? null;
    if (dirname(d) === d) return null;
  }
}

/** Why an import is not allowed, or null when it is. */
export function violation(file: string, spec: string): string | null {
  if (spec.startsWith("node:") || spec === "bun" || spec === "bun:test") return null;
  if (spec.startsWith(".")) return relative(DIR, resolve(dirname(file), spec)).startsWith("..") ? "relative import leaves connector/" : null;
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  const license = licenseOf(name, dirname(file));
  if (license !== "MIT") return `${name} is not an MIT package (license: ${license})`;
  return null;
}

describe("connector policy", () => {
  test("is MIT licensed with a LICENSE file and is publishable", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.private).not.toBe(true);
    expect(readFileSync(join(DIR, "LICENSE"), "utf8")).toContain("MIT License");
  });
  test("every import in src/ and test/ is a builtin, a connector file or an MIT package", () => {
    for (const f of sourceFiles(DIR)) for (const spec of importsOf(readFileSync(f, "utf8"))) expect(`${relative(DIR, f)}: ${spec}: ${violation(f, spec)}`).toBe(`${relative(DIR, f)}: ${spec}: null`);
  });
  test("production code depends only on @j-inbox/protocol", () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@j-inbox/protocol"]);
    const src = join(DIR, "src");
    if (!existsSync(src)) return;
    for (const f of sourceFiles(src))
      for (const spec of importsOf(readFileSync(f, "utf8"))) if (spec.startsWith("@")) expect(spec).toBe("@j-inbox/protocol");
  });
  test("all declared workspace dependencies are MIT", () => {
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) if (name.startsWith("@j-inbox/")) expect(`${name} ${licenseOf(name, DIR)}`).toBe(`${name} MIT`);
  });
  test("bin entries point at files that exist", () => {
    for (const p of Object.values<string>(typeof pkg.bin === "string" ? { j: pkg.bin } : (pkg.bin ?? {}))) expect(existsSync(join(DIR, p))).toBe(true);
  });
  test("the detector itself catches closed packages, root scripts and escapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "jinbox-policy-"));
    const f = join(dir, "x.ts");
    const q = (p: string) => JSON.stringify(p);
    const scope = "@j-inbox/";
    // Built at runtime so this file does not itself contain the forbidden imports.
    const [imp, exp, frm] = ["imp" + "ort", "exp" + "ort", "fr" + "om"];
    writeFileSync(f, [`${imp} a ${frm} ` + q(scope + "cloud"), `${exp} { b } ${frm} ` + q(scope + "web/x"), `const c = await ${imp}(` + q(scope + "protocol") + ")", `${imp} ` + q("./side")].join(";\n") + ";\n");
    expect(importsOf(readFileSync(f, "utf8"))).toEqual(["@j-inbox/cloud", "@j-inbox/web/x", "@j-inbox/protocol", "./side"]);
    const inSrc = join(DIR, "src", "a.ts");
    expect(violation(inSrc, scope + "testkit/fake-raft")).toMatch(/not an MIT package/);
    expect(violation(inSrc, scope + "cloud")).toMatch(/not an MIT package/);
    expect(violation(inSrc, "../../scripts/policy.ts")).toMatch(/leaves connector/);
    expect(violation(inSrc, "../../testkit/fake-beeper/index.ts")).toMatch(/leaves connector/);
    expect(violation(inSrc, scope + "protocol")).toBeNull();
    expect(violation(inSrc, scope + "fake-beeper")).toBeNull();
    expect(violation(inSrc, "./x.ts")).toBeNull();
    expect(violation(inSrc, "node:fs")).toBeNull();
  });
});
