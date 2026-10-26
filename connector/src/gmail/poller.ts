// Live updates for Gmail: every GMAIL_POLL_INTERVAL_MS per account, users.history.list from the
// last historyId, turned into the same metadata-only events the Beeper source sends (`message`
// upserted/deleted, `chat` upserted). The first poll only records where history starts. A 404
// (history too old) re-syncs: a fresh start point and a `chat` event for the newest threads, so
// open pages refetch. An account that needs reconnecting is skipped until it is reconnected.
import { GMAIL_POLL_INTERVAL_MS, MAX_EVENT_IDS, eventFrame, gmailChatID, parse, type EventFrame } from "@j-inbox/protocol";
import type { GmailSource } from "./source.ts";

export type PollerOptions = {
  sources: () => GmailSource[];
  send: (f: EventFrame) => boolean;
  intervalMs?: number;
  /** Threads announced after a history reset. */
  resyncThreads?: number;
  log?: (msg: string, fields?: Record<string, string | number | boolean | null>) => void;
  /** Accounts not to poll (reconnect required). */
  skip?: (email: string) => boolean;
};

const MAX_HISTORY_PAGES = 10;

export class GmailPoller {
  private historyIds = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | null = null;

  constructor(private readonly o: PollerOptions) {}

  start() {
    if (this.timer) return;
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), this.o.intervalMs ?? GMAIL_POLL_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Forget an account's position (removed, or reconnected). */
  forget(email: string) {
    this.historyIds.delete(email);
  }

  /** One round over every account (concurrent callers share it). */
  pollAll(): Promise<void> {
    this.running ??= (async () => {
      for (const s of this.o.sources()) {
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

  private emit(f: EventFrame) {
    if (parse(eventFrame, f).ok) this.o.send(f);
  }

  private async resync(s: GmailSource) {
    const p = await s.profile({});
    if (!p.ok) return;
    this.historyIds.set(s.email, p.data.historyId);
    const r = await s.client.get(s.client.path(["threads"], { q: "in:inbox", maxResults: String(this.o.resyncThreads ?? 20) }));
    if (!r.ok || !Array.isArray(r.body?.threads)) return;
    const ts = new Date().toISOString();
    for (const t of r.body.threads) if (typeof t?.id === "string" && /^[A-Za-z0-9]{1,64}$/.test(t.id)) this.emit({ type: "event", kind: "chat", op: "upserted", chatID: gmailChatID(s.email, t.id), ts });
  }

  async poll(s: GmailSource): Promise<number> {
    const start = this.historyIds.get(s.email);
    if (start === undefined) {
      const p = await s.profile({});
      if (p.ok) this.historyIds.set(s.email, p.data.historyId);
      return 0;
    }
    const added = new Map<string, Set<string>>();
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
    this.historyIds.set(s.email, latest);
    const ts = new Date().toISOString();
    let n = 0;
    for (const [op, map] of [["upserted", added], ["deleted", deleted]] as const)
      for (const [threadId, ids] of map) {
        const all = [...ids];
        for (let i = 0; i < all.length; i += MAX_EVENT_IDS) {
          this.emit({ type: "event", kind: "message", op, chatID: gmailChatID(s.email, threadId), messageIDs: all.slice(i, i + MAX_EVENT_IDS), ts });
          n++;
        }
      }
    for (const threadId of touched) {
      this.emit({ type: "event", kind: "chat", op: "upserted", chatID: gmailChatID(s.email, threadId), ts });
      n++;
    }
    return n;
  }
}
