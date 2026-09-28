# Roadmap

[简体中文](ROADMAP.md)

> **WIP — this is a direction of work, not a stable-release commitment or a delivery schedule.** The current priority is single-person, local Bot collaboration on macOS. What is already built still needs ongoing verification against real endpoints and in the UI.

## Current focus

Positioning: "Hand it to Bots that see it through", a team of Bots that sees one job through to delivery. It is for solo developers, technical individuals and small studios who can set up a model endpoint and API key themselves, with a job that needs a few roles and several file-producing steps: a research report, a launch kit, a small tool with tests and a start command.

Time goes to these, in this order:

1. **How often the core loop finishes.** Run a fixed set of tasks on the golden path (both ways of forming a team: you create the Bots, or a Coordinator hires them), judge every finished job requirement by requirement with the goal-coverage eval, and count the completion rate and how often each job needed you (approvals, answers, stalls reported to you). The runner exists: `eval:golden-path` runs three fixed jobs (a research report, launch copy with a landing page, a small tool with tests) × both ways of forming a team, plus one generalist Bot on its own as a control (does a team beat one Bot with the same model?), each in an isolated runtime until it settles, then judges completion with the judge model plus deterministic checks; `--ablate` switches off one side-call at a time to see what each is worth; it has not been run on a real model for a baseline yet. Until those numbers exist, "sees the job through" is described by its mechanisms, not promised as a result; once they do, they go into the README and the website, and every change to the core loop is run against them again.
2. **The first run.** Proper signing and notarization (the release workflow is ready and waits for a Developer ID certificate), and the path from the setup wizard to the first delivered job.
3. **Everything around it is in maintenance.** Remote access, Office previews, annotations, routines, Spend, global search and the split-pane workbench get bug fixes and follow core changes, but no new surface. Remote access's security review and on-device checks stay queued and don't take time from the core loop.

## 1. Local collaboration and open integration

Groundwork in place:

- Persistent Bots, directs and groups, mentions, participation judgement and asynchronous handoffs.
- A local daemon, a shared folder, file tools, shell, approval for dangerous actions, and Stop.
- Multiple OpenAI-compatible Chat Completions endpoints; stdio / Streamable HTTP MCP tools.
- One flow board per job: the groups, directs and Bot↔Bot directs that share a work dir are drawn on the same board by who woke whom, one card per turn, with the files handed over attached to the cards.
- A desktop pane workbench: the main area splits freely across and down, each pane holds a set of tabs, and a tab holds a session (together with its one preview and flow board), a terminal, the routine calendar or the workspace; the arrangement is remembered only on this Mac, and narrow screens and phones still show one screen at a time.
- Your own terminal sessions: held by the daemon, they keep running when the window closes, and after you quit and reopen they come back to the same directory and screen; a command a Bot runs scrolls under its message bubble while it runs and folds into one line when it finishes.
- Daily / weekly routines: wake a Bot at a set time by the local clock of the Mac that runs it; the routine calendar lays out every routine in one week view.
- What waits on you is marked on the session list: there is no notifications page; a macOS banner opens straight into that session, the Dock badge counts only what you have not seen and what is still waiting on you, and you can set quiet hours.

Next:

- Verify the full path from the task you put in, through Bots collaborating on their own, to delivered files, both for a team assembled by hand and for a Bot creating its own teammates.
- Keep verifying compatibility, error recovery and collaboration consistency across different models and MCP servers.
- Keep model and tool integration open and document the interface constraints; "any model / tool" is a direction, not a current compatibility guarantee for every implementation.

## 2. Agent-first decisions and task feedback (main focus of current work)

Groundwork in place:

