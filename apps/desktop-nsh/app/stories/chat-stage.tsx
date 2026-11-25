/**
 * The conversation's bodies on the fixture runtime: `ChatStage` on Writer's direct (the seeded
 * lines, one with Markdown), the group 周报小组, an empty scratch group (the welcome) and a scratch
 * group the story fills with enough lines to scroll and to page (`story-bulk`: 130 lines, past the 100 a conversation opens with;
 * `story-cleanup` deletes it); `BotDmDialog` on a Bot↔Bot direct and `ProjectChat` on a project
 * session, both synthetic (the runtime makes neither without a real agent): they are laid over the
 * runtime's snapshot like `chat-composer-2` does, and what would go to the daemon for them
 * (`send`, `tuneProjectSession`, the run's answer and stop, a project card's status) is answered here and
 * logged under `said`, and its agent's `/` list (`projectCommands`) a moment after it is asked; `story-annotated` adds a batch of annotations you sent in the project session.
 * `story-draft-switch` changes the open conversation's draft and opens the group in the same turn.
 * Lines go in through `runtime.client` into the scratch group only: one posted into the fixture's
 * Writer direct would start a turn there and leave it unfinished for every later test.
 */
import { computed, Scroll, signal, Text, View } from "nsh";
import { USER_MEMBER, type AgentRun, type AgentsStatusResponse, type AgentTaskDetail, type Annotation, type Bot, type ClaudeCodeCommand, type ClaudeCodeStatus, type DelegationView, type Message, type ProjectConsultSetting, type ProjectContextUsage, type SessionSummary } from "@real-bot/protocol";
import { classifySession, youBotPeer } from "../src/m/sidebar/session-groups";
import { ApiBase } from "../src/m/api-base.ts";
import { LocalApi } from "../src/m/local-api.ts";
import { forgetClaudeOptions } from "../src/m/chat/project-agent-options.svelte";
import { deep } from "../src/lib/reactive";
import { runtime } from "../src/runtime";
import { BotDmDialog } from "../src/ui/chat/BotDmDialog";
import { ChatStage } from "../src/ui/chat/ChatStage";
import { ProjectChat } from "../src/ui/chat/ProjectChat";
import { PaneMenu } from "../src/ui/workbench/pane-menu";
import { fakeReadFiles } from "./fake-files";

type Which = "direct" | "group" | "empty" | "bulk" | "project" | "none";
const which = signal<Which>("direct");
const scratch = signal<{ empty: string; bulk: string }>({ empty: "", bulk: "" });
const said = signal("—");
const busy = signal(false);
/** How many lines the story has posted into its scratch group so far. */
const posted = signal(0);
const popup = signal(false);
const runOn = signal<"" | "running" | "approval" | "plan" | "asking">("");
/**
 * The agent's questions in the project session: `story-ask` puts up one its run waits on and one it
 * no longer does, `story-ask-many` three it asks at once (pick one, pick any, words only); the ids
 * the run waits on, and what you answered.
 */
const asked = signal(false);
const askedMany = signal(false);
const runAsks = signal<string[]>([]);
const askAnswers = signal<Record<string, { selected: string[]; custom: string | null }>>({});
const MANY = ["pj-ask-many-1", "pj-ask-many-2", "pj-ask-many-3"];
/** A question whose next answer the daemon refuses (`story-ask-refuse`). */
const refuseAsk = signal<string | null>(null);
/** The running run's first subagent has ended. */
const subagentDone = signal(false);
/** The run has asked Codex for its view (ADR 0116): a consultant's task among the subagents (`story-consult`). */
const consulted = signal(false);
const planMode = signal(false);
/** The composer's consultant switch (ADR 0116 addendum): what the story's session holds, as the daemon would store it. */
const consultSetting = signal<ProjectConsultSetting | null>(null);
const projectContext = signal<ProjectContextUsage | null>(null);
/** The project session's agent: Claude Code, or another whose composer the caps shape (`story-agent-*`). */
const projectAgent = signal<"claude_code" | "codex" | "grok">("claude_code");
const projectLines = signal<Message[]>([]);
const projectEmpty = signal(false);
/** The batch of annotations in the project session (ADR 0095 decision 28), and each card's status. */
const annotated = signal(false);
const annotationStatus = signal<Record<string, "open" | "resolved">>({ "pa-1": "open", "pa-2": "open" });

