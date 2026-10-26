// Shared numeric limits. Changing one is a protocol change: note it in the root README changelog.

export const PROTOCOL_VERSION = 1;

/** Largest serialized WebSocket frame (UTF-8 bytes) either side may send. Cloudflare caps messages at 1 MiB. */
export const MAX_FRAME_BYTES = 1_000_000;
/** Raw bytes carried by one media chunk (before base64). */
export const MAX_CHUNK_BYTES = 256 * 1024;
export const MAX_CHUNK_BASE64_LENGTH = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
/** Largest media file relayed by get_media. Bigger files fail with TOO_LARGE. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const MAX_CHUNKS = Math.ceil(MAX_MEDIA_BYTES / MAX_CHUNK_BYTES);

/** Cloud waits this long for a `res` before answering TIMEOUT. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** get_media: time until the `res` (media head). Beeper may download the file first. */
export const MEDIA_TIMEOUT_MS = 60_000;
/** get_media: no chunk for this long fails the stream with TIMEOUT. */
export const MEDIA_IDLE_TIMEOUT_MS = 20_000;
/** get_media: slowest sustained uplink the total deadline allows for (32 KiB/s, about 256 kbit/s). */
export const MEDIA_MIN_BYTES_PER_SECOND = 32 * 1024;
/** get_media: hard cap on one stream, whatever the size. */
export const MEDIA_MAX_TOTAL_MS = 15 * 60_000;
/** Chunks the connector may send beyond the last `ack` (flow control). 8 x 256 KiB = 2 MiB per stream. */
export const MEDIA_WINDOW_CHUNKS = 8;
/** get_media streams one room relays at once; more are answered RATE_LIMITED. */
export const MAX_CONCURRENT_MEDIA_STREAMS = 4;
export const HEARTBEAT_INTERVAL_MS = 25_000;
/** No frame at all for this long means the peer is gone. */
export const HEARTBEAT_TIMEOUT_MS = 60_000;
/** Requests in flight per connector; more are answered RATE_LIMITED. */
export const MAX_INFLIGHT_REQUESTS = 32;
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
/** The connector checks Beeper health this often. */
export const BEEPER_HEALTH_INTERVAL_MS = 30_000;

export const MAX_ID_LENGTH = 512;
export const MAX_REQUEST_ID_LENGTH = 64;
export const MAX_CURSOR_LENGTH = 1024;
export const MAX_URL_LENGTH = 2048;
export const MAX_QUERY_LENGTH = 200;
/** Outgoing message / draft text. */
export const MAX_SEND_TEXT_LENGTH = 10_000;
/** Message text inside results is truncated to this many UTF-16 units (textTruncated: true). */
export const MAX_RESULT_TEXT_LENGTH = 4_000;
export const MAX_TITLE_LENGTH = 500;
export const MAX_NAME_LENGTH = 200;
export const MAX_REACTION_KEY_LENGTH = 256;
export const MAX_PAGE_LIMIT = 50;
export const MAX_ERROR_MESSAGE_LENGTH = 500;
export const MAX_ACCOUNTS = 50;
export const MAX_FILTER_IDS = 20;
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;
export const MAX_REACTIONS_PER_MESSAGE = 50;
export const MAX_EVENT_IDS = 100;
export const MAX_SEARCH_LIMIT = 20;

/** Pairing (device-code flow). */
export const PAIRING_CODE_TTL_SECONDS = 600;
export const PAIRING_POLL_INTERVAL_SECONDS = 5;
/** Agent approval requests expire after this long. */
export const APPROVAL_TTL_MS = 10 * 60_000;
/** The owner gets one Raft notice when the connector has been offline this long. */
export const OFFLINE_ALERT_AFTER_MS = 5 * 60_000;
/** Connector remembers write results by idempotency key this long. */
export const IDEMPOTENCY_TTL_MS = 60 * 60_000;
export const IDEMPOTENCY_MAX_ENTRIES = 1000;
/** Agents get get_media bytes inline (base64 JSON) up to this size; bigger files are TOO_LARGE. */
export const AGENT_MEDIA_INLINE_MAX_BYTES = 1024 * 1024;
/** Connector-side filtered paging (list_chats network/pinnedOnly, unread_summary): stop scanning after this. */
export const LIST_SCAN_BUDGET_MS = 8_000;
export const LIST_SCAN_MAX_PAGES = 20;

/** Sessions. Raft access tokens last 1 h and Raft issues no refresh tokens, so an agent session never outlives its token (and never 1 h). */
export const AGENT_SESSION_MAX_AGE_SECONDS = 3600;
/** A human session ends after this long without a request... */
export const HUMAN_SESSION_IDLE_SECONDS = 12 * 3600;
/** ...and in any case this long after login. */
export const HUMAN_SESSION_ABSOLUTE_SECONDS = 7 * 24 * 3600;
/** Human login-init state (state, nonce, PKCE verifier) lives this long in its cookie. */
export const LOGIN_INIT_TTL_SECONDS = 600;
