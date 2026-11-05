// To do, between the store and the world: what Beeper and Gmail say goes into the store (todo/store.ts), the
// first run finds what is unread, and a start (or a socket back) catches up with what happened while nobody listened.
//
// The first run, once per source (Beeper; each Gmail account when first seen). The source's `since` and its `cut`
// (7 days before it, fixed: store.ts) go to disk first; from then on a chat the store has never seen is handled unless
// someone wrote after `since`. What was unread at that moment and active since the cut is found in the background, one
// page at a time, and nothing waits for it: Beeper's GET /v1/chats pages (they are local; a chat without a known time
// counts as active), Gmail's threads.list for `is:unread in:inbox category:primary after:<epoch>` (ids only, one
// call of 10 quota units per 100 threads, a second apart: no thread is read for it). Gmail's search judges each message, so a
// thread whose unread message is older than the cut and whose activity since then was read (or the owner's) needs two more
// walks of ids: every thread active since the cut, then the unread older than it; what is in both is To do too, as a list would have it. That last walk always runs, since what it goes past
// is also what the cut leaves out. A restart walks again from the top, with the same cut, which changes nothing that is already known. While a source's first run is not done, a chat
// seen for the first time by any list is judged by the same rule, so a list is right before the walk reaches it. When
// the walk ends the source is `done`, on disk, and it never runs again. Nothing is marked read or archived for any of it.
//
// Add older unread, the owner's, per source: what the cut left out comes in the same way, in the background, once.
// Asked for on disk first, so a restart goes on with it from the top; then it is over for good. What is known already stays as it is (the owner's Done
// above all, even one forgotten for the store's bound: store.ts `forgot`), noise stays out. Handled chats make room for it; To do chats do not, so when they fill the
// bound the rest is left out and said (todoFull), and the source has its line again for when there is room. A walk that fails is logged and tried again
// soon, backing off, since nothing else would for half an hour. Until asked, Settings says how many, and that number is counted once: the first run goes past them anyway (Gmail's
// `before:<epoch>` walk, Beeper's every chat), counts what is neither known nor noise, and keeps it on the source with `done` (`olderLeft`). A restart of an unfinished first run counts again from the top.
// Settings only reads it, with no call to Gmail or Beeper; until the first run has ended it says `counting`. "About", because it is as of the first run and the owner may read mail after it.
// Gmail's resultSizeEstimate is no count (201 on any page with more after it: fake-google/README.md), and nothing reads it. A walk takes what it brings in off the number as it goes, so one the bound stopped leaves what is left, at least the rest of its page.
//
// While nobody listened. Each source remembers how far it has looked (`synced`). On start, and whenever
// Beeper's socket or the cloud's link comes back, and every half hour for what an at-most-once socket lost, the
// chats active since then are walked newest first. A Gmail thread's metadata says who wrote what, from the cache while
// its historyId stands. A Beeper chat whose newest message is the owner's says nothing about before it, so
// that chat is read (the queue below), once per change of its activity.
import { MAX_ACCOUNTS, gmailChatID, makeError, parseGmailChatID, type ActionResult, type ChatSummary, type ErrorBody, type EventFrame, type MessageItem } from "@j-inbox/protocol";
import type { Outcome, RequestContext } from "../actions.ts";
import { Q_PRIMARY } from "../gmail/source.ts";
import type { NoiseView } from "../noise/store.ts";
import { BEEPER_SOURCE, isFromOthers, sourceOf, type TodoStore } from "./store.ts";

