// Connecting chat apps from the owner's page (Settings > Chats): the shapes of the chat_apps and
// chat_login_* actions. The connector runs Beeper's own sign-in for a network (Beeper Client API:
// GET /v1/bridges, login flows, login sessions and their steps) and hands the page only what a step
// needs: a QR code's data, a code to type on the phone, a form's fields, or "a sign-in window is open
// on your Mac" (a website sign-in, done in a small window the connector opens on the Mac).
// What the owner types (a phone number, a code, a password) goes page -> cloud -> connector ->
// Beeper and is kept nowhere on the way; a QR code's data and a website's cookies are sign-in
// secrets too. None of it is logged.
import { array, boolean, discriminated, enumOf, literal, object, optional, record, string, text, type Infer } from "./schema.ts";
import { ACCOUNT_STATUSES, accountID } from "./model.ts";

/**
 * The chat apps J-Inbox offers, in the order Settings > Chats lists them. Nothing else is ever
 * offered or shown there, and Beeper's own account (its Matrix network) never is. Matched to
 * Beeper's bridges by the bridge's id and type (`chatAppOf`), never by a display name.
 * iMessage runs on the Mac itself: shown, never connected from the page.
 */
export const CHAT_APP_KEYS = ["whatsapp", "telegram", "instagram", "messenger", "linkedin", "x", "discord", "slack", "signal", "imessage"] as const;
export type ChatAppKey = (typeof CHAT_APP_KEYS)[number];
/** The ones the page can connect (iMessage is "On this Mac"). */
export const CONNECTABLE_CHAT_APPS = CHAT_APP_KEYS.filter((k) => k !== "imessage") as Exclude<ChatAppKey, "imessage">[];
export type ConnectableChatApp = Exclude<ChatAppKey, "imessage">;

/**
 * How Beeper names each app's bridges: a bridge whose id (without "local-") or whose type is one of
 * these belongs to the app. Bridge ids seen in 2026-11: "local-whatsapp", "local-telegram",
 * "local-signal", "local-discord", "local-slack", "local-facebook", "local-instagram"; cloud bridges
 * use their type ("discordgo", "slackgo", "instagramgo", "linkedin", "twitter").
 */
export const CHAT_APP_BRIDGES: Record<ChatAppKey, readonly string[]> = {
  whatsapp: ["whatsapp"],
  telegram: ["telegram"],
  instagram: ["instagram", "instagramgo"],
  messenger: ["facebook", "facebookgo", "messenger"],
  linkedin: ["linkedin"],
  x: ["twitter", "x"],
  discord: ["discord", "discordgo"],
  slack: ["slack", "slackgo"],
  signal: ["signal"],
  imessage: ["imessage", "imessagego"],
};

/** The words for each app (the page's own; never Beeper's display text). */
export const CHAT_APP_NAMES: Record<ChatAppKey, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
  messenger: "Messenger",
  linkedin: "LinkedIn",
  x: "X",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  imessage: "iMessage",
};

const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");

/** The app a Beeper bridge belongs to, by its id first, then its type; null for anything else (Beeper's own "matrix", Google Voice, LINE...). */
export function chatAppOf(bridge: { id?: unknown; type?: unknown }): ChatAppKey | null {
  const idKey = lower(bridge.id).replace(/^local-/, "");
  const typeKey = lower(bridge.type);
  for (const k of CHAT_APP_KEYS) if (CHAT_APP_BRIDGES[k].includes(idKey)) return k;
  for (const k of CHAT_APP_KEYS) if (CHAT_APP_BRIDGES[k].includes(typeKey)) return k;
  return null;
}

/**
 * Beeper's own account (its Matrix login): never a chat app, never offered, never listed. By
 * identity: the account id "matrix" or a bridge of type or id "matrix".
 */
export function isBeeperOwnAccount(a: { accountID?: unknown; bridge?: unknown }): boolean {
  if (a.accountID === "matrix") return true;
  const b = a.bridge && typeof a.bridge === "object" ? (a.bridge as { id?: unknown; type?: unknown }) : null;
  return !!b && (lower(b.type) === "matrix" || lower(b.id) === "matrix");
}

/**
 * Which login flow the page asks for, best first, by where it is. On a computer a QR code is
 * scanned with the phone; on the phone itself it cannot be, so there WhatsApp and Telegram use their
 * code flows, Signal and Discord (QR only) say to connect on a computer ("computer"), and Instagram,
 * whose sign-in is its own website in a window on the Mac, says it needs the Mac ("mac"). A flow the
 * bridge does not offer is skipped; none left: Beeper's default.
 */
