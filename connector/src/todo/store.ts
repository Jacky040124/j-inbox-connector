// The To do store (file todo.json): which chats the owner has not handled in J-Inbox, apart from the
// network's read state (protocol README "To do"). All of it stays on this computer; the cloud only relays
// the one bit. One JSON file, mode 0600 in a 0700 directory, written atomically; at most MAX_TODO_ENTRIES.
//
// One idea carries it: a source (Beeper, each Gmail account) has a `since`, the time it was first seen,
// and a chat has `others`, the newest message from someone else known here. A message is new, and makes the
// chat To do, only if it is later than both. So a chat the store has never heard of is handled unless someone
// wrote after `since`, and most chats need no entry at all: nothing has to load every chat (see tracker.ts for the
// first run, which finds what was unread at that moment).
//
// A source also has a `cut`, TODO_FIRST_RUN_DAYS before it was first seen, written with it and never moved (`since` can be lifted by
// eviction, so nothing is worked out from it): what its first run makes To do is what is unread and was active since then. What is
// older is left out until the owner adds it (`older`), and how many that is was counted by the first run (`olderLeft`). A source whose first run ended before there was a cut has none, and keeps none: nothing was left out of it.
//
// A source removed in this run stays out of the store until something that knows the account is live asks for it (`meet`): what was still in flight when it was removed changes nothing.
import { createHash } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { TODO_FIRST_RUN_DAYS, chatID as chatIDSchema, parse, parseGmailChatID, type ChatSummary, type MessageItem } from "@j-inbox/protocol";
import { writeAtomic } from "../config.ts";

export const MAX_TODO_ENTRIES = 5000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCES = 64;
/** Handled chats per source a later Add older unread must not bring back, as short hashes: the oldest go first. */
const MAX_FORGOT = MAX_TODO_ENTRIES;
/** What observations wait before they go to disk: a burst is one write, and what a crash loses is seen again on the next start. */
const WRITE_DELAY_MS = 1_000;
/** Messages per chat whose ids are remembered (the newest), as short hashes: the same one seen again is not new, whatever its clock says. */
const MAX_IDS = 32;
/** The owner's Done on a chat the store has never heard of, with nothing said of what was on screen: this far back from this computer's clock (it may be fast). */
const CLOCK_MARGIN_MS = 5 * 60_000;
/** Catching up looks this far before where it last looked (tracker.ts): the same margin here. */
const SYNC_MARGIN_MS = 60_000;
/** A read just after a message was heard may simply have started before it: not yet a sign the message is gone. */
const READ_RACE_MS = 30_000;
/** Two NOT_FOUND answers count only this far apart: one moment of a source's trouble is not a chat gone. */
export const GONE_APART_MS = 10 * 60_000;
const FIRST_RUN_WINDOW_MS = TODO_FIRST_RUN_DAYS * 24 * 3_600_000;

export const BEEPER_SOURCE = "beeper";
/** Which source a chat belongs to: its Gmail account, or Beeper. */
export function sourceOf(chatID: string): string {
  const g = parseGmailChatID(chatID);
  return g ? `gmail:${g.email}` : BEEPER_SOURCE;
}
const sourceKind = (key: string) => (key === BEEPER_SOURCE ? "Beeper" : "a Gmail account");

export type TodoEntry = {
  chatID: string;
  todo: boolean;
  /** Newest message from someone else known here (epoch ms; 0: none known). */
  others: number;
  /** Short hashes of the messages from someone else known here, newest last. */
  ids?: string[];
  /** The chat's last activity when last accounted for (epoch ms): activity later than this may hide someone's message. */
  activity: number;
  /** `others` is what the owner's screen showed, with no id known: another message at that same time cannot be told from it. */
  screen?: boolean;
  /** Out of the main inbox when last seen. */
  archived: boolean;
  low: boolean;
  /** Something exact said it is not in the main inbox (a walk's end, a look, its labels): a To do walk need not look for it. Until it next changes. */
  out?: boolean;
  /** NOT_FOUND answers so far, and when the last came: a chat is forgotten only when it repeats. */
  gone?: number;
  goneAt?: number;
  /** The source said the chat was deleted: out of the counts and events until it is seen again; what is known about it is kept. */
  deleted?: boolean;
  /** Last change (epoch ms). */
  at: number;
};

