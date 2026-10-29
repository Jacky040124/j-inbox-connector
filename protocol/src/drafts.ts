// "Ask an agent to draft a reply": the owner asks one of the Raft server's agents (picked in
// Settings > Agents) to draft a reply in a chat. The cloud room keeps only the request's metadata
// (its id, the chat id sealed, the target agent's id, the status and times); the owner's
// instruction and the agent's draft text live on the owner's computer (the connector's draft
// store) and only pass through the cloud. The agent is told through a Raft agent event that says
// nothing but the request id (draftEventSummary, draftEventPayload); it fetches the request with
// get_draft_request, reads the chat with read_chat and hands its text back with submit_draft. A
// draft is never sent by anyone but the owner, and never written into Beeper or Gmail.
import { array, boolean, enumOf, httpUrl, isoDateTime, literal, nullable, object, optional, parse, string, text, type Infer } from "./schema.ts";
import { errorBody } from "./error-schema.ts";
import { MAX_NAME_LENGTH, MAX_SEND_TEXT_LENGTH } from "./limits.ts";
import { chatID } from "./model.ts";
import { sanitizeLine } from "./textutil.ts";
import { uploadInfo } from "./uploads.ts";

/** An agent that was asked has this long to submit its draft; then the request expires. */
export const DRAFT_DEADLINE_MS = 30 * 60_000;
/** The owner's instruction ("Tell the agent what to write..."). */
export const MAX_DRAFT_INSTRUCTION_LENGTH = 2000;
/** Requests not yet handled (pending, drafted, expired, failed) per room. */
export const MAX_ACTIVE_DRAFTS = 50;
/** Agents the owner may allow (Settings > Agents). */
export const MAX_DRAFT_AGENTS = 100;
/** Agents kept from the Raft server's directory. */
export const MAX_RAFT_AGENTS = 200;
/** Requests read from the connector's draft store at once (keeps one answer well under a frame). */
export const MAX_DRAFT_READ = 10;
/** The connector forgets a request's instruction and draft this long after it was asked, whatever happened. */
export const DRAFT_KEEP_MS = 7 * 24 * 3600_000;
/** Per agent per minute (the cloud's caps on the agent actions). */
export const DRAFT_GET_PER_MINUTE = 30;
export const DRAFT_SUBMIT_PER_MINUTE = 10;
/** Raft's agent-event limits (POST /api/oauth/agent-events). */
export const RAFT_EVENT_SUMMARY_MAX = 500;
/** A queued Raft event lives this long (the request's deadline). */
export const DRAFT_EVENT_TTL_SECONDS = DRAFT_DEADLINE_MS / 1000;

/**
 * pending: asked, waiting for the agent. drafted: the draft is here. sent / discarded / cancelled:
 * handled by the owner (nothing is kept on the computer any more). expired: no draft within the
 * deadline. failed: the agent could not be reached (Raft refused).
 */
export const DRAFT_STATUSES = ["pending", "drafted", "sent", "discarded", "expired", "cancelled", "failed"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
/** Shown in the conversation until the owner handles them. */
export const ACTIVE_DRAFT_STATUSES = ["pending", "drafted", "expired", "failed"] as const satisfies readonly DraftStatus[];
export function isActiveDraftStatus(s: unknown): s is (typeof ACTIVE_DRAFT_STATUSES)[number] {
  return typeof s === "string" && (ACTIVE_DRAFT_STATUSES as readonly string[]).includes(s);
}

/**
 * How the request reached the agent: queued at Raft (sent), waiting for an approval in Raft before
 * J-Inbox may send events to that agent (awaiting_approval), or Raft did not answer and the room
 * tries again (retrying).
 */
export const DRAFT_DELIVERIES = ["sent", "awaiting_approval", "retrying"] as const;
export type DraftDelivery = (typeof DRAFT_DELIVERIES)[number];

/** A Raft agent id (the agent's `sub`). */
export const raftAgentID = string({ min: 1, max: 128, pattern: /^[A-Za-z0-9_.:-]+$/, format: "raft-agent-id" });
/** A draft request id, minted by the cloud. */
export const draftRequestID = string({ min: 8, max: 64, pattern: /^drq_[A-Za-z0-9_-]+$/, format: "draft-request-id" });
export const draftInstruction = text({ min: 1, max: MAX_DRAFT_INSTRUCTION_LENGTH });
export const draftText = text({ min: 1, max: MAX_SEND_TEXT_LENGTH });

/**
 * Where a draft came from: the owner asked an agent (asked), or an agent called draft_reply on its
 * own (agent, since 2026-10-29: an agent's draft_reply never writes into Beeper or Gmail any more,
 * it becomes a J-Inbox draft like an asked one; Jacky, #CHAT-GPT:df5ad78f).
 */
export const DRAFT_ORIGINS = ["asked", "agent"] as const;
export type DraftOrigin = (typeof DRAFT_ORIGINS)[number];
/** The instruction the connector's store keeps for an agent's own draft (the store needs one; the web does not show it). */
export const AGENT_OWN_DRAFT_INSTRUCTION = "(drafted by the agent on its own)";

/** One agent of the owner's Raft server (Settings > Agents): Raft's directory, nothing else. */
export const raftAgent = object({
  id: raftAgentID,
  name: string({ min: 1, max: MAX_NAME_LENGTH }),
  /** The agent's handle (@name), when Raft gave one. */
  handle: nullable(string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_.-]+$/ })),
  /** https only; the web shows it through GET /api/agent-avatar/<id>. */
  avatarURL: nullable(httpUrl()),
});
export type RaftAgent = Infer<typeof raftAgent>;