export const SYNC_EVERY_MS = 30 * 60_000;
/** Pause between the first run's Gmail pages (threads.list only). */
const GMAIL_FIRST_RUN_PAUSE_MS = 1_000;
/** Pause between Beeper's pages, so a long walk does not crowd what the owner waits for. */
const BEEPER_PAGE_PAUSE_MS = 20;
const SYNC_MARGIN_MS = 60_000;
const MAX_BEEPER_SYNC_PAGES = 40;
const MAX_GMAIL_SYNC_PAGES = 10;
/** Gmail's history reports what happens while this process runs: a welcome soon after the last look need not walk the inbox again. */
const GMAIL_SYNC_GAP_MS = 5 * 60_000;
const MAX_READS_WAITING = 200;
const READ_CONCURRENCY = 2;
const READ_TIMEOUT_MS = 10_000;
/** How far back a read goes through pages of only the owner's messages before it stops for this activity. */
const MAX_READ_PAGES = 5;
const MAX_GAVE_UP = 1000;
/** Events per page of a first run: enough for open pages to read the list again, not one per chat. */
const FIRST_RUN_EVENTS_PER_PAGE = 3;
/** Add older unread's walk failed: tried again after this long, doubling up to the half-hourly sync. */
const OLDER_RETRY_MS = 60_000;

/** What a Gmail account gives the tracker (gmail/source.ts). */
export type TodoGmail = {
  email: string;
  /** Ids of threads Gmail lists for the query, one page. */
  threadIDs(q: string, pageToken: string | null, ctx: RequestContext): Promise<{ ids: string[]; next: string | null }>;
  /** Chats in the main inbox, newest first, one page. */
  primaryPage(cursor: string | null, ctx: RequestContext): Promise<{ items: ChatSummary[]; next: string | null }>;
};

export type TodoTrackerOptions = {
  store: TodoStore;
  noise?: NoiseView;
  /** One page of Beeper's GET /v1/chats, mapped (with previews). Throws when Beeper cannot answer. */
  beeperPage?: (cursor: string | null, ctx: RequestContext) => Promise<{ items: ChatSummary[]; next: string | null }>;
  gmail?: () => TodoGmail[];
  /** The router's read_chat. */
  readChat?: (p: { chatID: string; limit: number; cursor?: string }, ctx: RequestContext) => Promise<Outcome<ActionResult<"read_chat">>>;
  /** The chat's flag moved: tell open pages (a metadata-only `chat` event with the one bit). */
  onChange?: (chatID: string, todo: boolean) => void;
  log?: (msg: string) => void;
  now?: () => number;
  pauseMs?: { gmail?: number; beeper?: number; olderRetry?: number };
};

const MAX_OLDER_COUNT = 1_000_000_000;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const failed = (code: ErrorBody["code"]): { ok: false; error: ErrorBody } => ({ ok: false, error: makeError(code, "read failed") });
/** Gmail's query for "unread in the main inbox", as the Unread tab asks it. */
const Q_UNREAD_PRIMARY = `is:unread ${Q_PRIMARY}`;
// Gmail's epoch-second operators, so the line stays where it is. Whichever way Gmail takes the very second of the cut, a thread there is in one or both, never in neither.
const qSinceCut = (cut: number) => `${Q_UNREAD_PRIMARY} after:${Math.max(0, Math.floor(cut / 1000) - 1)}`;
const qBeforeCut = (cut: number) => `${Q_UNREAD_PRIMARY} before:${Math.floor(cut / 1000)}`;
// Any thread active since the cut, wherever that message is (the owner's own has no INBOX label), as a row's last activity counts it: not a draft.
const qActiveSinceCut = (cut: number) => `after:${Math.max(0, Math.floor(cut / 1000) - 1)} -in:drafts`;
const sourceName = (key: string) => (key === BEEPER_SOURCE ? "Beeper" : "a Gmail account");

export class TodoTracker {
  readonly store: TodoStore;
  private readonly now: () => number;
  private syncing: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reads = new Set<string>();
  private running = new Set<string>();
  private gmailWaiting = new Map<string, Map<string, { at: number; ids: string[] }>>();
  /** Chats read as far back as a read goes, finding only the owner's messages: not again until their activity moves. */
  private gaveUp = new Map<string, number>();
  private gmailTimer: ReturnType<typeof setTimeout> | null = null;
  /** When this process last looked at each Gmail account (a restart has to look, whatever the file says). */
  private gmailLooked = new Map<string, number>();
  private olderRetry: ReturnType<typeof setTimeout> | null = null;
  private olderTries = 0;

