// Gmail as a second J-Inbox source (design/gmail-plan.md). The connector reads and writes Gmail
// on the owner's Mac; the cloud only runs "Sign in with Google" and refreshes access tokens with
// the web client secret, storing neither email nor tokens.
//
// Ids: accountID "gmail:<address>", chatID "gmail:<address>:<threadId>" (one thread = one chat),
// message ids are Gmail message ids. Attachments: gmail://<urlencoded address>/<messageId>/<attachmentId>.
import { integer, object, string, type Infer } from "./schema.ts";

export const GMAIL_NETWORK = "Gmail";
const PREFIX = "gmail:";
const ASSET_PREFIX = "gmail://";

/** An account address as the connector keeps it: lower case (Google addresses are case-insensitive). */
export const GMAIL_ADDRESS_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,8}\.[a-z]{2,63}$/;
/** Gmail thread and message ids (hex today; a little wider to be safe). */
export const GMAIL_ID_RE = /^[A-Za-z0-9]{1,64}$/;
/** Gmail attachment ids (base64url, can be long). */
export const GMAIL_ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]{1,1500}$/;

/** The address in canonical form, or null when it is not a plausible Google account address. */
export function normalizeGmailAddress(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 254) return null;
  const v = raw.trim().toLowerCase();
  return GMAIL_ADDRESS_RE.test(v) ? v : null;
}

function must(email: string): string {
  const v = normalizeGmailAddress(email);
  if (!v) throw new Error("invalid Gmail address");
  return v;
}

export function gmailAccountID(email: string): string {
  return PREFIX + must(email);
}

/** The address of a Gmail accountID, or null. */
export function parseGmailAccountID(id: unknown): string | null {
  if (typeof id !== "string" || !id.startsWith(PREFIX)) return null;
  const email = id.slice(PREFIX.length);
  return normalizeGmailAddress(email) === email ? email : null;
}

export function gmailChatID(email: string, threadId: string): string {
  if (!GMAIL_ID_RE.test(threadId)) throw new Error("invalid Gmail thread id");
  return `${PREFIX}${must(email)}:${threadId}`;
}

/** {email, threadId} of a Gmail chatID, or null. */
export function parseGmailChatID(id: unknown): { email: string; threadId: string } | null {
  if (typeof id !== "string" || !id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const i = rest.lastIndexOf(":");
  if (i < 1) return null;
  const email = rest.slice(0, i);
  const threadId = rest.slice(i + 1);
  return normalizeGmailAddress(email) === email && GMAIL_ID_RE.test(threadId) ? { email, threadId } : null;
}

/** Any id in the Gmail namespace (well-formed or not): never sent to Beeper. */
export function isGmailID(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(PREFIX);
}

export function gmailAssetURL(email: string, messageId: string, attachmentId: string): string {
  if (!GMAIL_ID_RE.test(messageId) || !GMAIL_ATTACHMENT_ID_RE.test(attachmentId)) throw new Error("invalid Gmail attachment");
  return `${ASSET_PREFIX}${encodeURIComponent(must(email))}/${messageId}/${attachmentId}`;
}

export function parseGmailAssetURL(url: unknown): { email: string; messageId: string; attachmentId: string } | null {
  if (typeof url !== "string" || !url.startsWith(ASSET_PREFIX) || url.length > 2048) return null;
  const parts = url.slice(ASSET_PREFIX.length).split("/");
  if (parts.length !== 3) return null;
  let email: string;
  try {
    email = decodeURIComponent(parts[0]!);
  } catch {
    return null;
  }
  const [, messageId, attachmentId] = parts as [string, string, string];
  if (normalizeGmailAddress(email) !== email || !GMAIL_ID_RE.test(messageId) || !GMAIL_ATTACHMENT_ID_RE.test(attachmentId)) return null;
  if (encodeURIComponent(email) !== parts[0]) return null;
  return { email, messageId, attachmentId };
}

// ---- Sign in with Google (cloud) and the token proxy (connector -> cloud) ----

/** Exactly these: gmail.modify covers read, labels, drafts and send. */
export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"] as const;
export const GOOGLE_SCOPE = GOOGLE_SCOPES.join(" ");
export const GMAIL_MODIFY_SCOPE = GOOGLE_SCOPES[2];

/**
 * start: GET, signed-in owner only, 302 to Google. callback: Google's redirect (registered as
 * <APP_ORIGIN>/auth/google/callback). token: POST, `Authorization: Bearer <deviceToken>`,
 * body googleTokenRequest, answers a bare googleTokenResponse or {ok:false, error}.
 */
export const GOOGLE_PATHS = { start: "/auth/google/start", callback: "/auth/google/callback", token: "/google/token" } as const;

/** OAuth tokens: Google's alphabet ("1//0g...", "ya29...."). Never logged, never stored by the cloud. */
export const oauthToken = string({ min: 8, max: 4096, pattern: /^[A-Za-z0-9._~+/=:-]+$/, format: "oauth-token" });
export const googleTokenRequest = object({ refreshToken: oauthToken });
export const googleTokenResponse = object({ accessToken: oauthToken, expiresIn: integer({ min: 1, max: 86_400 }) });
export type GoogleTokenRequest = Infer<typeof googleTokenRequest>;
export type GoogleTokenResponse = Infer<typeof googleTokenResponse>;

/** Where the connector's Settings link sends the owner after a Gmail account was added (or not). */
export const GMAIL_ADDED_QUERY = "added=gmail";
/**
 * `?gmail_error=<code>` on /settings/accounts: why adding a Gmail account failed (a code, never
 * content). offline: the computer is not connected; update: its connector is too old for Gmail;
 * refused: the connector did not accept the account; denied: the owner cancelled at Google; scope:
 * Gmail access was not granted; state: the sign-in expired, was replayed or belongs to another
 * session; google: Google failed or answered something unusable; rate_limited: too many tries;
 * unavailable: Gmail is not configured on this J-Inbox.
 */
export const GMAIL_CONNECT_ERRORS = ["offline", "update", "refused", "denied", "scope", "state", "google", "rate_limited", "unavailable"] as const;
export type GmailConnectError = (typeof GMAIL_CONNECT_ERRORS)[number];

/** The connector polls Gmail history this often per account. */
export const GMAIL_POLL_INTERVAL_MS = 30_000;
/** /google/token refreshes per device per minute; more answer RATE_LIMITED. */
export const GOOGLE_TOKEN_REFRESHES_PER_MINUTE = 30;
