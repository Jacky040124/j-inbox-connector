# @j-inbox/fake-beeper (MIT)

A fake **Beeper Client API** (HTTP + `/v1/ws`) for testing J-Inbox and its open-source connector.
Deterministic fixtures, fault injection, real-API quirks. It never talks to real Beeper and never
reads the real filesystem. No dependencies.

**Test:** `cd fake-beeper && bun test`

```ts
import { startFakeBeeper, CHAT_IDS, ASSET_URLS, HOSTILE_TEXTS } from "@j-inbox/fake-beeper";
const fb = await startFakeBeeper();   // 127.0.0.1, random port; fb.url, fb.wsURL, fb.token
```

The fixture stands at a fixed date (`FIXTURE_NOW`); `startFakeBeeper({ fixtureNow: Date.now() })` puts it where a test's real clock is (To do's first run looks 7 days back).

Full reference (routes, fixture, knobs): `testkit/README.md` ("fake-beeper"), which re-exports this
package as `@j-inbox/testkit/fake-beeper` for the closed packages. The spec-conformance tests that
validate every response against the vendored Beeper OpenAPI spec live in `testkit/test/`
(the spec file is not ours to relicense).

Bridges and their sign-ins (`src/logins.ts`): `GET /v1/bridges` (a cloud and usually an on-device
`local-` bridge per network, as Beeper Desktop 4.3 has them, Beeper's own `matrix` included; each
bridge's accounts are `/v1/accounts`'s), `GET /v1/bridges/{id}` and `.../login-flows` (the flows
measured on a real Beeper; Bluesky's answers 500, as measured), and login sessions: create, get,
cancel and `POST .../steps/{stepID}`. Flows: a QR code (`display_and_wait`, held until the phone acts or
`controls.loginWaitMs`), WhatsApp's pairing code, Telegram's phone and code, Slack's email and code,
Messenger's password, tokens, and a `cookies` step for website sign-ins, whose page (`/fake-login/<site>`)
sets the cookies and goes to its final URL. A wrong code or password answers the same step with an
`error` (a retry); a second session on a busy bridge is 409; a session expires after
`controls.loginTTLMs` (404). Tests act as the phone or the network with `fb.logins.scan()`, `rotate()`,
`fail()` and `expire()`; `LOGIN_SECRETS` are what the fake accepts (made-up markers).

Real-API behaviour it models (from the read-only smoke run, see `e2e/README.md`):

- iMessage (`imsg##`) messages have no `type`; WhatsApp history contains `REACTION` messages.
- Some messages omit `isSender`, some chats omit `isPinned`/`isMuted`/`isArchived`, one account
  omits `network`.
- `/v1/accounts` does not line up with chat networks: no iMessage account, `X` vs `Twitter/X`,
  plus Beeper's own `matrix` account.
- `controls.emptyOlderPageForIMessage`: `hasMore: true`, then an empty older page.
- `PATCH /v1/chats/{id}` refuses a non-empty draft while one exists (409 `CONFLICT`).
- `POST /v1/chats/{id}/unread` within 5 s of an unarchive puts the chat back in the archive (seen on
  Beeper Desktop 4.3, 2026-10-28); unread first, then unarchive, keeps both.
- `POST /v1/chats/{id}/unread` on a WhatsApp chat also archives it about 0.5 s later, and `POST
  /read` un-archives it (measured 2026-10-31): `controls.unreadArchives` (networks, default
  `["WhatsApp"]`) and `controls.unreadArchiveDelayMs` (default 300). Modelled at its worst: an
  unarchive in between does not stop it.
- `/v1/ws` `subscriptions.set` with `app: {state: true}` gets `app.state.updated`;
  `fb.setAppState("needs-login")` changes it.
- Every request is logged in `fb.state.calls` before auth and fault injection (`authorized`,
  `injected: "fail" | "hang"`, `status`), so `fb.writes()` counts every attempted write.
- `failNext({..., headers})` can send any response headers (e.g. a redirect `location`).