const PROJECT_ID = "project-story";
const BOTDM_ID = "botdm-story";
const D1 = "2026-10-19T09:30:00.000Z";
const D2 = "2026-10-20T09:30:00.000Z";

/** The runtime's snapshot with the story's synthetic sessions, their lines, the run going and the delegations. */
const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(runtime), "snapshot")!;
const real = descriptor.get!;

const botsC = computed((): Bot[] => real.call(runtime).bots);
const bots = () => botsC();
const writerBotC = computed(() => botsC().find((b) => b.name === "Writer"));
const editorBotC = computed(() => botsC().find((b) => b.name === "Editor"));
const writerBot = () => writerBotC();
const editorBot = () => editorBotC();
const realSessionsC = computed((): SessionSummary[] => real.call(runtime).sessions);
const realSessions = () => realSessionsC();
const writerDirectC = computed(() => {
  const w = writerBotC()?.id;
  return realSessionsC().find((s) => classifySession(s) === "you-bot" && youBotPeer(s) === w);
});
const writerDirect = () => writerDirectC();

function line(over: Partial<Message> & { id: string; session_id: string }): Message {
  return { turn_id: null, parent_id: null, kind: "user", author: USER_MEMBER, body: "", source_turn_id: null, created_at: D2, attachments: [], reactions: [], ...over } as Message;
}

function botDmSession(): SessionSummary | null {
  const base = writerDirect();
  const w = writerBot();
  const e = editorBot();
  if (!base || !w || !e) return null;
  return {
    ...base,
    id: BOTDM_ID,
    name: null,
    origin_session_id: base.id,
    participants: [
      { member: w.id, joined_at: D1, left_at: null },
      { member: e.id, joined_at: D1, left_at: null },
    ],
  } as unknown as SessionSummary;
}

function projectSession(): SessionSummary | null {
  const base = realSessions().find((s) => classifySession(s) === "group");
  return base
    ? ({ ...base, id: PROJECT_ID, kind: "project", name: "Deskfolk", project_dir: "/Users/dev/my-projects/real-bot", project_agent: projectAgent(), project_mode: planMode() ? "plan" : null, project_consult: consultSetting(), project_context: projectContext() } as unknown as SessionSummary)
    : null;
}

function botDmLines(): Message[] {
  const w = writerBot();
  const e = editorBot();
  if (!w || !e) return [];
  return [
    line({ id: "dm-1", session_id: BOTDM_ID, kind: "bot", author: w.id, body: "Editor，帮我看一下这份周报的措辞。", created_at: D2 }),
    line({ id: "dm-2", session_id: BOTDM_ID, kind: "bot", author: e.id, body: "看完了：第二段太长，建议拆成两条。", created_at: "2026-10-20T09:31:00.000Z" }),
  ];
}

const DELEGATION = (): DelegationView[] => {
  const w = writerBot();
  const e = editorBot();
  return w && e
    ? [
        {
          id: "deleg-1",
          task_id: "task-1",
          ticket_id: null,
          thread_session_id: BOTDM_ID,
          from_bot_id: w.id,
          to_bot_id: e.id,
          ask: "审一下周报的措辞",
          expects: "review",
          status: "open",
          part_keys: [],
          requirement_ids: [],
          created_at: D2,
          request_message_id: null,
          result_message_id: null,
          reply: null,
          wait: { state: "waiting", since: D2, due_at: null },
        } as DelegationView,
      ]
    : [];
};

/** As the runtime's store holds it: a deep proxy, whose arrays a component must copy before its `Each` draws them. */
const README_CHOICES: NonNullable<Message["ask"]> = { options: [{ label: "根目录" }, { label: "docs 目录", description: "docs/README.md" }], multi_select: false };

function askLine(id: string, body: string, at: string, ask: Message["ask"] = README_CHOICES): Message {
  const answer = askAnswers()[id];
  return deep(line({
    id,
    session_id: PROJECT_ID,
    kind: "ask",
    author: "claude-code",
    body,
    created_at: at,
    ask,
    ask_answer: answer ? { ...answer, answered_at: D2 } : null,
  }));
}

