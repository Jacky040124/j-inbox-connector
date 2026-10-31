// Live updates for Gmail: every GMAIL_POLL_INTERVAL_MS per account (GMAIL_POLL_ACTIVE_INTERVAL_MS
// while the owner has a J-Inbox page open), users.history.list from the last historyId, turned
// into the same metadata-only events the Beeper source sends (`message` upserted/deleted, `chat`
// upserted). The first poll only records where history starts. A 404 (history too old) re-syncs:
// a fresh start point and a `chat` event for the newest threads, so open pages refetch. An account
// that needs reconnecting is skipped until it is reconnected. The position moves on only when
// every event of the poll was handed to the cloud (send true); while the link is down (canSend
// false) nothing is polled, and the poll after the next welcome reads from the last position that
// was handed over, so a change is announced late rather than never.
import { GMAIL_POLL_ACTIVE_INTERVAL_MS, GMAIL_POLL_INTERVAL_MS, MAX_EVENT_IDS, eventFrame, gmailChatID, parse, type EventFrame } from "@j-inbox/protocol";
import type { GmailSource } from "./source.ts";

export type PollerOptions = {
  sources: () => GmailSource[];
  /** Hand an event to the cloud: true only when it went out on a connected link. */
  send: (f: EventFrame) => boolean;
  /** False while the cloud link is down: accounts are not polled (only a first start point is taken); pollAll after the welcome catches up. */
  canSend?: () => boolean;
  intervalMs?: number;
  /** While someone watches (setActive(true)). Default GMAIL_POLL_ACTIVE_INTERVAL_MS, never slower than intervalMs. */
  activeIntervalMs?: number;
  /** Threads announced after a history reset. */
  resyncThreads?: number;
  log?: (msg: string, fields?: Record<string, string | number | boolean | null>) => void;
  /** Accounts not to poll (reconnect required). */
  skip?: (email: string) => boolean;
};

const MAX_HISTORY_PAGES = 10;

const SENDER_RANK = { self: 0, unknown: 1, others: 2 } as const;

export class GmailPoller {
  private historyIds = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | null = null;
  private active = false;

  constructor(private readonly o: PollerOptions) {}

  /** The interval in use now. */
  get intervalMs(): number {
    const idle = this.o.intervalMs ?? GMAIL_POLL_INTERVAL_MS;
    return this.active ? Math.min(idle, this.o.activeIntervalMs ?? GMAIL_POLL_ACTIVE_INTERVAL_MS) : idle;
  }

  start() {
    if (this.timer) return;
    void this.pollAll();
    this.schedule();
  }

