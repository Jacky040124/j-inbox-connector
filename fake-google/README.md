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
| `/gmail/v1/users/me/...` | `profile`, `threads` (list: `q`, `labelIds`, `maxResults` 1-500, `pageToken`, `includeSpamTrash`; newest activity first, drafts do not count as activity), `threads/{id}` (`format=full|metadata|minimal`, `metadataHeaders`), `threads/{id}/modify`, `messages` (list), `messages/{id}`, `messages/{id}/modify`, `messages/{id}/attachments/{id}`, `messages/send`, `drafts` (create), `history` (`startHistoryId`, `historyTypes`, `labelId`; 404 when older than the kept history). Bearer access token of that user with the `gmail.modify` scope (read-only scope: GETs only), else 401/403 in Google's error shape |

Gmail realism: payload trees (`multipart/mixed` > `multipart/alternative` > text parts; files by
`attachmentId`), bodies in their declared charset (UTF-8 or ISO-8859-1), RFC 2047 encoded headers,
HTML-escaped snippets, `messages.send` files a message into `threadId` only when the subject
matches (ignoring `Re:`/`Fwd:`) and `In-Reply-To`/`References` name a message of the thread (Gmail's
rule; otherwise it starts a new thread), a send without recipients is 400, every change bumps the
mailbox `historyId` and is recorded for `history.list`. The query language (`compileQuery`)
covers words and phrases, `from: to: cc: subject: in: is: label: category: has:attachment after:
before: rfc822msgid:`, `-` negation, `{a b}` and `(a OR b)`; it is evaluated per message.

Fixture (`buildMailbox()`, owner `owner@example.com`; `THREADS` names the interesting threads):
`lunch` (reply chain, unread), `kickoff` (several To/Cc, for reply-all), `html` (HTML only, links,
`<script>`), `encoded` (RFC 2047 subject and name, Latin-1 body), `attachments` (PDF + inline
`cid:` PNG), `promo` and `social` (Gmail categories), `archived` (no INBOX), `starred`, `draft`
(has a draft), `hostile` (script tags, RTL override, prompt injection, 60k body), `long` (45
messages), `noSubject`, `cjk`, `sentOnly`, plus 24 filler threads. A second user
`other@example.com` has one thread. Times interleave with fake-beeper's chats.

Controls: `consentAs`, `denyNextConsent`, `grantOnly`, `issueRefreshToken(email)` (skip the browser
dance), `revokeAll(email)`, `isRevoked`, `liveGrants`, `expireAccessTokens`, `expireHistory`,
`advance(ms)`, `deliver(email, {threadId?, from, subject, text})` (incoming mail),
`failNext({method?, path?, status?, body?, network?, hang?, times?})`, `releaseHangs`, `latencyMs`,
`sent(email)` / `drafts(email)` (what clients sent, with parsed headers and text), `requests`
(method, path, status, account: metadata only), `reset()`.
