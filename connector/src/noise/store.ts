// The noise store (file noise.json): the owner's definition of noise, the verdicts on conversations
// (Jev's and the owner's own), the owner's corrections as examples for Jev, and the latest decisions
// for Settings > Noise (protocol noise.ts). All of it stays on this computer; the cloud only relays
// it. One JSON file, mode 0600 in a 0700 directory, written atomically on every change; at most
// MAX_VERDICTS verdicts (the least recently judged go first), validated on load. While the definition
// is empty nothing is applied: no conversation is noise.
import { readFileSync } from "node:fs";
import {
  MAX_NOISE_DECISIONS,
  MAX_NOISE_LINE_LENGTH,
  NOISE_SOURCES,
  OWNER_NOISE_REASON,
  chatID as chatIDSchema,
  noiseDecision,
  noiseDefinition,
  noiseLines,
  parse,
  sanitizeLine,
  type ChatNoise,
  type ChatSummary,
  type NoiseDecision,
} from "@j-inbox/protocol";
import { writeAtomic } from "../config.ts";

export const MAX_VERDICTS = 5000;
/** The owner's corrections Jev is shown as examples. */
export const MAX_EXAMPLES = 20;
export const MAX_EXAMPLE_LENGTH = 400;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

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
};

/** What the lists and the sources need: is a conversation noise now (the definition not empty)? */
export type NoiseView = { active(): boolean; isNoise(chatID: string): boolean };

type Decision = Omit<NoiseDecision, "at"> & { at: number };

export class NoiseStore implements NoiseView {
  private def = "";
  private lineList: string[] = [];
  /** Insertion order = least recently judged first. */
  private verdicts = new Map<string, Verdict>();
  private recent: Decision[] = [];
  private readonly now: () => number;
  private readonly max: number;

  constructor(private readonly o: { path?: string; now?: () => number; max?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.max = o.max ?? MAX_VERDICTS;
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
      for (const v of Array.isArray(j.verdicts) ? j.verdicts.slice(-this.max) : []) {
        const ok = cleanVerdict(v);
        if (ok) this.verdicts.set(ok.chatID, ok);
      }
      for (const d of Array.isArray(j.decisions) ? j.decisions.slice(0, MAX_NOISE_DECISIONS) : []) {
        if (!d || typeof d !== "object" || !Number.isSafeInteger(d.at)) continue;
        if (parse(noiseDecision, { ...d, at: new Date(d.at).toISOString() }).ok) this.recent.push(d as Decision);
      }
    } catch {
      // An unreadable file is ignored (and replaced on the next write): noise starts over, off.
    }
  }

  private save() {
    if (!this.o.path) return;
    writeAtomic(this.o.path, JSON.stringify({ v: 1, definition: this.def, verdicts: [...this.verdicts.values()], decisions: this.recent }));
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

  /** The definition has a line: judge new activity, apply the verdicts. */
  active(): boolean {
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

  /** The chat's noise mark now, or null (not noise, no verdict, or the definition is empty). */
  noiseOf(chatID: string): ChatNoise | null {
    if (!this.active()) return null;
    const v = this.verdicts.get(chatID);
    if (!v?.noise) return null;
    return v.source === "owner" ? { reason: OWNER_NOISE_REASON, confidence: 1, source: "owner" } : { reason: v.reason ?? OWNER_NOISE_REASON, confidence: v.confidence ?? 1, source: "jev" };
  }

  isNoise(chatID: string): boolean {
    return this.noiseOf(chatID) !== null;
  }

  /** A chat as the lists show it: a noise one is in Low priority, with why. */
  decorate<C extends ChatSummary>(c: C): C {
    const n = this.noiseOf(c.id);
    return n ? { ...c, isLowPriority: true, noise: n } : c;
  }

  noiseCount(): number {
    if (!this.active()) return 0;
    let n = 0;
    for (const v of this.verdicts.values()) if (v.noise) n++;
    return n;
  }

  private put(v: Verdict) {
    this.verdicts.delete(v.chatID);
    this.verdicts.set(v.chatID, v);
    for (const id of this.verdicts.keys()) {
      if (this.verdicts.size <= this.max) break;
      this.verdicts.delete(id);
    }
  }

  private note(d: Decision) {
    this.recent = [d, ...this.recent.filter((x) => !(x.chatID === d.chatID && x.source === d.source && x.at === d.at))].slice(0, MAX_NOISE_DECISIONS);
  }

  /** Jev's verdicts (one call's). Conversations the owner decided are left alone. Throws if they cannot be written. */
  setJev(items: { chatID: string; noise: boolean; reason?: string; confidence: number; lastMessageID?: string; title: string; network: string }[]): number {
    const at = this.now();
    let n = 0;
    for (const it of items) {
      if (this.isOwners(it.chatID)) continue;
      const reason = it.noise && it.reason ? sanitizeLine(it.reason, MAX_NOISE_LINE_LENGTH) : undefined;
      this.put({ chatID: it.chatID, noise: it.noise && !!reason, source: "jev", ...(reason ? { reason } : {}), confidence: clamp01(it.confidence), at, ...(it.lastMessageID ? { lastMessageID: it.lastMessageID } : {}) });
      this.note({ chatID: it.chatID, title: sanitizeLine(it.title, 500), network: sanitizeLine(it.network, 64) || "Unknown", noise: it.noise && !!reason, reason: reason ?? null, confidence: clamp01(it.confidence), source: "jev", at });
      n++;
    }
    if (n) this.save();
    return n;
  }

  /** The owner's own verdict (sticky). `about` names the conversation in Recent decisions; `example` is shown to Jev. Throws if it cannot be written. */
  setOwner(chatID: string, noise: boolean, about: { title?: string; network?: string; example?: string } = {}): void {
    const at = this.now();
    const example = about.example ? sanitizeLine(about.example, MAX_EXAMPLE_LENGTH) : undefined;
    this.put({ chatID, noise, source: "owner", at, ...(example ? { example } : {}) });
    this.note({ chatID, title: sanitizeLine(about.title ?? "", 500), network: sanitizeLine(about.network ?? "", 64) || "Unknown", noise, reason: noise ? OWNER_NOISE_REASON : null, confidence: null, source: "owner", at });
    this.save();
  }

  /** The owner's latest corrections that have an example, newest first. */
  examples(max = MAX_EXAMPLES): { example: string; noise: boolean }[] {
    const out: { example: string; noise: boolean }[] = [];
    for (const v of [...this.verdicts.values()].reverse()) {
      if (v.source !== "owner" || !v.example) continue;
      out.push({ example: v.example, noise: v.noise });
      if (out.length >= max) break;
    }
    return out;
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

function cleanVerdict(v: any): Verdict | null {
  if (!v || typeof v !== "object" || !parse(chatIDSchema, v.chatID).ok || typeof v.noise !== "boolean" || !NOISE_SOURCES.includes(v.source) || !Number.isSafeInteger(v.at)) return null;
  const out: Verdict = { chatID: v.chatID, noise: v.noise, source: v.source, at: v.at };
  if (typeof v.reason === "string" && v.reason) out.reason = sanitizeLine(v.reason, MAX_NOISE_LINE_LENGTH);
  if (typeof v.confidence === "number") out.confidence = clamp01(v.confidence);
  if (typeof v.lastMessageID === "string" && v.lastMessageID.length <= 512) out.lastMessageID = v.lastMessageID;
  if (typeof v.example === "string" && v.example) out.example = sanitizeLine(v.example, MAX_EXAMPLE_LENGTH);
  if (out.noise && out.source === "jev" && !out.reason) return null;
  return out;
}
