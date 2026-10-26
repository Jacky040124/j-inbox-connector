// `j-inbox pair` / `j-inbox unpair`.
import { loadConfig, saveConfig, validateCloudURL } from "../config.ts";
import { isAgentInstalled, restartAgent } from "../launchd.ts";
import { pairDevice, revokeDevice } from "../pairing-client.ts";
import { CONNECTOR_VERSION } from "../version.ts";
import { UsageError, defaultDeviceName, type Ctx } from "./context.ts";

export async function pairCommand(ctx: Ctx, o: { quietIfPaired?: boolean } = {}): Promise<number> {
  const { deps, flags } = ctx;
  const config = loadConfig(ctx.paths);
  if (typeof flags["cloud-url"] === "string") config.cloudURL = validateCloudURL(flags["cloud-url"]);
  const existing = await ctx.secrets.get("device-token");
  if (existing && config.deviceID && !flags.force) {
    if (o.quietIfPaired) {
      deps.out(`Already paired as ${config.deviceName ?? config.deviceID}.`);
      return 0;
    }
    deps.err(`This computer is already paired (${config.deviceName ?? config.deviceID}). Use \`j-inbox pair --force\` to pair it again.`);
    return 1;
  }
  const name = typeof flags.name === "string" ? flags.name : (config.deviceName ?? defaultDeviceName(deps.hostname()));
  if (!name.trim() || name.length > 64) throw new UsageError("--name must be 1-64 characters.");

  const ctl = new AbortController();
  const off = deps.onSignal(() => ctl.abort());
  try {
    const r = await pairDevice({
      cloudURL: config.cloudURL,
      deviceName: name,
      connectorVersion: CONNECTOR_VERSION,
      platform: { os: process.platform, arch: process.arch },
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      signal: ctl.signal,
      onCode: (c) => {
        deps.out("");
        deps.out("To pair this computer, open this page and sign in with Raft:");
        deps.out(`    ${c.verificationURL}`);
        deps.out("Then type this code:");
        deps.out(`    ${c.userCode}`);
        deps.out(`The code expires in ${Math.round(c.expiresIn / 60)} minutes. Waiting for approval (Ctrl-C to cancel)...`);
      },
    });
    if (!r.ok) {
      deps.err(r.message);
      return 1;
    }
    await ctx.secrets.set("device-token", r.deviceToken);
    saveConfig(ctx.paths, { ...config, deviceID: r.deviceID, deviceName: name.trim().slice(0, 64) });
    ctx.audit.lifecycle("paired");
    deps.out(`Paired with ${r.owner.serverSlug}${r.owner.name ? ` (${r.owner.name})` : ""} as "${name.trim()}".`);
    if (await isAgentInstalled(ctx.paths.launchAgentsDir)) {
      if (await restartAgent({ uid: deps.uid, run: deps.run })) deps.out("Restarted the background service.");
      else deps.out("Could not restart the background service; run `j-inbox doctor`.");
    }
    return 0;
  } finally {
    off();
  }
}

/** Revoke this computer in the cloud with its own token, if it has one. True when the cloud confirmed. */
export async function revokeInCloud(ctx: Ctx, cloudURL: string): Promise<boolean | null> {
  const token = await ctx.secrets.get("device-token");
  if (!token) return null;
  const r = await revokeDevice({ cloudURL, deviceToken: token, fetchImpl: ctx.deps.fetchImpl });
  if (r.ok) ctx.deps.out("This computer was revoked in the cloud.");
  else ctx.deps.err(`Could not revoke this computer in the cloud: ${r.message}`);
  return r.ok;
}

export async function unpairCommand(ctx: Ctx): Promise<number> {
  const config = loadConfig(ctx.paths);
  const revoked = await revokeInCloud(ctx, config.cloudURL);
  await ctx.secrets.delete("device-token");
  const { deviceID: _id, ...rest } = config;
  saveConfig(ctx.paths, rest);
  ctx.audit.lifecycle("unpaired");
  if (await isAgentInstalled(ctx.paths.launchAgentsDir)) await restartAgent({ uid: ctx.deps.uid, run: ctx.deps.run });
  ctx.deps.out("This computer is no longer paired; the connector stops relaying.");
  if (revoked === false) ctx.deps.out("Also remove it in the J-Inbox web page (Settings > Devices) so its old credential is revoked in the cloud.");
  return 0;
}
