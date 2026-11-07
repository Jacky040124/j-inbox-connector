// install.sh end to end against a local release (Bun.serve on 127.0.0.1) and a fake HOME in a temp
// dir. The "binary" is a tiny shell script; nothing reaches the network or the real home directory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "install.sh");
const ASSET = "j-inbox-darwin-arm64";
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const fakeBinary = (version: string, starts = true) =>
  [
    "#!/bin/sh",
    `if [ "$1" = --version ]; then ${starts ? `echo ${version}; exit 0` : "exit 1"}; fi`,
    'if [ "$1" = setup ]; then shift; printf "%s\\n" "$@" > "$HOME/setup-args"; exit 0; fi',
    "exit 2",
    "",
  ].join("\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** What the server hands out: the binary and its .sha256 (overridable to break it), and the sign-in window's archive (null: a release without it). */
let release: { binary: string; sum?: string; signin?: Uint8Array | null; signinSum?: string } = { binary: fakeBinary("9.9.1") };
const SIGNIN = "j-inbox-signin-darwin-arm64.tar.gz";
const shaBytes = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** A stand-in for J-Inbox Sign-in.app, packed as the release script packs the real one. */
function signinArchive(marker: string): Uint8Array {
  const d = mkdtempSync(join(scratch, "signin-"));
  const exe = join(d, "J-Inbox Sign-in.app", "Contents", "MacOS");
  Bun.spawnSync(["mkdir", "-p", exe]);
  writeFileSync(join(exe, "J-Inbox Sign-in"), `#!/bin/sh\necho ${marker}\n`);
  chmodSync(join(exe, "J-Inbox Sign-in"), 0o755);
  Bun.spawnSync(["tar", "-czf", join(d, SIGNIN), "-C", d, "J-Inbox Sign-in.app"], { env: { COPYFILE_DISABLE: "1", PATH: SYSTEM_PATH } });
  return new Uint8Array(readFileSync(join(d, SIGNIN)));
}
let server: ReturnType<typeof Bun.serve>;
let base = "";
const scratch = mkdtempSync(join(tmpdir(), "jinbox-install-sh-"));

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === `/${ASSET}`) return new Response(release.binary);
      if (p === `/${ASSET}.sha256`) return new Response(release.sum ?? `${sha(release.binary)}  ${ASSET}\n`);
      if (p === `/${SIGNIN}` && release.signin) return new Response(release.signin as Uint8Array<ArrayBuffer>);
      if (p === `/${SIGNIN}.sha256` && release.signin) return new Response(release.signinSum ?? `${shaBytes(release.signin)}  ${SIGNIN}\n`);
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server?.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

const fakeHome = () => mkdtempSync(join(scratch, "home-"));

/** A dir of shims (uname, sysctl) put first on PATH. */
function shims(files: Record<string, string>): string {
  const d = mkdtempSync(join(scratch, "shim-"));
  for (const [n, body] of Object.entries(files)) {
    writeFileSync(join(d, n), `#!/bin/sh\n${body}\n`);
    chmodSync(join(d, n), 0o755);
  }
  return d;
}