  private schedule() {
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.pollAll(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Someone has a J-Inbox page open (the cloud's viewers count > 0): poll faster, and at once when that starts. */
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (!this.timer) return;
    this.schedule();
    if (active) void this.pollAll();
  }

  /** Forget an account's position (removed, or reconnected). */
  forget(email: string) {
    this.historyIds.delete(email);
  }

  /** One round over every account (concurrent callers share it). */
  pollAll(): Promise<void> {
    this.running ??= (async () => {
      for (const s of this.o.sources()) {
        // Link down: only find where history starts (nothing to send for that); the rest waits for the welcome.
        if (this.o.canSend && !this.o.canSend() && this.historyIds.has(s.email)) continue;
        if (this.o.skip?.(s.email)) continue;
        try {
          await this.poll(s);
        } catch {
          // a failed round is retried at the next tick
        }
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** True when the event went out (an invalid one is skipped: it can never go out). */
  private emit(f: EventFrame): boolean {
    if (!parse(eventFrame, f).ok) return true;
    return this.o.send(f);
  }

  private async resync(s: GmailSource) {
    const p = await s.profile({});
    if (!p.ok) return;
    const r = await s.client.get(s.client.path(["threads"], { q: "in:inbox", maxResults: String(this.o.resyncThreads ?? 20) }));
    if (!r.ok || !Array.isArray(r.body?.threads)) return;
    const ts = new Date().toISOString();
    let all = true;
    for (const t of r.body.threads) if (typeof t?.id === "string" && /^[A-Za-z0-9]{1,64}$/.test(t.id)) all = this.emit({ type: "event", kind: "chat", op: "upserted", chatID: gmailChatID(s.email, t.id), ts }) && all;
    // Only once the cloud has heard: else the next poll finds the old position too old and re-syncs again.
    if (all) this.historyIds.set(s.email, p.data.historyId);
  }

  async poll(s: GmailSource): Promise<number> {
    const start = this.historyIds.get(s.email);
    if (start === undefined) {
      const p = await s.profile({});
      if (p.ok) this.historyIds.set(s.email, p.data.historyId);
      return 0;
    }
    const added = new Map<string, Set<string>>();
    // Per thread with added mail: someone else wrote (no SENT label), only the owner did, or unknown (no labels).
    const senders = new Map<string, "others" | "self" | "unknown">();
    const deleted = new Map<string, Set<string>>();
    const touched = new Set<string>();
    let pageToken: string | undefined;
    let latest = start;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const r = await s.client.get(s.client.path(["history"], { startHistoryId: start, maxResults: "500", pageToken }));
      if (!r.ok) {
        if (r.error.code === "NOT_FOUND") {
          this.o.log?.("gmail: history expired, re-syncing");
          await this.resync(s);
        }
        return 0;
      }
      const body = r.body ?? {};
      if (typeof body.historyId === "string" && /^\d{1,20}$/.test(body.historyId)) latest = body.historyId;
      for (const rec of Array.isArray(body.history) ? body.history : []) {
        const note = (list: unknown, into: Map<string, Set<string>> | null) => {
          if (!Array.isArray(list)) return;
          for (const x of list) {
            const m = x?.message;
            if (typeof m?.id !== "string" || typeof m?.threadId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(m.id) || !/^[A-Za-z0-9]{1,64}$/.test(m.threadId)) continue;
            // Drafts are the owner's unsent text: never announced.
            if (Array.isArray(m.labelIds) && m.labelIds.includes("DRAFT")) continue;
            touched.add(m.threadId);
            if (into) {
              const set = into.get(m.threadId) ?? new Set<string>();
              set.add(m.id);
              into.set(m.threadId, set);
            }
            if (into === added) {
              const who = !Array.isArray(m.labelIds) ? "unknown" : m.labelIds.includes("SENT") ? "self" : "others";
              const was = senders.get(m.threadId);
              if (was === undefined || SENDER_RANK[who] > SENDER_RANK[was]) senders.set(m.threadId, who);
            }
          }
        };
        note(rec?.messagesAdded, added);
        note(rec?.messagesDeleted, deleted);
        note(rec?.labelsAdded, null);
        note(rec?.labelsRemoved, null);
      }
      pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
      if (!pageToken) break;
    }
    const ts = new Date().toISOString();
    let n = 0;
    let all = true;
    for (const [op, map] of [["upserted", added], ["deleted", deleted]] as const)
      for (const [threadId, set] of map) {
        const ids = [...set];
        for (let i = 0; i < ids.length; i += MAX_EVENT_IDS) {
          // othersAt (snooze's early return): Gmail history has no times, and added mail is new: the poll's time.
          const who = op === "upserted" ? senders.get(threadId) : undefined;
          const othersAt = who === "others" ? ts : who === "self" ? null : undefined;
          if (this.emit({ type: "event", kind: "message", op, chatID: gmailChatID(s.email, threadId), messageIDs: ids.slice(i, i + MAX_EVENT_IDS), ts, ...(othersAt !== undefined ? { othersAt } : {}) })) n++;
          else all = false;
        }
      }
    for (const threadId of touched) {
      if (this.emit({ type: "event", kind: "chat", op: "upserted", chatID: gmailChatID(s.email, threadId), ts })) n++;
      else all = false;
    }
    // Handed over: next time from here. Not (the link dropped meanwhile): the same changes again next time.
    if (all && this.historyIds.get(s.email) === start) this.historyIds.set(s.email, latest);
    return n;
  }
}