- An agent picks the model and thinking level before a turn opens: it looks at the message, the Bot's profile, the candidate list and this Bot's recent review conclusions, and answers with a model, a thinking level and a one-line reason. It always runs on the default endpoint's default model, to avoid recursion; if it gives no answer, times out or names something that does not exist, it falls back to rules, without retrying and without holding up the user. When a Bot has its model and thinking level pinned, this step is skipped.
- Every follow-up line from the user is kept verbatim for review, not filtered by keywords: it lands on the turn it quotes, on the latest turn of the Bot it `@`s, or on the latest visible turn in the session; several turns about the same thing count as one correction chain.
- When a correction chain ends, it is reviewed once: the review judges whether the model fell short, the task itself was hard, or the request was unclear, plus which way to adjust (stronger / lighter / faster / cheaper), how many rounds of correction it took, and how confident it is. A turn with no follow-up is also reviewed once if the endpoint refused it, its reply was incomplete, or it had at least two tool errors. Only a verdict that the model fell short, with enough confidence, is kept as this Bot's experience; model routing reads it directly next time, together with the message and category it came from, and one that does not match is not taken as a lesson for the current message. What is kept is a conclusion, not a score — there are no weights, offsets or caps; once a conclusion has been followed twice without things coming out any cleaner, it leaves the routing window, and the record stays. Experience belongs to the Bot itself, and deleting the Bot deletes it too.
- What each turn chose, how it ended (completed, endpoint refused, incomplete reply, Stop, redirected, interrupted) and what feedback it got are all recorded and can be viewed per session through the Local API; in the messenger they sit on that turn's card on the flow board: the bottom line of the card shows the model, thinking level and category, opening the card shows the reason, feedback, review and any experience kept, the toolbar can light up turns that got feedback or were blamed on the model, and clicking a piece of feedback jumps back to the words it came from.
- Bots call the available tools within a turn, and move other Bots' work forward through handoffs.
- Plans, tickets and the organizer: the app itself organizes the job a session is working on into a plan (Kind, Goal, Done when, Rules, Process, Progress, Status) and tickets (the smallest unit with a deliverable, carrying a status, who is on it, and artifacts). Each message you send first goes through the organizer (default model, no tools), which files it under a plan and ticket, and only then does the turn open; once the plan goes quiet, the organizer runs once more and attributes what was delivered to its tickets. Every turn's situation includes the plan, the ticket list, this turn's ticket and precedents of the same kind, and so does a handoff to another Bot or another session, or a wake from a check-back; the request that opened the plan is kept separately, word for word. Artifacts land per ticket in `work/<plan>/<NN-ticket>/`, with `map.md` / `ticket.md` mirrored for Bots to read. No clock splits the work: switching to another job, going back to an earlier one, finishing and parking are all decided by the organizer. The first turn is marked, so the Bot first aligns on whatever was left unclear before it starts. Judgement and input suggestions can see the plan and tickets too.
- Check-back: a Bot books itself a one-off wake (one minute to seven days out); when it is due, the Bot is woken by its own note in the same session and the same job, to check whether the work it handed off has come back; a session holds only one at a time, and Stop, clearing or deleting cancels it.
- Learning from unclear requests too: when a review judges "the request was unclear" and the user corrected it over more than one round, the learning step can record one preference the user filled in (the form of the deliverable, the scope, who it is for, defaults); it writes only to memory and does not change skills.
- Closing check: before a deliverable is sent to you, the daemon makes one short tool-less call that holds this turn's ticket and the plan's Done when against the files already handed over and this wrap-up, and sends any requirement that was neither delivered nor accounted for in the wrap-up back to the Bot once; once the Bot fills it in or says what became of it, the next send goes through. A turn is checked only once; it is not a gate, and a send-back does not count as a tool error.
- Cross-session memory: a Bot uses a tool to write down facts that still hold across sessions; every enabled memory goes into the context of each of its steps, and other Bots cannot see them. There is no retrieval and no background distillation; when memory is full, writing returns an error and the Bot decides what to keep. In the Bot's settings you can see where each memory came from and when, and edit, disable or delete it.

Goals being built:

- **Scope of autonomous choice:** today the agent decides only the model and thinking level. For tools and ways of collaborating, the model is still handed the whole toolset to pick from within the turn; they are not settled before the turn opens.
- **Automatic collection:** when a turn ends, the app records its step count, tool calls, tool errors, repeated failing calls and the number of files written. The review reads these numbers and reads a blank one as unknown. The line that carries across sessions is still written by the Bot: after a chain ends there is one learning step whose only tools are remember, forget and edit an existing skill; if it calls none, nothing is written, and it leaves no line in the transcript. A single incident is written as a memory; no new skill is made from that one instance.
- **Reuse and evaluation:** model routing also reads this Bot's latest cleanly finished examples. Whether a conclusion was followed, whether corrections went down, and whether the same kind of task got shorter after something was recorded are all counted from rows that already exist, and written onto the model choice log and onto the Bot's memory and skill rows. The point is to keep the evidence, not to take the reflection text itself as progress. The goal-coverage evaluation script (`eval:goal-coverage`) holds the plan's Goal and Done when (the original request when there is no plan yet) against the files handed over and the Bot's wrap-up, and has a judge model rate each item covered / partial / missing. The golden-path benchmark (`eval:golden-path`) wires it into the golden path: it checks the artifacts item by item against the task set's fixed goal and Done when, plus whether the deliverables exist, content checks and commands the script runs itself after the team is done, and counts the completion rate and human interventions; the next step is a baseline on a real model, published.

Feedback and experience are managed on this Mac first; routing and review calls send the relevant messages to the endpoints you configure, and follow the data boundaries of the models and tools you choose.

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

Next:

- Pass, item by item: the independent security review (S-rev), home-screen WebAuthn on a real device (G-uv), iOS L1 on a real device, and iOS home-screen Web Push (G-push).
- Packaging gate (G-pack): a sealed daemon runtime and proper signing, so remote credentials can move from the file into a dedicated Keychain access group.
- Until these checks pass, public pairing stays off, and remote control is not publicly promised as a working feature.

For the steps to deploy the relay, connect the Mac and pair a phone, see the [remote access guide](docs/remote-access.md).

## Current product boundaries

- Local, single-person use; not a multi-user SaaS, and not a cloud virtual machine.
- Bots share the workspace and tools; there is no permission isolation between Bots.
- Running and verification currently target macOS; there is no delivery commitment for cross-platform support or signed installers.
- Remote access is an experimental prototype, off by default; there is no cloud relay run by the project.
- There is no commitment yet to a stable API, database compatibility or production readiness.

To contribute, start with [CONTRIBUTING.md](CONTRIBUTING.md); for how to use it today, see [README.md](README.md).
