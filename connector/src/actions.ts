// Catalogue actions implemented against the Beeper Client API. Callers pass params already checked
// with parseActionParams; every result is built from mapped data and shrunk to fit one frame.
import {
  makeError,
  parseActionResult,
  sanitizeLine,
  type Account,
  type ActionParams,
  type ActionResult,
  type ChatSummary,
  type ErrorBody,
  type ErrorCode,
  type MessageItem,
} from "@j-inbox/protocol";
import type { BeeperCall, BeeperClient, CallOptions } from "./beeper-client.ts";
import { mapAccount, mapChat, mapMessage } from "./beeper-map.ts";
import type { AssetAllowlist } from "./assets.ts";
import { IdempotencyCache, hashKey, type IdempotencyJournal } from "./idempotency.ts";
import { CursorExpired, CursorTooLong, RequestAborted, collect, decodePagerCursor, finishPage, fitToFrame, type BeeperPage, type PagerCursor } from "./pager.ts";

export type Outcome<T> = { ok: true; data: T; error?: undefined } | { ok: false; error: ErrorBody; data?: undefined };

class BeeperFailure extends Error {
  constructor(readonly body: ErrorBody) {
    super(body.code);
  }
}

const err = (code: ErrorCode, message: string): Outcome<never> => ({ ok: false, error: makeError(code, message) });
const must = (r: BeeperCall) => {
  if (!r.ok) throw new BeeperFailure(r.error);
  return r.body;
};
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Beeper sortKeys are numeric strings of any length: compare by length, then lexically. */
const sortKeyDesc = (a: any, b: any) => {
  const x = String(a?.sortKey ?? "");
  const y = String(b?.sortKey ?? "");
  return y.length - x.length || (y < x ? -1 : y > x ? 1 : 0);
};

function beeperPage(body: unknown): BeeperPage<any> {
  if (!isObj(body) || !Array.isArray(body.items)) throw new BeeperFailure(makeError("BEEPER_DOWN", "Beeper sent an unexpected page."));
  return { items: body.items.filter(isObj), hasMore: body.hasMore === true, oldestCursor: typeof body.oldestCursor === "string" && body.oldestCursor ? body.oldestCursor : null };
}

function cursorParam(raw: string | undefined, scope: string): PagerCursor | null | "bad" {
  if (raw === undefined) return null;
  return decodePagerCursor(raw, scope) ?? "bad";
}

async function guard<T>(fn: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BeeperFailure) return { ok: false, error: e.body };
    if (e instanceof CursorTooLong) return err("TOO_LARGE", "Beeper's page cursor is too long to continue paging. Start again without a cursor or use a narrower filter.");
    if (e instanceof CursorExpired) return err("BAD_PARAMS", "The cursor expired because the list changed. Reload from the first page.");
    if (e instanceof RequestAborted) return err("TIMEOUT", "The request ran out of time or was cancelled.");
    return err("INTERNAL", "The connector failed while handling this request.");
  }
}

/**
 * Results that prove nothing reached Beeper are not remembered, so the same key may run again.
 * A write only answers TIMEOUT when it was never dispatched (deadline passed first); a write that
 * was in flight when time ran out is UNKNOWN_OUTCOME.
 */
const NOT_DONE = new Set<ErrorCode>(["BEEPER_DOWN", "BEEPER_UNAUTHORIZED", "RATE_LIMITED", "TIMEOUT"]);

/** Per-request context: one cancel/deadline signal shared by every Beeper call of the request. */
export type RequestContext = { signal?: AbortSignal; deadline?: number };

/**
 * Context for one `req`: aborted on the cloud's `cancel` (pass its signal) and `marginMs` before
 * `timeoutMs` (use welcome.requestTimeoutMs), so the connector stops before the cloud gives up.
 */
export function requestContext(o: { timeoutMs: number; marginMs?: number; cancel?: AbortSignal; now?: () => number }): Required<RequestContext> {
  const margin = o.marginMs ?? Math.min(1000, Math.floor(o.timeoutMs / 10));
  const budget = Math.max(0, o.timeoutMs - margin);
  const timer = AbortSignal.timeout(Math.max(1, budget));
  return { signal: o.cancel ? AbortSignal.any([o.cancel, timer]) : timer, deadline: (o.now ?? Date.now)() + budget };
}

