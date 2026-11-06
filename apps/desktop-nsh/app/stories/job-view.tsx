/**
 * A job in one tab (`JobLayout`, ADR 0086): its title row (the job switcher, the stop menu, the
 * chips), the ticket rail with its lanes, the trace, the ticket board opened out, and the inspector
 * (a ticket, a step's panel, the whole job's spec). The job is protocol objects held here and served
 * by a stand-in client that answers as the daemon does; every call and every thing the layout hands
 * its host is written to `job-log`.
 *
 * Buttons above stand in for the host: `story-width-<narrow|medium|wide>` lays out by a fixed width
 * (the real tab measures its own), `story-page` mounts the narrow host (`TaskTrace`), `story-hold`
 * lands one of your stops, `story-fail` makes the plan's save conflict, `story-reload` is a live
 * reload, `story-ask` asks the tab to show a ticket on a column.
 */
import { Text, View, signal } from "nsh";
import { CallEditor } from "../src/ui/settings/CallEditor";
import {
  USER_MEMBER,
  builtinPlaybook,
  emptyPlaybookDiff,
  playbookDefaults,
  type Bot,
  type CallRun,
  type Hold,
  type Playbook,
  type SessionSummary,
  type TaskDetail,
  type TaskTrace as TaskTraceData,
  type TaskTraceNode,
  type TraceStep,
  type TicketWithArtifacts,
} from "@real-bot/protocol";
import type { MessengerApi } from "../src/m/messenger-api.ts";
import type { TraceViewAsk } from "../src/m/overlays/trace-view.ts";
import { Button } from "../src/ui/Button";
import { JobLayout } from "../src/ui/overlays/JobLayout";
import { TaskTrace } from "../src/ui/overlays/TaskTrace";

const AT = (minute: number, second = 0) => new Date(Date.UTC(2026, 8, 22, 9, minute, second)).toISOString();

const BOTS = [
  { id: "bot-1", name: "制片", duties: "", boundaries: "", avatar: null },
  { id: "bot-2", name: "分镜师", duties: "", boundaries: "", avatar: null },
  { id: "bot-3", name: "审片", duties: "", boundaries: "", avatar: null },
] as unknown as Bot[];

const SESSIONS = [{ id: "group-1", kind: "group", name: "制作组", participants: [] }] as unknown as SessionSummary[];

function node(over: Partial<TaskTraceNode>): TaskTraceNode {
  return {
    turn_id: "turn",
    session_id: "group-1",
    actor: "bot-1",
    status: "completed",
    woken_by_turn_id: null,
    woken_elsewhere: null,
    trigger_message_id: "m",
    focus_message_id: "m",
    summary: "",
    created_at: AT(0),
    artifacts: [],
    ask: null,
    approval: null,
    passed: 0,
    ticket_id: null,
    ...over,
  };
}

const BOARD_FILE = "work/先出分镜-7f3k/01-分镜草图/board.pdf";

function trace(): TaskTraceData {
  const nodes: TaskTraceNode[] = [
    node({ turn_id: "user:r0", actor: USER_MEMBER, trigger_message_id: "r0", focus_message_id: "r0", summary: "先出分镜草图", created_at: AT(0) }),
    node({
      turn_id: "t0",
      woken_by_turn_id: "user:r0",
      trigger_message_id: "r0",
      focus_message_id: "a0",
      summary: "分镜交给分镜师",
      created_at: AT(1),
      ticket_id: "tk-1",
    }),
    node({
      turn_id: "t1",
      actor: "bot-2",
      woken_by_turn_id: "t0",
      trigger_message_id: "a0",
      focus_message_id: "b1",
      summary: "12 格已画完",
      created_at: AT(10),
      ticket_id: "tk-1",
      artifacts: [{ path: BOARD_FILE, message_id: "b1", attachment_id: "att-1" }],
    }),
    node({ turn_id: "user:r1", actor: USER_MEMBER, trigger_message_id: "r1", focus_message_id: "r1", summary: "再加一版配乐", created_at: AT(30) }),
    node({
      turn_id: "t2",
      actor: "bot-2",
      woken_by_turn_id: "user:r1",
      trigger_message_id: "r1",
      focus_message_id: "b2",
      summary: "正在写配乐",
      created_at: AT(31),
      ticket_id: "tk-2",
    }),
    node({
      turn_id: "t3",
      actor: "bot-3",
      status: "stopped",
      woken_by_turn_id: "t2",
      trigger_message_id: "b2",
      focus_message_id: "b3",
      summary: "审片被停了",
      created_at: AT(33),
      ticket_id: "tk-3",
    }),
  ];
  const step = (over: Partial<TraceStep>): TraceStep =>
    ({
      id: "s1",
      role: "reader",
      prompt_id: "call.read_user_line",
      prompt_revision: null,
      prompt_locale: "zh",
      session_id: "group-1",
      message_id: null,
      turn_id: null,
      task_id: "task-1",
      ticket_id: null,
      bot_id: null,
      check_run_id: null,
      provider_id: "p",
      model: "haiku",
      thinking_level: null,
      outcome: "ok",
      fail_kind: null,
      verdict: null,
      cached: false,
      spend_id: null,
      ms: 1200,
      created_at: AT(30, 5),
      ...over,
    }) as TraceStep;
  const steps = [
    step({ id: "s1", message_id: "r1" }),
    step({ id: "s2", turn_id: "t2", outcome: "failed", fail_kind: "timeout", created_at: AT(31, 20) }),
  ];
  return { id: "task-1", dir: "work/先出分镜-7f3k", title: "先出分镜", session_id: "group-1", closed_at: null, nodes, steps } as TaskTraceData;
}

