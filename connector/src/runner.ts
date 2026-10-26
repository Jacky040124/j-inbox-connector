// Running other programs (security, launchctl, beeper, pmset) behind one interface, so tests
// can substitute fakes and never touch the real Keychain, launchd or Beeper.
export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = {
  stdin?: string;
  timeoutMs?: number;
  /** Let the child use this terminal (interactive wizards such as `beeper setup`). */
  inherit?: boolean;
  env?: Record<string, string>;
};
export type Runner = (cmd: string[], o?: RunOptions) => Promise<RunResult>;

const MAX_OUTPUT = 1024 * 1024;

export const realRunner: Runner = async (cmd, o = {}) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      stdin: o.inherit ? "inherit" : o.stdin !== undefined ? new TextEncoder().encode(o.stdin) : "ignore",
      stdout: o.inherit ? "inherit" : "pipe",
      stderr: o.inherit ? "inherit" : "pipe",
      env: o.env ? { ...process.env, ...o.env } : process.env,
    });
  } catch {
    return { code: 127, stdout: "", stderr: `${cmd[0]}: not found` };
  }
  const timer = o.timeoutMs ? setTimeout(() => proc.kill(), o.timeoutMs) : undefined;
  const read = async (s: unknown) => (s instanceof ReadableStream ? (await new Response(s).text()).slice(0, MAX_OUTPUT) : "");
  const [stdout, stderr, code] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
};
