// The sign-in window opened from a launchd agent, as the connector runs (gui/<uid>, not a terminal):
// loads a throwaway LaunchAgent with its own label (never the connector's), which runs signin-gui.ts,
// waits for its answer, and unloads it. macOS with a logged-in screen only.
//   bun connector/test/signin-launchd-check.ts <path to J-Inbox Sign-in.app> <scratch dir>
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [app, scratch] = process.argv.slice(2);
if (!app || !scratch) throw new Error("usage: signin-launchd-check.ts <J-Inbox Sign-in.app> <scratch dir>");
mkdirSync(scratch, { recursive: true });
const label = `build.jsuite.j-inbox-signin-check.${process.pid}`;
if (label === "build.jsuite.j-inbox") throw new Error("never the connector's label");
const out = join(scratch, "signin-launchd.out");
const errFile = join(scratch, "signin-launchd.err");
rmSync(out, { force: true });
const plist = join(scratch, `${label}.plist`);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const args = [process.execPath, resolve(import.meta.dir, "signin-gui.ts"), resolve(app)];
writeFileSync(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(resolve(import.meta.dir, "..", ".."))}</string>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>${xml(out)}</string>
  <key>StandardErrorPath</key><string>${xml(errFile)}</string>
</dict></plist>
`,
);
const uid = process.getuid!();
const run = (argv: string[]) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
const boot = run(["launchctl", "bootstrap", `gui/${uid}`, plist]);
if (boot.exitCode !== 0) throw new Error(`bootstrap failed: ${boot.stderr.toString()}`);
let answer = "";
for (let i = 0; i < 120 && !answer; i++) {
  await Bun.sleep(500);
  if (existsSync(out)) answer = readFileSync(out, "utf8").trim().split("\n").find((l) => l.startsWith("{")) ?? "";
}
run(["launchctl", "bootout", `gui/${uid}/${label}`]);
rmSync(plist, { force: true });
console.log(answer || "no answer");
process.exit(/"ok":true/.test(answer) && /"shown":true/.test(answer) ? 0 : 1);
