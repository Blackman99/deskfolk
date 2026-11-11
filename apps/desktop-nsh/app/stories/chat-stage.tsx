/**
 * The conversation's bodies on the fixture runtime: `ChatStage` on Writer's direct (the seeded
 * lines, one with Markdown), the group 周报小组, an empty scratch group (the welcome) and a scratch
 * group the story fills with enough lines to scroll and to page (`story-bulk`: 130 lines, past the 100 a conversation opens with;
 * `story-cleanup` deletes it); `BotDmDialog` on a Bot↔Bot direct and `ProjectChat` on a project
 * session, both synthetic (the runtime makes neither without a real agent): they are laid over the
 * runtime's snapshot like `chat-composer-2` does, and what would go to the daemon for them
 * (`send`, `tuneProjectSession`, the run's answer and stop, a project card's status) is answered here and
 * logged under `said`; `story-annotated` adds a batch of annotations you sent in the project session.
 * Lines go in through `runtime.client` into the scratch group only: one posted into the fixture's
 * Writer direct would start a turn there and leave it unfinished for every later test.
 */
import { computed, Scroll, signal, Text, View } from "nsh";
import { USER_MEMBER, type AgentRun, type Annotation, type Bot, type DelegationView, type Message, type SessionSummary } from "@real-bot/protocol";
import { classifySession, youBotPeer } from "../src/m/sidebar/session-groups";
import { runtime } from "../src/runtime";
import { BotDmDialog } from "../src/ui/chat/BotDmDialog";
import { ChatStage } from "../src/ui/chat/ChatStage";
import { ProjectChat } from "../src/ui/chat/ProjectChat";

type Which = "direct" | "group" | "empty" | "bulk" | "project" | "none";
const which = signal<Which>("direct");
const scratch = signal<{ empty: string; bulk: string }>({ empty: "", bulk: "" });
const said = signal("—");
const busy = signal(false);
/** How many lines the story has posted into its scratch group so far. */
const posted = signal(0);
const popup = signal(false);
const runOn = signal<"" | "running" | "approval" | "plan">("");
const planMode = signal(false);
const projectLines = signal<Message[]>([]);
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
    ? ({ ...base, id: PROJECT_ID, kind: "project", name: "Deskfolk", project_dir: "/Users/dev/my-projects/real-bot", project_agent: "claude_code", project_mode: planMode() ? "plan" : null } as unknown as SessionSummary)
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

function projectBase(): Message[] {
  return [
    line({ id: "pj-1", session_id: PROJECT_ID, body: "把 README 的安装一节改短", created_at: D1 }),
    line({ id: "pj-2", session_id: PROJECT_ID, kind: "bot", author: "claude-code", body: "好的，我看了 README：\n\n- 安装一节有 **三段**\n- 可以合成一段\n\n改好后告诉你。", created_at: "2026-10-19T09:31:00.000Z" }),
    line({ id: "pj-3", session_id: PROJECT_ID, kind: "system", author: "app", body: "已切到新的一天", created_at: D2 }),
    line({ id: "pj-4", session_id: PROJECT_ID, body: "再看一下测试", created_at: "2026-10-20T09:31:00.000Z" }),
    ...(annotated() ? [line({ id: "pj-5", session_id: PROJECT_ID, body: "按这两条改", created_at: "2026-10-20T09:33:00.000Z" })] : []),
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

function projectRun(): AgentRun | null {
  const mode = runOn();
  if (!mode) return null;
  return {
    id: "run-story",
    session_id: PROJECT_ID,
    status: mode === "running" ? "running" : "waiting_approval",
    activity: mode === "running" ? "Bash npm test" : null,
    partial: mode === "running" ? "我先跑一遍测试，看哪些用例挂了" : null,
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
            {button("show-project", "project", () => which.set("project"))}
            {button("story-run", "run", () => runOn.set("running"))}
            {button("story-approval", "approval", () => runOn.set("approval"))}
            {button("story-plan", "plan card", () => runOn.set("plan"))}
            {button("story-annotated", "annotated", () => annotated.set(true))}
            {button("show-popup", "popup", () => popup.set(true))}
            {button("story-cleanup", "clean up", () => void cleanup())}
          </View>
          <Text testID="said" class="text-[12px] text-ink-muted">{said()}</Text>
          <Text testID="story-session" class="text-[12px] text-ink-muted">{`session:${which()}`}</Text>
          <Text testID="story-posted" class="text-[12px] text-ink-muted">{`posted:${posted()}`}</Text>
          <Text testID="story-plan-mode" class="text-[12px] text-ink-muted">{`plan-mode:${planMode() ? "on" : "off"}`}</Text>
          <Text testID="story-state" class="text-[12px] text-ink-muted">{`lines:${lines().length} older:${(here() ? runtime.sessionView(here()!.id).hasOlderMessages : false) ? "yes" : "no"}`}</Text>
          <Text testID="story-last" class="text-[12px] text-ink-muted">{`last:${last()?.id ?? ""}`}</Text>
        </View>
      </Scroll>
      <If when={which() === "project" ? here() : null} else={
        <ChatStage
          selected={here()}
          onOpenProfile={(id) => said.set(`profile:${id}`)}
          onOpenArtifact={(path) => said.set(`artifact:${path}`)}
          onCreateBot={() => said.set("create-bot")}
        />
      }>
        {(session: () => SessionSummary) => <ProjectChat selected={session()} onOpenArtifact={(path) => said.set(`artifact:${path}`)} />}
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
