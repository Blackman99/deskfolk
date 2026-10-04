# BRIEF — Deskfolk launch film

## Business
Deskfolk: a local, single-user agent collaboration app (macOS; Windows is an experimental preview). A team of named, persistent Bots splits a job and hands it on; the app watches planning and acceptance: it sends back unbacked claims, chases stalls, runs done-when checks itself, asks before risky moves, and records every step on a flow board. Open source (MIT), alpha. Users bring their own model endpoint (any OpenAI-compatible) and key.

## Buyer / viewer
Solo developers, technical individuals, small studios who can set up a model endpoint themselves and have a multi-step, file-producing job (a research report, a launch kit, a small tool with tests and a start command). They have been burned by agents that say "done" / "tests pass" when nothing ran.

## The viewer's problem
Handing a whole job to AI agents means babysitting them: claims without evidence, work that silently stops halfway, no record of who did what.

## Single action (CTA)
Download the alpha / open the GitHub repo: `github.com/Blackman99/deskfolk`.

## Provably true (from README, CONTEXT, docs/behavior.md)
- Bots are named persistent teammates; they chat 1:1, join groups, get @mentioned and hand work to each other.
- Each message you send is filed into a plan and its tickets (organizer); the flow board draws a card per turn, by who woke whom, with files handed over, the ticket, and the model + reason.
- Closing check (deterministic): a "tests pass / verified" claim with no command run that turn goes back; a "results to follow" without a booked check-back or named handoff goes back; failing acceptance checks go back.
- Acceptance checks: machine-decidable done-when lines (file exists / contains / regex / command succeeds / parts fit) carry checks the daemon runs on your Mac; results on the flow board. **You add checks; Bots cannot write them.** (The organizer may turn a command that actually succeeded into one.)
- A job that goes quiet with tickets open: the app calls the Bot back once, then tells you if nothing moves.
- New endpoints / MCP servers, access outside the workspace, outbound network wait for your approval.
- Window, daemon, sessions, workspace are local; keys in Keychain; models are the endpoints you configure.
- Status: alpha. macOS primary; Windows experimental preview. MIT.

## Never claim
No success rates, speedups, "never fails", "fully autonomous", "secure", cloud, team/multi-user, Linux, built-in models, Bots writing their own checks, a browser tool for Bots. No fake testimonials or logos. The scenario shown is an illustrative re-creation of real features — say so in small type on the end card.

## Assets
No footage. Everything is code-built: UI re-created in HTML from the app's real tokens and component vocabulary (light theme): composer, group chat, presence chips, flow board cards, tickets, checks rows, approval card, system lines. Brand mark (teal speech bubble + white and mustard teammates).

## Brand
- Accent teal `#146a7c` (interaction, selection, "working"); bg `#eef1f2`, pane `#ffffff`, ink `#121c20`, muted `#5f6d74`, line `#e0e6e8`.
- Mustard `#f0ab3d` only in the mark (direction A: never a status colour).
- Status: ok `#16a34a` (passed), danger `#dc2626` (failed), warn `#d97706` (waiting on you), purple `#8b5cf6` (awaiting acceptance).
- Type: SF Pro Display/Text + PingFang SC; SF Mono for commands, times, ticket numbers. Headings 650 weight.

## Format
30.5 s (cut down from ~35 s in review), 1920×1080, 60 fps, H.264 + AAC. Chinese master first (zh), English version from the same timeline (en). Poster frame, contact sheet, editable source.

## Tagline
zh: 交给一组 Bot，盯到交付。 en: Hand it to Bots that see it through.