const STOPPED_AT = [
  "Antigravity 没先问就做了下面这一步（权限模式要求先问你），这一轮停在这里；那一步可能已经执行了：",
  "cd /Users/dev/my-projects/real-bot/.wt/web-test && git cherry-pick b2db52f && pnpm exec tsc --noEmit && rm -rf .next && COMMIT=$(git rev-parse --short=7 HEAD) && tar --exclude='node_modules' -czf \"/tmp/web-test-${COMMIT}.tar.gz\" .next package.json && python3 -c '",
  "import pathlib",
  "out = pathlib.Path(\"/Users/dev/.gemini/antigravity-cli/brain/session-1/scratch/deploy-remote.sh\")",
  "out.write_text(\"echo deploy\")",
  "'",
].join("\n");

function projectBase(): Message[] {
  if (projectEmpty()) return [];
  return [
    line({ id: "pj-1", session_id: PROJECT_ID, body: "把 README 的安装一节改短", created_at: D1 }),
    line({ id: "pj-2", session_id: PROJECT_ID, kind: "bot", author: "claude-code", body: "好的，我看了 README：\n\n- 安装一节有 **三段**\n- 可以合成一段\n\n改好后告诉你。", created_at: "2026-10-19T09:31:00.000Z" }),
    line({ id: "pj-3", session_id: PROJECT_ID, kind: "system", author: "app", body: "已切到新的一天", created_at: D2 }),
    // A turn stopped at a long command it ran without asking: the words, then the command whole.
    line({ id: "pj-3-stop", session_id: PROJECT_ID, kind: "system", author: "app", body: STOPPED_AT, created_at: D2 }),
    line({ id: "pj-4", session_id: PROJECT_ID, body: "再看一下测试", created_at: "2026-10-20T09:31:00.000Z" }),
    ...(annotated() ? [line({ id: "pj-5", session_id: PROJECT_ID, body: "按这两条改", created_at: "2026-10-20T09:33:00.000Z" })] : []),
    ...(asked()
      ? [
          askLine("pj-ask-open", "要改哪一份 README？", "2026-10-20T09:34:00.000Z"),
          askLine("pj-ask-ended", "测试跑哪一组？", "2026-10-20T09:32:30.000Z"),
        ]
      : []),
    // One call's questions land within the same moment.
    ...(askedMany()
      ? [
          askLine(MANY[0]!, "先改哪一份 README？", "2026-10-20T09:35:00.000Z"),
          askLine(MANY[1]!, "改完要跑哪些检查？", "2026-10-20T09:35:00.001Z", {
            options: [{ label: "单元测试", description: "bun test" }, { label: "类型检查" }, { label: "截图对比", description: "要几分钟" }],
            multi_select: true,
          }),
          askLine(MANY[2]!, "还有什么要注意的？", "2026-10-20T09:35:00.002Z", null),
        ]
      : []),
    ...projectLines(),
  ];
}

const PROJECT_FILE = "/Users/dev/my-projects/real-bot/src/a.ts";

function projectAnnotations(): Annotation[] {
  if (!annotated()) return [];
  const row = (id: string, body: string, line: number): Annotation => ({
    id,
    status: annotationStatus()[id] ?? "open",
    relpath: PROJECT_FILE,
    file_key: PROJECT_FILE,
    anchor_kind: "text_range",
    anchor: { start_line: line, start_col: 1, end_line: line, end_col: 13, quote: "const b = 2;", prefix: "", suffix: "" },
    content_sha256: "0".repeat(64),
    target_message_id: "pj-2",
    target_session_id: PROJECT_ID,
    target_turn_id: null,
    bot_id: null,
    session_id: PROJECT_ID,
    message_id: "pj-5",
    body,
    crop_mime: null,
    resolved_by: annotationStatus()[id] === "resolved" ? USER_MEMBER : null,
    resolved_note: null,
    resolved_at: null,
    created_at: D2,
    updated_at: D2,
    stale: null,
  });
  return [row("pa-1", "这里改成 let", 2), row("pa-2", "第二行也看看", 3)];
}

