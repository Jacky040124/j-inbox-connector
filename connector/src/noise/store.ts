// The noise store (file noise.json): the owner's definition of noise, the verdicts on conversations
// (Jev's and the owner's own), the owner's corrections as examples for Jev, and the latest decisions
// for Settings > Noise (protocol noise.ts). All of it stays on this computer; the cloud only relays
// it. One JSON file, mode 0600 in a 0700 directory, written atomically on every change; at most
// MAX_VERDICTS of Jev's and the list's verdicts (the least recently judged go first) and, apart, MAX_OWNER_VERDICTS of
// the owner's own (never pushed out by the others: their Not noise must keep winning), validated on load. While the definition
// is empty nothing of Jev's is applied.
//
// The noise list of senders ("noise-senders.v1") lives here too: exact addresses and whole domains, Gmail
// only, the owner's or learned. A conversation whose newest message is from someone other than the owner
// and from a sender on the list is noise, without Jev (source "sender"), whatever the definition and
// whether there is a Jev key. Only the newest message counts, and the owner's verdict on a conversation
// always wins. With no definition and no list, nothing is noise. The rest of it, which needs Gmail, is
// senders.ts. A file from before the list simply has none of it: the owner's verdicts then have no
// `sender`, which is what senders.ts looks up, once.
import { readFileSync } from "node:fs";
import {
  MAX_NOISE_DECISIONS,
  MAX_NOISE_LINE_LENGTH,
  MAX_NOISE_SENDERS,
  NOISE_SENDER_LEARN_AT,
  NOISE_SENDER_ORIGINS,
  NOISE_SOURCES,
  OWNER_NOISE_REASON,
  SENDER_NOISE_REASON,
  chatID as chatIDSchema,
  noiseDecision,
  noiseDefinition,
  noiseLines,
  parse,
  parseGmailChatID,
  parseNoiseSender,
  sanitizeLine,
  type ChatNoise,
  type ChatSummary,
  type NoiseDecision,
  type NoiseSender,
} from "@j-inbox/protocol";
import { writeAtomic } from "../config.ts";

export const MAX_VERDICTS = 5000;
/** The owner's own verdicts, kept apart from MAX_VERDICTS: only past this do the oldest of them go. */
export const MAX_OWNER_VERDICTS = 5000;
/** The owner's corrections Jev is shown as examples. */
export const MAX_EXAMPLES = 40;
export const MAX_EXAMPLE_LENGTH = 400;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Addresses the owner took off the list, kept so they are not learned again (the oldest go first). */
const MAX_REMOVED_SENDERS = 5000;
/** A verdict from the list reaches the file this soon: the next look at the conversation would make it again. */
const SAVE_SOON_MS = 1000;

export type Verdict = {
  chatID: string;
  noise: boolean;
  source: (typeof NOISE_SOURCES)[number];
  /** The definition line Jev chose (noise only). */
  reason?: string;
  confidence?: number;
  /** When it was decided (epoch ms). */
  at: number;
  /** The newest message Jev saw: the same one again is not asked about again. */
  lastMessageID?: string;
  /** The owner's corrections: a compact summary of the conversation, shown to Jev as an example. */
  example?: string;
  /**
   * The owner's verdict on a Gmail conversation: the one address everyone but the owner in it wrote from, as it was at the mark: what learning counts.
   * null: looked, and there is no such one (nobody else, or several: a group or a list teaches nothing). Absent: not looked up yet. A verdict from the list: the address it matched.
   */
  sender?: string | null;
  /** A verdict from the list: the entry that made it. */
  rule?: string;
};

/** What the lists and the sources need: is a conversation noise now (a definition or a list of senders)? */
export type NoiseView = { active(): boolean; isNoise(chatID: string): boolean; /** Noise by the list of senders (which can walk existing mail). */ isListNoise?(chatID: string): boolean };

/** One entry on the list, on disk. `wasRemoved`: its address had been taken off before the owner added it (Undo puts that back). */
export type SenderEntry = { value: string; kind: NoiseSender["kind"]; origin: NoiseSender["origin"]; at: number; wasRemoved?: true };

/** What the rule needs of a conversation: the newest message, and its sender unless that is the owner. */
export type RuleFacts = { chatID: string; lastMessageID: string; address: string | null; title?: string; network?: string };

type Decision = Omit<NoiseDecision, "at"> & { at: number };

