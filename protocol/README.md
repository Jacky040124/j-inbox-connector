# @j-inbox/protocol

The single source of truth for every J-Inbox contract, with strict runtime validators.
MIT licensed. No dependencies; runs unchanged in Cloudflare Workers, Bun and browsers.

**Test:** `cd protocol && bun test`

Import TypeScript source directly: `import { parseActionParams } from "@j-inbox/protocol"`.

Changes must be **additive** and recorded in the root README changelog (see "Rules" there).

## Files

| File | Contents |
|---|---|
| `schema.ts` | Tiny validator library: `string` (single line), `text` (multi-line), `id`, `cursor`, `isoDateTime`, `base64`, `assetUrl`, `httpUrl`, `integer`, `number`, `boolean`, `literal`, `enumOf`, `array`, `object` (strict), `optional`, `nullable`, `record`, `discriminated`, `refine`, `jsonObject`/`jsonValue`. `parse(schema, value)` returns `{ok, value}` or `{ok:false, issues}`; issues never echo input values, record keys (reported as `<entry i>`) or unknown keys that do not look like field names (reported at the parent path). Output objects are fresh copies containing only declared keys. |
| `limits.ts` | `PROTOCOL_VERSION` and every numeric limit (frame size, chunk size, timeouts, string lengths, page sizes). |
| `errors.ts` | `ERROR_CODES`, `httpStatusForError`, `isRetryable(code, action)`, `errorAfterDispatch`, `errorBody`, `makeError` (clamps and sanitizes). |
| `textutil.ts` | `truncateText`, `sanitizeText`, `sanitizeLine`: turn hostile upstream text into values the validators accept. |
| `model.ts` | Normalized data shapes: `chatSummary`, `messageItem`, `attachment`, `reaction`, `account`, `beeperHealth`, `mediaHead`. |
| `actions.ts` | The action catalogue `ACTIONS`, `parseActionParams` (fills defaults), `parseActionResult`, `coerceAgentParams`. |
| `frames.ts` | Connector<->cloud frames, `parseConnectorFrame`, `parseCloudFrame`, `encodeFrame`, media chunking and flow control (`makeChunkFrames`, `ChunkAssembler`, `ChunkWindow`, `mediaDeadlineMs`), `CLOSE_CODES`, `shouldReconnect`, `backoffDelay`. |
| `agent.ts` | Raft App surface: `buildRaftManifest`, agent action response, approvals (`approvalTicket`, `approvalView`), `agentMediaResult`, owner notices (`ownerNoticeText`, `offlineAlertDue`), room binding (`canBindRoom`, `authorizeRoomAccess`), meta actions `whoami` and `approval_status`. |
| `web.ts` | Browser API routes and shapes, CSRF header, `mediaResponseHeaders`, `WEB_HTML_HEADERS`, human and agent session cookies, logout, local-cache rules, upgrade `Origin` checks, `/live` messages. |
| `auth.ts` | Login with Raft (`startHumanLogin`, `handleRaftCallback`: state + nonce + PKCE for humans, stateless only for proven agents), session lifetimes (`sessionExpired`, `agentSessionMaxAge`), surfaces (`surfaceForPath`, `sessionKindForSurface`, `authorizeSurface`). |
| `pairing.ts` | Device-code pairing flow, user/device codes, device tokens, `hashToken`, `checkPairConfirm`, `approximateIP`, `PairingGuard` attempt limits. |

## Validation rules

- Objects reject unknown fields (including `__proto__`/`constructor` smuggled via `JSON.parse`).
- Every string and array is bounded. Lengths count UTF-16 code units.
- Single-line strings reject all C0/C1 control characters; `text` allows `\t \n \r` only. Both reject lone surrogates. Use `sanitizeLine` / `sanitizeText` / `truncateText` when mapping upstream data.
- `id` (Beeper ids) rejects whitespace and invisible formatting characters but allows `#`, `/`, `?`, `!`, `:`. Always `encodeURIComponent` ids in URL paths.
- `ownId` (ids J-Inbox mints: devices, approvals) is `[A-Za-z0-9_-]{1,64}`.
- `assetUrl` accepts only `mxc://`, `localmxc://` and `file:///` without `..` traversal (after percent-decoding).
- Frames are size-checked in UTF-8 bytes before `JSON.parse` (`MAX_FRAME_BYTES` = 1,000,000).

