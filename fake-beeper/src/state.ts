// Mutable in-memory world of the fake Beeper. Mutations emit domain events like /v1/ws does.
import { buildFixture, chatAccount, type BAccount, type BAsset, type BAttachment, type BChat, type BMessage, type Fixture } from "./fixtures.ts";

/** A file uploaded with POST /v1/assets/upload (or /upload/base64), kept until the fake is reset. */
export type BUpload = { uploadID: string; fileName: string; mimeType: string; srcURL: string; bytes: Uint8Array };

export type DomainEventType = "chat.upserted" | "chat.deleted" | "message.upserted" | "message.deleted";
export type DomainEvent = { type: DomainEventType; chatID: string; ids: string[]; entries?: Record<string, unknown>[] };
/**
 * One HTTP request the fake received. Logged before auth and before injected faults, so a write
 * that hung, failed by injection or was refused still shows up in writes().
 */
export type Call = {
  method: string;
  /** "METHOD /spec/template", or "METHOD /raw/path" for unknown routes. */
  route: string;
  params: Record<string, string>;
  query: Record<string, string[]>;
  body: unknown;
  at: number;
  authorized: boolean;
  /** Set when failNext / hangNext answered instead of the fake's normal behaviour. */
  injected?: "fail" | "hang";
  /** HTTP status sent (absent while a request hangs). */
  status?: number;
};

export class FakeBeeperState {
  accounts: BAccount[];
  chats: Map<string, BChat>;
  messages: Map<string, BMessage[]>;
  assets: Map<string, BAsset>;
  /** Files uploaded with /v1/assets/upload, by uploadID. Their srcURL is also served as an asset. */
  uploads = new Map<string, BUpload>();
  /** Every request the fake handled, in order. Tests assert on writes here. */
  calls: Call[] = [];
  private listeners = new Set<(e: DomainEvent) => void>();
  private pendingCounter = 0;
  /** Clock used for new messages; tests may replace it. */
  now: () => number = () => Date.now();

  constructor(fixture: Fixture = buildFixture()) {
    this.accounts = fixture.accounts;
    this.chats = new Map(fixture.chats.map((c) => [c.id, c]));
    this.messages = fixture.messages;
    this.assets = fixture.assets;
  }