  constructor(private readonly o: TodoTrackerOptions) {
    this.store = o.store;
    this.now = o.now ?? Date.now;
    // A To do chat left out for the store's bound: no silent drop, open pages hear of it.
    this.store.onDrop = (chatID) => this.o.onChange?.(chatID, false);
  }

  private isNoise = (chatID: string) => !!this.o.noise?.active() && this.o.noise.isNoise(chatID);
  /**
   * What a first run and Add older unread leave out: noise, but not the list's. The list walks existing mail, and a chat it caught must come back
   * to To do when its entry goes; so it is taken in as any unread chat is, and kept out of view by noise, like new mail from a listed sender.
   */
  private leftOut = (chatID: string) => this.isNoise(chatID) && !this.o.noise?.isListNoise?.(chatID);

  /** The chat's flag as lists and results show it: stored, and in the main inbox. */
  effective(c: ChatSummary, o: { hinted?: boolean } = {}): boolean {
    return this.store.effective(c, o) && !this.isNoise(c.id);
  }

  /**
   * Gmail's To do lane (gmail/source.ts ListFilter.only): only the store's threads are read; when all that could be met have come the walk ends. Every stored
   * To do counts, whatever the store believes of its scope (a wrong belief must not hide it), but for those proved to be elsewhere since they last changed: else every
   * promotion on the store would send each list to the end of Primary.
   */
  onlyFor(email: string) {
    const key = `gmail:${email}`;
    return { wants: (chatID: string) => this.store.isTodo(chatID), counted: (chatID: string) => this.store.isTodo(chatID), total: this.store.toFind(key), missing: (found: ReadonlySet<string>) => this.changedBy(this.store.todoOf(key), () => this.store.notInInbox(key, found)) };
  }

  /** To do chats of a Gmail account in the main inbox, without asking Gmail: the sidebar's count. */
  countFor(email: string): number {
    return this.store.count(`gmail:${email}`, this.isNoise);
  }

  /** To do chats of Beeper in the main inbox, without walking a long list. */
  countBeeper(): number {
    return this.store.count(BEEPER_SOURCE, this.isNoise);
  }

  /** To do chats had to be left out for the store's bound: the owner is told (unread_summary's todoFull). */
  full(): boolean {
    return this.store.overflowed();
  }

  /** A chat as a list walks past it: seen, then whether it is in To do. */
  inList(c: ChatSummary, o: { exactScope?: boolean } = {}): boolean {
    this.see(c, o);
    return this.effective(c);
  }

  private tell(chatID: string) {
    this.o.onChange?.(chatID, this.store.known(chatID) && !this.isNoise(chatID));
  }

  /** Open pages hear when what an event would say about these chats moved, whatever moved it. */
  private changedBy(ids: readonly string[], fn: () => void) {
    const before = ids.map((id) => this.store.known(id));
    fn();
    ids.forEach((id, i) => {
      if (this.store.known(id) !== before[i]) this.tell(id);
    });
  }

  private see(c: ChatSummary, o: { exactScope?: boolean } = {}) {
    const before = this.store.known(c.id);
    const r = this.store.see(c, undefined, o);
    if (r.changed || this.store.known(c.id) !== before) this.tell(c.id);
    if (r.needsRead) this.readSoon(c.id, c.lastActivity);
  }

  private seeRead(c: ChatSummary, items: readonly MessageItem[], complete: boolean, o: { asked: boolean }) {
    const before = this.store.known(c.id);
    const r = this.store.seeRead(c, items, { exactScope: !c.id.startsWith("gmail:"), complete });
    if (r.changed || this.store.known(c.id) !== before) this.tell(c.id);
    if (r.needsRead && !o.asked) this.readSoon(c.id, c.lastActivity);
    return r;
  }

