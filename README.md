# J-Inbox connector

![License: MIT](https://img.shields.io/badge/license-MIT-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![Bun](https://img.shields.io/badge/Bun-1.3-000000?logo=bun&logoColor=white) ![Tests](https://img.shields.io/badge/tests-1216%20passing-brightgreen) ![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)

**Every chat in one inbox, and an AI agent that can help with it without ever sending on its own.**

The open-source half of [J-Inbox](https://inbox.jackyzhonghq.com): one inbox for WhatsApp,
Instagram, LinkedIn, X, iMessage, Gmail and more, for people (a small web page) and for AI agents
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
- **Your keys stay here.** The Beeper token and your Gmail access live in the macOS Keychain. The cloud never stores them.
- **No chat content in logs.** The local audit log records the action name, time and result only.
- **Pass-through cloud.** The J-Inbox cloud relays requests and stores no messages. (The cloud is
  closed source; this repo is the part that runs on your machine, so you can check what it does.)

## Built with AI

I use J-Inbox every day, and I built it with AI coding agents. I set the requirements and the safety rules, the agents wrote the code, and every commit in this repo carries a `Co-Authored-By: Claude` trailer. Because the agents write the code, the design assumes the code has to prove itself:

- **1,216 tests** across the protocol, the fakes and the connector, and none of them touch real accounts.
- **Fake services that misbehave on purpose.** [`fake-beeper/`](fake-beeper/README.md) copies real API quirks and injects faults, so failures get tested and not only the happy path.
- **A person stays in control.** An agent can draft a reply, but a person has to approve it before it is sent.

**What the AI got wrong.** An agent drafted a reply, the API returned `draftSet: true`, and every check looked fine, but the draft never showed up in my Unread view. The feature only looked finished. The chat had been archived, and Unread hides archived chats, which nobody had thought about when the feature was built. A ready draft now moves its chat back to the inbox, with a test to hold that in place. Since then I check the result as a user would see it, and I do not count a green response as done.

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
| [`fake-google/`](fake-google/README.md) | A fake Google OAuth + Gmail REST subset, used by the tests. |
| `scripts/` | Helpers for the import-boundary tests. |

## Tests

```sh
bun run test        # protocol, fake-beeper, connector; fakes only, nothing leaves 127.0.0.1
bun run typecheck
```

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Beeper.
