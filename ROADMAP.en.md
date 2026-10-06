# Roadmap

[简体中文](ROADMAP.md)

> **WIP — this is a direction of work, not a stable-release commitment or a delivery schedule.** The current priority is single-person, local Bot collaboration on macOS. What is already built still needs ongoing verification against real endpoints and in the UI.

## Current focus

Positioning: hand it off, walk away, return to results. Give Bots a multi-day, multi-step job that needs rework and walk away, then come back without wondering whether it quietly stopped, forgot your rules or claimed to be done when it wasn't. The model does the work; the app holds it to account. It is for solo developers, technical individuals and small studios who can set up a model endpoint and API key themselves; one Bot on its own will do, and a team is for work that really splits; a one-off question or a half-hour job is not what it is for.

Time goes to these, in this order, and the first two come before any new feature:

1. **The kernel as the default, then the contraction.** From 2026-10-04 a build takes the data folder to engine level 8 by default: submissions and reviews, external jobs, default models and the ladder, quality events and lessons no longer need turning on by hand. What is left is [ADR 0040](docs/adr/0040-agent-kernel-the-job-owns-state.md)'s P6 contraction: once releases with this default are out and older versions are gone, remove the old paths level 8 no longer takes (the per-turn model pick, chain review, the learning step and so on) along with their tables and columns.
2. **Long jobs as the evidence.** The golden path (`eval:golden-path`, results under Measured in the README) measures only three small jobs, exactly where these guarantees have nothing to do: one Bot finishes as often as a team of three, for much less. Turn ADR 0040's incident fixtures (F-a to F-g) into a second public results table: inject stops, complaints, restarts and rework, and measure whether a stop leaves zero side effects, whether every rule survives, and how often you were interrupted. The golden path is still rerun and compared on every change to the core loop (`eval:golden-path:combine`); jobs that must be checked in a browser get a browser MCP (every landing-page timeout came from that).
3. **A first run narrowed to one kind of job.** Right after the setup wizard, offer "hand it off, close the window, come back tomorrow"; routines make a natural hook for the next day. Proper signing and notarization stay queued (the release workflow is ready and waits for a Developer ID certificate).
4. **Everything around it is in maintenance.** Remote access (screen viewing included), Office previews, annotations, routines, Spend, global search and the split-pane workbench get bug fixes and follow core changes, but no new surface, and investments like remote screen viewing are made more sparingly. Remote access's security review and on-device checks stay queued and don't take time from the core.
5. **"The app asks you" as a number.** How often each job interrupted you, and whether each interruption really needed you, counted as [ADR 0058](docs/adr/0058-the-app-asks-only-when-it-needs-you.md) defines it, in the second results table.

What we don't do stays undone: cloud computers, multiple users, a provider catalogue, Bots as a security boundary.

## 1. Local collaboration and open integration

Groundwork in place:

- Persistent Bots, directs and groups, mentions, participation judgement and asynchronous handoffs; lines sent in a row taken in order, and a line you sent changeable, the Bots going by the new words.
- A local daemon, a shared folder, file tools, shell, approval for dangerous actions, and Stop.
- Multiple OpenAI-compatible Chat Completions endpoints; stdio / Streamable HTTP MCP tools.
- One flow board per job: the groups, directs and Bot↔Bot directs that share a work dir are drawn on the same board by who woke whom, one card per turn, with the files handed over attached to the cards.
- A desktop pane workbench: the main area splits freely across and down, each pane holds a set of tabs, and a tab holds a session (together with its one preview and flow board), a terminal, the routine calendar or the workspace; the arrangement is remembered only on this Mac, and narrow screens and phones still show one screen at a time.
- Your own terminal sessions: held by the daemon, they keep running when the window closes, and after you quit and reopen they come back to the same directory and screen; a command a Bot runs scrolls under its message bubble while it runs and folds into one line when it finishes.
- Daily / weekly routines: wake a Bot at a set time by the local clock of the computer that runs it; the routine calendar lays out every routine in one week view.
- What waits on you is marked on the session list: there is no notifications page; a macOS banner opens straight into that session, the Dock badge counts only what you have not seen and what is still waiting on you, and you can set quiet hours.

