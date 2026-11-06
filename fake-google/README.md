# @j-inbox/fake-google (MIT)

A fake **Google OAuth** (authorize, token, revoke, userinfo) and **Gmail REST** subset for testing
J-Inbox and its open-source connector. A web-standard `fetch(Request)` handler (no Bun APIs, so it
also runs inside workerd for the cloud's tests), plus a Bun server wrapper. Deterministic mailbox,
fault injection. It never talks to real Google. No dependencies.

**Test:** `cd fake-google && bun test`

```ts
import { FakeGoogle, startFakeGoogle, FAKE_GOOGLE_CLIENT, OWNER_EMAIL, THREADS } from "@j-inbox/fake-google";
const g = new FakeGoogle({ redirectUris: ["http://127.0.0.1:8787/auth/google/callback"] });
await g.fetch(new Request("https://google.fake/o/oauth2/v2/auth?..."));
const s = await startFakeGoogle({ redirectUris: [...] });   // 127.0.0.1, random port; s.url, s.google
```

One origin serves everything (the real endpoints live on several Google hosts):

| Route | Behaviour |
|---|---|
| `GET /o/oauth2/v2/auth` | Registered client and exact `redirect_uri` (else 400 `redirect_uri_mismatch`), `response_type=code`, known scopes only, PKCE `S256`/`plain`. Consent is scripted: `consentAs(email)`, `denyNextConsent()` (redirect with `error=access_denied`), `grantOnly(scopes)` (granular consent). Redirects with `state`, `code`, `scope`. `lastAuthorize` keeps the query |
| `POST /token` | Form or JSON, client secret in the body or Basic. `authorization_code`: single-use (a failed exchange uses it up), 10 min, `redirect_uri` and PKCE verifier checked, `refresh_token` only with `access_type=offline`, `id_token` (claims `iss`, `aud`, `sub`, `email`, `email_verified`, `nonce`; signature is fake) when `openid` was granted. `refresh_token`: `invalid_grant` "Token has been expired or revoked." once revoked. Wrong secret: 401 `invalid_client` |
| `POST /revoke` | `token=` (refresh or access): revokes the whole grant, its access tokens too; unknown: 400 `invalid_token` |
| `GET /oauth2/v3/userinfo` | `sub`, `email`, `email_verified` |
| `POST /batch/gmail/v1` | Gmail's batch endpoint: a `multipart/mixed` body of `application/http` parts (request line, headers), at most 100 (`GMAIL_BATCH_MAX`, else 400); each call runs as if sent alone (auth, fault rules, `requests` with `inBatch: true`), in order, the batch's `Authorization` for calls without one; the answer is `multipart/mixed` with one part per call, `Content-ID: <response-ID>`. `latencyMs` is paid once per batch |
| `/gmail/v1/users/me/...` | `profile`, `threads` (list: `q`, `labelIds`, `maxResults` 1-500, `pageToken`, `includeSpamTrash`; newest activity first, drafts do not count as activity; `resultSizeEstimate` as measured against real Gmail on 2026-11-05: 201 on a page with more pages after it, whatever the true size of the list (755, 799 and 4000+ were seen), and on the last page what that page holds. It is no count of a list), `threads/{id}` (`format=full|metadata|minimal`, `metadataHeaders`), `threads/{id}/modify`, `messages` (list), `messages/{id}`, `messages/{id}/modify`, `messages/{id}/attachments/{id}`, `messages/send`, `drafts` (create), `settings/sendAs` (the address with `isPrimary` and its display name, `""` as in Gmail's default where mail goes out under the Google account's name, which only the owner's sent mail shows (`OWNER_NAME`); `mailbox(email).displayName` sets one; then `mailbox(email).aliases`), `history` (`startHistoryId`, `historyTypes`, `labelId`; 404 when older than the kept history). Bearer access token of that user with the `gmail.modify` scope (read-only scope: GETs only), else 401/403 in Google's error shape |

Gmail realism: payload trees (`multipart/mixed` > `multipart/alternative` > text parts; files by
`attachmentId`), bodies in their declared charset (UTF-8 or ISO-8859-1), RFC 2047 encoded headers,
HTML-escaped snippets, `messages.send` files a message into `threadId` only when the subject
matches (ignoring `Re:`/`Fwd:`) and `In-Reply-To`/`References` name a message of the thread (Gmail's
rule; otherwise it starts a new thread), a send without recipients is 400, every change bumps the
mailbox `historyId` and is recorded for `history.list`. The query language (`compileQuery`)
covers words and phrases, `from: to: cc: subject: in: is: label: category: has:attachment after:
before: rfc822msgid:`, `-` negation, `{a b}` and `(a OR b)`; it is evaluated per message. `from:` matches whole words of the header, as Gmail does: `from:a@example.com` is not found in `ba@example.com`, `from:example.com` is found in `x@mail.example.com` but not in `x@notexample.com`.

The request log keeps a list's search (`requests[i].q`), and `failNext({ search: /pageToken=/ })` fails only a later page.

Fixture at a fixed date (`GMAIL_FIXTURE_NOW`; `new FakeGoogle({ fixtureNow: Date.now() })` puts it where a test's real clock is) (`buildMailbox()`, owner `owner@example.com`; `THREADS` names the interesting threads):
`lunch` (reply chain, unread), `kickoff` (several To/Cc, for reply-all), `html` (HTML only, links,
`<script>`), `encoded` (RFC 2047 subject and name, Latin-1 body), `attachments` (PDF + inline
`cid:` PNG), `promo` and `social` (Gmail categories), `archived` (no INBOX), `starred`, `draft`
(has a draft), `hostile` (script tags, RTL override, prompt injection, 60k body), `long` (45
messages), `noSubject`, `cjk`, `sentOnly`, plus 24 filler threads. A second user
`other@example.com` has one thread. Times interleave with fake-beeper's chats.

Controls: `consentAs`, `denyNextConsent`, `grantOnly`, `issueRefreshToken(email)` (skip the browser
dance), `revokeAll(email)`, `isRevoked`, `liveGrants`, `expireAccessTokens`, `expireHistory`,
`advance(ms)`, `deliver(email, {threadId?, from, subject, text?, html?, attachments?, labels?, body?})` (incoming mail; `body`: a payload of the caller's own, for odd charsets and parts),
`failNext({method?, path?, status?, body?, network?, hang?, times?})`, `releaseHangs`, `latencyMs`,
`sent(email)` / `drafts(email)` (what clients sent, with parsed headers and text), `requests`
(method, path, status, account, `inBatch`: metadata only), `reset()`.
