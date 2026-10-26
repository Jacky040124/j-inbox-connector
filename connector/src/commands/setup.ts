// `j-inbox setup`: Beeper (Desktop already here, or Beeper Server installed through the beeper
// CLI on a free port) -> Beeper token into the Keychain -> pair -> launchd agent -> checks.
// The beeper CLI calls are the only place J-Inbox installs anything; tests run them against fakes.
import { DEFAULT_BEEPER_URL, loadConfig, saveConfig, validateBeeperURL, validateCloudURL, type Config, type Engine } from "../config.ts";
import { generatePlist, installAgent } from "../launchd.ts";
import { pickServerPort, probeBeeper } from "../probe.ts";
import { isStorableSecret } from "../secrets.ts";
import { runChecks, sleepMinutes } from "./doctor.ts";
import { pairCommand } from "./pair.ts";
import { UsageError, serviceProgram, type Ctx } from "./context.ts";

export const BEEPER_TARGET = "j-inbox";
/** The beeper CLI steps (docs: developers.beeper.com/desktop-api-reference/cli). */
export const beeperCommands = (port: number) => ({
  version: ["beeper", "--version"],
  addTarget: ["beeper", "targets", "add", "server", BEEPER_TARGET, "--port", String(port)],
  setup: ["beeper", "setup", "--server", "--install", "--target", BEEPER_TARGET],
  enable: ["beeper", "targets", "enable", BEEPER_TARGET],
});

async function chooseEngine(ctx: Ctx): Promise<Engine> {
  const f = ctx.flags.engine;
  if (f !== undefined) {
    if (f !== "desktop" && f !== "server") throw new UsageError("--engine must be desktop or server.");
    return f;
  }
  const desktopRunning = await ctx.deps.portInUse(23373);
  if (ctx.deps.isTTY && !ctx.flags.yes) {
    const a = (await ctx.deps.prompt.line(desktopRunning ? "Beeper Desktop seems to be running. Use it (d), or install Beeper Server next to it (s)? [d/s] " : "Install Beeper Server (s) or use Beeper Desktop (d)? [s/d] "))?.trim().toLowerCase();
    if (a === "d" || a === "desktop") return "desktop";
    if (a === "s" || a === "server") return "server";
  }
  return desktopRunning ? "desktop" : "server";
}

async function installServer(ctx: Ctx): Promise<string | null> {
  const { deps } = ctx;
  let port: number | null;
  if (ctx.flags["beeper-port"] !== undefined) {
    port = Number(ctx.flags["beeper-port"]);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new UsageError("--beeper-port must be a port number from 1024 to 65535.");
  } else port = await pickServerPort(deps.portInUse);
  if (port === null) {
    deps.err("No free port for Beeper Server between 23373 and 23399.");
    return null;
  }
  const cmd = beeperCommands(port);
  const v = await deps.run(cmd.version, { timeoutMs: 30_000 });
  if (v.code !== 0) {
    deps.err("The Beeper CLI is not installed. Install it with:");
    deps.err("    brew install beeper/tap/cli");
    deps.err("then run `j-inbox setup` again.");
    return null;
  }
  deps.out(`Installing Beeper Server on port ${port}${port !== 23373 ? " (23373 is taken, probably by Beeper Desktop)" : ""}.`);
  const add = await deps.run(cmd.addTarget, { timeoutMs: 60_000 });
  if (add.code !== 0) deps.out("(The beeper target may already exist; continuing.)");
  deps.out("Beeper will now sign you in (email code) and verify this device. Follow its prompts.");
  const setup = await deps.run(cmd.setup, { inherit: true });
  if (setup.code !== 0) {
    deps.err(`\`${cmd.setup.join(" ")}\` failed (exit ${setup.code}). Fix that first, then run \`j-inbox setup\` again.`);
    return null;
  }
  const enable = await deps.run(cmd.enable, { timeoutMs: 60_000 });
  if (enable.code !== 0) deps.out(`Could not enable Beeper Server at login; run \`${cmd.enable.join(" ")}\` later.`);
  return `http://127.0.0.1:${port}`;
}

