// inbox.db's first build: every chat in the window, of every source, read once in the background.
// Beeper: GET /v1/chats page by page (every inbox, newest first, to the end: a chat that is not
// archived is in the window whatever its age); Gmail, per account: the ids of the threads in the
// inbox or active in the window (`(in:inbox OR after:<window start>) -in:drafts`, a list call per
// 100 threads, no metadata). Each chat in the window is read through the ingest (InboxIngest, as a
// background job: whatever else wants a read goes first), one at a time, `paceMs` apart, and not
// while the connector answers requests (`busy`), so it never starves the owner. A chat the build
// meets outside the window that inbox.db keeps is removed.
// Progress is in inbox.db's meta table, per source (`build:beeper`, `build:gmail:<address>`): the
// next page's cursor, and done. A restart goes on from the page it was on; a chat already kept with
// the same activity is not read again (events keep it true). A source that fails (Beeper down, an
// account to reconnect) is tried again after a minute, doubling up to half an hour; the others go
// on. A Gmail account connected later gets its own build (kick); a removed one's progress is forgotten.
// The build is said to have started (meta `build.started`) when it is first created: from then on
// the connector says "sync.v1" in its hello, and pages see the window fill as the build goes.
import { gmailChatID, type ChatSummary } from "@j-inbox/protocol";
import type { RequestContext } from "../actions.ts";
import type { InboxDB } from "./db.ts";
import type { InboxIngest } from "./ingest.ts";
import { WINDOW_MS, inWindow } from "./window.ts";

export type GmailWalk = { email: string; threadIDs(q: string, pageToken: string | null, ctx: RequestContext): Promise<{ ids: string[]; next: string | null }> };

export type FirstBuildOptions = {
  db: InboxDB;
  ingest: Pick<InboxIngest, "refresh" | "removeChat" | "busy">;
  /** One page of Beeper's chat list as it is (actions.internals.chatsPage). */
  beeperPage?: (cursor: string | null, ctx: RequestContext) => Promise<{ items: ChatSummary[]; next: string | null }>;
  /** The Gmail accounts to build (not those that need reconnecting). */
  gmail?: () => GmailWalk[];
  /** Between two reads. Default 100 ms. */
  paceMs?: number;
  /** The connector is answering requests: wait. */
  busy?: () => boolean;
  retryMs?: number;
  maxRetryMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
};

type Progress = { cursor: string | null; done: boolean; q?: string };
type Source = { key: string; walk: (p: Progress) => Promise<void> };

const PAGE_TIMEOUT_MS = 30_000;

export class FirstBuild {
  private running = false;
  private again = false;
  private stopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private readonly now: () => number;

  constructor(private readonly o: FirstBuildOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Mark the build started (once, ever, for this inbox.db) and run what is left of it. */
  start() {
    if (!this.o.db.meta("build.started")) this.o.db.setMeta("build.started", new Date(this.now()).toISOString());
    this.kick();
  }

  /** The build has started (it may not be done): enough for "sync.v1". */
  get started(): boolean {
    return this.o.db.isOpen && !!this.o.db.meta("build.started");
  }

  /** Every source there is now is built. */
  get done(): boolean {
    return this.sources().every((s) => this.progress(s.key).done);
  }

  /** Run again: a new Gmail account, or a source that failed. */
  kick() {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.loop();
  }

  /** A removed Gmail account: its progress goes (connected again, it is built again). */
  forgetAccount(email: string) {
    if (this.o.db.isOpen) this.o.db.setMeta(`build:gmail:${email}`, null);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
  }

  private progress(key: string): Progress {
    try {
      const v = JSON.parse(this.o.db.meta(key) ?? "null");
      if (v && typeof v === "object" && typeof v.done === "boolean" && (v.cursor === null || typeof v.cursor === "string")) return v;
    } catch {}
    return { cursor: null, done: false };
  }

  private save(key: string, p: Progress) {
    if (this.o.db.isOpen) this.o.db.setMeta(key, JSON.stringify(p));
  }

  private sources(): Source[] {
    const out: Source[] = [];
    const beeperPage = this.o.beeperPage;
    if (beeperPage) out.push({ key: "build:beeper", walk: (p) => this.walk("build:beeper", p, async (cursor, ctx) => {
      const page = await beeperPage(cursor, ctx);
      return { items: page.items.map((c) => ({ chatID: c.id, chat: c })), next: page.next };
    }) });
    for (const g of this.o.gmail?.() ?? []) {
      const key = `build:gmail:${g.email}`;
      out.push({
        key,
        walk: (p) => {
          // The query is fixed when the walk starts: Gmail's page tokens belong to it.
          const q = p.q ?? `(in:inbox OR after:${Math.floor((this.now() - WINDOW_MS) / 1000)}) -in:drafts`;
          return this.walk(key, { ...p, q }, async (cursor, ctx) => {
            const page = await g.threadIDs(q, cursor, ctx);
            return { items: page.ids.map((id) => ({ chatID: gmailChatID(g.email, id) })), next: page.next };
          });
        },
      });
    }
    return out;
  }

  private async loop() {
    this.running = true;
    try {
      do {
        this.again = false;
        let failed = false;
        for (const s of this.sources()) {
          if (this.stopped || !this.o.db.isOpen) return;
          const p = this.progress(s.key);
          if (p.done) continue;
          try {
            await s.walk(p);
          } catch {
            failed = true;
            this.o.log?.(`inbox: the first build of a source failed; trying again later`);
          }
        }
        if (failed) this.retryLater();
        else this.failures = 0;
      } while (this.again && !this.stopped);
    } finally {
      this.running = false;
    }
    if (!this.stopped && this.done && this.o.db.isOpen && !this.o.db.meta("build.done")) {
      this.o.db.setMeta("build.done", new Date(this.now()).toISOString());
      this.o.log?.(`inbox: first build done (${this.o.db.chatCount()} chats)`);
    }
  }

  private retryLater() {
    clearTimeout(this.retryTimer);
    const wait = Math.min(this.o.maxRetryMs ?? 30 * 60_000, (this.o.retryMs ?? 60_000) * 2 ** this.failures++);
    this.retryTimer = setTimeout(() => this.kick(), wait);
  }

  private async pace() {
    await Bun.sleep(this.o.paceMs ?? 100);
    while (!this.stopped && (this.o.busy?.() || this.o.ingest.busy)) await Bun.sleep(50);
  }

  private async walk(key: string, start: Progress, page: (cursor: string | null, ctx: RequestContext) => Promise<{ items: { chatID: string; chat?: ChatSummary }[]; next: string | null }>) {
    let p = start;
    while (!p.done && !this.stopped) {
      await this.pace();
      const got = await page(p.cursor, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), deadline: this.now() + PAGE_TIMEOUT_MS });
      for (const it of got.items) {
        if (this.stopped || !this.o.db.isOpen) return;
        const had = this.o.db.chat(it.chatID);
        if (it.chat) {
          if (!inWindow(it.chat, this.now())) {
            if (had) this.o.ingest.removeChat(it.chatID);
            continue;
          }
          if (had && had.lastActivity === it.chat.lastActivity) continue;
        } else if (had) continue;
        await this.pace();
        await this.o.ingest.refresh(it.chatID, { background: true });
      }
      if (this.stopped) return;
      p = { ...p, cursor: got.next, done: got.next === null };
      this.save(key, p);
    }
  }
}