export class NoiseStore implements NoiseView {
  private def = "";
  private lineList: string[] = [];
  /** Insertion order = least recently judged first. */
  private verdicts = new Map<string, Verdict>();
  private recent: Decision[] = [];
  /** Oldest first. */
  private senderList = new Map<string, SenderEntry>();
  private removedSenders = new Set<string>();
  /** Entries whose existing mail is still to be walked (senders.ts): a restart goes on with them. */
  private walks: string[] = [];
  private lookupsDone = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly max: number;

  private readonly maxOwner: number;

  constructor(private readonly o: { path?: string; now?: () => number; max?: number; maxOwner?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.max = o.max ?? MAX_VERDICTS;
    this.maxOwner = o.maxOwner ?? MAX_OWNER_VERDICTS;
    if (o.path) this.load(o.path);
  }

  private load(path: string) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    if (raw.length > MAX_FILE_BYTES) return;
    try {
      const j = JSON.parse(raw);
      if (!j || j.v !== 1) return;
      if (parse(noiseDefinition, j.definition).ok) this.setDef(j.definition);
      for (const v of Array.isArray(j.verdicts) ? j.verdicts.slice(-(this.max + this.maxOwner)) : []) {
        const ok = cleanVerdict(v);
        if (ok) this.verdicts.delete(ok.chatID), this.verdicts.set(ok.chatID, ok);
      }
      this.trim();
      for (const d of Array.isArray(j.decisions) ? j.decisions.slice(0, MAX_NOISE_DECISIONS) : []) {
        if (!d || typeof d !== "object" || !Number.isSafeInteger(d.at)) continue;
        if (parse(noiseDecision, { ...d, at: new Date(d.at).toISOString() }).ok) this.recent.push(d as Decision);
      }
      for (const e of Array.isArray(j.senders) ? j.senders.slice(0, MAX_NOISE_SENDERS) : []) {
        const ok = cleanEntry(e);
        if (ok) this.senderList.set(ok.value, ok);
      }
      for (const a of Array.isArray(j.removedSenders) ? j.removedSenders.slice(-MAX_REMOVED_SENDERS) : []) if (parseNoiseSender(a)?.value === a) this.removedSenders.add(a);
      for (const w of Array.isArray(j.senderWalks) ? j.senderWalks : []) if (this.senderList.has(w) && !this.walks.includes(w)) this.walks.push(w);
      this.lookupsDone = j.senderLookupsDone === true;
      // A verdict from an entry no longer there is no verdict.
      for (const [id, v] of this.verdicts) if (v.source === "sender" && !this.senderList.has(v.rule!)) this.verdicts.delete(id);
    } catch {
      // An unreadable file is ignored (and replaced on the next write): noise starts over, off.
    }
  }

