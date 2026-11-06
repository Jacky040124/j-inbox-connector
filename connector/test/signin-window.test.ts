// The sign-in window's link to its helper (signin-window.ts): the request on stdin, one answer line
// on stdout with only the values asked for, closing on cancel. A stand-in script plays the helper;
// signin-gui.test.ts runs the real window (macOS, opt-in).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSigninWindows, parseHelperLine, signinExecutable } from "../src/signin-window.ts";
import { resolvePaths, signinHelperExecutable } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "jinbox-signin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function helper(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const REQ = { title: "J-Inbox: sign in to Instagram", url: "https://www.instagram.com/accounts/login/", fields: [{ id: "sessionid", name: "sessionid", type: "cookie" as const }] };

describe("parseHelperLine", () => {
  test("keeps only the fields asked for, as strings; progress lines are skipped; anything else is a failure", () => {
    expect(parseHelperLine('{"fields":{"sessionid":"v","other":"x","n":5},"lastURL":"https://a.test/"}', ["sessionid", "n"])).toEqual({ fields: { sessionid: "v" }, lastURL: "https://a.test/" });
    expect(parseHelperLine('{"event":"shown","onScreen":true}', ["a"])).toBe("event");
    expect(parseHelperLine('{"closed":true}', ["a"])).toEqual({ closed: true });
    expect(parseHelperLine('{"error":"bad url"}', ["a"])).toEqual({ failed: true });
    expect(parseHelperLine('{"fields":{}}', ["a"])).toEqual({ failed: true });
    expect(parseHelperLine("not json", ["a"])).toBeNull();
  });
});

describe("createSigninWindows", () => {
  test("the request goes on stdin; the answer comes back; the helper is told to go", async () => {
    const got = join(dir, "got.json");
    const exe = helper("ok.sh", `read line; printf '%s' "$line" > "${got}"; echo '{"event":"shown","onScreen":true}'; echo '{"fields":{"sessionid":"cookie-marker"},"lastURL":"https://www.instagram.com/"}'; sleep 5`);
    const w = createSigninWindows({ executable: exe });
    expect(w.available()).toBe(true);
    const win = w.open(REQ)!;
    expect(await win.result).toEqual({ fields: { sessionid: "cookie-marker" }, lastURL: "https://www.instagram.com/" });
    expect(JSON.parse(await Bun.file(got).text())).toEqual(REQ);
  });
  test("a closed window, a helper that dies, too much output: closed or failed", async () => {
    expect(await createSigninWindows({ executable: helper("closed.sh", `read line; echo '{"closed":true}'`) }).open(REQ)!.result).toEqual({ closed: true });
    expect(await createSigninWindows({ executable: helper("dies.sh", "exit 3") }).open(REQ)!.result).toEqual({ failed: true });
    expect(await createSigninWindows({ executable: helper("big.sh", `read line; head -c 400000 /dev/zero | tr '\\0' 'a'`) }).open(REQ)!.result).toEqual({ failed: true });
  });
  test("close() ends a helper that is still waiting", async () => {
    const w = createSigninWindows({ executable: helper("wait.sh", "read line; sleep 30") }).open(REQ)!;
    const t0 = Date.now();
    w.close();
    expect(await w.result).toEqual({ failed: true });
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  test("not installed: not available", () => {
    expect(createSigninWindows({ executable: join(dir, "nope") }).available()).toBe(false);
  });
});

describe("where the helper is", () => {
  test("the app in ~/Applications; a stand-in only in test mode", () => {
    const real = resolvePaths({ HOME: "/Users/someone" });
    expect(signinHelperExecutable({}, real, signinExecutable)).toBe("/Users/someone/Applications/J-Inbox Sign-in.app/Contents/MacOS/J-Inbox Sign-in");
    expect(() => signinHelperExecutable({ J_INBOX_SIGNIN_HELPER: "/tmp/x" }, real, signinExecutable)).toThrow();
    const t = resolvePaths({ HOME: "/Users/someone", J_INBOX_CONFIG_DIR: "/tmp/jt" });
    expect(signinHelperExecutable({ J_INBOX_SIGNIN_HELPER: "/tmp/x" }, t, signinExecutable)).toBe("/tmp/x");
  });
});