export const CHAT_APP_FLOWS: Record<ConnectableChatApp, { computer: readonly string[]; phone: readonly string[] | "computer" | "mac" }> = {
  whatsapp: { computer: ["qr"], phone: ["phone"] },
  telegram: { computer: ["qr"], phone: ["phone"] },
  signal: { computer: ["qr"], phone: "computer" },
  discord: { computer: ["qr"], phone: "computer" },
  slack: { computer: ["email"], phone: ["email"] },
  messenger: { computer: ["messenger-lite-android", "messenger", "facebook"], phone: ["messenger-lite-android"] },
  instagram: { computer: ["instagram"], phone: "mac" },
  linkedin: { computer: [], phone: [] },
  x: { computer: [], phone: [] },
};

/** The other ways to sign in the page offers under the first (a code instead of the QR code). */
export const CHAT_APP_ALTERNATIVES: Partial<Record<ConnectableChatApp, readonly string[]>> = {
  whatsapp: ["phone"],
  telegram: ["phone"],
};

/** The flow to use: the first preferred one the bridge offers; undefined = Beeper's default (or none offered). */
export function pickFlow(preferred: readonly string[], offered: readonly { id: string }[]): string | undefined {
  for (const id of preferred) if (offered.some((f) => f.id === id)) return id;
  return undefined;
}

/** Beeper's bridge ids (e.g. "local-whatsapp", "telegram"). */
export const bridgeID = string({ min: 1, max: 128, pattern: /^[A-Za-z0-9_.-]+$/, format: "bridge-id" });
/** A login flow's id (e.g. "qr", "phone", "messenger-lite-android"). */
export const loginFlowID = string({ min: 1, max: 128, pattern: /^[A-Za-z0-9_.:-]+$/, format: "flow-id" });
/** The connector's own name for one sign-in in progress (not Beeper's). */
export const chatLoginSessionID = string({ min: 8, max: 64, pattern: /^cl_[A-Za-z0-9_-]+$/, format: "chat-login-id" });
/** A step's id as Beeper names it (e.g. "fi.mau.whatsapp.qr"): printable ASCII. */
export const loginStepID = string({ min: 1, max: 256, pattern: /^[\x21-\x7e]+$/, format: "step-id" });
/** A form field's id, as Beeper names it. */
export const loginFieldID = string({ min: 1, max: 128, pattern: /^[\x21-\x7e]+$/, format: "field-id" });
/** One value the owner typed. Long enough for a pasted token; nothing keeps it. */
export const loginFieldValue = string({ min: 0, max: 4000 });
export const MAX_LOGIN_FIELDS = 10;
export const chatAppKey = enumOf(CHAT_APP_KEYS);
export const connectableChatApp = enumOf(CONNECTABLE_CHAT_APPS);

/**
 * How a field is shown: password is masked; code is a one-time code (numeric keyboard where it
 * fits); tel a phone number. The connector maps Beeper's suggested types onto these.
 */
export const CHAT_LOGIN_FIELD_KINDS = ["text", "password", "email", "tel", "code", "url"] as const;
export type ChatLoginFieldKind = (typeof CHAT_LOGIN_FIELD_KINDS)[number];

export const chatLoginField = object({
  id: loginFieldID,
  label: string({ min: 1, max: 200 }),
  kind: enumOf(CHAT_LOGIN_FIELD_KINDS),
  placeholder: optional(string({ min: 1, max: 200 })),
  optional: optional(boolean()),
  /** Beeper's own suggestion for the field (never anything the owner typed). */
  initial: optional(string({ min: 1, max: 500 })),
});
export type ChatLoginField = Infer<typeof chatLoginField>;

export const chatLoginFlow = object({ id: loginFlowID, name: string({ min: 1, max: 100 }) });
export type ChatLoginFlow = Infer<typeof chatLoginFlow>;

/** One account of a chat app, as the page shows it. */
export const chatAppAccount = object({
  accountID,
  /** Who the owner is there (Beeper's user name, phone number or handle). */
  name: optional(string({ min: 1, max: 200 })),
  status: enumOf(ACCOUNT_STATUSES),
  statusText: optional(string({ min: 1, max: 200 })),
  /** Signed out or stopped: Reconnect runs the same sign-in again for this account. */
  needsReconnect: boolean(),
  /** Remove… can sign Beeper out of it (it has a bridge login). */
  removable: boolean(),
});
export type ChatAppAccount = Infer<typeof chatAppAccount>;

/**
 * available: Connect works; full: the app's own limit of accounts is reached (another cannot be
 * added); unavailable: Beeper cannot add one right now, or this Beeper has no bridge for it.
 */
export const CHAT_APP_STATES = ["available", "full", "unavailable"] as const;

