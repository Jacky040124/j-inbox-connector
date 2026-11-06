// The Mac's sign-in window for a website sign-in (Beeper's cookies step: Instagram, and others whose
// only sign-in is their own website). A small app (signin-helper/, "J-Inbox Sign-in.app", installed
// next to the connector by install.sh) shows the site in a window titled "J-Inbox: sign in to ...",
// and when the site reaches the address Beeper expects, collects exactly the values Beeper asked for
// and writes them as one JSON line on its stdout. They come straight here and go straight to Beeper:
// never to a file, a log or the page. The window's web view keeps nothing on disk (a non-persistent
// data store), and it closes when the sign-in is cancelled or the connector stops (its stdin closes).
//
// The connector runs as a launchd agent in the owner's GUI session (gui/<uid>), so a child it starts
// can open a window on the owner's screen; the helper makes itself a regular app and comes to the front.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SigninRequest, SigninResult, SigninWindow, SigninWindows } from "./chat-login.ts";

export const SIGNIN_APP_NAME = "J-Inbox Sign-in.app";
export const SIGNIN_EXECUTABLE = "J-Inbox Sign-in";

/** The helper's executable inside its app. */
export const signinExecutable = (app: string) => join(app, "Contents", "MacOS", SIGNIN_EXECUTABLE);

/** At most this much from the helper (the values Beeper asked for are a few cookies). */
const MAX_OUTPUT = 256 * 1024;
/** A sign-in window open this long is closed (the session is cancelled long before, in practice). */
const WINDOW_MAX_MS = 15 * 60_000;

type Spawned = { stdin: { write(s: string): unknown; flush?(): unknown; end?(): unknown }; stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(signal?: number | NodeJS.Signals): void };
export type SpawnHelper = (argv: string[]) => Spawned;

const defaultSpawn: SpawnHelper = (argv) =>
  Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    // Nothing the helper says on stderr is wanted (and nothing secret is ever written there).
    stderr: "ignore",
    env: { HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...(process.env.J_INBOX_SIGNIN_TEST ? { J_INBOX_SIGNIN_TEST: "1" } : {}) },
  }) as unknown as Spawned;

/**
 * The helper's answer: {"fields": {...}, "lastURL": "..."} once signed in, {"closed": true} when the
 * owner closed the window, {"error": "..."} when it could not run. Lines with "event" are progress
 * ({"event": "shown"}) and skipped. Only the field ids asked for, with string values, are kept.
 */
export function parseHelperLine(line: string, asked: readonly string[]): SigninResult | "event" | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.event === "string") return "event";
  if (o.closed === true) return { closed: true };
  if (o.fields && typeof o.fields === "object" && !Array.isArray(o.fields)) {
    const fields: Record<string, string> = {};
    for (const id of asked) {
      const x = (o.fields as Record<string, unknown>)[id];
      if (typeof x === "string" && x.length > 0 && x.length <= 16_384) fields[id] = x;
    }
    if (!Object.keys(fields).length) return { failed: true };
    return { fields, ...(typeof o.lastURL === "string" && o.lastURL.length <= 4096 ? { lastURL: o.lastURL } : {}) };
  }
  return { failed: true };
}

async function firstAnswer(out: ReadableStream<Uint8Array>, asked: readonly string[]): Promise<SigninResult> {
  const reader = out.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { failed: true };
      total += value.byteLength;
      if (total > MAX_OUTPUT) return { failed: true };
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const r = parseHelperLine(line, asked);
        if (r === "event") continue;
        return r ?? { failed: true };
      }
    }
  } catch {
    return { failed: true };
  } finally {
    reader.releaseLock();
  }
}

/** Windows from the helper at `executable` (J-Inbox Sign-in.app's, or a stand-in in tests). */
export function createSigninWindows(o: { executable: string; spawn?: SpawnHelper; maxMs?: number }): SigninWindows {
  const spawn = o.spawn ?? defaultSpawn;
  return {
    available: () => existsSync(o.executable),
    open(r: SigninRequest): SigninWindow | null {
      let p: Spawned;
      try {
        p = spawn([o.executable]);
      } catch {
        return null;
      }
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(limit);
        try {
          p.stdin.end?.();
        } catch {}
        try {
          p.kill("SIGTERM");
        } catch {}
      };
      const limit = setTimeout(close, o.maxMs ?? WINDOW_MAX_MS);
      (limit as { unref?: () => void }).unref?.();
      try {
        // The request (no secret in it: the site, the names of the values to collect, Beeper's script).
        p.stdin.write(JSON.stringify(r) + "\n");
        p.stdin.flush?.();
      } catch {
        close();
        return { result: Promise.resolve({ failed: true }), close };
      }
      const result = firstAnswer(
        p.stdout,
        r.fields.map((f) => f.id),
      ).then((a) => {
        close();
        return a;
      });
      return { result, close };
    },
  };
}
