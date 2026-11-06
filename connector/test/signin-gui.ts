// Runs the real sign-in window (J-Inbox Sign-in.app, built by signin-helper/build.sh) against fake
// Beeper's sign-in page, through the connector's own code (signin-window.ts). macOS with a logged-in
// screen only. Prints one JSON line: what the window collected, and whether it showed on screen.
//   bun connector/test/signin-gui.ts <path to J-Inbox Sign-in.app>
import { startFakeBeeper } from "@j-inbox/fake-beeper";
import { createSigninWindows, signinExecutable } from "../src/signin-window.ts";

const app = process.argv[2];
if (!app) throw new Error("usage: signin-gui.ts <J-Inbox Sign-in.app>");
const fb = await startFakeBeeper();
const base = fb.url;
let shown = false;
/** The window's Edit menu (Cmd+V and the rest reach the web view only through it). */
let editKeys: string[] = [];
const windows = createSigninWindows({
  executable: signinExecutable(app),
  spawn: (argv) => {
    const p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    // Watch for the window's "shown" event on a copy of its stdout.
    const [a, b] = p.stdout.tee();
    void (async () => {
      const r = b.getReader();
      const d = new TextDecoder();
      let s = "";
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        s += d.decode(value);
        for (const line of s.split("\n")) {
          if (!line.includes('"event":"shown"')) continue;
          try {
            const e = JSON.parse(line) as { onScreen?: boolean; editKeys?: string[] };
            if (e.onScreen === true) shown = true;
            if (Array.isArray(e.editKeys)) editKeys = e.editKeys;
          } catch {}
        }
      }
    })();
    return { stdin: p.stdin, stdout: a, exited: p.exited, kill: (sig) => p.kill(sig as never) };
  },
});
const w = windows.open({
  title: "J-Inbox: sign in to Instagram",
  url: `${base}/fake-login/instagram?slow=1`,
  fields: [
    { id: "sessionid", name: "sessionid", type: "cookie" },
    { id: "csrftoken", name: "csrftoken", type: "cookie" },
  ],
  expectedFinalURLRegex: `^${base.replace(/[.]/g, "\\.")}/fake-login/instagram/home`,
  userAgent: "Mozilla/5.0 (Macintosh) J-Inbox-Test",
  extractJS: "(async () => ({}))()",
});
if (!w) throw new Error("no window");
const t = setTimeout(() => w.close(), 30_000);
const r = await w.result;
clearTimeout(t);
await Bun.sleep(300);
const ok = "fields" in r && r.fields.sessionid === "fake-cookie-value" && r.fields.csrftoken === "fake-cookie-value";
console.log(JSON.stringify({ ok, shown, editKeys, kind: "fields" in r ? "fields" : Object.keys(r)[0], lastURL: "fields" in r ? r.lastURL : null }));
fb.stop();
process.exit(ok ? 0 : 1);
