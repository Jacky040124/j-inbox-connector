// `j-inbox run`: the background service in the foreground (launchd runs this). Exits 0 only when it
// should stay down (not paired, revoked, replaced); a stop by a signal exits 128 + signal, so
// launchd's KeepAlive (SuccessfulExit=false) restarts it after `kill` or Activity Monitor's Quit.
// Only one run per config dir: a second one exits 3 (non-zero, so a launchd copy that lost the
// race is restarted later by KeepAlive and takes over once the other one is gone).
import { acquireInstanceLock } from "../instance-lock.ts";
import { LAUNCHD_LABEL } from "../launchd.ts";
import { exitCodeFor, startService } from "../service.ts";
import { CONNECTOR_VERSION } from "../version.ts";
import type { Ctx } from "./context.ts";

export const EXIT_ALREADY_RUNNING = 3;

export async function runCommand(ctx: Ctx): Promise<number> {
  const { deps } = ctx;
  const lock = acquireInstanceLock(ctx.paths.configDir);
  if (!lock.ok) {
    deps.err(
      `${new Date().toISOString()} j-inbox: already running${lock.pid ? ` (pid ${lock.pid})` : ""} for this computer. ` +
        `Use \`j-inbox status\`, or stop the other one first (the background service: \`launchctl bootout gui/${deps.uid}/${LAUNCHD_LABEL}\`). Lock: ${lock.path}`,
    );
    return EXIT_ALREADY_RUNNING;
  }
  try {
    const svc = await startService({
      paths: ctx.paths,
      secrets: ctx.secrets,
      version: CONNECTOR_VERSION,
      log: (line) => deps.err(`${new Date().toISOString()} ${line}`),
    });
    let signal: string | null = null;
    const off = deps.onSignal((sig) => {
      signal ??= typeof sig === "string" ? sig : "SIGTERM";
      deps.err(`${new Date().toISOString()} j-inbox: stopping (${signal})`);
      void svc.stop(5000);
    });
    try {
      const exit = await svc.done;
      return signal ? exitCodeFor(exit.reason, signal) : exit.exitCode;
    } finally {
      off();
    }
  } finally {
    lock.release();
  }
}
