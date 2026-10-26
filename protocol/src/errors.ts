import { type Infer } from "./schema.ts";
import { MAX_ERROR_MESSAGE_LENGTH } from "./limits.ts";
import { sanitizeLine, truncateText } from "./textutil.ts";
import { ACTIONS, isActionName } from "./actions.ts";
import { ERROR_CODES, errorBody, errorCode, type ErrorCode } from "./error-schema.ts";

export { ERROR_CODES, errorBody, errorCode, type ErrorCode };

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
  NOT_SUPPORTED: 422,
  REAUTH_REQUIRED: 502,
  UPSTREAM_DOWN: 502,
};

// OFFLINE means the request was never dispatched; BEEPER_DOWN / UPSTREAM_DOWN mean it never reached
// Beeper / Gmail (or a read failed there).
const ALWAYS_RETRYABLE = new Set<ErrorCode>(["OFFLINE", "BEEPER_DOWN", "UPSTREAM_DOWN", "RATE_LIMITED"]);
// Safe to retry only for reads: for a write the effect may already have happened.
const RETRYABLE_FOR_READS = new Set<ErrorCode>(["TIMEOUT", "INTERNAL"]);
const LOST_ANSWER = new Set<ErrorCode>(["TIMEOUT", "OFFLINE", "INTERNAL"]);

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
