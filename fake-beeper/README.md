# @j-inbox/fake-beeper (MIT)

A fake **Beeper Client API** (HTTP + `/v1/ws`) for testing J-Inbox and its open-source connector.
Deterministic fixtures, fault injection, real-API quirks. It never talks to real Beeper and never
reads the real filesystem. No dependencies.

**Test:** `cd fake-beeper && bun test`

```ts
import { startFakeBeeper, CHAT_IDS, ASSET_URLS, HOSTILE_TEXTS } from "@j-inbox/fake-beeper";
const fb = await startFakeBeeper();   // 127.0.0.1, random port; fb.url, fb.wsURL, fb.token
```

Full reference (routes, fixture, knobs): `testkit/README.md` ("fake-beeper"), which re-exports this
package as `@j-inbox/testkit/fake-beeper` for the closed packages. The spec-conformance tests that
validate every response against the vendored Beeper OpenAPI spec live in `testkit/test/`
(the spec file is not ours to relicense).

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
- `/v1/ws` `subscriptions.set` with `app: {state: true}` gets `app.state.updated`;
  `fb.setAppState("needs-login")` changes it.
- Every request is logged in `fb.state.calls` before auth and fault injection (`authorized`,
  `injected: "fail" | "hang"`, `status`), so `fb.writes()` counts every attempted write.
- `failNext({..., headers})` can send any response headers (e.g. a redirect `location`).
