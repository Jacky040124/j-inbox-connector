// What keeps inbox.db true: whenever the connector learns that a chat may have changed (a Beeper
// event, the Reconciler's re-sync, a Gmail poll, To do and noise changes, the owner's own actions),
// the chat is read again here on the Mac (read_chat through the dispatcher: the same decorated
// ChatSummary a list carries, To do and noise included, and its newest SYNC_MESSAGES_PER_CHAT
// messages) and applied: chat.upsert, then messages.upsert, then messages.remove for the kept ones
// in the range the read covered that are not there any more. NOT_FOUND is chat.remove; a deleted
// chat or message (Beeper's events say which) is removed at once, without a read.
//   - One read per chat at a time, at most `concurrency` chats at once: a chat asked for again while
//     it is being read is read once more after (the first read may have started before the change).
//     A read that fails otherwise (Beeper down, a timeout) is tried again a few times, later.
//   - The first build's reads (background) wait behind everything else.
//   - The owner's own action on a chat (begin/end, from the dispatcher) holds that chat's reads
//     while it runs; when it is done the chat is read with the request's opId, so what it caused
//     carries it, and for LINGER_MS more any change to the chat does too (Beeper may say what a
//     write did a moment after answering it), until the owner's next action on it. A change in that
//     time that the action did not cause carries the opId too: the page's optimistic copy is then
//     over a little early, never late.
//   - A chat removed while a read of it is out: that read's answer is dropped (it may predate the removal).
import { SYNC_MESSAGES_PER_CHAT, type ActionResult, type ChatSummary, type EventFrame, type MessageItem } from "@j-inbox/protocol";
import type { Outcome, RequestContext } from "../actions.ts";
import { isBarePreview } from "../preview-fill.ts";
import type { InboxDB } from "./db.ts";
import { newestFirst } from "./window.ts";

export type ReadChat = (chatID: string, ctx: RequestContext) => Promise<Outcome<ActionResult<"read_chat">>>;

export type IngestOptions = {
  db: InboxDB;
  /** read_chat {chatID, limit: SYNC_MESSAGES_PER_CHAT} as the dispatcher answers it (decorated). */
  read: ReadChat;
  concurrency?: number;
  readTimeoutMs?: number;
  /** Waits before the next tries of a read that failed (not NOT_FOUND). */
  retryMs?: readonly number[];
  lingerMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
};

export const LINGER_MS = 3_000;

type Job = { chatID: string; opId?: string; background: boolean; tries: number; waiters: (() => void)[] };

/** A chat as list_chats shows it: a preview that says nothing, or none, is the newest message read. */
export function withPreview(chat: ChatSummary, items: readonly MessageItem[]): ChatSummary {
  if (!items.length || (chat.preview && !isBarePreview(chat.preview))) return chat;
  const newest = [...items].sort(newestFirst)[0]!;
  return { ...chat, preview: newest };
}

