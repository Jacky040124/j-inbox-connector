# J-Inbox connector (open source, MIT)

`j-inbox` CLI and background service that runs on the user's Mac. It links the local
Beeper Client API (Beeper Server or Beeper Desktop, `127.0.0.1:23373`) and the owner's Gmail
accounts to the user's J-Inbox cloud room, and only ever runs the actions in the protocol catalogue.

## Install

On a Mac with Apple silicon, in Terminal:

```sh
curl -fsSL https://inbox.jackyzhonghq.com/install.sh | sh
```

`install.sh` (this folder; the web app serves it) downloads `j-inbox-darwin-arm64` and
`j-inbox-darwin-arm64.sha256` from the latest release of
[Jacky040124/j-inbox-connector](https://github.com/Jacky040124/j-inbox-connector/releases), checks the
SHA-256, puts the binary at `~/.local/bin/j-inbox` (no sudo; it prints the PATH line for `~/.zprofile`
if that folder is not on the PATH, and edits no dotfile), then runs `j-inbox setup` in the terminal.
Arguments after `sh -s --` go to setup. Run it again to upgrade: the binary is replaced by a rename (a
running service keeps its old file; copying over a running binary gets it killed), and setup keeps
the Beeper engine, the Beeper token and the pairing when they still work, and restarts the service on
the new binary. It refuses anything but macOS on arm64 (a Rosetta terminal on Apple silicon is fine).
`J_INBOX_DOWNLOAD_URL=<base>` takes the two files from elsewhere (https; plain http only for
127.0.0.1/localhost, for tests); `J_INBOX_NO_SETUP=1` installs without running setup. Without a
terminal (CI) it prints the setup command instead. Tests: `test/install-sh.test.ts`.

Gatekeeper: the binary is only ad-hoc signed (no Apple developer account). curl does not set
`com.apple.quarantine` (only apps that opt in do, such as browsers), so it runs; `spctl --assess` says
"rejected", which only matters for quarantined files. A copy saved by a browser carries the attribute
and Gatekeeper blocks it (it never starts; seen here with a Safari-style attribute, on both the
build's signature and a fresh ad-hoc one), so use the curl line. `install.sh` also removes the
attribute from the new file before it first runs. `bun build --compile` leaves a signature that
`codesign -v` calls invalid; the release script signs it again (`codesign --sign -`).

Release: `scripts/release-connector.sh` (in the J-Inbox repo, not in this package) builds from a clean checkout of HEAD, checks the
binary (Mach-O arm64, signature, `--version`), writes the two assets and `install.sh` to a directory
and prints the `gh release create` command; it publishes nothing.

## Build and test

**Test:** `cd connector && bun test` (one command; about 30 s; fakes only, nothing outside 127.0.0.1)

**Build:** `cd connector && bun run build` -> `dist/j-inbox`, a single darwin-arm64 binary (`bun build --compile`, with `src/gmail/email-html-worker.ts` as a second entry point, which the sanitizer's Worker needs; no Node or Bun needed on the target Mac). `test/binary.test.ts` builds it and runs `--help`, `--version`, `status` and `run` against the fakes.

Status: v0.1, early. Running for real since 2026-10-26 on one Mac (Beeper Desktop engine, paired
with the live J-Inbox cloud). Beeper Server is not yet used day to day; see "Assumptions" below.

## Using it

```sh
j-inbox setup        # Beeper -> Beeper token into the Keychain -> pair -> launchd agent -> checks
j-inbox status       # Beeper, pairing, service and cloud link at a glance (--json; exit 1 if anything is off)
j-inbox logs         # recent operations, metadata only (-n N, --json, --service for the service log)
j-inbox pair         # pair (or with --force re-pair) this computer: shows a code to type in the web page
j-inbox unpair       # revoke this computer in the cloud (POST /pair/revoke), then forget the device token here
j-inbox doctor       # finds common problems and prints a fix for each (--json; exit 1 on failures)
j-inbox jev-key      # the Jev (TypeSafe) API key for noise into the Keychain, from stdin (--delete removes it)
j-inbox uninstall    # launchd agent, the tokens and the Jev key, J-Inbox's own files (--yes, --keep-config); Beeper is left alone
j-inbox run          # the service in the foreground (what launchd runs)
```

`setup` options: `--engine desktop|server`, `--beeper-url URL` (loopback only), `--beeper-port N`,
`--beeper-token-stdin`, `--cloud-url URL`, `--name NAME`, `--skip-pair`, `--no-service`, `--yes`.

- **Desktop engine (the default):** uses Beeper Desktop's API on 23373. Setup first checks that it
  answers; if not, it says to install Beeper Desktop (https://www.beeper.com/download), sign in to the
  chat networks and turn on Settings > Developers > Beeper Desktop API, and in a terminal checks again
  on Enter. Then the owner pastes an access token (Settings > Developers), or pipes it with
  `--beeper-token-stdin`. Setup run again keeps the engine and a stored token Beeper still accepts.
- **Server engine (`--engine server`, or `s` at the Desktop prompt):** wraps the Beeper CLI (`brew install beeper/tap/cli`):
  `beeper targets add server j-inbox --port P`, `beeper setup --server --install --target j-inbox`
  (interactive: email code, device verification), `beeper targets enable j-inbox`. `P` is 23373
  when free, else the first free port from 23374 (Beeper Desktop usually holds 23373); the check
  is a TCP connect only. The commands are in `beeperCommands()` in `src/commands/setup.ts`.
- Every token is verified against Beeper (`GET /v1/accounts`) before it is stored; a rejected
  token is never stored.
- **Noise (Jev):** `pbpaste | j-inbox jev-key` (or `j-inbox jev-key` in a terminal: a hidden prompt)
  keeps the TypeSafe API key in the Keychain as `typesafe-api-key`; it is never printed, logged or
  put in argv, and is only sent to `https://api.typesafe.ai/v1/systemone` in the `Authorization`
  header. The running service reads it whenever it asks Jev (no restart). `--delete` removes it.
  Without a key nothing is judged and Settings > Noise says "Jev key not set on your computer".

## Where things live

| What | Where |
|---|---|
| Config (no secrets: cloud URL, Beeper URL, engine, device id and name) | `~/.config/j-inbox/config.json` (0600) |
| Beeper token, device token, Gmail refresh tokens, the Jev key, the Gmail cache key | login Keychain, service `build.jsuite.j-inbox`, accounts `beeper-token` / `device-token` / `gmail:<address>` / `typesafe-api-key` / `gmail-cache-key` (32 random bytes, made when the first Gmail account is added), written with `security -i` on stdin (never in argv) |
| Gmail accounts (addresses and connected / reconnect_required; never tokens or mail) | `~/Library/Application Support/j-inbox/gmail.json` (0600) |
| Idempotency journal (key hashes, parameter digests, result ids; never text or chat ids), asset allowlist (URL hashes) | `~/Library/Application Support/j-inbox/` |
| Gmail list cache `gmail-cache.json`: per thread what Gmail's `format=metadata` gives the lists (ids, labels, dates, the From/To/Cc/Subject/Date/Message-ID headers, Gmail's snippet; never a body, never a draft's snippet), valid while the thread's `historyId` is unchanged, so a restart lists without fetching every thread again; at most 3000 threads and 6 MiB, least recently used out; AES-256-GCM sealed with the Keychain's `gmail-cache-key` (no email text on disk in the clear; without the key it stays in memory); forgotten with its account | `~/Library/Application Support/j-inbox/` (0600) |
| Request store `drafts.json`: for "ask an agent to draft a reply", each request's chat id, the owner's instruction and the agent's draft; for "delegate to an agent as a Raft task", each request's chat id and the owner's instruction (the cloud keeps none of them); at most 200, each forgotten when the owner handles it (a delegation: when the task is created, or it is cancelled or dismissed) or 7 days after it was made | `~/Library/Application Support/j-inbox/` (0600) |
| Upload store `uploads/`: files being sent through J-Inbox (the owner's from the web page, an agent's on its draft), one `upl_*.bin` per file plus `index.json` (name, type, size, an owner tag that is a digest of the caller, never a sub); at most 60 files and 256 MiB; a file is forgotten once sent, discarded or handled with its draft, 1 hour after it began unless it is on a draft, with its draft (7 days at the latest) | `~/Library/Application Support/j-inbox/uploads/` (0700; files 0600) |
| Noise store `noise.json`: the owner's definition of noise, the verdicts (chat id, noise or not, the definition line Jev chose, its confidence, Jev's, the owner's or the noise list's, the newest message id Jev saw; at most 5000, the least recently judged go first), the owner's corrections with a one-line summary of the conversation (shown to Jev as examples) and, for an email with one other sender in it, that address (at most 5000 of the owner's, apart from the other verdicts' 5000), the noise list of senders with what is learned and what the owner took off, and the 20 latest decisions with the conversation's title (the cloud keeps none of it) | `~/Library/Application Support/j-inbox/` (0600) |
| To do store `todo.json`: the owner's own "unhandled" state, apart from the network's read state (protocol README "To do"): per chat that has anything to remember, its id, the flag, the times of the newest message from someone else and of its last activity, short hashes of the ids of its latest messages from someone else (at most 32, so a message seen again is known) and whether it was last seen out of the main inbox; per source when it was first seen, the first run's cut (7 days before that), whether its first run is done, how far it has looked, whether the owner asked for its older unread, and until that is over short hashes of the ids of handled chats forgotten for the limit (each once, at most 5000 per source), so it does not bring them back, and about how many older unread its first run left out, less what has come in since (a count); at most 5000 chats, fair per source, what was handled the longest ago goes first. A damaged file is renamed aside (`todo.json.corrupt-<time>`). Never a title, name or text (the cloud keeps none of it) | `~/Library/Application Support/j-inbox/` (0600) |
| Audit log `audit.jsonl` (rotated at 5 MiB, 3 files), service log `service.log` | `~/Library/Logs/j-inbox/` |
| Names for iMessage numbers (optional, written by the helper, removed by `uninstall`) | `~/Library/Application Support/j-inbox/contacts.json` |
| Service state for `status` (pid, cloud link state, Beeper health) | `~/.config/j-inbox/state.json` |
| launchd agent | `~/Library/LaunchAgents/build.jsuite.j-inbox.plist`: `RunAtLoad`, `KeepAlive {SuccessfulExit: false}`, `ThrottleInterval 10`, logs to `service.log` |

`J_INBOX_CONFIG_DIR=/abs/dir` (or `--config-dir`) moves all of it, including the LaunchAgents
directory, under one directory. `J_INBOX_SECRETS=file` swaps the Keychain for a 0600 JSON file,
and is refused unless `J_INBOX_CONFIG_DIR` is set (tests and local development only). The same holds
for `J_INBOX_GMAIL_API_URL` / `J_INBOX_GOOGLE_OAUTH_URL` (a loopback fake instead of
`gmail.googleapis.com` / `oauth2.googleapis.com`), `J_INBOX_TYPESAFE_URL` (a loopback fake instead of
`api.typesafe.ai`), `J_INBOX_SIGNIN_HELPER` (a stand-in for the sign-in window), `J_INBOX_GMAIL_POLL_MS` (a shorter history poll), `J_INBOX_NOISE_SENDERS_WAIT_MS` (a shorter wait before the noise list learns and walks) and `J_INBOX_NOISE_DEBOUNCE_MS` (a
shorter noise collection window): refused without `J_INBOX_CONFIG_DIR`.

## How it works

| Module | What |
|---|---|
| `src/cli.ts`, `src/commands/*` | argument parsing (unknown flags refused) and the commands; every external program, prompt, path and clock is injected (`CliDeps`) |
| `src/service.ts` | `j-inbox run`: composes everything below; exits 0 only when it must stay down (unpaired, no token, revoked 4403, replaced by another computer 4409, a 4401 that repeats 4 times in a row, version 4426); a stop by a signal exits 128 + signal (SIGTERM 143, SIGINT 130), so launchd (KeepAlive SuccessfulExit=false) restarts it after `kill` or Activity Monitor's Quit, while `launchctl bootout` (uninstall) removes the job |
| `src/instance-lock.ts`, `src/commands/run.ts` | one `j-inbox run` per config dir: an atomic pid file `run.lock` with its `startedAt` (taken over when the holder is dead, or when its pid now belongs to a process that started after the lock was written: a pid reused after a reboot or kill -9, checked with `ps -o etime=`; `status` and `doctor` apply the same check to `state.json`); a second `run` exits 3 with "already running (pid N)" and touches nothing |
| `src/cloud-link.ts` | `wss://<app>/connect` with `Authorization: Bearer <deviceToken>` (https only; http only for loopback dev); `hello` -> `welcome`; requests; heartbeat; reconnect |
| `src/dispatcher.ts` | the whitelist: catalogue action -> `parseActionParams` -> the router -> `parseActionResult`; anything else `NOT_ALLOWED`. `get_media` on a `gmail://` URL streams an email attachment (allowlist first) |
| `src/chat-login.ts`, `src/signin-window.ts`, `signin-helper/` | connecting chat apps from the owner's page ("chat-login.v1", Settings > Chats): `chat_apps` reads `GET /v1/bridges` (and each chosen bridge's `login-flows`) and answers only J-Inbox's ten chat apps (protocol `CHAT_APP_KEYS`, matched by bridge id and type), each with its accounts, never Beeper's own (`matrix`); a new account uses the on-device (`local-`) bridge when there is one, a Reconnect the account's own bridge with its `accountID` and `loginID`. `chat_login_start` / `_poll` / `_submit` / `_cancel` run one Beeper login session at a time (an earlier one is cancelled first): a display step (QR code, a code for the phone) is waited on in the background (`POST .../steps/{stepID} {type: display_and_wait}`); a form step's values go to Beeper as typed, never kept or logged, and a wrong code comes back as the same step with `retry`; a cookies step (a website's own sign-in) opens J-Inbox's sign-in window on this Mac (`signin-helper/`: "J-Inbox Sign-in.app", installed in `~/Applications` by `install.sh`, built by `signin-helper/build.sh` like the contacts helper, ad-hoc signed): the site in a WKWebView with a non-persistent data store and Beeper's user agent, and at Beeper's final URL exactly the cookies, local storage keys and request headers asked for (Beeper's `extractJS` run as an opaque helper) go over the helper's stdout to the connector and straight to Beeper (`source: webview`), then it closes. A session nobody asks about for a minute (the page went away; five while the step is in the phone app: a QR code, a code shown or sent) is cancelled on Beeper; one over 10 minutes expires; a stopped connector cancels what runs. The start runs on its own deadline: a session Beeper starts after the page was answered is cancelled when its answer comes, and a cancel Beeper does not confirm is tried again (and before the next start), so nothing half-done blocks the next attempt. Beeper's own error words never reach the page. The window opens on the owner's screen though the connector runs as a launchd agent (`gui/<uid>`): `test/signin-gui.test.ts` checks both (opt-in, `J_INBOX_GUI_TESTS=1`). `J_INBOX_SIGNIN_HELPER` (test mode only) is a stand-in |
| `src/contacts.ts`, `contacts-helper/` | names for the numbers iMessage gives. Optional: `contacts-helper/install.sh` builds a small app that alone holds the Contacts permission and writes `contacts.json` hourly; without it numbers stay numbers |
| `src/actions.ts` | the Beeper actions (`status`, `list_chats`, `unread_summary`, `read_chat`, `search_messages`, `draft_reply`, `send_message`, `react`, `mark_read`, `archive`, `remove_account`), plus the collecting building blocks the merged lists use. `status` leaves out Beeper's own account (`matrix`) and the network of its chats, by identity ("chat-login.v1"); its chats stay in the lists |
| `src/sources.ts` | the router: `gmail:` ids go to Gmail, the rest to Beeper; `list_chats`, `unread_summary` and `search_messages` over both, merged (`list_chats` `source: beeper\|gmail`, "list-source.v1", 2026-10-31: the first page of one source only, the other never asked, no cursor; `todo`: Gmail's lane reads only the To do threads it meets in `threads.list`, and ends when all have come); `compose_email`, `gmail_connect`; `react` on email is `NOT_SUPPORTED`; `status` adds the Gmail accounts and the Gmail network |
| `src/merge.ts` | k-way merge of newest-first sources with the `jm.` cursor (each source's own position, the boundary already returned, the last keys per source); failed sources reported, the others answer |
| `src/gmail/client.ts` | Gmail REST client per account: access tokens from the cloud's `/google/token` proxy (`cloudTokenRefresher`, memory only), one refresh and retry on 401, capped bodies, no redirects, error mapping (`gmailErrorCode`: reads `UPSTREAM_DOWN`, lost writes `UNKNOWN_OUTCOME`, `invalid_grant` `REAUTH_REQUIRED`); `revokeAtGoogle` |
| `src/gmail/source.ts`, `src/gmail/map.ts`, `src/gmail/mime.ts` | one account as a source (lists, threads, search, writes, attachments); Gmail JSON -> protocol shapes (drafts never leave the Mac); decoding (charsets, RFC 2047, address lists, email HTML -> text) and writing (reply-all recipients, `Re:`, `In-Reply-To`/`References`, UTF-8 base64 body, RFC 2047 headers, no header injection) |
| `src/gmail/email-html.ts`, `src/gmail/email-css.ts`, `src/gmail/email-html-run.ts`, `src/gmail/email-html-worker.ts` | lock one of HTML email (protocol README "HTML email"): an allowlist over Bun's `HTMLRewriter`, every attribute taken off and the allowed ones put back decoded, checked and encoded anew, no `<` left in text, a second pass that only says yes or no; CSS properties from an allowlist, by small scanners, written anew from what passed; `cid:` images by their bytes; 1x1, hidden and a small list of trackers' images gone. All in a Worker with a 3 s deadline, never on the main loop, and linear in its input. `read_chat` compares each email's plain part with what its HTML shows, once per message, and when they clearly differ `text` is what the HTML shows and `plainText` the plain part. `get_email_html` (`source.ts`): one `messages.get` per message, and `messages.attachments.get` only for the `cid:` images its HTML names, through the account's client and its limits; 8 messages' sanitized HTML (16 MiB at most) kept in memory for 10 minutes, by a timer, so opening and folding one again costs no quota; never on disk. A draft is refused. Over 2 MiB: `TOO_LARGE` |
| `src/gmail/batch.ts`, `src/gmail/meta-cache.ts` | thread and message metadata for lists and search in Gmail batch requests (`POST /batch/gmail/v1`, `multipart/mixed`, 20 calls each; a call Gmail asked to slow down, or answered unreadably, is fetched again on its own; the per-second pacing counts every call of a batch and serves callers in order); the thread metadata cache (see "Where things live") |
| `src/gmail/accounts.ts`, `src/gmail/service.ts`, `src/gmail/poller.ts` | `gmail.json` + Keychain; `gmail_connect` (one `users.getProfile`: the address must match, else nothing is stored) and removal (revoke at Google, forget); history polling every 30 s, every 10 s while the cloud says a J-Inbox page is open (`viewers`), -> metadata-only events, re-sync on a history reset. The history position moves on only once a poll's events went out on a connected link; while the link is down accounts are not polled, and the poll after the welcome starts from the last position handed over |
| `src/drafts.ts` | the request store behind the cloud-only `draft_store_put` / `_get` / `_set_text` / `_delete` (never Beeper): drafts (`drq_`) and delegations (`dlg_`, no text), one 0600 JSON file written atomically, validated on load, bounded, purged after 7 days; a draft may carry one upload (`attachmentId`), forgotten with it |
| `src/uploads.ts` | the upload store behind the cloud-only `upload_store_begin` / `_chunk` / `_commit` / `_delete` and the owner's `discard_upload` ("attachments.v1"), and `upload_store_read` ("upload-read.v1", 2026-11-03: a finished upload streamed back for the owner's preview, read from disk a piece at a time under `get_media`'s flow control; only the caller's own upload or one on a draft, the same `NOT_FOUND` for all else; a read changes nothing): chunks only from the upload's owner tag, in order, never past the declared size; `claim` puts a finished upload on a draft (only its owner's, the agent that uploaded it); purged every minute (1 h, or with the draft). A send with `attachmentId` (`send_message`, `compose_email`) reads it here: Beeper gets `POST /v1/assets/upload` (multipart) then the message with `attachment {uploadID, fileName, mimeType}`, Gmail a multipart/mixed reply-all (RFC 2231 file names); it is deleted once sent; a 400/422 from Beeper (or Gmail) is `NOT_SUPPORTED` with Beeper's own reason. Such sends get `SEND_WITH_FILE_TIMEOUT_MS` (2 min) instead of the usual request time |
| `src/noise/senders.ts` | the noise list of senders ("noise-senders.v1", protocol README "The noise list of senders"), where it needs Gmail: the rule as threads are mapped and just before new mail is announced, the owner's add and remove, learning, the once-only look at old marks and the walk for existing mail, one at a time, in one paced background loop. The list and the rule themselves are in `store.ts` |
| `src/noise/store.ts`, `src/noise/jev.ts`, `src/noise/judge.ts` | noise ("noise.v1", protocol README "Noise"): the noise store behind `get_noise_settings`, `set_noise_definition` and `set_noise` (0600, bounded, validated on load; an empty definition applies nothing; the owner's verdicts stick); Jev's request (one `choice` question per conversation, the criteria "Not noise" plus one per definition line, the owner's last 40 corrections as examples in `state`, the last 5 messages cut to 300 characters, a size budget) and verdict (a line chosen with confidence 0.7 or more, else not noise), `callJev` (`POST /v1/systemone`, 20 s timeout, capped answer, no redirects); the judge: `message` upserted events (Beeper and Gmail) queue a conversation, 5 s later up to 40 are read (`read_chat` limit 5) and asked about in one call, at most 6 calls a minute, unchanged conversations and the owner's own skipped, failures keep the verdicts and retry from 5 s doubling to 10 min. The Beeper actions and the router keep noise chats out of `inbox: "primary"` and `unread_summary` and add them to `inbox: "low-priority"` (Beeper: one walk over every chat; Gmail: a second lane per account over its Primary tab); the dispatcher marks every chat it returns (`isLowPriority`, `noise`). Nothing is ever written to Beeper or Gmail for it |
| `src/todo/store.ts`, `src/todo/tracker.ts` | To do ("todo.v1", protocol README "To do"): one rule, a message from someone else later than anything known here and than the source's first sight (so most chats need no entry, and nothing has to load every chat); the tracker feeds it from every result (`seeResult`), `message` events (Beeper's `othersAt`; Gmail's, after one look at the Primary tab), reads of a chat whose newest message is the owner's (own queue, 2 at a time), the first run per source (7 days back) and Add older unread, catching up after a start (see the comment in `tracker.ts`). The dispatcher marks every chat with `todo`; a flip goes out as a `chat` event with the one bit. Network read state is never touched: no `POST /read` or `/unread` for it |
| `src/media.ts`, `src/assets.ts` | `get_media`: only URLs a returned result carried (`AssetAllowlist`, hashes, bounded, persisted); head, then 256 KiB chunks under `ChunkWindow`, capped at 25 MiB or the declared size |
| `src/event-buffer.ts` | Beeper `chat`/`message` events (and noise verdict changes) while the cloud link is down: at most 200, one per chat, kind and op (message ids merged, the newest `othersAt`), oldest out; sent after the next welcome (status events are not kept: every welcome sends one) |
| `src/events.ts`, `src/beeper-ws.ts` | Beeper `/v1/ws` subscription per the spec: wait for `ready`, send `subscriptions.set` with a `requestID`, connected only when `subscriptions.updated` echoes `["*"]`; an `INVALID_PAYLOAD`/`INVALID_COMMAND` error is retried once without the `app` key; no confirmed subscription within 20 s of opening the socket (or a socket that never opens): close and retry with backoff. Resubscribe after drops, 30 s health checks (status events; `reachable:false` = Beeper down, `tokenValid:false`), re-sync after reconnects |
| `src/beeper-client.ts`, `src/beeper-map.ts`, `src/pager.ts`, `src/idempotency.ts` | Beeper HTTP client (encoded ids, no redirects, timeouts, capped bodies), mapping and sanitizing, `j2.` cursors, write dedupe that survives restarts |
| `src/preview-fill.ts` | A chat-list preview Beeper sends with only who and when: what it was (a reaction, a photo, an unsent message), from the chat's history, remembered per preview |
| `src/pairing-client.ts` | device-code pairing: start, show code + URL, poll (`slow_down`, expiry), token once |
| `src/secrets.ts`, `src/audit.ts`, `src/config.ts`, `src/launchd.ts`, `src/probe.ts`, `src/runner.ts` | Keychain (and test backends), audit log, paths and config, plist + install/uninstall, read-only probes, process runner |

Request handling (`CloudLink`):

- One deadline per `req`: `welcome.requestTimeoutMs` minus a margin for the action
  (`requestContext`), and a watchdog that answers just before the cloud gives up: `TIMEOUT`, or
  `UNKNOWN_OUTCOME` for a write that was already dispatched. Late results are dropped.
- At most 8 dispatches run at once; at most `MAX_INFLIGHT_REQUESTS` (32) are running or queued,
  more are `RATE_LIMITED` at once. A queued request whose deadline (nearly) passed is answered
  `TIMEOUT` and never dispatched.
- `get_media`: at most `MAX_CONCURRENT_MEDIA_STREAMS` (4) streams; the head within 60 s, then
  chunks only while the cloud acks (`ChunkWindow`), whole stream bounded by `mediaDeadlineMs(size)`.
- `cancel` aborts the request (no answer is sent): every Beeper and Gmail call of it is aborted and
  no further one starts. The cloud sends it when its own deadline passes, and (since 2026-10-31) when
  the browser that asked for a read went away. A duplicate `req` id is ignored.
- `viewers {count}` ("viewers.v1"): Gmail is polled every 10 s while `count > 0` (and at once when it
  becomes > 0), else every 30 s; a dropped link counts as 0.
- A frame that does not parse: if it is a `req` with a usable id, the answer is `NOT_ALLOWED`
  (unknown action) or `BAD_PARAMS`; everything else is dropped. The link stays up.
- Socket loss: reads are aborted, writes run to their deadline (aborting a POST in flight helps
  no one) and their results are dropped; the pending map is emptied either way (`stats()`).
- Heartbeat: `ping` every `welcome.heartbeatMs` (25 s); no frame for 60 s closes the socket (4408).
  No `welcome` within 10 s of the socket opening, or within 20 s of creating it (a stalled
  upgrade after sleep or a Wi-Fi change never fires `onclose`): drop it and reconnect.
- Close codes: 4403, 4409 (another computer was paired) and 4426 stop the link for good; 4401
  stops it only after it repeats (`unauthRetries`, 3 retries with backoff; older clouds closed a
  slow hello with 4401); 4410 (this device connected again, e.g. a second process) reconnects after
  60 s instead of fighting the other connection; everything else reconnects with backoff.
- Reconnect: `backoffDelay` (1 s, 2 s, 4 s ... 60 s, +/-20 % jitter); the attempt counter resets
  only after a connection stayed up 30 s (a cloud that accepts and drops at once cannot cause a
  reconnect storm).
- After every `welcome`: a `status` event, the events kept while the link was down
  (`event-buffer.ts`), re-sync (recent chats that changed since the last sync, as metadata-only
  `chat` events; a change of last activity, unread count, archived, marked unread, low priority,
  muted or pinned counts) and a Gmail history poll. After every Beeper `/v1/ws` subscription, the
  first one too (Beeper may have started after the connector): re-sync too.
- Beeper health: a `status` event on every change and again every 10 checks (5 min), in case one
  was lost. Under backpressure (more than 4 MiB unsent) chat/message events are dropped, never a
  `status` event.
- `message` events say whether someone else wrote (`othersAt`, for the cloud's snooze early
  return and To do; reactions and messages Beeper hides do not count; a NOTICE from someone else does): Beeper's `message.upserted` entries give `isSender` and the time (the newest other
  person's message time, `null` for the owner's own sends, left out when Beeper sent no entries);
  Gmail history: added mail without the `SENT` label, at the poll's time. Only that one timestamp
  leaves the Mac, never who wrote or what. The snooze itself lives in the cloud: the connector only
  runs `archive` and `mark_read` for it, and refuses `snooze_chat`/`unsnooze_chat`/`list_snoozed`
  (`NOT_ALLOWED`).
- Drafts by agents (`"drafts.v1"` in `hello.capabilities`): the request itself lives in the cloud
  (`request_draft` and the other owner actions are `NOT_ALLOWED` here); the connector only keeps its
  texts in the draft store, handing them back to the cloud for the owner's page and for the one agent
  that was asked, and forgets them when the cloud says so (`draft_store_delete`) or after 7 days.
- Delegations to agents (`"delegations.v1"`): the same store keeps a delegation's instruction under
  its `dlg_` id (`request_delegation` and the other owner actions are `NOT_ALLOWED` here). The
  connector never creates the Raft task: the agent does, with its own Raft CLI. The chat is marked
  read through the ordinary `mark_read`.
- `read_chat` asks Beeper for the chat and the first history page at once (a `limit` of 20 or less,
  one Beeper page, is then one round trip; the default 30 is two); `status` asks `/v1/info`,
  `/v1/accounts` and `/v1/chats` at once.
- Mark unread (`mark_read {read: false}`) on Beeper: real Beeper (WhatsApp, 2026-10-31) archives a
  chat about 0.5 s after it was marked unread. When the chat was in the inbox before, the connector
  watches it for 1.5 s (a `GET` every 250 ms, inside the request's deadline) and un-archives it once
  if Beeper did; an unarchive within 5 s of the connector's own unread (a snooze coming back:
  unread, then unarchive) is watched the same way, after the unarchive has answered. So a mark
  unread answers after about 1.5 s.
- `list_chats` with `inbox: "primary"` (the web's All chats and Unread) reads `GET /v1/chats`
  (`ChatWithPreview`) and filters archived/low-priority (and unread) chats here, so every row has
  its last message; text queries, chat types and the other inboxes use `/v1/chats/search` (no
  preview there).
- Pairing: if the owner approved but the poll that carried the device token got no usable answer,
  the next poll says `expired` (the token is handed out once); the CLI then says the computer may
  have been approved and to run `j-inbox pair` again, instead of "the code expired".
- Graceful stop (SIGTERM/SIGINT): new requests `OFFLINE`, running ones get up to 5 s, then close 1001.

Gmail: the service reads `gmail.json`, refreshes access through the cloud (`POST <cloud>/google/token`
with the device token; the web client secret never ships in this open-source connector) and talks to
Gmail directly from the Mac. `hello` carries `"gmail.v1"` and adds `"Gmail"` to the networks when an
account exists; every `welcome` triggers a history poll. `j-inbox uninstall` revokes every Gmail
account's access at Google before deleting the tokens. The idempotency journal never stores the
account address (compose results are rebuilt from the request).

Privacy: events, audit log, state file and service log carry metadata only (action names, error
codes, close codes, counts, durations). With noise on (a definition and a Jev key), the excerpts Jev
needs (title, network, the last 5 messages cut to 300 characters, an email sender's address, the owner's correction summaries)
go from this Mac straight to TypeSafe (`api.typesafe.ai`), never through the J-Inbox cloud. The audit log validates every field against a closed
vocabulary, so content cannot be written there by mistake. Tokens never appear in config files,
logs, argv or the launchd plist (`generatePlist` refuses them).

## Assumptions and open points

- Beeper Server is assumed to serve the same Client API as Desktop (plan section 6). The Beeper
  CLI commands above come from its public docs (developers.beeper.com/desktop-api-reference/cli,
  github.com/beeper/cli); they were never run here (rule: no Beeper install in development).
- How the owner gets a Beeper Server access token is not settled: setup asks for a pasted token.
  An OAuth/PKCE flow against Beeper's local `/oauth/*` endpoints would avoid pasting; not built.
- The Keychain backend is tested against a fake `security` only (never the real Keychain).
- `unpair`/`uninstall` revoke the computer in the cloud with its own token (`POST /pair/revoke`)
  before deleting it locally; if the cloud cannot be reached they still delete it locally and ask
  the owner to remove the computer in the web page.
- The local audit log records who asked (`caller`: human or agent, and the Raft display name,
  cleaned and capped at 64 characters) when the cloud's `req` carries the optional `caller`.
- `/pair/start` and `/pair/poll` answers are accepted bare or wrapped in `{ok:true,data}`.

## Tests

Everything runs against `@j-inbox/fake-beeper`, `@j-inbox/fake-google` (MIT: Google OAuth + Gmail
REST subset) and `test/helpers/fake-cloud.ts` (a protocol-only fake of `/connect`, `/pair/*` and
`/google/token`; `testkit` is closed source, so the connector cannot use its fakes). Gmail tests:
`test/gmail.test.ts` (every action on Gmail chats, mixed paging across both fakes, reauth, accounts,
history events), `test/merge.test.ts` (property style: hundreds of random interleavings, short and
empty pages, failures, frame-fitted pages; every item once, newest first), `test/gmail-mime.test.ts`
(decoding, reply-all, threading headers, encoding, header injection), `test/email-html.test.ts` and `test/gmail-email-html.test.ts` (the sanitizer against a hostile corpus, `test/fixtures/hostile-emails.ts`, and `get_email_html` against fake Google), `test/email-html-worker.test.ts` (the event loop watched during each email that once froze it, the deadline), `test/gmail-service.test.ts`
(the real service: `gmail_connect` over the cloud link, events, disk scan, removal), `test/todo.test.ts`, `test/todo-review.test.ts` and `test/todo-older.test.ts` (To do: the store, its first run and restart, the tracker, the whole service with Beeper and Gmail; the 7 days and Add older unread). Programs (`security`, `launchctl`, `beeper`, `pmset`) are fakes; paths are temp dirs.
`test/chaos.test.ts` covers garbled/truncated/binary/oversized/prototype-polluting frames, 100
concurrent requests, 1000 unknown actions, repeated socket drops mid-traffic, reconnect storms,
slow Beeper, Beeper 500s, oversized and malformed Beeper answers, media cancel storms, and checks
after each that nothing is left in flight.

`test/policy.test.ts` enforces the open-source boundary and is self-contained (no import from the
repo's root `scripts/`): src and tests may import only builtins, files in `connector/` and MIT
workspace packages (`@j-inbox/protocol`; in tests `@j-inbox/fake-beeper` and `@j-inbox/fake-google`). So `connector/`,
`protocol/` and `fake-beeper/` can be published together without any closed code.

## Rules specific to the connector

- `encodeURIComponent` every chat/message id in Beeper paths (ids contain `#`, `/`, `?`).
- Sort messages by `sortKey`; do not rely on Beeper's page order.
- Convert chat `imgURL` (a local path) to an encoded `file:///` URL; serve `get_media` only for
  asset URLs this connector has returned (Beeper will serve any `file://` path otherwise).
- Unknown `req` action -> `res` `NOT_ALLOWED`; bad params -> `BAD_PARAMS`; Beeper unreachable ->
  `BEEPER_DOWN`; Beeper 401 -> `BEEPER_UNAUTHORIZED` (not retryable; re-authorize); Beeper 404 ->
  `NOT_FOUND`; Beeper 429 -> `RATE_LIMITED`; Beeper 409/422 -> `CONFLICT`; a write whose answer
  was lost or failed in a way that may have happened (timeout, reset, any 5xx) ->
  `UNKNOWN_OUTCOME`, never a retryable code (`beeperErrorCode`).
- Response bodies are read with a running byte count and cancelled past `maxBodyBytes`
  (`readCapped`), with or without `Content-Length`.
- Writes with an `idempotencyKey` go through `IdempotencyCache` (key = action + chat + key, plus
  a digest of the other params: same key with different params is `CONFLICT`). The service must
  build it with `createWriteDedupe({journal: new FileIdempotencyJournal("~/Library/Application
  Support/j-inbox/idempotency.json")})` so keys survive restarts (in-flight at a crash ->
  `UNKNOWN_OUTCOME`, never re-sent). If the journal cannot be written, the write is not sent.
- An empty Beeper history page ends paging even if the previous page said `hasMore: true`.
- Never install Beeper Server or run `beeper setup/install/login` in development; `setup` code
  paths are tested only against `@j-inbox/fake-beeper` and fakes of the `beeper`, `security`, `launchctl` and `pmset` programs.