type SourceState = {
  /** First seen: nothing from before this makes a chat To do by itself. Moves up only past what has been looked at. */
  since: number;
  /** The first run found what was unread (it never runs again for this source). */
  done: boolean;
  /** Everything active up to here has been looked at. */
  synced: number;
  /** To do chats had to be left out to stay within the bound: said to the owner until there is room again. */
  full?: boolean;
  /** Epoch ms: the first run leaves out unread chats whose activity is older than this. One instant, set once. Absent: a first run finished before this rule, which left nothing out. */
  cut?: number;
  /** The owner's "Add older unread": asked for (the walk resumes after a restart), or finished, which is for good. */
  older?: "asked" | "added";
  /** Short hashes of handled chats that went for the bound while an older walk could still come, each once: it must not bring them back. Goes when that walk is over. */
  forgot?: string[];
  /** About this many older unread are left out: what the first run counted (tracker.ts), written with `done`, less what an older walk has taken in. Goes when a walk reaches its end. Absent: not known, the first run not being over or having ended before it counted. */
  olderLeft?: number;
};

/** What a chat says about the newest message from someone else: when (null: nothing), whether that is all there is to know, and which messages those are. */
export type OthersFact = { at: number | null; id?: string; ids?: readonly string[]; exact: boolean };

// A Gmail thread knows exactly (every message's labels are in its metadata): its mapping leaves that here,
// next to the ChatSummary, which has no room for it.
const threadFacts = new WeakMap<object, { at: number | null; ids: readonly string[] }>();
/** `ids`: the thread's messages from someone else, oldest first. */
export const noteThreadOthers = (chat: ChatSummary, at: number | null, ids: readonly string[] = []) => void threadFacts.set(chat, { at, ids });
// A preview Beeper hides (iMessage's tapback as a message of its own) stays as the row's line, and is no message.
const hiddenPreviews = new WeakSet<object>();
export const noteHiddenPreview = (m: MessageItem) => void hiddenPreviews.add(m);

/**
 * Someone writing. A reaction is not; a NOTICE is, because bridges send bots' messages that way (Jacky, 2026-11-04: to be
 * checked on real data). Messages Beeper hides never get here as messages (beeper-map.ts), and no other system line can be told apart.
 */
export const isFromOthers = (m: MessageItem) => !m.isSender && m.type !== "REACTION";

export function othersFact(c: ChatSummary): OthersFact {
  const t = threadFacts.get(c);
  if (t) return { at: t.at, ...(t.ids.length ? { id: t.ids.at(-1)!, ids: t.ids } : {}), exact: true };
  const p = c.preview;
  if (p && isFromOthers(p) && !hiddenPreviews.has(p)) {
    const at = Date.parse(p.timestamp);
    if (Number.isFinite(at)) return { at, id: p.id, exact: true };
  }
  return { at: null, exact: false };
}

const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
};
const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const cutOf = (firstSeen: number) => Math.max(0, firstSeen - FIRST_RUN_WINDOW_MS);
const isUnread = (c: ChatSummary) => c.unreadCount > 0 || c.isMarkedUnread === true;
/** Older than the source's cut, by a time known (0: not known, which is never hidden). */
const beforeCut = (s: SourceState, at: number) => s.cut !== undefined && at !== 0 && at < s.cut;
const idHash = (id: string) => createHash("sha256").update(id).digest("base64url").slice(0, 12);
const knows = (e: TodoEntry | undefined, id: string | undefined) => id !== undefined && !!e?.ids?.includes(idHash(id));
/**
 * These messages are known here: `ids` oldest first, as a read's page or a thread has them, so the newest is last. What is kept is the newest
 * MAX_IDS, oldest first. A busy chat's page has more than that, and what goes must be its oldest, never the one `others` stands for: else the
 * next look at that one takes it for another message at the same time, and a Done chat is To do again (task #57: inbox.db reads 50). So the
 * page goes in its own order, the ids already kept included; what was kept after the last of those (heard while the read was out) stays after it.
 */
function remember(e: TodoEntry, ids: readonly (string | undefined)[]): boolean {
  const page = [...new Set(ids.filter((id): id is string => id !== undefined).map(idHash))];
  if (!page.length) return false;
  const kept = e.ids ?? [];
  const onPage = new Set(page);
  let last = -1;
  kept.forEach((h, i) => {
    if (onPage.has(h)) last = i;
  });
  const next = [...kept.slice(0, last === -1 ? kept.length : last).filter((h) => !onPage.has(h)), ...page, ...(last === -1 ? [] : kept.slice(last + 1))].slice(-MAX_IDS);
  if (next.length === kept.length && next.every((h, i) => h === kept[i])) return false;
  e.ids = next;
  return true;
}

export type SeeResult = { changed: boolean; /** Someone may have written before the owner's latest: read the chat. */ needsRead: boolean };

export class TodoStore {
  /** Insertion order: least recently changed first. */
  private entries = new Map<string, TodoEntry>();
  private sources = new Map<string, SourceState>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** The file is of a version this build does not know, or could not be read: it is left as it is, and To do goes on in memory. */
  private frozen = false;
  /** Sources forgotten in this run: nothing makes them known again but `meet`. Not on disk: a restart has nothing in flight. */
  private removed = new Set<string>();
  private readonly now: () => number;
  private readonly max: number;
  /** A To do chat had to leave for the bound (the tracker tells open pages). */
  onDrop: ((chatID: string) => void) | null = null;

