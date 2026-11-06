// The real sign-in window (signin-helper/), built and run against fake Beeper's sign-in page, from a
// terminal and from a launchd agent in the GUI session as the connector runs. Opens a window on the
// screen for a few seconds, so only with J_INBOX_GUI_TESTS=1 on a Mac with a logged-in screen.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const on = process.env.J_INBOX_GUI_TESTS === "1" && process.platform === "darwin";
describe.skipIf(!on)("the sign-in window on this Mac", () => {
  test("built, it opens on screen and hands back the site's cookies; also from a launchd agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jinbox-signin-gui-"));
    try {
      const build = Bun.spawnSync(["sh", join(import.meta.dir, "..", "signin-helper", "build.sh"), dir], { stdout: "pipe", stderr: "pipe" });
      expect(build.exitCode).toBe(0);
      const app = join(dir, "J-Inbox Sign-in.app");
      const direct = Bun.spawnSync([process.execPath, join(import.meta.dir, "signin-gui.ts"), app], { stdout: "pipe", stderr: "ignore" });
      expect(direct.stdout.toString()).toContain('"ok":true');
      expect(direct.stdout.toString()).toContain('"shown":true');
      // Paste, copy, cut, select all, undo and redo in the web view: the window has an Edit menu.
      const said = JSON.parse(direct.stdout.toString().trim().split("\n").at(-1)!) as { editKeys: string[] };
      // (macOS adds its own items, Emoji & Symbols and the like, to an Edit menu.)
      expect(said.editKeys).toEqual(expect.arrayContaining(["z", "shift+z", "x", "c", "v", "a"]));
      const agent = Bun.spawnSync([process.execPath, join(import.meta.dir, "signin-launchd-check.ts"), app, dir], { stdout: "pipe", stderr: "ignore" });
      expect(agent.stdout.toString()).toContain('"ok":true');
      expect(agent.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
