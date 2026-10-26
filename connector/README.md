# J-Inbox connector (open source, MIT)

`j-inbox` CLI and background service that runs on the user's Mac. It links the local
Beeper Client API (Beeper Server or Beeper Desktop, `127.0.0.1:23373`) to the user's J-Inbox
cloud room, and only ever runs the actions in the protocol catalogue.

**Test:** `cd connector && bun test` (one command; about 30 s; fakes only, nothing outside 127.0.0.1)

**Build:** `cd connector && bun run build` -> `dist/j-inbox`, a single darwin-arm64 binary (`bun build --compile`; no Node or Bun needed on the target Mac). `test/binary.test.ts` builds it and runs `--help`, `--version`, `status` and `run` against the fakes.

Status: implemented (CLI, service, launchd, cloud link, all 11 actions). Not yet tested against a
real cloud (the cloud is built in parallel) or a real Beeper Server (never installed during
development, by rule); see "Assumptions" below.

## Using it

```sh
j-inbox setup        # Beeper -> Beeper token into the Keychain -> pair -> launchd agent -> checks
j-inbox status       # Beeper, pairing, service and cloud link at a glance (--json; exit 1 if anything is off)
j-inbox logs         # recent operations, metadata only (-n N, --json, --service for the service log)
j-inbox pair         # pair (or with --force re-pair) this computer: shows a code to type in the web page
j-inbox unpair       # revoke this computer in the cloud (POST /pair/revoke), then forget the device token here
j-inbox doctor       # finds common problems and prints a fix for each (--json; exit 1 on failures)
j-inbox uninstall    # launchd agent, both tokens, J-Inbox's own files (--yes, --keep-config); Beeper is left alone
j-inbox run          # the service in the foreground (what launchd runs)
```

`setup` options: `--engine desktop|server`, `--beeper-url URL` (loopback only), `--beeper-port N`,
`--beeper-token-stdin`, `--cloud-url URL`, `--name NAME`, `--skip-pair`, `--no-service`, `--yes`.

- **Desktop engine:** uses Beeper Desktop's API on 23373. The owner pastes an access token
  (Beeper Desktop > Settings > Developers), or pipes it with `--beeper-token-stdin`.
- **Server engine:** wraps the Beeper CLI (`brew install beeper/tap/cli`):
  `beeper targets add server j-inbox --port P`, `beeper setup --server --install --target j-inbox`
  (interactive: email code, device verification), `beeper targets enable j-inbox`. `P` is 23373
  when free, else the first free port from 23374 (Beeper Desktop usually holds 23373); the check
  is a TCP connect only. The commands are in `beeperCommands()` in `src/commands/setup.ts`.
- Every token is verified against Beeper (`GET /v1/accounts`) before it is stored; a rejected
  token is never stored.

## Where things live

| What | Where |
|---|---|
| Config (no secrets: cloud URL, Beeper URL, engine, device id and name) | `~/.config/j-inbox/config.json` (0600) |
| Beeper token, device token | login Keychain, service `build.jsuite.j-inbox`, accounts `beeper-token` / `device-token`, written with `security -i` on stdin (never in argv) |
| Idempotency journal (key hashes, parameter digests, result ids; never text or chat ids), asset allowlist (URL hashes) | `~/Library/Application Support/j-inbox/` |
| Audit log `audit.jsonl` (rotated at 5 MiB, 3 files), service log `service.log` | `~/Library/Logs/j-inbox/` |
| Service state for `status` (pid, cloud link state, Beeper health) | `~/.config/j-inbox/state.json` |
| launchd agent | `~/Library/LaunchAgents/build.jsuite.j-inbox.plist`: `RunAtLoad`, `KeepAlive {SuccessfulExit: false}`, `ThrottleInterval 10`, logs to `service.log` |

`J_INBOX_CONFIG_DIR=/abs/dir` (or `--config-dir`) moves all of it, including the LaunchAgents
directory, under one directory. `J_INBOX_SECRETS=file` swaps the Keychain for a 0600 JSON file,
and is refused unless `J_INBOX_CONFIG_DIR` is set (tests and local development only).

## How it works

