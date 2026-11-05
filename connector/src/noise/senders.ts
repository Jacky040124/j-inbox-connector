// The noise list of senders, where it needs Gmail (the list itself and the rule: store.ts).
//
// Where the rule is applied. A thread is mapped for a list, a read or a search: its newest sender is right there
// (seeChat), at no cost, before anything filters it. New mail: the poller asks who wrote just before it announces the
// thread (lookAt, one Gmail batch, only while the list has an entry), so To do and open pages hear of a caught thread
// as noise from the start and it never shows in To do. If that read fails, the judge's read gets it, 5 s or so later.
//
// Learning (store.ts learn). The owner's verdicts count by their `sender`, read when they mark a conversation: the one address
// everyone but the owner in it wrote from (a group or mailing-list thread has none, and teaches nothing, so a colleague is never learned).
// Those from before the list have none: once, in the background, each is looked up (threads.get metadata with only From, the thread as it was at the mark),
// ten every second at most, through the account's client and its pacing. What is found goes to disk a batch at a time, so a
// restart goes on where this stopped; when none is left it is marked done on disk and never runs again. A thread that
// is gone has no sender, which counts as found. Failures are logged by count and tried again later, doubling up to half an hour.
//
// Existing mail. An entry that comes on the list, by hand or learned, is walked: Gmail's ids for `in:inbox from:<entry>` of the last
// 30 days, at most WALK_MAX_THREADS, each checked by the rule (never Jev), a non-match keeping the verdict it has. Waiting walks are
// on disk, so a restart walks them again from the top, which changes nothing that is already known. Everything here runs one at a time, in one
// loop, paced. No log line says anything about mail or who wrote it.
//
// Nothing of it starts before START_DELAY_MS after a start: no learning, no walk, no look at old marks. Those make the first verdicts from
// the list, which an old Worker cannot read; a deploy puts the connector first (README "Deploying the noise list of senders").
import { MAX_NOISE_SENDERS, gmailChatID, makeError, parseGmailChatID, type ChatSummary, type ErrorBody, type NoiseSender } from "@j-inbox/protocol";
import type { RequestContext } from "../actions.ts";
import type { SenderLook } from "../gmail/source.ts";
import type { NoiseStore, RuleFacts } from "./store.ts";

export const WALK_DAYS = 30;
export const WALK_MAX_THREADS = 500;
/** Threads asked about in one Gmail batch, in the background; a pause follows. */
export const BACKGROUND_BATCH = 10;
const BACKGROUND_PAUSE_MS = 1_000;
/** After a start, so what a start does comes first. */
const START_DELAY_MS = 2 * 60_000;
const RETRY_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
/** Threads asked about before the poller announces them; beyond that the judge's read decides. */
const POLL_LOOK_MAX = 20;
const POLL_LOOK_TIMEOUT_MS = 5_000;
const BACKGROUND_TIMEOUT_MS = 30_000;
const MAX_WALK_TRIES = 5;
/** Events per batch of a walk: enough for open pages to read their list again, not one per thread. */
const EVENTS_PER_BATCH = 3;
const EVENTS_PER_REMOVAL = 20;
/** Who wrote, for the walk and the poller (the decision's name too). The lookups need only From. */
const WITH_TITLE = ["From", "Subject"] as const;
const FROM_ONLY = ["From"] as const;

/** What these need of one Gmail account (gmail/source.ts). */
export type SenderSource = {
  email: string;
  threadIDs(q: string, pageToken: string | null, ctx: RequestContext): Promise<{ ids: string[]; next: string | null }>;
  threadSenders(ids: string[], headers: readonly string[], ctx: RequestContext, until?: (number | undefined)[]): Promise<SenderLook[]>;
};

export type SenderRulesOptions = {
  store: NoiseStore;
  /** Accounts that can be asked now. */
  sources: () => SenderSource[];
  /** The account, if it is still on this computer (needing a reconnect or not). */
  known: (email: string) => boolean;
  /** Any connected account's address or alias (gmail/own.ts). */
  isOwn: (address: string) => boolean;
  /** What is known of the owner's addresses, before anything is learned from a read. */
  ownAddressesReady?: () => Promise<void>;
  /** Conversations that became noise or stopped being noise. */
  onChange?: (chatIDs: string[]) => void;
  log?: (msg: string) => void;
  now?: () => number;
  /** Tests: shorter waits. */
  timing?: { startDelayMs?: number; pauseMs?: number; retryMs?: number };
};

