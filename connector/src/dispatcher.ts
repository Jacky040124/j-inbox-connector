// The connector's whitelist. A request names a catalogue action; params are validated (and
// defaulted) with parseActionParams; the action calls only its own Beeper endpoints; the result is
// checked with parseActionResult before it may leave the Mac. Anything else (the cloud's own
// actions included: the snooze store and the draft requests live in the cloud) is NOT_ALLOWED.
// The draft_store_* actions never reach Beeper: they keep draft texts in this computer's draft store;
// the upload_store_* actions and discard_upload keep files being sent in its upload store; the noise
// actions keep the owner's definition and verdicts in its noise store. Chats in every result carry
// their noise mark (noise/store.ts decorate).
import {
  ACTIONS,
  encodeFrame,
  isActionName,
  isCloudAction,
  makeError,
  parseActionParams,
  parseActionResult,
  parseGmailAssetURL,
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
import { conversationOf, exampleOf } from "./noise/jev.ts";

export type DispatchResult =
  | { kind: "res"; ok: true; data: unknown; error?: undefined }
  | { kind: "res"; ok: false; error: ErrorBody; data?: undefined }
  | { kind: "media"; head: MediaHead; body: ReadableStream<Uint8Array>; cancel(): void };

type Handler = (p: any, ctx: RequestContext) => Promise<DispatchResult>;

const fail = (code: ErrorBody["code"], message: string): DispatchResult => ({ kind: "res", ok: false, error: makeError(code, message) });

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

/** What the dispatcher needs of the noise judge (noise/judge.ts) for Settings > Noise. */
export type NoiseStatus = { keySet(): Promise<boolean>; readonly problem: Exclude<NoiseProblem, "no_key"> | null; definitionChanged(): void };

/** Every chat a result carries, with its noise mark. */
function decorated(name: ConnectorActionName, data: unknown, noise: NoiseStore): unknown {
  const d = data as Record<string, any>;
  const dec = (c: ChatSummary) => noise.decorate(c);
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
}) {
  // Without a file (tests): in memory.
  const drafts = o.drafts ?? new DraftStore();
  const uploads = o.uploads ?? new UploadStore({ draftAlive: (id) => drafts.has(id) });
  const noise = o.noise ?? new NoiseStore();
  const router = createRouter({ beeper: o.actions, gmail: o.gmail ?? null, assets: o.assets, idempotency: o.idempotency, uploads, noise });
  const checked = (name: ConnectorActionName, data: unknown): DispatchResult => {
    const r = parseActionResult(name, data);
    return r.ok ? { kind: "res", ok: true, data: r.value } : fail("INTERNAL", "The connector produced an invalid result.");
  };
  const via =
    (name: Exclude<ConnectorActionName, "get_media" | "discard_upload" | `draft_store_${string}` | `upload_store_${string}` | "get_noise_settings" | "set_noise_definition" | "set_noise">): Handler =>
    async (p, ctx) => {
      const r = await (router[name] as (p: unknown, ctx: RequestContext) => Promise<{ ok: boolean; data?: unknown; error?: ErrorBody }>)(p, ctx);
      if (!r.ok) return { kind: "res", ok: false, error: r.error! };
      if (!noise.active()) return checked(name, r.data);
      // The page was fitted to a frame without the marks; in the rare case they push it over, it goes unmarked.
      const marked = decorated(name, r.data, noise);
      return checked(name, marked !== r.data && !encodeFrame({ type: "res", id: "x".repeat(64), ok: true, data: marked } as never).ok ? r.data : marked);
    };
  const noiseSettings = async () => {
    const keySet = o.judge ? await o.judge.keySet() : false;
    return { definition: noise.definition, enabled: noise.active(), keySet, problem: keySet ? (o.judge?.problem ?? null) : ("no_key" as const), noiseCount: noise.noiseCount(), decisions: noise.decisions() };
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
      noise.setOwner(p.chatID, p.noise, about);
      return checked("set_noise", { chatID: p.chatID, noise: p.noise });
    },
    get_media: async (p: { url: string }, ctx) => {
      if (p.url.startsWith("gmail://")) return openGmailMedia(o.gmail ?? null, o.assets, p.url, ctx);
      const r = await openMedia(o.client, o.assets, p.url, ctx.signal);
      return r.ok ? { kind: "media", head: r.head, body: r.body, cancel: r.cancel } : { kind: "res", ok: false, error: r.error };
    },
  } satisfies Record<ConnectorActionName, Handler>;

  return {
    /** read_chat as Beeper and Gmail have it (no noise marks): what the noise judge reads. */
    readChat: (p: { chatID: string; limit: number }, ctx: RequestContext): Promise<Outcome<ActionResult<"read_chat">>> => router.read_chat(p, ctx),
    isWrite: (action: string): boolean => !isActionName(action) || ACTIONS[action].write,
    async dispatch(action: string, raw: unknown, ctx: RequestContext = {}): Promise<DispatchResult> {
      if (!isActionName(action) || isCloudAction(action)) return fail("NOT_ALLOWED", "This action is not allowed.");
      const p = parseActionParams(action, raw);
      if (!p.ok) {
        const where = [...new Set(p.issues.map((i) => i.path.join(".") || "params"))].slice(0, 5).join(", ");
        return fail("BAD_PARAMS", `Invalid params for ${action} (${where}).`);
      }
      try {
        return await (handlers[action] as Handler)(p.value, ctx);
      } catch {
        return fail("INTERNAL", "The connector failed while handling this request.");
      }
    },
  };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
