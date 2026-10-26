// `j-inbox status`: Beeper, pairing, background service and cloud link, at a glance.
import { loadConfig } from "../config.ts";
import { isAgentInstalled } from "../launchd.ts";
import { pidHeldSince, probeBeeper, type BeeperProbe } from "../probe.ts";
import { readState, type ServiceState } from "../service.ts";
import { CONNECTOR_VERSION } from "../version.ts";
import type { Ctx } from "./context.ts";

export type StatusReport = {
  version: string;
  beeper: BeeperProbe;
  beeperToken: boolean;
  paired: { deviceID: string; deviceName: string | null } | null;
  service: { installed: boolean; running: boolean; pid?: number };
  cloud: (ServiceState["cloud"] & { url: string }) | { url: string; status: "unknown" };
  healthy: boolean;
};

export async function gatherStatus(ctx: Ctx): Promise<StatusReport> {
  const config = loadConfig(ctx.paths);
  const beeperToken = await ctx.secrets.get("beeper-token").catch(() => null);
  const deviceToken = await ctx.secrets.get("device-token").catch(() => null);
  const beeper = await probeBeeper(config.beeperURL, beeperToken, ctx.deps.fetchImpl);
  const state = readState(ctx.paths);
  // Not just "is the pid alive": after a reboot the pid may belong to another process.
  const running = !!state && pidHeldSince(state.pid, state.startedAt);
  const installed = await isAgentInstalled(ctx.paths.launchAgentsDir);
  const paired = config.deviceID && deviceToken ? { deviceID: config.deviceID, deviceName: config.deviceName ?? null } : null;
  const cloud = running && state ? { ...state.cloud, url: config.cloudURL } : state?.cloud.status === "stopped" && state.cloud.reason !== "shutdown" ? { ...state.cloud, url: config.cloudURL } : { url: config.cloudURL, status: "unknown" as const };
  const healthy = beeper.reachable && beeper.tokenValid === true && !!paired && running && cloud.status === "connected";
  return { version: CONNECTOR_VERSION, beeper, beeperToken: !!beeperToken, paired, service: { installed, running, ...(running ? { pid: state!.pid } : {}) }, cloud, healthy };
}

const pad = (s: string) => `  ${s.padEnd(14)}`;

export async function statusCommand(ctx: Ctx): Promise<number> {
  const r = await gatherStatus(ctx);
  if (ctx.json) {
    ctx.deps.out(JSON.stringify(r, null, 2));
    return r.healthy ? 0 : 1;
  }
  const out = ctx.deps.out;
  out(`J-Inbox connector ${r.version}`);
  const b = r.beeper;
  if (!b.reachable) out(`${pad("Beeper")}not reachable at ${b.url}  (start Beeper, or run \`j-inbox doctor\`)`);
  else if (b.tokenValid === false) out(`${pad("Beeper")}token rejected by ${b.name ?? "Beeper"}  (run \`j-inbox setup\` to enter a new token)`);
  else if (b.tokenValid) out(`${pad("Beeper")}ok (${b.name ?? "Beeper"} ${b.version ?? ""} at ${b.url}, ${b.accounts ?? 0} accounts)`);
  else out(`${pad("Beeper")}running at ${b.url}`);
  out(`${pad("Beeper token")}${r.beeperToken ? "stored in Keychain" : "missing  (run `j-inbox setup`)"}`);
  out(`${pad("Paired")}${r.paired ? `yes (${r.paired.deviceName ?? "this Mac"}, ${r.paired.deviceID})` : "no  (run `j-inbox pair`)"}`);
  out(`${pad("Service")}${r.service.running ? `running (pid ${r.service.pid})` : r.service.installed ? "installed, not running  (run `j-inbox doctor`)" : "not installed  (run `j-inbox setup`)"}`);
  const c = r.cloud;
  if (c.status === "connected" && "since" in c) out(`${pad("Cloud")}connected to ${c.url} since ${c.since}`);
  else if (c.status === "stopped" && "reason" in c) out(`${pad("Cloud")}stopped: ${c.reason}${c.reason === "revoked" ? "  (this computer was removed; run `j-inbox pair`)" : ""}`);
  else if (c.status === "unknown") out(`${pad("Cloud")}not connected (${c.url})`);
  else out(`${pad("Cloud")}${c.status} (${c.url})`);
  return r.healthy ? 0 : 1;
}
