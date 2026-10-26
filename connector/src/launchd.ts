// The connector as a per-user launchd agent: starts at login, restarts after a crash (not after a
// clean exit: revoked, replaced or unpaired connectors exit 0 and stay down), throttled.
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeAtomic } from "./config.ts";
import type { Runner } from "./runner.ts";

export const LAUNCHD_LABEL = "build.jsuite.j-inbox";
const LAUNCHCTL = "/bin/launchctl";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SECRET_KEY = /token|password|passwd/i;
const SECRET_VALUE = /jid_[A-Za-z0-9_-]{20,}|bearer\s/i;

export type PlistOptions = { program: string[]; logDir: string; env?: Record<string, string>; throttleSeconds?: number };

export function generatePlist(o: PlistOptions): string {
  if (!o.program.length || !isAbsolute(o.program[0]!)) throw new Error("The program path must be absolute.");
  for (const s of [...o.program, o.logDir, ...Object.entries(o.env ?? {}).flat()]) if (CONTROL.test(s)) throw new Error("Control characters are not allowed in the launchd agent.");
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(k)) throw new Error("Invalid environment variable name.");
    if (SECRET_KEY.test(k) || SECRET_VALUE.test(v)) throw new Error("Secrets never go into the launchd agent; they live in the Keychain.");
  }
  const args = o.program.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = Object.entries(o.env ?? {})
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  const log = xml(join(o.logDir, "service.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${Math.max(1, Math.floor(o.throttleSeconds ?? 10))}</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
</dict>
</plist>
`;
}

export const plistPath = (launchAgentsDir: string) => join(launchAgentsDir, `${LAUNCHD_LABEL}.plist`);

export async function installAgent(o: { launchAgentsDir: string; plist: string; uid: number; run: Runner }): Promise<{ path: string }> {
  const path = plistPath(o.launchAgentsDir);
  mkdirSync(o.launchAgentsDir, { recursive: true });
  writeAtomic(path, o.plist, 0o644);
  // Replace a running copy (bootout fails harmlessly when none is loaded).
  await o.run([LAUNCHCTL, "bootout", `gui/${o.uid}/${LAUNCHD_LABEL}`], { timeoutMs: 30_000 });
  const r = await o.run([LAUNCHCTL, "bootstrap", `gui/${o.uid}`, path], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`launchctl bootstrap failed (exit ${r.code}). Run \`j-inbox doctor\`.`);
  // RunAtLoad alone is not enough: right after a bootout, launchd can load the job and never start it
  // (seen on the first real install: "runs = 0"). Start it explicitly; no -k, so a running copy stays.
  await o.run([LAUNCHCTL, "kickstart", `gui/${o.uid}/${LAUNCHD_LABEL}`], { timeoutMs: 30_000 });
  return { path };
}

export async function uninstallAgent(o: { launchAgentsDir: string; uid: number; run: Runner }): Promise<void> {
  await o.run([LAUNCHCTL, "bootout", `gui/${o.uid}/${LAUNCHD_LABEL}`], { timeoutMs: 30_000 });
  try {
    unlinkSync(plistPath(o.launchAgentsDir));
  } catch {}
}

/** Restart the running agent (after pairing or unpairing). */
export async function restartAgent(o: { uid: number; run: Runner }): Promise<boolean> {
  const r = await o.run([LAUNCHCTL, "kickstart", "-k", `gui/${o.uid}/${LAUNCHD_LABEL}`], { timeoutMs: 30_000 });
  return r.code === 0;
}

export async function isAgentInstalled(launchAgentsDir: string): Promise<boolean> {
  return existsSync(plistPath(launchAgentsDir));
}
