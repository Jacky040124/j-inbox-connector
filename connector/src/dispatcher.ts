// The connector's whitelist. A request names a catalogue action; params are validated (and
// defaulted) with parseActionParams; the action calls only its own Beeper endpoints; the result is
// checked with parseActionResult before it may leave the Mac. Anything else (the cloud's own
// actions included: the snooze store and the draft requests live in the cloud) is NOT_ALLOWED.
// The draft_store_* actions never reach Beeper: they keep draft texts in this computer's draft store;
// the upload_store_* actions and discard_upload keep files being sent in its upload store (and
// upload_store_read streams one back for the owner's preview); the noise
// actions keep the owner's definition and verdicts in its noise store; set_todo keeps the owner's To do
// state in its To do store, and get_older_unread and add_older_unread ask it what its first run left out; get_noise_senders, add_noise_sender,
// add_noise_sender_of_chat and remove_noise_sender keep the noise list of senders (noise/senders.ts). Chats in every result carry their noise mark (noise/store.ts decorate) and To do flag.
// chat_apps and chat_login_* connect the owner's chat apps through Beeper's own sign-in (chat-login.ts): owner only, and what
// the owner types passes through to Beeper without being kept or logged.
// sync_pull answers from inbox.db ("sync.v1", inbox/): a delta or a snapshot of the window. The owner's actions on a chat hold
// that chat's reads in inbox.db while they run, then read it with the request's opId (ctx.opId, from reqFrame.opId), so the
// changes they caused carry it. With an opId (a page that syncs) the answer goes once those changes are in inbox.db (or after
// SYNC_WAIT_MS, and never past the request's deadline), so the page's optimistic copy never outlives the answer by much; without one
// nothing waits.
import {
  ACTIONS,
  encodeFrame,
  isActionName,
  isCloudAction,
  makeError,
  parseActionParams,
  parseActionResult,
  parseGmailAssetURL,
  parseGmailChatID,
  type ActionResult,
  type ChatSummary,
  type ConnectorActionName,
  type ErrorBody,
  type MediaHead,
  type NoiseProblem,
} from "@j-inbox/protocol";
import type { BeeperClient } from "./beeper-client.ts";
import type { AssetAllowlist } from "./assets.ts";
import type { BeeperActions, Outcome, RequestContext } from "./actions.ts";
import type { IdempotencyCache } from "./idempotency.ts";
import { openMedia } from "./media.ts";
import { createRouter } from "./sources.ts";
import type { GmailService } from "./gmail/service.ts";
import { DraftStore } from "./drafts.ts";
import { UploadError, UploadStore } from "./uploads.ts";
import { NoiseStore } from "./noise/store.ts";
import { SenderRules } from "./noise/senders.ts";
import { isAnyOwnAddress } from "./gmail/own.ts";
import { conversationOf, exampleOf } from "./noise/jev.ts";
import { TodoStore } from "./todo/store.ts";
import { TodoTracker } from "./todo/tracker.ts";
import { createChatLogin, type ChatLogin } from "./chat-login.ts";
import type { SyncHooks } from "./inbox/index.ts";

export type DispatchResult =
  | { kind: "res"; ok: true; data: unknown; error?: undefined }
  | { kind: "res"; ok: false; error: ErrorBody; data?: undefined }
  | { kind: "media"; head: MediaHead; body: ReadableStream<Uint8Array>; cancel(): void };

type Handler = (p: any, ctx: RequestContext) => Promise<DispatchResult>;

const fail = (code: ErrorBody["code"], message: string): DispatchResult => ({ kind: "res", ok: false, error: makeError(code, message) });

/**
 * The owner's actions that change one chat (its row, its messages, its To do or noise mark): inbox.db reads it again after, with the opId.
 * Others that change chats do it through the noise and To do stores' own events, with no opId (README "Which owner's actions put
 * their opId"): set_noise_definition, add_noise_sender, remove_noise_sender, add_older_unread, gmail_connect, and the other chats of
 * the sender add_noise_sender_of_chat names. A page ends its copy of those on the answer.
 */