type Added = { ok: true; data: { entry: NoiseSender; added: boolean; chatNoise?: boolean } } | { ok: false; error: ErrorBody };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const factsOf = (email: string, threadId: string, l: Extract<SenderLook, { status: "ok" }>): RuleFacts => ({ chatID: gmailChatID(email, threadId), lastMessageID: l.senders.lastMessageID, address: l.senders.newest, title: l.senders.title, network: "Gmail" });

export class SenderRules {
  private readonly store: NoiseStore;
  private readonly now: () => number;
  private stopped = false;
  private started = false;
  /** Learning, walks and lookups wait until then (epoch ms). */
  private readyAt = Number.POSITIVE_INFINITY;
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ownReady = false;
  private tries = 0;
  private walkTries = new Map<string, number>();

  constructor(private readonly o: SenderRulesOptions) {
    this.store = o.store;
    this.now = o.now ?? Date.now;
  }

  // ---------------------------------------------------------------- the rule, as mail is seen

  /** A thread as it is mapped: its preview is its newest message. */
  seeChat(c: ChatSummary) {
    const p = c.preview;
    // No list: no verdict from it either (taking the last entry off clears them).
    if (!p || !this.store.hasSenders()) return;
    this.moved(this.store.applyRule([{ chatID: c.id, lastMessageID: p.id, address: p.isSender ? null : (p.senderID ?? null), title: c.title, network: c.network }], { clear: true, note: true }));
  }

  /** New mail, just before the poller announces these threads. Whatever goes wrong here, the events go out and the judge's read decides. */
  async lookAt(s: SenderSource, threadIds: string[]): Promise<void> {
    if (!this.store.hasSenders() || !threadIds.length) return;
    const ids = threadIds.slice(0, POLL_LOOK_MAX);
    const got = await s.threadSenders(ids, WITH_TITLE, { signal: AbortSignal.timeout(POLL_LOOK_TIMEOUT_MS) }).catch(() => [] as SenderLook[]);
    const facts = got.flatMap((l, i) => (l.status === "ok" ? [factsOf(s.email, ids[i]!, l)] : []));
    this.moved(this.store.applyRule(facts, { clear: true, note: true }));
  }

  // ---------------------------------------------------------------- the owner's hand

  /** Settings' add. */
  add(value: string): Added {
    if (this.o.isOwn(value)) return { ok: false, error: makeError("NOT_ALLOWED", "That is one of your own addresses: mail from you is never noise.") };
    return this.put(value);
  }

  /** The menu's Always noise from this sender: the newest person other than the owner in this conversation. */
  async addOfChat(chatID: string, ctx: RequestContext): Promise<Added> {
    const g = parseGmailChatID(chatID);
    if (!g) return { ok: false, error: makeError("NOT_SUPPORTED", "Only email senders can go on the noise list.") };
    const s = this.o.sources().find((x) => x.email === g.email);
    if (!s) return { ok: false, error: makeError("NOT_FOUND", "This email's account can't be reached on this computer right now.") };
    const [l] = await s.threadSenders([g.threadId], WITH_TITLE, ctx);
    if (l?.status === "failed") return { ok: false, error: l.error };
    if (l?.status !== "ok") return { ok: false, error: makeError("NOT_FOUND", "This email thread is empty or was deleted.") };
    if (!l.senders.newestOther) return { ok: false, error: makeError("CONFLICT", "Nobody else has written in this conversation.") };
    const r = this.put(l.senders.newestOther);
    if (!r.ok) return r;
    // This one goes at once; its walk comes later.
    this.moved(this.store.applyRule([factsOf(g.email, g.threadId, l)], { clear: false, note: true }));
    return { ok: true, data: { ...r.data, chatNoise: this.store.noiseOf(chatID)?.source === "sender" } };
  }

  private put(value: string): Added {
    const r = this.store.addSender(value, "owner");
    if (!r) return { ok: false, error: makeError("CONFLICT", `Your noise list is full (${MAX_NOISE_SENDERS} senders).`) };
    if (r.added) this.kick();
    return { ok: true, data: r };
  }

  /** Off the list: what came from it is cleared. By the owner's hand, so it is not learned again. */
  remove(value: string, o: { undo?: boolean } = {}): boolean {
    const r = this.store.removeSender(value, { remember: true, undo: o.undo });
    if (!r) return false;
    this.walkTries.delete(value);
    this.tell(r.cleared, EVENTS_PER_REMOVAL);
    return true;
  }