  /**
   * What a result says about its chats. A single Gmail thread (a read, a search) has only a hint of its tab; a list asked by
   * tab knows (`exactScope`, sources.ts sets the row from the query).
   */
  seeResult(name: string, data: unknown, params: Record<string, unknown> = {}) {
    const d = data as Record<string, any>;
    const gmailExact = (c: ChatSummary) => !c.id.startsWith("gmail:") || name === "unread_summary" || params.todo === true || params.inbox === "primary" || params.inbox === "low-priority";
    if (name === "list_chats" || name === "unread_summary") for (const c of d.items as ChatSummary[]) this.see(c, { exactScope: gmailExact(c) });
    else if (name === "search_messages") for (const c of Object.values(d.chats as Record<string, ChatSummary>)) this.see(c, { exactScope: !c.id.startsWith("gmail:") });
    else if (name === "read_chat") {
      // An older page says nothing about the newest message: only the first page accounts for the chat's activity.
      if (params.cursor !== undefined) return;
      this.seeRead(d.chat, d.items, d.hasMore !== true, { asked: false });
    }
  }

  /** An event from Beeper or Gmail's history (metadata only). */
  event(f: EventFrame) {
    if (f.kind === "status" || this.stopped) return;
    if (f.kind === "chat") {
      if (f.op === "deleted") {
        // Out of the counts at once. What is known about it stays until the source says NOT_FOUND twice, apart: chats do come back.
        this.changedBy([f.chatID], () => this.store.noteDeleted(f.chatID));
        return this.readSoon(f.chatID);
      }
      // Gmail's labels moved on a To do thread (archived or moved on the phone): its count follows. Beeper's list walks are exact.
      if (f.chatID.startsWith("gmail:") && this.store.isTodo(f.chatID)) {
        this.store.noteMoved(f.chatID);
        this.readSoon(f.chatID);
      }
      return;
    }
    if (f.op !== "upserted") return;
    if (f.othersAt === null) return;
    if (f.othersAt === undefined) return this.readSoon(f.chatID);
    const at = Date.parse(f.othersAt);
    if (!Number.isFinite(at)) return;
    const g = parseGmailChatID(f.chatID);
    if (g) return this.gmailInbound(g.email, g.threadId, at, f.messageIDs);
    this.changedBy([f.chatID], () => this.store.noteOthers(f.chatID, at, { ids: f.messageIDs }));
    // Archived when last seen: someone writing often brings a chat back; the source's word (a read) says which.
    if (this.store.isTodo(f.chatID) && this.store.entry(f.chatID)?.archived) this.readSoon(f.chatID);
  }

  /** New mail, from Gmail's history (no tab in it): one look at the Primary tab's newest threads decides, for everything that poll found. */
  private gmailInbound(email: string, threadId: string, at: number, ids: readonly string[]) {
    const m = this.gmailWaiting.get(email) ?? new Map<string, { at: number; ids: string[] }>();
    const had = m.get(threadId);
    m.set(threadId, { at: Math.max(at, had?.at ?? 0), ids: [...(had?.ids ?? []), ...ids] });
    this.gmailWaiting.set(email, m);
    this.gmailTimer ??= setTimeout(() => {
      this.gmailTimer = null;
      void this.gmailDecide();
    }, 0);
  }

