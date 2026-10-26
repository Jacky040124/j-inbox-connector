// Shared helpers for per-package policy tests (licenses and import boundaries).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");

export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs|jsx)$/.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Every import/require/dynamic import specifier in a file. */
export function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm)) {
    specs.push((m[1] ?? m[2] ?? m[3] ?? m[4])!);
  }
  return specs;
}

/** Package (top-level dir or @j-inbox/<name>) an import points into, if any. */
export function targetPackage(file: string, spec: string): string | null {
  const scoped = /^@j-inbox\/([^/]+)/.exec(spec);
  if (scoped) return scoped[1]!;
  if (!spec.startsWith(".")) return null;
  const rel = relative(ROOT, resolve(file, "..", spec));
  if (rel.startsWith("..")) return "outside-repo";
  return rel.split(/[\\/]/)[0] ?? null;
}

export function pkgJson(pkg: string): Record<string, any> {
  return JSON.parse(readFileSync(join(ROOT, pkg, "package.json"), "utf8"));
}
