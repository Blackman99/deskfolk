/**
 * The trace view on a job that has run: four rounds (the older two fold to a line each), a line of
 * yours, two Bots, a card still waiting on your approval with a file bundle, model choices with
 * pushback and blame, a ticket, and the app's own calls (one gone wrong). The runtime is a stand-in
 * api, so the data does not depend on what the fixture holds. Controls above the board break it
 * (the trace fails to load, a job with nothing in it) and ask for a card; what the board calls out
 * to the host (a card pressed, a file opened, a model marked) is written as text.
 */
import { Text, View, signal } from "nsh";
import {
  USER_MEMBER,
  type Bot,
  type RouteRecord,
  type SessionSummary,
  type TaskDetail,
  type TaskTrace,
  type CallRun,
  type TaskTraceNode,
  type TraceStep,
} from "@real-bot/protocol";
import { Button } from "../src/ui/Button";
import { TraceStepDetail } from "../src/ui/overlays/TraceStepDetail";
import { TraceView, type TraceViewHandle } from "../src/ui/overlays/TraceView";
import { attachSteps } from "../src/m/overlays/trace-steps.ts";
import { JobState } from "../src/m/overlays/job-state.svelte.ts";
import type { MessengerApi } from "../src/m/messenger-api.ts";

const BOTS = [
  { id: "bot-1", name: "制片", duties: "", boundaries: "", avatar: null },
  { id: "bot-2", name: "分镜师", duties: "", boundaries: "", avatar: null },
] as unknown as Bot[];

const SESSIONS = [
  { id: "group-1", kind: "group", name: "制作组", participants: [] },
  {
    id: "direct-1",
    kind: "direct",
    name: null,
    participants: [
      { member: "bot-1", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
      { member: "bot-2", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
    ],
  },
] as unknown as SessionSummary[];

const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 8, 22, 9, minute, second)).toISOString();

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
    created_at: at(0),
    artifacts: [],
    ask: null,
    approval: null,
    passed: 0,
    ticket_id: null,
    ...over,
  };
}

/** A line of yours and the Bot who answered it, a round. */
function round(index: number, line: string, answer: string, minute: number, over: Partial<TaskTraceNode> = {}): TaskTraceNode[] {
  return [
    node({ turn_id: `user:r${index}`, actor: USER_MEMBER, trigger_message_id: `r${index}`, focus_message_id: `r${index}`, summary: line, created_at: at(minute) }),
    node({
      turn_id: `t${index}`,
      woken_by_turn_id: `user:r${index}`,
      trigger_message_id: `r${index}`,
      focus_message_id: `a${index}`,
      summary: answer,
      created_at: at(minute, 30),
      ...over,
    }),
  ];
}

function record(over: Partial<RouteRecord>): RouteRecord {
  return {
    turn_id: "t3",
    session_id: "group-1",
    bot_id: "bot-1",
    trigger_message_id: "r3",
    provider_id: null,
    model: "grok-4.7",
    thinking_level: "high",
    signature: "coding",
    outcome: "completed",
    fail_kind: null,
    reason: "要改很多文件，用最强的",
    chain_id: "t3",
    created_at: at(31),
    finished_at: at(35),
    hops: 16,
    tool_calls: 20,
    tool_errors: 0,
    repeated_failures: 0,
    files_written: 3,
    feedback: [],
    ...over,
  } as RouteRecord;
}

const BOARD = "work/先出分镜-7f3k/01-分镜草图/board.pdf";
const SCORE = ["work/先出分镜-7f3k/02-配乐/theme.mp3", "work/先出分镜-7f3k/02-配乐/notes.md"];

function step(over: Partial<TraceStep>): TraceStep {
  return {
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
    created_at: at(30, 5),
    ...over,
  };
}

