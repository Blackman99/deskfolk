<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme-hero-dark.png">
    <img alt="Deskfolk: a group chat beside its flow board, a pending approval card and a Markdown preview" src="docs/assets/readme-hero-light.png">
  </picture>
</p>

<h1 align="center">Deskfolk</h1>

<p align="center">A private AI team you can trust.</p>

<p align="center">A workbench you arrange freely: chats, terminals, flow boards and the workspace, split however you like.</p>

<p align="center">
  <a href="https://blackman99.github.io/deskfolk/"><b>Website</b></a> ·
  <a href="https://github.com/Blackman99/deskfolk/releases/latest"><b>Download alpha</b></a> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Blackman99/deskfolk/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Blackman99/deskfolk/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-146a7c.svg"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-0f172a.svg">
  <a href="https://github.com/Blackman99/deskfolk/releases/latest"><img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-f0ab3d.svg"></a>
</p>

## Why you can trust it

- **It stays on your Mac.** Window, daemon, sessions and the shared workspace stay local. Bring any OpenAI-compatible endpoint and MCP servers; keys go to Keychain.
- **It asks before risky moves.** New endpoints or MCP servers, access outside the workspace and outbound network wait for your approval. What waits on you is marked on the conversation list, with macOS banners and a Dock badge. Stop ends a running turn in a direct chat at any time.
- **It shows its work.** Every plan is a flow: the app files each message you send into a plan and its tickets, keeps the goal, the done-when and your rules as the plan's spec, and draws the work as a card per turn by who woke whom, carrying the files that turn handed over, the ticket it worked in, and the model it ran on and why. You can open the direct chats Bots have with each other, too.
- **It checks before handing over.** Before a Bot hands you files, the files and its wrap-up are checked against the plan's spec, or against what you first asked for until the app has written one; anything missing gets done, or the Bot says who has it, why it was left out or when it will be done.

## What it does

- **Persistent teammates.** Bots have names, duties and boundaries; they chat one to one, join groups, get `@`mentioned and hand work to each other.
- **Office file previews.** Open `.docx`, `.xlsx` and `.pptx` from chat files, the workspace or flow-board outputs. Read documents, switch worksheets and browse slides locally, with full-window viewing and Escape or phone Back to return to the preview; [format support and limits](docs/development.md#办公文件预览).
- **Annotate what a Bot hands over.** Mark a spot in text or code, rendered Markdown, an image or PDF region, an HTML element or a moment of audio or video; the batch goes out as one reply the Bot works through and resolves note by note.
- **Model choice that says why.** An agent picks each turn's model and thinking level and leaves a reason; only reviews that blame the model become the Bot's experience.
- **A split-pane workbench.** Divide the desktop window into panes of conversations, terminals, the routine calendar, workspace and Spend. Close an empty pane with its top-right ×, or choose **Close pane** from a pane’s context menu. Fold the session list to a rail of avatars with the button beside its search button or ⌘B.
- **Global search.** Open Search from the sidebar or folded rail, or press ⌘K (Ctrl+K). Filter conversations, messages, files and routines in a keyboard-friendly dialog; phones use a full-screen view. In the editor or terminal, use ⌘⇧K (Ctrl+Shift+K). Rail icons explain themselves on hover or keyboard focus.
- **Your own terminal.** Shells held by the daemon keep running when the window closes; a Bot's commands scroll under its message while they run.
- **Spend by model, conversation and Bot.** Track turn, decision and feedback calls; reported amounts and estimates stay separate — [spend and billing rates](docs/spend.md).
- **Routines.** Bots start work daily or weekly on the Mac's clock — [how routines work](docs/routines.md).
- **From your phone — experimental, off by default.** Reach your Mac through a relay you run yourself, end-to-end encrypted — [remote access](docs/remote-access.md).

## Get it

macOS 13 (Ventura) or later, Apple silicon or Intel.

- **Download** the latest unsigned `.dmg` from [Releases](https://github.com/Blackman99/deskfolk/releases/latest); nothing else to install. If Gatekeeper blocks the first launch, right-click → Open, or run `xattr -dr com.apple.quarantine "/Applications/Deskfolk.app"` ([Gatekeeper FAQ](docs/gatekeeper.md)).
- **Updates** show as a dot on the labeled **Settings** entry at the bottom of the desktop sidebar; Settings → About downloads and installs them. Appearance is in Settings → Preferences → Appearance.
- **From source** (Node 22+, pnpm 12.3.4, Bun 1.2+, Rust, Xcode Command Line Tools):

```bash
git clone https://github.com/Blackman99/deskfolk.git
cd deskfolk
pnpm install
pnpm dev
```

First run: pick a workspace folder, add an endpoint and key in Settings, create the first Bot, then let it hire the rest.

## Status

Alpha, macOS only; features and data formats may still change. Remote access is a default-off prototype. Everyday use and Web Push work on a real Android phone in Chrome; the iOS home screen and WebAuthn user verification have not been checked on real devices, and the independent security review has not passed. A release build cannot pair yet, so remote access needs Deskfolk running from source.

[What is live and what is not](https://blackman99.github.io/deskfolk/en#boundaries) · [Roadmap](ROADMAP.md) · [Domain language](CONTEXT.md) · [Relay deployment](docs/deploy-remote.md)

## Contributing

[Development guide](docs/development.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md). MIT licensed. Not affiliated with xAI / Grok.