  onEvent(fn: (e: DomainEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: DomainEvent) {
    for (const fn of this.listeners) fn(e);
  }

  chatList(): BChat[] {
    return [...this.chats.values()];
  }

  messagesOf(chatID: string): BMessage[] {
    return this.messages.get(chatID) ?? [];
  }

  lastMessage(chatID: string): BMessage | undefined {
    const m = this.messagesOf(chatID);
    return m[m.length - 1];
  }

  private nextSortKey(): string {
    let max = 0;
    for (const list of this.messages.values()) for (const m of list) max = Math.max(max, Number(m.sortKey));
    return String(max + 1);
  }

  emitChat(chat: BChat) {
    this.emit({ type: "chat.upserted", chatID: chat.id, ids: [chat.id], entries: [structuredClone(chat) as Record<string, unknown>] });
  }

  emitMessage(msg: BMessage) {
    this.emit({ type: "message.upserted", chatID: msg.chatID, ids: [msg.id], entries: [structuredClone(msg) as Record<string, unknown>] });
  }

  /** A temporary upload (POST /v1/assets/upload): served at its srcURL like any asset. */
  upload(o: { fileName: string; mimeType: string; bytes: Uint8Array }): BUpload {
    const uploadID = `upload_${++this.pendingCounter}`;
    const srcURL = `file:///tmp/fake-beeper-uploads/${uploadID}/${encodeURIComponent(o.fileName)}`;
    const u: BUpload = { uploadID, fileName: o.fileName, mimeType: o.mimeType, srcURL, bytes: o.bytes };
    this.uploads.set(uploadID, u);
    this.assets.set(srcURL, { url: srcURL, mimeType: o.mimeType, fileName: o.fileName, size: o.bytes.length, bytes: () => o.bytes });
    return u;
  }

  /** Message sent by us (POST /messages). Starts PENDING, becomes SUCCESS after `settleMs`. */
  sendOwn(chat: BChat, text: string | undefined, replyTo: string | undefined, settleMs: number, attachment?: BAttachment): BMessage {
    // iMessage has no /v1/accounts entry: fall back to the chat's own self participant.
    const account = this.accounts.find((a) => a.accountID === chat.accountID) ?? chatAccount(chat.accountID);
    const self = chat.participants.items.find((p) => p.isSelf);
    const ts = new Date(this.now()).toISOString();
    const msg: BMessage = {
      id: `pending_${++this.pendingCounter}`,
      chatID: chat.id,
      accountID: chat.accountID,
      senderID: self?.id ?? `@${account?.user.id ?? "self"}`,
      senderName: self?.fullName ?? account?.user.fullName,
      timestamp: ts,
      sortKey: this.nextSortKey(),
      ...(chat.accountID === "imessage" ? {} : { type: attachment ? attachmentMessageType(attachment) : "TEXT" }),
      ...(text !== undefined ? { text } : {}),
      ...(attachment ? { attachments: [attachment] } : {}),
      isSender: true,
      sendStatus: { status: "PENDING", timestamp: ts },
      ...(replyTo ? { linkedMessageID: replyTo } : {}),
    };
    if (!this.messages.has(chat.id)) this.messages.set(chat.id, []);
    this.messagesOf(chat.id).push(msg);
    chat.lastActivity = ts;
    chat.draft = null;
    this.emitMessage(msg);
    this.emitChat(chat);
    const settle = () => {
      msg.sendStatus = { status: "SUCCESS", timestamp: new Date(this.now()).toISOString() };
      this.emitMessage(msg);
    };
    if (settleMs <= 0) queueMicrotask(settle);
    else setTimeout(settle, settleMs);
    return msg;
  }

  /** Simulate a message arriving from someone else. */
  receive(chatID: string, opts: { text?: string; senderName?: string; attachments?: BMessage["attachments"] } = {}): BMessage {
    const chat = this.chats.get(chatID);
    if (!chat) throw new Error(`no chat ${chatID}`);
    const other = chat.participants.items.find((p) => !p.isSelf) ?? { id: "@someone:fake", fullName: "Someone" };
    const ts = new Date(this.now()).toISOString();
    const msg: BMessage = {
      id: `in_${++this.pendingCounter}`,
      chatID,
      accountID: chat.accountID,
      senderID: other.id,
      senderName: opts.senderName ?? other.fullName,
      timestamp: ts,
      sortKey: this.nextSortKey(),
      type: opts.attachments?.length ? "IMAGE" : "TEXT",
      text: opts.text ?? "New incoming message",
      isSender: false,
      isUnread: true,
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
    };
    if (!this.messages.has(chatID)) this.messages.set(chatID, []);
    this.messagesOf(chatID).push(msg);
    chat.unreadCount += 1;
    chat.lastActivity = ts;
    this.emitMessage(msg);
    this.emitChat(chat);
    return msg;
  }

  deleteMessage(chatID: string, messageID: string) {
    const list = this.messagesOf(chatID);
    const i = list.findIndex((m) => m.id === messageID);
    if (i >= 0) list.splice(i, 1);
    this.emit({ type: "message.deleted", chatID, ids: [messageID] });
  }

  deleteChat(chatID: string) {
    this.chats.delete(chatID);
    this.messages.delete(chatID);
    this.emit({ type: "chat.deleted", chatID, ids: [chatID] });
  }
}

function attachmentMessageType(a: BAttachment): string {
  return a.type === "img" ? "IMAGE" : a.type === "video" ? "VIDEO" : a.type === "audio" ? "AUDIO" : "FILE";
}
