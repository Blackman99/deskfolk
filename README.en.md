# Real Bot

> **WIP — Work in progress.** Real Bot currently targets local development and experimentation on macOS, not stable production use. Features, APIs, and data structures may change. Use a separate workspace and back up important data. Implemented foundations and work in progress are distinguished below.

**Organize persistent AI teammates through conversation on your own computer, connect your choice of models and tools, and help them become better at completing tasks.**

[简体中文](README.md) · [Roadmap](ROADMAP.md) · [Development guide](docs/development.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

[![CI](https://github.com/Blackman99/real-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Blackman99/real-bot/actions/workflows/ci.yml)

The detailed roadmap and development guide are currently in Chinese; both READMEs describe the same project scope and limitations.

## Core direction

### 1. Grok Bot-style collaboration, local execution, open models and tools

The collaboration model aligns with the Grok Bot app: Bots are persistent teammates with names, responsibilities, and boundaries. They can use direct messages and groups, mention one another with `@`, and hand work off asynchronously rather than disappearing after each task. In the transcript, `@` mentions of group members render as avatar chips that open that Bot's profile.

Real Bot's window, runtime, conversation data, and shared workspace live on your computer. It does not depend on a project-operated cloud collaboration service. The goal is open access to any model and any MCP (Model Context Protocol) tool, without tying collaboration to a single vendor.

**Currently supported interfaces:** multiple OpenAI-compatible Chat Completions endpoints and tools exposed by stdio / Streamable HTTP MCP servers. Other model APIs require a compatibility layer. Compatibility with individual models and servers still needs verification; this is not a claim that every implementation already works.

**Local execution does not mean fully offline.** Remote models and MCP services may receive prompts, context, file contents, or tool arguments. Local stdio MCP processes may also access the network. Offline operation depends on all configured models and tools being able to run locally.

### 2. Agent-first decisions, task feedback, and reflection (in progress)

The goal is for Bots to decide which model, reasoning effort, tools, and collaborators suit each task, instead of asking users to configure every execution step.

We want a complete task-feedback process: automatically collect task outcomes and user feedback, reflect on the choices and execution of every task, improve model-selection accuracy, and make subsequent similar tasks more efficient.

**Existing foundations:** the application selects models and reasoning effort using message categories, configured model strengths, prices, supported reasoning levels, and collected feedback. Follow-up messages pointing out problems can be recorded as negative feedback on the previous choice. Bots can invoke built-in and enabled MCP tools during a turn.

**Still in progress:** model selection is currently mainly rule-based scoring, not a complete agent-led decision process. Automatic outcome evaluation, structured reflection after every task, experience reuse, and measurement of improvements do not yet form a complete system. These are development goals, not finished self-learning capabilities.

### 3. Let Bots manage the application through conversation

The goal is to make every application operation available through conversation, with the graphical interface available for inspection, intervention, and approval rather than requiring manual setup for every action.

Bots already have tools to:

- Update their own avatar, name, responsibilities, and boundaries.
- Create Bots and groups, and manage group membership.
- Configure model providers, model lists, and MCP servers.
- Message, mention, and hand work to other Bots to move their work forward.

**Complete conversational coverage remains a goal.** Initial setup still requires a workspace, the first model endpoint, and the first Bot. Dangerous actions such as adding endpoints or MCP connections require user approval. Secrets belong in dedicated fields, not chat messages. Autonomous work does not bypass approval, refusal, or Stop.

## Current status

| Area | Existing implementation | Status and limitations |
| --- | --- | --- |
| Local collaboration | macOS desktop window, local daemon, shared workspace, persistent Bots, direct messages, groups, handoffs | Integrated; iteration and end-to-end verification continue |
| Open integrations | Multiple OpenAI-compatible endpoints; stdio / Streamable HTTP MCP tools | Integrated; compatibility depends on the implementation |
| Model decisions and feedback | Rule-based model / reasoning selection and follow-up negative feedback | Early implementation; complete agent decisions and reflection are WIP |
| Conversational management | Bot profiles, Bots / groups, provider / model / MCP configuration, Bot-to-Bot coordination | Main tools integrated; not every application operation is covered |
| Stable release | Development from source | No stable release or supported signed installer; Windows / Linux are not currently supported |

“Integrated” means the implementation exists, not that every model, tool combination, or complete task flow has passed real-world acceptance testing. See the [roadmap](ROADMAP.md).

## Run from source

Requirements: macOS, Node.js `>=22`, pnpm `12.3.4`, Bun `>=1.2`, Rust / Cargo, and the [Tauri macOS prerequisites](https://v2.tauri.app/start/prerequisites/#macos), including Xcode Command Line Tools.

From the project root:

```bash
pnpm install
pnpm dev
```

First use:

1. Create a local directory for the shared workspace and use its absolute path. A directory separate from the source repository is recommended.
2. In settings, provide the workspace, an OpenAI-compatible endpoint URL and API key, and the endpoint's actual supported model names and default model. Enter secrets in the dedicated fields.
3. Create the first Bot from the sidebar with a name, responsibilities, and boundaries, then start a direct conversation.
4. Ask it to create teammates, organize groups, or propose MCP configuration. Review any requested approvals in the application.

An example request, not a guarantee of task success:

> Rename yourself Coordinator and take responsibility for coordinating research and writing. Create Researcher and Writer, and put them in a group called Research. Work together on brief.md in the workspace to produce report.md, contacting each other directly when handing work off.

Closing the window hides it to the tray while background tasks continue. Cmd+Q or the tray's Quit action stops both the window and daemon.

## Development and verification

```bash
pnpm test
pnpm typecheck
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @real-bot/messenger build
```

Source is at [github.com/Blackman99/real-bot](https://github.com/Blackman99/real-bot). Pushes to `main` and pull requests run the checks above (plus the landing-page build). A `v*` tag packages an unsigned macOS snapshot as a draft prerelease; that is not a supported installer. The landing page is published with GitHub Pages. See the [development guide](docs/development.md#ci落地页与快照发布) (Chinese) for workflow details.

| Path | Responsibility |
| --- | --- |
| `apps/daemon` | Bun / TypeScript daemon for the local API, conversations, model calls, and tool execution |
| `apps/messenger` | SvelteKit chat interface |
| `apps/desktop` | Tauri 2 macOS window and runtime supervision |
| `apps/landing` | SvelteKit product manifesto and architecture landing site (static export) |
| `packages/protocol` | Shared TypeScript types and local API contracts |

See the [development guide](docs/development.md) for runtime behavior, hot reload, local interfaces, and data locations, and [CONTEXT.md](CONTEXT.md) for project terminology.

## Security and data

All Bots share the workspace and configured MCP services. **Bots are not permission-isolation boundaries, and the workspace shell is not an operating-system sandbox.** Calls to trusted MCP tools are not individually approved. Configure only trusted services, use test data, and manage external service costs yourself. Approval and Stop cannot undo completed actions. Groups have no Stop control; send a message to ask the Bots to stop.

See [SECURITY.md](SECURITY.md) for security boundaries, storage, and vulnerability reporting.

## Contributing and license

Reproducible bug reports, model / MCP compatibility reports, documentation improvements, and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) first. Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

Real Bot is licensed under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party source notices. Real Bot is an independent project, not affiliated with, sponsored by, or officially partnered with Grok / xAI. Grok Bot is referenced only to describe the collaboration model.