const CHAT_ACTIONS: ReadonlySet<string> = new Set(["send_message", "react", "mark_read", "archive", "draft_reply", "set_todo", "set_noise", "add_noise_sender_of_chat"]);
/** The longest an answer waits for inbox.db to take in what its action changed. */
export const SYNC_WAIT_MS = 3_000;
/**
 * And never closer than this to the request's deadline (ctx.deadline): the cloud link's watchdog
 * answers a started write UNKNOWN_OUTCOME ("Check before trying again") soon after it, and a write
 * that did what it was asked must not be told so because inbox.db was slow to read it back (a slow
 * Beeper, or the read queued behind the Reconciler's). The page's copy then ends with the answer.
 */
export const SYNC_WAIT_MARGIN_MS = 100;
const atMost = (p: Promise<unknown>, ms: number) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch(() => {}), new Promise((r) => (t = setTimeout(r, ms)))]).finally(() => clearTimeout(t));
};

/** The upload store's refusals (UploadError) as answers. */
function upload(fn: () => DispatchResult): DispatchResult {
  try {
    return fn();
  } catch (e) {
    if (e instanceof UploadError) return { kind: "res", ok: false, error: e.body };
    throw e;
  }
}

/** An email attachment's bytes as a get_media stream (Gmail hands attachments over whole). */
async function openGmailMedia(gmail: GmailService | null, assets: AssetAllowlist, url: string, ctx: RequestContext): Promise<DispatchResult> {
  if (!assets.has(url)) return fail("NOT_ALLOWED", "This media URL was not returned by this connector. Reload the chat and use a URL from its result.");
  const g = parseGmailAssetURL(url);
  const s = g && gmail ? gmail.source(g.email) : null;
  if (!g || !s) return fail("NOT_FOUND", "This email attachment's account is not on this computer any more.");
  const r = await s.attachment(g.messageId, g.attachmentId, ctx);
  if (!r.ok) return { kind: "res", ok: false, error: r.error };
  const bytes = r.data.bytes;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      if (bytes.length) c.enqueue(bytes);
      c.close();
    },
  });
  return { kind: "media", head: { mimeType: r.data.mimeType, size: bytes.length, fileName: r.data.fileName }, body, cancel: () => void body.cancel().catch(() => {}) };
}

/** An email's sanitized HTML as a stream, for the owner's page. Not for anything else: the action is cloud-only and owner-only. */
async function openEmailHtml(gmail: GmailService | null, p: { chatID: string; messageID: string }, ctx: RequestContext): Promise<DispatchResult> {
  const g = parseGmailChatID(p.chatID);
  if (!g) return fail("NOT_SUPPORTED", "Only email has HTML to show.");
  const s = gmail ? gmail.source(g.email) : null;
  if (!s) return fail("NOT_FOUND", "This email's account is not on this computer any more.");
  const r = await s.emailHtml(g.threadId, p.messageID, ctx);
  if (!r.ok) return { kind: "res", ok: false, error: r.error };
  const bytes = r.data;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      if (bytes.length) c.enqueue(bytes);
      c.close();
    },
  });
  return { kind: "media", head: { mimeType: "text/html", size: bytes.length }, body, cancel: () => void body.cancel().catch(() => {}) };
}

/** What the dispatcher needs of the noise judge (noise/judge.ts) for Settings > Noise. */
export type NoiseStatus = { keySet(): Promise<boolean>; readonly problem: Exclude<NoiseProblem, "no_key"> | null; definitionChanged(): void };

