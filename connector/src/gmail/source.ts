// One Gmail account as a J-Inbox source: lists (as merge sources), reading a thread, search,
// unread summary, the writes (mark read, archive, reply-all draft and send, new email) and
// attachments. Every Gmail call goes through the account's GmailClient.
import {
  LIST_SCAN_BUDGET_MS,
  MAX_CURSOR_LENGTH,
  MAX_MEDIA_BYTES,
  MIME_RE,
  gmailChatID,
  makeError,
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
import { activityMs, header, isDraft, mapGmailMessage, mapGmailThread, threadMessages, type GMessage, type GPart, type GThread } from "./map.ts";
import { b64urlToBytes, buildMessage, headerText, parseAddressList, rawForGmail, replyAllRecipients, replyReferences, replySubject } from "./mime.ts";
import { sniffImageType } from "../media.ts";

const META_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID"];
const REPLY_HEADERS = ["From", "To", "Cc", "Reply-To", "Subject", "Message-ID", "References", "In-Reply-To"];
/**
 * Primary inbox: Gmail's own Primary tab (`category:primary`), which Gmail works out per account:
 * which tabs are on, and which Updates it shows in Primary. Never rebuild it from the category
 * labels: on an account with the Updates tab Gmail still puts most Updates mail in Primary.
 */
export const Q_PRIMARY = "in:inbox category:primary";
export const Q_LOW_PRIORITY = "in:inbox -category:primary";
const CONCURRENCY = 8;
const MAX_SCAN_PAGES = 5;

export type Out<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };
const fail = (code: ErrorBody["code"], message: string): { ok: false; error: ErrorBody } => ({ ok: false, error: makeError(code, message) });

function must(r: GCall): any {
  if (!r.ok) throw new SourceFailure(r.error);
  return r.body;
}