/** What the running run has going, after the agent's last line: two subagents, and two commands of its own. */
function runTasks(): AgentRun["tasks"] {
  const task = (id: string, kind: string, status: string, description: string, at: string) =>
    ({ id, kind, status, description, agent_type: kind === "subagent" ? "Explore" : null, tool_use_id: `toolu-${id}`, command: kind === "shell" ? description : null, summary: null, output_file: null, tool_uses: null, tokens: null, activity: null, started_at: at, ended_at: status === "running" ? null : at });
  return [
    task("sub-a", "subagent", subagentDone() ? "completed" : "running", "查登录测试", "2026-10-20T09:32:10.000Z"),
    task("sub-b", "subagent", "running", "读 CHANGELOG", "2026-10-20T09:32:11.000Z"),
    task("cmd-a", "shell", "completed", "bun test src/login.test.ts", "2026-10-20T09:32:12.000Z"),
    task("cmd-b", "shell", "running", "pnpm dev", "2026-10-20T09:32:13.000Z"),
    ...(consulted()
      ? [{ ...task("consult_c-1", "subagent", "running", "这个迁移的回滚顺序对不对", "2026-10-20T09:32:14.000Z"), agent_type: "Codex", agent: "codex", model: "gpt-5.6-terra" }]
      : []),
  ] as unknown as AgentRun["tasks"];
}

/** What the agent said before it asked: the working bubble shows it while the run waits on the questions. */
const ASKING_SAID = "我看了一下：\n\n- 根目录的 README 有安装、配置、发布三节\n- docs/README.md 只讲本地开发\n\n两份都提到了安装，先确认几件事。";

function projectRun(): AgentRun | null {
  const mode = runOn();
  if (!mode) return null;
  return {
    ...(mode === "running" ? { tasks: runTasks() } : {}),
    id: "run-story",
    session_id: PROJECT_ID,
    status: mode === "running" ? "running" : "waiting_approval",
    asks: mode === "asking" ? runAsks().filter((id) => !askAnswers()[id]) : undefined,
    activity: mode === "running" ? "Bash npm test" : null,
    partial: mode === "running" ? "我先跑一遍测试，看哪些用例挂了" : mode === "asking" ? ASKING_SAID : null,
    approval: mode === "approval" ? { kind_key: "bash", target: "npm test", summary: "Bash: rm -rf dist && npm test" } : mode === "plan" ? { kind_key: "plan", target: "plan.md", summary: "## 计划\n\n1. 合并安装三段\n2. 跑测试" } : null,
    error: null,
    created_at: "2026-10-20T09:32:00.000Z",
    updated_at: "2026-10-20T09:32:00.000Z",
  } as AgentRun;
}

/** The overlay is computed once per change of what it reads: every component reads the snapshot many times a frame. */
const overlaid = computed(() => {
  const snap = real.call(runtime);
  const dm = botDmSession();
  const project = projectSession();
  const run = projectRun();
  const out = {
    ...snap,
    sessions: [...snap.sessions, ...(dm ? [dm] : []), ...(project ? [project] : [])],
    messages: [...snap.messages, ...(dm ? botDmLines() : []), ...(project ? projectBase() : [])],
    delegations: [...snap.delegations, ...DELEGATION()],
    agentRuns: run ? { ...snap.agentRuns, [PROJECT_ID]: run } : snap.agentRuns,
    annotations: [...snap.annotations, ...projectAnnotations()],
  };
  return out;
});

Object.defineProperty(runtime, "snapshot", {
  configurable: true,
  // The runtime writes back what it read (`snapshot = { ...snapshot, … }`): the story's own rows must not
  // become part of the real one, or each event would add them again.
  set(value: ReturnType<typeof real>) {
    const own = new Set([BOTDM_ID, PROJECT_ID]);
    const { [PROJECT_ID]: _run, ...runs } = (value.agentRuns ?? {}) as Record<string, unknown>;
    descriptor.set!.call(runtime, {
      ...value,
      sessions: value.sessions.filter((row: SessionSummary) => !own.has(row.id)),
      messages: value.messages.filter((row: Message) => !own.has(row.session_id)),
      delegations: value.delegations.filter((row: DelegationView) => row.id !== "deleg-1"),
      agentRuns: runs,
      annotations: value.annotations.filter((row: Annotation) => row.session_id !== PROJECT_ID),
    });
  },
  get: () => overlaid(),
});

