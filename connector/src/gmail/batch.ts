// Gmail's batch endpoint (developers.google.com/gmail/api/guides/batch): many GETs in one HTTP
// request, POST /batch/gmail/v1 with a multipart/mixed body of application/http parts. The batch's
// Authorization covers every call; each call still counts against the per-user quota. The answer is
// multipart/mixed with one application/http part per call, Content-ID "response-<id>". Everything
// in the answer is untrusted: an unreadable part is reported as such, never guessed.

export const GMAIL_BATCH_PATH = "/batch/gmail/v1";
/** Calls per batch: Gmail allows 100 but advises at most 50 (larger batches trip its rate limit). */
export const GMAIL_BATCH_SIZE = 20;

const PART_ID = (i: number) => `c${i}`;

/** The multipart/mixed body for GETs of these paths (each `/gmail/v1/...` with its query). */
export function buildBatch(paths: string[], boundary: string): string {
  if (!/^[A-Za-z0-9_-]{8,70}$/.test(boundary)) throw new Error("bad boundary");
  let out = "";
  paths.forEach((p, i) => {
    // A path never carries a line break or a space (client.path encodes every segment and the query).
    if (!p.startsWith("/gmail/v1/") || /[\s]/.test(p)) throw new Error("bad batch path");
    out += `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${PART_ID(i)}>\r\n\r\nGET ${p} HTTP/1.1\r\nAccept: application/json\r\n\r\n`;
  });
  return out + `--${boundary}--\r\n`;
}

export type BatchPart = { status: number; body: unknown };

function splitHead(s: string): [string, string] | null {
  const m = /\r?\n\r?\n/.exec(s);
  return m ? [s.slice(0, m.index), s.slice(m.index + m[0].length)] : null;
}

/**
 * The answers of a batch of `n` calls, by position: a part per call, matched by its Content-ID
 * (`response-c<i>`), or by order when Gmail sent none. null for a call whose part is missing or
 * unreadable. null for the whole batch when the answer is not a multipart/mixed batch at all.
 */
export function parseBatchResponse(contentType: string | null, text: string, n: number): (BatchPart | null)[] | null {
  const m = /^multipart\/mixed\s*;.*\bboundary=(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(contentType ?? "");
  if (!m) return null;
  const boundary = m[1] ?? m[2]!;
  const chunks = text.split(`--${boundary}`);
  if (chunks.length < 2) return null;
  const out: (BatchPart | null)[] = new Array(n).fill(null);
  let order = 0;
  for (const chunk of chunks.slice(1)) {
    if (chunk.startsWith("--")) break;
    const index = order++;
    const outer = splitHead(chunk.replace(/^\r?\n/, ""));
    if (!outer) continue;
    const id = /^content-id:\s*<?\s*response-c(\d{1,4})\s*>?\s*$/im.exec(outer[0]);
    const at = id ? Number(id[1]) : /^content-id:/im.test(outer[0]) ? -1 : index;
    if (!Number.isInteger(at) || at < 0 || at >= n || out[at] !== null) continue;
    const http = splitHead(outer[1]);
    if (!http) continue;
    const status = /^HTTP\/1\.[01] (\d{3})\b/.exec(http[0].trimStart());
    if (!status) continue;
    const raw = http[1].replace(/\r?\n$/, "");
    let body: unknown = null;
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    out[at] = { status: Number(status[1]), body };
  }
  return out;
}

/** A boundary nobody can predict or put in a path. */
export function batchBoundary(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return "jinbox_" + Buffer.from(b).toString("base64url");
}
