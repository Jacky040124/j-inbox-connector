import { enumOf, object, string, type Infer } from "./schema.ts";
import { MAX_ERROR_MESSAGE_LENGTH } from "./limits.ts";
import { sanitizeLine, truncateText } from "./textutil.ts";
import { ACTIONS, isActionName } from "./actions.ts";

export const ERROR_CODES = [
  "OFFLINE", // connector not connected
  "BEEPER_DOWN", // connector up, Beeper API unreachable or failing
  "NOT_ALLOWED", // action not in the whitelist, or caller lacks permission
  "TIMEOUT",
  "BAD_PARAMS",
  "TOO_LARGE",
  "RATE_LIMITED",
  "INTERNAL",
  "NOT_FOUND", // chat/message/asset/approval does not exist (Beeper 404)
  "UNAUTHENTICATED", // no or expired session / device credential
  "UNKNOWN_OUTCOME", // a write was dispatched but its answer was lost: it may or may not have happened
  "CONFLICT", // the target's current state forbids this (e.g. draft_reply when a draft already exists)
  "BEEPER_UNAUTHORIZED", // Beeper rejected the connector's token (revoked or expired): the owner must re-authorize, retrying will not help
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  OFFLINE: 503,
  BEEPER_DOWN: 502,
  NOT_ALLOWED: 403,
  TIMEOUT: 504,
  BAD_PARAMS: 400,
  TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  UNKNOWN_OUTCOME: 502,
  CONFLICT: 409,
  BEEPER_UNAUTHORIZED: 502,
};

// OFFLINE means the request was never dispatched; BEEPER_DOWN means it never reached Beeper.
const ALWAYS_RETRYABLE = new Set<ErrorCode>(["OFFLINE", "BEEPER_DOWN", "RATE_LIMITED"]);
// Safe to retry only for reads: for a write the effect may already have happened.
const RETRYABLE_FOR_READS = new Set<ErrorCode>(["TIMEOUT", "INTERNAL"]);
const LOST_ANSWER = new Set<ErrorCode>(["TIMEOUT", "OFFLINE", "INTERNAL"]);

export const errorCode = enumOf(ERROR_CODES);
export const errorBody = object({ code: errorCode, message: string({ min: 1, max: MAX_ERROR_MESSAGE_LENGTH }) });
export type ErrorBody = Infer<typeof errorBody>;

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(STATUS, v);
}

export function httpStatusForError(code: ErrorCode): number {
  return STATUS[code];
}

/**
 * May the caller retry the same request? For write actions TIMEOUT / INTERNAL / UNKNOWN_OUTCOME
 * are never retryable (the message may already be sent). Without a known read action, TIMEOUT
 * and INTERNAL are treated as unsafe.
 */
export function isRetryable(code: ErrorCode, action?: string): boolean {
  if (ALWAYS_RETRYABLE.has(code)) return true;
  if (!RETRYABLE_FOR_READS.has(code)) return false;
  return action !== undefined && isActionName(action) && !ACTIONS[action].write;
}

/**
 * The cloud calls this when a request was already sent to the connector (a `req` frame went out)
 * and no answer arrived: for writes the outcome is unknown, never "offline" or "timeout".
 */
export function errorAfterDispatch(action: string, code: ErrorCode): ErrorCode {
  const write = !isActionName(action) || ACTIONS[action].write;
  return write && LOST_ANSWER.has(code) ? "UNKNOWN_OUTCOME" : code;
}

/** Builds a valid error body, clamping the message to the protocol limit. */
export function makeError(code: ErrorCode, message: string): ErrorBody {
  const clean = sanitizeLine(message, MAX_ERROR_MESSAGE_LENGTH * 2) || code;
  if (clean.length <= MAX_ERROR_MESSAGE_LENGTH) return { code, message: clean };
  return { code, message: truncateText(clean, MAX_ERROR_MESSAGE_LENGTH - 1).text + "…" };
}
