// The ACTION catalogue: the single list of things anyone may ask J-Inbox to do. Used by the
// connector whitelist, the Raft agent manifest and the web API. A few (`cloud: true`, the snooze
// store and the draft requests) are answered by the cloud room itself and never sent to the
// connector as such.
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
  mimeType,
  networkName,
  versionString,
} from "./model.ts";
import { errorBody } from "./error-schema.ts";
import { oauthToken } from "./gmail.ts";
import { MAX_SNOOZES, snoozeItem } from "./snooze.ts";
import {
  MAX_ACTIVE_DRAFTS,
  MAX_DRAFT_AGENTS,
  MAX_DRAFT_READ,
  draftInstruction,
  draftRequestID,
  draftText,
  draftView,
  raftAgentID,
  raftAgentsResult,
  storedDraft,
  storedRequestID,
} from "./drafts.ts";
import { MAX_RECENT_CHANNELS, MAX_SHOWN_DELEGATIONS, delegationInstruction, delegationRequestID, delegationView, raftChannel } from "./delegations.ts";
import { MAX_STORED_UPLOADS, MAX_UPLOAD_BYTES, MAX_UPLOAD_CHUNKS, fileName, uploadChunkData, uploadID, uploadInfo, uploadOwner } from "./uploads.ts";


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
  /**
   * Answered by the cloud room itself (the snooze store, draft requests), never sent to the
   * connector in a `req` (not in CONNECTOR_ACTION_NAMES). Its effects on the owner's computer run
   * as ordinary connector actions (archive, mark_read, read_chat, draft_store_*).
   */
  readonly cloud?: boolean;
  /** Result is sent as `res` (metadata) followed by `chunk` frames. */
  readonly streamed: boolean;
  readonly timeoutMs: number;
  /** Per-agent cap enforced by the cloud, if any (the owner's own requests use only the overall human budget). */
  readonly rateLimitPerMinute?: number;
  /** The Beeper Client API endpoint(s) the connector calls. */
  readonly beeper: string;
  /** A check across params (e.g. text or a file), run by parseActionParams: an error message or null. */
  readonly check?: (p: InferShape<P>) => string | null;
}