// The script is for an Apple-silicon Mac: unless a test says otherwise (its own uname shim, first on
// PATH), it runs as if on one, so the tests mean the same on a Mac and on a Linux CI machine.
let mac: string | undefined;
const appleSilicon = () => (mac ??= shims({ uname: 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac', sysctl: "echo 0" }));

// Async spawn: the release server runs in this process, so a blocking spawn would starve it.
async function install(home: string, o: { env?: Record<string, string>; pathPrefix?: string; args?: string[] } = {}) {
  const env: Record<string, string> = { PATH: (o.pathPrefix ? o.pathPrefix + ":" : "") + appleSilicon() + ":" + SYSTEM_PATH, HOME: home, TMPDIR: scratch, SHELL: "/bin/zsh", J_INBOX_DOWNLOAD_URL: base, J_INBOX_NO_SETUP: "1", ...o.env };
  const p = Bun.spawn(["/bin/sh", SCRIPT, ...(o.args ?? [])], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err, text: out + err };
}

const binOf = (home: string) => join(home, ".local", "bin", "j-inbox");
const leftovers = (home: string) => (existsSync(join(home, ".local", "bin")) ? readdirSync(join(home, ".local", "bin")).filter((n) => n !== "j-inbox") : []);

describe("install.sh", () => {
  test("installs into ~/.local/bin (0755), says the version and the PATH line; a second run upgrades by rename", async () => {
    release = { binary: fakeBinary("9.9.1") };
    const home = fakeHome();
    const r = await install(home);
    expect(r.code).toBe(0);
    expect(readFileSync(binOf(home), "utf8")).toBe(release.binary);
    expect(statSync(binOf(home)).mode & 0o777).toBe(0o755);
    expect(r.out).toContain("Installed j-inbox 9.9.1");
    expect(r.out).toContain(`export PATH="$HOME/.local/bin:$PATH"`);
    expect(r.out).toContain("~/.zprofile");
    expect(r.out).toContain(`${binOf(home)} setup`);
    const firstInode = statSync(binOf(home)).ino;

    release = { binary: fakeBinary("9.9.2") };
    const r2 = await install(home, { pathPrefix: join(home, ".local", "bin") });
    expect(r2.code).toBe(0);
    expect(r2.out).toContain("Upgraded j-inbox 9.9.1 -> 9.9.2");
    expect(r2.out).not.toContain("not on your PATH");
    expect(r2.out).toContain("Next: j-inbox setup");
    expect(readFileSync(binOf(home), "utf8")).toBe(release.binary);
    expect(statSync(binOf(home)).ino).not.toBe(firstInode); // a new file, renamed into place
    expect(leftovers(home)).toEqual([]);
    expect(readdirSync(scratch).filter((n) => n.startsWith("j-inbox-install."))).toEqual([]);
  });

  test("installs the sign-in window into ~/Applications, replacing an older one; a release without it installs the binary and says so", async () => {
    const home = fakeHome();
    release = { binary: fakeBinary("9.9.1"), signin: signinArchive("first") };
    const r = await install(home);
    expect(r.code).toBe(0);
    const exe = join(home, "Applications", "J-Inbox Sign-in.app", "Contents", "MacOS", "J-Inbox Sign-in");
    expect(readFileSync(exe, "utf8")).toContain("first");
    expect(statSync(exe).mode & 0o111).not.toBe(0);
    expect(r.out).toContain("Installed the sign-in window");
    release = { binary: fakeBinary("9.9.2"), signin: signinArchive("second") };
    expect((await install(home)).code).toBe(0);
    expect(readFileSync(exe, "utf8")).toContain("second");
    expect(readdirSync(join(home, "Applications"))).toEqual(["J-Inbox Sign-in.app"]);
    release = { binary: fakeBinary("9.9.3"), signin: null };
    const old = await install(home);
    expect(old.code).toBe(0);
    expect(old.out).toContain("This release has no sign-in window");
    expect(readFileSync(binOf(home), "utf8")).toContain("9.9.3");
  });
  test("a sign-in window whose checksum does not match installs nothing at all", async () => {
    const home = fakeHome();
    release = { binary: fakeBinary("9.9.1"), signin: signinArchive("bad"), signinSum: `${"0".repeat(64)}  ${SIGNIN}\n` };
    const r = await install(home);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("Checksum mismatch for j-inbox-signin-darwin-arm64.tar.gz");
    expect(existsSync(binOf(home))).toBe(false);
    expect(existsSync(join(home, "Applications"))).toBe(false);
    release = { binary: fakeBinary("9.9.1") };
  });
  test("a checksum mismatch installs nothing (and keeps an existing install)", async () => {
    release = { binary: fakeBinary("9.9.1"), sum: `${"0".repeat(64)}  ${ASSET}\n` };
    const home = fakeHome();
    const r = await install(home);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Checksum mismatch.*Nothing was installed/);
    expect(existsSync(binOf(home))).toBe(false);

    release = { binary: fakeBinary("9.9.1") };
    expect((await install(home)).code).toBe(0);
    release = { binary: fakeBinary("9.9.3"), sum: `${sha(fakeBinary("9.9.1"))}  ${ASSET}\n` };
    expect((await install(home)).code).toBe(1);
    expect(readFileSync(binOf(home), "utf8")).toBe(fakeBinary("9.9.1"));
    expect(leftovers(home)).toEqual([]);
  });

  test("a malformed checksum file or a binary that does not start changes nothing", async () => {
    const home = fakeHome();
    release = { binary: fakeBinary("9.9.1"), sum: "not a checksum\n" };
    expect((await install(home)).code).toBe(1);
    expect(existsSync(binOf(home))).toBe(false);
    release = { binary: fakeBinary("9.9.1", false) };
    const r = await install(home);
    expect(r.code).toBe(1);
    expect(r.err).toContain("does not start");
    expect(existsSync(binOf(home))).toBe(false);
    expect(leftovers(home)).toEqual([]);
  });

  test("refuses anything but a Mac with Apple silicon; accepts a Rosetta shell on Apple silicon", async () => {
    release = { binary: fakeBinary("9.9.1") };
    for (const os of ["Linux", "Darwin"]) {
      const home = fakeHome();
      const r = await install(home, { pathPrefix: shims({ uname: `case "$1" in -s) echo ${os};; -m) echo x86_64;; esac`, sysctl: "echo 0" }) });
      expect(r.code).toBe(1);
      expect(r.err).toContain("needs a Mac with Apple silicon");
      expect(existsSync(join(home, ".local"))).toBe(false);
    }
    const home = fakeHome();
    const r = await install(home, { pathPrefix: shims({ uname: 'case "$1" in -s) echo Darwin;; -m) echo x86_64;; esac', sysctl: "echo 1" }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Rosetta");
    expect(existsSync(binOf(home))).toBe(true);
  });

  test("refuses a plain-http download URL that is not loopback", async () => {
    const home = fakeHome();
    const r = await install(home, { env: { J_INBOX_DOWNLOAD_URL: "http://example.com/x" } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("J_INBOX_DOWNLOAD_URL");
  });

  test("without J_INBOX_NO_SETUP: runs setup with the extra args on a terminal, or says what to run when there is none", async () => {
    release = { binary: fakeBinary("9.9.1") };
    const home = fakeHome();
    const r = await install(home, { env: { J_INBOX_NO_SETUP: "" }, args: ["--name", "Test Mac"] });
    expect(r.code).toBe(0);
    // Whether this process has a controlling terminal depends on how the tests were started.
    if (existsSync(join(home, "setup-args"))) expect(readFileSync(join(home, "setup-args"), "utf8")).toBe("--name\nTest Mac\n");
    else expect(r.out).toContain("No terminal here");
  });

  test("a cut-off download runs nothing: the script is one main() called on its last line", () => {
    const lines = readFileSync(SCRIPT, "utf8").trimEnd().split("\n");
    expect(lines.at(-1)).toBe('main "$@"');
    expect(lines.filter((l) => /^main\b(?!\(\))/.test(l))).toEqual(['main "$@"']);
  });
});
