#!/usr/bin/env bun
// j-inbox: the J-Inbox connector CLI.
import { hostname } from "node:os";
import { AuditLog } from "./audit.ts";
import { resolvePaths } from "./config.ts";
import { portInUse } from "./probe.ts";
import { terminalPrompt } from "./prompt.ts";
import { realRunner } from "./runner.ts";
import { CONNECTOR_VERSION } from "./version.ts";
import { UsageError, secretStore, type CliDeps, type Ctx, type Flags } from "./commands/context.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { logsCommand } from "./commands/logs.ts";
import { pairCommand, unpairCommand } from "./commands/pair.ts";
import { runCommand } from "./commands/run.ts";
import { setupCommand } from "./commands/setup.ts";
import { statusCommand } from "./commands/status.ts";
import { uninstallCommand } from "./commands/uninstall.ts";
import { jevKeyCommand } from "./commands/jev-key.ts";

export type { CliDeps } from "./commands/context.ts";

type FlagSpec = Record<string, "bool" | "string">;
type Command = { summary: string; flags: FlagSpec; run: (ctx: Ctx) => Promise<number> };

const COMMANDS: Record<string, Command> = {
  setup: {
    summary: "Set everything up: Beeper, the Beeper token, pairing, the background service",
    flags: {
      engine: "string",
      "beeper-url": "string",
      "beeper-port": "string",
      "beeper-token-stdin": "bool",
      "cloud-url": "string",
      name: "string",
      "skip-pair": "bool",
      "no-service": "bool",
      yes: "bool",
    },
    run: setupCommand,
  },
  run: { summary: "Run the connector in the foreground (launchd runs this)", flags: {}, run: runCommand },
  status: { summary: "Beeper, pairing, background service and cloud link at a glance", flags: {}, run: statusCommand },
  logs: { summary: "Recent operations (metadata only: what, when, ok/error)", flags: { n: "string", service: "bool" }, run: logsCommand },
  pair: { summary: "Pair this computer with your J-Inbox (shows a code to type in the web page)", flags: { force: "bool", name: "string", "cloud-url": "string" }, run: (c) => pairCommand(c) },
  unpair: { summary: "Unpair this computer", flags: {}, run: unpairCommand },
  doctor: { summary: "Find common problems and how to fix them", flags: {}, run: doctorCommand },
  "jev-key": { summary: "Keep the Jev (TypeSafe) API key for noise in the Keychain (from stdin; --delete removes it)", flags: { delete: "bool" }, run: jevKeyCommand },
  uninstall: { summary: "Remove the connector's service, tokens and files (Beeper is left alone)", flags: { yes: "bool", "keep-config": "bool" }, run: uninstallCommand },
};

const GLOBAL: FlagSpec = { json: "bool", help: "bool", version: "bool", "config-dir": "string" };
const SHORT: Record<string, string> = { h: "help", v: "version", n: "n", y: "yes" };

function usage(): string {
  const lines = [
    `j-inbox ${CONNECTOR_VERSION}: links Beeper on this Mac to your J-Inbox (open source, MIT).`,
    "",
    "Usage: j-inbox <command> [options]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([n, c]) => `  ${n.padEnd(10)} ${c.summary}`),
    "",
    "Options:",
    "  --json              machine-readable output (status, doctor, logs)",
    "  --config-dir DIR    keep config, data and logs under DIR (J_INBOX_CONFIG_DIR)",
    "  -h, --help          this help",
    "  -v, --version       print the version",
    "",
    "setup:   --engine desktop|server  --beeper-url URL  --beeper-port N  --beeper-token-stdin",
    "         --cloud-url URL  --name NAME  --skip-pair  --no-service  --yes",
    "pair:    --force  --name NAME  --cloud-url URL",
    "logs:    -n N  --service",
    "jev-key: --delete   (the key comes from stdin, or a hidden prompt in a terminal; it is never shown)",
    "uninstall: --yes  --keep-config",
  ];
  return lines.join("\n");
}

export function parseArgs(argv: string[]): { command: string | null; flags: Flags } {
  const flags: Flags = {};
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("-")) {
      let name = a.startsWith("--") ? a.slice(2) : SHORT[a.slice(1)];
      let inline: string | undefined;
      if (name && name.includes("=")) [name, inline] = [name.slice(0, name.indexOf("=")), name.slice(name.indexOf("=") + 1)];
      const spec = name ? (GLOBAL[name] ?? (command ? COMMANDS[command]?.flags[name] : undefined)) : undefined;
      if (!name || !spec) throw new UsageError(`Unknown option ${a.slice(0, 40)}.`);
      if (spec === "bool") {
        if (inline !== undefined) throw new UsageError(`--${name} takes no value.`);
        flags[name] = true;
      } else {
        const v = inline ?? argv[++i];
        if (v === undefined || (inline === undefined && v.startsWith("--"))) throw new UsageError(`--${name} needs a value.`);
        flags[name] = v;
      }
    } else if (command === null) {
      command = a;
      if (!Object.hasOwn(COMMANDS, a)) throw new UsageError(`Unknown command "${a.slice(0, 40)}". Run \`j-inbox --help\`.`);
    } else throw new UsageError(`Unexpected argument "${a.slice(0, 40)}".`);
  }
  return { command, flags };
}

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    deps.err((e as Error).message);
    return 2;
  }
  const { command, flags } = parsed;
  if (flags.version) {
    deps.out(CONNECTOR_VERSION);
    return 0;
  }
  if (flags.help || !command) {
    deps.out(usage());
    return 0;
  }
  try {
    const env = { ...deps.env };
    if (typeof flags["config-dir"] === "string") env.J_INBOX_CONFIG_DIR = flags["config-dir"];
    const paths = resolvePaths(env);
    const ctx: Ctx = { deps: { ...deps, env }, paths, secrets: secretStore({ ...deps, env }, paths), flags, json: flags.json === true, audit: new AuditLog({ path: paths.auditFile }) };
    return await COMMANDS[command]!.run(ctx);
  } catch (e) {
    deps.err((e as Error).message);
    return e instanceof UsageError ? 2 : 1;
  }
}

export function realDeps(): CliDeps {
  return {
    env: process.env,
    out: (l) => process.stdout.write(l + "\n"),
    err: (l) => process.stderr.write(l + "\n"),
    run: realRunner,
    fetchImpl: fetch,
    prompt: terminalPrompt,
    readStdin: () => new Response(Bun.stdin.stream()).text(),
    uid: process.getuid?.() ?? 501,
    sleep: (ms) => Bun.sleep(ms),
    isTTY: !!process.stdin.isTTY,
    execPath: process.execPath,
    mainPath: Bun.main,
    hostname,
    portInUse: (p) => portInUse(p),
    onSignal(cb) {
      process.on("SIGINT", cb);
      process.on("SIGTERM", cb);
      return () => {
        process.off("SIGINT", cb);
        process.off("SIGTERM", cb);
      };
    },
  };
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), realDeps());
  process.exit(code);
}
