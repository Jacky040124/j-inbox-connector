// Routes catalogue actions to their source: Beeper chats, or Gmail threads (ids "gmail:..."), and
// merges list_chats / unread_summary / search_messages over Beeper and every Gmail account
// newest-first (merge.ts). Rules (design/gmail-plan.md "Mixed lists"):
//   - network "Gmail" or only Gmail accountIDs/chatIDs: only Gmail is asked; another network or
//     only Beeper ids: only Beeper (exactly the Beeper-only behaviour and cursors as before);
//     no filter: both, merged, with a "jm." cursor.
//   - a source that fails is named in `failedSources` and the others still answer; when every
//     source failed the first failure is the answer.
// With no Gmail account on this computer everything is the Beeper path, unchanged.
import {
  GMAIL_NETWORK,
  gmailAccountID,
  gmailChatID,
  makeError,
  parseGmailAccountID,
  parseGmailChatID,
  sanitizeLine,
  type ActionParams,
  type ActionResult,
  type ChatSummary,
  type ErrorBody,
  type MessageItem,
} from "@j-inbox/protocol";
import { createWriteDedupe, fileRefused, sendFingerprint, type BeeperActions, type Outcome, type RequestContext, type UploadSource } from "./actions.ts";
import { UploadError } from "./uploads.ts";
import type { AssetAllowlist } from "./assets.ts";
import { hashKey, type IdempotencyCache } from "./idempotency.ts";
import { SourceFailure, mergeCollect, type FailedSource, type MergeItem, type MergeSource, type Merged } from "./merge.ts";
import { CursorExpired, CursorTooLong, RequestAborted, fitToFrame } from "./pager.ts";
import { activityMs } from "./gmail/map.ts";
import { listFilterFor, noiseLaneFilter, type GmailSource } from "./gmail/source.ts";
import type { GmailService } from "./gmail/service.ts";
import type { NoiseView } from "./noise/store.ts";

const err = (code: ErrorBody["code"], message: string): Outcome<never> => ({ ok: false, error: makeError(code, message) });
const isGmailNetwork = (n: string | undefined) => n !== undefined && n.toLowerCase() === GMAIL_NETWORK.toLowerCase();
const shortId = (email: string) => "g" + hashKey(email).slice(0, 10);

type Selection = { beeper: boolean; gmail: GmailSource[]; beeperAccountIDs?: string[]; beeperChatIDs?: string[]; gmailThreads?: Set<string> };

export type RouterOptions = {
  beeper: BeeperActions;
  gmail: GmailService | null;
  assets?: AssetAllowlist;
  /** The same write-dedupe the Beeper actions use (createWriteDedupe with the on-disk journal). */
  idempotency?: IdempotencyCache<Outcome<unknown>>;
  /** The upload store: the file of an email (attachmentId), gone once sent. */
  uploads?: UploadSource;
  /** Noise verdicts: Gmail's noise threads leave Primary and unread_summary and join Low priority (the Beeper actions do the same with their own). */
  noise?: NoiseView;
};

async function guarded<T>(fn: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SourceFailure) return { ok: false, error: e.body };
    if (e instanceof UploadError) return { ok: false, error: e.body };
    if (e instanceof CursorTooLong) return err("TOO_LARGE", "A page cursor is too long to continue paging. Start again without a cursor.");
    if (e instanceof CursorExpired) return err("BAD_PARAMS", "The cursor expired because the list changed. Reload from the first page.");
    if (e instanceof RequestAborted) return err("TIMEOUT", "The request ran out of time or was cancelled.");
    return err("INTERNAL", "The connector failed while handling this request.");
  }
}

