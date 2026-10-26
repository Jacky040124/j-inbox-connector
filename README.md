# J-Inbox connector

The open-source half of [J-Inbox](https://inbox.jackyzhonghq.com): one inbox for WhatsApp,
Instagram, LinkedIn, X, iMessage and more, for people (a small web page) and for AI agents
(a [Raft](https://raft.build) App).

The chats themselves never leave your Mac except to answer a request. J-Inbox uses the
[Beeper](https://www.beeper.com) Client API (Beeper Server or Beeper Desktop) running on your own
Mac. This connector is a small background service that links it to the J-Inbox cloud:

```
Beeper on your Mac  <-- localhost -->  j-inbox connector  <-- outbound WSS -->  J-Inbox cloud  <-->  web page / Raft agents
```

- **Outbound only.** The connector dials out to the cloud. No open ports, no tunnels.
- **Whitelist.** The cloud can only ask for the actions in the protocol catalogue
  (`protocol/src/actions.ts`): list, read and search chats, get media, draft, send, react, mark
  read, archive. An agent's send waits for a person to approve it in J-Inbox. Anything else is refused here, on your Mac.
- **Your keys stay here.** The Beeper token lives in the macOS Keychain. The cloud never sees it.
- **No chat content in logs.** The local audit log records the action name, time and result only.
- **Pass-through cloud.** The J-Inbox cloud relays requests and stores no messages. (The cloud is
  closed source; this repo is the part that runs on your machine, so you can check what it does.)

## Install

Requires macOS (Apple silicon) and Beeper. A Homebrew formula is coming; until then build from
source with [Bun](https://bun.sh) 1.3+:

```sh
bun install
bun run build             # -> connector/dist/j-inbox (a single binary, no runtime needed)
./connector/dist/j-inbox setup
```

`j-inbox setup` connects to Beeper, stores its token in the Keychain, pairs this computer with your
J-Inbox account (you confirm a code in the browser), and installs a launchd agent so the
connector starts at login and restarts if it crashes. See [`connector/README.md`](connector/README.md)
for every command and file location.

## Repo layout

| Dir | What |
|---|---|
| [`connector/`](connector/README.md) | The `j-inbox` CLI and background service. |
| [`protocol/`](protocol/README.md) | Every contract between connector, cloud, web page and agents, with runtime validators. No dependencies. |
| [`fake-beeper/`](fake-beeper/README.md) | A fake Beeper Client API with real-API quirks and fault injection, used by the tests. |
| `scripts/` | Helpers for the import-boundary tests. |

## Tests

```sh
bun run test        # protocol, fake-beeper, connector; fakes only, nothing leaves 127.0.0.1
bun run typecheck
```

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Beeper.