function ticket(seq: number, title: string, over: Partial<TicketWithArtifacts> = {}): TicketWithArtifacts {
  return {
    id: `tk-${seq}`,
    task_id: "task-1",
    seq,
    title,
    slug: `0${seq}-${title}`,
    dir: `work/先出分镜-7f3k/0${seq}-${title}`,
    spec: "",
    status: "todo",
    worker: null,
    owner_bot_id: "bot-2",
    depends_on: [],
    created_at: AT(0),
    updated_at: AT(20),
    closed_at: null,
    artifacts: [],
    ...over,
  } as TicketWithArtifacts;
}

function detail(): TaskDetail {
  return {
    id: "task-1",
    dir: "work/先出分镜-7f3k",
    title: "先出分镜",
    session_id: "group-1",
    closed_at: null,
    last_activity_at: AT(35),
    goal: "先出分镜的草图和配乐",
    kind: "分镜",
    status: "active",
    ticket_counts: { todo: 1, doing: 1, review: 1, done: 1, parked: 0 },
    brief: "先出分镜",
    spec: {
      kind: "分镜",
      goal: "先出分镜的草图和配乐",
      acceptance: ["12 格分镜", "一版配乐"],
      rules: ["镜头编号连续"],
      process: [],
      progress: { done: ["分镜草图"], open: ["配乐"], blocked: [] },
      status: "active",
    },
    spec_updated_at: AT(0),
    revision: 1,
    revision_actor: "app",
    routine_id: null,
    submissions_on: true,
    supervision_on: true,
    routing_on: false,
    reviewer_ids: ["bot-1", "bot-3"],
    tickets: [
      ticket(1, "分镜草图", {
        status: "done",
        worker: "bot-2",
        spec: "12 格，竖版",
        artifacts: [{ path: BOARD_FILE, message_id: "b1", attachment_id: "att-1" }],
      }),
      ticket(2, "配乐", { status: "doing", worker: "bot-2", reviewer_bot_id: "bot-1" }),
      ticket(3, "终稿审阅", { status: "review", owner_bot_id: "bot-3", worker: "bot-3", depends_on: ["tk-2"] }),
      ticket(4, "发布", { status: "todo", depends_on: ["tk-2"] }),
    ],
    checks: [],
    requirements: [
      {
        id: "offer",
        seq: 40,
        quote: "改成 3 分钟",
        restated: null,
        category: null,
        polarity: "must",
        dimension: null,
        value: null,
        status: "proposed",
        scope: "plan",
        ticket_id: null,
        domain: null,
        times_raised: 1,
        plans_raised: 1,
        last_raised_at: AT(30),
        source_kind: "message",
        source: { via: "message", session_id: "group-1", message_id: "m1", at: AT(30) },
        added_by: "scribe",
        inherited_from: null,
        excluded: false,
        supersedes: null,
      },
    ],
    retrospectives: [],
  } as unknown as TaskDetail;
}

const ENGINE: Playbook = {
  id: "general",
  builtin: true,
  base_id: "general",
  name: null,
  revision: 0,
  revision_id: null,
  diff: emptyPlaybookDiff(),
  resolved: playbookDefaults(),
  updated_at: null,
};
void builtinPlaybook;

