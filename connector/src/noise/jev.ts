// Jev: TypeSafe's System One (POST <api>/v1/systemone), asked whether conversations are noise.
// One `choice` question per conversation: the criteria are "Not noise" plus one choice per line of
// the owner's definition (name "Noise: <first words>", description = the line), so the chosen line
// is the verdict's reason. `state` says what J-Inbox is and carries the owner's corrections as
// examples. Each conversation is compact: network, title, group, low priority already, who started
// it, whether anyone else wrote, the last few messages (me / other) cut short. Noise only when a line
// was chosen with confidence >= NOISE_CONFIDENCE_THRESHOLD; everything else is not noise. Nothing
// here logs; the key is only ever in the Authorization header.
import { NOISE_CONFIDENCE_THRESHOLD, sanitizeLine, truncateText, type ActionResult, type NoiseProblem } from "@j-inbox/protocol";

export const JEV_MODEL = "jev-latest";
export const JEV_PATH = "/v1/systemone";
export const NOT_NOISE = "Not noise";
export const NOT_NOISE_DESCRIPTION =
  "Anything a person would want to see: real people writing to the owner, replies to the owner's own emails or messages, conversations the owner takes part in, personal or work matters that need attention. Choose this whenever unsure.";
/** Messages per conversation, and characters per message. */
export const JEV_MESSAGES = 5;
export const JEV_MESSAGE_CHARS = 300;
export const JEV_TIMEOUT_MS = 20_000;
/** A request body stays under this many characters (System One reads 64k tokens; criteria repeat per question). */
export const JEV_MAX_BODY_CHARS = 120_000;
const MAX_LABEL_WORDS = 5;
const MAX_LABEL_CHARS = 48;
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

/** One conversation as Jev sees it. */
export type JevConversation = {
  network: string;
  title: string;
  group: boolean;
  /** Beeper or Gmail already keeps it out of the main inbox (a Gmail tab other than Primary). */
  lowPriority: boolean;
  /** The owner wrote its first message (null: the start is older than what was read). */
  startedByMe: boolean | null;
  /** Someone other than the owner wrote in it (null: not in what was read, and there is more). */
  othersReplied: boolean | null;
  messages: { from: "me" | "other"; name?: string; text: string }[];
};

const oneLine = (s: string, max: number) => sanitizeLine(String(s ?? "").replace(/\s+/g, " "), max);

function cut(s: string, max: number): string {
  const t = truncateText(oneLine(s, max * 2), max);
  return t.truncated ? t.text + "…" : t.text;
}

/** A read_chat page (newest messages, oldest first) as Jev's conversation, and the newest message's id. */
export function conversationOf(r: ActionResult<"read_chat">): { conversation: JevConversation; lastMessageID: string | null } {
  const items = r.items.filter((m) => m.type !== "REACTION" && !m.isDeleted);
  const last = items.slice(-JEV_MESSAGES);
  const others = items.some((m) => !m.isSender);
  const messages = last.map((m) => {
    const text = m.text ? cut(m.text, JEV_MESSAGE_CHARS) : m.attachments?.length ? `[${m.attachments.map((a) => a.type).join(", ")}]` : `[${m.type.toLowerCase()}]`;
    const name = !m.isSender && m.senderName ? oneLine(m.senderName, 60) : "";
    return { from: m.isSender ? ("me" as const) : ("other" as const), ...(name ? { name } : {}), text };
  });
  return {
    conversation: {
      network: oneLine(r.chat.network, 64),
      title: oneLine(r.chat.title, 200),
      group: r.chat.type === "group",
      lowPriority: r.chat.isLowPriority === true,
      startedByMe: r.hasMore || !items.length ? null : items[0]!.isSender,
      othersReplied: others ? true : r.hasMore ? null : false,
      messages,
    },
    lastMessageID: r.items.length ? r.items[r.items.length - 1]!.id : null,
  };
}

/** The owner's correction as a one-line example for Jev's `state`. */
export function exampleOf(c: JevConversation): string {
  const yn = (b: boolean | null) => (b === null ? "unknown" : b ? "yes" : "no");
  const lastText = c.messages.length ? `; last message from ${c.messages[c.messages.length - 1]!.from}: "${cut(c.messages[c.messages.length - 1]!.text, 120)}"` : "";
  return oneLine(`${c.network}${c.group ? " group" : ""} "${cut(c.title, 80)}"; started by the owner: ${yn(c.startedByMe)}; others replied: ${yn(c.othersReplied)}${lastText}`, 400);
}