  /**
   * The sender a mark on this conversation counts for: the one address everyone but the owner in it wrote from, from its metadata (From only).
   * null: none (nobody else, several, or not an email). undefined: Gmail could not say now (the look at old marks asks again).
   */
  async senderOfChat(chatID: string, ctx: RequestContext): Promise<string | null | undefined> {
    const g = parseGmailChatID(chatID);
    if (!g) return null;
    const s = this.o.sources().find((x) => x.email === g.email);
    if (!s) return undefined;
    const [l] = await s.threadSenders([g.threadId], FROM_ONLY, ctx).catch(() => [undefined]);
    return l?.status === "ok" ? l.senders.sole : l?.status === "gone" ? null : undefined;
  }

  /** The owner marked a conversation: what that teaches (the addresses learned now), and its sender, if the mark could not tell (senderKnown false). */
  ownerMarked(chatID: string, senderKnown: boolean): string[] {
    const learned = this.learn();
    if (!senderKnown && parseGmailChatID(chatID)) this.kick(this.o.timing?.pauseMs ?? BACKGROUND_PAUSE_MS);
    return learned;
  }

  /** The owner's addresses were asked for again: an entry learned before one of them was known is no entry. */
  ownAddressesChanged() {
    this.learn();
  }

  /** Learning is held until the start's wait is over; then the first round does it. */
  private ready(): boolean {
    return this.started && this.now() >= this.readyAt;
  }

  private learn(): string[] {
    if (!this.ready()) return [];
    try {
      const r = this.store.learn(this.o.isOwn);
      this.tell(r.cleared, EVENTS_PER_REMOVAL);
      if (r.learned.length) {
        this.o.log?.(`noise: learned ${r.learned.length} senders from your marks`);
        this.kick();
      }
      return r.learned;
    } catch {
      this.o.log?.("noise: could not write what your marks taught");
      return [];
    }
  }

  // ---------------------------------------------------------------- in the background