export default function JobView() {
  const log = signal<string[]>([]);
  const said = (line: string) => log.set([...log(), line]);
  const fixedWidth = signal<number | undefined>(undefined);
  const page = signal(false);
  const reload = signal(0);
  const holds = signal<Hold[]>([]);
  const plan = signal<TaskDetail>(detail());
  const planFails = signal(false);
  const ask = signal<{ token: number; ask: TraceViewAsk | null }>({ token: 0, ask: null });

  const api = {
    sessionTasks: async () => [
      { id: "task-1", dir: "work/先出分镜-7f3k", title: "先出分镜", session_id: "group-1", closed_at: null, last_activity_at: AT(35), goal: null, kind: null, status: "active", ticket_counts: plan().ticket_counts },
      { id: "task-2", dir: "work/旧稿-1a2b", title: "旧稿", session_id: "group-1", closed_at: AT(5), last_activity_at: AT(5), goal: null, kind: null, status: "done", ticket_counts: { todo: 0, doing: 0, review: 0, done: 1, parked: 0 } },
    ],
    taskTrace: async (id: string) => (id === "task-1" ? trace() : { ...trace(), id, title: "旧稿", dir: "work/旧稿-1a2b", closed_at: AT(5), nodes: [], steps: [] }),
    taskDetail: async (id: string) => {
      if (id !== "task-1") return { ...detail(), id, title: "旧稿", tickets: [], ticket_counts: { todo: 0, doing: 0, review: 0, done: 0, parked: 0 }, status: "done" };
      return plan();
    },
    patchTicket: async (id: string, body: { status?: string; reviewer_bot_id?: string | null; depends_on?: string[] }) => {
      said(`patch:${id}:${JSON.stringify(body)}`);
      if (planFails()) throw Object.assign(new Error("conflict"), { status: 409 });
      const tickets = plan().tickets.map((row) => (row.id === id ? { ...row, ...(body as Partial<TicketWithArtifacts>) } : row));
      plan.set({ ...plan(), tickets, revision: plan().revision + 1 });
      return tickets.find((row) => row.id === id)!;
    },
    patchTaskSpec: async () => plan(),
    callRun: async () => ({ raw: JSON.stringify({ passed: false, why: "超时" }) }) as CallRun,
    listPlaybooks: async () => ({ default_id: "general", items: [ENGINE] }),
  } as unknown as MessengerApi;

  const layout = (host: "pane" | "page") => (
    <JobLayout
      host={host}
      api={api}
      taskId="task-1"
      sessionId="group-1"
      activeSessionId="group-1"
      sessions={SESSIONS}
      bots={BOTS}
      youLabel="你"
      deletedLabel="已删除"
      reloadToken={reload()}
      width={host === "pane" ? fixedWidth() : undefined}
      ask={ask().ask}
      askToken={ask().token}
      holds={holds()}
      onStop={(choice) => said(`stop:${choice.scope}`)}
      onLift={(hold) => {
        said(`lift:${hold.id}`);
        holds.set(holds().filter((row) => row.id !== hold.id));
      }}
      onJump={(session, message) => said(`jump:${session}/${message}`)}
      onOpenArtifact={(relpath, _att, _message, bundle, _task, siblings) => said(`artifact:${relpath}|${siblings?.length ?? 0}|${bundle ? "tree" : "file"}`)}
      onOpenRoles={(id) => said(`roles:${id}`)}
      onOpenMap={(id) => said(`map:${id}`)}
      onTask={(id) => said(`task:${id}`)}
      onClose={host === "page" ? () => page.set(false) : undefined}
      callEditor={(role) => <CallEditor role={role} />}
    />
  );

  return (
    <View class="flex-1 bg-pane">
      <View class="flex-row flex-wrap items-center gap-[8px] p-[8px] border-b border-line">
        <Button testID="story-width-narrow" size="sm" variant="secondary" onPress={() => fixedWidth.set(420)}>
          narrow
        </Button>
        <Button testID="story-width-medium" size="sm" variant="secondary" onPress={() => fixedWidth.set(800)}>
          medium
        </Button>
        <Button testID="story-width-wide" size="sm" variant="secondary" onPress={() => fixedWidth.set(1300)}>
          wide
        </Button>
        <Button testID="story-page" size="sm" variant="secondary" onPress={() => page.set(true)}>
          page
        </Button>
        <Button
          testID="story-hold"
          size="sm"
          variant="secondary"
          onPress={() =>
            holds.set([
              { id: "hold-1", scope: "plan", scope_id: "task-1", lift_on_next_user_message: false, created_at: AT(34), reason: null } as unknown as Hold,
            ])
          }
        >
          hold
        </Button>
        <Button testID="story-fail" size="sm" variant="secondary" onPress={() => planFails.set(true)}>
          fail
        </Button>
        <Button testID="story-reload" size="sm" variant="secondary" onPress={() => reload.set(reload() + 1)}>
          reload
        </Button>
        <Button
          testID="story-ask"
          size="sm"
          variant="secondary"
          onPress={() => ask.set({ token: ask().token + 1, ask: { ticket: "tk-2", column: "doing" } })}
        >
          ask
        </Button>
        <Text testID="job-log" class="text-[12px] text-ink-muted">
          {log().join(" ") || "-"}
        </Text>
      </View>
      <View class="flex-1 min-h-0">{layout("pane")}</View>
      <If when={page()}>
        <TaskTrace
          api={api}
          taskId="task-1"
          sessionId="group-1"
          activeSessionId="group-1"
          sessions={SESSIONS}
          bots={BOTS}
          youLabel="你"
          deletedLabel="已删除"
          workspacePath={null}
          reloadToken={0}
          onClose={() => page.set(false)}
          onJump={(session, message) => said(`jump:${session}/${message}`)}
          holds={holds()}
          onStop={(choice) => said(`stop:${choice.scope}`)}
        />
      </If>
    </View>
  );
}
