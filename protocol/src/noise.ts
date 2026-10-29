// Noise (since 2026-10-29, "noise.v1"): the owner says in plain words, one idea per line, what counts
// as noise; the owner's computer asks Jev (TypeSafe's System One) about every conversation with new
// activity and puts the noise ones in Low priority (ChatSummary.noise, with isLowPriority). The
// definition, the verdicts and their reasons stay on the owner's computer (the connector's noise
// store) and only pass through the cloud. Nothing is changed in Beeper or Gmail (never read, never
// archived). An empty definition turns it off.
import { boolean, enumOf, integer, isoDateTime, nullable, number, object, string, text, array, type Infer } from "./schema.ts";
import { MAX_TITLE_LENGTH } from "./limits.ts";
import { MAX_NOISE_LINE_LENGTH, NOISE_SOURCES, chatID, networkName } from "./model.ts";
import { sanitizeLine } from "./textutil.ts";

export const MAX_NOISE_DEFINITION_LENGTH = 4000;
/** Lines of the definition Jev is asked about (one choice each, plus "Not noise"; System One takes 255). */
export const MAX_NOISE_LINES = 50;
/** A conversation is noise only when Jev chose a noise line at least this sure; anything less is not noise. */
export const NOISE_CONFIDENCE_THRESHOLD = 0.7;
/** Settings > Noise shows this many of the latest decisions. */
export const MAX_NOISE_DECISIONS = 20;
/** The reason of a verdict the owner made by hand. */
export const OWNER_NOISE_REASON = "You marked it as noise";

export const noiseDefinition = text({ max: MAX_NOISE_DEFINITION_LENGTH });

/**
 * The definition's lines as Jev gets them: one line each (bullets and numbering dropped, spaces
 * collapsed, at most MAX_NOISE_LINE_LENGTH), empty and repeated lines left out, at most
 * MAX_NOISE_LINES. None: the feature is off.
 */
export function noiseLines(definition: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(definition ?? "").split(/\r\n|\r|\n/)) {
    const line = sanitizeLine(raw.replace(/^\s*(?:[-*•·–]+|\d{1,3}[.)])\s+/, ""), MAX_NOISE_LINE_LENGTH);
    const key = line.toLowerCase();
    if (!line || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= MAX_NOISE_LINES) break;
  }
  return out;
}

/** What keeps the computer from asking Jev: no key in its Keychain, Jev unreachable, or Jev refusing (a bad key, a refused request). */
export const NOISE_PROBLEMS = ["no_key", "jev_unreachable", "jev_refused"] as const;
export type NoiseProblem = (typeof NOISE_PROBLEMS)[number];

/** One recent decision (Settings > Noise "Recent decisions"): which conversation, noise or not, why, when. */
export const noiseDecision = object({
  chatID,
  title: string({ min: 0, max: MAX_TITLE_LENGTH }),
  network: networkName,
  noise: boolean(),
  /** The definition line Jev chose (noise), or the owner's words; null when not noise. */
  reason: nullable(string({ min: 1, max: MAX_NOISE_LINE_LENGTH })),
  /** Jev's confidence in its choice; null for the owner's own. */
  confidence: nullable(number({ min: 0, max: 1 })),
  source: enumOf(NOISE_SOURCES),
  at: isoDateTime(),
});
export type NoiseDecision = Infer<typeof noiseDecision>;

/** get_noise_settings / set_noise_definition: everything Settings > Noise shows, read from the owner's computer. */
export const noiseSettings = object({
  definition: noiseDefinition,
  /** The definition has at least one line: conversations with new activity are judged and noise goes to Low priority. */
  enabled: boolean(),
  /** The Jev key is in the computer's Keychain (`j-inbox jev-key`). */
  keySet: boolean(),
  problem: nullable(enumOf(NOISE_PROBLEMS)),
  /** Conversations in Low priority as noise now. */
  noiseCount: integer({ min: 0, max: 1_000_000 }),
  /** Newest first. */
  decisions: array(noiseDecision, { max: MAX_NOISE_DECISIONS }),
});
export type NoiseSettings = Infer<typeof noiseSettings>;