  private async gmailDecide() {
    const waiting = [...this.gmailWaiting];
    this.gmailWaiting.clear();
    for (const [email, threads] of waiting) {
      let primary: Set<string> | null = null;
      try {
        primary = new Set((await this.o.gmail?.().find((s) => s.email === email)?.threadIDs(Q_PRIMARY, null, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) }))?.ids ?? []);
      } catch {}
      if (this.stopped) return;
      for (const [threadId, { at, ids }] of threads) {
        const chatID = gmailChatID(email, threadId);
        // New mail is the newest, so the first page of Primary has it if Primary has it at all: it is in the inbox again (a stale `archived` goes), or it is not.
        // Not known (the look failed): as if in the inbox, until a list says. Better wrongly in To do than wrongly missing.
        const inPrimary = primary ? primary.has(threadId) : true;
        this.changedBy([chatID], () => this.store.noteOthers(chatID, at, { ids, ...(inPrimary ? { low: false, archived: false } : { low: true, out: primary !== null }) }));
      }
    }
  }

  /** The owner's own hand (set_todo; a noise verdict). On disk when this returns; open pages hear of it. Answers the flag as it now stands: Done refused for something newer than `upTo` is To do. */
  setByOwner(chatID: string, todo: boolean, o: { upTo?: number } = {}): boolean {
    const before = this.store.isTodo(chatID);
    const now = this.store.setOwner(chatID, todo, o);
    if (now === todo || now !== before) this.tell(chatID);
    return now;
  }

  /** What the first run left out, per source of this kind (Settings), as the store has it: no call to Gmail or Beeper. `counting`: its first run is not over, so the number is not known yet. Count null (that, or on its way, or no number kept) shows nothing. */
  olderUnread(kind: "beeper" | "gmail"): { source: string; count: number | null; adding: boolean; counting: boolean }[] {
    const item = (source: string) => {
      const o = this.store.olderOf(source);
      if (!o) return [];
      const left = this.store.olderLeft(source);
      return [{ source, count: o.asked || !o.done || left === undefined ? null : Math.min(left, MAX_OLDER_COUNT), adding: o.asked, counting: !o.done }];
    };
    if (kind === "beeper") return this.o.beeperPage ? item(BEEPER_SOURCE) : [];
    // Asking makes an account known: a sync busy elsewhere may not reach one just added for a long time, and the line does not wait for it.
    const live = this.o.gmail?.() ?? [];
    for (const s of live) this.store.meet(`gmail:${s.email}`);
    const items = live.flatMap((s) => item(`gmail:${s.email}`));
    // An account that cannot be asked now (it needs reconnecting) is still on its way: that line is not over.
    const waiting = this.store.olderAsked().filter((source) => source.startsWith("gmail:") && !items.some((i) => i.source === source));
    return [...items, ...waiting.flatMap(item)].slice(0, MAX_ACCOUNTS);
  }

  /** The owner's Add older unread. On disk when this returns, and running in the background. Pressed twice, it is one walk. False: there is nothing to bring in. */
  addOlder(source: string): boolean {
    const asked = this.store.askOlder(source);
    if (asked) void this.sync();
    return asked;
  }

  /** A Gmail account was removed. */
  forgetAccount(email: string) {
    this.store.forgetSource(`gmail:${email}`);
  }

  /** A Gmail account this computer did not have was connected: whatever was left about that address is not about this connection, and its first run starts now. */
  meetAccount(email: string) {
    const key = `gmail:${email}`;
    this.store.forgetSource(key);
    this.store.meet(key);
  }

  // ---------------------------------------------------------------- reading one chat

  private readSoon(chatID: string, activity?: string | null) {
    if (!this.o.readChat || this.stopped || this.reads.has(chatID)) return;
    if (activity && this.gaveUp.get(chatID) === Date.parse(activity)) return;
    if (this.reads.size >= MAX_READS_WAITING) return; // A later list or sync sees it again.
    this.reads.add(chatID);
    this.pump();
  }

  private pump() {
    while (this.running.size < READ_CONCURRENCY && !this.stopped) {
      const id = [...this.reads].find((x) => !this.running.has(x));
      if (id === undefined) return;
      this.running.add(id);
      void this.readOne(id).finally(() => {
        this.running.delete(id);
        this.reads.delete(id);
        this.pump();
      });
    }
  }

  /** Back through the chat's pages until someone else's message, the chat's start, or MAX_READ_PAGES: nothing is accounted for before that. */
  private async readOne(chatID: string) {
    const items: MessageItem[] = [];
    let chat: ChatSummary | null = null;
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < MAX_READ_PAGES; page++) {
      const ctx: RequestContext = { signal: AbortSignal.timeout(READ_TIMEOUT_MS), deadline: this.now() + READ_TIMEOUT_MS };
      const r = await this.o.readChat!({ chatID, limit: 20, ...(cursor ? { cursor } : {}) }, ctx).catch(() => failed("INTERNAL"));
      if (this.stopped) return;
      if (!r.ok) {
        if (r.error.code === "NOT_FOUND") {
          // One answer says little (a source restarting, a moved thread): it takes a second one, later.
          const before = this.store.isTodo(chatID);
          if (this.store.noteNotFound(chatID) && before) this.tell(chatID);
        }
        if (!chat) return;
        break;
      }
      chat ??= r.data.chat;
      items.push(...r.data.items);
      complete = r.data.hasMore !== true || !r.data.nextCursor;
      if (complete || r.data.items.some(isFromOthers)) break;
      cursor = r.data.nextCursor ?? undefined;
    }
    if (!chat) return;
    const seen = this.seeRead(chat, items, complete, { asked: true });
    if (seen.needsRead && chat.lastActivity) {
      this.gaveUp.delete(chatID);
      this.gaveUp.set(chatID, Date.parse(chat.lastActivity));
      if (this.gaveUp.size > MAX_GAVE_UP) this.gaveUp.delete(this.gaveUp.keys().next().value!);
    } else this.gaveUp.delete(chatID);
  }

  // ---------------------------------------------------------------- first run and catching up

  /** Run from now on (every half hour, and whenever sync is called). */
  start() {
    this.store.meet(BEEPER_SOURCE);
    this.timer ??= setInterval(() => void this.sync(), SYNC_EVERY_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.gmailTimer) clearTimeout(this.gmailTimer);
    this.gmailTimer = null;
    if (this.olderRetry) clearTimeout(this.olderRetry);
    this.olderRetry = null;
    this.store.flush();
  }

  /** First runs that are left, then what happened since each source last looked. Concurrent callers share a run; one more follows if asked meanwhile. */
  sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.again = false;
        for (const id of this.store.awaitingSecondLook()) this.readSoon(id);
        try {
          await this.syncBeeper();
        } catch {
          this.olderHeldUp(BEEPER_SOURCE);
        }
        try {
          await this.addOlderBeeper();
        } catch {
          this.olderHeldUp(BEEPER_SOURCE);
        }
        for (const s of this.o.gmail?.() ?? []) {
          const key = `gmail:${s.email}`;
          // Removed while an account before it was walked, which can be long: it is not made known again.
          if (!this.o.gmail?.().some((x) => x.email === s.email)) continue;
          try {
            await this.syncGmail(s);
          } catch {
            this.olderHeldUp(key);
          }
          try {
            await this.addOlderGmail(s);
          } catch {
            this.olderHeldUp(key);
          }
        }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private ctx(): RequestContext {
    return { signal: AbortSignal.timeout(30_000) };
  }

  private async syncBeeper() {
    if (!this.o.beeperPage) return;
    const started = this.now();
    const state = this.store.meet(BEEPER_SOURCE);
    // What the cut leaves out, each once, however the list moves under the walk. Not on disk until the walk ends: a restart counts again.
    const older = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; !this.stopped; page++) {
      const r: { items: ChatSummary[]; next: string | null } = await this.o.beeperPage(cursor, this.ctx());
      const firstRun = !state.done;
      let told = 0;
      let stillNew = false;
      for (const c of r.items) {
        const t = c.lastActivity ? Date.parse(c.lastActivity) : 0;
        if (t >= state.synced - SYNC_MARGIN_MS) stillNew = true;
        const had = this.store.isTodo(c.id);
        const knew = this.store.known(c.id);
        if (firstRun && this.store.isOlder(c) && !this.isNoise(c.id)) older.add(c.id);
        // Out of the main inbox, or noise: as the Unread tab counts them, at first run too.
        const out = this.isNoise(c.id) ? { ...c, isLowPriority: true } : c;
        const seen = this.store.see(out);
        if (seen.needsRead) this.readSoon(c.id, c.lastActivity);
        if (seen.changed || (!had && this.store.isTodo(c.id)) || (!firstRun && this.store.known(c.id) !== knew)) {
          if (!firstRun || told++ < FIRST_RUN_EVENTS_PER_PAGE) this.tell(c.id);
        }
      }
      cursor = r.next;
      if (!cursor) break;
      // A first run goes through every chat; catching up only as far as what is new (a page with nothing since then: Beeper lists newest first).
      if (!firstRun && (!stillNew || page >= MAX_BEEPER_SYNC_PAGES)) break;
      await pause(this.o.pauseMs?.beeper ?? BEEPER_PAGE_PAUSE_MS);
    }
    if (this.stopped) return;
    this.store.finishFirstRun(BEEPER_SOURCE, older.size);
    this.store.markSynced(BEEPER_SOURCE, started);
  }

  private async syncGmail(s: TodoGmail) {
    const key = sourceOf(gmailChatID(s.email, "x"));
    const started = this.now();
    const state = this.store.meet(key);
    if (!state.done) {
      // Removed meanwhile (added again or not): what this walk was for is gone.
      const live = () => !this.stopped && this.store.cutNow(key) === state.cut;
      const mark = (ids: string[]) => {
        let told = 0;
        for (const id of ids) {
          const chatID = gmailChatID(s.email, id);
          if (this.leftOut(chatID)) continue;
          if (this.store.markUnreadAtFirstRun(chatID) && told++ < FIRST_RUN_EVENTS_PER_PAGE) this.tell(chatID);
        }
      };
      // What the cut leaves out, each once, however the list moves under the walk. Not on disk until the walk ends: a restart counts again.
      const older = new Set<string>();
      if (state.cut === undefined) {
        if (!(await this.walkIds(s, Q_UNREAD_PRIMARY, live, mark))) return;
      } else {
        const found = new Set<string>();
        const since = (ids: string[]) => {
          mark(ids);
          for (const id of ids) found.add(id);
        };
        if (!(await this.walkIds(s, qSinceCut(state.cut), live, since))) return;
        // Unread before the cut and active since it, which no one message says: what is both. The rest of that walk is what the cut leaves out. It costs what a first run cost before there was a cut.
        const active = new Set<string>();
        if (!(await this.walkIds(s, qActiveSinceCut(state.cut), live, (ids) => ids.forEach((id) => found.has(id) || active.add(id))))) return;
        const before = (ids: string[]) => {
          mark(ids.filter((id) => active.has(id)));
          for (const id of ids) {
            const chatID = gmailChatID(s.email, id);
            if (!active.has(id) && !found.has(id) && !this.store.heardOf(chatID) && !this.leftOut(chatID)) older.add(id);
          }
        };
        if (!(await this.walkIds(s, qBeforeCut(state.cut), live, before))) return;
      }
      this.store.finishFirstRun(key, older.size);
      this.store.markSynced(key, started);
      this.gmailLooked.set(key, started);
      this.o.log?.("todo: first run of a Gmail account finished");
      return;
    }
    if (started - (this.gmailLooked.get(key) ?? Number.NEGATIVE_INFINITY) < GMAIL_SYNC_GAP_MS) return;
    this.gmailLooked.set(key, started);
    let cursor: string | null = null;
    for (let page = 0; page < MAX_GMAIL_SYNC_PAGES && !this.stopped; page++) {
      const r: { items: ChatSummary[]; next: string | null } = await s.primaryPage(cursor, this.ctx());
      let stillNew = false;
      for (const c of r.items) {
        if ((c.lastActivity ? Date.parse(c.lastActivity) : 0) >= state.synced - SYNC_MARGIN_MS) stillNew = true;
        this.see(c);
      }
      cursor = r.next;
      if (!cursor || !stillNew) break;
    }
    if (!this.stopped) this.store.markSynced(key, started);
  }

  /** Pages of a Gmail query, ids only, a second apart. False: `live` said the walk is over before its end. */
  private async walkIds(s: TodoGmail, q: string, live: () => boolean, page: (ids: string[]) => boolean | void): Promise<boolean> {
    let token: string | null = null;
    for (;;) {
      const r: { ids: string[]; next: string | null } = await s.threadIDs(q, token, this.ctx());
      if (!live() || page(r.ids) === false) return false;
      token = r.next;
      if (!token) return true;
      await pause(this.o.pauseMs?.gmail ?? GMAIL_FIRST_RUN_PAUSE_MS);
    }
  }

  /** Add older unread, when asked and the first run is over: Beeper's pages, as its first run walks them. */
  private async addOlderBeeper() {
    if (!this.o.beeperPage || !this.olderWanted(BEEPER_SOURCE)) return;
    let cursor: string | null = null;
    while (!this.stopped) {
      const r: { items: ChatSummary[]; next: string | null } = await this.o.beeperPage(cursor, this.ctx());
      if (this.stopped) return;
      let told = 0;
      const wanted = (c: ChatSummary) => this.store.isOlder(c) && !this.isNoise(c.id);
      for (const [i, c] of r.items.entries()) {
        if (!wanted(c)) continue;
        const added = this.store.markOlder(c.id);
        if (added === null) return this.olderNoRoom(BEEPER_SOURCE, r.items.slice(i).filter(wanted).length);
        if (!added) continue;
        // Its times and ids, as a list would have left them.
        this.store.see(c);
        if (told++ < FIRST_RUN_EVENTS_PER_PAGE) this.tell(c.id);
      }
      cursor = r.next;
      if (!cursor) return this.finishOlder(BEEPER_SOURCE);
      await pause(this.o.pauseMs?.beeper ?? BEEPER_PAGE_PAUSE_MS);
    }
  }

  /** Add older unread, when asked and the first run is over: threads.list and ids only, a second apart, like Gmail's first run. */
  private async addOlderGmail(s: TodoGmail) {
    const key = sourceOf(gmailChatID(s.email, "x"));
    if (!this.olderWanted(key)) return;
    // Stopped, or the account removed meanwhile: nothing more of it.
    const live = () => !this.stopped && !!this.store.olderOf(key)?.asked;
    const ended = await this.walkIds(s, qBeforeCut(this.store.olderOf(key)!.cut), live, (ids) => {
      let told = 0;
      for (const [i, id] of ids.entries()) {
        const chatID = gmailChatID(s.email, id);
        if (this.leftOut(chatID)) continue;
        const added = this.store.markOlder(chatID);
        if (added === null) {
          this.olderNoRoom(key, ids.slice(i).filter((rest) => !this.store.heardOf(gmailChatID(s.email, rest)) && !this.leftOut(gmailChatID(s.email, rest))).length);
          return false;
        }
        if (added && told++ < FIRST_RUN_EVENTS_PER_PAGE) this.tell(chatID);
      }
    });
    if (ended) this.finishOlder(key);
  }

  private olderWanted(key: string): boolean {
    const o = this.store.olderOf(key);
    return !!o?.asked && o.done && !this.stopped;
  }

  private finishOlder(key: string) {
    this.store.finishOlder(key);
    this.olderTries = 0;
    this.o.log?.(`todo: older unread of ${sourceName(key)} added`);
  }

  /** To do fills the bound: it is said (todoFull), and the source has its line back. Not for a walk to try again by itself: only the owner can make room. `rest`: what of its page the walk could not take. */
  private olderNoRoom(key: string, rest: number) {
    this.store.releaseOlder(key, rest);
    this.olderTries = 0;
    this.o.log?.(`todo: no room for the rest of the older unread of ${sourceName(key)}`);
  }

  /** A walk that Add older unread is waiting for failed: said, with nothing of the account or its mail, and tried again soon. The half-hourly sync would leave the page saying "Adding" for that long. */
  private olderHeldUp(key: string) {
    if (this.stopped || !this.store.olderOf(key)?.asked) return;
    this.o.log?.(`todo: adding the older unread of ${sourceName(key)} failed for now, it will be tried again`);
    if (this.olderRetry) return;
    const wait = Math.min((this.o.pauseMs?.olderRetry ?? OLDER_RETRY_MS) * 2 ** this.olderTries++, SYNC_EVERY_MS);
    this.olderRetry = setTimeout(() => {
      this.olderRetry = null;
      void this.sync();
    }, wait);
    (this.olderRetry as { unref?: () => void }).unref?.();
  }
}