// What would go to the daemon for the project session is answered here: a line joins the lines, the tuning
// switches plan mode, the run is answered or stopped.
const proto = Object.getPrototypeOf(runtime) as Record<string, (...args: unknown[]) => unknown>;
const realSend = proto.send!;
proto.send = function (this: unknown, ...args: unknown[]) {
  const opts = args[0] as { sessionId?: string } | undefined;
  if (opts?.sessionId !== PROJECT_ID) return realSend.apply(this, args);
  const draft = runtime.sessionView(PROJECT_ID).draft;
  projectLines.set([...projectLines(), line({ id: `pj-sent-${projectLines().length}`, session_id: PROJECT_ID, body: draft, created_at: new Date().toISOString() })]);
  runtime.sessionView(PROJECT_ID).draft = "";
  said.set(`sent:${draft}`);
  return Promise.resolve(true);
};
proto.tuneProjectSession = function (_id: unknown, change: unknown) {
  const mode = (change as { mode?: string | null }).mode;
  if (mode !== undefined) planMode.set(mode === "plan");
  const consult = (change as { consult?: ProjectConsultSetting | null }).consult;
  if (consult !== undefined) consultSetting.set(consult);
  said.set(`tune:${JSON.stringify(change)}`);
  return Promise.resolve(null);
};
proto.answerAgentRun = function (_id: unknown, allow: unknown) {
  said.set(`answer:${allow ? "allow" : "deny"}`);
  runOn.set("");
  return Promise.resolve(null);
};
proto.stopAgentRun = function () {
  said.set("stop");
  runOn.set("");
  return Promise.resolve(null);
};
proto.loadProjectRun = () => Promise.resolve();
// Only you mark a project session's annotation handled; the story keeps the status here.
const realPatchAnnotation = proto.patchAnnotation!;
proto.patchAnnotation = function (this: unknown, ...args: unknown[]) {
  const [id, patch] = args as [string, { status?: "open" | "resolved" }];
  if (id !== "pa-1" && id !== "pa-2") return realPatchAnnotation.apply(this, args);
  if (patch.status) annotationStatus.set({ ...annotationStatus(), [id]: patch.status });
  said.set(`annotation:${id}:${patch.status ?? ""}`);
  return Promise.resolve(null);
};
// The agent's / list for the project session, a moment after it is asked as the daemon answers it: one command
// takes nothing, one free text, two have choices in their hints (as Claude Code writes /advisor's and /fast's).
const PROJECT_COMMANDS: ClaudeCodeCommand[] = [
  { name: "compact", description: "Free up context by summarizing the conversation so far", argument_hint: "<optional custom summarization instructions>", aliases: [] },
  { name: "advisor", description: "Let Claude consult a stronger model at key moments", argument_hint: "[fable|opus|sonnet|off]", aliases: [] },
  { name: "fast", description: "Toggle fast mode", argument_hint: "[on|off]", aliases: [] },
  { name: "review", description: "Review a pull request", argument_hint: "<pr>", aliases: [] },
];
const api = ApiBase.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
// A project question's answer goes to the daemon's answer endpoint, as a Bot's does; it comes back on the question.
const realAnswerAsk = api.answerAsk!;
api.answerAsk = function (this: unknown, ...args: unknown[]) {
  const [id, answer] = args as [string, { selected: string[]; custom: string | null }];
  if (!id.startsWith("pj-ask-")) return realAnswerAsk.apply(this, args);
  if (refuseAsk() === id) {
    refuseAsk.set(null);
    return Promise.reject(new Error("暂时答不了，再试一次"));
  }
  said.set(`ask:${id}:${answer.selected.join(",")}|${answer.custom ?? ""}`);
  askAnswers.set({ ...askAnswers(), [id]: answer });
  // The run goes on once every question it waits on has its answer.
  if (runAsks().every((ask) => askAnswers()[ask])) runOn.set("running");
  return Promise.resolve(askLine(id, "", D2));
};
// Your local agents as a fixed list (`story-agents`), so the consultant menu's models do not hang on
// what this computer has installed; what was asked before (the Bot's picker asks as the story opens)
// is forgotten, as a window that has shown no Bot yet has nothing asked.
const fakeAgents = signal(false);
const fakeMultiAccounts = signal(false);
const STORY_AGENTS: AgentsStatusResponse = {
  items: [{
    runner: "antigravity", custom_id: null, label: "Antigravity", path: "/usr/local/bin/agy", source: "path", version: "1.5.14", logged_in: true, auth: null,
    login_command: null, models: [{ id: "story-agy-alpha", name: "Story Alpha (High)", efforts: [] }, { id: "story-agy-beta", name: "Story Beta (Low)", efforts: [] }],
    default_model: null, proxy: null, proxy_source: null, checked_at: D2, error: null,
  }],
  custom_agents: [],
};
const STORY_AGENTS_MULTI: AgentsStatusResponse = {
  items: [
    ...STORY_AGENTS.items,
    {
      runner: "codex", custom_id: null, label: "Codex", path: "/usr/local/bin/codex", source: "path", version: "0.153.4", logged_in: true, auth: "personal",
      login_command: null, models: [{ id: "gpt-5.6-terra", name: "gpt-5.6-terra", efforts: ["low", "high"] }],
      default_model: null, proxy: null, proxy_source: null, checked_at: D2, error: null,
      accounts: [
        { config_dir: null, logged_in: true, auth: "personal", login_command: null, error: null },
        { config_dir: "/Users/dev/.codex-work", logged_in: true, auth: "work", login_command: null, error: null },
      ],
    },
  ],
  custom_agents: [],
};
const STORY_CLAUDE_MULTI: ClaudeCodeStatus = {
  path: "/usr/local/bin/claude",
  version: "2.1.329",
  logged_in: true,
  email: "home@example.com",
  accounts: [
    { config_dir: null, config_directory: null, logged_in: true, auth_method: "claude.ai", subscription_type: "max", email: "home@example.com", error: null, login_command: "" },
    { config_dir: "/Users/dev/.claude-work", config_directory: "/Users/dev/.claude-work", logged_in: true, auth_method: "claude.ai", subscription_type: "max", email: "work@example.com", error: null, login_command: "" },
  ],
} as unknown as ClaudeCodeStatus;
const local = LocalApi.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
const realAgents = local.agents!;
local.agents = function (this: unknown, ...args: unknown[]) {
  if (fakeMultiAccounts()) return Promise.resolve(STORY_AGENTS_MULTI);
  return fakeAgents() ? Promise.resolve(STORY_AGENTS) : realAgents.apply(this, args);
};
const realClaudeCode = local.claudeCode!;
local.claudeCode = function (this: unknown, ...args: unknown[]) {
  return fakeMultiAccounts() ? Promise.resolve(STORY_CLAUDE_MULTI) : realClaudeCode.apply(this, args);
};
const realCommands = api.projectCommands!;
api.projectCommands = function (this: unknown, ...args: unknown[]) {
  if (args[0] !== PROJECT_ID) return realCommands.apply(this, args);
  return new Promise((done) => setTimeout(() => done({ commands: PROJECT_COMMANDS, checked_at: D2, error: null }), 150));
};
// The Bot↔Bot direct's delegations are held here.
const realLoadDelegations = proto.loadDelegations!;
proto.loadDelegations = function (this: unknown, ...args: unknown[]) {
  return args[0] === BOTDM_ID ? Promise.resolve() : realLoadDelegations.apply(this, args);
};

