// The noise judge: every conversation with new activity (a `message` upserted event, from Beeper or
// from Gmail history polling) is asked about again, in batches. It collects for DEBOUNCE_MS, reads
// each conversation's newest messages (read_chat, limit 5), asks Jev about at most BATCH_MAX in one
// call (fewer when the body would be too big), at most CALLS_PER_MINUTE calls a minute, and keeps the
// verdicts in the noise store. A conversation the owner decided, or whose newest message Jev already
// saw, is skipped. Jev failing never blocks anything: the verdicts stay as they were and the
// conversations are asked about again later (5 s doubling to 10 min). Only new activity while the
// definition is not empty and the key is set is judged: nothing is caught up later. Logs carry counts.
import { makeError, type ActionResult, type ErrorBody, type NoiseProblem } from "@j-inbox/protocol";
import type { Outcome, RequestContext } from "../actions.ts";
import { buildJevRequest, callJev, conversationOf, verdictOf, type JevConversation } from "./jev.ts";
import type { NoiseStore } from "./store.ts";

export const DEBOUNCE_MS = 5_000;
export const BATCH_MAX = 40;
export const CALLS_PER_MINUTE = 6;
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 10 * 60_000;
/** Conversations waiting at most; the oldest beyond go (no backfill: a later message brings one back). */
const MAX_PENDING = 1000;
const READ_CONCURRENCY = 4;
const READ_TIMEOUT_MS = 10_000;

export type NoiseJudgeOptions = {
  store: NoiseStore;
  /** The router's read_chat (the chat as Beeper and Gmail have it, not decorated with noise). */
  readChat: (p: { chatID: string; limit: number }, ctx: RequestContext) => Promise<Outcome<ActionResult<"read_chat">>>;
  /** The Jev key (the Keychain's typesafe-api-key), read when a batch runs. */
  apiKey: () => Promise<string | null>;
  url: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  debounceMs?: number;
  batchMax?: number;
  callsPerMinute?: number;
  timeoutMs?: number;
  /** Jitter source for the backoff (tests: () => 0.5). */
  random?: () => number;
  log?: (msg: string) => void;
  /** Conversations that became noise or stopped being noise (the service tells open pages with metadata-only `chat` events). */
  onChange?: (chatIDs: string[]) => void;
};

export class NoiseJudge {
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueAt = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private failures = 0;
  private calls: number[] = [];
  private stopped = false;
  private lastProblem: Exclude<NoiseProblem, "no_key"> | null = null;
  private keyKnown: boolean | null = null;
  private readonly now: () => number;

  constructor(private readonly o: NoiseJudgeOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Jev's last trouble (null after a call that worked). */
  get problem(): Exclude<NoiseProblem, "no_key"> | null {
    return this.lastProblem;
  }

  /** Conversations waiting to be asked about. */
  get waiting(): number {
    return this.pending.size;
  }

  /** Is the key in the Keychain? (read now) */
  async keySet(): Promise<boolean> {
    try {
      this.keyKnown = !!(await this.o.apiKey());
    } catch {
      this.keyKnown = false;
    }
    return this.keyKnown;
  }

  /** New activity in a conversation: ask about it again soon (while the definition is not empty). */
  touch(chatID: string) {
    if (this.stopped || !this.o.store.active() || this.o.store.isOwners(chatID)) return;
    this.pending.delete(chatID);
    this.pending.add(chatID);
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.values().next().value!);
    this.schedule(this.failures ? this.backoff() : (this.o.debounceMs ?? DEBOUNCE_MS));
  }

  /** The definition changed: what waits is asked about with the new one; a failure streak starts over. */
  definitionChanged() {
    this.failures = 0;
    this.lastProblem = null;
    if (!this.o.store.active()) this.pending.clear();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Run a batch now (tests, and the timer). Concurrent callers share it. */
  runNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    if (this.timer) clearTimeout(this.timer), (this.timer = null);
    this.running = this.batch()
      .catch(() => {})
      .finally(() => {
        this.running = null;
        if (this.again && !this.stopped) {
          this.again = false;
          this.schedule(0);
        }
      });
    return this.running;
  }