export class InboxIngest {
  private urgent = new Map<string, Job>();
  private background = new Map<string, Job>();
  /** Asked for again while being read: read once more after. */
  private again = new Map<string, Job>();
  private running = new Set<string>();
  private held = new Map<string, number>();
  private linger = new Map<string, { opId: string; until: number }>();
  /** Bumped by every removal of a chat: a read that started before it is dropped. */
  private gen = new Map<string, number>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private active = 0;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly o: IngestOptions) {
    this.now = o.now ?? Date.now;
  }

  /** A metadata event the connector sends (or would send): what it says may have changed. */
  onEvent(f: EventFrame) {
    if (f.kind === "status") return;
    if (f.kind === "chat" && f.op === "deleted") return this.removeChat(f.chatID);
    if (f.kind === "message" && f.op === "deleted") this.apply({ op: "messages.remove", chatID: f.chatID, messageIDs: f.messageIDs });
    void this.refresh(f.chatID);
  }

  /** Read the chat again and apply it. Resolves when a read that started after this call is done (or given up). */
  refresh(chatID: string, o: { opId?: string; background?: boolean } = {}): Promise<void> {
    if (this.stopped || !this.o.db.isOpen) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const merge = (j: Job) => {
        if (o.opId) j.opId = o.opId;
        j.waiters.push(resolve);
      };
      const fresh = (): Job => ({ chatID, ...(o.opId ? { opId: o.opId } : {}), background: !!o.background, tries: 0, waiters: [resolve] });
      if (this.running.has(chatID)) {
        const j = this.again.get(chatID);
        if (j) merge(j);
        else this.again.set(chatID, fresh());
      } else if (this.urgent.has(chatID)) merge(this.urgent.get(chatID)!);
      else if (this.background.has(chatID)) {
        const j = this.background.get(chatID)!;
        merge(j);
        if (!o.background) {
          // Someone is waiting for it now: it goes ahead of the build.
          this.background.delete(chatID);
          j.background = false;
          this.urgent.set(chatID, j);
        }
      } else (o.background ? this.background : this.urgent).set(chatID, fresh());
      this.pump();
    });
  }

  /** Forget a chat (gone, or out of the window). */
  removeChat(chatID: string, opId?: string) {
    this.gen.set(chatID, (this.gen.get(chatID) ?? 0) + 1);
    for (const q of [this.urgent, this.background, this.again]) {
      const j = q.get(chatID);
      if (j && !j.opId) {
        q.delete(chatID);
        for (const w of j.waiters) w();
      }
    }
    this.apply({ op: "chat.remove", chatID }, opId ?? this.lingering(chatID));
  }

  /** Forget every chat of these accounts (removed from this computer). */
  removeAccounts(accountIDs: readonly string[], opId?: string) {
    if (!this.o.db.isOpen) return;
    for (const id of this.o.db.chatIDsOfAccounts(accountIDs)) this.removeChat(id, opId);
  }

  /**
   * The owner's action on a chat starts: its reads wait until the returned function is called. ok:
   * the action succeeded, and the chat is read with its opId (awaited by the caller, so the change is
   * in inbox.db, and on its way to the pages, by the time the answer goes).
   */
  begin(chatID: string, opId?: string): (ok: boolean) => Promise<void> {
    this.held.set(chatID, (this.held.get(chatID) ?? 0) + 1);
    // A newer request on the chat: what follows is its doing, not the one before's.
    this.linger.delete(chatID);
    let ended = false;
    return (ok: boolean) => {
      if (ended) return Promise.resolve();
      ended = true;
      const n = (this.held.get(chatID) ?? 1) - 1;
      if (n > 0) this.held.set(chatID, n);
      else this.held.delete(chatID);
      if (ok && opId) this.linger.set(chatID, { opId, until: this.now() + (this.o.lingerMs ?? LINGER_MS) });
      if (!ok) {
        this.pump();
        return Promise.resolve();
      }
      return this.refresh(chatID, opId ? { opId } : {});
    };
  }

  /** Nothing queued or being read (tests). */
  async idle(): Promise<void> {
    while (!this.stopped && (this.active || this.urgent.size || this.background.size || this.again.size)) await Bun.sleep(5);
  }

  /** Reads waiting (not the build's), for the build's pacing. */
  get busy(): boolean {
    return this.urgent.size > 0 || this.again.size > 0;
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const q of [this.urgent, this.background, this.again]) {
      for (const j of q.values()) for (const w of j.waiters) w();
      q.clear();
    }
  }

  private apply(...a: Parameters<InboxDB["apply"]>) {
    if (this.stopped || !this.o.db.isOpen) return [];
    return this.o.db.apply(...a);
  }

  private lingering(chatID: string): string | undefined {
    const l = this.linger.get(chatID);
    if (!l) return undefined;
    if (l.until > this.now()) return l.opId;
    this.linger.delete(chatID);
    return undefined;
  }

  private next(): Job | null {
    for (const q of [this.urgent, this.background]) {
      for (const [id, j] of q) {
        if (this.held.has(id) || this.running.has(id)) continue;
        q.delete(id);
        return j;
      }
      // The build waits while anything else is waiting, even a held chat.
      if (q === this.urgent && q.size) return null;
    }
    return null;
  }

  private pump() {
    while (!this.stopped && this.active < (this.o.concurrency ?? 2)) {
      const j = this.next();
      if (!j) return;
      this.active++;
      this.running.add(j.chatID);
      void this.run(j).finally(() => {
        this.active--;
        this.running.delete(j.chatID);
        for (const w of j.waiters) w();
        const a = this.again.get(j.chatID);
        if (a) {
          this.again.delete(j.chatID);
          (a.background ? this.background : this.urgent).set(j.chatID, a);
        }
        this.pump();
      });
    }
  }

  private async run(j: Job) {
    const gen = this.gen.get(j.chatID) ?? 0;
    const ms = this.o.readTimeoutMs ?? 30_000;
    let r: Outcome<ActionResult<"read_chat">> | null;
    try {
      r = await this.o.read(j.chatID, { signal: AbortSignal.timeout(ms), deadline: this.now() + ms });
    } catch {
      r = null;
    }
    if (this.stopped || !this.o.db.isOpen || (this.gen.get(j.chatID) ?? 0) !== gen) return;
    const opId = j.opId ?? this.lingering(j.chatID);
    if (r && !r.ok && r.error.code === "NOT_FOUND") return this.removeChat(j.chatID, opId);
    if (!r || !r.ok) return this.retry(j);
    const { chat, items } = r.data;
    // A read answers the chat it was asked for; anything else is not applied.
    if (chat.id !== j.chatID) return;
    this.apply({ op: "chat.upsert", chat: withPreview(chat, items) }, opId);
    if (!items.length || !this.o.db.chat(chat.id)) return;
    this.apply({ op: "messages.upsert", chatID: chat.id, messages: [...items].sort(newestFirst).slice(0, SYNC_MESSAGES_PER_CHAT) }, opId);
    // Kept messages in the range this read covered that it did not return: deleted (or hidden) since.
    const oldest = [...items].sort(newestFirst).at(-1)!;
    const present = new Set(items.map((m) => m.id));
    const gone = this.o.db.messageIDsFrom(chat.id, oldest.sortKey).filter((id) => !present.has(id));
    if (gone.length) this.apply({ op: "messages.remove", chatID: chat.id, messageIDs: gone }, opId);
  }

  private retry(j: Job) {
    const waits = this.o.retryMs ?? [2_000, 15_000, 60_000];
    if (j.tries >= waits.length) return this.o.log?.("inbox: a chat could not be read; it is read again at its next change");
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.stopped) return;
      const q = j.background ? this.background : this.urgent;
      if (this.running.has(j.chatID) || q.has(j.chatID)) return;
      q.set(j.chatID, { chatID: j.chatID, ...(j.opId ? { opId: j.opId } : {}), background: j.background, tries: j.tries + 1, waiters: [] });
      this.pump();
    }, waits[j.tries]);
    this.timers.add(t);
  }
}