/** Choice names for the definition's lines: "Noise: " + its first words, unique, never "Not noise". */
export function noiseLabels(lines: string[]): string[] {
  const used = new Set<string>([NOT_NOISE.toLowerCase()]);
  return lines.map((line, i) => {
    const words = line.replace(/[^\p{L}\p{N}'’&/+-]+/gu, " ").trim().split(/\s+/).filter(Boolean).slice(0, MAX_LABEL_WORDS).join(" ");
    let label = "Noise: " + (truncateText(words || `line ${i + 1}`, MAX_LABEL_CHARS - 7).text.trim() || `line ${i + 1}`);
    if (used.has(label.toLowerCase())) label = `${truncateText(label, MAX_LABEL_CHARS - 5).text} (${i + 1})`;
    used.add(label.toLowerCase());
    return label;
  });
}

export function jevState(examples: { example: string; noise: boolean }[]): string {
  const head =
    'J-Inbox is the owner\'s unified inbox (chats on many networks, and email). Each question is one conversation that just had new activity. Decide whether it is noise for the owner, by the owner\'s own definition of noise: every choice other than "Not noise" is one line of that definition. Choose "Not noise" for anything a person would want to see, and whenever you are unsure.';
  if (!examples.length) return head;
  return [head, "The owner's own decisions on earlier conversations (decide similar ones the same way):", ...examples.map((e) => `- ${e.example} => ${e.noise ? "Noise" : "Not noise"}`)].join("\n");
}

export type JevRequest = { body: { model: string; state: string; questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> }; asked: number };

/**
 * The request for as many of `conversations` (in order) as fit JEV_MAX_BODY_CHARS (at least one):
 * question q<i> is conversations[i]. `asked` says how many went in.
 */
export function buildJevRequest(o: { lines: string[]; conversations: JevConversation[]; examples: { example: string; noise: boolean }[]; maxChars?: number }): JevRequest {
  const labels = noiseLabels(o.lines);
  const criteria: Record<string, string> = { [NOT_NOISE]: NOT_NOISE_DESCRIPTION };
  labels.forEach((l, i) => (criteria[l] = o.lines[i]!));
  const body: JevRequest["body"] = { model: JEV_MODEL, state: jevState(o.examples), questions: {} };
  const max = o.maxChars ?? JEV_MAX_BODY_CHARS;
  let size = JSON.stringify(body).length;
  let asked = 0;
  for (const c of o.conversations) {
    const q = { type: "choice" as const, instructions: `Is this conversation noise for the owner? Choose the line of the owner's definition it matches, or "${NOT_NOISE}".\nConversation (JSON): ${JSON.stringify(c)}`, criteria };
    const add = JSON.stringify(q).length + 12;
    if (asked > 0 && size + add > max) break;
    body.questions[`q${asked}`] = q;
    size += add;
    asked++;
  }
  return { body, asked };
}

export type JevAnswer = { choice: string; confidence: number };
export type Verdict = { noise: boolean; reason?: string; confidence: number };

/**
 * The verdict for one answer: noise only when Jev chose a definition line at least
 * NOISE_CONFIDENCE_THRESHOLD sure; "Not noise", a low confidence, an unknown choice or no answer
 * is not noise.
 */
export function verdictOf(a: JevAnswer | undefined, lines: string[]): Verdict {
  if (!a) return { noise: false, confidence: 0 };
  const idx = noiseLabels(lines).indexOf(a.choice);
  const confidence = Number.isFinite(a.confidence) ? Math.min(1, Math.max(0, a.confidence)) : 0;
  if (idx < 0 || confidence < NOISE_CONFIDENCE_THRESHOLD) return { noise: false, confidence };
  return { noise: true, reason: lines[idx]!, confidence };
}

export type JevCall = { ok: true; answers: Record<string, JevAnswer> } | { ok: false; problem: Exclude<NoiseProblem, "no_key">; status?: number; retry: boolean };

/**
 * One System One call. Network failures, timeouts, 429 and 5xx: jev_unreachable (retry); 401/403:
 * jev_refused (retry later: a new key may come); other 4xx: jev_refused, not retried (the request
 * itself was refused). An answer that is not the documented shape counts as unreachable.
 */
export async function callJev(o: { url: string; key: string; body: unknown; fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }): Promise<JevCall> {
  const timer = AbortSignal.timeout(o.timeoutMs ?? JEV_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(o.url.replace(/\/$/, "") + JEV_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(o.body),
      redirect: "manual",
      signal: o.signal ? AbortSignal.any([o.signal, timer]) : timer,
    });
  } catch {
    return { ok: false, problem: "jev_unreachable", retry: true };
  }
  if (res.status === 401 || res.status === 403) return drain(res, { ok: false, problem: "jev_refused", status: res.status, retry: true });
  if (res.status === 429 || res.status >= 500 || (res.status >= 300 && res.status < 400)) return drain(res, { ok: false, problem: "jev_unreachable", status: res.status, retry: true });
  if (res.status >= 400) return drain(res, { ok: false, problem: "jev_refused", status: res.status, retry: false });
  let j: any;
  try {
    const text = await readCapped(res, MAX_ANSWER_BYTES);
    j = text === null ? null : JSON.parse(text);
  } catch {
    j = null;
  }
  if (!j || typeof j.answers !== "object" || j.answers === null || Array.isArray(j.answers)) return { ok: false, problem: "jev_unreachable", status: res.status, retry: true };
  const answers: Record<string, JevAnswer> = {};
  for (const [id, a] of Object.entries<any>(j.answers)) if (a && typeof a.choice === "string" && typeof a.confidence === "number") answers[id] = { choice: a.choice, confidence: a.confidence };
  return { ok: true, answers };
}

async function drain<T>(res: Response, v: T): Promise<T> {
  try {
    await res.body?.cancel();
  } catch {}
  return v;
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}