  /** Run at most `ms` from now (an earlier run already planned stays). */
  private schedule(ms: number) {
    if (this.stopped) return;
    const at = this.now() + ms;
    if (this.timer && this.dueAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.dueAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow();
    }, Math.max(0, ms));
  }

  private backoff(): number {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, this.failures - 1));
    return Math.round(base * (0.8 + 0.4 * (this.o.random ?? Math.random)()));
  }

  private requeue(ids: string[]) {
    for (const id of ids) this.pending.add(id);
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.values().next().value!);
  }

  private async batch(): Promise<void> {
    const store = this.o.store;
    if (!store.active()) return this.pending.clear();
    if (!this.pending.size) return;
    const now = this.now();
    this.calls = this.calls.filter((t) => now - t < 60_000);
    if (this.calls.length >= (this.o.callsPerMinute ?? CALLS_PER_MINUTE)) return this.schedule(this.calls[0]! + 60_000 - now);
    let key: string | null = null;
    try {
      key = await this.o.apiKey();
    } catch {}
    this.keyKnown = !!key;
    if (!key) {
      // No key: classification is off; nothing waits to be caught up later.
      this.pending.clear();
      return;
    }
    const ids = [...this.pending].slice(0, this.o.batchMax ?? BATCH_MAX);
    for (const id of ids) this.pending.delete(id);
    const read = await this.readAll(ids.filter((id) => !store.isOwners(id)));
    const fresh = read.filter((r) => !(r.lastMessageID && store.verdict(r.chatID)?.source === "jev" && store.verdict(r.chatID)?.lastMessageID === r.lastMessageID));
    if (!fresh.length) return this.next();
    const lines = store.lines();
    const req = buildJevRequest({ lines, conversations: fresh.map((r) => r.conversation), examples: store.examples() });
    const asked = fresh.slice(0, req.asked);
    // What did not fit in this call goes first next time.
    if (req.asked < fresh.length) {
      const rest = [...fresh.slice(req.asked).map((r) => r.chatID), ...this.pending];
      this.pending = new Set(rest);
    }
    this.calls.push(this.now());
    const r = await callJev({ url: this.o.url, key, body: req.body, fetchImpl: this.o.fetchImpl, timeoutMs: this.o.timeoutMs });
    if (this.stopped) return;
    if (!r.ok) {
      this.lastProblem = r.problem;
      this.failures++;
      if (r.retry) this.requeue(asked.map((a) => a.chatID));
      this.o.log?.(`noise: Jev failed (${r.status ?? "no answer"}), ${asked.length} conversations ${r.retry ? "wait" : "dropped"}`);
      if (this.pending.size) this.schedule(this.backoff());
      return;
    }
    this.failures = 0;
    this.lastProblem = null;
    // The definition may have changed during the call: a line no longer there is no verdict.
    const now2 = store.lines();
    const out = asked.map((a, i) => {
      const v = verdictOf(r.answers[`q${i}`], lines);
      const stillThere = !v.noise || now2.includes(v.reason!);
      return { chatID: a.chatID, noise: v.noise && stillThere, ...(v.noise && stillThere ? { reason: v.reason } : {}), confidence: v.confidence, ...(a.lastMessageID ? { lastMessageID: a.lastMessageID } : {}), title: a.title, network: a.network };
    });
    if (!store.active()) return;
    const before = out.map((x) => store.isNoise(x.chatID));
    store.setJev(out);
    const changed = out.filter((x, i) => store.isNoise(x.chatID) !== before[i]).map((x) => x.chatID);
    if (changed.length) this.o.onChange?.(changed);
    this.o.log?.(`noise: judged ${out.length} conversations (${out.filter((x) => x.noise).length} noise)`);
    this.next();
  }

  private next() {
    if (this.pending.size) this.schedule(1000);
  }

  /** read_chat for each (a few at a time); a chat that is gone is dropped, one that failed waits for its next activity. */
  private async readAll(ids: string[]): Promise<{ chatID: string; conversation: JevConversation; lastMessageID: string | null; title: string; network: string }[]> {
    const out: ({ chatID: string; conversation: JevConversation; lastMessageID: string | null; title: string; network: string } | null)[] = new Array(ids.length).fill(null);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(READ_CONCURRENCY, ids.length) }, async () => {
        while (next < ids.length) {
          const i = next++;
          const id = ids[i]!;
          const ctx: RequestContext = { signal: AbortSignal.timeout(READ_TIMEOUT_MS), deadline: this.now() + READ_TIMEOUT_MS };
          let r: Outcome<ActionResult<"read_chat">>;
          try {
            r = await this.o.readChat({ chatID: id, limit: 5 }, ctx);
          } catch {
            r = { ok: false, error: makeError("INTERNAL", "read failed") as ErrorBody };
          }
          if (!r.ok) continue;
          const c = conversationOf(r.data);
          out[i] = { chatID: id, ...c, title: r.data.chat.title, network: r.data.chat.network };
        }
      }),
    );
    return out.filter((x): x is NonNullable<typeof x> => x !== null);
  }
}
