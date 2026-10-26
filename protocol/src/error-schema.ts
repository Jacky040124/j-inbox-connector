// Error codes and the error body schema. Kept apart from errors.ts (which needs the action
// catalogue) so actions.ts can use errorBody in result shapes without an import cycle.
import { enumOf, object, string } from "./schema.ts";
import { MAX_ERROR_MESSAGE_LENGTH } from "./limits.ts";

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
  "NOT_SUPPORTED", // the chat's network cannot do this (e.g. react on an email thread)
  "REAUTH_REQUIRED", // Google refused the account's refresh token: the owner must reconnect the Gmail account in Settings
  "UPSTREAM_DOWN", // connector up, Gmail (Google) unreachable or failing; the request never reached it, or a read failed there
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCode = enumOf(ERROR_CODES);
export const errorBody = object({ code: errorCode, message: string({ min: 1, max: MAX_ERROR_MESSAGE_LENGTH }) });
