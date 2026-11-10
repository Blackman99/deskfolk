/**
 * The task map: a project session's agent at work as a town of its folders (a Claude Code run with
 * a subagent that failed once), a Bot conversation's plan (the fixture's Writer and Editor in the
 * group and in Writer's direct, with two more jobs to switch to), and a conversation with no record.
 * The replays are protocol objects held here and served by a fake client in place of the runtime's;
 * a button lands a live call on the project map. What the screen reports (`task:<id>`), and a right
 * click that reaches the pane round it (`pane-menu`), is written to `taskmap-log`.
 */
import { Scroll, Text, View, computed, signal } from "nsh";
import type {
  AgentReplay,
  AgentReplayCall,
  PlanReplay,
  PlanReplayCall,
  SessionReplay,
  SessionSummary,
  SessionTaskSummary,
  ToolFrame,
} from "@real-bot/protocol";
import { AgentCallLog } from "../src/m/taskmap/live.svelte";
import { runtime } from "../src/runtime";
import { Button } from "../src/ui/Button";
import { TaskMap, type TaskMapClient } from "../src/ui/taskmap/TaskMap";

const T0 = Date.parse("2026-10-20T01:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

// --- A project session: the agent edits in two folders, a subagent builds the chat and fails a check ---
let n = 0;
function aCall(path: string, s: number, over: Partial<AgentReplayCall> = {}): AgentReplayCall {
  n += 1;
  return { id: `toolu_${n}`, at: iso(s), agent_id: null, tool: "Edit", place: { zone: "project", path }, model: "claude-opus-5-5", file: path.split("/").pop() ?? null, ok: true, duration_ms: 400, decision: null, ...over };
}

function projectReplay(): AgentReplay {
  n = 0;
  return {
    session_id: "proj-1",
    agent_session: "s-1",
    source_session: null,
    calls: [
      ...Array.from({ length: 12 }, (_, i) => aCall("apps/daemon/src/store/a.ts", i * 5)),
      ...Array.from({ length: 12 }, (_, i) => aCall("apps/messenger/src/lib/chat/b.svelte", 70 + i * 5, i % 2 ? { agent_id: "agent-x", model: "claude-sonnet-5-5" } : {})),
      aCall("x", 140, { tool: "Bash", place: { zone: "check", check: "test" }, ok: false }),
    ],
    subagents: [{ id: "agent-x", description: "Build the chat", agent_type: "general-purpose", model: "sonnet", spawned_by: null, first_at: iso(75), last_at: iso(130), calls: 6 }],
    said: [{ kind: "say", at: iso(0), text: "把地图做出来" }],
  };
}

const PROJECT: SessionSummary = {
  id: "proj-1",
  kind: "project",
  name: "Fix the login loop",
  archived_at: null,
  created_at: "2026-09-19T00:00:00.000Z",
  updated_at: "2026-09-19T00:00:00.000Z",
  last_read_at: null,
  origin_session_id: null,
  origin_message_id: null,
  participants: [{ member: "user", joined_at: "2026-09-19T00:00:00.000Z", left_at: null }],
  project_dir: "/w/real-bot",
  project_agent: "claude_code",
  project_config_dir: null,
  project_agent_session: null,
  project_source: null,
  project_model: null,
  project_effort: null,
  project_mode: null,
} as SessionSummary;

// --- A plan the fixture's Bots worked on, in the group and in Writer's direct ---
const job = (id: string, title: string, over: Partial<SessionTaskSummary> = {}): SessionTaskSummary => ({
  id,
  dir: `jobs/${id}`,
  title,
  session_id: null,
  closed_at: null,
  last_activity_at: "2026-10-20T00:00:00.000Z",
  goal: null,
  kind: null,
  status: "active",
  ticket_counts: { todo: 1, doing: 1, review: 0, done: 2, parked: 0 },
  turn_count: 3,
  ...over,
});
const JOBS = [
  job("task-1", "周报"),
  job("task-2", "季度复盘"),
  job("task-3", "问一句", { status: "done", closed_at: "2026-10-19T00:00:00.000Z", ticket_counts: { todo: 0, doing: 0, review: 0, done: 0, parked: 0 }, turn_count: 1 }),
];

const bot = (name: string) => runtime.snapshot.bots.find((b) => b.name === name);
const group = () => runtime.snapshot.sessions.find((s) => s.kind === "group") ?? null;
const directOf = (botId: string) => runtime.snapshot.sessions.find((s) => s.kind === "direct" && s.participants.some((p) => p.member === botId)) ?? null;

function planReplay(id: string): PlanReplay {
  n = 0;
  const writer = bot("Writer")!.id;
  const editor = bot("Editor")!.id;
  const g = group()!.id;
  const d = directOf(writer)?.id ?? g;
  const call = (b: string, session: string, path: string, s: number, over: Partial<PlanReplayCall> = {}): PlanReplayCall => {
    n += 1;
    return { id: `call_${n}`, at: iso(s), bot_id: b, turn_id: "turn-1", task_id: id, tool: "write_file", place: { zone: "project", path }, model: "deepseek-chat", file: path.split("/").pop() ?? null, ok: true, duration_ms: 300, decision: null, session_id: session, ...over };
  };
  return {
    task_id: id,
    title: JOBS.find((j) => j.id === id)?.title ?? id,
    dir: `jobs/${id}`,
    truncated: false,
    bots: [writer, editor],
    sessions: [g, d],
    calls: [
      ...Array.from({ length: 6 }, (_, i) => call(writer, g, "jobs/weekly/drafts/a.md", i * 10)),
      call(writer, g, "x", 65, { tool: "mcp_search", place: { zone: "service", server: "search-cpa" }, file: null }),
      ...Array.from({ length: 4 }, (_, i) => call(editor, d, "jobs/weekly/review/notes.md", 100 + i * 10, { tool: "read_file", model: "claude-opus-5-5" })),
    ],
    said: [
      { kind: "say", at: iso(0), text: "写本周周报", session_id: g },
      { kind: "say", at: iso(95), text: "请编辑看节奏", session_id: d },
    ],
  };
}

const none = async (): Promise<never> => {
  throw new Error("not served");
};
const projectClient: TaskMapClient = {
  projectReplay: async () => projectReplay(),
  sessionReplay: none,
  planReplay: none,
  sessionTasks: async () => [],
};
const planClient: TaskMapClient = {
  sessionTasks: async () => JOBS,
  planReplay: async (id: string) => planReplay(id),
  sessionReplay: none,
  projectReplay: none,
};
const emptyClient: TaskMapClient = {
  sessionTasks: async () => [],
  planReplay: none,
  sessionReplay: async () => ({ session_id: "g", bots: [], calls: [], said: [], truncated: false }) as SessionReplay,
  projectReplay: none,
};

type Mode = "project" | "plan" | "empty";

export default function TaskMapStory() {
  const mode = signal<Mode>("project");
  const log = signal<string[]>([]);
  const projectCalls = new AgentCallLog();
  const ready = computed(() => group() !== null && bot("Writer") !== undefined && bot("Editor") !== undefined);
  let live = 0;
  const land = () => {
    live += 1;
    projectCalls.applyTool({
      type: "tool",
      turn_id: "run-1",
      id: `toolu_live_${live}`,
      name: "Edit",
      phase: "started",
      agent_run: { session_id: "proj-1", agent_id: null, place: { zone: "project", path: "apps/daemon/src/store/a.ts" }, model: "claude-opus-5-5", at: iso(200 + live) },
    } as ToolFrame);
  };
  const modes: Mode[] = ["project", "plan", "empty"];

  return (
    <View class="flex-1 min-h-0 bg-pane">
      <View class="flex-row flex-wrap items-center gap-2 p-2 border-b border-line-subtle">
        <Each of={modes}>
          {(m) => (
            <Button testID={`taskmap-mode-${m()}`} variant={mode() === m() ? "primary" : "secondary"} size="sm" onPress={() => mode.set(m())}>
              {m()}
            </Button>
          )}
        </Each>
        <Button testID="taskmap-live-call" variant="secondary" size="sm" onPress={land}>live call</Button>
        <Scroll horizontal class="shrink min-w-0">
          <Text testID="taskmap-log" class="text-[11px] text-ink-muted">{log().join(" ")}</Text>
        </Scroll>
      </View>
      {/* Hears a right click as the workbench pane round a map does (`WorkbenchLeaf`), to see what reaches it. */}
      <View class="flex-1 min-h-0" onContextMenu={() => log.set([...log(), "pane-menu"])}>
        <If when={mode() === "project"}>
          <TaskMap session={PROJECT} client={projectClient} agentCalls={projectCalls} />
        </If>
        <If when={mode() === "plan" && ready()}>
          <TaskMap
            session={group()!}
            client={planClient}
            agentCalls={new AgentCallLog()}
            onTask={(id) => log.set([...log(), `task:${id}`])}
          />
        </If>
        <If when={mode() === "empty" && ready()}>
          <TaskMap session={group()!} client={emptyClient} agentCalls={new AgentCallLog()} />
        </If>
      </View>
    </View>
  );
}
