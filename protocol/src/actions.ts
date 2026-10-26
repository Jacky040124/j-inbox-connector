// The ACTION catalogue: the single list of things anyone may ask the connector to do.
// Used by the connector whitelist, the Raft agent manifest and the web API.
import {
  array,
  assetUrl,
  boolean,
  cursor,
  enumOf,
  integer,
  isoDateTime,
  literal,
  nullable,
  object,
  optional,
  parse,
  record,
  string,
  text,
  type Infer,
  type InferShape,
  type ObjectSchema,
  type Result,
  type Schema,
} from "./schema.ts";
import {
  MAX_ACCOUNTS,
  MAX_CURSOR_LENGTH,
  MAX_FILTER_IDS,
  MAX_PAGE_LIMIT,
  MAX_QUERY_LENGTH,
  MAX_REACTION_KEY_LENGTH,
  MAX_SEARCH_LIMIT,
  MAX_SEND_TEXT_LENGTH,
  MEDIA_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
} from "./limits.ts";
import {
  accountID,
  accountList,
  beeperHealth,
  chatID,
  chatSummary,
  emailRecipient,
  mediaHead,
  messageID,
  messageItem,
  networkName,
  versionString,
} from "./model.ts";
import { errorBody } from "./error-schema.ts";
import { oauthToken } from "./gmail.ts";


type Shape = Record<string, Schema<any>>;

export interface ActionDef<P extends Shape, R> {
  readonly description: string;
  readonly params: ObjectSchema<P>;
  readonly paramDocs: { readonly [K in keyof P]: string };
  /** Applied by parseActionParams when a param is absent. */
  readonly defaults: Partial<InferShape<P>>;
  readonly result: Schema<R>;
  /** Changes state in Beeper or is visible to others. */
  readonly write: boolean;
  /** Agents must get the owner's approval before this runs. Humans in the web UI do not. */
  readonly needsApprovalForAgents: boolean;
  /** Only the owner in the web page may run it: never in the agent manifest, refused for agents. */
  readonly humanOnly?: boolean;
  /** Only the cloud itself sends it to the connector (never from the web API or agents). Implies humanOnly. */
  readonly cloudOnly?: boolean;
  /** Result is sent as `res` (metadata) followed by `chunk` frames. */
  readonly streamed: boolean;
  readonly timeoutMs: number;
  /** Per-agent cap enforced by the cloud, if any (the owner's own requests use only the overall human budget). */
  readonly rateLimitPerMinute?: number;
  /** The Beeper Client API endpoint(s) the connector calls. */
  readonly beeper: string;
}

function define<P extends Shape, R>(def: ActionDef<P, R>): ActionDef<P, R> {
  return def;
}

const limit = (max: number) => integer({ min: 1, max });
const pageCursor = cursor(MAX_CURSOR_LENGTH);
const query = text({ min: 1, max: MAX_QUERY_LENGTH });
const idList = <T>(s: Schema<T>) => array(s, { min: 1, max: MAX_FILTER_IDS });
const sendText = text({ min: 1, max: MAX_SEND_TEXT_LENGTH });
const page = <T>(item: Schema<T>, max: number) => ({ items: array(item, { max }), hasMore: boolean(), nextCursor: nullable(pageCursor) });
/** Client-chosen key for a write. Reuse the same key when retrying; the connector then replays the first result instead of acting twice. */
export const idempotencyKey = string({ min: 8, max: 64, pattern: /^[A-Za-z0-9_-]+$/, format: "idempotency-key" });
/**
 * The cloud forwards scopeIdempotencyKey(caller, key) instead of the caller's own key, so two
 * callers (two agents, or an agent and the owner) that pick the same key never share a result.
 */