Next:

- Verify the full path from the task you put in, through Bots collaborating on their own, to delivered files, both for a team assembled by hand and for a Bot creating its own teammates.
- Keep verifying compatibility, error recovery and collaboration consistency across different models and MCP servers.
- Promise only OpenAI-compatible Chat Completions endpoints, MCP (stdio / Streamable HTTP), and Bots run by the Claude Code you installed and signed in to (Claude Agent, [ADR 0061](docs/adr/0061-claude-agent-runner.md)) for models and tools, with the interface constraints written down; no promise of compatibility with any model or any tool.

## 2. Plans, tickets and done-when: the app holds it to account (main focus of current work)

The model understands, proposes and does the work; only the app's code writes state ([ADR 0040](docs/adr/0040-agent-kernel-the-job-owns-state.md)). From 2026-10-04 a build takes the data folder to engine level 8 by default, so what follows is how the downloaded app behaves; a data folder shared with an older installed app that does not read the version gate stays at a lower level, and there a model is still picked per turn and correction chains are still reviewed afterwards.

Groundwork in place:

- Your words and the requirements ledger ([ADR 0042](docs/adr/0042-requirements-ledger.md)): every line you write is kept word for word, and no Bot can write there; your requirements go into a ledger one by one and are only ever added to, with the database checking that each quote is words you actually wrote. A scribe reads your lines in the background and only proposes patches; changing an entry only creates a replacement waiting for your confirmation, while the old one stays in force. Every turn's situation and the flow board list the same entries.
- Plans, tickets and attribution ([ADR 0043](docs/adr/0043-work-items-and-attribution.md), [ADR 0057](docs/adr/0057-the-job-a-line-is-about-is-read.md)): a job is a plan, with tickets under it that each have a deliverable. A line of yours goes first where it points itself (your pick, an annotation, a quote reply, a path); otherwise a model reads which job it is about; one it cannot place, or that is about none of the open jobs, goes to the Bot it wakes, which opens a new job for it once it actually acts. Artifacts land per ticket in `work/<plan>/<NN-ticket>/`, with `map.md` / `ticket.md` mirrored for Bots to read. The organizer is left with the handoff tidy-up once a plan goes quiet and with compatibility for the older paths.
- Line reading ([ADR 0055](docs/adr/0055-lines-read-by-a-model.md)): whether a line is a stop or a go-on, only asks how things stand, or picks at something already delivered, and whether a Bot's line promises "results to follow" or claims it tested, is read by one short call with no tools; whether a stop is made, something is sent back or a card goes out is still decided by rules. When nothing can read it, the old word lists take over.
- Stops and restarts ([ADR 0041](docs/adr/0041-control-plane-holds-and-restarts.md)): a stop is a record only you can lift, and starting a turn, waking a Bot and every tool call with side effects check it first, with database triggers as a second guard. Restarts are classified by cause, and work that will go on by itself does not bother you.
- Work items, delegation and the end contract ([ADR 0044](docs/adr/0044-delegation-and-end-contract.md)): a Bot runs one segment at a time on a job; handing work to another Bot is a named delegation, with replies and cancellations on record; a segment that says it is still working but ends owing nothing is sent back.
- The supervisor ([ADR 0045](docs/adr/0045-supervisor.md)): one tick every 15 seconds, no model call, and no deadline lost to a restart; it calls back the ball holder of a ticket nobody moves, and picks up interrupted or failed segments where they stopped. Calls with side effects are logged before they run, and one whose outcome is unknown is not repeated.
- Submissions and reviews ([ADR 0046](docs/adr/0046-submissions-and-reviews.md), [ADR 0053](docs/adr/0053-plan-items.md)): a ticket's stage moves only on a submission (with the checks the app runs on it), a review, the supervisor and you. A review rules on each requirement you raised twice or more and each one about the picture, and a pass needs evidence; writing "passed" alone moves nothing. The lead can lay out tickets, who does and who reviews each, and their dependencies in one `plan_items` call.
- External jobs ([ADR 0047](docs/adr/0047-external-jobs.md)): renders a media server accepts are polled by the daemon, the same parameters are not submitted twice within half an hour, and the Bots waiting on a job are woken when it is done.
- Model choice ([ADR 0048](docs/adr/0048-default-models.md), [ADR 0049](docs/adr/0049-capability-filter-and-escalation.md), [ADR 0054](docs/adr/0054-model-ladder-and-in-turn-triggers.md)): the model set on the ticket → the one you pinned → the Bot's default model (the one it used most over the last 7 days) → the endpoint's default, with each turn recording which, on its card in the flow board; work that needs to see images skips models marked as unable to (unless pinned). When submissions keep failing or a turn keeps erring, the job thinks one level harder first, and once thinking is maxed and submissions still fail, it climbs the ladder of models you order (a pinned model or one set on the ticket stays put).
- Quality events and lessons ([ADR 0050](docs/adr/0050-quality-events-and-lessons.md), [ADR 0051](docs/adr/0051-narrowed-reflection.md)): what goes wrong is filed by the kind of event, without asking a model whether the model fell short and without writing those events into memory. A command like a recursive search that runs into its timeout gets a warning and then a block from the app before the call; after a wrongful approval or a capability ceiling, the Bot involved may propose one checklist item or one check, which takes effect only when you adopt it. You can share one Bot's skill with every Bot ([ADR 0052](docs/adr/0052-project-skills.md)). Once a job you accepted is delivered, the Bots that made it hold a retrospective ([ADR 0062](docs/adr/0062-retrospective-after-delivery.md)): they find where they tripped up and which of their ways made you send work back, and correct, merge and add to their own memories and skills — posting nothing, asking you nothing, every change undoable on the board.
- Acceptance checks and the closing check ([ADR 0036](docs/adr/0036-acceptance-checks-run-by-the-daemon.md), [ADR 0037](docs/adr/0037-cut-the-core-loop-by-the-benchmark.md)): lines of the done-when that a machine can decide carry a check (a file exists, contains, matches a regex, a command's exit code and output, whether the parts several Bots made fit together) that the daemon runs on your Mac, with the result on the flow board; you add, edit and remove them, the organizer may only add and change its own, and Bots cannot write them. Before a deliverable is sent to you it is checked once with no model call: are the checks passing, is a "results to follow" backed by a check-back or a named handoff, is a "tested" backed by a command this turn ran; if not, it goes back once.
- The app asks you only when it needs you ([ADR 0058](docs/adr/0058-the-app-asks-only-when-it-needs-you.md)): cards and "waiting on you" notifications go out only for your approval, for something only you can give, or when the app has stopped and will not go on by itself; nothing goes out for what it settled for you and you can change any time, what you just said, or what it will carry on with by itself.
- Status questions: a line that only asks how things stand is answered by the app from the plan, tickets, live turns and checks, with no model call and without waking or redirecting a Bot; if nobody is on it, it says so and calls nobody back.
- Check-back: a Bot books itself a one-off wake (5 minutes to 7 days out, at most 6 an hour per piece of work); when it is due, the Bot is woken by its own note in the same job to check whether the work it handed off has come back; a stop suspends it, and a job the daemon is already polling needs none.
- Cross-session memory: a Bot uses a tool to write down facts that still hold across sessions; every enabled memory goes into the context of each of its steps, and other Bots cannot see them. There is no retrieval and no distilling of transcripts in the background; a retrospective changes memories only after a job you accepted is delivered, from that job's record; when memory is full, writing returns an error and the Bot decides what to keep. In the Bot's settings you can see where each memory came from and when, and edit, disable or delete it.

Goals being built:

- **Contraction (P6):** once releases with level 8 as the default are out and older versions are gone, remove the old paths level 8 no longer takes (the per-turn model pick, chain review, the learning step, the plan call-back) along with their tables and columns.
- **Measuring long jobs:** turn the incident fixtures into a second public results table (see step 2 of Current focus), together with how often each job interrupted you.
- **Evaluation:** the goal-coverage evaluation (`eval:goal-coverage`) holds the plan's goal and done-when against the files handed over, and has a judge model rate each item covered / partial / missing; the golden-path benchmark (`eval:golden-path`) checks each item against the task set's fixed done-when, plus deterministic checks on the delivered files, their content and commands, and counts the completion rate and human interventions. The table in the README was measured on 2026-09-29, before the kernel landed, and is to be measured again at the level-8 default.

Your words, requirements, quality events and lessons are kept on this Mac; the turns themselves, and the line-reading, scribe, reflection, retrospective and image-judging check calls, send the relevant messages to the endpoints you configure, and follow the data boundaries of the models and tools you choose.

## 3. Managing the app itself through conversation

Groundwork in place:

- Bots change their own avatar, name, duties, boundaries and skills.
- Bots create other Bots, create groups and manage their members.
- Bots manage providers, model lists and MCP servers; dangerous configuration needs the user's approval.
- Bots send messages, mention and hand off, and actively move other Bots' work forward.

Next:

- Gradually cover every app operation, and make clear which operations still need the graphical interface and what first-time setup requires.
- Verify that configuration updates take effect consistently in the current turn, for other Bots, and in directs, groups and routines.
- As the range of autonomous operations widens, keep user approval, denial, Stop, key entry and execution records; autonomy does not mean permissions loosen automatically.

## 4. Remote access (experimental, off by default)

Groundwork in place:

- A self-hosted Bun relay: one-time bootstrap and per-device outbound links; it only forwards opaque Noise traffic, and its logs record only metadata.
- Noise IK end-to-end encryption and WebAuthn identity; the one-time pairing payload pins the host's public key, and the relay is the same one that serves the hosted page; the hosted messenger PWA uses the same set of methods as the Local API, and the hosted production bundle contains no local discovery and no loopback bearer.
- Sessions, the workspace, terminals and files on the phone: after a disconnect it reconnects on its own with backoff, and back in the foreground it fetches only what changed in the meantime; pictures arrive first as scaled-down copies; the "Files" session sends files from the phone into the workspace `inbox/` without waking a Bot.
- Optional Web Push sends only generic reminders that something is waiting, goes out from the Mac, and when opened only brings you back to the session list; it never approves anything.
- Everyday features and Web Push work end to end in Chrome on a real Android device (from source, with the development switch).
- The installed app registers with a relay and pairs devices: remote credentials live in a private file in the data folder, and the window approves each device with Touch ID (ADR 0033).
- Seeing and operating the Mac's screen from the phone (off by default, turned on at the Mac): through macOS's own Screen Sharing, lock screen included; WebRTC directly when it can connect, via the relay when it cannot ([ADR 0056](docs/adr/0056-remote-screen.md)). The local end-to-end check passes; a direct connection from a real phone on cellular, the real Screen Sharing, and iOS Safari are not yet accepted. On Windows it uses a VNC server the user installs (TightVNC), and remote access itself is wired up there too, approving devices with Windows Hello ([ADR 0059](docs/adr/0059-windows-remote-access-and-screen.md)); neither has been tried on a real PC.

Next:

- Pass, item by item: the independent security review (S-rev), home-screen WebAuthn on a real device (G-uv), iOS L1 on a real device, and iOS home-screen Web Push (G-push).
- Packaging gate (G-pack): a sealed daemon runtime and proper signing, so remote credentials can move from the file into a dedicated Keychain access group.
- Until these checks pass, public pairing stays off, and remote control is not publicly promised as a working feature.

For the steps to deploy the relay, connect the Mac and pair a phone, see the [remote access guide](docs/remote-access.md).

## Current product boundaries

- Local, single-person use; not a multi-user SaaS, and not a cloud virtual machine.
- Bots share the workspace and tools; there is no permission isolation between Bots.
- Running and verification currently target macOS first. Windows is an experimental preview, without the independent runtime, in-app update install or desktop notifications yet, and with remote access not yet tried on a real PC; there is no delivery commitment for Linux or signed installers.
- Remote access is an experimental prototype, off by default; there is no cloud relay run by the project.
- There is no commitment yet to a stable API, database compatibility or production readiness.

To contribute, start with [CONTRIBUTING.md](CONTRIBUTING.md); for how to use it today, see [README.md](README.md).
