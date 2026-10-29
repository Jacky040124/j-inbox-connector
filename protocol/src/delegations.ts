// "Delegate a message to an agent as a Raft task" (decided with Jacky, 2026-10-29): the owner hands
// a chat (an email that needs some work done, say) to one of the Raft server's agents (the same
// allowlist as drafts, Settings > Agents). The agent creates a task in the Raft channel the owner
// named, claims it, and reports the task's number; the chat itself is done (marked read at once)
// and the owner follows the task in Raft. Delegation is not a reply: the agent sends nothing in the
// chat for it.
//
// Like drafts, the cloud room keeps only the request's metadata (its id, the chat id sealed, the
// agent's id, the channel's name, the status, the task number, times, an error code or the agent's
// short reason); the owner's instruction lives on the owner's computer (the connector's request
// store, the draft_store_* actions) and passes through the cloud only to the agent that was asked.
// The agent is told through a Raft agent event that names nothing but the request id
// (delegationEventSummary, delegationEventPayload).
import { enumOf, integer, isoDateTime, literal, nullable, object, optional, parse, string, text, type Infer } from "./schema.ts";
import { errorBody } from "./error-schema.ts";
import { MAX_NAME_LENGTH, MAX_TITLE_LENGTH } from "./limits.ts";
import { chatID, networkName } from "./model.ts";
import { sanitizeLine } from "./textutil.ts";
import { DRAFT_DELIVERIES, MAX_DRAFT_INSTRUCTION_LENGTH, RAFT_EVENT_SUMMARY_MAX, raftAgentID, ownerLabelForEvent } from "./drafts.ts";

/** An agent that was asked has this long to report the task; then the request expires. */
export const DELEGATION_DEADLINE_MS = 30 * 60_000;
/** The owner's instruction (what the task is): the same bounds as a draft's. */
export const MAX_DELEGATION_INSTRUCTION_LENGTH = MAX_DRAFT_INSTRUCTION_LENGTH;
/** Requests the owner still has to look at (pending, failed, expired) per room. */
export const MAX_ACTIVE_DELEGATIONS = 50;
/** Requests list_delegations shows at once (the open ones and the tasks created, newest first). */
export const MAX_SHOWN_DELEGATIONS = 200;
/** Channels the owner used before, kept per owner (most recent first). */
export const MAX_RECENT_CHANNELS = 20;
/** The agent's own reason when it could not create the task (cut, one clean line). */
export const MAX_DELEGATION_REASON_LENGTH = 200;
/** A Raft channel name, "#" included. */
export const MAX_CHANNEL_LENGTH = 81;
/** Per agent per minute (the cloud's caps on the agent actions). */
export const DELEGATION_GET_PER_MINUTE = 30;
export const DELEGATION_REPORT_PER_MINUTE = 10;
/** A queued Raft event lives this long (the request's deadline). */
export const DELEGATION_EVENT_TTL_SECONDS = DELEGATION_DEADLINE_MS / 1000;

/**
 * pending: asked, waiting for the agent's report. created: the agent made the task (its number is
 * here). failed: the agent could not create it (its reason), or Raft would not take the request.
 * expired: no report within the deadline. cancelled: the owner stopped it while it was pending.
 * dismissed: the owner put a finished one aside (or a new request for the chat replaced it).
 */
export const DELEGATION_STATUSES = ["pending", "created", "failed", "expired", "cancelled", "dismissed"] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];
/** Shown in the conversation (and created ones as "Delegated" in the chat list) until dismissed or replaced. */
export const SHOWN_DELEGATION_STATUSES = ["pending", "created", "failed", "expired"] as const satisfies readonly DelegationStatus[];
/** Still something for the owner to act on (counted against MAX_ACTIVE_DELEGATIONS; the instruction is still on the computer). */
export const OPEN_DELEGATION_STATUSES = ["pending", "failed", "expired"] as const satisfies readonly DelegationStatus[];
export function isShownDelegationStatus(s: unknown): s is (typeof SHOWN_DELEGATION_STATUSES)[number] {
  return typeof s === "string" && (SHOWN_DELEGATION_STATUSES as readonly string[]).includes(s);
}
export function isOpenDelegationStatus(s: unknown): s is (typeof OPEN_DELEGATION_STATUSES)[number] {
  return typeof s === "string" && (OPEN_DELEGATION_STATUSES as readonly string[]).includes(s);
}

/** A delegation request id, minted by the cloud. */
export const delegationRequestID = string({ min: 8, max: 64, pattern: /^dlg_[A-Za-z0-9_-]+$/, format: "delegation-request-id" });
export const delegationInstruction = text({ min: 1, max: MAX_DELEGATION_INSTRUCTION_LENGTH });

/**
 * A Raft channel as J-Inbox names it: "#" and 1-80 letters or digits (any script), "_", "-" or ".",
 * starting with a letter or digit. No spaces, no thread suffix, nothing that could be a path.
 */
export const CHANNEL_PATTERN = /^#[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u;
export const raftChannel = string({ min: 2, max: MAX_CHANNEL_LENGTH, pattern: CHANNEL_PATTERN, format: "raft-channel" });