## Error codes

| Code | HTTP | Retryable (`isRetryable(code, action)`) | Meaning |
|---|---|---|---|
| `OFFLINE` | 503 | yes | Connector not connected; the request was **never dispatched** |
| `BEEPER_DOWN` | 502 | yes | Connector up, Beeper API unreachable; the request **never reached Beeper** (connection refused; for reads also a Beeper 5xx). A Beeper 5xx on a **write** is `UNKNOWN_OUTCOME`: 502 means Beeper's upstream answered badly, so the message may be out |
| `BEEPER_UNAUTHORIZED` | 502 | **no** | Beeper rejected the connector's token (revoked or expired, Beeper 401). Nothing ran. The owner must re-authorize (`j-inbox doctor`); `beeperHealth.tokenValid` is `false`. Not 401, because the web UI logs out on 401 |
| `NOT_ALLOWED` | 403 | no | Action not whitelisted, or caller lacks permission |
| `TIMEOUT` | 504 | reads only | No answer within the timeout. For writes the cloud answers `UNKNOWN_OUTCOME` instead (`errorAfterDispatch`) |
| `BAD_PARAMS` | 400 | no | Params failed validation |
| `TOO_LARGE` | 413 | no | Payload or media over a limit |
| `RATE_LIMITED` | 429 | yes | Per-action, media-stream or in-flight cap hit |
| `INTERNAL` | 500 | reads only | Unexpected failure |
| `NOT_FOUND` | 404 | no | Chat/message/asset/approval/room does not exist |
| `UNAUTHENTICATED` | 401 | no | Missing or expired session / device credential |
| `UNKNOWN_OUTCOME` | 502 | **no** | A write was dispatched and its answer was lost (timeout, socket drop, crash). It may have happened: read back (e.g. `read_chat`) before trying again, or retry with the same `idempotencyKey` |
| `CONFLICT` | 409 | no | The target's state forbids it, e.g. `draft_reply` when the chat already has a draft; a second owner trying to bind a server |

Error messages are for humans and agents; never put message text, tokens or chat names in them.

**No double sends.** The cancel frame cannot undo a POST Beeper already accepted. So: (1) the cloud
maps a lost answer to a dispatched write to `UNKNOWN_OUTCOME` (`errorAfterDispatch`), never to a
retryable code; (2) `send_message` and `react` take an optional `idempotencyKey`; the web UI and
agents send one and reuse it on retry; (3) the connector remembers `action + idempotencyKey ->
result` for `IDEMPOTENCY_TTL_MS` (`IDEMPOTENCY_MAX_ENTRIES`), replays the first result for a repeat
(also while the first is still running) and never calls Beeper twice for the same key. Results
that prove the write never reached Beeper (`BEEPER_DOWN` = connection refused,
`BEEPER_UNAUTHORIZED`, `RATE_LIMITED`) are not remembered, so a retry runs again; everything else,
including a Beeper 5xx (`UNKNOWN_OUTCOME`), is.
(4) A key reused with **different parameters** (other text or `replyToMessageID`; for `react`
other `messageID`/`reactionKey`) answers `CONFLICT` and is never replayed. (5) The cloud never
forwards a caller's raw key: it sends `scopeIdempotencyKey({type, sub}, key)`, so two agents (or an
agent and the owner) that pick the same key cannot collide. (6) Keys survive a connector restart:
the connector records each key as in flight in an on-disk journal (`FileIdempotencyJournal`: key
hash, parameter digest, state, result ids; never text) **before** calling Beeper, so a write that
was in flight when the process died answers `UNKNOWN_OUTCOME` after the restart and is never sent
again. `connector/src/idempotency.ts` implements this.