const isErrorBody = (v: unknown): v is ErrorBody => isObj(v) && typeof v.code === "string" && typeof v.message === "string";

/**
 * The write-dedupe cache the connector uses. Pass a FileIdempotencyJournal (under the user's
 * Application Support directory) in the service so keys survive restarts: a write in flight when
 * the process died then answers UNKNOWN_OUTCOME instead of being sent again.
 */
export function createWriteDedupe(o: { journal?: IdempotencyJournal; now?: () => number } = {}): IdempotencyCache<Outcome<unknown>> {
  return new IdempotencyCache<Outcome<unknown>>({
    now: o.now,
    journal: o.journal,
    remember: (r) => r.ok || !NOT_DONE.has(r.error.code),
    conflict: () => err("CONFLICT", "This idempotencyKey was already used with different parameters. Use a new key for a different message."),
    interrupted: () => err("UNKNOWN_OUTCOME", "The connector restarted while this write was running. It may or may not have happened; check before trying again."),
    // Only ids and error codes go to disk; send/react results carry no message text, and the chat
    // id (often a phone number) is left out too: withChatID() restores it from the request.
    encode: (r) => (r.ok ? { ok: true, data: isObj(r.data) ? Object.fromEntries(Object.entries(r.data).filter(([k]) => k !== "chatID")) : r.data } : { ok: false, error: r.error }),
    decode: (v) => (isObj(v) && v.ok === true && isObj(v.data) ? { ok: true, data: v.data } : isObj(v) && v.ok === false && isErrorBody(v.error) ? { ok: false, error: makeError(v.error.code as ErrorCode, v.error.message) } : undefined),
  });
}

/** A result replayed from the journal has no chatID (never written to disk): put the request's back. */
function withChatID<T>(chatID: string, r: Outcome<T>): Outcome<T> {
  return r.ok && isObj(r.data) && r.data.chatID === undefined ? { ok: true, data: { chatID, ...r.data } as T } : r;
}

/** Digest of the parameters a key stands for; a different digest under the same key is CONFLICT. */
const fingerprint = (parts: unknown[]) => hashKey(JSON.stringify(parts));

/**
 * The chat networks the owner can use: for each account the network its chats show (accounts say
 * "X", chats say "Twitter/X"), plus chat networks with no account at all (iMessage), plus the
 * remaining accounts' own networks. Sorted, unique, no "Unknown". Also the `hello.networks` list.
 */
export function connectedNetworks(accounts: Account[], rawChats: unknown[]): string[] {
  const byAccount = new Map<string, string>();
  for (const c of rawChats) {
    if (!isObj(c) || typeof c.accountID !== "string" || typeof c.network !== "string") continue;
    const n = sanitizeLine(c.network, 64);
    if (n && !byAccount.has(c.accountID)) byAccount.set(c.accountID, n);
  }
  const out = new Set<string>(byAccount.values());
  for (const a of accounts) if (!byAccount.has(a.accountID)) out.add(a.network);
  out.delete("Unknown");
  return [...out].sort().slice(0, 50);
}

export type ActionsOptions = {
  /** Reported by status. */
  connectorVersion?: string;
  idempotency?: IdempotencyCache<Outcome<unknown>>;
  /** Limits for connector-side scans (defaults LIST_SCAN_MAX_PAGES / LIST_SCAN_BUDGET_MS). */
  scan?: { maxPages?: number; budgetMs?: number };
  /** get_media allowlist: every asset URL in a returned result is added here. */
  assets?: AssetAllowlist;
};

/** A mapped value plus the asset URLs it carries, so only URLs that are actually returned get allowed. */
type WithAssets<T> = { value: T; urls: string[] };
function tracked<T>(map: (raw: unknown, o: { onAsset: (u: string) => void }) => T | null, raw: unknown): WithAssets<T> | null {
  const urls: string[] = [];
  const value = map(raw, { onAsset: (u) => urls.push(u) });
  return value === null ? null : { value, urls };
}

