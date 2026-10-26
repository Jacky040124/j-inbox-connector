// Small CLI helpers: version, port choice, device names, argument parsing, launchd program line.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { parseArgs } from "../src/cli.ts";
import { defaultDeviceName, serviceProgram, type CliDeps } from "../src/commands/context.ts";
import { pickServerPort, pidAlive, portInUse } from "../src/probe.ts";
import { CONNECTOR_VERSION } from "../src/version.ts";

describe("version", () => {
  test("matches package.json", () => {
    expect(CONNECTOR_VERSION).toBe(JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version);
  });
});

describe("ports", () => {
  test("pickServerPort: 23373 when free, else the first free one from 23374", async () => {
    expect(await pickServerPort(async () => false)).toBe(23373);
    expect(await pickServerPort(async (p) => p === 23373)).toBe(23374);
    expect(await pickServerPort(async (p) => p <= 23376)).toBe(23377);
    expect(await pickServerPort(async () => true)).toBeNull();
  });
  test("portInUse sees a listening socket and a closed port", async () => {
    const srv = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = (srv.address() as { port: number }).port;
    expect(await portInUse(port)).toBe(true);
    await new Promise((r) => srv.close(r));
    expect(await portInUse(port)).toBe(false);
  });
  test("pidAlive", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(99_999_999)).toBe(false);
    expect(pidAlive("1" as any)).toBe(false);
    expect(pidAlive(1)).toBe(false);
  });
});

describe("names and program", () => {
  test("defaultDeviceName strips .local and odd characters, never empty", () => {
    expect(defaultDeviceName("Jackys-Mac-mini.local")).toBe("Jackys-Mac-mini");
    expect(defaultDeviceName("<script>.local")).toBe("script");
    expect(defaultDeviceName("")).toBe("Mac");
    expect(defaultDeviceName("x".repeat(100)).length).toBe(64);
  });
  test("serviceProgram: the compiled binary runs itself; dev mode runs bun + cli.ts", () => {
    const d = (execPath: string, mainPath: string) => ({ execPath, mainPath }) as CliDeps;
    expect(serviceProgram(d("/opt/homebrew/bin/j-inbox", "/$bunfs/root/j-inbox"))).toEqual(["/opt/homebrew/bin/j-inbox", "run"]);
    expect(serviceProgram(d("/usr/local/bin/bun", "/src/connector/src/cli.ts"))).toEqual(["/usr/local/bin/bun", "/src/connector/src/cli.ts", "run"]);
  });
});

describe("parseArgs", () => {
  test("commands, flags, values and = syntax", () => {
    expect(parseArgs(["status", "--json"])).toEqual({ command: "status", flags: { json: true } });
    expect(parseArgs(["logs", "-n", "5"])).toEqual({ command: "logs", flags: { n: "5" } });
    expect(parseArgs(["pair", "--name=Studio Mac", "--force"])).toEqual({ command: "pair", flags: { name: "Studio Mac", force: true } });
  });
  test("refuses unknown flags, flags of other commands, missing values, extra args", () => {
    for (const a of [["status", "--force"], ["pair", "--name"], ["status", "extra"], ["--json=1", "status"], ["logs", "-x"], ["__proto__"], ["constructor"], ["pair", "--name", "--force"]]) expect(() => parseArgs(a)).toThrow();
  });
});
