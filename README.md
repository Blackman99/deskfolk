<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme-hero-dark.png">
    <img alt="Deskfolk: a group chat beside its flow board, a pending approval card and a Markdown preview" src="docs/assets/readme-hero-light.png">
  </picture>
</p>

<h1 align="center">Deskfolk</h1>

<p align="center">Persistent AI teammates, organized by conversation, on your own Mac.</p>

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

## What it does

- **Persistent teammates.** Bots have names, duties and boundaries; they chat one to one, join groups, get `@`mentioned and hand work to each other.
- **Everything on your Mac.** Window, daemon, sessions and the shared workspace stay local. Bring any OpenAI-compatible endpoint and MCP servers.
- **Every job is a flow.** A card per turn, drawn by who woke whom, with the files each turn handed over.
- **Annotate what a Bot hands over.** Mark a spot in text or code, rendered Markdown, an image or PDF region, an HTML element or a moment of audio or video; the batch goes out as one reply the Bot works through and resolves note by note.
- **Model choice that says why.** An agent picks each turn's model and thinking level and leaves a reason; only reviews that blame the model become the Bot's experience.
- **A split-pane workbench.** Divide the desktop window into panes of conversations, terminals, the routine calendar, workspace and Spend. Close an empty pane with its top-right ×, or choose **Close pane** from a pane’s context menu. Fold the session list to a rail of avatars with the button beside its search button or ⌘B.
- **Global search.** Open Search from the sidebar or folded rail, or press ⌘K (Ctrl+K). Filter conversations, messages, files and routines in a keyboard-friendly dialog; phones use a full-screen view. In the editor or terminal, use ⌘⇧K (Ctrl+Shift+K). Rail icons explain themselves on hover or keyboard focus.
- **Your own terminal.** Shells held by the daemon keep running when the window closes; a Bot's commands scroll under its message while they run.
- **Spend by model, conversation and Bot.** Track turn, decision and feedback calls; reported amounts and estimates stay separate — [spend and billing rates](docs/spend.md).
- **Routines.** Bots start work daily or weekly on the Mac's clock — [how routines work](docs/routines.md).
- **You stay in control.** New endpoints or MCP servers, access outside the workspace and outbound network wait for your approval, and keys go to Keychain. What waits on you is marked on the conversation list, with macOS banners and a Dock badge.
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

Alpha, macOS only; features and data formats may still change. Remote access is a default-off prototype whose independent security review and real-device checks have not passed.

[What is live and what is not](https://blackman99.github.io/deskfolk/en#boundaries) · [Roadmap](ROADMAP.md) · [Domain language](CONTEXT.md) · [Relay deployment](docs/deploy-remote.md)

## Contributing

[Development guide](docs/development.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md). MIT licensed. Not affiliated with xAI / Grok.