function fullTrace(): TaskTrace {
  const nodes: TaskTraceNode[] = [
    ...round(0, "先把需求整理一下", "需求整理好了，见 brief.md", 0, {
      route: {
        record: record({ turn_id: "t0", trigger_message_id: "r0", chain_id: "t0", feedback: [{ message_id: "m-note0", body: "格式不对", created_at: at(5) }] }),
        review: null,
        learning: null,
      },
    } as Partial<TaskTraceNode>),
    ...round(1, "分镜草图什么时候能出", "今天下午", 10, { ticket_id: "tk-1" }),
    ...round(2, "出 12 格分镜", "分镜交给你", 20),
    node({
      turn_id: "t2a",
      session_id: "direct-1",
      actor: "bot-2",
      woken_by_turn_id: "t2",
      trigger_message_id: "a2",
      focus_message_id: "b2",
      summary: "12 格已画完",
      created_at: at(24),
      ticket_id: "tk-1",
      artifacts: [{ path: BOARD, message_id: "b2", attachment_id: "att-1" }],
    }),
    node({ turn_id: "user:r3", actor: USER_MEMBER, trigger_message_id: "r3", focus_message_id: "r3", summary: "再加一版配乐", created_at: at(30) }),
    node({
      turn_id: "t3",
      woken_by_turn_id: "user:r3",
      trigger_message_id: "r3",
      focus_message_id: "a3",
      summary: "配乐交给分镜师",
      created_at: at(31),
      route: {
        record: record({ feedback: [{ message_id: "m-note", body: "又漏了镜头", created_at: at(36) }] }),
        review: {
          chain_id: "t3",
          turn_id: "t3",
          session_id: "group-1",
          bot_id: "bot-1",
          signature: "coding",
          model: "grok-4.7",
          thinking_level: "high",
          fault: "model",
          direction: "stronger",
          rounds: 2,
          confidence: 0.9,
          reason: "两次都漏了镜头",
          created_at: at(37),
          retired_at: null,
          effect: null,
        },
        learning: { chain_id: "t3", bot_id: "bot-1", session_id: "group-1", kind: "memory", label: "分镜质检标准", created_at: at(38), outcome: null },
        marked_model: false,
      },
    } as Partial<TaskTraceNode>),
    node({
      turn_id: "t3a",
      session_id: "direct-1",
      actor: "bot-2",
      status: "waiting_approval",
      woken_by_turn_id: "t3",
      trigger_message_id: "a3",
      focus_message_id: "b3",
      summary: "正在写配乐",
      created_at: at(32),
      ticket_id: "tk-2",
      artifacts: SCORE.map((path, index) => ({ path, message_id: "b3", attachment_id: `att-${index + 2}` })),
      approval: { message_id: "m-approval", summary: "写入工作区外" },
      route: {
        record: record({
          turn_id: "t3a",
          session_id: "direct-1",
          bot_id: "bot-2",
          model: "gemini-3.8",
          thinking_level: "medium",
          signature: "writing",
          outcome: null as never,
          finished_at: null as never,
          reason: null as never,
          chain_id: "t3a",
          hops: null as never,
          tool_calls: null as never,
          tool_errors: null as never,
        }),
        review: null,
        learning: null,
      },
    } as Partial<TaskTraceNode>),
  ];
  const steps: TraceStep[] = [
    step({ id: "s1", role: "reader", message_id: "r3", turn_id: null, created_at: at(30, 5) }),
    step({ id: "s2", role: "reader", turn_id: "t3", outcome: "failed", fail_kind: "timeout", created_at: at(31, 20) }),
  ];
  return { id: "task-1", dir: "work/先出分镜-7f3k", title: "先出分镜", session_id: "group-1", closed_at: null, nodes, steps };
}

function detail(): TaskDetail {
  const ticket = (seq: number, title: string, worker: string | null) => ({
    id: `tk-${seq}`,
    task_id: "task-1",
    seq,
    title,
    slug: `0${seq}-${title}`,
    dir: `work/先出分镜-7f3k/0${seq}-${title}`,
    spec: "",
    status: "doing",
    worker,
    created_at: at(0),
    updated_at: at(20),
    closed_at: null,
    artifacts: [],
  });
  return {
    id: "task-1",
    dir: "work/先出分镜-7f3k",
    title: "先出分镜",
    session_id: "group-1",
    closed_at: null,
    last_activity_at: at(35),
    goal: "先出分镜的草图和配乐",
    kind: "分镜",
    status: "active",
    ticket_counts: { todo: 0, doing: 2, review: 0, done: 0, parked: 0 },
    brief: "先出分镜",
    spec: null,
    spec_updated_at: at(0),
    revision: 1,
    revision_actor: "app",
    routine_id: null,
    tickets: [ticket(1, "分镜草图", "bot-2"), ticket(2, "配乐", "bot-2")],
  } as unknown as TaskDetail;
}

