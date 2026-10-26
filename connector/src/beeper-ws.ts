// Beeper /v1/ws -> connector `event` frames. Beeper's socket is at-most-once: after any
// reconnect the connector refetches recent chats. Events carry metadata only, never text.
import { BEEPER_APP_STATES, MAX_EVENT_IDS, chatID as chatIDSchema, eventFrame, messageID, parse, type EventFrame } from "@j-inbox/protocol";

/** Every chat, plus app state (needs-login, needs-verification, ready, ...) for the status bar. */
export const BEEPER_SUBSCRIBE = { type: "subscriptions.set", chatIDs: ["*"], app: { state: true } } as const;

/** The subscription command, sent only after the server's `ready`. `app` is dropped for builds that refuse it. */
export function subscribeCommand(requestID: string, withApp: boolean): Record<string, unknown> {
  return withApp ? { ...BEEPER_SUBSCRIBE, requestID } : { type: BEEPER_SUBSCRIBE.type, chatIDs: [...BEEPER_SUBSCRIBE.chatIDs], requestID };
}

/** Control replies on /v1/ws (spec WSReadyMessage, WSSubscriptionsUpdatedMessage, WSErrorMessage). */
export type BeeperControl = { kind: "ready" } | { kind: "subscribed"; requestID: string | null; all: boolean } | { kind: "error"; requestID: string | null; code: string };

export function parseBeeperControl(msg: unknown): BeeperControl | null {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  const requestID = typeof m.requestID === "string" ? m.requestID : null;
  if (m.type === "ready") return { kind: "ready" };
  if (m.type === "subscriptions.updated") return { kind: "subscribed", requestID, all: Array.isArray(m.chatIDs) && m.chatIDs.length === 1 && m.chatIDs[0] === "*" };
  if (m.type === "error") return { kind: "error", requestID, code: typeof m.code === "string" ? m.code.slice(0, 64) : "UNKNOWN" };
  return null;
}

const valid = (f: unknown): f is EventFrame => parse(eventFrame, f).ok;

export function mapBeeperEvent(msg: unknown, ctx: { beeperVersion: string | null; now: string }): EventFrame[] {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return [];
  const m = msg as Record<string, any>;
  const ts = ctx.now;
  if (m.type === "app.state.updated") {
    const state = (BEEPER_APP_STATES as readonly string[]).includes(m.appState?.state) ? m.appState.state : "unknown";
    const f = { type: "event", kind: "status", ts, beeper: { reachable: true, version: ctx.beeperVersion, appState: state } };
    return valid(f) ? [f] : [];
  }
  const op = m.type === "message.upserted" || m.type === "chat.upserted" ? "upserted" : m.type === "message.deleted" || m.type === "chat.deleted" ? "deleted" : null;
  if (!op || !parse(chatIDSchema, m.chatID).ok) return [];
  if (m.type.startsWith("chat.")) {
    const unread = m.entries?.[0]?.unreadCount;
    const f = { type: "event", kind: "chat", op, chatID: m.chatID, ts, ...(Number.isSafeInteger(unread) && unread >= 0 ? { unreadCount: unread } : {}) };
    return valid(f) ? [f] : [];
  }
  const ids: string[] = (Array.isArray(m.ids) ? m.ids : []).filter((x: unknown) => parse(messageID, x).ok);
  const out: EventFrame[] = [];
  for (let i = 0; i < ids.length; i += MAX_EVENT_IDS) {
    const f = { type: "event", kind: "message", op, chatID: m.chatID, messageIDs: ids.slice(i, i + MAX_EVENT_IDS), ts };
    if (valid(f)) out.push(f);
  }
  return out;
}