function define<P extends Shape, R, const C extends boolean | undefined = undefined>(def: ActionDef<P, R> & { cloud?: C }): ActionDef<P, R> & (C extends true ? { readonly cloud: true } : {}) {
  return def as ActionDef<P, R> & (C extends true ? { readonly cloud: true } : {});
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

/** send_message and compose_email: a text, a file, or both. */
const textOrFile = (p: { text?: string; attachmentId?: string }) => (p.text === undefined && p.attachmentId === undefined ? "text is required (or attachmentId)" : null);
const ATTACHMENT_DOC = `One file to send with it: the uploadId of a finished upload (at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB). Owner only, from the J-Inbox web page; agents attach files to a draft instead (draft_reply attachmentId)`;

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
      "Draft a reply without sending it. For agents it becomes a J-Inbox draft card in that chat (Send / Edit / Discard for the owner, the chat goes to Unread); nothing is written into Beeper or Gmail. If the owner asked you for this chat's draft, it answers that request. To attach one file, upload it first (upload_file, or upload_begin / upload_chunk / upload_commit) and pass its uploadId as attachmentId. Fails with CONFLICT while the chat has an open draft from someone else. The owner decides whether to send.",
    params: object({ chatID, text: sendText, attachmentId: optional(uploadID) }),
    paramDocs: {
      chatID: "Chat ID",
      text: "Draft text (plain text or Markdown)",
      attachmentId: "Optional: one file for the owner to send with the draft, the uploadId from upload_file or upload_commit (your own upload). Kept on the owner's computer with the draft",
    },
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
    params: object({ chatID, text: optional(sendText), replyToMessageID: optional(messageID), idempotencyKey: optional(idempotencyKey), attachmentId: optional(uploadID) }),
    paramDocs: {
      chatID: "Chat ID",
      text: "Message text (plain text or Markdown); may be left out when attachmentId is given",
      replyToMessageID: "Message ID to reply to",
      idempotencyKey: IDEMPOTENCY_DOC,
      attachmentId: ATTACHMENT_DOC,
    },
    defaults: {},
    result: object({ chatID, pendingMessageID: messageID }),
    write: true,
    needsApprovalForAgents: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 10,
    beeper: "POST /v1/chats/{chatID}/messages; with attachmentId first POST /v1/assets/upload (multipart), then the message with attachment {uploadID, fileName, mimeType}",
    check: textOrFile,
  }),

  react: define({
    description: "Add an emoji reaction to a message, or take back the owner's own with remove=true (not for Gmail: NOT_SUPPORTED). Agents need the owner's approval.",
    params: object({ chatID, messageID, reactionKey: string({ min: 1, max: MAX_REACTION_KEY_LENGTH }), remove: optional(boolean()), idempotencyKey: optional(idempotencyKey) }),
    paramDocs: { chatID: "Chat ID", messageID: "Message ID", reactionKey: "Emoji, e.g. 👍", remove: "true to remove the owner's own reaction instead (default false)", idempotencyKey: IDEMPOTENCY_DOC },
    defaults: {},
    result: object({ chatID, messageID, reactionKey: string({ min: 1, max: MAX_REACTION_KEY_LENGTH }), removed: optional(literal(true)) }),
    write: true,
    needsApprovalForAgents: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 30,
    beeper: "POST /v1/chats/{chatID}/messages/{messageID}/reactions | DELETE .../reactions/{reactionKey}",
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
      text: optional(sendText),
      idempotencyKey: optional(idempotencyKey),
      attachmentId: optional(uploadID),
    }),
    paramDocs: {
      accountID: "The Gmail account to send from: gmail:<address> (from status.accounts)",
      to: "Recipient addresses, 1-50" + ARRAY_DOC,
      cc: "Cc addresses, up to 50" + ARRAY_DOC,
      subject: "Subject line (may be empty)",
      text: "Body, plain text; may be left out when attachmentId is given",
      idempotencyKey: IDEMPOTENCY_DOC,
      attachmentId: ATTACHMENT_DOC,
    },
    defaults: {},
    result: object({ accountID, chatID, pendingMessageID: messageID }),
    write: true,
    needsApprovalForAgents: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 10,
    beeper: "none (Gmail users.messages.send; with attachmentId a multipart/mixed message)",
    check: textOrFile,
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

  snooze_chat: define({
    description:
      "Snooze a chat (any network, Gmail too): it is archived now and comes back to the inbox, unarchived and marked unread, at `until` (1 minute to 7 days ahead). A new message from someone else brings it back sooner. Snoozing again moves the time. Agents need the owner's approval.",
    params: object({ chatID, until: isoDateTime() }),
    paramDocs: { chatID: "Chat ID", until: "When the chat comes back: an ISO 8601 time with timezone, 1 minute to 7 days from now" },
    defaults: {},
    result: object({ chatID, until: isoDateTime() }),
    write: true,
    needsApprovalForAgents: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 60,
    beeper: "none itself: the cloud keeps the snooze and runs read_chat (limit 1) and archive now, archive {archived:false} + mark_read {read:false} when it is due",
  }),

  unsnooze_chat: define({
    description: "End a chat's snooze now: it is moved back to the inbox (unarchived, its read state unchanged). Agents need the owner's approval.",
    params: object({ chatID }),
    paramDocs: { chatID: "Chat ID of a snoozed chat (from list_snoozed)" },
    defaults: {},
    result: object({ chatID }),
    write: true,
    needsApprovalForAgents: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 60,
    beeper: "none itself: the cloud runs archive {archived:false} and forgets the snooze",
  }),

  list_snoozed: define({
    description:
      "The owner's snoozed chats, soonest return first: when each comes back (until) and when it was snoozed, with each chat's details (title, network, account) read from the owner's computer; while the computer is offline the details are missing.",
    params: object({}),
    paramDocs: {},
    defaults: {},
    result: object({ items: array(snoozeItem, { max: MAX_SNOOZES }) }),
    write: false,
    needsApprovalForAgents: false,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    // Each call reads every snoozed chat at the connector: agents get a per-action cap.
    rateLimitPerMinute: 10,
    beeper: "the cloud's snooze store (chat ids and times only), then list_chats {inbox: archive} and read_chat (limit 1) for chats that page missed, at most 6 at a time; nothing while the computer is offline"
  }),

  // ---- drafts by agents (protocol drafts.ts): the owner asks, the cloud keeps the request's
  // metadata, the connector keeps its texts. Agents use get_draft_request / submit_draft (agent.ts).

  request_draft: define({
    description:
      "Ask one of the allowed Raft agents (Settings > Agents) to draft a reply in a chat. The agent gets a Raft event with the request id only and has 30 minutes. A new request for the same chat replaces the open one. Owner only.",
    params: object({ chatID, agentID: raftAgentID, instruction: draftInstruction }),
    paramDocs: { chatID: "Chat ID", agentID: "The agent's id (from list_raft_agents, allowed)", instruction: `What the agent should write, 1-2000 characters (kept on the owner's computer)` },
    defaults: {},
    result: draftView,
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 20,
    beeper: "none: the cloud runs read_chat (limit 1) and draft_store_put at the connector, then sends the Raft agent event",
  }),

  cancel_draft: define({
    description: "Cancel a pending draft request (the agent can no longer submit). Owner only.",
    params: object({ requestId: draftRequestID }),
    paramDocs: { requestId: "requestId from request_draft or list_drafts" },
    defaults: {},
    result: draftView,
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none: the cloud forgets the texts on the computer (draft_store_delete)",
  }),

  discard_draft: define({
    description: "Throw a draft away (or put an expired or failed request aside). Owner only.",
    params: object({ requestId: draftRequestID }),
    paramDocs: { requestId: "requestId from list_drafts" },
    defaults: {},
    result: draftView,
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none: draft_store_delete at the connector",
  }),

  mark_draft_sent: define({
    description: "The owner sent the draft (with send_message, as written or edited): the request is done. Owner only.",
    params: object({ requestId: draftRequestID }),
    paramDocs: { requestId: "requestId of a drafted request" },
    defaults: {},
    result: draftView,
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none: draft_store_delete at the connector",
  }),

  list_drafts: define({
    description: "The draft requests not handled yet (pending, drafted, expired, failed), newest first, with the instruction and the draft read from the owner's computer (absent while it is offline). Owner only.",
    params: object({ chatID: optional(chatID) }),
    paramDocs: { chatID: "Only this chat's" },
    defaults: {},
    result: object({ items: array(draftView, { max: MAX_ACTIVE_DRAFTS }) }),
    write: false,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "the cloud's request store (metadata), then draft_store_get at the connector",
  }),

  list_raft_agents: define({
    description: "The agents of the owner's Raft server (from Raft, read at sign-in or on refresh) and which of them may be asked to draft. Owner only.",
    params: object({ refresh: optional(boolean()) }),
    paramDocs: { refresh: "Read the list from Raft again now (needs a recent sign-in that allows agent:read)" },
    defaults: {},
    result: raftAgentsResult,
    write: false,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none (Raft's agent directory, GET /api/oauth/agents with the owner's Raft token)",
  }),

  set_draft_agents: define({
    description: "Which agents of the Raft server may be asked to draft (agent ids only). Owner only.",
    params: object({ agentIDs: array(raftAgentID, { max: MAX_DRAFT_AGENTS }) }),
    paramDocs: { agentIDs: "Agent ids from list_raft_agents" + ARRAY_DOC },
    defaults: {},
    result: object({ allowedAgentIDs: array(raftAgentID, { max: MAX_DRAFT_AGENTS }) }),
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none",
  }),

  // ---- delegations (protocol delegations.ts): the owner hands a chat to an agent as a Raft task.
  // The cloud keeps the request's metadata, the connector its instruction (the draft store, by a dlg_
  // id). Agents use get_delegation_request / report_delegation (agent.ts).

  request_delegation: define({
    description:
      "Delegate a chat to one of the allowed Raft agents (Settings > Agents) as a Raft task in a channel: the chat is marked read, the agent gets a Raft event with the request id only and has 30 minutes to create and claim the task and report its number. A new request for the same chat replaces the open one. Owner only.",
    params: object({ chatID, agentID: raftAgentID, channel: raftChannel, instruction: delegationInstruction }),
    paramDocs: {
      chatID: "Chat ID",
      agentID: "The agent's id (from list_raft_agents, allowed)",
      channel: "The Raft channel for the task, as #name",
      instruction: "What the task is, 1-2000 characters (kept on the owner's computer)",
    },
    defaults: {},
    result: delegationView,
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: 20,
    beeper: "none: the cloud runs read_chat (limit 1), draft_store_put and mark_read at the connector, then sends the Raft agent event",
  }),

  cancel_delegation: define({
    description: "Cancel a pending delegation (the agent can no longer report a task). Owner only.",
    params: object({ requestId: delegationRequestID }),
    paramDocs: { requestId: "requestId from request_delegation or list_delegations" },
    defaults: {},
    result: delegationView,
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none: the cloud forgets the instruction on the computer (draft_store_delete)",
  }),

  dismiss_delegation: define({
    description: "Put a delegation aside (created, failed or expired): it no longer shows on the chat. Owner only.",
    params: object({ requestId: delegationRequestID }),
    paramDocs: { requestId: "requestId from list_delegations" },
    defaults: {},
    result: delegationView,
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none: draft_store_delete at the connector",
  }),

  list_delegations: define({
    description:
      "The delegations shown on chats (pending, created, failed, expired), newest first, with the instruction of the open ones read from the owner's computer (absent while it is offline), and the channels the owner used before (most recent first). Owner only.",
    params: object({ chatID: optional(chatID) }),
    paramDocs: { chatID: "Only this chat's" },
    defaults: {},
    result: object({ items: array(delegationView, { max: MAX_SHOWN_DELEGATIONS }), channels: array(raftChannel, { max: MAX_RECENT_CHANNELS }) }),
    write: false,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloud: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "the cloud's request store (metadata), then draft_store_get at the connector",
  }),

  // The connector's draft store (the instruction and the draft text stay on the owner's computer).
  // Cloud-only: only the room sends them, as the steps of the draft actions above.

  draft_store_put: define({
    description: "Internal: keep a draft or delegation request's instruction on the owner's computer.",
    params: object({ requestId: storedRequestID, chatID, instruction: draftInstruction, deadline: isoDateTime() }),
    paramDocs: { requestId: "The request id (drq_ draft, dlg_ delegation)", chatID: "Chat ID", instruction: "The owner's instruction", deadline: "When the request expires" },
    defaults: {},
    result: object({ requestId: storedRequestID, stored: literal(true) }),
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloudOnly: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none (the connector's local draft store)",
  }),

  draft_store_get: define({
    description: "Internal: read draft or delegation requests (instruction, draft) from the owner's computer. Unknown ids are left out.",
    params: object({ requestIds: array(storedRequestID, { min: 1, max: MAX_DRAFT_READ }) }),
    paramDocs: { requestIds: "Request ids" },
    defaults: {},
    result: object({ items: array(storedDraft, { max: MAX_DRAFT_READ }) }),
    write: false,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloudOnly: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none (the connector's local draft store)",
  }),

  draft_store_set_text: define({
    description: "Internal: keep the agent's draft for a request on the owner's computer (NOT_FOUND if the request is not there). With attachmentId the upload goes with the draft (NOT_FOUND unless it is finished and owner's).",
    params: object({ requestId: draftRequestID, text: draftText, attachmentId: optional(uploadID), owner: optional(uploadOwner) }),
    paramDocs: { requestId: "The request id", text: "The draft", attachmentId: "A finished upload to keep with the draft", owner: "uploadOwnerTag of the agent: the upload must be its own" },
    defaults: {},
    result: object({ requestId: draftRequestID, stored: literal(true) }),
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloudOnly: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none (the connector's local draft store)",
    check: (p) => ((p.attachmentId === undefined) !== (p.owner === undefined) ? "attachmentId and owner go together" : null),
  }),

  draft_store_delete: define({
    description: "Internal: forget draft or delegation requests (instruction and draft) on the owner's computer.",
    params: object({ requestIds: array(storedRequestID, { min: 1, max: MAX_ACTIVE_DRAFTS }) }),
    paramDocs: { requestIds: "Request ids" },
    defaults: {},
    result: object({ deleted: integer({ min: 0, max: MAX_ACTIVE_DRAFTS }) }),
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloudOnly: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none (the connector's local draft store)",
  }),

  // The connector's upload store (uploads.ts): files the owner or an agent is sending, on the owner's
  // computer only. Cloud-only: the room sends the chunks it relays, one req per chunk.

  upload_store_begin: define({
    description: "Internal: start keeping a file on the owner's computer (its name, type and size; the bytes follow in upload_store_chunk).",
    params: object({ uploadId: uploadID, owner: uploadOwner, fileName, mimeType, size: integer({ min: 0, max: MAX_UPLOAD_BYTES }) }),
    paramDocs: { uploadId: "The upload id (upl_)", owner: "uploadOwnerTag of the caller", fileName: "The file's name", mimeType: "Its type", size: "Its size in bytes" },
    defaults: {},
    result: object({ uploadId: uploadID, stored: literal(true) }),
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloudOnly: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none (the connector's local upload store)",
  }),

  upload_store_chunk: define({
    description: "Internal: the next piece of an upload's bytes (index 0, 1, 2 ... in order, at most 256 KiB each).",
    params: object({ uploadId: uploadID, owner: uploadOwner, index: integer({ min: 0, max: MAX_UPLOAD_CHUNKS - 1 }), data: uploadChunkData }),
    paramDocs: { uploadId: "The upload id", owner: "uploadOwnerTag of the caller", index: "This chunk's number, from 0", data: "The bytes, base64" },
    defaults: {},
    result: object({ uploadId: uploadID, index: integer({ min: 0, max: MAX_UPLOAD_CHUNKS - 1 }), received: integer({ min: 0, max: MAX_UPLOAD_BYTES }) }),
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloudOnly: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none (the connector's local upload store)",
  }),

  upload_store_commit: define({
    description: "Internal: every byte of an upload is there (BAD_PARAMS if not): it may now be sent or attached to a draft.",
    params: object({ uploadId: uploadID, owner: uploadOwner }),
    paramDocs: { uploadId: "The upload id", owner: "uploadOwnerTag of the caller" },
    defaults: {},
    result: uploadInfo,
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloudOnly: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none (the connector's local upload store)",
  }),

  upload_store_delete: define({
    description: "Internal: forget uploads (their files) on the owner's computer.",
    params: object({ uploadIds: array(uploadID, { min: 1, max: MAX_STORED_UPLOADS }) }),
    paramDocs: { uploadIds: "Upload ids" },
    defaults: {},
    result: object({ deleted: integer({ min: 0, max: MAX_STORED_UPLOADS }) }),
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    cloudOnly: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none (the connector's local upload store)",
  }),

  discard_upload: define({
    description: "Forget a file the owner attached in the web page and then removed (one on an agent's draft stays with the draft). Owner only.",
    params: object({ uploadId: uploadID }),
    paramDocs: { uploadId: "uploadId from POST /api/upload" },
    defaults: {},
    result: object({ uploadId: uploadID, deleted: boolean() }),
    write: true,
    needsApprovalForAgents: false,
    humanOnly: true,
    streamed: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    beeper: "none (the connector's local upload store)",
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

/** Actions the cloud answers itself (`cloud: true`): never in a `req` frame. */
export type CloudActionName = { [K in ActionName]: Actions[K] extends { cloud: true } ? K : never }[ActionName];
/** Actions the connector runs: everything a `req` frame may name. */
export type ConnectorActionName = Exclude<ActionName, CloudActionName>;
export const CLOUD_ACTION_NAMES = Object.freeze(ACTION_NAMES.filter((n) => (ACTIONS[n] as { cloud?: boolean }).cloud === true) as CloudActionName[]);
export const CONNECTOR_ACTION_NAMES = Object.freeze(ACTION_NAMES.filter((n) => (ACTIONS[n] as { cloud?: boolean }).cloud !== true) as ConnectorActionName[]);

export function isCloudAction(v: unknown): v is CloudActionName {
  return isActionName(v) && (ACTIONS[v] as { cloud?: boolean }).cloud === true;
}

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
  const problem = def.check?.(merged.value as never);
  if (problem) return { ok: false, issues: [{ path: [], message: problem }] };
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
  return coerceParams(isActionName(name) ? (ACTIONS[name].params.shape as Record<string, Schema<unknown>>) : {}, raw);
}

/** coerceAgentParams for any params shape (the agent meta actions' too). */
export function coerceParams(shape: Record<string, Schema<unknown>>, raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
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
