import { describe, expect, test } from "bun:test";
import { ERROR_CODES, errorBody, httpStatusForError, isErrorCode, isRetryable } from "../src/errors.ts";
import { parse } from "../src/schema.ts";
import { beeperHealth } from "../src/model.ts";

describe("error codes", () => {
  test("contains the agreed codes", () => {
    for (const c of ["OFFLINE", "BEEPER_DOWN", "NOT_ALLOWED", "TIMEOUT", "BAD_PARAMS", "TOO_LARGE", "RATE_LIMITED", "INTERNAL"]) expect(ERROR_CODES).toContain(c as any);
  });
  test("every code maps to an HTTP status", () => {
    for (const c of ERROR_CODES) {
      const s = httpStatusForError(c);
      expect(s).toBeGreaterThanOrEqual(400);
      expect(s).toBeLessThan(600);
    }
    expect(httpStatusForError("OFFLINE")).toBe(503);
    expect(httpStatusForError("BAD_PARAMS")).toBe(400);
    expect(httpStatusForError("NOT_ALLOWED")).toBe(403);
    expect(httpStatusForError("RATE_LIMITED")).toBe(429);
    expect(httpStatusForError("TOO_LARGE")).toBe(413);
    expect(httpStatusForError("TIMEOUT")).toBe(504);
  });
  test("isErrorCode", () => {
    expect(isErrorCode("OFFLINE")).toBe(true);
    expect(isErrorCode("offline")).toBe(false);
    expect(isErrorCode("toString")).toBe(false);
    expect(isErrorCode(null)).toBe(false);
  });
  test("retryable codes", () => {
    expect(isRetryable("OFFLINE")).toBe(true);
    expect(isRetryable("TIMEOUT", "read_chat")).toBe(true);
    expect(isRetryable("BAD_PARAMS")).toBe(false);
    expect(isRetryable("NOT_ALLOWED")).toBe(false);
  });
});

// spec-r2-R2-SPEC-5: a rejected Beeper token is its own, non-retryable code (not "Beeper is down").
describe("BEEPER_UNAUTHORIZED", () => {
  test("exists, is a 5xx (not 401: the web UI logs out on 401) and is never retryable", () => {
    expect(isErrorCode("BEEPER_UNAUTHORIZED")).toBe(true);
    expect(httpStatusForError("BEEPER_UNAUTHORIZED")).toBe(502);
    for (const a of [undefined, "read_chat", "send_message"]) expect(isRetryable("BEEPER_UNAUTHORIZED", a)).toBe(false);
  });
  test("beeperHealth can say the token is invalid while Beeper itself is reachable", () => {
    expect(parse(beeperHealth, { reachable: true, version: "4.2.1", tokenValid: false }).ok).toBe(true);
    expect(parse(beeperHealth, { reachable: true, version: null, tokenValid: "no" }).ok).toBe(false);
  });
});

describe("errorBody schema", () => {
  test("valid", () => expect(parse(errorBody, { code: "OFFLINE", message: "Your computer is offline." }).ok).toBe(true));
  test("rejects unknown code, missing message, extra fields, huge message", () => {
    expect(parse(errorBody, { code: "NOPE", message: "x" }).ok).toBe(false);
    expect(parse(errorBody, { code: "OFFLINE" }).ok).toBe(false);
    expect(parse(errorBody, { code: "OFFLINE", message: "x", stack: "..." }).ok).toBe(false);
    expect(parse(errorBody, { code: "OFFLINE", message: "x".repeat(501) }).ok).toBe(false);
  });
});

// stability-r1-R1-01: a write whose outcome is unknown must never be presented as retryable.
import { ACTION_NAMES, ACTIONS } from "../src/actions.ts";
import { errorAfterDispatch } from "../src/errors.ts";

describe("retryability depends on the action (no double sends)", () => {
  const writes = ACTION_NAMES.filter((n) => ACTIONS[n].write);
  const reads = ACTION_NAMES.filter((n) => !ACTIONS[n].write);
  test("UNKNOWN_OUTCOME and CONFLICT exist with sensible HTTP statuses", () => {
    expect(ERROR_CODES).toContain("UNKNOWN_OUTCOME");
    expect(ERROR_CODES).toContain("CONFLICT");
    expect(httpStatusForError("CONFLICT")).toBe(409);
    expect(httpStatusForError("UNKNOWN_OUTCOME")).toBeGreaterThanOrEqual(500);
  });
  test("TIMEOUT and INTERNAL are not retryable for any write action", () => {
    for (const a of writes) for (const c of ["TIMEOUT", "INTERNAL", "UNKNOWN_OUTCOME"] as const) expect(`${a} ${c} ${isRetryable(c, a)}`).toBe(`${a} ${c} false`);
  });
  test("OFFLINE (never dispatched), BEEPER_DOWN (never reached Beeper) and RATE_LIMITED stay retryable for writes", () => {
    for (const a of writes) for (const c of ["OFFLINE", "BEEPER_DOWN", "RATE_LIMITED"] as const) expect(isRetryable(c, a)).toBe(true);
  });
  test("reads keep the old table", () => {
    for (const a of reads) {
      expect(isRetryable("TIMEOUT", a)).toBe(true);
      expect(isRetryable("INTERNAL", a)).toBe(true);
      expect(isRetryable("UNKNOWN_OUTCOME", a)).toBe(false);
    }
  });
  test("without an action, ambiguous codes are treated conservatively", () => {
    expect(isRetryable("TIMEOUT")).toBe(false);
    expect(isRetryable("INTERNAL")).toBe(false);
    expect(isRetryable("OFFLINE")).toBe(true);
    expect(isRetryable("CONFLICT")).toBe(false);
  });
  test("unknown action names do not make writes look safe", () => {
    expect(isRetryable("TIMEOUT", "__proto__")).toBe(false);
    expect(isRetryable("TIMEOUT", "delete_everything")).toBe(false);
  });
  test("errorAfterDispatch turns lost answers to writes into UNKNOWN_OUTCOME", () => {
    for (const a of writes) {
      expect(errorAfterDispatch(a, "TIMEOUT")).toBe("UNKNOWN_OUTCOME");
      expect(errorAfterDispatch(a, "OFFLINE")).toBe("UNKNOWN_OUTCOME");
      expect(errorAfterDispatch(a, "INTERNAL")).toBe("UNKNOWN_OUTCOME");
      expect(errorAfterDispatch(a, "BAD_PARAMS")).toBe("BAD_PARAMS");
    }
    for (const a of reads) expect(errorAfterDispatch(a, "TIMEOUT")).toBe("TIMEOUT");
  });
});
