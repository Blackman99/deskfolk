/**
 * What the TaskTrace tests share: the cast, a job and its detail, the pictures they draw, and
 * `open`, which renders the board or its pane with the host's callbacks recorded.
 */
import { readFileSync } from "node:fs";
import { flushSync } from "svelte";
import { USER_MEMBER, type AcceptanceCheck, type Hold, type PlanRequirement, type RouteRecord, type SessionTaskSummary, type TaskDetail, type TaskTrace } from "@real-bot/protocol";
import { mockMonacoCss } from "../test-mocks.ts";

mockMonacoCss();
const { default: TaskTraceView } = await import("./TaskTrace.svelte");
const { default: TraceView } = await import("./TraceView.svelte");
import { copyFor } from "../copy.ts";
import { forgetTraceMinimap, loadTraceMinimap } from "./trace-minimap.ts";
import { forgetSpentAsks, forgetTraceView, loadTraceView, saveTraceView, type TraceViewAsk, type TraceViewKind } from "./trace-view.ts";
import { forgetKeptBoards } from "./task-trace.ts";
import { aBot, aDirect, aGroup, aHold } from "../test-fixtures.ts";
import { buttonByText, click, press, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { settle } from "../test-async.ts";

const t = copyFor("zh");

export const writer = aBot({ id: "bot-1", name: "制片" });
export const artist = aBot({ id: "bot-2", name: "分镜师" });
export const group = aGroup({ id: "group-1", name: "制作组" });
export const direct = aDirect({
  id: "direct-1",
  participants: [
    { member: "bot-1", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
    { member: "bot-2", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
  ],
});

export function job(over: Partial<SessionTaskSummary> = {}): SessionTaskSummary {
  return {
    id: "task-1",
    dir: "work/先出分镜-7f3k",
    title: "先出分镜",
    session_id: "group-1",
    closed_at: null,
    last_activity_at: "2026-09-22T00:00:00.000Z",
    goal: null,
    kind: null,
    status: "active",
    ticket_counts: { todo: 0, doing: 0, review: 0, done: 0, parked: 0 },
    ...over,
  };
}

/** The plan behind task-1 once the organizer has run: a spec, two tickets, one with a file. */
export function detail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...job({ goal: "先出分镜的草图和配乐", kind: "分镜", ticket_counts: { todo: 1, doing: 1, review: 0, done: 0, parked: 0 } }),
    brief: "先出分镜",
    spec: {
      kind: "分镜",
      goal: "先出分镜的草图和配乐",
      acceptance: ["12 格草图交到 board.pdf"],
      rules: ["不要真人"],
      process: ["分镜师画，制片审"],
      progress: { done: [], open: ["草图"], blocked: [] },
      status: "active",
    },
    spec_updated_at: "2026-09-22T00:00:03.000Z",
    revision: 2,
    revision_actor: "app",
    routine_id: null,
    tickets: [
      {
        id: "tk-1",
        task_id: "task-1",
        seq: 1,
        title: "分镜草图",
        slug: "01-分镜草图",
        dir: "work/先出分镜-7f3k/01-分镜草图",
        spec: "画满 12 格",
        status: "doing",
        worker: "bot-2",
        created_at: "2026-09-22T00:00:00.000Z",
        updated_at: "2026-09-22T00:00:03.000Z",
        closed_at: null,
        artifacts: [{ path: "work/先出分镜-7f3k/01-分镜草图/board.pdf", message_id: "m3", attachment_id: "a1" }],
      },
      {
        id: "tk-2",
        task_id: "task-1",
        seq: 2,
        title: "配乐",
        slug: "02-配乐",
        dir: "work/先出分镜-7f3k/02-配乐",
        spec: "",
        status: "todo",
        worker: null,
        created_at: "2026-09-22T00:00:00.000Z",
        updated_at: "2026-09-22T00:00:00.000Z",
        closed_at: null,
        artifacts: [],
      },
    ],
    ...over,
  };
}

export function picture(): TaskTrace {
  return {
    id: "task-1",
    dir: "work/先出分镜-7f3k",
    title: "先出分镜",
    session_id: "group-1",
    closed_at: null,
    nodes: [
      {
        turn_id: "user:m1",
        session_id: "group-1",
        actor: USER_MEMBER,
        status: "completed",
        woken_by_turn_id: null,
        woken_elsewhere: null,
        ticket_id: null,
        trigger_message_id: "m1",
        focus_message_id: "m1",
        summary: "先出分镜",
        created_at: "2026-09-22T00:00:00.000Z",
        artifacts: [],
        ask: null,
        approval: null,
        passed: 0,
      },
      {
        turn_id: "t-writer",
        session_id: "group-1",
        actor: "bot-1",
        status: "completed",
        woken_by_turn_id: "user:m1",
        woken_elsewhere: null,
        ticket_id: null,
        trigger_message_id: "m1",
        focus_message_id: "m2",
        summary: "分镜交给你",
        created_at: "2026-09-22T00:00:01.000Z",
        artifacts: [],
        ask: null,
        approval: null,
        passed: 0,
      },
      {
        turn_id: "t-artist",
        session_id: "direct-1",
        actor: "bot-2",
        status: "running",
        woken_by_turn_id: "t-writer",
        woken_elsewhere: null,
        ticket_id: "tk-1",
        trigger_message_id: "m2",
        focus_message_id: "m3",
        summary: "正在画第一格",
        created_at: "2026-09-22T00:00:02.000Z",
        artifacts: [{ path: "work/先出分镜-7f3k/01-分镜草图/board.pdf", message_id: "m3", attachment_id: "a1" }],
        ask: null,
        approval: { message_id: "m-approval", summary: "写入工作区外" },
        passed: 0,
      },
    ],
  };
}

/** Press a handle and pull it by (x, y), the way a corner is dragged. */
export function drag(el: Element, by: { x: number; y: number }): void {
  const from = { clientX: 400, clientY: 400 };
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ...from }));
  window.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      clientX: from.clientX + by.x,
      clientY: from.clientY + by.y,
    }),
  );
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  flushSync();
}