  constructor(private readonly o: { path?: string; now?: () => number; max?: number; writeDelayMs?: number; log?: (msg: string) => void } = {}) {
    this.now = o.now ?? Date.now;
    this.max = o.max ?? MAX_TODO_ENTRIES;
    if (o.path) this.load(o.path);
  }

  private log(msg: string) {
    this.o.log?.(msg);
  }

  /** What a damaged file held is not known any more: it is put aside, and the first run starts again with a new cut, finding what is unread and active since (read chats' To do cannot be found again: it is said). */
  private setAside(path: string, why: string) {
    const aside = `${path}.corrupt-${this.now()}`;
    try {
      renameSync(path, aside);
      this.log(`todo: the To do file could not be read (${why}). Kept as ${aside}; its first run starts again: what is unread and active in the last ${TODO_FIRST_RUN_DAYS} days becomes To do, older unread can be added in Settings.`);
    } catch {
      this.frozen = true;
      this.log(`todo: the To do file could not be read (${why}), nor moved aside. It is left as it is; To do is in memory only until this is fixed.`);
    }
    this.entries.clear();
    this.sources.clear();
  }

  private load(path: string) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      this.frozen = true;
      this.log("todo: the To do file could not be opened. It is left as it is; To do is in memory only until this is fixed.");
      return;
    }
    if (raw.length > MAX_FILE_BYTES) return this.setAside(path, "too large");
    let j: any;
    try {
      j = JSON.parse(raw);
    } catch {
      return this.setAside(path, "not JSON");
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) return this.setAside(path, "not an object");
    if (j.v !== 1) {
      this.frozen = true;
      this.log(`todo: the To do file has version ${typeof j.v === "number" ? j.v : "unknown"}, which this build does not know. It is left as it is; To do is in memory only until the connector is updated.`);
      return;
    }
    if (!Array.isArray(j.sources) || !Array.isArray(j.entries)) return this.setAside(path, "wrong shape");
    let skipped = 0;
    let unset = false;
    for (const s of j.sources.slice(0, MAX_SOURCES)) {
      if (!Array.isArray(s) || typeof s[0] !== "string" || s[0].length > 400 || !s[1] || !isTime(s[1].since) || !isTime(s[1].synced)) {
        skipped++;
        continue;
      }
      const done = s[1].done === true;
      // A first run under way when this rule came: its cut is set now, from the first sight it knows, and stays. One that is done has left nothing out and never gets one.
      const cut = isTime(s[1].cut) ? s[1].cut : done ? undefined : cutOf(s[1].since);
      const older = s[1].older === "asked" || s[1].older === "added" ? s[1].older : undefined;
      if (cut !== s[1].cut && cut !== undefined) unset = true;
      // Once each, in its last place (a file may hold copies), before the bound: a copy must not take a real one's room.
      const forgot = cut !== undefined && older !== "added" && Array.isArray(s[1].forgot) ? [...new Set<string>(s[1].forgot.filter((h: unknown): h is string => typeof h === "string" && h.length <= 16).reverse())].reverse().slice(-MAX_FORGOT) : [];
      const olderLeft = cut !== undefined && older !== "added" && isTime(s[1].olderLeft) ? s[1].olderLeft : undefined;
      this.sources.set(s[0], { since: s[1].since, done, synced: s[1].synced, ...(s[1].full === true ? { full: true } : {}), ...(cut !== undefined ? { cut } : {}), ...(cut !== undefined && older ? { older } : {}), ...(forgot.length ? { forgot } : {}), ...(olderLeft !== undefined ? { olderLeft } : {}) });
    }
    for (const e of j.entries.slice(-this.max)) {
      const ok = cleanEntry(e);
      if (ok) this.entries.set(ok.chatID, ok);
      else skipped++;
    }
    skipped += Math.max(0, j.entries.length - this.max);
    if (skipped) this.log(`todo: ${skipped} damaged or surplus records in the To do file were left out.`);
    if (unset) this.later();
  }

  private save() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    if (!this.o.path || this.frozen) return;
    writeAtomic(this.o.path, JSON.stringify({ v: 1, sources: [...this.sources], entries: [...this.entries.values()] }));
  }

  /** Observations go to disk a moment later, together; a full disk loses only what the next start sees again. */
  private later() {
    this.dirty = true;
    if (!this.o.path || this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.o.writeDelayMs ?? WRITE_DELAY_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Write what waits, now (the service's stop). Never throws. */
  flush() {
    if (!this.dirty) return;
    try {
      this.save();
    } catch {}
  }

  /**
   * A source's state, made (and on disk at once: this moment is what later messages are measured by) when first asked.
   * `heard`: what makes it known is a message from someone, at that time: that message counts.
   */
  private source(key: string, heard?: number): SourceState {
    let s = this.sources.get(key);
    if (!s) {
      const at = this.now();
      s = { since: heard !== undefined ? Math.min(at, heard - 1) : at, done: false, synced: at, cut: cutOf(at) };
      this.sources.set(key, s);
      try {
        this.save();
      } catch {}
    }
    return s;
  }

  /** Make the source known now, if it is not (its first run starts from this moment). Only for one known to be live: a removed one comes back by this and nothing else. */
  meet(key: string): { since: number; done: boolean; synced: number; cut?: number } {
    this.removed.delete(key);
    const { since, done, synced, cut } = this.source(key);
    return { since, done, synced, ...(cut !== undefined ? { cut } : {}) };
  }

  /** The source's cut as it stands, without making it known (a walk's check that what it set out for is still there). */
  cutNow(key: string): number | undefined {
    return this.sources.get(key)?.cut;
  }

  /** `olderLeft`: what its walk counted that the cut leaves out. */
  finishFirstRun(key: string, olderLeft?: number) {
    if (this.removed.has(key)) return;
    const s = this.source(key);
    if (s.done) return;
    s.done = true;
    if (s.cut !== undefined && olderLeft !== undefined) s.olderLeft = olderLeft;
    this.later();
  }

  markSynced(key: string, at: number) {
    if (this.removed.has(key)) return;
    const s = this.source(key);
    if (at > s.synced) (s.synced = at), this.later();
  }

  /** The newest time before which a message can no longer be new in this chat, by its time alone. */
  private floor(s: SourceState, e: TodoEntry | undefined): number {
    return Math.max(s.since, e?.others ?? 0);
  }

  /** Stored, as the newest change. False: there was no room for it, and it is not stored (left out, and said). */
  private put(e: TodoEntry): boolean {
    e.at = this.now();
    this.entries.delete(e.chatID);
    this.entries.set(e.chatID, e);
    if (this.entries.size > this.max) this.evict(e);
    this.later();
    return this.entries.get(e.chatID) === e;
  }

  /**
   * Over the bound. Fair per source: what goes is the largest source's. A handled chat first, whichever the source, since
   * all that can happen is that it comes back wrongly as To do: its source's `since` moves up, but only past what has been looked at, so nothing
   * unseen is lost by it, and an older walk still to come is told not to bring it back (`forgot`). Then a To do chat out of the inbox, then the oldest To do of the largest source. A To do that goes is logged, told to open pages
   * and said to the owner (todoFull); `since` does not move for it, so it comes back when next seen and there is room.
   */
  private evict(incoming: TodoEntry) {
    while (this.entries.size > this.max) {
      const counts = new Map<string, number>();
      for (const e of this.entries.values()) {
        const k = sourceOf(e.chatID);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const largest = [...counts].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
      let handled: TodoEntry | undefined;
      let handledAny: TodoEntry | undefined;
      let outside: TodoEntry | undefined;
      let oldest: TodoEntry | undefined;
      for (const e of this.entries.values()) {
        const mine = sourceOf(e.chatID) === largest;
        if (!e.todo) {
          handledAny ??= e;
          if (mine) handled ??= e;
          continue;
        }
        if (!mine) continue;
        if (e.archived || e.low) outside ??= e;
        // The oldest message goes; among those the time of which is not known (a first run's marks), the last found: walks go newest first.
        if (!oldest || e.others <= oldest.others) oldest = e;
      }
      const victim = handled ?? handledAny ?? outside ?? oldest!;
      this.entries.delete(victim.chatID);
      if (!victim.todo) {
        const s = this.source(sourceOf(victim.chatID));
        const lifted = Math.min(victim.others, s.synced - SYNC_MARGIN_MS);
        if (lifted > s.since) s.since = lifted;
        if (s.cut !== undefined && s.older !== "added") {
          // Once each, the same chat again as the newest: it may go over and over (one with nothing from anyone, at every list), and must not push out a real Done.
          const h = idHash(victim.chatID);
          s.forgot = [...(s.forgot ?? []).filter((x) => x !== h), h].slice(-MAX_FORGOT);
        }
        continue;
      }
      const s = this.source(sourceOf(victim.chatID));
      if (!s.full) this.log(`todo: To do has reached its limit of ${this.max} chats; older ones of ${sourceKind(sourceOf(victim.chatID))} are being left out, and the owner is told.`);
      s.full = true;
      if (victim !== incoming) this.onDrop?.(victim.chatID);
    }
  }

  /** To do chats had to be left out, and there is no room yet. */
  overflowed(): boolean {
    for (const s of this.sources.values()) if (s.full) return true;
    return false;
  }

  /** There is room (the owner's Done, an account removed, an older walk over): what was left out comes back as it is seen (older unread: from Settings' line), so nothing more needs saying. Only To do chats fill the bound: a handled one makes way for any of them. */
  private roomAgain() {
    if (!this.overflowed()) return;
    let todo = 0;
    for (const e of this.entries.values()) if (e.todo) todo++;
    if (todo > this.max * 0.9) return;
    for (const s of this.sources.values()) delete s.full;
  }

  /**
   * A chat as a list or a read describes it. `exactScope`: the answer knows whether it is in the main inbox (a single
   * Gmail thread has only a hint of its tab: the hint decides nothing about a chat the store knows). True in `changed`: its To do flag moved.
   */
  see(c: ChatSummary, fact: OthersFact = othersFact(c), o: { exactScope?: boolean } = {}): SeeResult {
    const exactScope = o.exactScope ?? true;
    if (this.removed.has(sourceOf(c.id))) return { changed: false, needsRead: false };
    const s = this.source(sourceOf(c.id));
    const e = this.entries.get(c.id);
    const now = this.now();
    // Never later than now: a sender's clock (or a hostile timestamp) must not push away what comes next.
    const at = fact.at === null ? null : Math.min(fact.at, now);
    const activity = Math.min(ms(c.lastActivity), now);
    const archived = c.isArchived === true;
    const low = exactScope || !e ? c.isLowPriority === true : e.low;
    const known = knows(e, fact.id);
    // Its time is past what is known, or (the same time, or a chat first seen at a time) it is another message.
    const isNew = at !== null && !known && at > s.since && (at > (e?.others ?? 0) || (at === e?.others && fact.id !== undefined && !!e?.ids?.length && !e.screen));
    const needsRead = !fact.exact && activity > Math.max(s.since, e?.activity ?? 0);
    if (!e) {
      // First sight, while the first run has not finished: the same rule it applies. Unread now, in the main inbox, and active since the cut: To do.
      const firstRun = !s.done && !archived && !low && isUnread(c) && !beforeCut(s, Math.max(activity, at ?? 0));
      const todo = isNew || firstRun;
      // Nothing to remember about a chat nobody wrote in since `since` and that is not To do: most chats.
      if (!todo && activity <= s.since && (at === null || at <= s.since)) return { changed: false, needsRead: false };
      const fresh: TodoEntry = { chatID: c.id, todo, others: at ?? 0, activity: fact.exact ? activity : 0, archived, low, ...(archived || (exactScope && low) ? { out: true } : {}), at: now };
      remember(fresh, [...(fact.ids ?? []), fact.id]);
      const kept = this.put(fresh);
      return { changed: todo && kept, needsRead };
    }
    let dirty = e.archived !== archived || e.low !== low;
    if (e.gone !== undefined || e.deleted) {
      delete e.gone;
      delete e.goneAt;
      delete e.deleted;
      dirty = true;
    }
    const wasOut = e.archived;
    e.archived = archived;
    e.low = low;
    const out = exactScope ? archived || low : archived || (e.out === true && !wasOut);
    if (!!e.out !== out) {
      if (out) e.out = true;
      else delete e.out;
      dirty = true;
    }
    const changed = isNew && !e.todo;
    if (isNew) (e.todo = true), (dirty = true);
    if (at !== null && !known && at > e.others) {
      e.others = at;
      delete e.screen;
      dirty = true;
    }
    if (at !== null && at === e.others && fact.id !== undefined && e.screen) {
      // The one on the owner's screen, named at last.
      delete e.screen;
      dirty = true;
    }
    // The newest known, and now its true time (Gmail's events carry only the time of the poll that found it).
    if (at !== null && known && fact.exact && at < e.others && e.ids?.at(-1) === idHash(fact.id!)) {
      e.others = at;
      dirty = true;
    }
    if (remember(e, [...(fact.ids ?? []), fact.id])) dirty = true;
    if (fact.exact && activity > e.activity) (e.activity = activity), (dirty = true);
    if (isNew) this.put(e);
    else if (dirty) this.later();
    return { changed, needsRead };
  }

  /**
   * A first page of a read answered. It accounts for the chat's last activity only if it reached the chat's start (`complete`, the default
   * for a page that says nothing), or holds someone else's message: a page of only the owner's says nothing about before it.
   */
  seeRead(c: ChatSummary, items: readonly MessageItem[], o: { exactScope?: boolean; complete?: boolean } = {}): SeeResult {
    const e = this.entries.get(c.id);
    const now = this.now();
    const page = items.filter((m) => isFromOthers(m) && Number.isFinite(Date.parse(m.timestamp))).map((m) => ({ id: m.id, at: Date.parse(m.timestamp) })).sort((a, b) => a.at - b.at);
    // One the store has not met is judged first: a known one dated in the future must not hide it.
    const unknown = page.filter((m) => !knows(e, m.id));
    const lead = unknown.at(-1) ?? page.at(-1);
    const thread = threadFacts.get(c);
    const ids = [...(thread?.ids ?? []), ...page.map((m) => m.id)];
    let fact: OthersFact;
    if (lead) fact = { at: lead.at, id: lead.id, ids, exact: true };
    else if (thread) fact = { at: thread.at, ...(thread.ids.length ? { id: thread.ids.at(-1)! } : {}), ids, exact: true };
    else fact = { at: null, exact: o.complete ?? true };
    if (lead && thread && thread.at !== null && thread.at > lead.at) fact = { at: thread.at, id: thread.ids.at(-1)!, ids, exact: true };
    const r = this.see(c, fact, { exactScope: o.exactScope ?? true });
    // What the store took for the newest is not on the first page: its time was an estimate, or it was deleted. The source's word stands, unless the read may have started before it came.
    const after = this.entries.get(c.id);
    const newest = page.at(-1)?.at ?? thread?.at ?? null;
    if (after && newest !== null && Math.min(newest, now) < after.others) {
      const last = after.ids?.at(-1);
      const onPage = last !== undefined && page.some((m) => idHash(m.id) === last);
      if (onPage || now - after.at >= READ_RACE_MS) {
        after.others = Math.min(newest, now);
        this.later();
      }
    }
    return r;
  }

  /**
   * Someone else wrote at `at` (an event: no chat described). `low`, `archived`: what the source says of where it is now; `out`: and that is exact.
   * `ids`: the event's messages. All known: seen before, whatever the time says. Any new one is new even at or before the newest known, as long as it is after `since`.
   * True: the flag moved.
   */
  noteOthers(chatID: string, at: number, o: { low?: boolean; archived?: boolean; out?: boolean; ids?: readonly string[] } = {}): boolean {
    const now = this.now();
    const when = Math.min(at, now);
    if (this.removed.has(sourceOf(chatID))) return false;
    const s = this.source(sourceOf(chatID), when);
    const e = this.entries.get(chatID);
    const ids = o.ids ?? [];
    if (ids.length && ids.every((id) => knows(e, id))) return false;
    if (!(when > this.floor(s, e)) && !(ids.length && e && when > s.since && !(when === e.others && e.screen))) return false;
    const changed = !e?.todo;
    const next: TodoEntry = { ...e, chatID, todo: true, others: Math.max(when, e?.others ?? 0), activity: e?.activity ?? 0, archived: o.archived ?? e?.archived ?? false, low: o.low ?? e?.low ?? false, at: 0 };
    delete next.gone;
    delete next.goneAt;
    delete next.deleted;
    delete next.out;
    delete next.screen;
    if (o.out) next.out = true;
    remember(next, ids);
    return this.put(next) && changed;
  }

  /** The first run found this thread unread in the main inbox. An entry already there is what happened since: it stands. */
  markUnreadAtFirstRun(chatID: string): boolean {
    if (this.entries.has(chatID) || this.removed.has(sourceOf(chatID))) return false;
    return this.put({ chatID, todo: true, others: 0, activity: 0, archived: false, low: false, at: 0 });
  }

  /** Where a source's older unread stand: null when it has none to speak of (not met; its first run left nothing out; already added). */
  olderOf(key: string): { cut: number; asked: boolean; done: boolean } | null {
    const s = this.sources.get(key);
    return s?.cut === undefined || s.older === "added" ? null : { cut: s.cut, asked: s.older === "asked", done: s.done };
  }

  /** Sources Add older unread is on its way for, whatever else can be said of them. */
  olderAsked(): string[] {
    return [...this.sources].filter(([, s]) => s.older === "asked").map(([key]) => key);
  }

  /** Something is known about this chat, here or (it went for the bound, handled) in its source's `forgot`: Add older unread leaves it as it is. */
  heardOf(chatID: string): boolean {
    return this.entries.has(chatID) || !!this.sources.get(sourceOf(chatID))?.forgot?.includes(idHash(chatID));
  }

  /** What Add older unread would bring in of a chat as a list shows it: nothing known about it, unread now, in the main inbox, last active before the cut. An unknown time is not older (the first run's rule takes it). */
  isOlder(c: ChatSummary): boolean {
    const s = this.sources.get(sourceOf(c.id));
    if (!s || this.heardOf(c.id) || c.isArchived === true || c.isLowPriority === true || !isUnread(c)) return false;
    const at = othersFact(c).at;
    return beforeCut(s, Math.max(Math.min(ms(c.lastActivity), this.now()), Math.min(at ?? 0, this.now())));
  }

  /** The owner asked for the older unread: on disk before it is answered, so a restart goes on with it. Throws if it cannot be written. False: there is nothing to bring in. */
  askOlder(key: string): boolean {
    const s = this.sources.get(key);
    if (s?.cut === undefined || s.older === "added") return false;
    if (s.older === "asked") return true;
    s.older = "asked";
    try {
      this.save();
    } catch (err) {
      delete s.older;
      throw err;
    }
    return true;
  }

  /**
   * Add older unread met this chat. What is known about it stands, so the owner's Done stays, gone for the bound or not. A handled chat makes room for it, as for any To do;
   * another To do does not: older than anything here, it is what is left out. True: To do now. null: To do has filled the bound, and it is said (todoFull).
   */
  markOlder(chatID: string): boolean | null {
    const key = sourceOf(chatID);
    if (this.removed.has(key) || this.heardOf(chatID)) return false;
    if (this.entries.size >= this.max && ![...this.entries.values()].some((e) => !e.todo)) {
      const s = this.source(key);
      if (!s.full) this.log(`todo: To do has reached its limit of ${this.max} chats; older ones of ${sourceKind(key)} are being left out, and the owner is told.`);
      s.full = true;
      this.later();
      return null;
    }
    const kept = this.put({ chatID, todo: true, others: 0, activity: 0, archived: false, low: false, at: 0 });
    // Only what it took: what the first run counted was neither known nor noise. Here, with the chat, so a restart in the middle of a walk loses neither.
    const s = this.sources.get(key);
    if (kept && s?.olderLeft) s.olderLeft--;
    return kept;
  }

  /** No room for the rest: not asked any more, so the owner has the line again, and presses it once there is room. `rest`: what of its page the walk could not take, the least that is left, however low the number has come. */
  releaseOlder(key: string, rest: number) {
    const s = this.sources.get(key);
    if (s?.older !== "asked") return;
    delete s.older;
    s.olderLeft = Math.max(rest, s.olderLeft ?? 0);
    this.later();
  }

  /** About how many older unread are left out, if that is known. */
  olderLeft(key: string): number | undefined {
    return this.sources.get(key)?.olderLeft;
  }

  /** The older unread are in: for good, whatever is unread later. A source forgotten meanwhile stays forgotten. */
  finishOlder(key: string) {
    const s = this.sources.get(key);
    if (!s || s.older === "added") return;
    s.older = "added";
    delete s.forgot;
    delete s.olderLeft;
    this.roomAgain();
    try {
      this.save();
    } catch {
      this.later();
    }
  }

  /**
   * The owner's own hand: on disk before it is answered. Throws if it cannot be written, with nothing changed. Answers the flag as it now stands.
   * `upTo`: for Done, the newest message on the owner's screen. If this computer knows something newer, the owner has not seen it: it stays To do.
   */
  setOwner(chatID: string, todo: boolean, o: { upTo?: number } = {}): boolean {
    if (this.removed.has(sourceOf(chatID))) return false;
    const before = this.entries.get(chatID);
    if (!todo && before?.todo && o.upTo !== undefined && before.others > o.upTo) return true;
    const copy = before ? { ...before } : undefined;
    const now = this.now();
    const upTo = o.upTo === undefined ? undefined : Math.min(o.upTo, now);
    // Never seen here, so what the chat holds is not known: what is there now is what the owner handled. Not by this computer's clock, which may be fast.
    const e: TodoEntry = before ?? { chatID, todo, others: todo ? 0 : (upTo ?? now - CLOCK_MARGIN_MS), ...(!todo ? { screen: true } : {}), activity: 0, archived: false, low: false, at: 0 };
    e.todo = todo;
    if (!todo && upTo !== undefined && upTo > e.others) (e.others = upTo), (e.screen = true);
    delete e.gone;
    delete e.goneAt;
    delete e.deleted;
    this.put(e);
    if (!todo) this.roomAgain();
    try {
      this.save();
    } catch (err) {
      if (copy) this.entries.set(chatID, copy);
      else this.entries.delete(chatID);
      throw err;
    }
    return this.entries.get(chatID)?.todo === true;
  }

  /** The computer archived or unarchived it just now (a list says so later): what events about it carry follows. */
  noteArchived(chatID: string, archived: boolean) {
    const e = this.entries.get(chatID);
    if (!e) return;
    if (e.archived !== archived) (e.archived = archived), this.later();
    if (archived && !e.out) (e.out = true), this.later();
    if (!archived && e.out && !e.low) delete e.out, this.later();
  }

  /** Its labels moved (Gmail): where it is is not known until it is next seen. */
  noteMoved(chatID: string) {
    const e = this.entries.get(chatID);
    if (e?.out) delete e.out, this.later();
  }

  /** The source said the chat was deleted. Out of counts and events at once; what is known stays until NOT_FOUND has said so twice, apart. */
  noteDeleted(chatID: string) {
    const e = this.entries.get(chatID);
    if (e && !e.deleted) (e.deleted = true), this.later();
  }

  /** The source answered NOT_FOUND. True: that was the second time, far enough apart, and it is forgotten. */
  noteNotFound(chatID: string): boolean {
    const e = this.entries.get(chatID);
    if (!e) return false;
    const now = this.now();
    if (e.gone !== undefined && now - (e.goneAt ?? 0) >= GONE_APART_MS) {
      this.entries.delete(chatID);
      this.later();
      return true;
    }
    if (e.gone === undefined) (e.gone = 1), (e.goneAt = now), this.later();
    return false;
  }

  /** Chats waiting for their second answer (a sync asks again). */
  awaitingSecondLook(): string[] {
    const now = this.now();
    const out: string[] = [];
    for (const e of this.entries.values()) if ((e.gone !== undefined && now - (e.goneAt ?? 0) >= GONE_APART_MS) || (e.deleted && e.gone === undefined)) out.push(e.chatID);
    return out;
  }

  isTodo(chatID: string): boolean {
    return this.entries.get(chatID)?.todo === true;
  }

  /** The chat as it stands now: stored, and in the main inbox. `hinted`: what the chat says of its tab is only a hint (a single Gmail thread): the store's word counts. */
  effective(c: ChatSummary, o: { hinted?: boolean } = {}): boolean {
    const e = this.entries.get(c.id);
    if (!e?.todo || c.isArchived === true) return false;
    return o.hinted ? !e.low : c.isLowPriority !== true;
  }

  /** What the store knows of a chat's tab, if it knows the chat. */
  scopeOf(chatID: string): { low: boolean } | null {
    const e = this.entries.get(chatID);
    return e ? { low: e.low } : null;
  }

  /** As far as this computer knows, without asking anyone: the flag an event about this chat should carry. */
  known(chatID: string): boolean {
    const e = this.entries.get(chatID);
    return !!e && e.todo && !e.archived && !e.low && !e.deleted;
  }

  /** To do chats of a source in the main inbox, as last seen (`skip`: noise). */
  count(key: string, skip?: (chatID: string) => boolean): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.todo && !e.archived && !e.low && !e.deleted && sourceOf(e.chatID) === key && !skip?.(e.chatID)) n++;
    return n;
  }

  /** Every stored To do chat of a source a walk of the main inbox could still meet: all but those proved to be elsewhere since they last changed. */
  toFind(key: string): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.todo && !e.out && !e.deleted && sourceOf(e.chatID) === key) n++;
    return n;
  }

  todoOf(key: string): string[] {
    const out: string[] = [];
    for (const e of this.entries.values()) if (e.todo && sourceOf(e.chatID) === key) out.push(e.chatID);
    return out;
  }

  /** A whole walk of the main inbox, and nothing narrower, reached its end without these: they are not in it. */
  notInInbox(key: string, found: ReadonlySet<string>) {
    for (const e of this.entries.values())
      if (e.todo && sourceOf(e.chatID) === key && !found.has(e.chatID)) {
        if (!e.archived) e.low = true;
        e.out = true;
        this.later();
      }
  }

  /** A Gmail account was removed: its chats and its first run go with it, and what was in flight for it brings nothing back (`meet` does, when it is connected again). */
  forgetSource(key: string) {
    for (const id of [...this.entries.keys()]) if (sourceOf(id) === key) this.entries.delete(id);
    this.sources.delete(key);
    this.removed.add(key);
    this.roomAgain();
    try {
      this.save();
    } catch {}
  }

  entry(chatID: string): Readonly<TodoEntry> | undefined {
    return this.entries.get(chatID);
  }

  get size(): number {
    return this.entries.size;
  }
}

function cleanEntry(v: any): TodoEntry | null {
  if (!v || typeof v !== "object" || !parse(chatIDSchema, v.chatID).ok || typeof v.todo !== "boolean" || !isTime(v.others) || !isTime(v.activity) || !isTime(v.at)) return null;
  const out: TodoEntry = { chatID: v.chatID, todo: v.todo, others: v.others, activity: v.activity, archived: v.archived === true, low: v.low === true, at: v.at };
  if (Array.isArray(v.ids)) out.ids = v.ids.filter((h: unknown): h is string => typeof h === "string" && h.length <= 16).slice(-MAX_IDS);
  if (v.out === true) out.out = true;
  if (v.screen === true) out.screen = true;
  if (v.deleted === true) out.deleted = true;
  if (isTime(v.gone) && isTime(v.goneAt)) (out.gone = v.gone), (out.goneAt = v.goneAt);
  return out;
}