async function pool<A, B>(items: A[], n: number, fn: (a: A) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const scopeHash = (s: string) => createHash("sha256").update(s).digest().subarray(0, 9).toString("base64url");

/** A position in a Gmail list: page token (null = first page) and offset in that page. */
type Pos = { t: string | null; o: number };
function encodePos(p: Pos): string {
  const s = "g1." + b64(JSON.stringify([p.t, p.o]));
  if (s.length > MAX_CURSOR_LENGTH) throw new CursorTooLong();
  return s;
}
function decodePos(s: string | null): Pos | null {
  if (s === null) return { t: null, o: 0 };
  if (!s.startsWith("g1.")) return null;
  try {
    const v = JSON.parse(unb64(s.slice(3)));
    if (Array.isArray(v) && v.length === 2 && (v[0] === null || (typeof v[0] === "string" && v[0].length <= 512)) && Number.isSafeInteger(v[1]) && v[1] >= 0 && v[1] <= 500) return { t: v[0], o: v[1] };
  } catch {}
  return null;
}

export type ListFilter = {
  q: string;
  keep: (c: ChatSummary) => boolean;
  /** Set isLowPriority from the query (Gmail knows the tab; the labels only hint at it). */
  lowPriority?: boolean;
};

/** Gmail query and post-filter for list_chats params (network/accountIDs are routed before). */
export function listFilterFor(p: Partial<ActionParams<"list_chats">>): ListFilter {
  const q: string[] = [];
  const keeps: ((c: ChatSummary) => boolean)[] = [];
  let lowPriority: boolean | undefined;
  if (p.inbox === "primary") q.push(Q_PRIMARY), keeps.push((c) => !c.isArchived), (lowPriority = false);
  else if (p.inbox === "low-priority") q.push(Q_LOW_PRIORITY), keeps.push((c) => !c.isArchived), (lowPriority = true);
  else if (p.inbox === "archive") q.push("-in:inbox"), keeps.push((c) => c.isArchived);
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

export type GmailSource = ReturnType<typeof createGmailSource>;

export function createGmailSource(o: { email: string; client: GmailClient; scan?: { maxPages?: number; budgetMs?: number }; now?: () => number }) {
  const { email, client } = o;
  const now = o.now ?? Date.now;
  const opts = (ctx: RequestContext) => ({ signal: ctx.signal });

  function checkTime(ctx: RequestContext) {
    if (ctx.signal?.aborted) throw new RequestAborted();
  }

  async function threadMeta(id: string, ctx: RequestContext, headers = META_HEADERS): Promise<GThread | null> {
    const r = await client.get(client.path(["threads", id], { format: "metadata", metadataHeaders: headers }), opts(ctx));
    if (!r.ok && r.error.code === "NOT_FOUND") return null;
    return must(r) as GThread;
  }

  // Thread metadata by id, valid while the thread's historyId (from threads.list) is unchanged: the
  // inbox lists the same threads again and again, and each fetch costs Gmail quota. Memory only.
  const metaCache = new Map<string, { historyId: string; thread: GThread }>();
  const META_CACHE_MAX = 2000;
  async function listedThreadMeta(id: string, historyId: string | undefined, ctx: RequestContext): Promise<GThread | null> {
    const hit = historyId ? metaCache.get(id) : undefined;
    if (hit && hit.historyId === historyId) {
      metaCache.delete(id);
      metaCache.set(id, hit);
      return hit.thread;
    }
    const t = await threadMeta(id, ctx);
    if (t && historyId) {
      metaCache.set(id, { historyId, thread: t });
      if (metaCache.size > META_CACHE_MAX) metaCache.delete(metaCache.keys().next().value!);
    }
    return t;
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
    const pageSize = Math.min(100, Math.max(limit + 5, 20));
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
        const chunk = ids.slice(i, i + Math.min(CONCURRENCY * 2, limit - kept.length + 2));
        const threads = await pool(chunk, CONCURRENCY, (id) => listedThreadMeta(id, historyOf.get(id), ctx));
        for (let j = 0; j < chunk.length; j++) {
          const idx = i + j;
          const after: Pos = idx + 1 < ids.length ? { t: pos.t, o: idx + 1 } : next ? { t: next, o: 0 } : { t: pos.t, o: ids.length };
          const urls: string[] = [];
          const chat = threads[j] ? mapGmailThread(threads[j], email, { onAsset: (u) => urls.push(u) }) : null;
          if (chat && filter.lowPriority !== undefined) chat.isLowPriority = filter.lowPriority;
          if (chat && filter.keep(chat)) kept.push({ item: { value: chat, time: activityMs(chat), key: chat.id, urls }, after });
          if (kept.length >= limit) {
            const moreHere = idx + 1 < ids.length;
            hasMore = moreHere || !!next;
            resume = after;
            break;
          }
        }
        i += chunk.length;
      }
      if (kept.length >= limit) break;
      if (!next) {
        hasMore = false;
        resume = null;
        break;
      }
      pos = { t: next, o: 0 };
      if (pages >= maxPages || now() - t0 >= budget || (ctx.deadline !== undefined && now() >= ctx.deadline)) {
        hasMore = true;
        resume = pos;
        break;
      }
    }
    const items = kept.map((k) => k.item);
    return {
      items,
      hasMore,
      cursorAfter: (n) => {
        if (n < items.length) return n > 0 ? encodePos(kept[n - 1]!.after) : cursor === null ? encodePos({ t: null, o: 0 }) : cursor;
        return hasMore && resume ? encodePos(resume) : null;
      },
    };
  }

  /** Unread chats in the primary inbox, newest first (unread_summary). */
  async function unread(limit: number, ctx: RequestContext): Promise<{ items: MergeItem<ChatSummary>[]; truncated: boolean }> {
    const page = await listThreads({ q: `is:unread ${Q_PRIMARY}`, keep: (c) => c.unreadCount > 0 && !c.isArchived, lowPriority: false }, null, limit, ctx);
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
    const chat = mapGmailThread(t, email, { onAsset: (u) => chatURLs.push(u) });
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
    const msgs = await pool(slice, CONCURRENCY, async (r) => {
      const g = await client.get(client.path(["messages", r.id], { format: "metadata", metadataHeaders: META_HEADERS }), opts(ctx));
      if (!g.ok && g.error.code === "NOT_FOUND") return null;
      return must(g) as GMessage;
    });
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
    // The chats of these messages (one metadata call per thread).
    const threads = [...new Set(kept.map((k) => k.item.value.chatID))].filter((id) => !chats.has(id));
    await pool(threads, CONCURRENCY, async (chatID) => {
      const tid = chatID.slice(chatID.lastIndexOf(":") + 1);
      const t = await threadMeta(tid, ctx);
      const urls: string[] = [];
      const chat = t ? mapGmailThread(t, email, { onAsset: (u) => urls.push(u) }) : null;
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
  async function buildReply(threadId: string, text: string, replyTo: string | undefined, ctx: RequestContext, refuseIfDraft: boolean): Promise<Out<{ raw: string }>> {
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
      buildMessage({ from: email, to, cc, subject: replySubject(base.subject || firstSubject), text, ...(refs.inReplyTo ? { inReplyTo: refs.inReplyTo } : {}), ...(refs.references ? { references: refs.references } : {}), date: new Date(now()) }),
    );
    return { ok: true, data: { raw } };
  }

  async function draftReply(threadId: string, text: string, ctx: RequestContext): Promise<Out<null>> {
    const b = await buildReply(threadId, text, undefined, ctx, true);
    if (!b.ok) return b;
    const r = await client.write(client.path(["drafts"]), { message: { raw: b.data.raw, threadId } }, opts(ctx));
    return r.ok ? { ok: true, data: null } : r;
  }

  async function sendReply(threadId: string, text: string, replyTo: string | undefined, ctx: RequestContext): Promise<Out<{ id: string; threadId: string }>> {
    const b = await buildReply(threadId, text, replyTo, ctx, false);
    if (!b.ok) return b;
    const r = await client.write(client.path(["messages", "send"]), { raw: b.data.raw, threadId }, opts(ctx));
    if (!r.ok) return r;
    const id = r.body?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(id)) return fail("UNKNOWN_OUTCOME", "Gmail accepted the email but its answer was unreadable. Check the thread before sending again.");
    return { ok: true, data: { id, threadId: typeof r.body?.threadId === "string" ? r.body.threadId : threadId } };
  }

  async function compose(p: { to: string[]; cc?: string[]; subject: string; text: string }, ctx: RequestContext): Promise<Out<{ id: string; threadId: string }>> {
    let raw: string;
    try {
      raw = rawForGmail(buildMessage({ from: email, to: p.to.map((a) => ({ address: a })), cc: (p.cc ?? []).map((a) => ({ address: a })), subject: p.subject, text: p.text, date: new Date(now()) }));
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

  async function profile(ctx: RequestContext): Promise<Out<{ emailAddress: string; historyId: string }>> {
    const r = await client.get(client.path(["profile"]), opts(ctx));
    if (!r.ok) return r;
    const e = r.body?.emailAddress;
    const h = r.body?.historyId;
    if (typeof e !== "string" || typeof h !== "string" || !/^\d{1,20}$/.test(h)) return fail("UPSTREAM_DOWN", "Gmail sent an unreadable profile.");
    return { ok: true, data: { emailAddress: e, historyId: h } };
  }

  return { email, client, listThreads, unread, readThread, readCursor, search, markRead, modifyThread, draftReply, sendReply, compose, attachment, profile };
}