export function createRouter(o: RouterOptions) {
  const b = o.beeper;
  const gmail = o.gmail;
  const dedupe = o.idempotency ?? createWriteDedupe();
  const allow = (urls: string[] | undefined) => {
    if (o.assets) for (const u of urls ?? []) o.assets.add(u);
  };

  /** Which sources a list asks. accountIDs / chatIDs split by namespace; `network` picks one side. */
  function select(p: { network?: string; accountIDs?: string[]; chatIDs?: string[] }): Selection {
    const all = gmail ? gmail.sources() : [];
    if (p.network !== undefined) {
      if (!isGmailNetwork(p.network)) return { beeper: true, gmail: [] };
    }
    let sel: Selection = { beeper: !isGmailNetwork(p.network), gmail: all };
    if (p.accountIDs) {
      const g = new Set(p.accountIDs.map(parseGmailAccountID).filter((x): x is string => x !== null));
      const others = p.accountIDs.filter((id) => !id.startsWith("gmail:"));
      sel = { ...sel, beeper: sel.beeper && others.length > 0, gmail: sel.gmail.filter((s) => g.has(s.email)), beeperAccountIDs: others };
    }
    if (p.chatIDs) {
      const threads = new Set<string>();
      const emails = new Set<string>();
      for (const id of p.chatIDs) {
        const g = parseGmailChatID(id);
        if (g) threads.add(id), emails.add(g.email);
      }
      const others = p.chatIDs.filter((id) => !id.startsWith("gmail:"));
      sel = { ...sel, beeper: sel.beeper && others.length > 0, gmail: sel.gmail.filter((s) => emails.has(s.email)), beeperChatIDs: others, gmailThreads: threads };
    }
    return sel;
  }

  const beeperOnly = (sel: Selection) => sel.beeper && sel.gmail.length === 0;

  function wrapBeeper<T>(fn: () => Promise<{ items: MergeItem<T>[]; hasMore: boolean; cursorAfter: (n: number) => string | null }>): () => Promise<{ items: MergeItem<T>[]; hasMore: boolean; cursorAfter: (n: number) => string | null }> {
    return async () => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof RequestAborted) throw e;
        const f = b.internals.toFailure(e);
        if (f) throw new SourceFailure(f);
        throw e;
      }
    };
  }

  function failuresOrError<T>(m: Merged<T>, asked: number): ErrorBody | null {
    return asked > 0 && m.failed.length === asked ? m.failed[0]!.error : null;
  }

  // One entry per source (Low priority asks a Gmail account twice when noise is on).
  const withFailed = (failed: FailedSource[]) => {
    const one = failed.filter((f, i) => failed.findIndex((g) => g.source === f.source && g.accountID === f.accountID) === i);
    return one.length ? { failedSources: one.slice(0, 51) } : {};
  };

  // ---------------------------------------------------------------- lists

  async function list_chats(p: Partial<ActionParams<"list_chats">>, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"list_chats">>> {
    const sel = select(p);
    if (beeperOnly(sel) || !gmail) return b.list_chats({ ...p, ...(sel.beeperAccountIDs ? { accountIDs: sel.beeperAccountIDs } : {}) }, ctx);
    return guarded(async (): Promise<Outcome<ActionResult<"list_chats">>> => {
      const limit = p.limit ?? 25;
      const noise = o.noise?.active() ? o.noise : null;
      const isNoise = noise ? (id: string) => noise.isNoise(id) : undefined;
      const filter = listFilterFor(p, isNoise);
      // Low priority with noise on: each account's other tabs, and its Primary threads that are noise.
      const noiseLane = isNoise && p.inbox === "low-priority" ? noiseLaneFilter(p, isNoise) : null;
      const beeperParams = { ...p, ...(sel.beeperAccountIDs ? { accountIDs: sel.beeperAccountIDs } : {}) };
      delete beeperParams.cursor;
      const sources: MergeSource<ChatSummary>[] = [];
      if (sel.beeper)
        sources.push({
          id: "b",
          rank: 0,
          failure: { source: "beeper" },
          fetch: (cursor, n) =>
            wrapBeeper(async () => {
              const { r, mapped, scope } = await b.internals.listChatsCollect({ ...beeperParams, ...(cursor ? { cursor } : {}), limit: n }, ctx);
              return {
                items: mapped.map((x) => ({ value: x.value, time: activityMs(x.value), key: x.value.id, urls: x.urls })),
                hasMore: r.hasMore,
                cursorAfter: (k) => b.internals.finishPage(r, k, scope).nextCursor,
                ...(r.horizon !== undefined ? { horizon: r.horizon } : {}),
              };
            })(),
        });
      sel.gmail.forEach((s, i) => {
        sources.push({ id: shortId(s.email), rank: 1 + i, failure: { source: "gmail", accountID: gmailAccountID(s.email) }, fetch: (cursor, n) => s.listThreads(filter, cursor, n, ctx) });
        if (noiseLane) sources.push({ id: "n" + shortId(s.email).slice(1), rank: 1 + sel.gmail.length + i, failure: { source: "gmail", accountID: gmailAccountID(s.email) }, fetch: (cursor, n) => s.listThreads(noiseLane, cursor, n, ctx) });
      });
      if (!sources.length) return { ok: true, data: { items: [], hasMore: false, nextCursor: null } };
      const scope = `merged\u0000list_chats\u0000${JSON.stringify([p.network?.toLowerCase() ?? null, p.accountIDs ?? null, p.unreadOnly ?? null, p.pinnedOnly ?? null, p.inbox ?? null, p.type ?? null, p.query ?? null])}${noiseLane ? "\u0000noise" : ""}`;
      const m = await mergeCollect(sources, p.cursor ?? null, limit, scope);
      if (m === "bad") return err("BAD_PARAMS", "cursor is not from this list (other filters or another action).");
      const all = failuresOrError(m, sources.length);
      if (all) return { ok: false, error: all };
      const build = (n: number) => ({ items: m.taken.slice(0, n).map((t) => t.item.value), ...m.finish(n), ...withFailed(m.failed) });
      const n = fitToFrame(m.taken.length, build);
      if (m.taken.length && n === 0) return err("TOO_LARGE", "A single chat is too large to send.");
      for (const t of m.taken.slice(0, n)) allow(t.item.urls);
      return { ok: true, data: build(n) };
    });
  }

  async function unread_summary(p: Partial<ActionParams<"unread_summary">>, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"unread_summary">>> {
    const sources = gmail ? gmail.sources() : [];
    if (!sources.length) return b.unread_summary(p, ctx);
    return guarded(async () => {
      const limit = p.limit ?? 50;
      const failed: FailedSource[] = [];
      const parts = await Promise.all([
        (async () => {
          try {
            const r = await b.internals.unreadCollect(ctx);
            return { rank: 0, items: r.all.map((x) => ({ value: x.value, time: activityMs(x.value), key: x.value.id, urls: x.urls })), truncated: r.hasMore };
          } catch (e) {
            if (e instanceof RequestAborted) throw e;
            failed.push({ source: "beeper", error: b.internals.toFailure(e) ?? makeError("INTERNAL", "Beeper failed while listing.") });
            return null;
          }
        })(),
        ...sources.map(async (s, i) => {
          try {
            const r = await s.unread(limit, ctx, o.noise?.active() ? (id) => o.noise!.isNoise(id) : undefined);
            return { rank: 1 + i, items: r.items, truncated: r.truncated };
          } catch (e) {
            if (e instanceof RequestAborted) throw e;
            failed.push({ source: "gmail", accountID: gmailAccountID(s.email), error: e instanceof SourceFailure ? e.body : makeError("INTERNAL", "Gmail failed while listing.") });
            return null;
          }
        }),
      ]);
      const ok = parts.filter((x): x is NonNullable<typeof x> => x !== null);
      if (!ok.length) return { ok: false, error: failed[0]!.error };
      const all = ok.flatMap((x) => x.items.map((it) => ({ ...it, rank: x.rank }))).sort((a, c) => c.time - a.time || a.rank - c.rank);
      const truncatedAny = ok.some((x) => x.truncated);
      const totalUnreadMessages = all.reduce((sum, c) => sum + c.value.unreadCount, 0);
      const build = (n: number) => ({
        totalUnreadChats: all.length,
        totalUnreadMessages: Math.min(totalUnreadMessages, 1_000_000_000),
        items: all.slice(0, n).map((x) => x.value),
        truncated: n < all.length || truncatedAny,
        ...withFailed(failed),
      });
      const n = fitToFrame(Math.min(limit, all.length), build);
      for (const x of all.slice(0, n)) allow(x.urls);
      return { ok: true, data: build(n) };
    });
  }

  async function search_messages(p: ActionParams<"search_messages">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"search_messages">>> {
    const sel = select(p);
    if (beeperOnly(sel) || !gmail) return b.search_messages({ ...p, ...(sel.beeperAccountIDs ? { accountIDs: sel.beeperAccountIDs } : {}), ...(sel.beeperChatIDs ? { chatIDs: sel.beeperChatIDs } : {}) }, ctx);
    return guarded(async (): Promise<Outcome<ActionResult<"search_messages">>> => {
      const limit = p.limit ?? 20;
      const chats = new Map<string, { chat: ChatSummary; urls: string[] }>();
      const beeperParams: ActionParams<"search_messages"> = { ...p, ...(sel.beeperAccountIDs ? { accountIDs: sel.beeperAccountIDs } : {}), ...(sel.beeperChatIDs ? { chatIDs: sel.beeperChatIDs } : {}) };
      delete beeperParams.cursor;
      const sources: MergeSource<MessageItem>[] = [];
      if (sel.beeper)
        sources.push({
          id: "b",
          rank: 0,
          failure: { source: "beeper" },
          fetch: (cursor, n) =>
            wrapBeeper(async () => {
              const { r, items, chatsOf, scope } = await b.internals.searchCollect({ ...beeperParams, ...(cursor ? { cursor } : {}), limit: n }, ctx);
              for (const [id, c] of chatsOf) if (c) chats.set(id, { chat: c.value, urls: c.urls });
              return { items: items.map((x) => ({ value: x.value, time: Date.parse(x.value.timestamp), key: `${x.value.chatID}\u0000${x.value.id}`, urls: x.urls })), hasMore: r.hasMore, cursorAfter: (k) => b.internals.finishPage(r, k, scope).nextCursor };
            })(),
        });
      const terms = [`(${p.query})`];
      if (p.sender === "me") terms.push("from:me");
      if (p.sender === "others") terms.push("-from:me");
      if (p.dateAfter) terms.push(`after:${Math.floor(Date.parse(p.dateAfter) / 1000)}`);
      if (p.dateBefore) terms.push(`before:${Math.ceil(Date.parse(p.dateBefore) / 1000)}`);
      const q = terms.join(" ");
      const threadKeep = sel.gmailThreads && sel.gmailThreads.size ? (m: MessageItem) => sel.gmailThreads!.has(m.chatID) : () => true;
      sel.gmail.forEach((s, i) =>
        sources.push({ id: shortId(s.email), rank: 1 + i, failure: { source: "gmail", accountID: gmailAccountID(s.email) }, fetch: (cursor, n) => s.search(q, threadKeep, cursor, n, ctx, chats) }),
      );
      if (!sources.length) return { ok: true, data: { items: [], chats: {}, hasMore: false, nextCursor: null } };
      const scope = `merged\u0000search_messages\u0000${JSON.stringify([p.query, p.chatIDs ?? null, p.accountIDs ?? null, p.network?.toLowerCase() ?? null, p.sender ?? null, p.dateAfter ?? null, p.dateBefore ?? null])}`;
      const m = await mergeCollect(sources, p.cursor ?? null, limit, scope);
      if (m === "bad") return err("BAD_PARAMS", "cursor is not from this search.");
      const all = failuresOrError(m, sources.length);
      if (all) return { ok: false, error: all };
      const chatsFor = (n: number) => {
        const out: Record<string, ChatSummary> = {};
        for (const t of m.taken.slice(0, n)) {
          const c = chats.get(t.item.value.chatID);
          if (c) out[t.item.value.chatID] = { ...c.chat, preview: null };
        }
        return out;
      };
      const build = (n: number) => ({ items: m.taken.slice(0, n).map((t) => t.item.value), chats: chatsFor(n), ...m.finish(n), ...withFailed(m.failed) });
      const n = fitToFrame(m.taken.length, build);
      if (m.taken.length && n === 0) return err("TOO_LARGE", "A single message is too large to send.");
      for (const t of m.taken.slice(0, n)) {
        allow(t.item.urls);
        allow(chats.get(t.item.value.chatID)?.urls);
      }
      return { ok: true, data: build(n) };
    });
  }

  // ---------------------------------------------------------------- one Gmail chat

  /** An email's file from the upload store (read() throws NOT_FOUND when it is gone). */
  function emailFile(id: string | undefined): Outcome<{ fileName: string; mimeType: string; bytes: Uint8Array }> | null {
    if (!id) return null;
    if (!o.uploads) return err("NOT_SUPPORTED", "This connector cannot send files.");
    const f = o.uploads.read(id);
    return { ok: true, data: { fileName: f.fileName, mimeType: f.mimeType, bytes: f.bytes } };
  }

  /** The Gmail account and thread of a chatID, or an error (unknown account: NOT_FOUND). */
  function gmailChat(chatID: string): { s: GmailSource; threadId: string } | Outcome<never> {
    const g = parseGmailChatID(chatID);
    const s = g && gmail ? gmail.source(g.email) : null;
    if (!g || !s) return err("NOT_FOUND", "No such email thread on this computer (the Gmail account may have been removed).");
    return { s, threadId: g.threadId };
  }

  async function read_chat(p: ActionParams<"read_chat">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"read_chat">>> {
    if (!p.chatID.startsWith("gmail:")) return b.read_chat(p, ctx);
    const g = gmailChat(p.chatID);
    if ("ok" in g) return g;
    return guarded(async () => {
      const r = await g.s.readThread(g.threadId, p.cursor, p.limit ?? 30, ctx);
      if (!r.ok) return r;
      const { chat, items, offsets, urls, chatURLs } = r.data;
      // items are oldest first; a smaller page keeps the newest ones.
      const build = (n: number) => {
        const kept = items.slice(items.length - n);
        // A message that could not be mapped still counts as read past (never a cursor that repeats).
        const nextOffset = offsets.from + (n === items.length ? offsets.slice : n);
        const hasMore = nextOffset < offsets.total;
        return { chat, items: kept, hasMore, nextCursor: hasMore ? g.s.readCursor(g.threadId, nextOffset) : null };
      };
      const n = fitToFrame(items.length, build);
      if (items.length && n === 0) return err("TOO_LARGE", "A single email is too large to send.");
      allow(chatURLs);
      for (const u of urls.slice(urls.length - n)) allow(u);
      return { ok: true, data: build(items.length ? n : 0) };
    });
  }

  async function mark_read(p: Partial<ActionParams<"mark_read">> & { chatID: string }, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"mark_read">>> {
    if (!p.chatID.startsWith("gmail:")) return b.mark_read(p, ctx);
    const g = gmailChat(p.chatID);
    if ("ok" in g) return g;
    const read = p.read !== false;
    return guarded(async () => {
      const r = await g.s.markRead(g.threadId, read, p.messageID, ctx);
      return r.ok ? { ok: true, data: { chatID: p.chatID, read } } : r;
    });
  }

  async function archive(p: Partial<ActionParams<"archive">> & { chatID: string }, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"archive">>> {
    if (!p.chatID.startsWith("gmail:")) return b.archive(p, ctx);
    const g = gmailChat(p.chatID);
    if ("ok" in g) return g;
    const archived = p.archived !== false;
    return guarded(async () => {
      const r = await g.s.modifyThread(g.threadId, archived ? [] : ["INBOX"], archived ? ["INBOX"] : [], ctx);
      return r.ok ? { ok: true, data: { chatID: p.chatID, archived } } : r;
    });
  }

  async function draft_reply(p: ActionParams<"draft_reply">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"draft_reply">>> {
    if (!p.chatID.startsWith("gmail:")) return b.draft_reply(p, ctx);
    const g = gmailChat(p.chatID);
    if ("ok" in g) return g;
    return guarded(async () => {
      const r = await g.s.draftReply(g.threadId, p.text, ctx);
      return r.ok ? { ok: true, data: { chatID: p.chatID, draftSet: true as const } } : r;
    });
  }

  async function send_message(p: ActionParams<"send_message">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"send_message">>> {
    if (!p.chatID.startsWith("gmail:")) return b.send_message(p, ctx, o.uploads);
    const g = gmailChat(p.chatID);
    if ("ok" in g) return g;
    const run = () =>
      guarded(async (): Promise<Outcome<ActionResult<"send_message">>> => {
        const file = emailFile(p.attachmentId);
        if (file && !file.ok) return file;
        const r = await g.s.sendReply(g.threadId, p.text ?? "", p.replyToMessageID, ctx, file?.data);
        if (!r.ok) return file ? fileRefused(r, "Gmail") : r;
        if (p.attachmentId) o.uploads?.delete([p.attachmentId]);
        return { ok: true, data: { chatID: p.chatID, pendingMessageID: r.data.id } };
      });
    if (!p.idempotencyKey) return run();
    const key = `send_message\u0000${p.chatID}\u0000${p.idempotencyKey}`;
    return (dedupe.run(key, run, { fingerprint: sendFingerprint([p.text, p.replyToMessageID ?? null], p.attachmentId) }) as Promise<Outcome<ActionResult<"send_message">>>)
      .then((r) => (r.ok && (r.data as { chatID?: string }).chatID === undefined ? { ok: true as const, data: { ...r.data, chatID: p.chatID } } : r))
      .catch(() => err("INTERNAL", "The connector could not record this write, so it was not sent."));
  }

  async function react(p: ActionParams<"react">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"react">>> {
    if (!p.chatID.startsWith("gmail:")) return b.react(p, ctx);
    return err("NOT_SUPPORTED", "Email has no reactions. Reply instead.");
  }

  async function compose_email(p: ActionParams<"compose_email">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"compose_email">>> {
    const email = parseGmailAccountID(p.accountID);
    const s = email && gmail ? gmail.source(email) : null;
    if (!email || !s) return err("NOT_FOUND", "No such Gmail account on this computer. Use an accountID from status.accounts (gmail:<address>).");
    const run = () =>
      guarded(async (): Promise<Outcome<ActionResult<"compose_email">>> => {
        const file = emailFile(p.attachmentId);
        if (file && !file.ok) return file;
        const r = await s.compose(p, ctx, file?.data);
        if (!r.ok) return file ? fileRefused(r, "Gmail") : r;
        if (p.attachmentId) o.uploads?.delete([p.attachmentId]);
        return { ok: true, data: { accountID: p.accountID, chatID: gmailChatID(email, r.data.threadId), pendingMessageID: r.data.id } };
      });
    if (!p.idempotencyKey) return run();
    const key = `compose_email\u0000${p.accountID}\u0000${p.idempotencyKey}`;
    return (dedupe.run(key, run, { fingerprint: sendFingerprint([p.to, p.cc ?? [], p.subject, p.text], p.attachmentId) }) as Promise<Outcome<ActionResult<"compose_email">>>)
      .then((r) => {
        // Replayed from the on-disk journal (ids only): a new thread's id is its first message's id.
        if (!r.ok || (r.data as { chatID?: string }).chatID !== undefined) return r;
        const id = (r.data as { pendingMessageID: string }).pendingMessageID;
        return { ok: true as const, data: { accountID: p.accountID, chatID: gmailChatID(email, id), pendingMessageID: id } };
      })
      .catch(() => err("INTERNAL", "The connector could not record this write, so it was not sent."));
  }

  async function gmail_connect(p: ActionParams<"gmail_connect">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"gmail_connect">>> {
    if (!gmail) return err("NOT_ALLOWED", "This connector cannot run Gmail accounts.");
    return guarded(() => gmail.connect(p.email, p.refreshToken, ctx));
  }

  async function remove_account(p: ActionParams<"remove_account">, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"remove_account">>> {
    const email = parseGmailAccountID(p.accountID);
    if (!email) return b.remove_account(p, ctx);
    if (!gmail) return err("NOT_FOUND", "No such Gmail account on this computer.");
    return guarded(async () => {
      const r = await gmail.remove(email);
      return r.ok ? { ok: true, data: { accountID: p.accountID, removed: true as const, scope: "all-devices" as const, affectedAccountIDs: [p.accountID] } } : r;
    });
  }

  async function status(p: Partial<ActionParams<"status">> = {}, ctx: RequestContext = {}): Promise<Outcome<ActionResult<"status">>> {
    const r = await b.status(p, ctx);
    const extra = gmail ? gmail.statusAccounts() : [];
    if (!r.ok || !extra.length) return r;
    const networks = [...new Set([...(r.data.networks ?? []), GMAIL_NETWORK])].map((n) => sanitizeLine(n, 64)).sort();
    return { ok: true, data: { ...r.data, accounts: [...r.data.accounts.slice(0, 50 - Math.min(extra.length, 20)), ...extra.slice(0, 20)], networks: networks.slice(0, 50) } };
  }

  return { status, list_chats, unread_summary, read_chat, search_messages, draft_reply, send_message, react, mark_read, archive, remove_account, compose_email, gmail_connect };
}

export type Router = ReturnType<typeof createRouter>;