  /** From now on (the service, once): nothing before the start's wait is over, then one round for whatever waits. */
  start() {
    if (this.started || this.stopped) return;
    const wait = this.o.timing?.startDelayMs ?? START_DELAY_MS;
    this.started = true;
    this.readyAt = this.now() + wait;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow();
    }, wait);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.store.flush();
  }

  /** The loop, soon (not before an earlier plan). Before the start's wait is over, nothing: the round at its end takes all that waits. */
  private kick(ms = 0) {
    if (this.stopped || !this.ready()) return;
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow();
    }, ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** One round: the lookups, then the walks. Concurrent callers share it; failures try again later. Not before the start's wait is over. */
  runNow(): Promise<void> {
    if (!this.ready()) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer), (this.timer = null);
    this.running ??= this.round()
      .catch(() => {
        this.o.log?.("noise: the look at senders failed for now, it will be tried again");
        this.retry();
      })
      .finally(() => {
        this.running = null;
        if (this.again && !this.stopped) {
          this.again = false;
          this.kick();
        }
      });
    return this.running;
  }

  private retry() {
    if (this.stopped) return;
    const wait = Math.min((this.o.timing?.retryMs ?? RETRY_MS) * 2 ** this.tries++, RETRY_MAX_MS);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow();
    }, wait);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async round() {
    if (!this.ownReady) {
      await this.o.ownAddressesReady?.();
      this.ownReady = true;
    }
    if (this.stopped) return;
    const lookups = await this.lookups();
    if (this.stopped) return;
    const walks = await this.walks();
    if (this.stopped) return;
    if (lookups || walks) this.retry();
    else this.tries = 0;
  }

  private ctx(): RequestContext {
    return { signal: AbortSignal.timeout(BACKGROUND_TIMEOUT_MS) };
  }

  private pause() {
    return sleep(this.o.timing?.pauseMs ?? BACKGROUND_PAUSE_MS);
  }

  /** Each owner's verdict without a sender, the thread as it was at the mark. Answers how many failed. */
  private async lookups(): Promise<number> {
    const waiting = this.store.ownerWithoutSender();
    let failed = 0;
    let found = 0;
    const live = new Map(this.o.sources().map((s) => [s.email, s] as const));
    const byAccount = new Map<string, string[]>();
    for (const chatID of waiting) {
      const email = parseGmailChatID(chatID)!.email;
      byAccount.set(email, [...(byAccount.get(email) ?? []), chatID]);
    }
    for (const [email, chats] of byAccount) {
      const s = live.get(email);
      if (!s) {
        // Removed: nobody can say. Waiting for a reconnect: later.
        if (this.o.known(email)) failed += chats.length;
        else this.store.setOwnerSenders(chats.map((chatID) => ({ chatID, sender: null })));
        continue;
      }
      for (let i = 0; i < chats.length && !this.stopped; i += BACKGROUND_BATCH) {
        const part = chats.slice(i, i + BACKGROUND_BATCH);
        const at = part.map((c) => this.store.verdict(c)?.at);
        const got = await s.threadSenders(part.map((c) => parseGmailChatID(c)!.threadId), FROM_ONLY, this.ctx(), at).catch(() => null);
        if (!got) {
          failed += part.length;
          continue;
        }
        const now = part.flatMap((chatID, k) => {
          const l = got[k];
          if (l?.status === "ok") return [{ chatID, sender: l.senders.sole }];
          if (l?.status === "gone") return [{ chatID, sender: null }];
          failed++;
          return [];
        });
        // On disk a batch at a time: a restart goes on from here.
        this.store.setOwnerSenders(now);
        found += now.length;
        this.learn();
        if (i + BACKGROUND_BATCH < chats.length) await this.pause();
      }
    }
    if (this.stopped) return 0;
    if (waiting.length) this.o.log?.(`noise: looked up the senders of ${found} of your marks${failed ? `, ${failed} failed and will be tried again` : ""}`);
    this.learn();
    if (!failed) this.store.markSenderLookupsDone();
    return failed;
  }

  /** The walks waiting. Answers how many failed. */
  private async walks(): Promise<number> {
    let failed = 0;
    // New ones may come while these go; the next round has them.
    for (const value of [...this.store.pendingWalks()]) {
      if (this.stopped) break;
      if (!this.store.pendingWalks().includes(value)) continue;
      const ok = await this.walk(value).catch(() => false);
      if (this.stopped) break;
      if (ok) {
        this.store.finishWalk(value);
        this.walkTries.delete(value);
        continue;
      }
      const tries = (this.walkTries.get(value) ?? 0) + 1;
      if (tries >= MAX_WALK_TRIES) {
        // New mail is still caught, and lists catch what they show. Only the rest of what was already there stays where it is.
        this.store.finishWalk(value);
        this.walkTries.delete(value);
        this.o.log?.(`noise: gave up moving existing mail for a sender after ${tries} tries`);
      } else {
        this.walkTries.set(value, tries);
        failed++;
      }
    }
    if (failed) this.o.log?.(`noise: moving existing mail failed for ${failed} senders, it will be tried again`);
    return failed;
  }

  /** One entry's existing mail. False: some of it could not be looked at. */
  private async walk(value: string): Promise<boolean> {
    const since = Math.floor((this.now() - WALK_DAYS * 86_400_000) / 1000);
    const q = `in:inbox from:${value} after:${since}`;
    let left = WALK_MAX_THREADS;
    let whole = true;
    for (const s of this.o.sources()) {
      let token: string | null = null;
      while (left > 0 && !this.stopped && this.store.pendingWalks().includes(value)) {
        const page: { ids: string[]; next: string | null } = await s.threadIDs(q, token, this.ctx());
        const ids = page.ids.slice(0, left);
        left -= ids.length;
        // The owner's verdict stands whoever wrote: no need to ask.
        const asked = ids.filter((id) => !this.store.isOwners(gmailChatID(s.email, id)));
        for (let i = 0; i < asked.length && !this.stopped && this.store.pendingWalks().includes(value); i += BACKGROUND_BATCH) {
          const part = asked.slice(i, i + BACKGROUND_BATCH);
          const got = await s.threadSenders(part, WITH_TITLE, this.ctx()).catch(() => null);
          if (!got || got.some((l) => l.status === "failed")) whole = false;
          const facts = (got ?? []).flatMap((l, k) => (l.status === "ok" ? [factsOf(s.email, part[k]!, l)] : []));
          // Recent decisions keep what Jev decided about new activity: this is not that.
          this.tell(this.store.applyRule(facts, { clear: false, note: false }), EVENTS_PER_BATCH);
          await this.pause();
        }
        token = page.next;
        if (!token) break;
      }
    }
    return whole;
  }

  private moved(ids: string[]) {
    if (ids.length) this.o.onChange?.(ids);
  }

  private tell(ids: string[], most: number) {
    if (ids.length) this.o.onChange?.(ids.slice(0, most));
  }
}