/**
 * What the owner typed ("GARAGE", "#GARAGE", " #garage ") as "#name", or null when it is not a
 * channel name. Case is kept (Raft shows the name as it was made).
 */
export function normalizeChannel(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const v = input.normalize("NFC").trim().replace(/^#+/, "");
  const name = `#${v}`;
  return CHANNEL_PATTERN.test(name) && name.length <= MAX_CHANNEL_LENGTH ? name : null;
}

/** The same channel, whatever the case. */
export function sameChannel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A Raft task number (as `raft task create` prints it: #N). */
export const taskNumber = integer({ min: 1, max: 100_000_000 });
export const delegationTask = object({ number: taskNumber, channel: raftChannel });
export type DelegationTask = Infer<typeof delegationTask>;

/**
 * The agent's reason when it could not create the task: one line, no controls, no bidi or
 * zero-width tricks, at most MAX_DELEGATION_REASON_LENGTH. Empty when nothing is left.
 */
export function cleanDelegationReason(s: unknown): string {
  if (typeof s !== "string") return "";
  const noTricks = s.replace(/[​-‏‪-‮⁠-⁩﻿]/g, "");
  return sanitizeLine(noTricks, MAX_DELEGATION_REASON_LENGTH);
}
/** What the agent may send as `error` (cleaned and cut to MAX_DELEGATION_REASON_LENGTH before it is kept). */
export const delegationReason = text({ min: 1, max: 2000 });

/** A delegation request as the owner's web page sees it. The cloud keeps none of `instruction`. */
export const delegationMeta = object({
  requestId: delegationRequestID,
  chatID,
  agent: object({ id: raftAgentID, name: nullable(string({ min: 0, max: MAX_NAME_LENGTH })) }),
  /** Where the owner asked for the task. */
  channel: raftChannel,
  status: enumOf(DELEGATION_STATUSES),
  createdAt: isoDateTime(),
  updatedAt: isoDateTime(),
  /** When a pending request expires. */
  deadline: isoDateTime(),
  delivery: optional(enumOf(DRAFT_DELIVERIES)),
  /** created: the task the agent reported (its channel may be written differently). */
  task: optional(delegationTask),
  /** failed by the agent: its own short reason ("not a member of #garage"). */
  reason: optional(string({ min: 1, max: MAX_DELEGATION_REASON_LENGTH })),
  /** failed because Raft would not take the request (the agent is gone, denied ...). */
  error: optional(errorBody),
});
export type DelegationMeta = Infer<typeof delegationMeta>;

export const delegationView = object({
  ...delegationMeta.shape,
  /** The owner's instruction, read from the owner's computer while the request is open (absent while it is offline, and once the task exists). */
  instruction: optional(delegationInstruction),
});
export type DelegationView = Infer<typeof delegationView>;

/** The Raft agent event's payload: the request id and nothing else. */
export const DELEGATION_EVENT_TYPE = "delegation_request";
export const delegationEventPayload = object({ type: literal(DELEGATION_EVENT_TYPE), requestId: delegationRequestID });
export type DelegationEventPayload = Infer<typeof delegationEventPayload>;

/**
 * The Raft agent event's summary: who asked, the request id and what to do (the agent sees this
 * line), never the chat, the channel, the instruction or any chat text.
 */
export function delegationEventSummary(ownerName: string | null, requestId: string): string {
  if (!parse(delegationRequestID, requestId).ok) throw new Error("invalid delegation request id");
  const who = ownerLabelForEvent(ownerName);
  const s = `J-Inbox: ${who} delegated a task to you (request ${requestId}). Use the J-Inbox app: get_delegation_request, then create the task in the channel it names with \`raft task create\`, claim it, and report_delegation with the task number. Do not reply in the chat.`;
  return s.slice(0, RAFT_EVENT_SUMMARY_MAX);
}

/** get_delegation_request's answer (the agent that was asked, while pending). */
export const delegationRequestForAgent = object({
  requestId: delegationRequestID,
  chatID,
  network: nullable(networkName),
  chatTitle: nullable(string({ min: 0, max: MAX_TITLE_LENGTH })),
  instruction: delegationInstruction,
  channel: raftChannel,
  status: literal("pending"),
  deadline: isoDateTime(),
});

/**
 * report_delegation's parameters as the agent CLI may send them: `task` as an object or as JSON
 * text, its number as a number or digits, the channel with or without "#". Anything else is left
 * for the schema to refuse.
 */
export function coerceReportParams(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  let task = out.task;
  if (typeof task === "string" && task.trim().startsWith("{")) {
    try {
      task = JSON.parse(task);
    } catch {}
  }
  if (task && typeof task === "object" && !Array.isArray(task)) {
    const t = { ...(task as Record<string, unknown>) };
    if (typeof t.number === "string" && /^#?\d{1,9}$/.test(t.number.trim())) t.number = Number(t.number.trim().replace(/^#/, ""));
    if (typeof t.channel === "string") t.channel = normalizeChannel(t.channel) ?? t.channel;
    task = t;
  }
  if (task !== undefined) out.task = task;
  return out;
}

/** /live `delegation`: a request was made or changed (metadata only). */
export const DELEGATION_LIVE_TYPE = "delegation";
