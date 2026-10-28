// The connector's whitelist. A request names a catalogue action; params are validated (and
// defaulted) with parseActionParams; the action calls only its own Beeper endpoints; the result is
// checked with parseActionResult before it may leave the Mac. Anything else (the cloud's own
// actions included: the snooze store and the draft requests live in the cloud) is NOT_ALLOWED.
// The draft_store_* actions never reach Beeper: they keep draft texts in this computer's draft store.
import { ACTIONS, isActionName, isCloudAction, makeError, parseActionParams, parseActionResult, parseGmailAssetURL, type ConnectorActionName, type ErrorBody, type MediaHead } from "@j-inbox/protocol";
import type { BeeperClient } from "./beeper-client.ts";
import type { AssetAllowlist } from "./assets.ts";
import type { BeeperActions, Outcome, RequestContext } from "./actions.ts";
import type { IdempotencyCache } from "./idempotency.ts";
import { openMedia } from "./media.ts";
import { createRouter } from "./sources.ts";
import type { GmailService } from "./gmail/service.ts";
import { DraftStore } from "./drafts.ts";

export type DispatchResult =
  | { kind: "res"; ok: true; data: unknown; error?: undefined }
  | { kind: "res"; ok: false; error: ErrorBody; data?: undefined }
  | { kind: "media"; head: MediaHead; body: ReadableStream<Uint8Array>; cancel(): void };

type Handler = (p: any, ctx: RequestContext) => Promise<DispatchResult>;

const fail = (code: ErrorBody["code"], message: string): DispatchResult => ({ kind: "res", ok: false, error: makeError(code, message) });

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

export function createDispatcher(o: { actions: BeeperActions; client: BeeperClient; assets: AssetAllowlist; gmail?: GmailService | null; idempotency?: IdempotencyCache<Outcome<unknown>>; drafts?: DraftStore }) {
  const router = createRouter({ beeper: o.actions, gmail: o.gmail ?? null, assets: o.assets, idempotency: o.idempotency });
  // Without a file (tests): in memory.
  const drafts = o.drafts ?? new DraftStore();
  const checked = (name: ConnectorActionName, data: unknown): DispatchResult => {
    const r = parseActionResult(name, data);
    return r.ok ? { kind: "res", ok: true, data: r.value } : fail("INTERNAL", "The connector produced an invalid result.");
  };
  const via =
    (name: Exclude<ConnectorActionName, "get_media" | `draft_store_${string}`>): Handler =>
    async (p, ctx) => {
      const r = await (router[name] as (p: unknown, ctx: RequestContext) => Promise<{ ok: boolean; data?: unknown; error?: ErrorBody }>)(p, ctx);
      if (!r.ok) return { kind: "res", ok: false, error: r.error! };
      return checked(name, r.data);
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
    draft_store_get: async (p: { requestIds: string[] }) => checked("draft_store_get", { items: drafts.get(p.requestIds) }),
    draft_store_set_text: async (p: { requestId: string; text: string }) =>
      drafts.setText(p.requestId, p.text) ? checked("draft_store_set_text", { requestId: p.requestId, stored: true }) : fail("NOT_FOUND", "This draft request is not on this computer (it was handled or is older than 7 days)."),
    draft_store_delete: async (p: { requestIds: string[] }) => checked("draft_store_delete", { deleted: drafts.delete(p.requestIds) }),
    get_media: async (p: { url: string }, ctx) => {
      if (p.url.startsWith("gmail://")) return openGmailMedia(o.gmail ?? null, o.assets, p.url, ctx);
      const r = await openMedia(o.client, o.assets, p.url, ctx.signal);
      return r.ok ? { kind: "media", head: r.head, body: r.body, cancel: r.cancel } : { kind: "res", ok: false, error: r.error };
    },
  } satisfies Record<ConnectorActionName, Handler>;

  return {
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