| Module | What |
|---|---|
| `src/cli.ts`, `src/commands/*` | argument parsing (unknown flags refused) and the commands; every external program, prompt, path and clock is injected (`CliDeps`) |
| `src/service.ts` | `j-inbox run`: composes everything below; exits 0 only when it must stay down (unpaired, no token, revoked 4403, replaced by another computer 4409, a 4401 that repeats 4 times in a row, version 4426); a stop by a signal exits 128 + signal (SIGTERM 143, SIGINT 130), so launchd (KeepAlive SuccessfulExit=false) restarts it after `kill` or Activity Monitor's Quit, while `launchctl bootout` (uninstall) removes the job |
| `src/instance-lock.ts`, `src/commands/run.ts` | one `j-inbox run` per config dir: an atomic pid file `run.lock` with its `startedAt` (taken over when the holder is dead, or when its pid now belongs to a process that started after the lock was written: a pid reused after a reboot or kill -9, checked with `ps -o etime=`; `status` and `doctor` apply the same check to `state.json`); a second `run` exits 3 with "already running (pid N)" and touches nothing |
| `src/cloud-link.ts` | `wss://<app>/connect` with `Authorization: Bearer <deviceToken>` (https only; http only for loopback dev); `hello` -> `welcome`; requests; heartbeat; reconnect |
| `src/dispatcher.ts` | the whitelist: catalogue action -> `parseActionParams` -> its own Beeper endpoints -> `parseActionResult`; anything else `NOT_ALLOWED` |
| `src/actions.ts` | all 10 JSON actions (`status`, `list_chats`, `unread_summary`, `read_chat`, `search_messages`, `draft_reply`, `send_message`, `react`, `mark_read`, `archive`) |
| `src/media.ts`, `src/assets.ts` | `get_media`: only URLs a returned result carried (`AssetAllowlist`, hashes, bounded, persisted); head, then 256 KiB chunks under `ChunkWindow`, capped at 25 MiB or the declared size |
| `src/events.ts`, `src/beeper-ws.ts` | Beeper `/v1/ws` subscription per the spec: wait for `ready`, send `subscriptions.set` with a `requestID`, connected only when `subscriptions.updated` echoes `["*"]`; an `INVALID_PAYLOAD`/`INVALID_COMMAND` error is retried once without the `app` key; no confirmed subscription within 20 s of opening the socket (or a socket that never opens): close and retry with backoff. Resubscribe after drops, 30 s health checks (status events; `reachable:false` = Beeper down, `tokenValid:false`), re-sync after reconnects |
| `src/beeper-client.ts`, `src/beeper-map.ts`, `src/pager.ts`, `src/idempotency.ts` | Beeper HTTP client (encoded ids, no redirects, timeouts, capped bodies), mapping and sanitizing, `j2.` cursors, write dedupe that survives restarts |
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
- `cancel` aborts the request (no answer is sent). A duplicate `req` id is ignored.
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
- After every `welcome`: a `status` event and re-sync (recent chats that changed since the last
  sync, as metadata-only `chat` events). After every Beeper `/v1/ws` subscription, the first one
  too (Beeper may have started after the connector): re-sync too.
- Beeper health: a `status` event on every change and again every 10 checks (5 min), in case one
  was lost. Under backpressure (more than 4 MiB unsent) chat/message events are dropped, never a
  `status` event.
- `list_chats` with `inbox: "primary"` (the web's All chats and Unread) reads `GET /v1/chats`
  (`ChatWithPreview`) and filters archived/low-priority (and unread) chats here, so every row has
  its last message; text queries, chat types and the other inboxes use `/v1/chats/search` (no
  preview there).
- Pairing: if the owner approved but the poll that carried the device token got no usable answer,
  the next poll says `expired` (the token is handed out once); the CLI then says the computer may
  have been approved and to run `j-inbox pair` again, instead of "the code expired".
- Graceful stop (SIGTERM/SIGINT): new requests `OFFLINE`, running ones get up to 5 s, then close 1001.

Privacy: events, audit log, state file and service log carry metadata only (action names, error
codes, close codes, counts, durations). The audit log validates every field against a closed
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

Everything runs against `@j-inbox/fake-beeper` and `test/helpers/fake-cloud.ts` (a protocol-only
fake of `/connect` and `/pair/*`; `testkit` is closed source, so the connector cannot use its
fakes). Programs (`security`, `launchctl`, `beeper`, `pmset`) are fakes; paths are temp dirs.
`test/chaos.test.ts` covers garbled/truncated/binary/oversized/prototype-polluting frames, 100
concurrent requests, 1000 unknown actions, repeated socket drops mid-traffic, reconnect storms,
slow Beeper, Beeper 500s, oversized and malformed Beeper answers, media cancel storms, and checks
after each that nothing is left in flight.

`test/policy.test.ts` enforces the open-source boundary and is self-contained (no import from the
repo's root `scripts/`): src and tests may import only builtins, files in `connector/` and MIT
workspace packages (`@j-inbox/protocol`; in tests `@j-inbox/fake-beeper`). So `connector/`,
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
