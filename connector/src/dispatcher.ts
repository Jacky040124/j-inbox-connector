// The connector's whitelist. A request names a catalogue action; params are validated (and
// defaulted) with parseActionParams; the action calls only its own Beeper endpoints; the result is
// checked with parseActionResult before it may leave the Mac. Anything else is NOT_ALLOWED.
import { ACTIONS, isActionName, makeError, parseActionParams, parseActionResult, type ActionName, type ErrorBody, type MediaHead } from "@j-inbox/protocol";
import type { BeeperClient } from "./beeper-client.ts";
import type { AssetAllowlist } from "./assets.ts";
import type { RequestContext, createActions } from "./actions.ts";
import { openMedia } from "./media.ts";

export type DispatchResult =
  | { kind: "res"; ok: true; data: unknown; error?: undefined }
  | { kind: "res"; ok: false; error: ErrorBody; data?: undefined }
  | { kind: "media"; head: MediaHead; body: ReadableStream<Uint8Array>; cancel(): void };

type Actions = ReturnType<typeof createActions>;
type Handler = (p: any, ctx: RequestContext) => Promise<DispatchResult>;

const fail = (code: ErrorBody["code"], message: string): DispatchResult => ({ kind: "res", ok: false, error: makeError(code, message) });

export function createDispatcher(o: { actions: Actions; client: BeeperClient; assets: AssetAllowlist }) {
  const via =
    (name: Exclude<ActionName, "get_media">): Handler =>
    async (p, ctx) => {
      const r = await (o.actions[name] as (p: unknown, ctx: RequestContext) => Promise<{ ok: boolean; data?: unknown; error?: ErrorBody }>)(p, ctx);
      if (!r.ok) return { kind: "res", ok: false, error: r.error! };
      const checked = parseActionResult(name, r.data);
      return checked.ok ? { kind: "res", ok: true, data: checked.value } : fail("INTERNAL", "The connector produced an invalid result.");
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
    get_media: async (p: { url: string }, ctx) => {
      const r = await openMedia(o.client, o.assets, p.url, ctx.signal);
      return r.ok ? { kind: "media", head: r.head, body: r.body, cancel: r.cancel } : { kind: "res", ok: false, error: r.error };
    },
  } satisfies Record<ActionName, Handler>;

  return {
    isWrite: (action: string): boolean => !isActionName(action) || ACTIONS[action].write,
    async dispatch(action: string, raw: unknown, ctx: RequestContext = {}): Promise<DispatchResult> {
      if (!isActionName(action)) return fail("NOT_ALLOWED", "This action is not allowed.");
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