/** list_raft_agents: the directory, which of them may draft, and whether the owner must sign in again to read it. */
export const raftAgentsResult = object({
  agents: array(raftAgent, { max: MAX_RAFT_AGENTS }),
  allowedAgentIDs: array(raftAgentID, { max: MAX_DRAFT_AGENTS }),
  /** When the directory was read from Raft (null: never). */
  fetchedAt: nullable(isoDateTime()),
  /** The owner's Raft sign-in does not allow reading the agent list (older session, or the scope was not granted): sign in again. */
  signInNeeded: boolean(),
});

/** A draft request as the owner's web page sees it. The cloud keeps none of `instruction` and `text`. */
export const draftMeta = object({
  requestId: draftRequestID,
  chatID,
  agent: object({ id: raftAgentID, name: nullable(string({ min: 0, max: MAX_NAME_LENGTH })) }),
  status: enumOf(DRAFT_STATUSES),
  createdAt: isoDateTime(),
  updatedAt: isoDateTime(),
  /** When a pending request expires. */
  deadline: isoDateTime(),
  delivery: optional(enumOf(DRAFT_DELIVERIES)),
  /** failed: why (Raft refused, the agent is gone ...). */
  error: optional(errorBody),
  /** agent: the agent drafted it on its own (draft_reply); absent: the owner asked. */
  origin: optional(enumOf(DRAFT_ORIGINS)),
});
export type DraftMeta = Infer<typeof draftMeta>;

export const draftView = object({
  ...draftMeta.shape,
  /** The owner's instruction, read from the owner's computer (absent while it is offline). */
  instruction: optional(draftInstruction),
  /** drafted: the agent's text, read from the owner's computer. */
  text: optional(draftText),
  /** drafted: the file the agent attached (since "attachments.v1"), its name and size read from the owner's computer. */
  attachment: optional(uploadInfo),
});
export type DraftView = Infer<typeof draftView>;

/**
 * A request id the connector's request store keeps: a draft request (drq_) or, since 2026-10-29, a
 * delegation request (dlg_, protocol delegations.ts; connectors with "delegations.v1"). The store is
 * one for both: the owner's instruction (and a draft's text) by request id.
 */
export const storedRequestID = string({ min: 8, max: 64, pattern: /^(?:drq|dlg)_[A-Za-z0-9_-]+$/, format: "stored-request-id" });

/** One request in the connector's request store (draft_store_get). `text` and `attachment` are a draft's only. */
export const storedDraft = object({ requestId: storedRequestID, chatID, instruction: draftInstruction, text: optional(draftText), attachment: optional(uploadInfo) });
export type StoredDraft = Infer<typeof storedDraft>;

/** The Raft agent event's payload: the request id and nothing else (the agent CLI does not even show it). */
export const DRAFT_EVENT_TYPE = "draft_request";
export const draftEventPayload = object({ type: literal(DRAFT_EVENT_TYPE), requestId: draftRequestID });
export type DraftEventPayload = Infer<typeof draftEventPayload>;

/**
 * The Raft agent event's summary: who asked and the request id, never the chat, the instruction or
 * any chat text, and how to go on (the agent sees this line, not the payload).
 */
export function draftEventSummary(ownerName: string | null, requestId: string): string {
  if (!parse(draftRequestID, requestId).ok) throw new Error("invalid draft request id");
  const who = ownerLabelForEvent(ownerName);
  const s = `J-Inbox: ${who} asked you to draft a reply (request ${requestId}). Use the J-Inbox app: get_draft_request, then read_chat, then submit_draft. Draft only; never send.`;
  return s.slice(0, RAFT_EVENT_SUMMARY_MAX);
}

/** The owner's name as a Raft event's summary says it: one plain line, no markup or mentions, or "The owner". */
export function ownerLabelForEvent(ownerName: string | null): string {
  return sanitizeLine(ownerName ?? "", 60).replace(/[\[\]()<>*_`~|\\#!@:]/g, "").replace(/ {2,}/g, " ").trim() || "The owner";
}

/** /live `draft`: a request changed (metadata only; the page reads the texts with list_drafts). */
export const DRAFT_LIVE_TYPE = "draft";