export type Opened = { relpath: string; messageId: string | null | undefined; forceTree: boolean | undefined; taskId: string | null | undefined; siblings: number };

export function open(opts: {
  taskId?: string | null;
  fail?: boolean;
  sessionId?: string;
  writeBack?: boolean;
  trace?: TaskTrace;
  /** What task-2's trace is; an empty one by default. */
  otherTrace?: TaskTrace;
  /** What the plan endpoint answers; `false` is a daemon that predates plans (404). */
  detail?: TaskDetail | false;
  focus?: { messageId: string; turnId: string | null } | null;
  focusToken?: number;
  /** Mount the board itself, the way a pane does, instead of the phone's page around it. */
  pane?: boolean;
  /** The one view a tab shows. */
  fixedView?: TraceViewKind;
  ask?: TraceViewAsk | null;
  askToken?: number;
  /** The jobs the session lists, newest first; the two stock ones by default. */
  jobs?: SessionTaskSummary[];
} = {}) {
  const jumps: Array<[string, string]> = [];
  const settled: string[] = [];
  const opened: Opened[] = [];
  const patched: Array<[string, Record<string, unknown>]> = [];
  let closed = 0;
  const asked: string[] = [];
  const shown: Array<[TraceViewKind, string | null, TraceViewAsk]> = [];
  const api = {
    sessionTasks: async (sessionId: string) => {
      asked.push(sessionId);
      if (sessionId === "direct-9") return [job({ id: "task-9", title: "另一件事" })];
      if (opts.fail) throw new Error("nope");
      if (opts.jobs) return opts.jobs;
      return [job({ goal: opts.detail === false ? null : "先出分镜的草图和配乐" }), job({ id: "task-2", title: "上周的排期", closed_at: "2026-09-15T00:00:00.000Z", status: "done" })];
    },
    taskTrace: async (id: string) =>
      id === "task-1"
        ? (opts.trace ?? picture())
        : id === "task-2" && opts.otherTrace
          ? opts.otherTrace
          : { ...picture(), id, title: id === "task-9" ? "另一件事" : "上周的排期", nodes: [] },
    taskDetail: async (id: string) => {
      if (opts.detail === false) throw Object.assign(new Error("not found"), { status: 404 });
      if (id === "task-1") return opts.detail ?? detail();
      return { ...detail(), ...job({ id, title: id === "task-9" ? "另一件事" : "上周的排期" }), spec: null, revision: 0, revision_actor: null, tickets: [] };
    },
    taskSpecRevisions: async () => [],
    patchTaskSpec: async (id: string, body: Record<string, unknown>) => {
      patched.push([id, body]);
      return { ...detail(), revision: 3, revision_actor: "user" as const };
    },
    patchTicket: async (id: string, body: Record<string, unknown>) => {
      patched.push([id, body]);
      return { ...detail().tickets[0]!, ...body };
    },
    getWorkspaceFileBlob: async () => new Blob(["# 分镜"]),
  };
  const props = reactive({
    api: api as never,
    taskId: opts.taskId === undefined ? "task-1" : opts.taskId,
    focus: opts.focus ?? null,
    focusToken: opts.focusToken ?? 0,
    sessionId: opts.sessionId ?? "group-1",
    activeSessionId: "group-1",
    sessions: [group, direct],
    bots: [writer, artist],
    youLabel: "你",
    deletedLabel: "已删除",
    workspacePath: "/work",
    t,
    reloadToken: 0,
    onClose: () => (closed += 1),
    onJump: (sessionId: string, messageId: string) => jumps.push([sessionId, messageId]),
    onTask: (taskId: string) => {
      settled.push(taskId);
      // What a pane does: the tab records the job on screen, which comes back as the prop.
      if (opts.writeBack) props.taskId = taskId;
    },
    onOpenArtifact: (relpath: string, _att?: unknown, messageId?: string | null, forceTree?: boolean, taskId?: string | null, siblings?: unknown[] | null) => {
      opened.push({ relpath, messageId, forceTree, taskId, siblings: siblings?.length ?? 0 });
    },
    ...(opts.fixedView
      ? {
          fixedView: opts.fixedView,
          ask: opts.ask ?? null,
          askToken: opts.askToken ?? 0,
          onShowView: (next: TraceViewKind, taskId: string | null, wanted: TraceViewAsk) => shown.push([next, taskId, wanted]),
        }
      : {}),
  });
  const view = render(opts.pane ? TraceView : TaskTraceView, props as never);
  return { ...view, props, jumps, asked, settled, opened, patched, shown, closed: () => closed };
}

