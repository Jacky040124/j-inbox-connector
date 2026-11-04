<p align="center">
  <img src="docs/assets/banner.svg" alt="J-Inbox: every chat in one inbox. AI agents draft, you decide what gets sent." width="100%">
</p>

<p align="center">
  <a href="https://inbox.jackyzhonghq.com"><b>Website</b></a> &nbsp;·&nbsp;
  <a href="#why-j-inbox"><b>Why J-Inbox</b></a> &nbsp;·&nbsp;
  <a href="#architecture"><b>Architecture</b></a> &nbsp;·&nbsp;
  <a href="#install"><b>Install</b></a> &nbsp;·&nbsp;
  <a href="#built-with-ai"><b>Built with AI</b></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Bun-1.3-000000?logo=bun&logoColor=white" alt="Bun">
  <img src="https://img.shields.io/badge/tests-1%2C216-brightgreen" alt="1,216 tests">
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple" alt="macOS">
</p>

J-Inbox puts WhatsApp, iMessage, Instagram, LinkedIn, X, Telegram, Signal, SMS and Gmail in one fast inbox. AI agents can draft your replies and take on tasks, but **nothing is sent until a person approves it**.

This repo is the open-source half: the connector that runs on your Mac.

<p align="center">
  <img src="docs/assets/demo.gif" alt="Open a chat, ask an agent for a draft, review it and send it" width="100%">
</p>
<p align="center"><sub>Every name and message in these images is invented demo data.</sub></p>

## Why J-Inbox

### Every chat in one place

One list for all your networks, while each conversation still feels like its own app.

<table>
  <tr>
    <td width="33%"><img src="docs/assets/skin-whatsapp.png" alt="A WhatsApp chat in J-Inbox"></td>
    <td width="33%"><img src="docs/assets/skin-linkedin.png" alt="A LinkedIn chat in J-Inbox"></td>
    <td width="33%"><img src="docs/assets/skin-gmail.png" alt="A Gmail thread in J-Inbox"></td>
  </tr>
</table>

### Agents help, you stay in control

Ask an agent to draft a reply or hand it a chat as a task. You see the exact text before anything goes out.

<table>
  <tr>
    <td width="50%"><img src="docs/assets/draft-card.png" alt="A draft from an agent, with Send, Edit, Rewrite and Discard"></td>
    <td width="50%"><img src="docs/assets/approval.png" alt="The approval page, showing the exact text an agent wants to send"></td>
  </tr>
</table>

### Your chats stay on your Mac

The connector only dials out, your keys stay in the macOS Keychain, and the cloud relays requests without storing messages. The part on your machine is open source, so you can check it.

### Works everywhere

Light, dark, desktop and phone.

<table>
  <tr>
    <td width="70%"><img src="docs/assets/inbox-dark.png" alt="J-Inbox in dark mode"></td>
    <td width="30%"><img src="docs/assets/phone.png" alt="J-Inbox on a phone"></td>
  </tr>
</table>

## Architecture

```mermaid
flowchart LR
    B["Beeper and Gmail<br/>on your Mac"] <-->|localhost| C["j-inbox connector<br/>(this repo)"]
    C <-->|outbound WSS only| R["J-Inbox cloud<br/>pass-through relay"]
    R <--> W["Web app<br/>for you"]
    R <--> A["Raft agents<br/>draft, never send"]
```

| Part | Built with | Role |
|---|---|---|
| **Connector** (open source) | TypeScript, Bun | Runs on your Mac and only performs a whitelist of actions |
| **Protocol** (open source) | TypeScript | One shared contract for every part, checked at runtime |
| **Cloud** | Cloudflare | Relays requests and stores no messages |
| **Web app** | React, Tailwind CSS | The inbox you use, on desktop and phone |
| **Agents** | [Raft](https://raft.build) App | Lets agents draft replies and take on tasks |

## Built with AI

I use J-Inbox every day, and I built it with AI coding agents. I set the requirements and the safety rules, the agents wrote the code, and every commit in this repo carries a `Co-Authored-By: Claude` trailer. Because the agents write the code, the design assumes the code has to prove itself:

- **1,216 tests** across the protocol, the fakes and the connector, and none of them touch real accounts.
- **Fake services that misbehave on purpose.** [`fake-beeper/`](fake-beeper/README.md) copies real API quirks and injects faults, so failures get tested and not only the happy path.
- **A person stays in control.** An agent can draft a reply, but a person has to approve it before it is sent.

**What the AI got wrong.** An agent drafted a reply, the API returned `draftSet: true`, and every check looked fine, but the draft never showed up in my Unread view. The feature only looked finished. The chat had been archived, and Unread hides archived chats, which nobody had thought about when the feature was built. A ready draft now moves its chat back to the inbox, with a test to hold that in place. Since then I check the result as a user would see it, and I do not count a green response as done.

## Install

Requires macOS (Apple silicon), [Beeper](https://www.beeper.com) and [Bun](https://bun.sh) 1.3+.

```sh
bun install
bun run build
./connector/dist/j-inbox setup
```

See [`connector/README.md`](connector/README.md) for details.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Beeper.
