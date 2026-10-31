// Beeper events that happen while the cloud link is down (it drops every hour or two and comes
// back within seconds): kept in a small bounded buffer, one entry per chat and kind, and sent once
// the link is connected again. Metadata only, like the events themselves; memory only. Status
// events are never kept (every welcome sends a fresh one). A buffer that overflowed lost the
// oldest chats; the Reconciler's re-sync after the welcome covers the recent ones.
import { MAX_EVENT_IDS, eventFrame, parse, type EventFrame } from "@j-inbox/protocol";

export const EVENT_BUFFER_MAX = 200;

type ChatOrMessage = Exclude<EventFrame, { kind: "status" }>;

const later = (a: string, b: string) => (Date.parse(b) > Date.parse(a) ? b : a);

/** othersAt of two merged message events: the newest time someone else wrote, else null (only the owner), else unknown. */
function mergeOthersAt(a: string | null | undefined, b: string | null | undefined): string | null | undefined {
  if (typeof a === "string" && typeof b === "string") return later(a, b);
  if (typeof a === "string") return a;
  if (typeof b === "string") return b;
  if (a === undefined || b === undefined) return undefined;
  return null;
}

export class EventBuffer {
  private items = new Map<string, ChatOrMessage>();
  /** Entries dropped (oldest first) since the last flush. */
  dropped = 0;

  constructor(private readonly max = EVENT_BUFFER_MAX) {}

  get size(): number {
    return this.items.size;
  }

  /** Keep `f` for later. Always true for chat and message events (false for status events, which are not kept). */
  add(f: EventFrame): boolean {
    if (f.kind === "status") return false;
    const key = `${f.kind}\u0000${f.op}\u0000${f.chatID}`;
    const had = this.items.get(key);
    let next: ChatOrMessage = f;
    if (had?.kind === "message" && f.kind === "message") {
      const ids = [...new Set([...had.messageIDs, ...f.messageIDs])];
      const othersAt = mergeOthersAt(had.othersAt, f.othersAt);
      // Too many ids for one event: the chat event for it says enough (clients refetch the chat).
      if (ids.length > MAX_EVENT_IDS) {
        this.items.delete(key);
        return this.add({ type: "event", kind: "chat", op: "upserted", chatID: f.chatID, ts: later(had.ts, f.ts) });
      }
      const { othersAt: _drop, ...base } = f;
      next = { ...base, messageIDs: ids, ts: later(had.ts, f.ts), ...(othersAt !== undefined ? { othersAt } : {}) };
    } else if (had?.kind === "chat" && f.kind === "chat") {
      next = { ...f, ts: later(had.ts, f.ts) };
    }
    // Re-inserting moves the chat to the newest end, so overflow drops the chats quiet the longest.
    this.items.delete(key);
    this.items.set(key, next);
    while (this.items.size > this.max) {
      this.items.delete(this.items.keys().next().value!);
      this.dropped++;
    }
    return true;
  }

  /** Send everything kept, oldest first; what `send` refuses (the link went down again) stays. Returns how many were sent. */
  flush(send: (f: EventFrame) => boolean): number {
    let n = 0;
    for (const [key, f] of [...this.items]) {
      if (!parse(eventFrame, f).ok) {
        this.items.delete(key);
        continue;
      }
      if (!send(f)) return n;
      this.items.delete(key);
      n++;
    }
    this.dropped = 0;
    return n;
  }

  clear() {
    this.items.clear();
    this.dropped = 0;
  }
}
