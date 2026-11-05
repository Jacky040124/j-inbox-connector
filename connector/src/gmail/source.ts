// One Gmail account as a J-Inbox source: lists (as merge sources), reading a thread, search,
// unread summary, the writes (mark read, archive, reply-all draft and send, new email) and
// attachments. Every Gmail call goes through the account's GmailClient.
import {
  GMAIL_ID_RE,
  GMAIL_ATTACHMENT_ID_RE,
  LIST_SCAN_BUDGET_MS,
  MAX_CURSOR_LENGTH,
  MAX_EMAIL_CID_IMAGE_BYTES,
  MAX_EMAIL_CID_TOTAL_BYTES,
  MAX_EMAIL_HTML_BYTES,
  MAX_EMAIL_TEXT_LENGTH,
  MAX_MEDIA_BYTES,
  MIME_RE,
  gmailChatID,
  makeError,
  sanitizeText,
  truncateText,
  type ActionParams,
  type ChatSummary,
  type ErrorBody,
  type MessageItem,
} from "@j-inbox/protocol";
import { createHash } from "node:crypto";
import { SourceFailure, type MergeItem, type SourcePage } from "../merge.ts";
import { CursorTooLong, RequestAborted } from "../pager.ts";
import type { RequestContext } from "../actions.ts";
import type { GCall, GmailClient } from "./client.ts";
import { activityMs, charsetOfPart, header, htmlParts, inlineHtmlOf, isDraft, mapGmailMessage, mapGmailThread, partsByContentId, threadMessages, threadSendersOf, type GMessage, type GPart, type GThread, type ThreadSenders } from "./map.ts";
import { imageDataUri } from "./email-html.ts";
import { cidReferencesIn, compareInWorker, sanitizeInWorker } from "./email-html-run.ts";
import { b64urlToBytes, buildMessage, decodeCharset, headerText, parseAddressList, rawForGmail, replyAllRecipients, replyReferences, replySubject, splitQuoted, type OutgoingFile } from "./mime.ts";
import { sniffImageType } from "../media.ts";
import { GMAIL_BATCH_SIZE } from "./batch.ts";
import { ThreadMetaCache, keptThread } from "./meta-cache.ts";

const META_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID"];
const REPLY_HEADERS = ["From", "To", "Cc", "Reply-To", "Subject", "Message-ID", "References", "In-Reply-To"];
/**
 * Primary inbox: Gmail's own Primary tab (`category:primary`), which Gmail works out per account:
 * which tabs are on, and which Updates it shows in Primary. Never rebuild it from the category
 * labels: on an account with the Updates tab Gmail still puts most Updates mail in Primary.
 */
export const Q_PRIMARY = "in:inbox category:primary";
export const Q_LOW_PRIORITY = "in:inbox -category:primary";
const MAX_SCAN_PAGES = 5;
/** A walk that reads no thread but the ones it wants (ListFilter.only) can go further for the same quota: a list call each. */
const MAX_ONLY_PAGES = 20;
/** Sanitized HTML kept in memory, here on the Mac and nowhere else: opening and folding an email again costs no Gmail quota. */
const HTML_KEPT_ENTRIES = 8;
const HTML_KEPT_BYTES = 16 * 1024 * 1024;
const HTML_KEPT_MS = 10 * 60_000;
/** What read_chat worked out about emails' two versions: messages do not change, and a thread is read again and again. */
const AGREEMENT_KEPT_ENTRIES = 300;
const AGREEMENT_MESSAGES_AT_ONCE = 30;

export type Out<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };
const fail = (code: ErrorBody["code"], message: string): { ok: false; error: ErrorBody } => ({ ok: false, error: makeError(code, message) });

