<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme-hero-dark.png">
    <img alt="Real Bot: a group chat with three bots, a pending approval card and a Markdown preview" src="docs/assets/readme-hero-light.png">
  </picture>
</p>

<h1 align="center">Real Bot</h1>

<p align="center">Persistent AI teammates, organized by conversation, on your own Mac.</p>

<p align="center">
  <a href="https://blackman99.github.io/real-bot/"><b>Website</b></a> ·
  <a href="https://github.com/Blackman99/real-bot/releases/latest"><b>Download alpha</b></a> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Blackman99/real-bot/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Blackman99/real-bot/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-146a7c.svg"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-0f172a.svg">
  <a href="https://github.com/Blackman99/real-bot/releases/latest"><img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-f0ab3d.svg"></a>
</p>

## What it does

- **Teammates, not throwaway chats.** Bots have names, duties and boundaries. They chat one to one, join groups, get `@`mentioned and hand work to each other. When one bot goes off to ask another, that is its own conversation, opened from the message that prompted it and read-only to you.
- **Everything stays on your Mac.** Window, daemon, sessions and one shared workspace folder are local. No project-run cloud.
- **Bring your own models and tools.** Any OpenAI-compatible endpoint; MCP servers over stdio or Streamable HTTP, available to every bot.
- **One job reads as a flow.** A group, a direct chat and a Bot-to-Bot aside that share a work dir open the same board: top to bottom by who woke whom, a card per turn, and the file that turn handed over unfolding after that turn, read only. Opening it from a message lands on that message's card.
- **Model choice is made per turn, and says why.** Before each turn an agent picks the model and thinking level for that bot and leaves a one-line reason. When a correction runs its course it reviews what actually went wrong — the model, the task, or the way you asked — and only a verdict against the model is kept as that bot's experience. A turn also records how many hops it took and how many tool calls failed, and a closed chain may leave one memory, or a revision of a skill the bot already has, for the next time. Every turn's choice, outcome and feedback reads back from the session itself, and the messenger log can be filtered.
- **A terminal at hand, and commands you can watch.** Open your own shell session in the app and run something that stays up, like `pnpm dev`: the daemon holds it, so closing the window does not end it, and Quit and reopen puts it back where it was. It behaves like a Mac terminal — the ⌘← / ⌘⌫ editing keys, ⌘K to clear, ⌘F to find, ⌘-click to open a link, Copy and Paste on the right-click, colours that follow light and dark, a screen the daemon keeps so vim and friends come back whole when you reattach — and under zsh its tab follows you when you `cd`. A paired phone can watch it and type into it, with a key row for the Ctrl-C, Tab and arrows a software keyboard does not have. When a Bot runs a command its output scrolls under that bubble while it runs, then folds to one line — command, exit code, how long. The Bot still gets the same one-shot shell it always had, classified per spawn and gated where it was gated; you are just no longer staring at ten minutes of silence.
- **Dangerous actions wait for you.** New endpoints or MCP servers, anything outside the workspace and outbound network stop at an approval card. Keys go to Keychain, never into chat.
- **Bots run the app.** Create bots, form groups and configure endpoints or MCP by talking to one.

## Get it

**System requirement: macOS 13.0 (Ventura) or later**, on Apple silicon or Intel.