## Action catalogue

Shared by the connector whitelist, the Raft manifest and the web API. Params and results are
camelCase (like Beeper). Agent writes marked "approval" go through the approval flow below.

| Action | Params (all strict; `?` optional) | Result | write | approval for agents | Beeper call |
|---|---|---|---|---|---|
| `status` | – | `{online, lastSeenAt, connectorVersion, beeper:{reachable, version, appState?, tokenValid?}, accounts[], networks?[]}`. `networks` is the platform list; `accounts[]` alone is not (no iMessage account, `X` vs `Twitter/X`) | | | `GET /v1/info`, `GET /v1/accounts`, `GET /v1/chats` (first page, networks by `accountID`) |
| `list_chats` | `network? accountIDs? unreadOnly? pinnedOnly? inbox?(primary/low-priority/archive) type?(single/group/any) query? limit?(1-50, 25) cursor?` | `{items: ChatSummary[], hasMore, nextCursor}` | | | `GET /v1/chats` or `/v1/chats/search`, then connector-side `network`/`pinnedOnly` filter (see "Filtered paging") |
| `unread_summary` | `limit?(1-50, 50)` | `{totalUnreadChats, totalUnreadMessages, items: ChatSummary[] (with preview), truncated}` | | | `GET /v1/chats` (ChatWithPreview) paged, keep `unreadCount>0 \|\| isMarkedUnread`, drop `isArchived` and `isLowPriority` chats (Beeper's inbox view). Not `/v1/chats/search`: it returns `Chat` without `preview` |
| `read_chat` | `chatID cursor? limit?(1-50, 30)` | `{chat, items: MessageItem[] oldest-first, hasMore, nextCursor}` (nextCursor = older) | | | `GET /v1/chats/{id}`, `GET /v1/chats/{id}/messages?cursor&direction=before` |
| `search_messages` | `query chatIDs? accountIDs? network? sender?(me/others) dateAfter? dateBefore? limit?(1-20, 20) cursor?` | `{items, chats: {chatID: ChatSummary}, hasMore, nextCursor}` | | | `GET /v1/messages/search` |
| `draft_reply` | `chatID text(1-10000)` | `{chatID, draftSet: true}` | yes | no | `GET /v1/chats/{id}`; if `draft` is non-empty answer `CONFLICT` (never clear the owner's half-typed text); else `PATCH /v1/chats/{id}` `{draft:{text}}`; Beeper 409/422 -> `CONFLICT` |
| `send_message` | `chatID text(1-10000) replyToMessageID? idempotencyKey?` | `{chatID, pendingMessageID}` | yes | **yes** (10/min) | `POST /v1/chats/{id}/messages` |
| `react` | `chatID messageID reactionKey idempotencyKey?` | `{chatID, messageID, reactionKey}` | yes | **yes** (30/min) | `POST .../messages/{mid}/reactions` |
| `mark_read` | `chatID messageID? read?(true)` (`read:false` marks unread) | `{chatID, read}` | yes | **yes** | `POST /v1/chats/{id}/read` or `/unread` |
| `archive` | `chatID archived?(true)` | `{chatID, archived}` | yes | **yes** | `POST /v1/chats/{id}/archive` |
| `get_media` | `url` (an attachment `url` or chat `avatarURL` from another result) | `res` = `{mimeType, size (null if unknown), fileName?}` then `chunk` frames | | | `GET /v1/assets/serve?url=` |

Notes for implementers:

- `parseActionParams(name, raw)` validates and fills `defaults`. Agent requests: `parseActionParams(name, coerceAgentParams(name, raw))` because `raft integration invoke --param` sends strings.
- Message `text` in results is at most `MAX_RESULT_TEXT_LENGTH` (4000) with `textTruncated: true` when cut; single-line fields (titles, names) must be `sanitizeLine`d.
- `get_media`: the connector must only serve asset URLs it has itself returned in a result
  (Beeper serves arbitrary `file://` paths). Over `MAX_MEDIA_BYTES` (25 MiB): `TOO_LARGE`.
- Array params (`accountIDs`, `chatIDs`): `raft integration invoke --param` is text-only and the
  released CLI rejects `--param` for array/object params, so agents must use `--data-json`
  (the param docs say so).
- **Mapping Beeper data** (`connector/src/beeper-map.ts`): Beeper omits fields the protocol requires.
  Defaults: missing `Message.type` -> derived from the first attachment (img `IMAGE`, video
  `VIDEO`, voice note `VOICE`, audio `AUDIO`, other `FILE`), else `TEXT` when there is text, else
  `UNKNOWN` (real iMessage messages have no `type`); missing `isSender` -> `false`; missing
  `isPinned`/`isMuted`/`isArchived` -> `false`; missing `Account.network` -> `"Unknown"`.
  A chat's draft becomes `hasDraft: boolean`: the owner's unsent text is never sent to the cloud or
  to agents. `isLowPriority` is passed through. `list_chats` with `unreadOnly` and no `inbox`
  covers every inbox (archived and low priority too); pass `inbox: "primary"` for Beeper's main
  inbox.
  `REACTION` messages in history are passed through as `type: "REACTION"`.
- **Big pages** (`connector/src/pager.ts` `fitToFrame`): a valid page can serialize to more than
  `MAX_FRAME_BYTES` (long CJK texts, many attachments and reactions). The connector then returns
  fewer items (newest kept), `hasMore: true` and a cursor that continues exactly after the last item
  it returned. One maximal message always fits.

### Filtered paging (list_chats `network`/`pinnedOnly`, unread_summary)

Beeper has no network or pinned filter, account network names differ from chat network names
(`X` vs `Twitter/X`, and there is no iMessage account), so the connector filters on the **chat's**
`network` (case-insensitive) and `isPinned` itself. It walks Beeper pages (cursor +
`direction=before`) until `limit` items match, Beeper has no more, or `LIST_SCAN_BUDGET_MS` /
`LIST_SCAN_MAX_PAGES` run out; then it answers with what it has, `hasMore` true if Beeper had more.
`nextCursor` is the connector's own cursor (`j2.` + base64url JSON of the Beeper cursor, a short
hash of the last returned item's id and a hash of the cursor's scope), opaque to everyone else. An
empty Beeper page ends the walk even if `hasMore` was true (real iMessage history does this).

- A cursor works only for the scope that minted it: `read_chat` for the same `chatID`,
  `list_chats` with the same filters. Anything else (another chat, another action, other
  filters, garbage) is `BAD_PARAMS`, never an empty or wrong page.
- Cursor size does not depend on id length (the item id is hashed). If Beeper's own cursor is too
  long to wrap within `MAX_CURSOR_LENGTH`, the answer is `TOO_LARGE` (not retryable), never
  `INTERNAL`.
- New items between calls: a cursor that points into the newest Beeper page is resumed by walking
  older pages until its item shows up, so the next page is never newer than the previous one. If
  the item is gone for good (deleted, or out of the scan budget) the answer is `BAD_PARAMS`
  ("cursor expired, reload"). On an older page the page itself is stable; if the item vanished
  that page is restarted (may repeat, never skips).

## Connector <-> cloud WebSocket (`wss://<app>/connect`)

Upgrade request: `Authorization: Bearer <deviceToken>`. JSON text frames, each at most
`MAX_FRAME_BYTES`.

```
connector -> cloud   hello  {v, deviceID, connectorVersion, beeperVersion|null, platform{os,arch}, networks[] (connectedNetworks()), capabilities?}
cloud -> connector   welcome{v, serverTime, heartbeatMs, requestTimeoutMs, maxFrameBytes}
cloud -> connector   req    {id, action, params, caller?{type:"human"|"agent", name?}}   action must be in the catalogue
connector -> cloud   res    {id, ok:true, data} | {id, ok:false, error{code,message}}
connector -> cloud   chunk  {id, seq, data(base64 <= 256 KiB raw), last, error?}   get_media only, after res
cloud -> connector   ack    {id, seq}                       get_media flow control: chunk seq was written out
cloud -> connector   cancel {id}                            caller gone or timed out
connector -> cloud   event  {kind:"message", op, chatID, messageIDs[1..100], ts}
                            {kind:"chat", op, chatID, ts, unreadCount?}
                            {kind:"status", ts, beeper{reachable, version, appState?}}
both                 ping {t} / pong {t}                    every 25 s; 60 s silence = dead
```

- Events carry **metadata only**; clients refetch content with `read_chat`.
- `req.caller` (optional) says who asked, for the connector's local audit log only: the caller type
  and the Raft display name (`sanitizeLine`d, 1-200 chars, omitted when empty). Never a sub, chat
  or message value.
- `hello.capabilities` values are in `CAPABILITIES`: `"media.v1"` = `get_media` streams chunks
  under `ack` flow control. The cloud may gate new behaviour on them.
- Connector behaviour the cloud may rely on: a duplicate in-flight `req` id is ignored; a `req`
  that arrives while the connector shuts down gets `OFFLINE` and is not dispatched; a queued `req`
  whose deadline has (nearly) passed gets `TIMEOUT` without being dispatched; a `get_media` stream
  the cloud stops acking is dropped at `mediaDeadlineMs(size)` without a final chunk, so the
  cloud's own idle timeout (`MEDIA_IDLE_TIMEOUT_MS`) ends it.
- The connector answers a `req` whose action it does not know with `NOT_ALLOWED`, and invalid params with `BAD_PARAMS` (it validates with `parseActionParams`).
- One deadline per `req`: the connector gives the whole request (every Beeper call, every scanned
  page) `welcome.requestTimeoutMs` minus a margin, and aborts it on `cancel`. A read that runs out
  of time answers `TIMEOUT`; a write whose deadline passed before it was dispatched answers
  `TIMEOUT` (nothing was sent, the idempotency key stays free); a write in flight when time ran
  out is `UNKNOWN_OUTCOME`.
- Close codes (`CLOSE_CODES`): 4400 bad frame, 4401 unauthenticated (only for a device token the cloud rejected), 4403 revoked, 4408 heartbeat timeout and `HELLO_TIMEOUT` (no hello in time: a timeout, so reconnect), 4409 replaced by another paired computer, 4410 `SUPERSEDED` (the same device connected again; reconnect after a long delay), 4413 too large, 4426 version unsupported. `shouldReconnect(code)` is false for 4401, 4403, 4409, 4426. The connector re-checks a 4401 a few times before it stops (an older cloud sent 4401 for a slow hello). Reconnect delay: `backoffDelay(attempt)` = 1 s, 2 s, 4 s ... 60 s, with +/-20% jitter.
- After every reconnect (to the cloud or to Beeper `/v1/ws`), the connector re-syncs recent chats and emits events, because Beeper's WebSocket is at-most-once.
- Media flow control: the connector sends chunk `seq` only while `seq <= lastAck + MEDIA_WINDOW_CHUNKS`
  (8 x 256 KiB), using `ChunkWindow.waitFor(seq)`. The cloud streams with
  `ChunkAssembler({expectedSize, onBytes}).accept(frame)`, which awaits `onBytes` (the
  `writer.write()` into the HTTP response) and only then returns the `ack` frame to send. So a slow
  reader slows the connector instead of filling Durable Object memory.
- Media limits: `MAX_CONCURRENT_MEDIA_STREAMS` (4) per room (more: `RATE_LIMITED`); the `res` head
  must arrive within `MEDIA_TIMEOUT_MS` (60 s); then no chunk for `MEDIA_IDLE_TIMEOUT_MS` (20 s) is
  `TIMEOUT`; the whole stream must finish within `mediaDeadlineMs(size)` (scales with size at
  `MEDIA_MIN_BYTES_PER_SECOND`, capped at 15 min). `size` may be `null` when Beeper streams without
  `Content-Length`; the assembler then caps the running total at `MAX_MEDIA_BYTES`.

## Raft agent surface (`agent.ts`)

- Manifest: `buildRaftManifest({origin, service})` served at `/.well-known/raft-agent-manifest.json`. `origin` must be the canonical constant, never derived from `Host`. Each action posts JSON to `/api/raft/actions/<name>`. Only documented manifest fields are used (`name`, `description`, `endpoint`, `parameters`).
- Agent `get_media` answers JSON `agentMediaResult` `{mimeType, size, fileName, encoding:"base64", data}` for files up to `AGENT_MEDIA_INLINE_MAX_BYTES` (1 MiB), else `TOO_LARGE`. No raw bytes and no download URLs for agents.
- Login: the single registered return URL is `RAFT_CALLBACK_PATH` (`/auth/raft/callback`), handled by `handleRaftCallback` (`auth.ts`). Agents arrive there with `?code=` and no login state and are accepted only if `userinfo.type === "agent"`; they get the **agent** session cookie (`__Host-jinbox_agent`, `Path=/`, at most 1 h and never past the Raft token). Humans must come through `startHumanLogin` (OIDC authorize, `state` + `nonce` + PKCE S256 in a sealed 10-minute login-init cookie); a human without valid login-init state is refused with 4xx and no Set-Cookie.
- Agent sessions work only on `/api/raft/actions/*`; human sessions only on the web surface (`authorizeSurface`).
- Approval caps (`canCreateApproval`): 5 pending per agent, 20 per room, and creations count against the action's `rateLimitPerMinute`; more is `RATE_LIMITED`. Approval DMs are grouped (`approvalNoticeDue`, `approvals_pending`).
- Responses (`agentActionResponse`): `200 {ok:true, status:"done", result}`, `202 {ok:true, status:"pending_approval", approval:{id, action, expiresAt, approveURL}}`, or `4xx/5xx {ok:false, status:"error", error}`.
- **Approval** (Raft has no manifest flag for it): the owner opens `approveURL` in the web UI, sees `approvalView` (who asked, which chat, the exact text), approves or denies; the cloud runs the action; the agent reads the outcome with `approval_status {approvalID}`. Pending approvals live in memory only and expire after `APPROVAL_TTL_MS` (10 min).
- **Telling the owner** (plan step 3): the cloud sends a Raft DM from the **J-Inbox App Bot**
  (`enableBot`, per-server bot grant, `sk_agent_*` key minted by the backend; docs.raft.build
  "App Bot") to the room owner with `ownerNoticeText({kind:"approval_requested", ...})`, and the
  ticket says `delivery: "raft_dm"`. Without a bot grant `delivery` is `"none"` and the agent must
  share `approveURL`. The same bot sends `connector_offline` once per outage when
  `offlineAlertDue()` (offline for `OFFLINE_ALERT_AFTER_MS` = 5 min) and `connector_online` after.
  Notices are metadata only: agent name, action kind, link, expiry. Never chat names, ids or text
  (they would be stored by Raft). This replaces the plan's "approval card in the Raft conversation":
  Raft offers no such card for app actions (see root README "Open decisions").
- **Room binding** (who reaches which inbox): one owner per Raft server per installation.
  `canBindRoom(human, existing)` lets only a server `owner`/`admin` pair, and refuses a second
  owner on an already bound server (`CONFLICT`). `authorizeRoomAccess(principal, binding)` runs on
  every request: humans only reach their own room; agents only the room bound to their server.
- Meta actions (cloud-only, never forwarded): `whoami`, `approval_status`.

## Browser API (`web.ts`)

Auth: the human's session cookie, built with `sessionCookie(origin, value, maxAge, "human")`:
`__Host-jinbox_session` on https (Secure, HttpOnly, SameSite=Lax, Path=/, no Domain, so sibling
J-Suite subdomains cannot set or shadow it), `jinbox_session` on loopback http. Only human
sessions of the room's owner pass `authorizeSurface(principal, "web", binding)`, on every route
below, `/live` and `/auth/logout`; an agent session is `NOT_ALLOWED` everywhere here. Human sessions
end after 12 h idle or 7 days (`sessionExpired`). Every HTML page carries `WEB_HTML_HEADERS` (CSP
`default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';
form-action 'self'; img-src 'self' blob:; media-src 'self' blob:` (blob: for media shown from
`POST /api/media`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, nosniff, no-store);
the approve and pair pages also need an explicit confirmation step. Every non-GET `/api`
request and `POST /auth/logout` must send header `x-j-inbox-csrf: 1`. Responses use
`apiResponse(schema)`: `{ok:true, data}` or `{ok:false, error}` with `httpStatusForError(code)`, and
every `/api` response carries `API_NO_STORE_HEADERS` (`Cache-Control: no-store`, nosniff).

**Request URLs never carry content** (no chat ids, asset URLs, file names or text in a path or
query): URLs are written to Worker logs, browser history and proxies.

| Method | Path | Body / query | Response data |
|---|---|---|---|
| GET | `/api/me` | | `meResponse` (user, paired device + online, pendingApprovals) |
| POST | `/api/actions/{action}` | action params | action result (humans never need approval) |
| POST | `/api/media` | `mediaRequest {url}` | raw bytes with `mediaResponseHeaders(mimeType)`, or JSON error. The UI shows them via a `blob:` URL |
| GET | `/api/devices` | | `devicesResponse` |
| POST | `/api/devices/{id}/revoke` | | `{revoked:true}`, only after the device's live `/connect` socket was closed with 4403 and requests stopped routing to it |
| GET | `/api/approvals` | | `approvalsResponse` |
| POST | `/api/approvals/{id}/decision` | `{decision:"approve"|"deny"}` | `{approval}` |
| GET | `/api/audit?cursor&limit` | | `auditResponse` (metadata only: who, action, ok, errorCode) |
| POST | `/api/pair/lookup` | `{userCode}` | `pairLookupResponse` |
| POST | `/api/pair/confirm` | `{userCode, approve, replaceDeviceID?}` | `pairConfirmResponse` (`CONFLICT` if the server already has another owner, or if a computer is paired and `replaceDeviceID` does not name it; `NOT_ALLOWED` unless owner/admin) |
| GET | `/api/settings` | | `settingsResponse {agentAccess}` |
| POST | `/api/settings` | `settingsRequest {agentAccess}` | `settingsResponse`; the owner's switch for agent access (on by default after pairing) |
| POST | `/auth/logout` | | `{ok:true}`; expires the cookie (`expiredSessionCookie`), drops the server session, sends `LOGOUT_RESPONSE_HEADERS` (`Clear-Site-Data: "cache", "storage"`) |

Media responses (`mediaResponseHeaders`): always `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: no-store`,
`Cross-Origin-Resource-Policy: same-origin`. Only `image/png|jpeg|gif|webp`, `video/mp4|webm` and
`audio/*` are served inline with their type; everything else (html, svg, xml, pdf, text, scripts,
unknown) is `application/octet-stream` with `Content-Disposition: attachment`. No file name in
headers. A contact can send any file, so nothing they send may run on the app origin.

Pages (`WEB_PAGES`, `webPagePath`, `webPageURL`): `/`, `/pair`, `/approvals`, `/approvals/{id}`,
`/settings/devices`, `/settings/activity`. The cloud serves `index.html` for each and builds every
link from them (`approveURL` = `webPageURL(APP_ORIGIN, "approval", id)`, `approvals_pending` ->
`approvals`, `connector_replaced` -> `devices`); the UI routes on the same paths.

Browser cache (plan 2.5): every IndexedDB/localStorage key is `localCacheKey(sub, key)`. Render
cached data only while `/api/me` returns the same `sub` (`shouldKeepLocalCache`); wipe it on logout,
on any 401 and on a `sub` mismatch.

`/live` (WebSocket, same cookie): server sends `snapshot` first, then `presence`, `event`
(a connector event frame, metadata only), `approval`, `pong`, and `resync {reason:"events_dropped"}`
(the room dropped connector events over its per-minute budget: refetch what is on screen). A
socket evicted because the owner has too many tabs open is closed with
`LIVE_CLOSE_CODES.TOO_MANY_TABS` (4429); the browser must not reconnect on its own after it.
Browser may send `ping {t}` only.
Parse with `parseLiveServerMessage` / `parseLiveClientMessage`. Before upgrading, the cloud checks
`isAllowedUpgradeOrigin("live", Origin, APP_ORIGIN)` (exact match, missing Origin refused) and
answers 403 otherwise: CORS does not apply to WebSockets and Lax cookies ride on same-site
upgrades. `/connect` uses `isAllowedUpgradeOrigin("connect", ...)` (no Origin is fine for the
connector; a foreign Origin is refused).

## Pairing (`pairing.ts`)

Device-code flow (like RFC 8628):

1. Connector `POST /pair/start {deviceName, connectorVersion, platform}` -> `{deviceCode, userCode "BCDF-GHJK", verificationURL, verificationURLComplete, expiresIn<=600, interval}`. `verificationURLComplete` equals `verificationURL`: no link ever carries the code.
2. Human opens `verificationURL`, signs in with Raft, **types** the code shown in the terminal, `POST /api/pair/lookup {userCode}` to see the device: its self-chosen name and platform next to what the cloud observed (`requestedAt`, `requester` = `approximateIP` + country), the computer it would replace (`replaces`) and who is signed in (`signedInAs`). Then `POST /api/pair/confirm {userCode, approve, replaceDeviceID?}`; replacing a paired computer needs `replaceDeviceID` naming it (`checkPairConfirm`), closes the old one with 4409 and DMs the owner `connector_replaced`.
3. Connector `POST /pair/poll {deviceCode}` every `interval` s -> `pending` | `slow_down{interval}` | `approved{deviceID, deviceToken, owner}` | `denied` | `expired`. The token is shown exactly once; the cloud stores `hashToken(deviceToken)` only.

4. Connector `POST /pair/revoke` with `Authorization: Bearer <deviceToken>` (no body) -> `{revoked:true}`
   (`pairRevokeResponse`): `j-inbox unpair` / `uninstall` revoke the device in the cloud, which
   closes its live `/connect` socket with 4403. An unknown token is `UNAUTHENTICATED`; an already
   revoked one answers `{revoked:true}` again.

`/pair/start`, `/pair/poll` and `/pair/revoke` answer with these **bare objects** (no
`apiResponse` wrapper); errors are `{ok:false, error}` with `httpStatusForError`. The connector
accepts a wrapped answer too. The connector shows `verificationURL` only when
`isSameOriginVerificationURL(verificationURL, configuredCloudURL)` (exact origin; 127.0.0.1 and
localhost differ), as a defence against phishing links.

User codes use the consonant alphabet `BCDFGHJKMNPQRSTVWXZ`; `normalizeUserCode` accepts lower case, spaces and dashes.

Limits (`PairingGuard`, RFC 8628 section 5.1): 5 failed lookups/confirms per session, per Raft user
and per IP in 10 minutes, then `RATE_LIMITED`; a pending code is invalidated after 3 refused
confirms. `/pair/start` is charged to every key of `pairStartKeys(ip)`: the address and the IPv6
/64 (10 per hour each), the IPv6 /48 or IPv4 /24 (30 per hour). While 10,000 codes are pending
(`MAX_PENDING_PAIR_CODES`) only networks with no start in the window may start one, so a flood
blocks the flooder, not everyone; above `MAX_PENDING_PAIR_CODES_HARD` (100,000) nobody may. The
counters live in a `GuardStore` (memory by default; the cloud keeps them in its Durable Object's
SQLite under salted hashes, so they survive restarts). Every miss (wrong, expired, used,
invalidated) gets the same `pairLookupFailure()` answer.