function must(r: GCall): any {
  if (!r.ok) throw new SourceFailure(r.error);
  return r.body;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const scopeHash = (s: string) => createHash("sha256").update(s).digest().subarray(0, 9).toString("base64url");

/** A position in a Gmail list: page token (null = first page), offset in that page, and how many of a filter's `only` threads came before it. */
type Pos = { t: string | null; o: number; f?: number };
function encodePos(p: Pos): string {
  const s = "g1." + b64(JSON.stringify(p.f ? [p.t, p.o, p.f] : [p.t, p.o]));
  if (s.length > MAX_CURSOR_LENGTH) throw new CursorTooLong();
  return s;
}
function decodePos(s: string | null): Pos | null {
  if (s === null) return { t: null, o: 0 };
  if (!s.startsWith("g1.")) return null;
  try {
    const v = JSON.parse(unb64(s.slice(3)));
    if (Array.isArray(v) && (v.length === 2 || (v.length === 3 && Number.isSafeInteger(v[2]) && v[2] >= 0)) && (v[0] === null || (typeof v[0] === "string" && v[0].length <= 512)) && Number.isSafeInteger(v[1]) && v[1] >= 0 && v[1] <= 500) return { t: v[0], o: v[1], ...(v.length === 3 ? { f: v[2] } : {}) };
  } catch {}
  return null;
}

export type ListFilter = {
  q: string;
  keep: (c: ChatSummary) => boolean;
  /** Set isLowPriority from the query (Gmail knows the tab; the labels only hint at it). */
  lowPriority?: boolean;
  /**
   * To do: of what Gmail lists, only these threads are read at all (the rest cost no metadata), `total` of them (`counted`) are
   * expected, so the walk ends when all have come, and `missing` hears who did not when it reached the list's end.
   */
  only?: { wants(chatID: string): boolean; counted(chatID: string): boolean; total: number; missing(found: ReadonlySet<string>): void };
};

/** What the lists ask of To do (todo/tracker.ts). */
export type TodoLists = { inList(c: ChatSummary, o?: { exactScope?: boolean }): boolean; onlyFor(email: string): NonNullable<ListFilter["only"]> };

/**
 * Gmail query and post-filter for list_chats params (network/accountIDs are routed before). `isNoise`
 * (noise on): noise threads leave the Primary list; Low priority gets them from noiseLaneFilter.
 */
export function listFilterFor(p: Partial<ActionParams<"list_chats">>, isNoise?: (chatID: string) => boolean, todo?: TodoLists): ListFilter {
  const q: string[] = [];
  const keeps: ((c: ChatSummary) => boolean)[] = [];
  let lowPriority: boolean | undefined;
  // To do is the main inbox's, whatever else is asked.
  if (p.inbox === "primary" || p.todo) q.push(Q_PRIMARY), keeps.push((c) => !c.isArchived && !isNoise?.(c.id)), (lowPriority = false);
  else if (p.inbox === "low-priority") q.push(Q_LOW_PRIORITY), keeps.push((c) => !c.isArchived), (lowPriority = true);
  else if (p.inbox === "archive") q.push("-in:inbox"), keeps.push((c) => c.isArchived);
  if (p.todo && todo) keeps.push((c) => todo.inList(c, { exactScope: true }));
  if (p.unreadOnly) q.push("is:unread"), keeps.push((c) => c.unreadCount > 0);
  if (p.pinnedOnly) q.push("is:starred"), keeps.push((c) => c.isPinned);
  if (p.type && p.type !== "any") keeps.push((c) => c.type === p.type);
  if (p.query) {
    // Words of the title: each as a quoted subject term, so Gmail operators in the text stay words.
    const words = p.query.split(/\s+/).map((w) => w.replace(/["{}()]/g, "")).filter(Boolean).slice(0, 20);
    for (const w of words) q.push(`subject:"${w}"`);
    keeps.push((c) => words.every((w) => c.title.toLowerCase().includes(w.toLowerCase())));
  }
  return { q: q.join(" "), keep: (c) => keeps.every((k) => k(c)), ...(lowPriority === undefined ? {} : { lowPriority }) };
}

/** Low priority's second lane per account (noise on): the Primary tab's threads that are noise. */
export function noiseLaneFilter(p: Partial<ActionParams<"list_chats">>, isNoise: (chatID: string) => boolean): ListFilter {
  const base = listFilterFor({ ...p, inbox: "primary" });
  return { q: base.q, keep: (c) => base.keep(c) && isNoise(c.id), lowPriority: false };
}

export type GmailSource = ReturnType<typeof createGmailSource>;

/** One thread's answer to threadSenders. */
export type SenderLook = { status: "ok"; senders: ThreadSenders } | { status: "gone" } | { status: "failed"; error: ErrorBody };

export function createGmailSource(o: {
  email: string;
  client: GmailClient;
  scan?: { maxPages?: number; budgetMs?: number };
  now?: () => number;
  metaCache?: ThreadMetaCache;
  htmlKeptMs?: number;
  /** Every thread as it is mapped for a list, a read or a search, before anything filters it (the noise list of senders: its newest sender is known here, at no cost). */
  onChat?: (c: ChatSummary) => void;
}) {
  const { email, client } = o;
  const seen = (c: ChatSummary | null): ChatSummary | null => {
    if (c) o.onChat?.(c);
    return c;
  };
  const now = o.now ?? Date.now;
  const opts = (ctx: RequestContext) => ({ signal: ctx.signal });

  function checkTime(ctx: RequestContext) {
    if (ctx.signal?.aborted) throw new RequestAborted();
  }

  // Thread metadata by id, valid while the thread's historyId (from threads.list) is unchanged: the
  // inbox lists the same threads again and again, and each fetch costs Gmail quota. The service
  // shares one cache, kept on disk (meta-cache.ts), across its accounts.
  const metaCache = o.metaCache ?? new ThreadMetaCache();
  const metaPath = (id: string) => client.path(["threads", id], { format: "metadata", metadataHeaders: META_HEADERS });

  /** Metadata of many threads: cached ones as they are, the rest in Gmail batch requests. null = gone (404). */
  async function threadMetas(ids: string[], historyOf: (id: string) => string | undefined, ctx: RequestContext): Promise<(GThread | null)[]> {
    const out: (GThread | null | undefined)[] = ids.map((id) => metaCache.get(email, id, historyOf(id)) ?? undefined);
    const missing = ids.map((_, i) => i).filter((i) => out[i] === undefined);
    for (let k = 0; k < missing.length; k += GMAIL_BATCH_SIZE) {
      checkTime(ctx);
      const part = missing.slice(k, k + GMAIL_BATCH_SIZE);
      const got = await client.batchGet(part.map((i) => metaPath(ids[i]!)), opts(ctx));
      part.forEach((i, j) => {
        const r = got[j]!;
        if (!r.ok && r.error.code === "NOT_FOUND") return void (out[i] = null);
        const raw = must(r);
        // The same shape whether it came from Gmail now or from the cache later.
        out[i] = metaCache.set(email, ids[i]!, historyOf(ids[i]!), raw) ?? keptThread(raw) ?? (raw as GThread);
      });
    }
    return out as (GThread | null)[];
  }

  /**
   * Threads matching `filter`, newest first, from the list position `cursor`: up to `limit` kept
   * chats, scanning at most a few Gmail pages. A merge source page.
   */
  async function listThreads(filter: ListFilter, cursor: string | null, limit: number, ctx: RequestContext): Promise<SourcePage<ChatSummary>> {
    const start = decodePos(cursor);
    if (!start) throw new SourceFailure(makeError("BAD_PARAMS", "cursor is not from this list."));
    const t0 = now();
    const budget = o.scan?.budgetMs ?? LIST_SCAN_BUDGET_MS;
    const maxPages = o.scan?.maxPages ?? MAX_SCAN_PAGES;
    const kept: { item: MergeItem<ChatSummary>; after: Pos }[] = [];
    let pos: Pos = start;
    let hasMore = false;
    let resume: Pos | null = null;
    const only = filter.only;
    const pageSize = only ? 100 : Math.min(100, Math.max(limit + 5, 20));
    const pagesAtMost = only ? (o.scan?.maxPages ?? MAX_ONLY_PAGES) : maxPages;
    // How many of the wanted threads were met, this walk and the pages before it; which ones, on a walk from the top.
    let met = start.f ?? 0;
    const metHere = new Set<string>();
    let allMet = false;
    let lastLooked: string | null = null;
    for (let pages = 1; ; pages++) {
      checkTime(ctx);
      const list = must(await client.get(client.path(["threads"], { q: filter.q || undefined, maxResults: String(pageSize), pageToken: pos.t ?? undefined }), opts(ctx)));
      const listed: { id: string; historyId?: string }[] = Array.isArray(list?.threads)
        ? list.threads.filter((t: any) => typeof t?.id === "string").map((t: any) => ({ id: t.id, ...(typeof t.historyId === "string" && t.historyId ? { historyId: t.historyId } : {}) }))
        : [];
      const ids = listed.map((t) => t.id);
      const historyOf = new Map(listed.map((t) => [t.id, t.historyId]));
      const next: string | null = typeof list?.nextPageToken === "string" && list.nextPageToken ? list.nextPageToken : null;
      let i = pos.o;
      while (i < ids.length && kept.length < limit) {
        const chunk = ids.slice(i, i + Math.min(GMAIL_BATCH_SIZE, limit - kept.length + 2));
        // With `only`, the threads not wanted are not read: a list call says all there is to know about them.
        const wanted = only ? chunk.filter((id) => only.wants(gmailChatID(email, id))) : chunk;
        const got = await threadMetas(wanted, (id) => historyOf.get(id), ctx);
        const threadOf = new Map(wanted.map((id, k) => [id, got[k]!]));
        for (let j = 0; j < chunk.length; j++) {
          const idx = i + j;
          if (only && threadOf.has(chunk[j]!)) {
            const chatID = gmailChatID(email, chunk[j]!);
            if (only.counted(chatID)) met++;
            metHere.add(chatID);
          }
          const counted = only && met ? { f: met } : {};
          const after: Pos = idx + 1 < ids.length ? { t: pos.t, o: idx + 1, ...counted } : next ? { t: next, o: 0, ...counted } : { t: pos.t, o: ids.length, ...counted };
          const urls: string[] = [];
          const t = threadOf.get(chunk[j]!);
          const chat = t ? seen(mapGmailThread(t, email, { onAsset: (u) => urls.push(u) })) : null;
          if (chat && filter.lowPriority !== undefined) chat.isLowPriority = filter.lowPriority;
          if (chat && filter.keep(chat)) kept.push({ item: { value: chat, time: activityMs(chat), key: chat.id, urls }, after });
          allMet = !!only && met >= only.total;
          if (kept.length >= limit || allMet) {
            const moreHere = idx + 1 < ids.length;
            hasMore = !allMet && (moreHere || !!next);
            resume = hasMore ? after : null;
            break;
          }
        }
        if (kept.length >= limit || allMet) break;
        i += chunk.length;
      }
      if (kept.length >= limit || allMet) break;
      lastLooked = ids.at(-1) ?? lastLooked;
      if (!next) {
        hasMore = false;
        resume = null;
        // Its end, from the top: what is wanted and did not come is not in this list.
        // Only a walk of exactly the main inbox can say so: a narrower list (pinned, unread, a query: any agent may ask one) has left out what it never looked for.
        if (only && cursor === null && filter.q === Q_PRIMARY) only.missing(metHere);
        break;
      }
      pos = { t: next, o: 0, ...(only && met ? { f: met } : {}) };
      if (pages >= pagesAtMost || now() - t0 >= budget || (ctx.deadline !== undefined && now() >= ctx.deadline)) {
        hasMore = true;
        resume = pos;
        break;
      }
    }
    const items = kept.map((k) => k.item);
    // A walk cut short that read nothing it could tell the time by: how far back it looked, from the last thread it listed.
    let horizon: number | undefined;
    if (only && hasMore && kept.length < limit && lastLooked) {
      const [t] = await threadMetas([lastLooked], () => undefined, ctx).catch(() => [null]);
      const c = t ? mapGmailThread(t, email) : null;
      if (c) horizon = activityMs(c);
    }
    return {
      items,
      hasMore,
      ...(horizon !== undefined ? { horizon } : {}),
      cursorAfter: (n) => {
        if (n < items.length) return n > 0 ? encodePos(kept[n - 1]!.after) : cursor === null ? encodePos({ t: null, o: 0 }) : cursor;
        return hasMore && resume ? encodePos(resume) : null;
      },
    };
  }

  /** Ids of the threads Gmail lists for a query, one page: a list call, no thread read (10 quota units per 100 threads). */
  async function threadIDs(q: string, pageToken: string | null, ctx: RequestContext): Promise<{ ids: string[]; next: string | null }> {
    checkTime(ctx);
    const list = must(await client.get(client.path(["threads"], { q, maxResults: "100", pageToken: pageToken ?? undefined }), opts(ctx)));
    const ids: string[] = Array.isArray(list?.threads) ? list.threads.map((t: any) => t?.id).filter((id: unknown): id is string => typeof id === "string" && GMAIL_ID_RE.test(id)) : [];
    return { ids, next: typeof list?.nextPageToken === "string" && list.nextPageToken ? list.nextPageToken : null };
  }

  /** Who wrote in these threads, in one Gmail batch: threads.get metadata with only `headers`, 10 quota units each, in the order asked. `until[i]`: thread i's `sole` as it was then. */
  async function threadSenders(ids: string[], headers: readonly string[], ctx: RequestContext, until: (number | undefined)[] = []): Promise<SenderLook[]> {
    checkTime(ctx);
    const got = await client.batchGet(ids.map((id) => client.path(["threads", id], { format: "metadata", metadataHeaders: [...headers] })), opts(ctx));
    return got.map((r, i): SenderLook => {
      if (!r.ok) return r.error.code === "NOT_FOUND" ? { status: "gone" } : { status: "failed", error: r.error };
      const senders = threadSendersOf(r.body, email, { until: until[i] });
      return senders ? { status: "ok", senders } : { status: "gone" };
    });
  }

  /** The main inbox's chats, newest first, one page (metadata from the cache while a thread's historyId stands). */
  async function primaryPage(cursor: string | null, ctx: RequestContext): Promise<{ items: ChatSummary[]; next: string | null }> {
    const page = await listThreads({ q: Q_PRIMARY, keep: () => true, lowPriority: false }, cursor, 50, ctx);
    return { items: page.items.map((i) => i.value), next: page.cursorAfter(page.items.length) };
  }

  /** Unread chats in the primary inbox, newest first (unread_summary); noise ones (isNoise) left out. */
  async function unread(limit: number, ctx: RequestContext, isNoise?: (chatID: string) => boolean): Promise<{ items: MergeItem<ChatSummary>[]; truncated: boolean }> {
    const page = await listThreads({ q: `is:unread ${Q_PRIMARY}`, keep: (c) => c.unreadCount > 0 && !c.isArchived && !isNoise?.(c.id), lowPriority: false }, null, limit, ctx);
    return { items: page.items, truncated: page.hasMore };
  }

  /** read_chat: the thread, newest messages first in pages of `limit`, returned oldest first. */
  async function readThread(threadId: string, cursor: string | undefined, limit: number, ctx: RequestContext): Promise<Out<{ chat: ChatSummary; items: MessageItem[]; offsets: { total: number; from: number; slice: number }; urls: string[][]; chatURLs: string[] }>> {
    const scope = scopeHash(`read_chat\u0000${gmailChatID(email, threadId)}`);
    let offset = 0;
    if (cursor !== undefined) {
      const m = /^jg\.([A-Za-z0-9_-]{1,64})$/.exec(cursor);
      let v: any = null;
      try {
        v = m ? JSON.parse(unb64(m[1]!)) : null;
      } catch {}
      if (!v || v.s !== scope || !Number.isSafeInteger(v.o) || v.o < 0) return fail("BAD_PARAMS", "cursor is not from this chat.");
      offset = v.o;
    }
    const r = await client.get(client.path(["threads", threadId], { format: "full" }), opts(ctx));
    if (!r.ok) return r;
    const t = r.body as GThread;
    const chatURLs: string[] = [];
    const chat = seen(mapGmailThread(t, email, { onAsset: (u) => chatURLs.push(u) }));
    if (!chat) return fail("NOT_FOUND", "This email thread is empty or was deleted.");
    const msgs = threadMessages(t);
    const end = Math.max(0, msgs.length - offset);
    const startAt = Math.max(0, end - limit);
    const urls: string[][] = [];
    const items: MessageItem[] = [];
    for (const m of msgs.slice(startAt, end)) {
      const u: string[] = [];
      const item = mapGmailMessage(m, email, { onAsset: (x) => u.push(x) });
      if (item) items.push(item), urls.push(u);
    }
    await showWhatTheOwnerSees(msgs, chat.preview ? [...items, chat.preview] : items);
    return { ok: true, data: { chat, items, offsets: { total: msgs.length, from: offset, slice: end - startAt }, urls, chatURLs } };
  }

  function readCursor(threadId: string, newOffset: number): string {
    return "jg." + b64(JSON.stringify({ o: newOffset, s: scopeHash(`read_chat\u0000${gmailChatID(email, threadId)}`) }));
  }

  /** Messages matching a Gmail query, newest first, as a merge source page; chats of the returned messages in `chats`. */
  async function search(q: string, keep: (m: MessageItem) => boolean, cursor: string | null, limit: number, ctx: RequestContext, chats: Map<string, { chat: ChatSummary; urls: string[] }>): Promise<SourcePage<MessageItem>> {
    const start = decodePos(cursor);
    if (!start) throw new SourceFailure(makeError("BAD_PARAMS", "cursor is not from this search."));
    checkTime(ctx);
    const pageSize = Math.min(100, Math.max(limit + 5, 20));
    const list = must(await client.get(client.path(["messages"], { q, maxResults: String(pageSize), pageToken: start.t ?? undefined }), opts(ctx)));
    const refs: { id: string; threadId: string }[] = Array.isArray(list?.messages) ? list.messages.filter((m: any) => typeof m?.id === "string" && typeof m?.threadId === "string") : [];
    const next: string | null = typeof list?.nextPageToken === "string" && list.nextPageToken ? list.nextPageToken : null;
    const slice = refs.slice(start.o, start.o + limit);
    const msgs: (GMessage | null)[] = [];
    for (let k = 0; k < slice.length; k += GMAIL_BATCH_SIZE) {
      checkTime(ctx);
      const got = await client.batchGet(slice.slice(k, k + GMAIL_BATCH_SIZE).map((r) => client.path(["messages", r.id], { format: "metadata", metadataHeaders: META_HEADERS })), opts(ctx));
      for (const g of got) msgs.push(!g.ok && g.error.code === "NOT_FOUND" ? null : (must(g) as GMessage));
    }
    const kept: { item: MergeItem<MessageItem>; after: Pos }[] = [];
    for (let j = 0; j < slice.length; j++) {
      const idx = start.o + j;
      const after: Pos = idx + 1 < refs.length ? { t: start.t, o: idx + 1 } : next ? { t: next, o: 0 } : { t: start.t, o: refs.length };
      const raw = msgs[j];
      if (!raw || isDraft(raw)) continue;
      const urls: string[] = [];
      const m = mapGmailMessage(raw, email, { onAsset: (u) => urls.push(u) });
      if (!m || !keep(m)) continue;
      kept.push({ item: { value: m, time: Number(m.sortKey), key: `${m.chatID}\u0000${m.id}`, urls }, after });
    }
    // The chats of these messages (their thread metadata, batched).
    const threads = [...new Set(kept.map((k) => k.item.value.chatID))].filter((id) => !chats.has(id));
    const metas = await threadMetas(
      threads.map((chatID) => chatID.slice(chatID.lastIndexOf(":") + 1)),
      () => undefined,
      ctx,
    );
    threads.forEach((chatID, i) => {
      const t = metas[i];
      const urls: string[] = [];
      const chat = t ? seen(mapGmailThread(t, email, { onAsset: (u) => urls.push(u) })) : null;
      if (chat) chats.set(chatID, { chat: { ...chat, preview: null }, urls });
    });
    const items = kept.filter((k) => chats.has(k.item.value.chatID));
    const consumedAll = start.o + slice.length;
    const hasMore = consumedAll < refs.length || !!next;
    const resume: Pos | null = consumedAll < refs.length ? { t: start.t, o: consumedAll } : next ? { t: next, o: 0 } : null;
    return {
      items: items.map((k) => k.item),
      hasMore,
      cursorAfter: (n) => {
        if (n < items.length) return n > 0 ? encodePos(items[n - 1]!.after) : cursor === null ? encodePos({ t: null, o: 0 }) : cursor;
        return hasMore && resume ? encodePos(resume) : null;
      },
    };
  }

  async function modifyThread(threadId: string, add: string[], remove: string[], ctx: RequestContext): Promise<Out<null>> {
    const r = await client.write(client.path(["threads", threadId, "modify"]), { addLabelIds: add, removeLabelIds: remove }, opts(ctx));
    return r.ok ? { ok: true, data: null } : r;
  }

  async function markRead(threadId: string, read: boolean, messageID: string | undefined, ctx: RequestContext): Promise<Out<null>> {
    if (!messageID || !read) return modifyThread(threadId, read ? [] : ["UNREAD"], read ? ["UNREAD"] : [], ctx);
    // Read up to one message: every message of the thread up to and including it.
    const t = await client.get(client.path(["threads", threadId], { format: "minimal" }), opts(ctx));
    if (!t.ok) return t;
    const msgs = threadMessages(t.body as GThread);
    const idx = msgs.findIndex((m) => m.id === messageID);
    if (idx < 0) return fail("NOT_FOUND", "That message is not in this email thread.");
    for (const m of msgs.slice(0, idx + 1)) {
      if (!(m.labelIds ?? []).includes("UNREAD")) continue;
      const r = await client.write(client.path(["messages", m.id!, "modify"]), { removeLabelIds: ["UNREAD"] }, opts(ctx));
      if (!r.ok) return r;
    }
    return { ok: true, data: null };
  }

  /** The reply-all message for a thread (to its newest message, or to `replyTo`). */
  async function buildReply(threadId: string, text: string, replyTo: string | undefined, ctx: RequestContext, refuseIfDraft: boolean, attachment?: OutgoingFile): Promise<Out<{ raw: string }>> {
    const t = await client.get(client.path(["threads", threadId], { format: "metadata", metadataHeaders: REPLY_HEADERS }), opts(ctx));
    if (!t.ok) return t;
    const thread = t.body as GThread;
    const all = Array.isArray(thread.messages) ? thread.messages : [];
    if (refuseIfDraft && all.some(isDraft)) return fail("CONFLICT", "This email thread already has a draft. J-Inbox never replaces it; ask the owner to send or delete it.");
    const msgs = threadMessages(thread);
    const target = replyTo ? msgs.find((m) => m.id === replyTo) : msgs.at(-1);
    if (!target) return fail(replyTo ? "NOT_FOUND" : "NOT_FOUND", replyTo ? "That message is not in this email thread." : "This email thread has no message to reply to.");
    const p: GPart | undefined = target.payload;
    const base = {
      from: parseAddressList(header(p, "From"), 1),
      replyTo: parseAddressList(header(p, "Reply-To")),
      to: parseAddressList(header(p, "To")),
      cc: parseAddressList(header(p, "Cc")),
      subject: headerText(header(p, "Subject"), 900),
      messageId: header(p, "Message-ID").trim(),
      references: header(p, "References"),
    };
    const firstSubject = headerText(header(msgs[0]?.payload, "Subject"), 900);
    const { to, cc } = replyAllRecipients(base, email);
    const refs = replyReferences(base);
    const raw = rawForGmail(
      buildMessage({ from: email, to, cc, subject: replySubject(base.subject || firstSubject), text, ...(refs.inReplyTo ? { inReplyTo: refs.inReplyTo } : {}), ...(refs.references ? { references: refs.references } : {}), date: new Date(now()), ...(attachment ? { attachment } : {}) }),
    );
    return { ok: true, data: { raw } };
  }

  async function draftReply(threadId: string, text: string, ctx: RequestContext): Promise<Out<null>> {
    const b = await buildReply(threadId, text, undefined, ctx, true);
    if (!b.ok) return b;
    const r = await client.write(client.path(["drafts"]), { message: { raw: b.data.raw, threadId } }, opts(ctx));
    return r.ok ? { ok: true, data: null } : r;
  }

  /** A reply-all in the thread; with a file, multipart/mixed (still reply-all, still threaded). */
  async function sendReply(threadId: string, text: string, replyTo: string | undefined, ctx: RequestContext, attachment?: OutgoingFile): Promise<Out<{ id: string; threadId: string }>> {
    const b = await buildReply(threadId, text, replyTo, ctx, false, attachment);
    if (!b.ok) return b;
    const r = await client.write(client.path(["messages", "send"]), { raw: b.data.raw, threadId }, opts(ctx));
    if (!r.ok) return r;
    const id = r.body?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(id)) return fail("UNKNOWN_OUTCOME", "Gmail accepted the email but its answer was unreadable. Check the thread before sending again.");
    return { ok: true, data: { id, threadId: typeof r.body?.threadId === "string" ? r.body.threadId : threadId } };
  }

  async function compose(p: { to: string[]; cc?: string[]; subject: string; text?: string }, ctx: RequestContext, attachment?: OutgoingFile): Promise<Out<{ id: string; threadId: string }>> {
    let raw: string;
    try {
      raw = rawForGmail(buildMessage({ from: email, to: p.to.map((a) => ({ address: a })), cc: (p.cc ?? []).map((a) => ({ address: a })), subject: p.subject, text: p.text ?? "", date: new Date(now()), ...(attachment ? { attachment } : {}) }));
    } catch {
      return fail("BAD_PARAMS", "An address is not valid.");
    }
    const r = await client.write(client.path(["messages", "send"]), { raw }, opts(ctx));
    if (!r.ok) return r;
    const id = r.body?.id;
    const threadId = r.body?.threadId;
    if (typeof id !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(id) || typeof threadId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(threadId))
      return fail("UNKNOWN_OUTCOME", "Gmail accepted the email but its answer was unreadable. Check Sent before sending again.");
    return { ok: true, data: { id, threadId } };
  }

  /** An attachment's bytes (Gmail sends it whole, base64url). */
  async function attachment(messageId: string, attachmentId: string, ctx: RequestContext): Promise<Out<{ mimeType: string; fileName: string | null; bytes: Uint8Array }>> {
    const m = await client.get(client.path(["messages", messageId], { format: "full" }), opts(ctx));
    if (!m.ok) return m;
    let part: GPart | null = null;
    const walk = (p: GPart | undefined, d: number) => {
      if (!p || d > 12 || part) return;
      if (p.body?.attachmentId === attachmentId) part = p;
      for (const c of p.parts ?? []) walk(c, d + 1);
    };
    walk((m.body as GMessage).payload, 0);
    const found = part as GPart | null;
    if (found && typeof found.body?.size === "number" && found.body.size > MAX_MEDIA_BYTES) return fail("TOO_LARGE", "This file is larger than J-Inbox relays (25 MiB).");
    const a = await client.get(client.path(["messages", messageId, "attachments", attachmentId]), opts(ctx));
    if (!a.ok) return a;
    const bytes = typeof a.body?.data === "string" ? b64urlToBytes(a.body.data) : null;
    if (!bytes) return fail("UPSTREAM_DOWN", "Gmail sent an unreadable attachment.");
    if (bytes.length > MAX_MEDIA_BYTES) return fail("TOO_LARGE", "This file is larger than J-Inbox relays (25 MiB).");
    const declared = String(found?.mimeType ?? "").toLowerCase();
    let mimeType = declared.length >= 3 && declared.length <= 255 && MIME_RE.test(declared) ? declared : "application/octet-stream";
    if (mimeType === "application/octet-stream") mimeType = sniffImageType(bytes) ?? mimeType;
    const name = found?.filename ? headerText(found.filename, 255) : "";
    return { ok: true, data: { mimeType, fileName: name || null, bytes } };
  }

  // Messages do not change; drafts are refused before they get here. Bounded, gone with the process, and gone when their time is up: a timer, not the next read.
  const htmlKept = new Map<string, { threadId: string; bytes: Uint8Array; until: number }>();
  const keepHtml = (messageId: string, threadId: string, bytes: Uint8Array) => {
    if (bytes.length > HTML_KEPT_BYTES) return;
    const keptMs = o.htmlKeptMs ?? HTML_KEPT_MS;
    const entry = { threadId, bytes, until: now() + keptMs };
    htmlKept.set(messageId, entry);
    (setTimeout(() => {
      if (htmlKept.get(messageId) === entry) htmlKept.delete(messageId);
    }, keptMs) as { unref?: () => void }).unref?.();
    let total = 0;
    for (const v of htmlKept.values()) total += v.bytes.length;
    for (const [k, v] of htmlKept) {
      if (htmlKept.size <= HTML_KEPT_ENTRIES && total <= HTML_KEPT_BYTES) break;
      htmlKept.delete(k);
      total -= v.bytes.length;
    }
  };

  const agreement = new Map<string, string | null>();

  /**
   * When an email's plain part clearly differs from what its HTML shows, `text` becomes what the HTML shows, so that whoever reads
   * the thread (agents, Jev) reads what the owner sees; the plain part stays as `plainText`, for the owner's Plain text view (the
   * cloud gives it to no agent). A separate step on purpose: messageBody decides which part is the body, this only compares.
   * An email that cannot be sanitized shows the owner its text anyway, so nothing changes. Within read_chat's deadline, off the main loop.
   */
  async function showWhatTheOwnerSees(msgs: GMessage[], items: MessageItem[]): Promise<void> {
    const wanted = new Set(items.map((i) => i.id));
    const asked: { id: string; html: string; plain: string }[] = [];
    for (const m of msgs) {
      if (!m.id || !wanted.has(m.id) || agreement.has(m.id) || asked.length >= AGREEMENT_MESSAGES_AT_ONCE) continue;
      const item = items.find((i) => i.id === m.id)!;
      if (!item.hasHtml) continue;
      const parts = htmlParts(m.payload).map(inlineHtmlOf);
      const html = parts.filter((t): t is string => t !== null).join("\n");
      if (!html || Buffer.byteLength(html, "utf8") > MAX_EMAIL_HTML_BYTES) continue;
      asked.push({ id: m.id, html, plain: `${item.text ?? ""}\n${item.quotedText ?? ""}` });
    }
    if (asked.length) {
      for (const [id, shown] of await compareInWorker(asked)) {
        agreement.set(id, shown === null ? null : shown.slice(0, MAX_EMAIL_TEXT_LENGTH * 2));
        if (agreement.size > AGREEMENT_KEPT_ENTRIES) agreement.delete(agreement.keys().next().value!);
      }
    }
    for (const item of items) {
      const shown = agreement.get(item.id);
      if (!shown) continue;
      const { main, quoted } = splitQuoted(sanitizeText(shown));
      const t = truncateText(main.replace(/\s+$/, ""), MAX_EMAIL_TEXT_LENGTH);
      if (item.text) item.plainText = item.text;
      item.text = t.text;
      if (t.truncated) item.textTruncated = true;
      else delete item.textTruncated;
      if (quoted) item.quotedText = truncateText(quoted, MAX_EMAIL_TEXT_LENGTH).text;
      else delete item.quotedText;
    }
  }

  /** A part's bytes, held in the message or by attachmentId. null: unreadable. */
  async function partBytes(messageId: string, p: GPart, ctx: RequestContext): Promise<Uint8Array | null> {
    if (typeof p.body?.data === "string") return b64urlToBytes(p.body.data);
    const id = p.body?.attachmentId;
    if (typeof id !== "string" || !GMAIL_ATTACHMENT_ID_RE.test(id)) return null;
    const a = await client.get(client.path(["messages", messageId, "attachments", id]), opts(ctx));
    return a.ok && typeof a.body?.data === "string" ? b64urlToBytes(a.body.data) : null;
  }

  /** The message's own images that its HTML names, as data: URIs: only those parts are fetched, within the limits; the rest are simply not there. */
  async function cidImages(messageId: string, payload: GPart | undefined, html: string, ctx: RequestContext): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const wanted = (await cidReferencesIn(html)) ?? [];
    if (!wanted.length) return out;
    const parts = partsByContentId(payload);
    let total = 0;
    for (const id of wanted) {
      const p = parts.get(id);
      if (!p) continue;
      const declared = typeof p.body?.size === "number" ? p.body.size : 0;
      if (declared > MAX_EMAIL_CID_IMAGE_BYTES || total + declared > MAX_EMAIL_CID_TOTAL_BYTES) continue;
      checkTime(ctx);
      const bytes = await partBytes(messageId, p, ctx);
      if (!bytes || total + bytes.length > MAX_EMAIL_CID_TOTAL_BYTES) continue;
      const uri = imageDataUri(bytes);
      if (!uri) continue;
      total += bytes.length;
      out.set(id, uri);
    }
    return out;
  }

  /** get_email_html: one message's HTML, sanitized. Its plain metadata was already read by read_chat; this asks Gmail once per message, and no more while it is kept. */
  async function emailHtml(threadId: string, messageId: string, ctx: RequestContext): Promise<Out<Uint8Array>> {
    const gone = () => fail("NOT_FOUND", "This email is not in this thread, or has no HTML.");
    const kept = htmlKept.get(messageId);
    if (kept && kept.until > now()) return kept.threadId === threadId ? { ok: true, data: kept.bytes } : gone();
    const r = await client.get(client.path(["messages", messageId], { format: "full" }), opts(ctx));
    if (!r.ok) return r;
    const m = r.body as GMessage;
    // A draft is the owner's unsent text: it never leaves the Mac, in any form.
    if (m?.threadId !== threadId || isDraft(m)) return gone();
    const parts = htmlParts(m.payload);
    if (!parts.length) return gone();
    const tooLarge = () => fail("TOO_LARGE", "This email's HTML is too large to show here.");
    if (parts.reduce((n, p) => n + (typeof p.body?.size === "number" ? p.body.size : 0), 0) > MAX_EMAIL_HTML_BYTES) return tooLarge();
    const texts: string[] = [];
    for (const p of parts) {
      checkTime(ctx);
      const inline = typeof p.body?.data === "string" ? inlineHtmlOf(p) : null;
      const bytes = inline === null ? await partBytes(messageId, p, ctx) : null;
      const t = inline ?? (bytes ? decodeCharset(bytes, charsetOfPart(p)) : null);
      if (t !== null) texts.push(t);
    }
    if (!texts.length) return fail("UPSTREAM_DOWN", "Gmail sent an unreadable email.");
    const html = texts.join("\n");
    if (Buffer.byteLength(html, "utf8") > MAX_EMAIL_HTML_BYTES) return tooLarge();
    const clean = await sanitizeInWorker(html, await cidImages(messageId, m.payload, html, ctx));
    if (clean === null) return fail("NOT_FOUND", "This email's HTML cannot be shown.");
    const bytes = new TextEncoder().encode(clean.html);
    keepHtml(messageId, threadId, bytes);
    return { ok: true, data: bytes };
  }

  /** "Send mail as": the account's aliases (own.ts). */
  async function sendAs(): Promise<{ ok: true; data: unknown } | { ok: false }> {
    const r = await client.get(client.path(["settings", "sendAs"]));
    return r.ok ? { ok: true, data: r.body } : { ok: false };
  }

  async function profile(ctx: RequestContext): Promise<Out<{ emailAddress: string; historyId: string }>> {
    const r = await client.get(client.path(["profile"]), opts(ctx));
    if (!r.ok) return r;
    const e = r.body?.emailAddress;
    const h = r.body?.historyId;
    if (typeof e !== "string" || typeof h !== "string" || !/^\d{1,20}$/.test(h)) return fail("UPSTREAM_DOWN", "Gmail sent an unreadable profile.");
    return { ok: true, data: { emailAddress: e, historyId: h } };
  }

  return { email, client, sendAs, listThreads, threadIDs, threadSenders, primaryPage, unread, readThread, readCursor, search, markRead, modifyThread, draftReply, sendReply, compose, attachment, emailHtml, profile };
}
