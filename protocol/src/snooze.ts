// Snooze: J-Inbox's own timer (not Beeper's reminders), kept by the cloud room. Snoozing archives
// a chat now; when `until` comes the cloud unarchives it and marks it unread (archive and mark_read
// at the connector), and a new message from someone else brings it back sooner. Works for every
// network, Gmail too.
import { isoDateTime, object, optional, parse, type Infer } from "./schema.ts";
import { chatID, chatSummary } from "./model.ts";

/** A snooze ends at most this far ahead. */
export const MAX_SNOOZE_MS = 7 * 24 * 3600_000;
/** ...and at least this far ahead. */
export const MIN_SNOOZE_MS = 60_000;
/** Accepted beyond MAX_SNOOZE_MS: the browser computes "In 7 days" with its own clock. */
export const SNOOZE_CLOCK_SLACK_MS = 10 * 60_000;
/** Snoozed chats per room. */
export const MAX_SNOOZES = 500;

/**
 * One snoozed chat (list_snoozed). The cloud keeps only the chat id (sealed) and the times; `chat`
 * (without its last message) is read from the owner's computer when list_snoozed is asked, and is
 * absent while the computer is offline or when the chat could not be read.
 */
export const snoozeItem = object({
  chatID,
  until: isoDateTime(),
  snoozedAt: isoDateTime(),
  chat: optional(chatSummary),
});
export type SnoozeItem = Infer<typeof snoozeItem>;

/** Why the cloud sent a /live `snooze` message: set (or moved), or cleared and why. */
export const SNOOZE_REASONS = ["snoozed", "due", "early", "unsnoozed", "unarchived", "dropped"] as const;
export type SnoozeReason = (typeof SNOOZE_REASONS)[number];

/**
 * What is wrong with `until` as a snooze end at `now` (epoch ms), in words for the owner, or null
 * when it is fine: a real ISO 8601 time, at least MIN_SNOOZE_MS ahead, at most MAX_SNOOZE_MS (plus
 * SNOOZE_CLOCK_SLACK_MS) ahead. The schema only checks the format; the cloud and the web both run this.
 */
export function snoozeUntilProblem(until: unknown, now: number): string | null {
  if (!parse(isoDateTime(), until).ok || !Number.isFinite(now)) return "Not a valid time.";
  const at = Date.parse(until as string);
  if (!Number.isFinite(at)) return "Not a valid time.";
  if (at - now < MIN_SNOOZE_MS) return "Pick a time at least a minute from now.";
  if (at - now > MAX_SNOOZE_MS + SNOOZE_CLOCK_SLACK_MS) return "Snooze for at most 7 days.";
  return null;
}
