// The sanitizer off the main thread, with a deadline: a hostile email costs a Worker that is thrown away, and the
// connector's event loop goes on answering. Past the deadline the worker is terminated and the answer is null,
// which is the text. terminate() stops JavaScript, also inside the rewriter's handlers; a regular expression already running
// goes on, so all the sanitizer's patterns are bounded, and a worker that does not end is counted (its close event never
// comes): after a few of those the connector stops starting new ones (the text for all) rather than let an email pin its cores.
import type { Sanitized } from "./email-html.ts";

export type HtmlJob = { op: "cids"; html: string } | { op: "sanitize"; html: string; images: [string, string][] } | { op: "compare"; messages: { id: string; html: string; plain: string }[] };

export const SANITIZE_DEADLINE_MS = 3000;
/** Long enough for a terminated worker to have ended, if it can. */
const END_GRACE_MS = 2000;
const MAX_STUCK = 3;

let stuck = 0;
export const stuckWorkers = () => stuck;
/** Tests only. */
export const forgetStuckWorkers = () => void (stuck = 0);

/** Where the worker is: beside this file when run from source; in a compiled binary, as its own entry point (package.json "build"). */
export function workerPath(moduleUrl: string = import.meta.url): string {
  return moduleUrl.startsWith("file:///$bunfs/") ? "/$bunfs/root/gmail/email-html-worker.js" : new URL("./email-html-worker.ts", moduleUrl).href;
}

type Options = { deadlineMs?: number; path?: string };

/** One job in its own worker. `onMessage` gets each answer until it says enough (true); false from the promise: the deadline passed, or the worker could not start. */
function run(job: HtmlJob, onMessage: (m: any) => boolean, o: Options): Promise<boolean> {
  if (stuck >= MAX_STUCK) return Promise.resolve(false);
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(o.path ?? workerPath());
    } catch {
      return resolve(false);
    }
    let ended = false;
    worker.addEventListener("close", () => void (ended = true));
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      worker.terminate();
      if (!ok)
        (setTimeout(() => {
          if (!ended) stuck++;
        }, END_GRACE_MS) as { unref?: () => void }).unref?.();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), o.deadlineMs ?? SANITIZE_DEADLINE_MS);
    worker.onmessage = (e) => {
      if (onMessage(e.data)) finish(true);
    };
    worker.onerror = () => finish(false);
    worker.postMessage(job);
  });
}

export async function cidReferencesIn(html: string, o: Options = {}): Promise<string[] | null> {
  let out: string[] | null = null;
  await run({ op: "cids", html }, (m) => ((out = m.cids), true), o);
  return out;
}

export async function sanitizeInWorker(html: string, images: Map<string, string>, o: Options = {}): Promise<Sanitized | null> {
  let out: Sanitized | null = null;
  await run({ op: "sanitize", html, images: [...images] }, (m) => ((out = m.sanitized), true), o);
  return out;
}

/** For each message, the text its HTML shows if its plain part clearly differs; `null` if they agree (or it cannot be told); not there if the deadline came first. */
export async function compareInWorker(messages: { id: string; html: string; plain: string }[], o: Options = {}): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  await run(
    { op: "compare", messages },
    (m) => {
      if (m.done) return true;
      out.set(m.compared.id, m.compared.shown);
      return false;
    },
    o,
  );
  return out;
}
