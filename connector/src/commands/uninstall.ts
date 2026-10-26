// `j-inbox uninstall`: background service, the tokens (Gmail accounts' access is revoked at Google
// first) and J-Inbox's own files. Beeper itself is left alone (it may be used for other things).
import { rmSync } from "node:fs";
import { googleEndpoints, loadConfig } from "../config.ts";
import { GmailAccounts } from "../gmail/accounts.ts";
import { revokeAtGoogle } from "../gmail/client.ts";
import { uninstallAgent } from "../launchd.ts";
import { revokeInCloud } from "./pair.ts";
import { SECRET_NAMES } from "../secrets.ts";
import type { Ctx } from "./context.ts";

export async function uninstallCommand(ctx: Ctx): Promise<number> {
  const { deps, flags, paths } = ctx;
  if (!flags.yes) {
    if (!deps.isTTY) {
      deps.err("Add --yes to uninstall without a prompt.");
      return 1;
    }
    if (!(await deps.prompt.confirm("Remove the J-Inbox connector, its background service and its tokens?", false))) {
      deps.out("Nothing removed.");
      return 1;
    }
  }
  let revoked: boolean | null = null;
  try {
    revoked = await revokeInCloud(ctx, loadConfig(paths).cloudURL);
  } catch {
    revoked = false;
  }
  await uninstallAgent({ launchAgentsDir: paths.launchAgentsDir, uid: deps.uid, run: deps.run });
  deps.out("Removed the background service.");
  // Gmail accounts: revoke J-Inbox's access at Google (needs no secret), then forget the tokens.
  const gmail = new GmailAccounts({ path: paths.gmailFile, secrets: ctx.secrets });
  let oauthURL: string | undefined;
  try {
    oauthURL = googleEndpoints(deps.env, paths).oauthURL;
  } catch {}
  for (const a of gmail.list()) {
    try {
      const token = await gmail.refreshToken(a.email);
      if (token && !(await revokeAtGoogle({ token, oauthURL, fetchImpl: deps.fetchImpl }))) deps.err("Could not reach Google to revoke a Gmail account's access; remove J-Inbox at myaccount.google.com/permissions.");
      await gmail.remove(a.email);
    } catch (e) {
      deps.err(`Could not remove a Gmail account's token from the Keychain: ${(e as Error).message}`);
    }
  }
  for (const name of SECRET_NAMES) {
    try {
      await ctx.secrets.delete(name);
    } catch (e) {
      deps.err(`Could not delete the ${name} from the Keychain: ${(e as Error).message}`);
    }
  }
  deps.out("Removed the tokens from the Keychain.");
  const rm = (p: string) => rmSync(p, { recursive: true, force: true });
  rm(paths.dataDir);
  rm(paths.logDir);
  rm(paths.stateFile);
  if (!flags["keep-config"]) {
    rm(paths.configFile);
    if (!paths.testMode) rm(paths.configDir);
    deps.out("Removed J-Inbox's files.");
  } else deps.out(`Kept ${paths.configFile}.`);
  deps.out("Beeper was not touched. If setup installed Beeper Server for J-Inbox and you no longer need it: beeper targets remove j-inbox");
  if (revoked !== true) deps.out("Also remove this computer in the J-Inbox web page (Settings > Devices).");
  return 0;
}