**Download** the latest alpha from [GitHub Releases](https://github.com/Blackman99/real-bot/releases/latest): unsigned `.dmg` for Apple silicon and Intel. The app carries its own runtime and native helper, so there is nothing else to install — no Bun, no Node, no checkout. If Gatekeeper blocks the first launch, right-click → Open, or run:

```bash
xattr -dr com.apple.quarantine "/Applications/Real Bot.app"
```

More detail: [Gatekeeper FAQ](docs/gatekeeper.md) · notarization path: [docs/notarization.md](docs/notarization.md) ([#10](https://github.com/Blackman99/real-bot/issues/10)).

**Updates:** the app checks GitHub Releases in the background and shows a dot on the settings gear when a newer build exists. Settings → General → About lists the current version and opens the matching `.dmg` in your browser; while builds are unsigned there is no in-app installer.

**Run from source** (macOS 13.0+, Node 22+, pnpm 12.3.4, Bun 1.2+, Rust, Xcode Command Line Tools):

```bash
cd real-bot
pnpm install
pnpm dev
```

First run: pick a workspace folder (missing folders are created), add an OpenAI-compatible endpoint and key in Settings, create the first bot from the sidebar, then let it hire the rest.

On phone-width screens, the messenger has **Chats / Workspace / Settings** navigation. Archived sessions are below the chat search field; appearance is in **Settings → Preferences**. Opening a conversation or a settings detail hides the bottom navigation. Switching away from an edited workspace file asks you to save or discard changes.

## Daily and weekly routines

The calendar button at the bottom of the sidebar (beside search on a phone) opens the **routine calendar**: every Bot’s daily and weekly routines on one week grid, read only. A block is the rule unfolded, not a record of each run, and the clock on it is the execution Mac’s local time. Changing a time still happens in the Bot’s profile; a phone cannot drag.

Open a Bot’s profile (the Bot avatar/name → profile), then **Routines → Add routine**. The owner is that Bot. Enter a title and task instruction, choose **Daily** or **Weekly** with one or more weekdays, and enter a 24-hour `HH:MM` time. Save, edit, pause/resume, or delete with confirmation in the same card. Sidebar search opens the matching routine’s Bot profile and highlights its editor. A later search or dismissal cancels earlier pending navigation. Historical routines belonging to a deleted Bot remain retained but are marked unavailable in search. Confirmation dialogs keep keyboard focus inside, restore the invoking control on cancellation, and block dismissal while saving.

Times are civil times in the **execution Mac’s local time zone**, not the browser’s zone; there is no per-routine timezone or cron expression. The Mac must be awake and its runtime available. Recovery catches up only the latest missed occurrence, never every missed run; archived Bots do not run routines. Deleting or pausing a routine does not stop already-started work. Lists update live across clients and refresh after reconnecting. If another client edits a draft’s routine, load the latest version before saving; stale saves and deletes are rejected rather than overwriting it. Connection loss does not automatically retry a write—check the list after reconnecting. If a request result is unknown, **Retry original request** in the routine card resends only the original content and request ID, not later draft edits. Pending-payload warnings are not revision conflicts. After the request is no longer pending, the edited draft stays visible but cannot be submitted until you check the list and reopen the routine.

## Status

Alpha, macOS only. What is live, in progress and out of scope: [website](https://blackman99.github.io/real-bot/en#boundaries) · [Roadmap](ROADMAP.md) · [CONTEXT.md](CONTEXT.md) (domain language).

The shared remote-crypto package is an **experimental, default-off prototype**, not available remote access. A default-off Bun relay, native-gated daemon adapter, and hosted messenger PWA client now exist for isolated integration testing. Hosted production builds omit local discovery and the loopback bearer; public pairing stays off. A link that ends — the relay closing it, the Mac going away, a phone changing network — is noticed by the page itself and retried with backoff, including the silently dead link a browser never reports; nothing is queued while it is down, and coming back from a locked screen or the background tries again without waiting to be tapped. Web Push honors the daemon's proxy environment (`https_proxy` / `HTTPS_PROXY`, with `ALL_PROXY` fallback and `NO_PROXY` exclusions); see [proxy setup](docs/deploy-remote.md#web-push-proxy). Optional Web Push is a generic pending-item reminder from the Mac; a notification click reconnects and returns to the chat list and never approves. In-app state lives on the conversation list; there is no notification page. The production daemon advertises `push_settings_v2` with `push_transport=policy_v2`. Outbound Web Push send, subscribe and test require an open remote gate (activation / native / trust); unsubscribe stays available for cleanup. It does not stay on a temporary upgrade pause. Cold-start click from a signed installed package is still unverified (`NATIVE_DELIVERY_QUALIFIED` is false). A banner posts when the process has a bundle identity and the system permission is granted; that flag no longer disables the test. Enqueueing reports queued, not native-accepted. `tauri dev` re-executes inside a debug `.app` with the same `com.real-bot.desktop` identity, so Notification Center and an already granted system permission both apply.  Hosted remote tests use the remote gate, contact, and subscription. This is not a ready remote product: independent security review (S-rev), physical iOS/Android home-screen WebAuthn (G-uv), physical L1, and physical home-screen Web Push (G-push) have **not passed**. See [self-hosted deployment, bootstrap recovery and routing contracts](docs/deploy-remote.md), including the separate `test:edge` command for real local Caddy HTTP/HTTPS/WSS checks (Caddy 2.10.2 and OpenSSL required). Its tests include official Noise vectors and an independent Rust snow peer (`pnpm test` requires Cargo). See the [protocol/API contract](docs/remote-protocol.md), including the single shared receipt digest with conditional headers and duplicate-filename ordering, now also consumed by local daemon receipts through the canonical-only workspace export. The daemon retains its stricter route and strong-SHA256 If-Match checks.

## Contributing

[Development guide](docs/development.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md). MIT licensed. Not affiliated with xAI / Grok.