export default function Trace() {
  const failing = signal(false);
  const empty = signal(false);
  const log = signal<string[]>([]);
  const focus = signal<{ token: number; turn: string | null }>({ token: 0, turn: null });
  let handle: TraceViewHandle | null = null;
  const note = (line: string) => log.set([...log(), line]);

  const api = {
    sessionTasks: async () => [
      { id: "task-1", dir: "work/先出分镜-7f3k", title: "先出分镜", session_id: "group-1", closed_at: null, last_activity_at: at(35), goal: null, kind: null, status: "active", ticket_counts: { todo: 0, doing: 2, review: 0, done: 0, parked: 0 } },
    ],
    taskTrace: async () => {
      if (failing()) throw new Error("nope");
      return empty() ? { ...fullTrace(), nodes: [], steps: [] } : fullTrace();
    },
    taskDetail: async () => detail(),
    markTurnModel: async (turnId: string, marked: boolean) => {
      note(`marked:${turnId}=${marked}`);
    },
  } as unknown as MessengerApi;

  const job = new JobState({ api: () => api, sessionId: () => "group-1", taskId: () => "task-1", line: () => null });
  void job.load("task-1");
  const openGroup = () => (job.trace && job.openStep ? (attachSteps(job.trace.nodes, job.trace.steps ?? []).groups.find((row) => row.id === job.openStep) ?? null) : null);

  return (
    <View class="flex-1 bg-pane">
      <View class="flex-row flex-wrap items-center gap-[8px] p-[8px] border-b border-line">
        <Button
          testID="story-fail"
          size="sm"
          variant="secondary"
          onPress={() => {
            failing.set(true);
            void job.load("task-1");
  const openGroup = () => (job.trace && job.openStep ? (attachSteps(job.trace.nodes, job.trace.steps ?? []).groups.find((row) => row.id === job.openStep) ?? null) : null);
          }}
        >
          fail
        </Button>
        <Button testID="story-heal" size="sm" variant="secondary" onPress={() => failing.set(false)}>
          heal
        </Button>
        <Button
          testID="story-empty"
          size="sm"
          variant="secondary"
          onPress={() => {
            empty.set(true);
            void job.load("task-1");
  const openGroup = () => (job.trace && job.openStep ? (attachSteps(job.trace.nodes, job.trace.steps ?? []).groups.find((row) => row.id === job.openStep) ?? null) : null);
          }}
        >
          empty
        </Button>
        <Button testID="story-focus" size="sm" variant="secondary" onPress={() => focus.set({ token: focus().token + 1, turn: "t1" })}>
          focus
        </Button>
        <Button testID="story-ticket" size="sm" variant="secondary" onPress={() => void handle?.showTicket("tk-1")}>
          ticket
        </Button>
        <Text testID="story-log" class="text-[12px] text-ink-muted">
          {log().join(" ")}
        </Text>
      </View>
      <View class="flex-1 min-h-0 flex-row">
        <View class="flex-1 min-w-0">
        <TraceView
          api={api}
          job={job}
          taskId="task-1"
          focus={focus().turn ? { messageId: "a1", turnId: focus().turn } : null}
          focusToken={focus().token}
          sessionId="group-1"
          activeSessionId="group-1"
          sessions={SESSIONS}
          bots={BOTS}
          youLabel="你"
          deletedLabel="已删除"
          onJump={(session, message) => note(`jump:${session}/${message}`)}
          onOpenArtifact={(relpath, _att, _message, bundle, _task, siblings) => note(`artifact:${relpath}|${siblings?.length ?? 0}|${bundle ? "tree" : "file"}`)}
          onHandle={(next) => (handle = next)}
        />
        </View>
        {/* What the job around the board does for a step picked on it: its panel, beside the board. */}
        <If when={openGroup()}>
          {(group: () => NonNullable<ReturnType<typeof openGroup>>) => (
            <View class="w-[300px] border-l border-line">
              <TraceStepDetail
                group={group()}
                fetchRun={async () => ({ raw: JSON.stringify({ passed: false, why: "超时" }) }) as CallRun}
                onJump={(session, message) => note(`jump:${session}/${message}`)}
                callEditor={(role) => <Text testID="story-call-editor">{role}</Text>}
                onClose={() => (job.openStep = null)}
              />
            </View>
          )}
        </If>
      </View>
    </View>
  );
}