export async function scopeIdempotencyKey(caller: { type: "human" | "agent"; sub: string }, key: string): Promise<string> {
  if (!parse(idempotencyKey, key).ok) throw new Error("invalid idempotencyKey");
  if (!caller || (caller.type !== "human" && caller.type !== "agent") || typeof caller.sub !== "string" || caller.sub.length < 1 || caller.sub.length > 128) throw new Error("invalid caller");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${caller.type}\u0000${caller.sub}\u0000${key}`)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return "s_" + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/**
 * A source (Beeper, or one Gmail account) that failed while the others answered: list_chats,
 * unread_summary and search_messages over several sources return what they have and name the
 * failed ones here (e.g. a Gmail account that needs reconnecting), instead of failing as a whole.
 */
export const failedSource = object({ source: enumOf(["beeper", "gmail"] as const), accountID: optional(accountID), error: errorBody });
const failedSources = optional(array(failedSource, { max: MAX_ACCOUNTS + 1 }));
const recipients = (min: number) => array(emailRecipient, { min, max: 50 });

const IDEMPOTENCY_DOC = "Optional key (8-64 of A-Z a-z 0-9 _ -). Send the same key when you retry after TIMEOUT or UNKNOWN_OUTCOME so it is not done twice";
const ARRAY_DOC = " (JSON array: pass it with --data-json, raft --param is text-only)";

export const ACTIONS = {
  status: define({
    description: "Is the owner's computer online, is Beeper healthy, and which chat networks are connected (use networks, not accounts, for the platform list).",
    params: object({}),
    paramDocs: {},
    defaults: {},
    result: object({
      online: boolean(),
      lastSeenAt: nullable(isoDateTime()),
      connectorVersion: nullable(versionString),
      beeper: nullable(beeperHealth),
      accounts: accountList,
      /**
       * Chat networks the owner can use, e.g. ["iMessage", "Twitter/X", "WhatsApp"]. Built from the
       * accounts plus the networks on recent chats (by accountID): GET /v1/accounts has no
       * iMessage account and names some networks differently ("X" vs "Twitter/X").
       */
      networks: optional(array(networkName, { max: 50 })),
    }),
    write: false,
    needsApprovalForAgents: false,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "GET /v1/info, GET /v1/accounts, GET /v1/chats (first page, for networks)",
  }),

  list_chats: define({
    description:
      "List chats across all networks (Gmail threads too, network Gmail), most recent first. Filter by network, unread, pinned, inbox or a search query. Page with cursor. If one source fails (e.g. a Gmail account needs reconnecting) the others still answer and failedSources names it.",
    params: object({
      network: optional(networkName),
      accountIDs: optional(idList(accountID)),
      unreadOnly: optional(boolean()),
      pinnedOnly: optional(boolean()),
      inbox: optional(enumOf(["primary", "low-priority", "archive"] as const)),
      type: optional(enumOf(["single", "group", "any"] as const)),
      query: optional(query),
      limit: optional(limit(MAX_PAGE_LIMIT)),
      cursor: optional(pageCursor),
    }),
    paramDocs: {
      network: "Chat network name as shown on chats, e.g. WhatsApp, Instagram, LinkedIn, Twitter/X, iMessage, Gmail (case-insensitive)",
      accountIDs: "Only these account IDs (from a chat's accountID; Gmail accounts are gmail:<address>)" + ARRAY_DOC,
      unreadOnly: "Only chats with unread messages (all inboxes, including archived and low priority, unless inbox is set)",
      pinnedOnly: "Only pinned chats",
      inbox: "primary, low-priority or archive (default: all)",
      type: "single, group or any",
      query: "Words that must appear in the chat title or network (email: in the subject)",
      limit: `Chats per page, 1-${MAX_PAGE_LIMIT} (default 25)`,
      cursor: "nextCursor from the previous page",
    },
    defaults: { limit: 25 },
    result: object({ ...page(chatSummary, MAX_PAGE_LIMIT), failedSources }),
    write: false,
    needsApprovalForAgents: false,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    // Beeper has no network or pinned filter, and account network names differ from chat network
    // names. The connector walks Beeper pages and filters itself (protocol README "Filtered paging").
    beeper: "GET /v1/chats or GET /v1/chats/search (query/inbox/type/unreadOnly), then connector-side filter on network/pinnedOnly with a wrapped cursor",
  }),

  unread_summary: define({
    description: "Every chat in the main inbox with unread messages (not archived, not low priority): who, which network, how many, and the latest message.",
    params: object({ limit: optional(limit(MAX_PAGE_LIMIT)) }),
    paramDocs: { limit: `Most chats to include, 1-${MAX_PAGE_LIMIT} (default 50)` },
    defaults: { limit: 50 },
    result: object({
      totalUnreadChats: integer({ min: 0, max: 1_000_000_000 }),
      totalUnreadMessages: integer({ min: 0, max: 1_000_000_000 }),
      items: array(chatSummary, { max: MAX_PAGE_LIMIT }),
      truncated: boolean(),
      failedSources,
    }),
    write: false,
    needsApprovalForAgents: false,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    // /v1/chats/search returns Chat without preview; /v1/chats returns ChatWithPreview.
    beeper: "GET /v1/chats (ChatWithPreview, cursor+direction=before), connector keeps unreadCount>0 or isMarkedUnread, and drops archived and low-priority chats (like Beeper's inbox)",
  }),

  read_chat: define({
    description: "Read one chat: its details and messages in time order (oldest first). Use nextCursor to page further back in history.",
    params: object({ chatID, cursor: optional(pageCursor), limit: optional(limit(MAX_PAGE_LIMIT)) }),
    paramDocs: {
      chatID: "Chat ID from list_chats or unread_summary",
      cursor: "nextCursor from the previous call, to load older messages",
      limit: `Messages per page, 1-${MAX_PAGE_LIMIT} (default 30)`,
    },
    defaults: { limit: 30 },
    result: object({ chat: chatSummary, ...page(messageItem, MAX_PAGE_LIMIT) }),
    write: false,
    needsApprovalForAgents: false,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "GET /v1/chats/{chatID}, GET /v1/chats/{chatID}/messages?cursor&direction=before",
  }),

  search_messages: define({
    description: "Search messages across all networks by literal words. For Gmail the query uses Gmail search syntax (from:, subject:, has:attachment ...).",
    params: object({
      query,
      chatIDs: optional(idList(chatID)),
      accountIDs: optional(idList(accountID)),
      network: optional(networkName),
      sender: optional(enumOf(["me", "others"] as const)),
      dateAfter: optional(isoDateTime()),
      dateBefore: optional(isoDateTime()),
      limit: optional(limit(MAX_SEARCH_LIMIT)),
      cursor: optional(pageCursor),
    }),
    paramDocs: {
      query: "Words to find (all must match, any order)",
      chatIDs: "Only search these chats" + ARRAY_DOC,
      accountIDs: "Only search these accounts" + ARRAY_DOC,
      network: "Only search this network",
      sender: "me or others",
      dateAfter: "Only messages after this ISO 8601 time",
      dateBefore: "Only messages before this ISO 8601 time",
      limit: `Results per page, 1-${MAX_SEARCH_LIMIT} (default 20)`,
      cursor: "nextCursor from the previous page",
    },
    defaults: { limit: MAX_SEARCH_LIMIT },
    result: object({ ...page(messageItem, MAX_SEARCH_LIMIT), chats: record(chatID, chatSummary, { max: MAX_SEARCH_LIMIT }), failedSources }),
    write: false,
    needsApprovalForAgents: false,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "GET /v1/messages/search",
  }),

  draft_reply: define({
    description:
      "Put a draft into a chat's input box without sending it (Gmail: a reply-all draft in the thread). The owner decides whether to send. Never replaces an existing draft (the owner may be typing): fails with CONFLICT if the chat already has one.",
    params: object({ chatID, text: sendText }),
    paramDocs: { chatID: "Chat ID", text: "Draft text (plain text or Markdown)" },
    defaults: {},
    result: object({ chatID, draftSet: literal(true) }),
    write: true,
    needsApprovalForAgents: false,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "GET /v1/chats/{chatID} (draft must be empty, else CONFLICT), PATCH /v1/chats/{chatID} {draft:{text}}; Beeper 409/422 -> CONFLICT",
  }),

  send_message: define({
    description: "Send a text message, optionally as a reply. In a Gmail chat this is a plain-text reply-all in the thread. Agents need the owner's approval.",
    params: object({ chatID, text: sendText, replyToMessageID: optional(messageID), idempotencyKey: optional(idempotencyKey) }),
    paramDocs: { chatID: "Chat ID", text: "Message text (plain text or Markdown)", replyToMessageID: "Message ID to reply to", idempotencyKey: IDEMPOTENCY_DOC },
    defaults: {},
    result: object({ chatID, pendingMessageID: messageID }),
    write: true,
    needsApprovalForAgents: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 10,
    beeper: "POST /v1/chats/{chatID}/messages",
  }),

  react: define({
    description: "Add an emoji reaction to a message (not for Gmail: NOT_SUPPORTED). Agents need the owner's approval.",
    params: object({ chatID, messageID, reactionKey: string({ min: 1, max: MAX_REACTION_KEY_LENGTH }), idempotencyKey: optional(idempotencyKey) }),
    paramDocs: { chatID: "Chat ID", messageID: "Message ID", reactionKey: "Emoji, e.g. 👍", idempotencyKey: IDEMPOTENCY_DOC },
    defaults: {},
    result: object({ chatID, messageID, reactionKey: string({ min: 1, max: MAX_REACTION_KEY_LENGTH }) }),
    write: true,
    needsApprovalForAgents: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 30,
    beeper: "POST /v1/chats/{chatID}/messages/{messageID}/reactions",
  }),

  mark_read: define({
    description: "Mark a chat read (or unread with read=false). Agents need the owner's approval.",
    params: object({ chatID, messageID: optional(messageID), read: optional(boolean()) }),
    paramDocs: { chatID: "Chat ID", messageID: "Mark read up to this message (default: all)", read: "false to mark unread instead (default true)" },
    defaults: { read: true },
    result: object({ chatID, read: boolean() }),
    write: true,
    needsApprovalForAgents: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 60,
    beeper: "POST /v1/chats/{chatID}/read or /unread",
  }),

  archive: define({
    description: "Archive a chat (or unarchive with archived=false). Agents need the owner's approval.",
    params: object({ chatID, archived: optional(boolean()) }),
    paramDocs: { chatID: "Chat ID", archived: "false to unarchive (default true)" },
    defaults: { archived: true },
    result: object({ chatID, archived: boolean() }),
    write: true,
    needsApprovalForAgents: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 60,
    beeper: "POST /v1/chats/{chatID}/archive",
  }),

  remove_account: define({
    description: "Remove a chat account (sign Beeper out of that network; for Gmail: revoke J-Inbox's access at Google and forget the account). Owner only, from the web page.",
    params: object({ accountID }),
    paramDocs: { accountID: "accountID from status.accounts (removable ones only)" },
    defaults: {},
    result: object({ accountID, removed: literal(true), scope: enumOf(["current-device", "all-devices"] as const), affectedAccountIDs: array(accountID, { max: MAX_ACCOUNTS }) }),
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 10,
    beeper: "GET /v1/accounts/{accountID}, GET /v1/bridges/{bridgeID}/logins/{loginID}, POST /v1/bridges/{bridgeID}/logins/{loginID}/remove",
  }),

  compose_email: define({
    description: "Write a new email (a new thread) from one of the owner's Gmail accounts, plain text. Agents need the owner's approval.",
    params: object({
      accountID,
      to: recipients(1),
      cc: optional(recipients(0)),
      subject: string({ min: 0, max: 500 }),
      text: sendText,
      idempotencyKey: optional(idempotencyKey),
    }),
    paramDocs: {
      accountID: "The Gmail account to send from: gmail:<address> (from status.accounts)",
      to: "Recipient addresses, 1-50" + ARRAY_DOC,
      cc: "Cc addresses, up to 50" + ARRAY_DOC,
      subject: "Subject line (may be empty)",
      text: "Body, plain text",
      idempotencyKey: IDEMPOTENCY_DOC,
    },
    defaults: {},
    result: object({ accountID, chatID, pendingMessageID: messageID }),
    write: true,
    needsApprovalForAgents: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 10,
    beeper: "none (Gmail users.messages.send)",
  }),

  gmail_connect: define({
    description: "Internal: the cloud hands a newly added Gmail account to the owner's connector once, right after Sign in with Google. Never from the web API or agents.",
    params: object({ email: emailRecipient, refreshToken: oauthToken }),
    paramDocs: { email: "The Google account address from the id_token", refreshToken: "The refresh token (the connector keeps it in the Keychain)" },
    defaults: {},
    result: object({ accountID, connected: literal(true) }),
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloudOnly: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 10,
    beeper: "none (Gmail users.getProfile to verify, then the Keychain)",
  }),

  get_media: define({
    description: "Download an image or file from a message (attachment url or chat avatarURL; email attachments too).",
    params: object({ url: assetUrl() }),
    paramDocs: { url: "An attachment url or avatarURL returned by another action" },
    defaults: {},
    result: mediaHead,
    write: false,
    needsApprovalForAgents: false,
    streamed: true,
    timeoutMs: MEDIA_TIMEOUT_MS,
    beeper: "GET /v1/assets/serve?url=",
  }),
} as const;

export type Actions = typeof ACTIONS;
export type ActionName = keyof Actions;
export type ActionParams<A extends ActionName> = Infer<Actions[A]["params"]>;
export type ActionResult<A extends ActionName> = Infer<Actions[A]["result"]>;

export const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS) as ActionName[]);

export function isActionName(v: unknown): v is ActionName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ACTIONS, v);
}

/** Validate params for an action (strict) and fill defaults. */
export function parseActionParams<A extends ActionName>(name: A, raw: unknown): Result<ActionParams<A>> {
  if (!isActionName(name)) return { ok: false, issues: [{ path: [], message: "unknown action" }] };
  const def = ACTIONS[name] as unknown as ActionDef<Shape, unknown>;
  const r = parse(def.params, raw);
  if (!r.ok) return r;
  // Validate again after merging so a bad default can never reach the connector.
  const merged = parse(def.params, { ...def.defaults, ...r.value });
  if (!merged.ok) return merged;
  return { ok: true, value: merged.value as ActionParams<A> };
}

export function parseActionResult<A extends ActionName>(name: A, raw: unknown): Result<ActionResult<A>> {
  if (!isActionName(name)) return { ok: false, issues: [{ path: [], message: "unknown action" }] };
  return parse(ACTIONS[name].result as Schema<ActionResult<A>>, raw);
}

const INT_RE = /^-?(0|[1-9]\d{0,15})$/;

/**
 * `raft integration invoke --param k=v` sends every value as a string. Convert strings
 * to the declared boolean/integer/array type; anything unconvertible is left as-is so
 * strict validation rejects it afterwards.
 */
export function coerceAgentParams(name: ActionName, raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  const shape: Record<string, Schema<unknown>> = isActionName(name) ? (ACTIONS[name].params.shape as Record<string, Schema<unknown>>) : {};
  for (const key of Object.keys(raw)) {
    const v = (raw as Record<string, unknown>)[key];
    const meta = Object.prototype.hasOwnProperty.call(shape, key) ? shape[key]!.meta : undefined;
    let next = v;
    if (typeof v === "string" && meta) {
      if (meta.type === "boolean") next = v === "true" ? true : v === "false" ? false : v;
      else if (meta.type === "integer") next = INT_RE.test(v) ? Number(v) : v;
      else if (meta.type === "array" && v.startsWith("[")) {
        try {
          next = JSON.parse(v);
        } catch {
          next = v;
        }
      }
    }
    Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