function current(): SessionSummary | null {
  const all = runtime.snapshot.sessions as SessionSummary[];
  switch (which()) {
    case "direct":
      return writerDirect() ? (all.find((s) => s.id === writerDirect()!.id) ?? null) : null;
    case "group":
      return all.find((s) => classifySession(s) === "group" && s.id !== scratch().empty && s.id !== scratch().bulk) ?? null;
    case "empty":
      return all.find((s) => s.id === scratch().empty) ?? null;
    case "bulk":
      return all.find((s) => s.id === scratch().bulk) ?? null;
    case "project":
      return all.find((s) => s.id === PROJECT_ID) ?? null;
    case "none":
      return null;
  }
}

const currentC = computed(current);

async function makeGroup(name: string): Promise<string | null> {
  const api = runtime.client;
  if (!api) return null;
  const made = await api.createGroup({ name, members: bots().map((b) => b.id) });
  return made.id;
}

async function open(kind: "empty" | "bulk", count: number): Promise<void> {
  if (busy()) return;
  busy.set(true);
  try {
    const api = runtime.client;
    if (!api) return;
    let id = scratch()[kind];
    if (!id) {
      id = (await makeGroup(kind === "bulk" ? "stage bulk" : "stage empty")) ?? "";
      scratch.set({ ...scratch(), [kind]: id });
      for (let i = 1; i <= count; i++) {
        await api.postMessage(id, `第 ${i} 条：${"周报要点 ".repeat(1 + (i % 4))}`);
        posted.set(i);
      }
    }
    which.set(kind);
    await runtime.selectSession(id);
  } finally {
    busy.set(false);
  }
}