/** One chat app as Beeper has it on this computer. */
export const chatApp = object({
  app: chatAppKey,
  state: enumOf(CHAT_APP_STATES),
  /** The bridge a new account would use runs on this computer (an on-device bridge), not on Beeper's servers. */
  onDevice: boolean(),
  /** The ways to sign in Beeper offers for it (ids the page picks from with CHAT_APP_FLOWS). Empty: Beeper's default. */
  flows: array(chatLoginFlow, { max: 8 }),
  accounts: array(chatAppAccount, { max: 20 }),
});
export type ChatApp = Infer<typeof chatApp>;

/** What a display step shows: a QR code to scan, a code to type on the phone, an emoji picture, or nothing (just wait). */
export const CHAT_LOGIN_SHOW = ["qr", "code", "emoji", "nothing"] as const;

export const chatLoginStep = discriminated("kind", {
  display: object({
    kind: literal("display"),
    stepID: loginStepID,
    show: enumOf(CHAT_LOGIN_SHOW),
    /** The QR code's text or the code. A sign-in secret: shown, never kept. */
    data: optional(string({ min: 1, max: 4096 })),
    /** emoji: the picture, base64 (PNG, JPEG, GIF or WebP), with its type. */
    image: optional(string({ min: 1, max: 350_000, pattern: /^[A-Za-z0-9+/]+={0,2}$/ })),
    imageType: optional(enumOf(["image/png", "image/jpeg", "image/gif", "image/webp"] as const)),
    instructions: optional(text({ min: 1, max: 1000 })),
  }),
  form: object({
    kind: literal("form"),
    stepID: loginStepID,
    fields: array(chatLoginField, { min: 1, max: MAX_LOGIN_FIELDS }),
    instructions: optional(text({ min: 1, max: 1000 })),
  }),
  /**
   * A website sign-in (Beeper's cookies step): a window on the Mac shows the site; what the site
   * hands over after the sign-in goes from there to Beeper, never to the page. `site`: the host it
   * shows. `window`: open (waiting for the owner there), or not opened (asked not to, or the
   * window's helper is not on this Mac: the sign-in was cancelled).
   */
  browser: object({
    kind: literal("browser"),
    stepID: loginStepID,
    site: string({ min: 1, max: 253, pattern: /^[A-Za-z0-9.-]+$/ }),
    window: enumOf(["open", "not-opened", "missing"] as const),
  }),
});
export type ChatLoginStep = Infer<typeof chatLoginStep>;

/**
 * waiting: Beeper works, or waits for the phone or the Mac's window (a display or browser step);
 * input: a form to fill; done: the account is connected; failed, cancelled, expired: over (start
 * again). `retry`: what was just sent did not work (a wrong code) and the same form asks again.
 */
export const CHAT_LOGIN_STATUSES = ["waiting", "input", "done", "failed", "cancelled", "expired"] as const;
export type ChatLoginStatus = (typeof CHAT_LOGIN_STATUSES)[number];

/**
 * Why it ended, when the page has words for it: window-closed (the sign-in window on the Mac was
 * closed), no-window (that window's helper is not on this Mac), needs-mac (a website sign-in, and
 * the page asked for no window: on a phone), busy (Beeper still has another sign-in open).
 */
export const CHAT_LOGIN_PROBLEMS = ["window-closed", "no-window", "needs-mac", "busy"] as const;

export const chatLoginState = object({
  sessionID: chatLoginSessionID,
  app: connectableChatApp,
  status: enumOf(CHAT_LOGIN_STATUSES),
  step: optional(chatLoginStep),
  retry: optional(literal(true)),
  problem: optional(enumOf(CHAT_LOGIN_PROBLEMS)),
  /** done: who the owner is on the app now. */
  account: optional(object({ name: optional(string({ min: 1, max: 200 })) })),
});
export type ChatLoginState = Infer<typeof chatLoginState>;

export const chatLoginFields = record(loginFieldID, loginFieldValue, { max: MAX_LOGIN_FIELDS });

/** How long the page waits between asks while a sign-in runs. */
export const CHAT_LOGIN_POLL_MS = 1500;
/** A sign-in nobody asked about for this long is cancelled on Beeper (the page went away). */
export const CHAT_LOGIN_IDLE_MS = 60_000;
/**
 * The same while the person is likely in another app: a QR code or a code to type on the phone, or a
 * code sent to them. A phone's browser stops asking while it is in the background, so this is longer.
 */
export const CHAT_LOGIN_AWAY_MS = 5 * 60_000;
/** The longest a sign-in may run before it is cancelled as expired. */
export const CHAT_LOGIN_MAX_MS = 10 * 60_000;
