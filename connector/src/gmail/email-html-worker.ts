// The sanitizer's own thread: what a hostile email costs is spent here, never on the connector's main loop.
// email-html-run.ts starts it, gives it a deadline and terminates it. A separate entry point of the compiled binary.
import { cidReferences, sanitizeEmail, textsDiffer } from "./email-html.ts";
import type { HtmlJob } from "./email-html-run.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent<HtmlJob>) => {
  const j = e.data;
  if (j.op === "cids") return self.postMessage({ cids: cidReferences(j.html) });
  if (j.op === "sanitize") return self.postMessage({ sanitized: sanitizeEmail(j.html, { images: new Map(j.images) }) });
  // Each as it is done: a hostile one at the end costs the ones before it nothing.
  for (const m of j.messages) {
    const shown = sanitizeEmail(m.html)?.text ?? null;
    self.postMessage({ compared: { id: m.id, shown: shown !== null && textsDiffer(m.plain, shown) ? shown : null } });
  }
  self.postMessage({ done: true });
};