/** Let a press's awaits (the panel swap, the scroll after it) run out, then flush what they changed. */

export async function until(host: HTMLElement, selector: string): Promise<Element> {
  for (let i = 0; i < 20; i += 1) {
    const found = host.querySelector(selector);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`never saw ${selector}`);
}

export function aRecord(over: Partial<RouteRecord> = {}): RouteRecord {
  return {
    turn_id: "t-writer",
    session_id: "group-1",
    bot_id: "bot-1",
    trigger_message_id: "m1",
    provider_id: null,
    model: "grok-4.7",
    thinking_level: "high",
    signature: "coding",
    outcome: "completed",
    fail_kind: null,
    reason: "要改很多文件，用最强的",
    chain_id: "t-writer",
    created_at: "2026-09-22T00:00:01.000Z",
    finished_at: "2026-09-22T00:04:38.000Z",
    hops: 16,
    tool_calls: 20,
    tool_errors: 0,
    repeated_failures: 0,
    files_written: 3,
    feedback: [],
    ...over,
  };
}

/** The same job, with the model each Bot turn ran on and what came of it riding on its card. */
export function routedPicture(): TaskTrace {
  const base = picture();
  const [you, writerTurn, artistTurn] = base.nodes;
  return {
    ...base,
    nodes: [
      { ...you!, route: null },
      {
        ...writerTurn!,
        route: {
          record: aRecord({ feedback: [{ message_id: "m-note", body: "又漏了镜头", created_at: "2026-09-22T00:05:00.000Z" }] }),
          review: {
            chain_id: "t-writer",
            turn_id: "t-writer",
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
            created_at: "2026-09-22T00:06:00.000Z",
            retired_at: null,
            effect: null,
          },
          learning: { chain_id: "t-writer", bot_id: "bot-1", session_id: "group-1", kind: "memory", label: "分镜质检标准", created_at: "2026-09-22T00:07:00.000Z", outcome: null },
        },
      },
      {
        ...artistTurn!,
        route: {
          record: aRecord({ turn_id: "t-artist", session_id: "direct-1", bot_id: "bot-2", model: "gemini-3.8", thinking_level: "medium", signature: "writing", outcome: null, finished_at: null, reason: null, chain_id: "t-artist", hops: null, tool_calls: null, tool_errors: null }),
          review: null,
          learning: null,
        },
      },
    ],
  };
}

/**
 * happy-dom reports every element as zero-sized, so the pane would never measure anything and a
 * test could not tell a kept measurement from a lost one. Give cards a height that depends on
 * what is in them, which is what the real one does.
 */
export function withMeasuredCards(run: () => Promise<void>): Promise<void> {
  const descriptors = ["offsetHeight", "offsetWidth"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
  ] as const);
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      // Even heights, so a centred card lands on whole pixels whatever its text length.
      return this.classList.contains("trace-slot") ? 80 + 2 * (this.textContent?.length ?? 0) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("trace-slot") ? 248 : 0;
    },
  });
  return run().finally(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  });
}