/** Every chat a result carries, with its noise mark. */
function decorated(name: ConnectorActionName, data: unknown, noise: NoiseStore, todo?: TodoTracker): unknown {
  const d = data as Record<string, any>;
  // A single Gmail thread (a read, a search) has only a hint of its tab, from any one message's label: a list asked by tab has said where it is, and that stands.
  const hinted = (c: ChatSummary) => (name === "read_chat" || name === "search_messages") && c.id.startsWith("gmail:");
  const dec = (c: ChatSummary) => {
    const marked = noise.decorate(c);
    if (!todo) return marked;
    if (!hinted(c)) return { ...marked, todo: todo.effective(marked) };
    const scope = marked.noise ? null : todo.store.scopeOf(c.id);
    return { ...marked, ...(scope ? { isLowPriority: scope.low } : {}), todo: todo.effective(marked, { hinted: true }) };
  };
  if (name === "list_chats" || name === "unread_summary") return { ...d, items: (d.items as ChatSummary[]).map(dec) };
  if (name === "read_chat") return { ...d, chat: dec(d.chat) };
  if (name === "search_messages") return { ...d, chats: Object.fromEntries(Object.entries(d.chats as Record<string, ChatSummary>).map(([k, c]) => [k, dec(c)])) };
  return data;
}

