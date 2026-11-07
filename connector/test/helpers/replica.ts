// A page's replica of the inbox, as sync.ts says a page keeps it, written apart from inbox.db's own
// code on purpose: tests check that applying the changelog here gives exactly what inbox.db holds.
//   chat.upsert: the chat's whole summary; chat.remove: the chat and its messages go;
//   messages.upsert: those messages as they are now, then the chat keeps its newest
//   SYNC_MESSAGES_PER_CHAT (by sortKey: Beeper's are numeric strings, so by length, then lexically;
//   ties by id); messages.remove: those go. A snapshot replaces everything.
import { SYNC_MESSAGES_PER_CHAT, type ChatSummary, type MessageItem, type SyncChange, type SyncSnapshotChat } from "@j-inbox/protocol";

const cmpKey = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
/** Newest first. */
const newer = (a: MessageItem, b: MessageItem) => -cmpKey(a.sortKey, b.sortKey) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export type ReplicaState = Map<string, { chat: ChatSummary; messages: MessageItem[] }>;

export class Replica {
  chats = new Map<string, ChatSummary>();
  messages = new Map<string, Map<string, MessageItem>>();
  epoch: string | null = null;
  cursor = 0;

  apply(c: SyncChange) {
    switch (c.op) {
      case "chat.upsert":
        this.chats.set(c.chat.id, c.chat);
        break;
      case "chat.remove":
        this.chats.delete(c.chatID);
        this.messages.delete(c.chatID);
        break;
      case "messages.upsert": {
        const m = this.messages.get(c.chatID) ?? new Map<string, MessageItem>();
        for (const x of c.messages) m.set(x.id, x);
        const keep = [...m.values()].sort(newer).slice(0, SYNC_MESSAGES_PER_CHAT);
        this.messages.set(c.chatID, new Map(keep.map((x) => [x.id, x])));
        break;
      }
      case "messages.remove": {
        const m = this.messages.get(c.chatID);
        for (const id of c.messageIDs) m?.delete(id);
        break;
      }
    }
    this.cursor = c.seq;
  }

  applyAll(changes: readonly SyncChange[]) {
    for (const c of changes) this.apply(c);
  }

  /** Replace everything with a whole snapshot (its pages together; a chat twice: the later one). */
  replace(epoch: string, head: number, chats: readonly SyncSnapshotChat[]) {
    this.chats.clear();
    this.messages.clear();
    for (const e of chats) {
      this.chats.set(e.chat.id, e.chat);
      this.messages.set(e.chat.id, new Map(e.messages.map((m) => [m.id, m])));
    }
    this.epoch = epoch;
    this.cursor = head;
  }

  /** The same shape as InboxDB.dump(): messages newest last. */
  state(): ReplicaState {
    const out: ReplicaState = new Map();
    for (const [id, chat] of this.chats) out.set(id, { chat, messages: [...(this.messages.get(id)?.values() ?? [])].sort(newer).reverse() });
    for (const [id, m] of this.messages) if (!this.chats.has(id) && m.size) out.set(id, { chat: null as never, messages: [...m.values()].sort(newer).reverse() });
    return out;
  }
}

/** Two states as sorted plain data, for toEqual. */
export function plain(s: ReplicaState): [string, { chat: ChatSummary; messages: MessageItem[] }][] {
  return [...s.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