export function createActions(client: BeeperClient, opts: ActionsOptions = {}) {
  const dedupe = opts.idempotency ?? createWriteDedupe();
  const scan = opts.scan ?? {};

  const chatsQuery = (q: Record<string, string | string[] | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) u.append(k, x);
    return u;
  };

  const callOpts = (ctx: RequestContext): CallOptions => ({ signal: ctx.signal });
  const allow = (items: WithAssets<unknown>[], n: number) => {
    if (!opts.assets) return;
    for (const it of items.slice(0, n)) for (const u of it.urls) opts.assets.add(u);
  };

  async function list_chats(p: Partial<ActionParams<"list_chats">>, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"list_chats">>> {
    return guard(async () => {
      // GET /v1/chats returns ChatWithPreview; /v1/chats/search returns Chat without `preview`. The
      // primary inbox (with or without unreadOnly) is read from /v1/chats and filtered here, so the
      // default lists show the last message. Text queries, chat types and the other inboxes need search.
      const primary = p.inbox === "primary" && p.query === undefined && (p.type === undefined || p.type === "any");
      // The endpoint is part of the scope: a cursor from the other endpoint is not resumable here.
      const scope = `list_chats\u0000${JSON.stringify([p.network?.toLowerCase() ?? null, p.accountIDs ?? null, p.unreadOnly ?? null, p.pinnedOnly ?? null, p.inbox ?? null, p.type ?? null, p.query ?? null])}${primary ? "\u0000chats" : ""}`;
      const cursor = cursorParam(p.cursor, scope);
      if (cursor === "bad") return err("BAD_PARAMS", "cursor is not from this list (other filters or another action).");
      const limit = p.limit ?? 25;
      const search = !primary && (p.query !== undefined || p.inbox !== undefined || (p.type !== undefined && p.type !== "any") || p.unreadOnly === true);
      const unreadOnly = primary && p.unreadOnly === true;
      const network = p.network?.toLowerCase();
      const r = await collect({
        cursor,
        limit,
        fetchPage: async (b) => {
          const q = chatsQuery({
            limit: "50",
            accountIDs: p.accountIDs,
            ...(search ? { query: p.query, inbox: p.inbox, type: p.type, unreadOnly: p.unreadOnly ? "true" : undefined } : {}),
            ...(b ? { cursor: b, direction: "before" } : {}),
          });
          return beeperPage(must(await client.get(`/v1/chats${search ? "/search" : ""}?${q}`, callOpts(ctx))));
        },
        keep: (c) =>
          (!network || String(c.network ?? "").toLowerCase() === network) &&
          (!p.pinnedOnly || c.isPinned === true) &&
          (!primary || (c.isArchived !== true && c.isLowPriority !== true)) &&
          (!unreadOnly || Number(c.unreadCount) > 0 || c.isMarkedUnread === true) &&
          mapChat(c) !== null,
        keyOf: (c) => String(c.id),
        ...scan,
        ...ctx,
      });
      const mapped = r.items.map((c) => tracked(mapChat, c)!);
      const build = (n: number) => ({ ...finishPage(r, n, scope), items: mapped.slice(0, n).map((x) => x.value) as ChatSummary[] });
      const n = fitToFrame(mapped.length, build);
      if (mapped.length && n === 0) return err("TOO_LARGE", "A single chat is too large to send.");
      allow(mapped, n);
      return { ok: true, data: build(n) };
    });
  }

  async function unread_summary(p: Partial<ActionParams<"unread_summary">>, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"unread_summary">>> {
    return guard(async () => {
      const limit = p.limit ?? 50;
      // /v1/chats carries `preview` (the latest message); /v1/chats/search does not.
      const r = await collect({
        cursor: null,
        limit: Number.MAX_SAFE_INTEGER,
        fetchPage: async (b) => beeperPage(must(await client.get(`/v1/chats?${chatsQuery({ limit: "50", ...(b ? { cursor: b, direction: "before" } : {}) })}`, callOpts(ctx)))),
        // Beeper's inbox view: archived and low-priority chats are not "unread" for the owner.
        keep: (c) => (Number(c.unreadCount) > 0 || c.isMarkedUnread === true) && c.isArchived !== true && c.isLowPriority !== true && mapChat(c) !== null,
        keyOf: (c) => String(c.id),
        ...scan,
        ...ctx,
      });
      const all = r.items.map((c) => tracked(mapChat, c)!);
      const totalUnreadMessages = all.reduce((sum, c) => sum + c.value.unreadCount, 0);
      const build = (n: number) => ({
        totalUnreadChats: all.length,
        totalUnreadMessages: Math.min(totalUnreadMessages, 1_000_000_000),
        items: all.slice(0, n).map((x) => x.value) as ChatSummary[],
        truncated: n < all.length || r.hasMore,
      });
      const n = fitToFrame(Math.min(limit, all.length), build);
      allow(all, n);
      return { ok: true, data: build(n) };
    });
  }

  async function read_chat(p: ActionParams<"read_chat">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"read_chat">>> {
    return guard(async () => {
      const scope = `read_chat\u0000${p.chatID}`;
      const cursor = cursorParam(p.cursor, scope);
      if (cursor === "bad") return err("BAD_PARAMS", "cursor is not from this chat.");
      const chatT = tracked(mapChat, must(await client.get(client.chatPath(p.chatID), callOpts(ctx))));
      if (!chatT) return err("BEEPER_DOWN", "Beeper sent an unexpected chat.");
      const chat = chatT.value;
      const base = client.chatPath(p.chatID, "messages");
      const r = await collect({
        cursor,
        limit: p.limit ?? 30,
        fetchPage: async (b) => {
          const page = beeperPage(must(await client.get(b ? `${base}?${chatsQuery({ cursor: b, direction: "before" })}` : base, callOpts(ctx))));
          // Page order is unspecified: walk newest first.
          return { ...page, items: [...page.items].sort(sortKeyDesc) };
        },
        keep: (m) => mapMessage(m) !== null,
        keyOf: (m) => String(m.id),
        ...scan,
        ...ctx,
      });
      const newestFirst = r.items.map((m) => tracked(mapMessage, m)!);
      const build = (n: number) => ({ chat, ...finishPage(r, n, scope), items: newestFirst.slice(0, n).map((x) => x.value).reverse() as MessageItem[] });
      const n = fitToFrame(newestFirst.length, build);
      if (newestFirst.length && n === 0) return err("TOO_LARGE", "A single message is too large to send.");
      allow([chatT], 1);
      allow(newestFirst, n);
      return { ok: true, data: build(n) };
    });
  }

  async function draft_reply(p: ActionParams<"draft_reply">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"draft_reply">>> {
    return guard(async () => {
      const current = must(await client.get(client.chatPath(p.chatID), callOpts(ctx)));
      // Never clear or replace what the owner may be typing.
      if (isObj(current) && typeof current.draft?.text === "string" && current.draft.text.length > 0)
        return err("CONFLICT", "The chat already has a draft. J-Inbox never replaces it; ask the owner to send or clear it.");
      // An aborted signal (deadline passed during the GET) means the PATCH is never dispatched.
      must(await client.write("PATCH", client.chatPath(p.chatID), { draft: { text: p.text } }, callOpts(ctx)));
      return { ok: true, data: { chatID: p.chatID, draftSet: true as const } };
    });
  }

  async function send_message(p: ActionParams<"send_message">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"send_message">>> {
    const run = () =>
      guard(async (): Promise<Outcome<ActionResult<"send_message">>> => {
        const body = must(await client.write("POST", client.chatPath(p.chatID, "messages"), { text: p.text, ...(p.replyToMessageID ? { replyToMessageID: p.replyToMessageID } : {}) }, callOpts(ctx)));
        const result = parseActionResult("send_message", { chatID: isObj(body) && typeof body.chatID === "string" ? body.chatID : p.chatID, pendingMessageID: isObj(body) ? body.pendingMessageID : undefined });
        // Beeper accepted the send but its answer is unreadable: the message may be out.
        if (!result.ok) return err("UNKNOWN_OUTCOME", "Beeper accepted the message but its answer was unreadable. Check the chat before sending again.");
        return { ok: true, data: result.value };
      });
    if (!p.idempotencyKey) return run();
    const key = `send_message\u0000${p.chatID}\u0000${p.idempotencyKey}`;
    return (dedupe.run(key, run, { fingerprint: fingerprint([p.text, p.replyToMessageID ?? null]) }) as Promise<Outcome<ActionResult<"send_message">>>).then((r) => withChatID(p.chatID, r)).catch(() =>
      err("INTERNAL", "The connector could not record this write, so it was not sent."),
    );
  }

  async function status(_p: Partial<ActionParams<"status">> = {}, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"status">>> {
    return guard(async () => {
      const base = { online: true, lastSeenAt: new Date().toISOString(), connectorVersion: opts.connectorVersion ?? null };
      const info = await client.get("/v1/info", callOpts(ctx));
      if (!info.ok && info.error.code !== "BEEPER_UNAUTHORIZED") return { ok: true, data: { ...base, beeper: { reachable: false, version: null }, accounts: [], networks: [] } };
      const v = info.ok && isObj(info.body) && isObj(info.body.app) && typeof info.body.app.version === "string" ? sanitizeLine(info.body.app.version, 64) : "";
      const version = v || null;
      const acc = await client.get("/v1/accounts", callOpts(ctx));
      if (!acc.ok && acc.error.code === "BEEPER_UNAUTHORIZED") return { ok: true, data: { ...base, beeper: { reachable: true, version, tokenValid: false }, accounts: [], networks: [] } };
      const rawAccounts = must(acc);
      const accounts = (Array.isArray(rawAccounts) ? rawAccounts : isObj(rawAccounts) && Array.isArray(rawAccounts.items) ? rawAccounts.items : []).map(mapAccount).filter((a: Account | null): a is Account => a !== null).slice(0, 50);
      const chats = beeperPage(must(await client.get(`/v1/chats?${chatsQuery({ limit: "50" })}`, callOpts(ctx)))).items;
      const data = { ...base, beeper: { reachable: true, version, tokenValid: true }, accounts, networks: connectedNetworks(accounts, chats) };
      const checked = parseActionResult("status", data);
      return checked.ok ? { ok: true, data: checked.value } : err("INTERNAL", "Beeper sent an unexpected status.");
    });
  }

  async function search_messages(p: ActionParams<"search_messages">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"search_messages">>> {
    return guard(async () => {
      const network = p.network?.toLowerCase();
      const scope = `search_messages\u0000${JSON.stringify([p.query, p.chatIDs ?? null, p.accountIDs ?? null, network ?? null, p.sender ?? null, p.dateAfter ?? null, p.dateBefore ?? null])}`;
      const cursor = cursorParam(p.cursor, scope);
      if (cursor === "bad") return err("BAD_PARAMS", "cursor is not from this search.");
      const rawChats = new Map<string, unknown>();
      const r = await collect({
        cursor,
        limit: p.limit ?? 20,
        fetchPage: async (b) => {
          const q = chatsQuery({
            query: p.query,
            chatIDs: p.chatIDs,
            accountIDs: p.accountIDs,
            sender: p.sender,
            dateAfter: p.dateAfter,
            dateBefore: p.dateBefore,
            limit: "20",
            ...(b ? { cursor: b, direction: "before" } : {}),
          });
          const body = must(await client.get(`/v1/messages/search?${q}`, callOpts(ctx)));
          const page = beeperPage(body);
          if (isObj(body) && isObj(body.chats)) for (const [id, c] of Object.entries(body.chats)) if (rawChats.size < 5000) rawChats.set(id, c);
          return page;
        },
        keep: (m) => {
          if (mapMessage(m) === null) return false;
          const c = rawChats.get(String(m.chatID));
          if (!c || mapChat(c) === null) return false;
          return !network || String((c as any).network ?? "").toLowerCase() === network;
        },
        keyOf: (m) => `${String(m.chatID)}\u0000${String(m.id)}`,
        ...scan,
        ...ctx,
      });
      const items = r.items.map((m) => tracked(mapMessage, m)!);
      const chatsOf = new Map<string, WithAssets<ChatSummary>>();
      for (const m of items) if (!chatsOf.has(m.value.chatID)) chatsOf.set(m.value.chatID, tracked(mapChat, rawChats.get(m.value.chatID))!);
      const firstChats = (n: number) => {
        const out: Record<string, ChatSummary> = {};
        for (const m of items.slice(0, n)) out[m.value.chatID] = chatsOf.get(m.value.chatID)!.value;
        return out;
      };
      const build = (n: number) => ({ ...finishPage(r, n, scope), items: items.slice(0, n).map((x) => x.value) as MessageItem[], chats: firstChats(n) });
      const n = fitToFrame(items.length, build);
      if (items.length && n === 0) return err("TOO_LARGE", "A single message is too large to send.");
      allow(items, n);
      allow(Object.keys(firstChats(n)).map((id) => chatsOf.get(id)!), Number.MAX_SAFE_INTEGER);
      return { ok: true, data: build(n) };
    });
  }

  async function react(p: ActionParams<"react">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"react">>> {
    const run = () =>
      guard(async (): Promise<Outcome<ActionResult<"react">>> => {
        must(await client.write("POST", client.chatPath(p.chatID, "messages", p.messageID, "reactions"), { reactionKey: p.reactionKey }, callOpts(ctx)));
        return { ok: true, data: { chatID: p.chatID, messageID: p.messageID, reactionKey: p.reactionKey } };
      });
    if (!p.idempotencyKey) return run();
    const key = `react\u0000${p.chatID}\u0000${p.idempotencyKey}`;
    return (dedupe.run(key, run, { fingerprint: fingerprint([p.messageID, p.reactionKey]) }) as Promise<Outcome<ActionResult<"react">>>).then((r) => withChatID(p.chatID, r)).catch(() =>
      err("INTERNAL", "The connector could not record this write, so it was not sent."),
    );
  }

  async function mark_read(p: Partial<ActionParams<"mark_read">> & { chatID: string }, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"mark_read">>> {
    return guard(async () => {
      const read = p.read !== false;
      must(await client.write("POST", client.chatPath(p.chatID, read ? "read" : "unread"), p.messageID ? { messageID: p.messageID } : {}, callOpts(ctx)));
      return { ok: true, data: { chatID: p.chatID, read } };
    });
  }

  async function archive(p: Partial<ActionParams<"archive">> & { chatID: string }, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"archive">>> {
    return guard(async () => {
      const archived = p.archived !== false;
      must(await client.write("POST", client.chatPath(p.chatID, "archive"), { archived }, callOpts(ctx)));
      return { ok: true, data: { chatID: p.chatID, archived } };
    });
  }

  /** Owner-only (the cloud refuses agents). Removes the account's bridge login, like Beeper's "Remove account". */
  async function remove_account(p: ActionParams<"remove_account">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"remove_account">>> {
    return guard(async () => {
      const enc = encodeURIComponent;
      const raw = must(await client.get(`/v1/accounts/${enc(p.accountID)}`, callOpts(ctx)));
      const acc = mapAccount(raw);
      const bridgeID = isObj(raw) && isObj(raw.bridge) && typeof raw.bridge.id === "string" ? raw.bridge.id : null;
      const loginID = isObj(raw) && typeof raw.loginID === "string" ? raw.loginID : null;
      if (!acc?.removable || !bridgeID || !loginID) return err("NOT_ALLOWED", "This account can't be removed from J-Inbox. Use the Beeper app.");
      const login = must(await client.get(`/v1/bridges/${enc(bridgeID)}/logins/${enc(loginID)}`, callOpts(ctx)));
      const scopes: unknown[] = isObj(login) && Array.isArray(login.removeScopes) ? login.removeScopes : [];
      const scope = scopes.includes("all-devices") ? "all-devices" : scopes.includes("current-device") ? "current-device" : null;
      if (!scope) return err("NOT_ALLOWED", "Beeper does not allow removing this account here. Use the Beeper app.");
      const out = must(await client.write("POST", `/v1/bridges/${enc(bridgeID)}/logins/${enc(loginID)}/remove`, { scope }, callOpts(ctx)));
      const affected = isObj(out) && Array.isArray(out.affectedAccountIDs) ? out.affectedAccountIDs.filter((x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 256) : [];
      return { ok: true, data: { accountID: p.accountID, removed: true as const, scope, affectedAccountIDs: (affected.length ? affected : [p.accountID]).slice(0, 50) } };
    });
  }

  return { status, list_chats, unread_summary, read_chat, search_messages, draft_reply, send_message, react, mark_read, archive, remove_account };
}