export function createDispatcher(o: {
  actions: BeeperActions;
  client: BeeperClient;
  assets: AssetAllowlist;
  gmail?: GmailService | null;
  idempotency?: IdempotencyCache<Outcome<unknown>>;
  drafts?: DraftStore;
  uploads?: UploadStore;
  noise?: NoiseStore;
  judge?: NoiseStatus;
  /** The To do tracker (todo/tracker.ts). Without one (tests): chats carry no flag, and set_todo keeps it in memory. */
  todo?: TodoTracker;
  /** The noise list of senders, with Gmail (noise/senders.ts). Without one (tests): over this dispatcher's accounts, with nothing in the background. */
  senders?: SenderRules;
  /** Connecting chat apps (chat-login.ts). Without one (tests): over this dispatcher's client, with no sign-in window on the Mac. */
  chatLogin?: ChatLogin;
  /** The inbox kept for sync (inbox/). Without one: sync_pull is NOT_SUPPORTED (and the hello does not say "sync.v1"). */
  inbox?: SyncHooks | null;
}) {
  // Without a file (tests): in memory.
  const drafts = o.drafts ?? new DraftStore();
  const uploads = o.uploads ?? new UploadStore({ draftAlive: (id) => drafts.has(id) });
  const noise = o.noise ?? new NoiseStore();
  const todo = o.todo ?? new TodoTracker({ store: new TodoStore() });
  const senders = o.senders ?? new SenderRules({ store: noise, sources: () => o.gmail?.sources() ?? [], known: (email) => !!o.gmail?.has(email), isOwn: isAnyOwnAddress });
  const chatLogin = o.chatLogin ?? createChatLogin({ client: o.client, windows: null });
  /** The chat_apps and chat_login_* actions: owner only (the cloud and the connector's link refuse agents), what is typed passes through to Beeper. */
  const login =
    <N extends "chat_apps" | "chat_login_start" | "chat_login_poll" | "chat_login_submit" | "chat_login_cancel">(name: N): Handler =>
    async (p, ctx) => {
      const r = await (chatLogin[name] as (p: unknown, ctx: RequestContext) => Promise<Outcome<unknown>>)(p, ctx);
      return r.ok ? checked(name, r.data) : { kind: "res", ok: false, error: r.error };
    };
  const router = createRouter({ beeper: o.actions, gmail: o.gmail ?? null, assets: o.assets, idempotency: o.idempotency, uploads, noise, todo });
  const checked = (name: ConnectorActionName, data: unknown): DispatchResult => {
    const r = parseActionResult(name, data);
    return r.ok ? { kind: "res", ok: true, data: r.value } : fail("INTERNAL", "The connector produced an invalid result.");
  };
  const via =
    (name: Exclude<ConnectorActionName, "get_media" | "get_email_html" | "discard_upload" | `draft_store_${string}` | `upload_store_${string}` | "get_noise_settings" | "set_noise_definition" | "set_noise" | "get_noise_senders" | "add_noise_sender" | "add_noise_sender_of_chat" | "remove_noise_sender" | "set_todo" | "sync_pull" | "get_older_unread" | "add_older_unread" | "chat_apps" | `chat_login_${string}`>): Handler =>
    async (p, ctx) => {
      const r = await (router[name] as (p: unknown, ctx: RequestContext) => Promise<{ ok: boolean; data?: unknown; error?: ErrorBody }>)(p, ctx);
      if (!r.ok) return { kind: "res", ok: false, error: r.error! };
      // Every chat that comes back is what To do knows about it: a list, a read and a search all count.
      o.todo?.seeResult(name, r.data, p);
      if (name === "archive") o.todo?.store.noteArchived(p.chatID, p.archived !== false);
      if (!noise.active() && !o.todo) return checked(name, r.data);
      // The page was fitted to a frame without the marks; in the rare case they push it over, it goes unmarked.
      const marked = decorated(name, r.data, noise, o.todo);
      return checked(name, marked !== r.data && !encodeFrame({ type: "res", id: "x".repeat(64), ok: true, data: marked } as never).ok ? r.data : marked);
    };
  const noiseSettings = async () => {
    const keySet = o.judge ? await o.judge.keySet() : false;
    return { definition: noise.definition, enabled: noise.judging(), keySet, problem: keySet ? (o.judge?.problem ?? null) : ("no_key" as const), noiseCount: noise.noiseCount(), decisions: noise.decisions() };
  };

  const handlers = {
    status: via("status"),
    list_chats: via("list_chats"),
    unread_summary: via("unread_summary"),
    read_chat: via("read_chat"),
    search_messages: via("search_messages"),
    draft_reply: via("draft_reply"),
    send_message: via("send_message"),
    react: via("react"),
    mark_read: via("mark_read"),
    archive: via("archive"),
    remove_account: via("remove_account"),
    compose_email: via("compose_email"),
    gmail_connect: via("gmail_connect"),
    draft_store_put: async (p: { requestId: string; chatID: string; instruction: string; deadline: string }) => {
      drafts.put(p);
      return checked("draft_store_put", { requestId: p.requestId, stored: true });
    },
    draft_store_get: async (p: { requestIds: string[] }) =>
      checked("draft_store_get", {
        items: drafts.get(p.requestIds).map((d) => {
          const a = drafts.attachmentOf(d.requestId);
          const info = a ? uploads.info(a) : null;
          return info ? { ...d, attachment: info } : d;
        }),
      }),
    draft_store_set_text: async (p: { requestId: string; text: string; attachmentId?: string; owner?: string }) => {
      const gone = "This draft request is not on this computer (it was handled or is older than 7 days).";
      if (!drafts.has(p.requestId) || !p.requestId.startsWith("drq_")) return fail("NOT_FOUND", gone);
      // Only the agent's own finished upload, and not one on another draft.
      if (p.attachmentId && !uploads.claim(p.attachmentId, p.owner!, p.requestId, drafts.createdAt(p.requestId) ?? Date.now())) return fail("NOT_FOUND", "That upload is not on this computer, not finished, or not yours. Upload the file again.");
      const before = drafts.attachmentOf(p.requestId);
      if (!drafts.setText(p.requestId, p.text, p.attachmentId)) return fail("NOT_FOUND", gone);
      if (before && before !== p.attachmentId) uploads.delete([before]);
      return checked("draft_store_set_text", { requestId: p.requestId, stored: true });
    },
    draft_store_delete: async (p: { requestIds: string[] }) => {
      // A draft's file goes with it.
      const files = drafts.attachmentsOf(p.requestIds);
      const deleted = drafts.delete(p.requestIds);
      uploads.delete(files);
      return checked("draft_store_delete", { deleted });
    },
    upload_store_begin: async (p: { uploadId: string; owner: string; fileName: string; mimeType: string; size: number }) => upload(() => (uploads.begin(p), checked("upload_store_begin", { uploadId: p.uploadId, stored: true }))),
    upload_store_chunk: async (p: { uploadId: string; owner: string; index: number; data: string }) => upload(() => checked("upload_store_chunk", { uploadId: p.uploadId, index: p.index, received: uploads.chunk(p).received })),
    upload_store_commit: async (p: { uploadId: string; owner: string }) => upload(() => checked("upload_store_commit", uploads.commit(p))),
    upload_store_delete: async (p: { uploadIds: string[] }) => checked("upload_store_delete", { deleted: uploads.delete(p.uploadIds) }),
    upload_store_read: async (p: { uploadId: string; owner: string }): Promise<DispatchResult> => {
      try {
        const f = uploads.open(p.uploadId, p.owner);
        return { kind: "media", head: { mimeType: f.info.mimeType, size: f.info.size, fileName: f.info.fileName }, body: f.body, cancel: f.cancel };
      } catch (e) {
        if (e instanceof UploadError) return { kind: "res", ok: false, error: e.body };
        throw e;
      }
    },
    get_email_html: (p: { chatID: string; messageID: string }, ctx) => openEmailHtml(o.gmail ?? null, p, ctx),
    discard_upload: async (p: { uploadId: string }) => checked("discard_upload", { uploadId: p.uploadId, deleted: uploads.discard(p.uploadId) }),
    get_noise_settings: async () => checked("get_noise_settings", await noiseSettings()),
    set_noise_definition: async (p: { definition: string }) => {
      noise.setDefinition(p.definition);
      o.judge?.definitionChanged();
      return checked("set_noise_definition", await noiseSettings());
    },
    set_noise: async (p: { chatID: string; noise: boolean }, ctx) => {
      // The conversation as it is now: its name for Recent decisions, and the example Jev learns from.
      const r = await router.read_chat({ chatID: p.chatID, limit: 5 }, ctx).catch(() => null);
      if (r && !r.ok && r.error.code === "NOT_FOUND") return { kind: "res", ok: false, error: r.error };
      const about = r?.ok ? { title: r.data.chat.title, network: r.data.chat.network, example: exampleOf(conversationOf(r.data).conversation) } : {};
      // Who it is from, as it is now: the one other sender in it, or none (noise/senders.ts).
      const sender = await senders.senderOfChat(p.chatID, ctx);
      noise.setOwner(p.chatID, p.noise, { ...about, ...(parseGmailChatID(p.chatID) && sender !== undefined ? { sender } : {}) });
      // Marked as noise by the owner's hand: handled. Only that way: Jev's verdict hides a chat, and leaves what the owner has not handled.
      if (p.noise) todo.setByOwner(p.chatID, false);
      // Learned with this mark: the page says so, with Undo (learning is never silent).
      const learned = senders.ownerMarked(p.chatID, sender !== undefined);
      return checked("set_noise", { chatID: p.chatID, noise: p.noise, ...(sender && learned.includes(sender) ? { learned: sender } : {}) });
    },
    get_noise_senders: async () => checked("get_noise_senders", { items: noise.senders() }),
    add_noise_sender: async (p: { entry: string }) => {
      const r = senders.add(p.entry);
      return r.ok ? checked("add_noise_sender", r.data) : { kind: "res", ok: false, error: r.error };
    },
    add_noise_sender_of_chat: async (p: { chatID: string }, ctx) => {
      const r = await senders.addOfChat(p.chatID, ctx);
      return r.ok ? checked("add_noise_sender_of_chat", r.data) : { kind: "res", ok: false, error: r.error };
    },
    remove_noise_sender: async (p: { entry: string; undo?: boolean }) => checked("remove_noise_sender", { entry: p.entry, removed: senders.remove(p.entry, { undo: p.undo }) }),
    // sync.v1 (task #57): inbox.db answers it. Without an inbox (it could not be opened) the hello does not say sync.v1, so the cloud does not ask.
    sync_pull: async (p: { epoch?: string | null; cursor?: number | null; page?: string }) => {
      if (!o.inbox) return fail("NOT_SUPPORTED", "This computer does not keep the inbox for sync.");
      const r = o.inbox.pull(p);
      return r.ok ? checked("sync_pull", r.data) : { kind: "res", ok: false, error: r.error };
    },
    set_todo: async (p: { chatID: string; todo: boolean; upTo?: string }) => {
      // Done with something newer than the owner's screen stays To do, and says so.
      const now = todo.setByOwner(p.chatID, p.todo, p.upTo !== undefined ? { upTo: Date.parse(p.upTo) } : {});
      return checked("set_todo", { chatID: p.chatID, todo: now });
    },
    get_older_unread: async (p: { source: "beeper" | "gmail" }) => checked("get_older_unread", { items: todo.olderUnread(p.source) }),
    add_older_unread: async (p: { source: string }) => checked("add_older_unread", { source: p.source, adding: todo.addOlder(p.source) }),
    chat_apps: login("chat_apps"),
    chat_login_start: login("chat_login_start"),
    chat_login_poll: login("chat_login_poll"),
    chat_login_submit: login("chat_login_submit"),
    chat_login_cancel: login("chat_login_cancel"),
    get_media: async (p: { url: string }, ctx) => {
      if (p.url.startsWith("gmail://")) return openGmailMedia(o.gmail ?? null, o.assets, p.url, ctx);
      const r = await openMedia(o.client, o.assets, p.url, ctx.signal);
      return r.ok ? { kind: "media", head: r.head, body: r.body, cancel: r.cancel } : { kind: "res", ok: false, error: r.error };
    },
  } satisfies Record<ConnectorActionName, Handler>;

  return {
    /** read_chat as Beeper and Gmail have it (no noise marks): what the noise judge reads. */
    readChat: (p: { chatID: string; limit: number; cursor?: string }, ctx: RequestContext): Promise<Outcome<ActionResult<"read_chat">>> => router.read_chat(p, ctx),
    isWrite: (action: string): boolean => !isActionName(action) || ACTIONS[action].write,
    async dispatch(action: string, raw: unknown, ctx: RequestContext = {}): Promise<DispatchResult> {
      if (!isActionName(action) || isCloudAction(action)) return fail("NOT_ALLOWED", "This action is not allowed.");
      const p = parseActionParams(action, raw);
      if (!p.ok) {
        const where = [...new Set(p.issues.map((i) => i.path.join(".") || "params"))].slice(0, 5).join(", ");
        return fail("BAD_PARAMS", `Invalid params for ${action} (${where}).`);
      }
      // The owner's action on a chat: inbox.db holds that chat's reads until it is done, then reads it with the opId.
      const chatID = o.inbox && CHAT_ACTIONS.has(action) ? (p.value as { chatID?: string }).chatID : undefined;
      const end = chatID ? o.inbox!.begin(chatID, ctx.opId) : null;
      let r: DispatchResult;
      try {
        r = await (handlers[action] as Handler)(p.value, ctx);
      } catch {
        r = fail("INTERNAL", "The connector failed while handling this request.");
      }
      const ok = r.kind === "res" && r.ok;
      const after: Promise<unknown>[] = [];
      if (end) after.push(end(ok));
      if (o.inbox && r.kind === "res" && r.ok && ACTIONS[action].write) after.push(o.inbox.caused(action, p.value as Record<string, unknown>, r.data, ctx.opId));
      const wait = ctx.deadline !== undefined ? Math.min(SYNC_WAIT_MS, ctx.deadline - Date.now() - SYNC_WAIT_MARGIN_MS) : SYNC_WAIT_MS;
      if (ctx.opId && after.length && wait > 0) await atMost(Promise.all(after), wait);
      else for (const x of after) x.catch(() => {});
      return r;
    },
  };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