async function show(kind: "direct" | "group"): Promise<void> {
  which.set(kind);
  const s = currentC();
  if (s) await runtime.selectSession(s.id);
}

/**
 * The draft of the conversation open now changes and the group opens in the same turn, as a quote
 * or a suggestion followed at once by another conversation: the editor that goes is handed the
 * next one's draft on its way out, and must not answer it once it is gone.
 */
function draftAndSwitch(): void {
  const here = currentC();
  if (here) runtime.sessionView(here.id).draft = "story draft";
  which.set("group");
  const group = currentC();
  if (group) void runtime.selectSession(group.id);
}

async function cleanup(): Promise<void> {
  const ids = scratch();
  which.set("direct");
  scratch.set({ empty: "", bulk: "" });
  posted.set(0);
  for (const id of [ids.empty, ids.bulk]) if (id) await runtime.deleteSession(id);
  said.set("cleaned");
}

export default function ChatStageStory() {
  const here = () => currentC();
  const lines = () => (here() ? runtime.snapshot.messages.filter((m: Message) => m.session_id === here()!.id) : []);
  const last = () => [...lines()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).at(-1);
  const button = (testID: string, label: string, onPress: () => void) => (
    <View role="button" testID={testID} onPress={onPress} class="px-2 py-1 border border-line rounded-(--radius-sm)">
      <Text class="text-[12px] text-ink">{label}</Text>
    </View>
  );
  return (
    <View class="flex-1 bg-bg">
      <Scroll class="shrink-0 max-h-[150px]">
        <View class="p-2 gap-1">
          <View class="flex-row flex-wrap gap-2">
            {button("show-direct", "direct", () => void show("direct"))}
            {button("show-group", "group", () => void show("group"))}
            {button("show-empty", "empty", () => void open("empty", 0))}
            {button("story-bulk", "bulk", () => void open("bulk", 130))}
            {button("show-none", "none", () => which.set("none"))}
            {button("show-project", "project", () => {
              projectEmpty.set(false);
              which.set("project");
            })}
            {button("story-project-empty", "project empty", () => {
              projectEmpty.set(true);
              which.set("project");
            })}
            {button("story-run", "run", () => runOn.set("running"))}
            {button("story-agent-grok", "grok", () => projectAgent.set("grok"))}
            {button("story-agent-codex", "codex", () => projectAgent.set("codex"))}
            {button("story-consult", "consult codex", () => {
              // The popup reads the consultant through the runtime's client; the story answers for it.
              const client = runtime.client as unknown as { agentTaskDetail: (run: string, id: string) => Promise<AgentTaskDetail> } | null;
              if (client) {
                client.agentTaskDetail = async (run, id) =>
                  ({ task: { id, run_id: run }, output: null, output_bytes: null, prompt: "这个迁移的回滚顺序对不对", model: "gpt-5.6-terra", steps: [{ kind: "say", text: "先回滚索引，再回滚列。" }] }) as unknown as AgentTaskDetail;
              }
              consulted.set(true);
            })}
            {button("story-consult-members", "consult: opus + codex", () =>
              consultSetting.set({ on: true, members: [{ agent: "claude_code", model: "claude-opus-5-5", effort: null }, { agent: "codex", model: null, effort: "high" }] }),
            )}
            {button("story-context-normal", "ctx 34%", () => projectContext.set({ used: 68_000, limit: 200_000, model: "claude-opus-4-6" }))}
            {button("story-context-high", "ctx 92%", () => projectContext.set({ used: 184_000, limit: 200_000, model: "claude-opus-4-6" }))}
            {button("story-context-nolimit", "ctx 42.3k", () => projectContext.set({ used: 42_300, limit: null }))}
            {button("story-context-clear", "ctx clear", () => projectContext.set(null))}
            {button("story-agents", "fixed agents", () => {
              forgetClaudeOptions();
              fakeMultiAccounts.set(false);
              fakeAgents.set(true);
            })}
            {button("story-accounts", "multi accounts", () => {
              forgetClaudeOptions();
              fakeAgents.set(false);
              fakeMultiAccounts.set(true);
            })}
            {button("story-subagent-done", "subagent done", () => subagentDone.set(true))}
            {button("story-approval", "approval", () => runOn.set("approval"))}
            {button("story-ask", "ask", () => {
              asked.set(true);
              runAsks.set(["pj-ask-open"]);
              runOn.set("asking");
            })}
            {button("story-ask-many", "ask three", () => {
              askedMany.set(true);
              runAsks.set(MANY);
              runOn.set("asking");
            })}
            {button("story-ask-refuse", "refuse the 2nd answer", () => refuseAsk.set(MANY[1]!))}
            {button("story-plan", "plan card", () => runOn.set("plan"))}
            {button("story-annotated", "annotated", () => annotated.set(true))}
            {button("show-popup", "popup", () => popup.set(true))}
            {button("story-cleanup", "clean up", () => void cleanup())}
            {button("story-draft-switch", "draft and switch", () => draftAndSwitch())}
          </View>
          <Text testID="said" class="text-[12px] text-ink-muted">{said()}</Text>
          <Text testID="story-session" class="text-[12px] text-ink-muted">{`session:${which()}`}</Text>
          <Text testID="story-posted" class="text-[12px] text-ink-muted">{`posted:${posted()}`}</Text>
          <Text testID="story-plan-mode" class="text-[12px] text-ink-muted">{`plan-mode:${planMode() ? "on" : "off"}`}</Text>
          <Text testID="story-consult" class="text-[12px] text-ink-muted">{`consult:${consultSetting()?.on ? "on" : "off"}:${(consultSetting()?.members ?? []).map((m) => `${m.agent}/${m.model ?? "-"}/${m.effort ?? "-"}${m.config_dir ? `@${m.config_dir}` : ""}`).join(",")}`}</Text>
          <Text testID="story-state" class="text-[12px] text-ink-muted">{`lines:${lines().length} older:${(here() ? runtime.sessionView(here()!.id).hasOlderMessages : false) ? "yes" : "no"}`}</Text>
          <Text testID="story-last" class="text-[12px] text-ink-muted">{`last:${last()?.id ?? ""}`}</Text>
          <Text testID="story-answers" class="text-[12px] text-ink-muted">{`answers:${Object.entries(askAnswers()).map(([id, a]) => `${id}=${a.selected.join(",")}|${a.custom ?? ""}`).join(";")}`}</Text>
        </View>
      </Scroll>
      <If when={which() === "project" ? here() : null} else={
        <ChatStage
          selected={here()}
          onOpenProfile={(id) => said.set(`profile:${id}`)}
          onOpenArtifact={(path) => said.set(`artifact:${path}`)}
          onCreateBot={() => said.set("create-bot")}
          readFiles={fakeReadFiles}
        />
      }>
        {(session: () => SessionSummary) => (
          <PaneMenu.Provider value={() => said.set("pane-menu")}>
            <ProjectChat selected={session()} onOpenArtifact={(path) => said.set(`artifact:${path}`)} readFiles={fakeReadFiles} />
          </PaneMenu.Provider>
        )}
      </If>
      <If when={popup() ? (runtime.snapshot.sessions as SessionSummary[]).find((s) => s.id === BOTDM_ID) : null}>
        {(session: () => SessionSummary) => (
          <BotDmDialog
            session={session()}
            onClose={() => popup.set(false)}
            onOpenProfile={(id) => {
              popup.set(false);
              said.set(`profile:${id}`);
            }}
            onOpenArtifact={(path) => {
              popup.set(false);
              said.set(`artifact:${path}`);
            }}
            onCreateBot={() => said.set("create-bot")}
          />
        )}
      </If>
    </View>
  );
}
