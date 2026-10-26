// `j-inbox doctor`: finds common problems and says how to fix each. Read-only.
import { accessSync, constants, mkdirSync } from "node:fs";
import { loadConfig, type Config } from "../config.ts";
import { LAUNCHD_LABEL, isAgentInstalled } from "../launchd.ts";
import { pidHeldSince, probeBeeper } from "../probe.ts";
import { readState } from "../service.ts";
import type { Ctx } from "./context.ts";

export type Check = { id: string; level: "ok" | "warn" | "fail"; message: string; fix?: string };

export async function runChecks(ctx: Ctx): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  let config: Config;
  try {
    config = loadConfig(ctx.paths);
    add({ id: "config", level: "ok", message: `Config ${ctx.paths.configFile}` });
  } catch (e) {
    add({ id: "config", level: "fail", message: (e as Error).message, fix: "Fix or delete the file, then run `j-inbox setup`." });
    return checks;
  }

  let beeperToken: string | null = null;
  try {
    beeperToken = await ctx.secrets.get("beeper-token");
    add(beeperToken ? { id: "beeper-token", level: "ok", message: "Beeper token is in the Keychain" } : { id: "beeper-token", level: "fail", message: "No Beeper token stored", fix: "Run `j-inbox setup`." });
  } catch (e) {
    add({ id: "beeper-token", level: "fail", message: `Cannot read the Beeper token: ${(e as Error).message}`, fix: "Unlock the login keychain, then try again." });
  }

  const b = await probeBeeper(config.beeperURL, beeperToken, ctx.deps.fetchImpl);
  if (!b.reachable)
    add({
      id: "beeper",
      level: "fail",
      message: `Beeper is not reachable at ${config.beeperURL}`,
      fix: config.engine === "server" ? "Start it with `beeper targets start j-inbox` (and `beeper targets enable j-inbox` to start at login)." : "Open Beeper Desktop and make sure Settings > Developers > Beeper Desktop API is on.",
    });
  else {
    add({ id: "beeper", level: "ok", message: `${b.name ?? "Beeper"} ${b.version ?? ""} is running at ${config.beeperURL}` });
    if (beeperToken && b.tokenValid === false) add({ id: "beeper-auth", level: "fail", message: "Beeper rejected the stored token", fix: "Create a new token in Beeper and run `j-inbox setup` again." });
    else if (beeperToken && b.tokenValid) add({ id: "beeper-auth", level: b.accounts ? "ok" : "warn", message: b.accounts ? `Beeper accepted the token (${b.accounts} accounts)` : "Beeper accepted the token but has no chat accounts", ...(b.accounts ? {} : { fix: "Connect networks in Beeper (beeper accounts add)." }) });
  }

  let deviceToken: string | null = null;
  try {
    deviceToken = await ctx.secrets.get("device-token");
  } catch {}
  add(deviceToken && config.deviceID ? { id: "paired", level: "ok", message: `Paired as ${config.deviceName ?? config.deviceID}` } : { id: "paired", level: "fail", message: "This computer is not paired with J-Inbox", fix: "Run `j-inbox pair`." });

  try {
    const res = await ctx.deps.fetchImpl(new URL("/.well-known/raft-agent-manifest.json", config.cloudURL), { redirect: "manual", signal: AbortSignal.timeout(5000) });
    await res.body?.cancel().catch(() => {});
    add({ id: "cloud", level: res.status < 500 ? "ok" : "warn", message: `J-Inbox cloud ${config.cloudURL} answers (HTTP ${res.status})` });
  } catch {
    add({ id: "cloud", level: "fail", message: `Cannot reach the J-Inbox cloud at ${config.cloudURL}`, fix: "Check the internet connection (and any VPN or firewall)." });
  }

  const installed = await isAgentInstalled(ctx.paths.launchAgentsDir);
  const state = readState(ctx.paths);
  const running = !!state && pidHeldSince(state.pid, state.startedAt);
  if (state?.cloud.status === "stopped" && state.cloud.reason === "revoked") add({ id: "service", level: "fail", message: "This computer was removed in the J-Inbox web page", fix: "Run `j-inbox pair` to pair it again." });
  else if (state?.cloud.status === "stopped" && state.cloud.reason === "replaced") add({ id: "service", level: "fail", message: "Another computer was paired in place of this one", fix: "Run `j-inbox pair` to switch back to this computer." });
  else if (state?.cloud.status === "stopped" && state.cloud.reason === "version") add({ id: "service", level: "fail", message: "The cloud needs a newer connector", fix: "Run `brew upgrade j-inbox`." });
  else if (!installed) add({ id: "service", level: "fail", message: "The background service is not installed", fix: "Run `j-inbox setup` (it installs the launchd agent)." });
  else if (!running) add({ id: "service", level: "fail", message: "The background service is not running", fix: `Run \`launchctl kickstart -k gui/${ctx.deps.uid}/${LAUNCHD_LABEL}\` and check \`j-inbox logs --service\`.` });
  else if (state!.cloud.status === "connected") add({ id: "service", level: "ok", message: `The service is running (pid ${state!.pid}) and connected` });
  else add({ id: "service", level: "warn", message: `The service is running but ${state!.cloud.status}`, fix: "It retries on its own; see `j-inbox logs --service`." });

  try {
    mkdirSync(ctx.paths.logDir, { recursive: true, mode: 0o700 });
    accessSync(ctx.paths.logDir, constants.W_OK);
    add({ id: "logs", level: "ok", message: `Logs in ${ctx.paths.logDir}` });
  } catch {
    add({ id: "logs", level: "warn", message: `Cannot write logs to ${ctx.paths.logDir}`, fix: "Check the folder's permissions." });
  }

  const sleep = await sleepMinutes(ctx);
  if (sleep !== null && sleep > 0) add({ id: "sleep", level: "warn", message: `This Mac goes to sleep after ${sleep} minutes; J-Inbox is offline while it sleeps`, fix: "System Settings > Energy: prevent automatic sleeping (or `sudo pmset -a sleep 0`)." });
  else if (sleep === 0) add({ id: "sleep", level: "ok", message: "This Mac does not sleep on its own" });
  return checks;
}

/** System sleep timer in minutes from `pmset -g` (0 = never), or null when unknown. */
export async function sleepMinutes(ctx: Ctx): Promise<number | null> {
  const r = await ctx.deps.run(["/usr/bin/pmset", "-g"], { timeoutMs: 10_000 }).catch(() => null);
  if (!r || r.code !== 0) return null;
  const m = /^\s*sleep\s+(\d+)/m.exec(r.stdout);
  return m ? Number(m[1]) : null;
}

export async function doctorCommand(ctx: Ctx): Promise<number> {
  const checks = await runChecks(ctx);
  const failed = checks.some((c) => c.level === "fail");
  if (ctx.json) ctx.deps.out(JSON.stringify({ ok: !failed, checks }, null, 2));
  else {
    for (const c of checks) {
      ctx.deps.out(`[${c.level}] ${c.message}`);
      if (c.fix && c.level !== "ok") ctx.deps.out(`       fix: ${c.fix}`);
    }
    ctx.deps.out(failed ? "Some checks failed." : "No problems found.");
  }
  return failed ? 1 : 0;
}
