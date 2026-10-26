// Mailboxes, OAuth grants and history for the fake. Deterministic ids; every mutation bumps the
// mailbox historyId and is recorded for users.history.list.
import { addressesIn, bodyText, decodeHeader, snippetOf, type Header, type Part } from "./mime.ts";
import type { MessageView } from "./query.ts";

export const SYSTEM_LABELS = [
  "INBOX",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
] as const;

export type FMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  payload: Part;
  /** base64url raw for messages a client sent or drafted. */
  raw?: string;
  /** A draft's id (drafts.create). */
  draftId?: string;
};

export type HistoryRecord = {
  id: number;
  messagesAdded?: { id: string; threadId: string; labelIds: string[] }[];
  messagesDeleted?: { id: string; threadId: string; labelIds: string[] }[];
  labelsAdded?: { message: { id: string; threadId: string; labelIds: string[] }; labelIds: string[] }[];
  labelsRemoved?: { message: { id: string; threadId: string; labelIds: string[] }; labelIds: string[] }[];
};

export class Mailbox {
  messages = new Map<string, FMessage>();
  historyId = 1000;
  history: HistoryRecord[] = [];
  /** history.list with a startHistoryId below this answers 404 (Gmail keeps about a week). */
  oldestHistoryId = 1000;
  /** Fixture thread names -> thread ids. */
  names: Record<string, string> = {};
  private seq = 0;

  constructor(
    readonly email: string,
    readonly sub: string,
    private readonly idBase: number,
  ) {}

  /** Gmail ids are 16 hex digits. */
  newId(): string {
    return (this.idBase * 0x100000 + ++this.seq).toString(16).padStart(16, "0");
  }

  private record(r: Omit<HistoryRecord, "id">) {
    this.historyId += 1 + (this.seq % 3);
    this.history.push({ id: this.historyId, ...r });
    if (this.history.length > 5000) this.history.splice(0, this.history.length - 5000);
  }

  private ref(m: FMessage) {
    return { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] };
  }

  add(m: FMessage, opts: { silent?: boolean } = {}) {
    this.messages.set(m.id, m);
    if (!opts.silent) this.record({ messagesAdded: [this.ref(m)] });
  }

  remove(id: string) {
    const m = this.messages.get(id);
    if (!m) return;
    this.messages.delete(id);
    this.record({ messagesDeleted: [this.ref(m)] });
  }

  modify(id: string, add: string[], remove: string[]) {
    const m = this.messages.get(id);
    if (!m) return;
    const added = add.filter((l) => !m.labelIds.includes(l));
    const removed = remove.filter((l) => m.labelIds.includes(l));
    m.labelIds = [...m.labelIds.filter((l) => !removed.includes(l)), ...added];
    if (added.length) this.record({ labelsAdded: [{ message: this.ref(m), labelIds: added }] });
    if (removed.length) this.record({ labelsRemoved: [{ message: this.ref(m), labelIds: removed }] });
  }

  thread(id: string): FMessage[] {
    return [...this.messages.values()].filter((m) => m.threadId === id).sort((a, b) => a.internalDate - b.internalDate || (a.id < b.id ? -1 : 1));
  }

  threadIds(): string[] {
    return [...new Set([...this.messages.values()].map((m) => m.threadId))];
  }
}

export function header(p: Part, name: string): string {
  return p.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function hasAttachment(p: Part): boolean {
  return !!p.attachmentId || (p.parts ?? []).some(hasAttachment);
}

export function viewOf(m: FMessage): MessageView {
  const p = m.payload;
  return {
    labelIds: m.labelIds,
    from: decodeHeader(header(p, "From")),
    to: decodeHeader(header(p, "To")),
    cc: decodeHeader(header(p, "Cc")),
    subject: decodeHeader(header(p, "Subject")),
    text: bodyText(p),
    internalDate: m.internalDate,
    hasAttachment: hasAttachment(p),
    messageIdHeader: header(p, "Message-ID"),
  };
}

export function snippet(m: FMessage): string {
  return snippetOf(bodyText(m.payload));
}

export type Grant = { email: string; clientId: string; scopes: string[]; revoked: boolean };
export type AccessToken = { grant: Grant; expiresAt: number };

/** Every address on a message, lower case (From, To, Cc). */
export function people(m: FMessage): string[] {
  const p = m.payload;
  return [...addressesIn(header(p, "From")), ...addressesIn(header(p, "To")), ...addressesIn(header(p, "Cc"))];
}

export type { Header, Part };