  private save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.o.path) return;
    writeAtomic(this.o.path, JSON.stringify({ v: 1, definition: this.def, verdicts: [...this.verdicts.values()], decisions: this.recent, senders: [...this.senderList.values()], removedSenders: [...this.removedSenders], senderWalks: this.walks, senderLookupsDone: this.lookupsDone }));
  }

  /** A verdict from the list: many can come in one read of a list, and the file is written once for them. */
  private saveSoon() {
    if (!this.o.path || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.save();
      } catch {
        // The next change writes it all; a verdict from the list comes back at the next look anyway.
      }
    }, SAVE_SOON_MS);
    (this.saveTimer as { unref?: () => void }).unref?.();
  }

  /** On disk now, if anything waits (stopping). */
  flush() {
    if (!this.saveTimer) return;
    try {
      this.save();
    } catch {}
  }

  private setDef(text: string) {
    this.def = text;
    this.lineList = noiseLines(text);
  }

  get definition(): string {
    return this.def;
  }

  /** The definition's lines (protocol noiseLines). */
  lines(): string[] {
    return this.lineList;
  }

  /** The definition has a line or the list has an entry: there can be noise. */
  active(): boolean {
    return this.lineList.length > 0 || this.senderList.size > 0;
  }

  /** The definition has a line: Jev judges new activity, and its verdicts apply. */
  judging(): boolean {
    return this.lineList.length > 0;
  }

  /**
   * A new definition. The owner's corrections stay; so do Jev's verdicts whose line is still in
   * it (or that were not noise); a noise verdict whose line went is forgotten. Throws if it cannot be written.
   */
  setDefinition(text: string): void {
    const before = { def: this.def, verdicts: new Map(this.verdicts) };
    this.setDef(text);
    const lines = new Set(this.lineList);
    for (const [id, v] of this.verdicts) if (v.source === "jev" && v.noise && (!v.reason || !lines.has(v.reason))) this.verdicts.delete(id);
    try {
      this.save();
    } catch (e) {
      this.setDef(before.def);
      this.verdicts = before.verdicts;
      throw e;
    }
  }

  verdict(chatID: string): Verdict | undefined {
    return this.verdicts.get(chatID);
  }

  /** The owner decided this conversation: Jev does not judge it again. */
  isOwners(chatID: string): boolean {
    return this.verdicts.get(chatID)?.source === "owner";
  }

  /** The chat's noise mark now, or null: not noise, no verdict, or what made it is off (Jev's need the definition; the owner's a definition or a list). */
  noiseOf(chatID: string): ChatNoise | null {
    const v = this.verdicts.get(chatID);
    if (!v?.noise) return null;
    if (v.source === "sender") return { reason: SENDER_NOISE_REASON, confidence: 1, source: "sender" };
    if (v.source === "owner") return this.active() ? { reason: OWNER_NOISE_REASON, confidence: 1, source: "owner" } : null;
    return this.judging() ? { reason: v.reason ?? OWNER_NOISE_REASON, confidence: v.confidence ?? 1, source: "jev" } : null;
  }

  isNoise(chatID: string): boolean {
    return this.noiseOf(chatID) !== null;
  }

  isListNoise(chatID: string): boolean {
    return this.noiseOf(chatID)?.source === "sender";
  }

  /** A chat as the lists show it: a noise one is in Low priority, with why. */
  decorate<C extends ChatSummary>(c: C): C {
    const n = this.noiseOf(c.id);
    return n ? { ...c, isLowPriority: true, noise: n } : c;
  }

  noiseCount(): number {
    let n = 0;
    for (const id of this.verdicts.keys()) if (this.noiseOf(id)) n++;
    return n;
  }

  private put(v: Verdict) {
    this.verdicts.delete(v.chatID);
    this.verdicts.set(v.chatID, v);
    this.trim();
  }

  /** Within the bounds: Jev's and the list's go first, least recently judged first; the owner's only past their own bound, oldest first. */
  private trim() {
    let owners = 0;
    for (const v of this.verdicts.values()) if (v.source === "owner") owners++;
    let others = this.verdicts.size - owners;
    if (others <= this.max && owners <= this.maxOwner) return;
    for (const [id, v] of this.verdicts) {
      if (v.source === "owner" ? owners > this.maxOwner && owners-- : others > this.max && others--) this.verdicts.delete(id);
      if (others <= this.max && owners <= this.maxOwner) break;
    }
  }

  private note(d: Decision) {
    // The same decision once; two different verdicts within one millisecond are both kept.
    this.recent = [d, ...this.recent.filter((x) => !(x.chatID === d.chatID && x.source === d.source && x.at === d.at && x.noise === d.noise && x.reason === d.reason))].slice(0, MAX_NOISE_DECISIONS);
  }

  /** Jev's verdicts (one call's). Conversations the owner decided are left alone. Throws if they cannot be written. */
  setJev(items: { chatID: string; noise: boolean; reason?: string; confidence: number; lastMessageID?: string; title: string; network: string }[]): number {
    const at = this.now();
    let n = 0;
    for (const it of items) {
      if (this.isOwners(it.chatID)) continue;
      // Caught by the list while Jev was being asked (the list clears what no longer matches before anyone asks).
      if (this.verdicts.get(it.chatID)?.source === "sender") continue;
      const reason = it.noise && it.reason ? sanitizeLine(it.reason, MAX_NOISE_LINE_LENGTH) : undefined;
      this.put({ chatID: it.chatID, noise: it.noise && !!reason, source: "jev", ...(reason ? { reason } : {}), confidence: clamp01(it.confidence), at, ...(it.lastMessageID ? { lastMessageID: it.lastMessageID } : {}) });
      this.note({ chatID: it.chatID, title: sanitizeLine(it.title, 500), network: sanitizeLine(it.network, 64) || "Unknown", noise: it.noise && !!reason, reason: reason ?? null, confidence: clamp01(it.confidence), source: "jev", at });
      n++;
    }
    if (n) this.save();
    return n;
  }

  /**
   * The owner's own verdict (sticky). `about` names the conversation in Recent decisions; `example` is shown to Jev; `sender` is
   * what learning counts (absent: not known yet, senders.ts looks it up). Throws if it cannot be written.
   */
  setOwner(chatID: string, noise: boolean, about: { title?: string; network?: string; example?: string; sender?: string | null } = {}): void {
    const at = this.now();
    const example = about.example ? sanitizeLine(about.example, MAX_EXAMPLE_LENGTH) : undefined;
    const had = this.verdicts.get(chatID);
    const sender = about.sender !== undefined ? about.sender : had?.source === "owner" ? had.sender : undefined;
    this.put({ chatID, noise, source: "owner", at, ...(example ? { example } : {}), ...(sender !== undefined ? { sender } : {}) });
    this.note({ chatID, title: sanitizeLine(about.title ?? "", 500), network: sanitizeLine(about.network ?? "", 64) || "Unknown", noise, reason: noise ? OWNER_NOISE_REASON : null, confidence: null, source: "owner", at });
    this.save();
  }

  /** The owner's latest corrections that have an example, newest first, each with its sender's address when the example does not say it (one made before examples did, whose sender was looked up since). */
  examples(max = MAX_EXAMPLES): { example: string; noise: boolean }[] {
    const out: { example: string; noise: boolean }[] = [];
    for (const v of [...this.verdicts.values()].reverse()) {
      if (v.source !== "owner" || !v.example) continue;
      out.push({ example: v.sender && !v.example.includes(v.sender) ? `${v.example}; sender: ${v.sender.slice(0, MAX_EXAMPLE_SENDER)}` : v.example, noise: v.noise });
      if (out.length >= max) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- the list of senders

  hasSenders(): boolean {
    return this.senderList.size > 0;
  }

  /** The list, newest first. */
  senders(): NoiseSender[] {
    return [...this.senderList.values()].reverse().map((e) => ({ value: e.value, kind: e.kind, origin: e.origin, addedAt: new Date(e.at).toISOString() }));
  }

  /** The entry that catches an address: its own, else its domain's (whole: not its subdomains'). */
  entryFor(address: string): SenderEntry | null {
    const a = address.trim().toLowerCase();
    const at = a.lastIndexOf("@");
    return this.senderList.get(a) ?? (at > 0 ? this.senderList.get(a.slice(at + 1)) : undefined) ?? null;
  }

  /** The rule has answered about this activity: the newest message is one of these, and the list caught it. */
  caughtAlready(chatID: string, messageIDs: readonly string[]): boolean {
    const v = this.verdicts.get(chatID);
    return v?.source === "sender" && !!v.lastMessageID && messageIDs.includes(v.lastMessageID);
  }

  /**
   * The rule on these conversations (Gmail's only; the owner's verdicts stay as they are). `clear`: one whose newest message
   * no longer matches stops being noise by the list; without it nothing but a match changes anything. `note`: Recent decisions hear of it.
   * Answers which conversations moved in or out of noise. On disk soon after: the next look at them would decide the same.
   */
  applyRule(items: RuleFacts[], o: { clear: boolean; note: boolean }): string[] {
    const moved: string[] = [];
    let changed = false;
    const at = this.now();
    for (const it of items) {
      if (!parseGmailChatID(it.chatID) || this.isOwners(it.chatID)) continue;
      const had = this.verdicts.get(it.chatID);
      const entry = it.address ? this.entryFor(it.address) : null;
      if (!entry) {
        if (!o.clear || had?.source !== "sender") continue;
        this.verdicts.delete(it.chatID);
        moved.push(it.chatID);
        changed = true;
        continue;
      }
      if (had?.source === "sender" && had.lastMessageID === it.lastMessageID && had.rule === entry.value) continue;
      const before = this.isNoise(it.chatID);
      this.put({ chatID: it.chatID, noise: true, source: "sender", reason: SENDER_NOISE_REASON, confidence: 1, at, lastMessageID: it.lastMessageID, sender: it.address, rule: entry.value });
      if (o.note) this.note({ chatID: it.chatID, title: sanitizeLine(it.title ?? "", 500), network: sanitizeLine(it.network ?? "", 64) || "Unknown", noise: true, reason: SENDER_NOISE_REASON, confidence: null, source: "sender", at });
      if (!before) moved.push(it.chatID);
      changed = true;
    }
    if (changed) this.saveSoon();
    return moved;
  }

  /**
   * An entry on the list: the owner's (an address they had taken off may be learned again, and one learned is theirs now), or learned.
   * Its existing mail is to be walked. null: the list is full. Throws if it cannot be written.
   */
  addSender(value: string, origin: NoiseSender["origin"]): { entry: NoiseSender; added: boolean } | null {
    const parsed = parseNoiseSender(value);
    if (!parsed || parsed.value !== value) throw new Error("not an entry");
    const before = this.keepList();
    const had = this.senderList.get(value);
    if (had) {
      if (origin === "owner" && had.origin !== "owner") this.senderList.set(value, { ...had, origin });
    } else {
      if (this.senderList.size >= MAX_NOISE_SENDERS) return null;
      const wasRemoved = this.removedSenders.delete(value);
      this.senderList.set(value, { value, kind: parsed.kind, origin, at: this.now(), ...(wasRemoved ? { wasRemoved: true as const } : {}) });
      this.walks = [...this.walks, value];
    }
    this.commit(before);
    const e = this.senderList.get(value)!;
    return { entry: { value, kind: e.kind, origin: e.origin, addedAt: new Date(e.at).toISOString() }, added: !had };
  }

  /**
   * An entry off the list, and the verdicts that came from it: those another entry still catches are that one's now, and the rest are
   * cleared (those conversations are judged again on their next activity). `remember` (the owner took it off): the address is not learned
   * again, unless the owner adds it. `undo`: it only takes back the add a moment ago, so what was remembered before that is again. Answers which
   * conversations stopped being noise, or null if it was not there. Throws if it cannot be written.
   */
  removeSender(value: string, o: { remember: boolean; undo?: boolean }): { cleared: string[] } | null {
    const e = this.senderList.get(value);
    if (!e) return null;
    const before = this.keepList();
    this.senderList.delete(value);
    this.walks = this.walks.filter((w) => w !== value);
    if (e.kind === "address" && (o.undo ? e.wasRemoved : o.remember)) {
      this.removedSenders.delete(value);
      this.removedSenders.add(value);
      for (const a of this.removedSenders) {
        if (this.removedSenders.size <= MAX_REMOVED_SENDERS) break;
        this.removedSenders.delete(a);
      }
    }
    const cleared: string[] = [];
    for (const [id, v] of this.verdicts) {
      if (v.source !== "sender" || v.rule !== value) continue;
      const other = v.sender ? this.entryFor(v.sender) : null;
      if (other) this.verdicts.set(id, { ...v, rule: other.value });
      else {
        this.verdicts.delete(id);
        cleared.push(id);
      }
    }
    this.commit(before);
    return { cleared };
  }

  /** The address was taken off by the owner, and has not been added since. */
  isRemovedSender(address: string): boolean {
    return this.removedSenders.has(address);
  }

  /**
   * What the owner's marks say now. Learned: an address with at least NOISE_SENDER_LEARN_AT conversations marked noise and none marked not
   * noise, not taken off by the owner, not the owner's own. No longer: a learned entry with a Not noise mark (no record of it is needed: the mark
   * itself keeps it from coming back), or one that turned out to be the owner's own. Throws if it cannot be written.
   */
  learn(isOwn: (address: string) => boolean): { learned: string[]; cleared: string[] } {
    const counts = new Map<string, { noise: number; not: number }>();
    for (const v of this.verdicts.values()) {
      if (v.source !== "owner" || !v.sender) continue;
      const c = counts.get(v.sender) ?? { noise: 0, not: 0 };
      if (v.noise) c.noise++;
      else c.not++;
      counts.set(v.sender, c);
    }
    const cleared: string[] = [];
    for (const e of [...this.senderList.values()]) {
      if (e.origin !== "learned" || (!counts.get(e.value)?.not && !isOwn(e.value))) continue;
      cleared.push(...(this.removeSender(e.value, { remember: false })?.cleared ?? []));
    }
    const learned: string[] = [];
    for (const [address, c] of counts) {
      if (c.noise < NOISE_SENDER_LEARN_AT || c.not > 0 || this.senderList.has(address) || this.removedSenders.has(address) || isOwn(address) || parseNoiseSender(address)?.value !== address) continue;
      if (!this.addSender(address, "learned")) break;
      learned.push(address);
    }
    return { learned, cleared };
  }

  /** Gmail conversations the owner has a verdict on whose sender was not looked up yet, oldest first. */
  ownerWithoutSender(): string[] {
    const out: string[] = [];
    for (const v of this.verdicts.values()) if (v.source === "owner" && v.sender === undefined && parseGmailChatID(v.chatID)) out.push(v.chatID);
    return out;
  }

  /** What the lookups found. Throws if it cannot be written. */
  setOwnerSenders(found: { chatID: string; sender: string | null }[]): void {
    let changed = false;
    for (const f of found) {
      const v = this.verdicts.get(f.chatID);
      if (v?.source !== "owner") continue;
      v.sender = f.sender;
      changed = true;
    }
    if (changed) this.save();
  }

  /** The look at the owner's verdicts from before the list ran to its end. */
  get senderLookupsDone(): boolean {
    return this.lookupsDone;
  }

  markSenderLookupsDone(): void {
    if (this.lookupsDone) return;
    this.lookupsDone = true;
    this.save();
  }

  /** Entries whose existing mail is still to be walked, oldest first. */
  pendingWalks(): string[] {
    return this.walks;
  }

  /** One walk is over. Whatever it found is written with this. */
  finishWalk(value: string): void {
    if (!this.walks.includes(value)) return;
    this.walks = this.walks.filter((w) => w !== value);
    this.save();
  }

  private keepList() {
    return { senders: new Map(this.senderList), removed: new Set(this.removedSenders), walks: this.walks, verdicts: new Map(this.verdicts) };
  }

  private commit(before: ReturnType<NoiseStore["keepList"]>) {
    try {
      this.save();
    } catch (e) {
      this.senderList = before.senders;
      this.removedSenders = before.removed;
      this.walks = before.walks;
      this.verdicts = before.verdicts;
      throw e;
    }
  }

  /** Settings > Noise "Recent decisions", newest first. */
  decisions(): NoiseDecision[] {
    return this.recent.map((d) => ({ ...d, at: new Date(d.at).toISOString() }));
  }

  get size(): number {
    return this.verdicts.size;
  }
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** An example stays within its bounds when it says who wrote: the longest a sender goes in one. */
const MAX_EXAMPLE_SENDER = 80;

/** A sender as a mark keeps it: what Gmail's From said, which need not be something the list could hold (learning asks). */
const isSender = (v: unknown): v is string => typeof v === "string" && v.includes("@") && v === sanitizeLine(v, 320);

function cleanEntry(e: any): SenderEntry | null {
  const p = e && typeof e === "object" ? parseNoiseSender(e.value) : null;
  if (!p || p.value !== e.value || !NOISE_SENDER_ORIGINS.includes(e.origin) || !Number.isSafeInteger(e.at)) return null;
  return { value: p.value, kind: p.kind, origin: e.origin, at: e.at, ...(e.wasRemoved === true ? { wasRemoved: true as const } : {}) };
}

function cleanVerdict(v: any): Verdict | null {
  if (!v || typeof v !== "object" || !parse(chatIDSchema, v.chatID).ok || typeof v.noise !== "boolean" || !NOISE_SOURCES.includes(v.source) || !Number.isSafeInteger(v.at)) return null;
  const out: Verdict = { chatID: v.chatID, noise: v.noise, source: v.source, at: v.at };
  if (typeof v.reason === "string" && v.reason) out.reason = sanitizeLine(v.reason, MAX_NOISE_LINE_LENGTH);
  if (typeof v.confidence === "number") out.confidence = clamp01(v.confidence);
  if (typeof v.lastMessageID === "string" && v.lastMessageID.length <= 512) out.lastMessageID = v.lastMessageID;
  if (typeof v.example === "string" && v.example) out.example = sanitizeLine(v.example, MAX_EXAMPLE_LENGTH);
  if (out.noise && out.source === "jev" && !out.reason) return null;
  if (v.sender === null || isSender(v.sender)) out.sender = v.sender;
  if (out.source === "sender") {
    if (!out.noise || !parseNoiseSender(v.rule) || !out.sender) return null;
    out.rule = v.rule;
  }
  return out;
}