async function obtainToken(ctx: Ctx, beeperURL: string, engine: Engine): Promise<string | null> {
  const { deps } = ctx;
  const check = async (token: string) => {
    if (!isStorableSecret(token)) return "That does not look like a Beeper access token.";
    const p = await probeBeeper(beeperURL, token, deps.fetchImpl, 5000);
    if (!p.reachable) return `Beeper is not reachable at ${beeperURL}.`;
    if (p.tokenValid !== true) return "Beeper rejected this token.";
    return null;
  };
  if (ctx.flags["beeper-token-stdin"]) {
    const token = (await deps.readStdin()).split(/\r?\n/)[0]!.trim();
    const problem = await check(token);
    if (problem) {
      deps.err(problem);
      return null;
    }
    return token;
  }
  if (!deps.isTTY) {
    deps.err("No terminal to ask for the Beeper token. Pipe it in with --beeper-token-stdin.");
    return null;
  }
  deps.out(
    engine === "desktop"
      ? "Create an access token in Beeper Desktop: Settings > Developers > Beeper Desktop API > + (approved connections), then paste it here."
      : "Paste an access token for Beeper Server (for example from Beeper Desktop's Developers settings on the same account).",
  );
  for (let i = 0; i < 3; i++) {
    const token = (await deps.prompt.secret("Beeper access token: "))?.trim();
    if (!token) return null;
    const problem = await check(token);
    if (!problem) return token;
    deps.out(`${problem} Try again.`);
  }
  deps.err("Giving up after 3 attempts.");
  return null;
}

export async function setupCommand(ctx: Ctx): Promise<number> {
  const { deps, flags } = ctx;
  let config: Config;
  try {
    config = loadConfig(ctx.paths);
  } catch (e) {
    deps.err((e as Error).message);
    return 1;
  }
  if (typeof flags["cloud-url"] === "string") config.cloudURL = validateCloudURL(flags["cloud-url"]);
  deps.out("J-Inbox setup");
  deps.out("Step 1 of 4: Beeper");
  const engine = await chooseEngine(ctx);
  let beeperURL: string;
  if (typeof flags["beeper-url"] === "string") {
    try {
      beeperURL = validateBeeperURL(flags["beeper-url"]);
    } catch (e) {
      deps.err((e as Error).message);
      return 1;
    }
  } else if (engine === "desktop") beeperURL = DEFAULT_BEEPER_URL;
  else {
    const url = await installServer(ctx);
    if (!url) return 1;
    beeperURL = url;
  }

  deps.out("Step 2 of 4: Beeper access token");
  const token = await obtainToken(ctx, beeperURL, engine);
  if (!token) return 1;
  await ctx.secrets.set("beeper-token", token);
  config = { ...config, beeperURL, engine };
  saveConfig(ctx.paths, config);
  deps.out("Beeper token saved to the Keychain.");

  deps.out("Step 3 of 4: pair with J-Inbox");
  if (flags["skip-pair"]) deps.out("Skipped (--skip-pair). Run `j-inbox pair` later.");
  else {
    const code = await pairCommand({ ...ctx, flags: { ...flags, force: false } }, { quietIfPaired: true });
    if (code !== 0) return code;
  }

  deps.out("Step 4 of 4: background service");
  if (flags["no-service"]) deps.out("Skipped (--no-service). Run `j-inbox run` yourself.");
  else {
    const env: Record<string, string> = {};
    if (ctx.paths.testMode) {
      env.J_INBOX_CONFIG_DIR = ctx.paths.configDir;
      if (deps.env.J_INBOX_SECRETS) env.J_INBOX_SECRETS = deps.env.J_INBOX_SECRETS;
    }
    const plist = generatePlist({ program: serviceProgram(deps), logDir: ctx.paths.logDir, env });
    try {
      const r = await installAgent({ launchAgentsDir: ctx.paths.launchAgentsDir, plist, uid: deps.uid, run: deps.run });
      deps.out(`Installed ${r.path}; the connector starts at login and restarts if it crashes.`);
    } catch (e) {
      deps.err((e as Error).message);
      return 1;
    }
  }

  ctx.audit.lifecycle("setup.completed");
  const sleep = await sleepMinutes(ctx);
  if (sleep !== null && sleep > 0) deps.out(`Note: this Mac goes to sleep after ${sleep} minutes, and J-Inbox is offline while it sleeps. Turn automatic sleep off in System Settings > Energy.`);
  if (!flags["no-service"] && !flags["skip-pair"]) {
    const failed = (await runChecks(ctx)).filter((c) => c.level === "fail" && c.id !== "service");
    for (const c of failed) deps.out(`[fail] ${c.message}${c.fix ? ` (fix: ${c.fix})` : ""}`);
  }
  deps.out("Done. Check anytime with `j-inbox status`.");
  return 0;
}
