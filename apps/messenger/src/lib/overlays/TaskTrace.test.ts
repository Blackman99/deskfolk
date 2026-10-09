import { afterEach, expect, mock, test } from "bun:test";
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

// A board left in one test would otherwise come back where that test left it in the next.
afterEach(() => {
  forgetKeptBoards();
  forgetTraceMinimap();
  forgetSpentAsks();
});

const writer = aBot({ id: "bot-1", name: "制片" });
const artist = aBot({ id: "bot-2", name: "分镜师" });
const group = aGroup({ id: "group-1", name: "制作组" });
const direct = aDirect({
  id: "direct-1",
  participants: [
    { member: "bot-1", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
    { member: "bot-2", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
  ],
});

function job(over: Partial<SessionTaskSummary> = {}): SessionTaskSummary {
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
function detail(over: Partial<TaskDetail> = {}): TaskDetail {
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

function picture(): TaskTrace {
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
function drag(el: Element, by: { x: number; y: number }): void {
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

type Opened = { relpath: string; messageId: string | null | undefined; forceTree: boolean | undefined; taskId: string | null | undefined; siblings: number };

function open(opts: {
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

async function until(host: HTMLElement, selector: string): Promise<Element> {
  for (let i = 0; i < 20; i += 1) {
    const found = host.querySelector(selector);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`never saw ${selector}`);
}

function aRecord(over: Partial<RouteRecord> = {}): RouteRecord {
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
function routedPicture(): TaskTrace {
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

test("each Bot card says which model its turn ran on, and unfolds what came of it in place", async () => {
  const view = open({ trace: routedPicture() });
  await until(view.host, ".trace-slot");
  const cardOf = (who: string) =>
    [...view.host.querySelectorAll<HTMLElement>(".trace-card")].find((card) => card.querySelector(".trace-card-who")?.textContent?.trim() === who)!;
  // Your own card ran on no model.
  expect(cardOf("你").querySelector(".trace-route-btn")).toBeNull();
  const line = cardOf("制片").querySelector<HTMLButtonElement>(".trace-route-btn")!;
  expect(line.querySelector(".trace-route-model")?.textContent).toBe("grok-4.7");
  expect(line.querySelector(".trace-route-meta")?.textContent).toBe("思考 高 · 写代码");
  expect(line.querySelector(".trace-route-flag.is-blamed")).not.toBeNull();
  expect(line.querySelector(".trace-route-flag.is-feedback")?.textContent?.trim()).toBe("1");
  expect(cardOf("分镜师").querySelector(".trace-route-flag")).toBeNull();
  expect(view.host.querySelector(".trace-route")).toBeNull();

  click(line);
  flushSync();
  const detail = view.host.querySelector<HTMLElement>(".trace-slot .trace-route")!;
  expect(line.getAttribute("aria-expanded")).toBe("true");
  expect(detail.querySelector(".trace-route-outcome")?.textContent).toBe("完成");
  expect(detail.querySelector(".trace-route-why")?.textContent).toContain("要改很多文件，用最强的");
  expect(detail.querySelector(".trace-route-stats")?.textContent).toContain("16 跳 · 0 次工具错误");
  expect(detail.querySelector(".trace-route-review")?.classList.contains("is-model")).toBe(true);
  expect(detail.querySelector(".trace-route-review")?.textContent).toContain("该更强");
  expect(detail.querySelector(".trace-route-learning")?.textContent).toBe("记下了：分镜质检标准");
  // A note of yours about the model jumps back to where you said it.
  click(detail.querySelector(".trace-route-note"));
  expect(view.jumps).toEqual([["group-1", "m-note"]]);
  // It unfolds under its own card, and only one at a time.
  click(cardOf("分镜师").querySelector(".trace-route-btn"));
  flushSync();
  expect(view.host.querySelectorAll(".trace-route")).toHaveLength(1);
  expect(view.host.querySelector(".trace-route-outcome")?.textContent).toBe("进行中");
  click(view.host.querySelector(".trace-route-close"));
  flushSync();
  expect(view.host.querySelector(".trace-route")).toBeNull();
  view.close();
});

test("the toolbar lights the cards you pushed back on, or whose review blamed the model, and dims the rest", async () => {
  const view = open({ trace: routedPicture() });
  await until(view.host, ".trace-slot");
  const chip = (label: string) =>
    [...view.host.querySelectorAll<HTMLButtonElement>(".trace-highlight")].find((b) => b.textContent?.includes(label))!;
  expect(chip("有反馈").textContent).toContain("1");
  expect(chip("归咎模型").textContent).toContain("1");
  click(chip("归咎模型"));
  flushSync();
  expect(chip("归咎模型").getAttribute("aria-pressed")).toBe("true");
  // The whole job stays on the board; only what matches is lit.
  expect(view.host.querySelectorAll(".trace-card")).toHaveLength(3);
  expect(view.host.querySelectorAll(".trace-card.is-lit")).toHaveLength(1);
  expect(view.host.querySelectorAll(".trace-card.is-dim")).toHaveLength(2);
  click(chip("归咎模型"));
  flushSync();
  expect(view.host.querySelectorAll(".trace-card.is-lit, .trace-card.is-dim")).toHaveLength(0);
  view.close();
});

test("a job with no model trouble offers no highlight to look for it", async () => {
  const view = open();
  await until(view.host, ".trace-slot");
  expect(view.host.querySelector(".trace-highlight")).toBeNull();
  view.close();
});

test("the flow runs top to bottom, a card jumps to its turn, and a file hands over to the host's preview", async () => {
  const view = open();
  await until(view.host, ".trace-slot");
  // Cards sit where the layout put them, so reading order is the y they were given.
  const byRow = [...view.host.querySelectorAll<HTMLElement>(".trace-slot")]
    .map((slot) => ({
      top: Number.parseInt(slot.style.top, 10),
      who: slot.querySelector(".trace-card-who")?.textContent?.trim(),
    }))
    .sort((a, b) => a.top - b.top);
  expect(byRow.map((row) => row.who)).toEqual(["你", "制片", "分镜师"]);
  const faces = [...view.host.querySelectorAll(".trace-avatar")];
  expect(faces).toHaveLength(3);
  expect(faces[0]?.classList.contains("is-you")).toBe(true);
  expect(faces[0]?.querySelector("img")).toBeNull();
  expect(faces[1]?.querySelector("img")?.getAttribute("src")).toBe(writer.avatar);
  expect(faces[2]?.querySelector("img")?.getAttribute("src")).toBe(artist.avatar);
  expect(new Set(byRow.map((row) => row.top)).size).toBe(3);
  // Every handoff is a drawn curve now, not a divider between rows.
  const edges = [...view.host.querySelectorAll(".trace-edges path")];
  expect(edges).toHaveLength(2);
  expect(edges.every((edge) => (edge.getAttribute("d") ?? "").includes("C"))).toBe(true);
  expect(view.host.querySelector(".trace-card.is-running .trace-summary")?.textContent).toBe("正在画第一格");
  expect(view.host.querySelector(".trace-card.is-completed")).not.toBeNull();
  expect(view.host.querySelector(".trace-card.is-running")).not.toBeNull();
  // Dark mode washes a 35% green and a 35% teal into the same grey, so a finished card and a live
  // one could not be told apart. The border is the solid status colour.
  const palette = document.createElement("style");
  palette.textContent = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");
  const previousTheme = document.documentElement.getAttribute("data-theme");
  document.head.append(palette);
  document.documentElement.dataset.theme = "dark";
  try {
    expect(getComputedStyle(view.host.querySelector(".trace-card.is-completed")!).borderTopColor).toBe("#22c55e");
    expect(getComputedStyle(view.host.querySelector(".trace-card.is-running")!).borderTopColor).toBe("#45b0c3");
    expect(getComputedStyle(view.host.querySelector(".trace-card.is-running")!).borderLeftColor).toBe("#45b0c3");
  } finally {
    palette.remove();
    if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", previousTheme);
  }
  // The node that lives in the conversation on screen is marked as the one you are on.
  expect(view.host.querySelectorAll(".trace-card.is-here")).toHaveLength(2);
  // The job's own conversation is named once, in the header; only the card from elsewhere says where.
  expect(view.host.querySelector(".trace-meta")?.textContent).toContain("群 · 制作组");
  const places = [...view.host.querySelectorAll(".trace-place")];
  expect(places).toHaveLength(1);
  expect(places[0]?.closest(".trace-card")?.classList.contains("is-running")).toBe(true);
  // Your own card carries no status: it was sent.
  expect(view.host.querySelectorAll(".trace-status")).toHaveLength(2);

  click(view.host.querySelector(".trace-card.is-running .trace-card-main"));
  expect(view.jumps).toEqual([["direct-1", "m-approval"]]);

  // The board draws no file of its own: the host's preview opens it, in this plan's tree.
  click(view.host.querySelector<HTMLButtonElement>(".trace-file")!);
  expect(view.opened).toEqual([{ relpath: "work/先出分镜-7f3k/01-分镜草图/board.pdf", messageId: "m3", forceTree: false, taskId: "task-1", siblings: 1 }]);
  expect(view.host.querySelector(".artifact-pane")).toBeNull();
  view.close();
});

test("a phone shows the flow as a page that fills the screen", async () => {
  const previous = window.matchMedia;
  let view: ReturnType<typeof open> | undefined;
  window.matchMedia = ((query: string) => ({
    // Reduced motion keeps the page from sliding out, which this environment cannot finish.
    matches: query.includes("680") || query.includes("reduce"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
    onchange: null,
  })) as unknown as typeof window.matchMedia;
  try {
    view = open();
    await until(view.host, ".trace-slot");
    const page = view.host.querySelector(".trace-page");
    expect(page).not.toBeNull();
    expect(page?.getAttribute("aria-modal")).toBe("true");
    // Nothing places the board itself any more: on a phone it is a page, and on a wide window a
    // pane, whose size is the workbench's business rather than this component's.
    const pane = view.host.querySelector(".trace-pane") as HTMLElement;
    expect(pane.style.left).toBe("");
    expect(pane.style.width).toBe("");
  } finally {
    try { view?.close(); } catch { /* the page slide has nothing to animate here */ }
    window.matchMedia = previous;
  }
});

test("switching the conversation reloads that conversation's job", async () => {
  const asked: string[] = [];
  const Harness = (await import("./TaskTraceHarness.svelte")).default;
  const view = render(Harness, {
    api: {
      sessionTasks: async (sessionId: string) => {
        asked.push(sessionId);
        return sessionId === "direct-9" ? [job({ id: "task-9", title: "另一件事" })] : [job()];
      },
      taskTrace: async (id: string) =>
        id === "task-1" ? picture() : { ...picture(), id, title: "另一件事", nodes: [] },
    } as never,
    sessions: [group, direct],
    bots: [writer, artist],
    t,
  });
  await until(view.host, ".trace-slot");
  click(view.host.querySelector("[data-switch]"));
  await until(view.host, ".trace-empty");
  expect(asked).toContain("direct-9");
  expect(view.host.querySelector(".trace-titles h2")?.textContent).toContain("另一件事");
  view.close();
});

test("the switcher opens another job from this session", async () => {
  const view = open();
  const trigger = await until(view.host, ".trace-title-trigger");
  click(trigger);
  await until(view.host, ".trace-job");
  const jobBtn = [...view.host.querySelectorAll<HTMLButtonElement>(".trace-job")].find((b) =>
    b.textContent?.includes("上周的排期")
  )!;
  click(jobBtn);
  await until(view.host, ".trace-empty");
  expect(view.host.querySelector(".trace-titles h2")?.textContent).toContain("上周的排期");
  view.close();
});

/** A job that was one question and its answer: closed, no tickets, one turn. */
function oneShot(id: string, title: string): SessionTaskSummary {
  return job({ id, title, status: "done", closed_at: "2026-09-15T00:00:00.000Z", turn_count: 1 });
}

function jobRows(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".trace-job")].map((row) => row.querySelector(".trace-job-title")?.textContent?.trim() ?? "");
}

test("the switcher folds the one-question jobs into a single row that unfolds in place, and the job on screen never folds", async () => {
  const view = open({
    jobs: [
      job({ turn_count: 6 }),
      oneShot("task-2", "几点了"),
      job({ id: "task-3", title: "上周的排期", status: "done", closed_at: "2026-09-15T00:00:00.000Z", turn_count: 4 }),
      oneShot("task-4", "翻译一句话"),
      // Still going: not folded, however short.
      job({ id: "task-5", title: "刚开的", turn_count: 1 }),
      // A ticket makes it work, not a question.
      job({ id: "task-6", title: "有任务的", status: "done", turn_count: 1, ticket_counts: { todo: 0, doing: 0, review: 0, done: 1, parked: 0 } }),
    ],
  });
  click(await until(view.host, ".trace-title-trigger"));
  await until(view.host, ".trace-job");
  expect(jobRows(view.host)).toEqual(["先出分镜", "上周的排期", "刚开的", "有任务的", t.plan.oneShotJobs(2)]);
  const fold = view.host.querySelector<HTMLButtonElement>(".trace-job.is-fold")!;
  expect(t.plan.oneShotJobs(2)).toBe("一问一答 2 件");
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  // Folding does not choose a job: only the first read of the board has said which is on screen.
  click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(view.settled).toEqual(["task-1"]);
  expect(jobRows(view.host)).toEqual(["先出分镜", "上周的排期", "刚开的", "有任务的", t.plan.oneShotJobs(2), "几点了", "翻译一句话"]);
  // A folded job opens like any other.
  click([...view.host.querySelectorAll<HTMLButtonElement>(".trace-job")].find((row) => row.textContent?.includes("翻译一句话")));
  await until(view.host, ".trace-empty");
  expect(view.settled).toEqual(["task-1", "task-4"]);
  view.close();
});

test("the job on screen stays in the list when it is itself a one-question job; no fold row for none", async () => {
  const view = open({ taskId: "task-2", jobs: [job(), oneShot("task-2", "几点了"), oneShot("task-4", "翻译一句话")] });
  click(await until(view.host, ".trace-title-trigger"));
  await until(view.host, ".trace-job");
  expect(jobRows(view.host)).toEqual(["先出分镜", "几点了", t.plan.oneShotJobs(1)]);
  expect(view.host.querySelector(".trace-job.is-current .trace-job-title")?.textContent).toBe("几点了");
  view.close();

  const plain = open({ jobs: [job(), job({ id: "task-3", title: "上周的排期", status: "done", turn_count: 3 })] });
  click(await until(plain.host, ".trace-title-trigger"));
  await until(plain.host, ".trace-job");
  expect(plain.host.querySelector(".trace-job.is-fold")).toBeNull();
  plain.close();
});

test("the arrow keys walk the switcher's rows, the fold row and the folded jobs among them", async () => {
  const view = open({ jobs: [job({ turn_count: 6 }), oneShot("task-2", "几点了"), oneShot("task-4", "翻译一句话")] });
  click(await until(view.host, ".trace-title-trigger"));
  await until(view.host, ".trace-job");
  const popover = view.host.querySelector(".trace-switcher-popover")!;
  expect(document.activeElement?.classList.contains("is-current")).toBe(true);
  press(popover, "ArrowDown");
  expect(document.activeElement?.classList.contains("is-fold")).toBe(true);
  click(document.activeElement);
  press(popover, "ArrowDown");
  expect(document.activeElement?.textContent).toContain("几点了");
  press(popover, "ArrowDown");
  expect(document.activeElement?.textContent).toContain("翻译一句话");
  press(popover, "ArrowDown");
  expect(document.activeElement?.classList.contains("is-current")).toBe(true);
  press(popover, "ArrowUp");
  expect(document.activeElement?.textContent).toContain("翻译一句话");
  view.close();
});

test("with no job asked for, the board opens on the newest job that was not a one-question one", async () => {
  const view = open({
    taskId: null,
    pane: true,
    jobs: [oneShot("task-2", "几点了"), oneShot("task-4", "翻译一句话"), job({ id: "task-3", title: "上周的排期", status: "done", closed_at: "2026-09-15T00:00:00.000Z", turn_count: 4 }), job()],
  });
  await until(view.host, ".trace-titles h2");
  for (let i = 0; i < 20 && view.settled.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(view.settled).toEqual(["task-3"]);
  view.close();

  // All of them one-question jobs: the newest, as before.
  const only = open({ taskId: null, pane: true, jobs: [oneShot("task-2", "几点了"), oneShot("task-4", "翻译一句话")] });
  for (let i = 0; i < 20 && only.settled.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(only.settled).toEqual(["task-2"]);
  only.close();
});

test("pointed at another job from outside, the board turns to it without a second read of its own", async () => {
  // A conversation has one board: a card or a link asking for another of its jobs changes the
  // job this board shows, rather than opening another board beside it.
  const view = open({ writeBack: true });
  await until(view.host, ".trace-slot");
  expect(view.settled).toEqual(["task-1"]);
  const reads = view.asked.length;

  view.props.taskId = "task-2";
  flushSync();
  await until(view.host, ".trace-empty");
  expect(view.host.querySelector(".trace-titles h2")?.textContent).toContain("上周的排期");
  expect(view.settled).toEqual(["task-1", "task-2"]);

  // The job it settled on coming back as the prop is not another request.
  expect(view.asked.length).toBe(reads + 1);
  view.close();
});

test("a session with nothing yet says so, and a failed read can be retried", async () => {
  const view = open({ taskId: null, fail: true });
  const failed = await until(view.host, ".trace-empty button");
  expect(view.host.textContent).toContain(t.trace.failed);
  click(failed);
  await until(view.host, ".trace-empty button");
  expect(view.asked.length).toBeGreaterThan(1);
  view.close();
});

/**
 * happy-dom reports every element as zero-sized, so the pane would never measure anything and a
 * test could not tell a kept measurement from a lost one. Give cards a height that depends on
 * what is in them, which is what the real one does.
 */
function withMeasuredCards(run: () => Promise<void>): Promise<void> {
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

// A smoke test, not a guard: happy-dom does not run the refetch the way the browser does, so it
// passes with the fix removed. What actually pins the behaviour is the overlap test in
// task-trace.test.ts, plus the two guards in the pane — measurements are kept across a reload of
// the same job, and every card is read back after each layout.
test("opening from a message centres that message's card", async () => {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("trace-viewport")) {
      return { x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON() { return {}; } } as DOMRect;
    }
    return rect.call(this);
  };
  try {
    await withMeasuredCards(async () => {
      const view = open({ focus: { messageId: "m3", turnId: "t-artist" }, focusToken: 1 });
      await until(view.host, ".trace-slot");
      await new Promise((resolve) => setTimeout(resolve, 60));
      flushSync();
      const flow = view.host.querySelector<HTMLElement>(".trace-flow")!;
      const card = [...view.host.querySelectorAll<HTMLElement>(".trace-card")].find((row) =>
        row.textContent?.includes("分镜师"),
      )!;
      expect(card.classList.contains("is-focus")).toBe(true);
      const slot = card.parentElement as HTMLElement;
      const moved = /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(flow.style.transform);
      expect(moved).not.toBeNull();
      const [tx, ty, scale] = moved!.slice(1).map(Number);
      const cx = Number.parseInt(slot.style.left, 10) + 124;
      const cy = Number.parseInt(slot.style.top, 10) + slot.offsetHeight / 2;
      expect(tx + cx * scale!).toBeCloseTo(400, 0);
      expect(ty + cy * scale!).toBeCloseTo(300, 0);
      // The same job fetched again is not another request to move.
      (view.props as { reloadToken: number }).reloadToken = 1;
      flushSync();
      await new Promise((resolve) => setTimeout(resolve, 60));
      flushSync();
      expect(flow.style.transform).toBe(`translate(${tx}px, ${ty}px) scale(${scale})`);

      // The board is already open, so another message slides there instead of cutting.
      const timers = new Map<number, () => void>();
      let nextTimer = 1;
      const setTimer = globalThis.setTimeout;
      const clearTimer = globalThis.clearTimeout;
      globalThis.setTimeout = ((fn: () => void) => {
        const id = nextTimer++;
        timers.set(id, fn);
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((id: number) => {
        timers.delete(id);
      }) as typeof clearTimeout;
      const realNow = performance.now.bind(performance);
      let clock = realNow();
      performance.now = () => clock;
      try {
        view.props.focus = { messageId: "m1", turnId: null };
        view.props.focusToken = 2;
        flushSync();
        const started = flow.style.transform;
        expect(started).toBe(`translate(${tx}px, ${ty}px) scale(${scale})`);
        for (let i = 0; i < 40 && timers.size > 0; i += 1) {
          clock += 20;
          const pending = [...timers.entries()];
          timers.clear();
          for (const [, fn] of pending) fn();
          flushSync();
        }
        const you = [...view.host.querySelectorAll<HTMLElement>(".trace-card")].find((row) =>
          row.querySelector(".trace-card-who")?.textContent?.trim() === "你",
        )!;
        expect(you.classList.contains("is-focus")).toBe(true);
        const landed = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(flow.style.transform)!;
        const slot = you.parentElement as HTMLElement;
        const x = Number.parseInt(slot.style.left, 10) + 124;
        const y = Number.parseInt(slot.style.top, 10) + slot.offsetHeight / 2;
        expect(Math.abs(Number(landed[1]) + x - 400)).toBeLessThanOrEqual(1);
        expect(Math.abs(Number(landed[2]) + y - 300)).toBeLessThanOrEqual(1);
        expect(flow.style.transform).not.toBe(started);
      } finally {
        performance.now = realNow;
        globalThis.setTimeout = setTimer;
        globalThis.clearTimeout = clearTimer;
      }
      view.close();
    });
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
});

test("a board still on the view it opened on slides to the card a message asks for, and stays there", async () => {
  // The slide's first step is a timer away. The same layout pass that started it used to find the
  // board still on its opening view and open it again, which put it back where it was.
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("trace-viewport")) {
      return { x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON() { return {}; } } as DOMRect;
    }
    return rect.call(this);
  };
  try {
    await withMeasuredCards(async () => {
      const view = open({ pane: true });
      await until(view.host, ".trace-slot");
      await new Promise((resolve) => setTimeout(resolve, 60));
      flushSync();
      const flow = view.host.querySelector<HTMLElement>(".trace-flow")!;
      const opened = flow.style.transform;
      const timers = new Map<number, () => void>();
      let nextTimer = 1;
      const setTimer = globalThis.setTimeout;
      const clearTimer = globalThis.clearTimeout;
      globalThis.setTimeout = ((fn: () => void) => {
        const id = nextTimer++;
        timers.set(id, fn);
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((id: number) => {
        timers.delete(id);
      }) as typeof clearTimeout;
      const realNow = performance.now.bind(performance);
      let clock = realNow();
      performance.now = () => clock;
      try {
        view.props.focus = { messageId: "m3", turnId: "t-artist" };
        view.props.focusToken = 5;
        flushSync();
        for (let i = 0; i < 40 && timers.size > 0; i += 1) {
          clock += 20;
          const pending = [...timers.entries()];
          timers.clear();
          for (const [, fn] of pending) fn();
          flushSync();
        }
      } finally {
        performance.now = realNow;
        globalThis.setTimeout = setTimer;
        globalThis.clearTimeout = clearTimer;
      }
      const card = [...view.host.querySelectorAll<HTMLElement>(".trace-card")].find((row) => row.textContent?.includes("分镜师"))!;
      expect(card.classList.contains("is-focus")).toBe(true);
      expect(flow.style.transform).not.toBe(opened);
      const landed = /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(flow.style.transform)!;
      const [tx, ty, scale] = landed.slice(1).map(Number);
      const slot = card.parentElement as HTMLElement;
      const x = Number.parseInt(slot.style.left, 10) + 124;
      const y = Number.parseInt(slot.style.top, 10) + slot.offsetHeight / 2;
      expect(Math.abs(tx! + x * scale! - 400)).toBeLessThanOrEqual(1);
      expect(Math.abs(ty! + y * scale! - 300)).toBeLessThanOrEqual(1);
      // A card measuring again afterwards does not open the board again either.
      (view.props as { reloadToken: number }).reloadToken = 1;
      flushSync();
      await new Promise((resolve) => setTimeout(resolve, 200));
      flushSync();
      expect(flow.style.transform).toBe(`translate(${tx}px, ${ty}px) scale(${scale})`);
      view.close();
    });
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
});

test("the board still lays out after the job is fetched again", async () => {
  // What the screenshot showed: a turn was still running, the trace refetched every few seconds,
  // and the cards ended up drawn on top of one another. The measured heights were being thrown
  // away on every new trace object, and a card whose size never changes never reports it again.
  await withMeasuredCards(async () => {
    const view = open();
    await until(view.host, ".trace-slot");
    // Let the first measurements land.
    await new Promise((resolve) => setTimeout(resolve, 60));
    flushSync();
    const tops = () =>
      [...view.host.querySelectorAll<HTMLElement>(".trace-slot")].map((slot) => slot.style.top);
    const measured = tops();
    expect(new Set(measured).size).toBe(measured.length);

    // The same job, fetched again — which is all a live turn does. Several bumps within a moment
    // are one read, a moment later.
    const reads = view.asked.length;
    (view.props as { reloadToken: number }).reloadToken = 1;
    flushSync();
    (view.props as { reloadToken: number }).reloadToken = 2;
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(view.asked.length).toBe(reads);
    await new Promise((resolve) => setTimeout(resolve, 200));
    flushSync();
    expect(view.asked.length).toBe(reads + 1);
    expect(tops()).toEqual(measured);
    view.close();
  });
});

test("a node with multiple attachments renders a single bundle button and opens through preview panel", async () => {
  const opened: Array<{
    relpath: string;
    att: any;
    messageId: string | null;
    forceTree: boolean;
    taskId: string | null;
    siblings: any[];
  }> = [];

  const multiTrace: TaskTrace = {
    id: "task-multi",
    dir: "work/2026-09-22-继续-qb3y",
    title: "继续",
    session_id: "group-1",
    closed_at: null,
    nodes: [
      {
        turn_id: "t-reviewer",
        session_id: "group-1",
        actor: "bot-1",
        status: "completed",
        woken_by_turn_id: null,
        woken_elsewhere: null,
        trigger_message_id: "m1",
        focus_message_id: "m1",
        summary: "【驳回重跑】EP01 v4 不能进 120 秒预演",
        created_at: "2026-09-22T00:00:00.000Z",
        artifacts: [
          { path: "work/2026-09-22-继续-qb3y/pair_01.jpg", message_id: "m1", attachment_id: "a1" },
          { path: "work/2026-09-22-继续-qb3y/pair_02.jpg", message_id: "m1", attachment_id: "a2" },
          { path: "work/2026-09-22-继续-qb3y/pair_03.jpg", message_id: "m1", attachment_id: "a3" },
          { path: "work/2026-09-22-继续-qb3y/pair_04.jpg", message_id: "m1", attachment_id: "a4" },
          { path: "work/2026-09-22-继续-qb3y/pair_05.jpg", message_id: "m1", attachment_id: "a5" },
        ],
        ask: null,
        approval: null,
        passed: 0,
      },
    ],
  };

  const props = reactive({
    api: {
      sessionTasks: async () => [job({ id: "task-multi", title: "继续" })],
      taskTrace: async () => multiTrace,
    } as never,
    taskId: "task-multi",
    sessionId: "group-1",
    activeSessionId: "group-1",
    sessions: [group],
    bots: [writer],
    youLabel: "你",
    deletedLabel: "已删除",
    workspacePath: "/work",
    t,
    reloadToken: 0,
    onClose: () => {},
    onJump: () => {},
    onOpenArtifact: (relpath: string, att: any, messageId: string | null, forceTree: boolean, taskId: string | null, siblings: any[]) => {
      opened.push({ relpath, att, messageId, forceTree, taskId, siblings });
    },
  });

  const view = render(TaskTraceView, props as never);
  await until(view.host, ".trace-slot");

  // There are 5 files, but ONLY 1 button is rendered (unified entry), not 5 buttons
  const buttons = view.host.querySelectorAll(".trace-file-btn");
  expect(buttons).toHaveLength(1);

  const btn = buttons[0] as HTMLButtonElement;
  expect(btn.classList.contains("is-bundle")).toBe(true);
  expect(btn.textContent).toContain("5 个文件");

  click(btn);
  expect(opened).toHaveLength(1);
  expect(opened[0].relpath).toBe("work/2026-09-22-继续-qb3y/pair_01.jpg");
  expect(opened[0].forceTree).toBe(true);
  expect(opened[0].taskId).toBe("task-multi");
  expect(opened[0].siblings).toHaveLength(5);
  expect(opened[0].messageId).toBe("m1");

  view.close();
});

test("a node with a single attachment renders 1 file button and opens through preview panel", async () => {
  const opened: Array<{
    relpath: string;
    att: any;
    messageId: string | null;
    forceTree: boolean;
    taskId: string | null;
    siblings: any[];
  }> = [];

  const singleTrace: TaskTrace = {
    id: "task-single",
    dir: "work/2026-09-22-继续-qb3y",
    title: "继续",
    session_id: "group-1",
    closed_at: null,
    nodes: [
      {
        turn_id: "t-single",
        session_id: "group-1",
        actor: "bot-1",
        status: "completed",
        woken_by_turn_id: null,
        trigger_message_id: "m1",
        focus_message_id: "m1",
        summary: "单个产物",
        created_at: "2026-09-22T00:00:00.000Z",
        artifacts: [
          { path: "work/2026-09-22-继续-qb3y/report.md", message_id: "m1", attachment_id: "a1" },
        ],
        ask: null,
        approval: null,
        passed: 0,
      },
    ],
  };

  const props = reactive({
    api: {
      sessionTasks: async () => [job({ id: "task-single", title: "继续" })],
      taskTrace: async () => singleTrace,
    } as never,
    taskId: "task-single",
    sessionId: "group-1",
    activeSessionId: "group-1",
    sessions: [group],
    bots: [writer],
    youLabel: "你",
    deletedLabel: "已删除",
    workspacePath: "/work",
    t,
    reloadToken: 0,
    onClose: () => {},
    onJump: () => {},
    onOpenArtifact: (relpath: string, att: any, messageId: string | null, forceTree: boolean, taskId: string | null, siblings: any[]) => {
      opened.push({ relpath, att, messageId, forceTree, taskId, siblings });
    },
  });

  const view = render(TaskTraceView, props as never);
  await until(view.host, ".trace-slot");

  const btn = view.host.querySelector(".trace-file-btn") as HTMLButtonElement;
  expect(btn).not.toBeNull();
  expect(btn.classList.contains("is-bundle")).toBe(false);
  expect(btn.textContent).toContain("report.md");

  click(btn);
  expect(opened).toHaveLength(1);
  expect(opened[0].relpath).toBe("work/2026-09-22-继续-qb3y/report.md");
  expect(opened[0].forceTree).toBe(false);
  expect(opened[0].taskId).toBe("task-single");
  expect(opened[0].siblings).toHaveLength(1);

  view.close();
});

/** The view switch's tabs, as they read: 流程, 看板 with its count, 要点. */
function viewTabs(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>(".trace-views [role='tab']")];
}

function viewTab(host: HTMLElement, label: string): HTMLButtonElement {
  const found = viewTabs(host).find((tab) => tab.textContent?.replace(/\s+/g, "").startsWith(label));
  if (!found) throw new Error(`no view tab ${label}`);
  return found;
}

/** Which view fills the pane: trace, board or spec. */
function viewOn(host: HTMLElement): string | null {
  return host.querySelector(".trace-pane")?.getAttribute("data-view") ?? null;
}

test("the header reads the plan — its name, status, kind, ticket counts — and the switch offers the trace, the board and the spec, opening on the trace", async () => {
  forgetTraceView();
  const view = open({ pane: true });
  await until(view.host, ".ticket-row");
  // Its name, as its tags and the Bots call it; the goal is in the spec.
  expect(view.host.querySelector(".trace-titles h2")?.textContent).toBe("这件事 · 先出分镜");
  const meta = view.host.querySelector(".trace-meta")!;
  expect(meta.querySelector(".plan-status.is-active")?.textContent).toBe(t.plan.status.active);
  expect(meta.textContent).toContain("分镜");
  expect(meta.textContent).toContain(t.plan.ticketCounts(2, 2));
  // Nothing sits above the trace: the spec and the board are views of their own.
  expect(view.host.querySelector(".trace-top .plan-spec")).toBeNull();
  expect(viewTabs(view.host).map((tab) => tab.textContent?.replace(/\s+/g, ""))).toEqual([t.plan.segmentTrace, `${t.plan.segmentBoard}2`, t.plan.segmentSpec]);
  expect(viewTabs(view.host).map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
  expect(viewOn(view.host)).toBe("trace");
  expect(view.host.querySelector(".trace-stage")?.classList.contains("is-on")).toBe(true);
  const specView = view.host.querySelector(".trace-spec-view");
  expect(specView?.classList.contains("is-on")).toBe(false);
  // The spec is mounted with it, read in full once it is shown.
  expect(specView?.textContent).toContain("12 格草图交到 board.pdf");
  expect(specView?.textContent).toContain("不要真人");
  // The board, in order, with who is on what.
  const rowOf = (title: string) => [...view.host.querySelectorAll(".ticket-row")].find((row) => row.textContent?.includes(title));
  expect(["分镜草图", "配乐"].map((title) => rowOf(title)?.querySelector(".ticket-tag")?.textContent)).toEqual(["01", "02"]);
  expect(rowOf("分镜草图")?.textContent).toContain(t.plan.worker("分镜师"));
  expect(rowOf("配乐")?.textContent).toContain(t.plan.nobody);
  // The card that worked in a ticket wears its number.
  expect(view.host.querySelector(".trace-card.is-running .trace-ticket-tag")?.textContent).toBe("01");
  expect(view.host.querySelector(".trace-card.is-completed .trace-ticket-tag")).toBeNull();
  // The switcher rows read the same way.
  click(await until(view.host, ".trace-title-trigger"));
  const jobs = [...view.host.querySelectorAll(".trace-job")];
  expect(jobs[0]?.querySelector(".trace-job-title")?.textContent).toBe("先出分镜");
  expect(jobs[1]?.querySelector(".plan-status.is-done")).not.toBeNull();
  view.close();
});

test("the header's ticket counts leave out the dropped and set-aside, and say how many there are", async () => {
  forgetTraceView();
  const counts = { todo: 1, doing: 1, review: 0, done: 3, parked: 2 };
  const view = open({ pane: true, detail: detail({ ticket_counts: counts }), jobs: [job({ ticket_counts: counts }), job({ id: "task-2", title: "上周的排期" })] });
  await until(view.host, ".ticket-row");
  expect(view.host.querySelector(".trace-meta")?.textContent).toContain("2 未完成 · 共 5 · 作废/搁置 2");
  click(await until(view.host, ".trace-title-trigger"));
  expect(view.host.querySelector(".trace-job .trace-job-meta")?.textContent).toContain(t.plan.ticketCounts(2, 5, 2));
  view.close();
});

test("a ticket picked on the board lights its cards on the trace and dims the rest; Escape lets go of it", async () => {
  forgetTraceView();
  const view = open({ pane: true });
  await until(view.host, ".ticket-row");
  click(viewTab(view.host, t.plan.segmentBoard));
  expect(viewOn(view.host)).toBe("board");
  const sketch = [...view.host.querySelectorAll(".ticket-row")].find((row) => row.textContent?.includes("分镜草图"))!;
  click(sketch.querySelector(".ticket-main"));
  expect(view.host.querySelector(".ticket-row.is-selected .ticket-tag")?.textContent).toBe("01");
  expect(view.host.querySelector(".trace-card.is-running")?.classList.contains("is-lit")).toBe(true);
  expect(view.host.querySelector(".trace-card.is-completed")?.classList.contains("is-dim")).toBe(true);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(view.host.querySelector(".ticket-row.is-selected")).toBeNull();
  expect(view.host.querySelector(".trace-card.is-dim")).toBeNull();
  // A ticket's files open in the host's preview, with the plan's folder as the tree.
  click(sketch.querySelector(".ticket-artifacts"));
  expect(view.opened).toEqual([{ relpath: "work/先出分镜-7f3k/01-分镜草图/board.pdf", messageId: "m3", forceTree: true, taskId: "task-1", siblings: 1 }]);
  // And its latest turn is one click away.
  click(sketch.querySelector(".ticket-jump"));
  expect(view.jumps).toEqual([["direct-1", "m3"]]);
  // Picked again, it offers its rounds on the trace: the trace comes up with them lit.
  click(sketch.querySelector(".ticket-main"));
  expect(sketch.querySelector(".ticket-show-trace")?.textContent?.trim()).toBe(t.plan.links.showInTrace);
  click(sketch.querySelector(".ticket-show-trace"));
  await settle();
  expect(viewOn(view.host)).toBe("trace");
  expect(loadTraceView()).toBe("trace");
  expect(view.host.querySelector(".trace-card.is-running")?.classList.contains("is-lit")).toBe(true);
  view.close();
  forgetTraceView();
});

function aRequirement(over: Partial<PlanRequirement> = {}): PlanRequirement {
  return {
    id: "req-plan",
    seq: 1,
    quote: "不要真人出镜",
    restated: null,
    category: null,
    polarity: "must",
    dimension: null,
    value: null,
    status: "open",
    scope: "plan",
    ticket_id: null,
    domain: null,
    times_raised: 1,
    plans_raised: 1,
    last_raised_at: "2026-09-22T00:00:00.000Z",
    source_kind: "message",
    source: null,
    added_by: "scribe",
    inherited_from: null,
    excluded: false,
    supersedes: null,
    ...over,
  };
}

function aTicketCheck(over: Partial<AcceptanceCheck> = {}): AcceptanceCheck {
  return {
    id: "check-1",
    task_id: "task-1",
    ticket_id: "tk-1",
    item: "12 格草图交到 board.pdf",
    kind: "exists",
    path: "work/先出分镜-7f3k/01-分镜草图/board.pdf",
    pattern: null,
    negate: false,
    command: null,
    cwd: null,
    expect_exit: null,
    expect_stdout: null,
    timeout_sec: null,
    source: "user",
    created_at: "2026-09-22T00:00:00.000Z",
    updated_at: "2026-09-22T00:00:00.000Z",
    defined_at: "2026-09-22T00:00:00.000Z",
    first_passed_at: null,
    last_run: null,
    running: false,
    ...over,
  };
}

/** task-1 with what the spec holds to its tickets: one requirement over the plan, one for 02 alone, a check filed under 01. */
function linkedDetail(): TaskDetail {
  return detail({
    requirements: [aRequirement(), aRequirement({ id: "req-02", seq: 2, quote: "配乐要无版权", scope: "ticket", ticket_id: "tk-2" })],
    checks: [aTicketCheck()],
  });
}

test("the picked ticket lists what it meets — the spec, as every ticket does, and what is its alone — and opens the spec on it", async () => {
  forgetTraceView();
  const view = open({ pane: true, detail: linkedDetail() });
  await until(view.host, ".ticket-row");
  click(viewTab(view.host, t.plan.segmentBoard));
  // The list says how its tickets stand to the spec before anything is picked.
  expect(view.host.querySelector(".ticket-list-hint")?.textContent).toBe(t.plan.links.ticketsHint);
  expect(view.host.querySelector(".ticket-owes")).toBeNull();
  click([...view.host.querySelectorAll(".ticket-row")].find((row) => row.textContent?.includes("分镜草图"))!.querySelector(".ticket-main"));
  const owes = view.host.querySelector(".ticket-row.is-selected .ticket-owes")!;
  const links = t.plan.links;
  expect(owes.querySelector(".ticket-owes-plan")?.textContent).toBe(
    links.planWide([links.acceptanceCount(1), links.rulesCount(1), links.requirementsCount(1)].join(links.join)),
  );
  // Held to 01 alone: its check; 02's requirement is not 01's.
  expect(owes.querySelector(".ticket-owes-sub")?.textContent).toBe(links.onlyThis);
  expect([...owes.querySelectorAll(".ticket-owes-list li")].map((row) => row.textContent)).toEqual([
    `${t.plan.checks.status.none}work/先出分镜-7f3k/01-分镜草图/board.pdf 存在且不为空`,
  ]);
  // The spec comes up in the board's place, still on 01: its check stands out, 02's requirement steps back.
  click(owes.querySelector(".ticket-owes-spec"));
  await settle();
  expect(viewOn(view.host)).toBe("spec");
  expect(view.host.querySelector(".ticket-row.is-selected .ticket-tag")?.textContent).toBe("01");
  const focusStrip = view.host.querySelector(".plan-spec-focus")!;
  expect(focusStrip.querySelector(".plan-spec-ticket-ref")?.textContent).toBe("01");
  expect(focusStrip.querySelector(".plan-spec-focus-title")?.textContent).toBe("分镜草图");
  expect(view.host.querySelector(".plan-spec-check")?.classList.contains("is-ticket-mine")).toBe(true);
  const reqClass = (id: string) => view.host.querySelector(`.plan-req[data-requirement="${id}"]`)?.className ?? "";
  expect(reqClass("req-plan")).not.toContain("is-ticket");
  expect(reqClass("req-02")).toContain("is-ticket-other");
  // The trace still lights 01's cards.
  expect(view.host.querySelector(".trace-card.is-running")?.classList.contains("is-lit")).toBe(true);
  view.close();
  forgetTraceView();
});

test("a line of the spec held to one ticket shows that ticket, picked, on the board; the strip lets go of it", async () => {
  forgetTraceView();
  const view = open({ pane: true, detail: linkedDetail() });
  await until(view.host, ".ticket-row");
  click(viewTab(view.host, t.plan.segmentSpec));
  await settle();
  expect(viewOn(view.host)).toBe("spec");
  // The requirement held to 02 names it; pressing the name shows 02.
  const scope = view.host.querySelector<HTMLButtonElement>('.plan-req[data-requirement="req-02"] .plan-req-ticket')!;
  expect(scope.textContent).toBe(t.plan.requirements.scope.ticket("02 配乐"));
  click(scope);
  await settle();
  expect(viewOn(view.host)).toBe("board");
  expect(view.host.querySelector(".ticket-row.is-selected .ticket-tag")?.textContent).toBe("02");
  // The check filed under 01 wears its number, and that shows 01.
  click(viewTab(view.host, t.plan.segmentSpec));
  await settle();
  expect(view.host.querySelector(".plan-spec-check.is-ticket-other")).not.toBeNull();
  click(view.host.querySelector(".plan-spec-check button.plan-spec-ticket-ref"));
  await settle();
  expect(viewOn(view.host)).toBe("board");
  expect(view.host.querySelector(".ticket-row.is-selected .ticket-tag")?.textContent).toBe("01");
  // Back on the spec, the strip puts the ticket down: nothing dims there or on the trace.
  click(viewTab(view.host, t.plan.segmentSpec));
  await settle();
  click(view.host.querySelector(".plan-spec-focus-clear"));
  await settle();
  expect(view.host.querySelector(".plan-spec-focus")).toBeNull();
  expect(view.host.querySelector(".ticket-row.is-selected")).toBeNull();
  expect(view.host.querySelector(".plan-spec-check.is-ticket-other, .plan-req.is-ticket-other")).toBeNull();
  expect(view.host.querySelector(".trace-card.is-dim")).toBeNull();
  view.close();
  forgetTraceView();
});

test("the spec's ticket states sit above the written progress and bring up the board on that column", async () => {
  forgetTraceView();
  const view = open({ pane: true, detail: linkedDetail() });
  await until(view.host, ".ticket-row");
  click(viewTab(view.host, t.plan.segmentSpec));
  await settle();
  const states = [...view.host.querySelectorAll<HTMLButtonElement>(".plan-spec-ticket-state")];
  expect(states.map((state) => state.textContent?.replace(/\s+/g, ""))).toEqual([`${t.plan.ticketStatus.todo}1`, `${t.plan.ticketStatus.doing}1`]);
  // What the row is for is its tooltip, not a paragraph under it.
  expect(view.host.querySelector(".plan-spec-ticket-states-line")?.getAttribute("title")).toBe(t.plan.links.progressHint);
  click(states[1]);
  await settle();
  expect(viewOn(view.host)).toBe("board");
  // Naming a status lights that column and hides nothing: both cards stay.
  expect([...view.host.querySelectorAll(".ticket-row .ticket-tag")].map((tag) => tag.textContent).sort()).toEqual(["01", "02"]);
  expect(view.host.querySelector("[data-board-status='doing']")?.classList.contains("is-focused")).toBe(true);
  expect(view.host.querySelector(".ticket-filter-btn")).toBeNull();
  // A ticket of another status, shown from the spec, lets the column go.
  click(viewTab(view.host, t.plan.segmentSpec));
  await settle();
  click(view.host.querySelector('.plan-req[data-requirement="req-02"] .plan-req-ticket'));
  await settle();
  expect([...view.host.querySelectorAll(".ticket-row .ticket-tag")].map((tag) => tag.textContent).sort()).toEqual(["01", "02"]);
  expect(view.host.querySelector(".ticket-row.is-selected .ticket-tag")?.textContent).toBe("02");
  expect(view.host.querySelector("[data-board-status='doing']")?.classList.contains("is-focused")).toBe(false);
  view.close();
  forgetTraceView();
});

test("a phone has the same three views in the same switch, and the spec's links move between them", async () => {
  forgetTraceView();
  const view = open({ detail: linkedDetail() });
  await until(view.host, ".ticket-row");
  const selected = () => viewTabs(view.host).map((tab) => tab.getAttribute("aria-selected"));
  expect(viewTabs(view.host).map((tab) => tab.textContent?.replace(/\s+/g, ""))).toEqual([t.plan.segmentTrace, `${t.plan.segmentBoard}2`, t.plan.segmentSpec]);
  expect(selected()).toEqual(["true", "false", "false"]);
  click(viewTab(view.host, t.plan.segmentSpec));
  click(view.host.querySelector('.plan-req[data-requirement="req-02"] .plan-req-ticket'));
  await settle();
  expect(selected()).toEqual(["false", "true", "false"]);
  expect(view.host.querySelector(".ticket-row.is-selected .ticket-tag")?.textContent).toBe("02");
  click(view.host.querySelector(".ticket-row.is-selected .ticket-owes-spec"));
  await settle();
  expect(selected()).toEqual(["false", "false", "true"]);
  expect(view.host.querySelector(".plan-spec-focus .plan-spec-ticket-ref")?.textContent).toBe("02");
  view.close();
  forgetTraceView();
});

test("one view at a time has the pane; the others are hidden in place, and the one picked is the next plan's too", async () => {
  forgetTraceView();
  const view = open({ pane: true });
  await until(view.host, ".ticket-row");
  const on = () => [".trace-stage", ".trace-board-view", ".trace-spec-view"].map((selector) => view.host.querySelector(selector)?.classList.contains("is-on"));
  expect(on()).toEqual([true, false, false]);
  click(viewTab(view.host, t.plan.segmentBoard));
  expect(on()).toEqual([false, true, false]);
  expect(view.host.querySelector(".trace-stage")?.hasAttribute("inert")).toBe(true);
  click(viewTab(view.host, t.plan.segmentSpec));
  expect(on()).toEqual([false, false, true]);
  expect(loadTraceView()).toBe("spec");
  view.close();
  // The next board opens the way this one was left.
  const again = open({ pane: true });
  await until(again.host, ".ticket-row");
  expect(viewOn(again.host)).toBe("spec");
  again.close();
  forgetTraceView();
});

test("a message asking for its card opens the trace, whatever view was left, without changing the one remembered", async () => {
  saveTraceView("board");
  const view = open({ pane: true, focus: { messageId: "m3", turnId: "t-artist" }, focusToken: 1 });
  await until(view.host, ".ticket-row");
  expect(viewOn(view.host)).toBe("trace");
  // Moved on to the board, a later request brings the trace back again.
  click(viewTab(view.host, t.plan.segmentBoard));
  expect(viewOn(view.host)).toBe("board");
  view.props.focus = { messageId: "m3", turnId: "t-artist" };
  view.props.focusToken = 2;
  await settle();
  expect(viewOn(view.host)).toBe("trace");
  expect(loadTraceView()).toBe("board");
  view.close();
  forgetTraceView();
});

test("a plan with no tickets yet has no board to switch to, and a board left on falls back to the trace", async () => {
  saveTraceView("board");
  const view = open({ pane: true, detail: { ...detail(), tickets: [] } });
  await until(view.host, ".trace-views");
  expect(viewTabs(view.host).map((tab) => tab.textContent?.trim())).toEqual([t.plan.segmentTrace, t.plan.segmentSpec]);
  expect(viewOn(view.host)).toBe("trace");
  expect(view.host.querySelector(".trace-board-view")).toBeNull();
  view.close();
  forgetTraceView();
});

test("a tab is one view of the job: it draws that view alone, with no switch to the others", async () => {
  forgetTraceView();
  for (const [fixedView, drawn] of [["board", ".trace-board-view"], ["spec", ".trace-spec-view"], ["trace", ".trace-stage"]] as const) {
    const view = open({ pane: true, fixedView });
    await until(view.host, drawn);
    await until(view.host, ".trace-meta");
    expect(viewOn(view.host)).toBe(fixedView);
    expect(view.host.querySelector(drawn)?.classList.contains("is-on")).toBe(true);
    expect([".trace-board-view", ".trace-spec-view", ".trace-stage"].filter((other) => view.host.querySelector(other))).toEqual([drawn]);
    // Each view is opened as a tab of its own from a message's or a conversation's menu.
    expect(view.host.querySelector(".trace-views")).toBeNull();
    view.close();
  }
  // Nothing was remembered for the phone's page.
  expect(loadTraceView()).toBe("trace");
});

test("in a tab, a ticket's way to the trace or the spec brings up that view's tab, carrying the ticket and its card", async () => {
  const view = open({ pane: true, fixedView: "board", detail: linkedDetail() });
  await until(view.host, ".ticket-row");
  const sketch = [...view.host.querySelectorAll(".ticket-row")].find((row) => row.textContent?.includes("分镜草图"))!;
  click(sketch.querySelector(".ticket-main"));
  click(sketch.querySelector(".ticket-show-trace"));
  click(view.host.querySelector(".ticket-row.is-selected .ticket-owes-spec"));
  await settle();
  expect(view.shown).toEqual([
    ["trace", "task-1", { ticket: "tk-1", focus: { messageId: "m3", turnId: "t-artist" } }],
    ["spec", "task-1", { ticket: "tk-1" }],
  ]);
  expect(viewOn(view.host)).toBe("board");
  expect(view.host.querySelector(".ticket-row.is-selected .ticket-tag")?.textContent).toBe("01");
  view.close();
});

test("in a tab, the spec's ticket numbers and ticket states bring up the board's tab on that card or column", async () => {
  const view = open({ pane: true, fixedView: "spec", detail: linkedDetail() });
  await until(view.host, ".plan-spec");
  expect(view.host.querySelector(".trace-board-view")).toBeNull();
  click(view.host.querySelector(".plan-spec-check button.plan-spec-ticket-ref"));
  const states = [...view.host.querySelectorAll<HTMLButtonElement>(".plan-spec-ticket-state")];
  click(states.find((button) => button.textContent?.includes(t.plan.ticketStatus.todo)) ?? states[0]!);
  await settle();
  expect(view.shown[0]).toEqual(["board", "task-1", { ticket: "tk-1" }]);
  expect(view.shown[1]?.[0]).toBe("board");
  expect(view.shown[1]?.[2].column).toBeTruthy();
  expect(viewOn(view.host)).toBe("spec");
  view.close();
});

test("a tab opened with a request acts on it once its job is here, and not again when it comes back", async () => {
  const first = open({ pane: true, fixedView: "board", ask: { ticket: "tk-2" }, askToken: 41 });
  await until(first.host, ".ticket-row.is-selected");
  expect(first.host.querySelector(".ticket-row.is-selected .ticket-tag")?.textContent).toBe("02");
  // You let go of it, and the tab goes to the back.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(first.host.querySelector(".ticket-row.is-selected")).toBeNull();
  first.close();
  // Brought forward again, it still carries the same request: it is not acted on twice.
  const again = open({ pane: true, fixedView: "board", ask: { ticket: "tk-2" }, askToken: 41 });
  await until(again.host, ".ticket-row");
  await settle();
  expect(again.host.querySelector(".ticket-row.is-selected")).toBeNull();
  // A new request is.
  again.props.ask = { ticket: "tk-1" };
  again.props.askToken = 42;
  await until(again.host, ".ticket-row.is-selected");
  expect(again.host.querySelector(".ticket-row.is-selected .ticket-tag")?.textContent).toBe("01");
  again.close();
});

test("the trace's tab asked to show a ticket lights its cards and comes up on its newest one", async () => {
  const view = open({
    pane: true,
    fixedView: "trace",
    ask: { ticket: "tk-1" },
    askToken: 7,
    focus: { messageId: "m3", turnId: "t-artist" },
    focusToken: 7,
  });
  await until(view.host, ".trace-card.is-lit");
  expect(view.host.querySelector(".trace-card.is-running")?.classList.contains("is-lit")).toBe(true);
  expect(view.host.querySelector(".trace-card.is-completed")?.classList.contains("is-dim")).toBe(true);
  expect(view.host.querySelector(".trace-board-view")).toBeNull();
  view.close();
});

test("the spec's tab asked to hold to a ticket opens on it", async () => {
  const view = open({ pane: true, fixedView: "spec", detail: linkedDetail(), ask: { ticket: "tk-1" }, askToken: 3 });
  await until(view.host, ".plan-spec-focus");
  expect(view.host.querySelector(".plan-spec-focus .plan-spec-ticket-ref")?.textContent).toBe("01");
  view.close();
});

test("a board's tab stays the board on a plan with no tickets yet, and says so while its plan loads", async () => {
  const view = open({ pane: true, fixedView: "board", detail: detail({ tickets: [], ticket_counts: { todo: 0, doing: 0, review: 0, done: 0, parked: 0 } }) });
  expect(view.host.querySelector(".trace-plan-state")?.textContent).toContain(t.trace.loading);
  await until(view.host, ".trace-board-view");
  expect(viewOn(view.host)).toBe("board");
  expect(view.host.querySelector(".trace-stage")).toBeNull();
  expect(view.host.querySelector(".trace-plan-state")).toBeNull();
  view.close();
});

test("a daemon that predates plans still draws the tree, without the spec, the board or the switch", async () => {
  const view = open({ detail: false, pane: true });
  await until(view.host, ".trace-slot");
  expect(view.host.querySelector(".trace-titles h2")?.textContent).toContain("先出分镜");
  expect(view.host.querySelector(".plan-spec")).toBeNull();
  expect(view.host.querySelector(".trace-views")).toBeNull();
  expect(view.host.querySelector(".trace-spec-view")).toBeNull();
  expect(view.host.querySelector(".trace-board-view")).toBeNull();
  expect(view.host.querySelectorAll(".trace-card")).toHaveLength(3);
  view.close();
});

/** A job of `count` rounds: a line of yours and the Bot answering it, a minute apart. */
function longJob(count: number): TaskTrace {
  return {
    ...picture(),
    nodes: Array.from({ length: count }, (_, index) => {
      const minute = String(index).padStart(2, "0");
      const base = { session_id: "group-1", woken_elsewhere: null, artifacts: [], ask: null, approval: null, passed: 0 };
      return [
        {
          ...base,
          turn_id: `user:r${index}`,
          actor: USER_MEMBER,
          status: "completed" as const,
          woken_by_turn_id: null,
          trigger_message_id: `r${index}`,
          focus_message_id: `r${index}`,
          summary: `第 ${index} 句`,
          created_at: `2026-09-22T00:${minute}:00.000Z`,
        },
        {
          ...base,
          turn_id: `t${index}`,
          actor: "bot-1",
          status: "completed" as const,
          woken_by_turn_id: `user:r${index}`,
          trigger_message_id: `r${index}`,
          focus_message_id: `w${index}`,
          summary: `回第 ${index} 句`,
          created_at: `2026-09-22T00:${minute}:30.000Z`,
        },
      ];
    }).flat(),
  };
}

test("a long job opens with its older rounds folded to a line each, and a line unfolds its round", async () => {
  const view = open({ trace: longJob(5), pane: true });
  await until(view.host, ".trace-round");
  const rows = () => [...view.host.querySelectorAll<HTMLButtonElement>(".trace-round")];
  expect(rows()).toHaveLength(5);
  expect(rows().map((row) => row.classList.contains("is-folded"))).toEqual([true, true, true, false, false]);
  // Only the newest two rounds are drawn as cards; a folded line says whose line it was.
  expect(view.host.querySelectorAll(".trace-slot")).toHaveLength(4);
  expect(rows()[0]?.querySelector(".trace-round-said")?.textContent).toBe("你第 0 句");
  expect(rows()[0]?.getAttribute("aria-expanded")).toBe("false");

  click(rows()[0]!);
  flushSync();
  expect(rows()[0]?.getAttribute("aria-expanded")).toBe("true");
  expect(view.host.querySelectorAll(".trace-slot")).toHaveLength(6);
  expect(rows()[0]?.querySelector(".trace-round-said")).toBeNull();

  click(rows()[0]!);
  flushSync();
  expect(view.host.querySelectorAll(".trace-slot")).toHaveLength(4);
  view.close();
});

test("a message asking for a card in a folded round opens that round", async () => {
  const view = open({ trace: longJob(5), pane: true, focus: { messageId: "w0", turnId: "t0" }, focusToken: 1 });
  await until(view.host, ".trace-round");
  const first = view.host.querySelector(".trace-round");
  expect(first?.classList.contains("is-folded")).toBe(false);
  expect([...view.host.querySelectorAll(".trace-card-who")].length).toBe(6);
  view.close();
});

test("folding a round keeps its line where you pressed it, and a fold that empties the view brings the cards back", async () => {
  // The newest round fans out to three Bots, wider than any other, so folding it moves the spine.
  const base = longJob(5);
  const answer = base.nodes.find((node) => node.turn_id === "t4")!;
  const trace = {
    ...base,
    nodes: [
      ...base.nodes,
      { ...answer, turn_id: "t4b", actor: "bot-2", focus_message_id: "w4b", created_at: "2026-09-22T00:04:40.000Z" },
      { ...answer, turn_id: "t4c", focus_message_id: "w4c", created_at: "2026-09-22T00:04:50.000Z" },
    ],
  };
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("trace-viewport")) {
      return { x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON() { return {}; } } as DOMRect;
    }
    return rect.call(this);
  };
  try {
    await withMeasuredCards(async () => {
      const view = open({ trace, pane: true });
      await until(view.host, ".trace-slot");
      await new Promise((resolve) => setTimeout(resolve, 60));
      flushSync();
      const flow = view.host.querySelector<HTMLElement>(".trace-flow")!;
      const board = () => {
        const [, x, y, scale] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(flow.style.transform)!;
        return { x: Number(x), y: Number(y), scale: Number(scale), width: Number.parseFloat(flow.style.width), height: Number.parseFloat(flow.style.height) };
      };
      const newest = () => [...view.host.querySelectorAll<HTMLElement>(".trace-round")].at(-1)!;
      const onScreen = (row: HTMLElement) => {
        const at = board();
        return { x: at.x + Number.parseFloat(row.style.left) * at.scale, y: at.y + Number.parseFloat(row.style.top) * at.scale };
      };
      const expectAt = (row: HTMLElement, at: { x: number; y: number }) => {
        expect(onScreen(row).x).toBeCloseTo(at.x, 6);
        expect(onScreen(row).y).toBeCloseTo(at.y, 6);
      };
      // Read down to the newest round, so its line sits at the top of the view.
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: onScreen(newest()).y - 20 });
      view.host.querySelector(".trace-viewport")!.dispatchEvent(wheel);
      flushSync();
      const pressed = onScreen(newest());
      const wide = board().width;

      click(newest());
      flushSync();
      expect(newest().classList.contains("is-folded")).toBe(true);
      // The spine moved, and the line you pressed did not.
      expect(board().width).toBeLessThan(wide);
      expectAt(newest(), pressed);

      // Nothing is left under it, so the board slides down until the whole of it is in view.
      await new Promise((resolve) => setTimeout(resolve, 450));
      flushSync();
      const settled = board();
      expect(settled.y).toBe(12);
      expect(settled.y + settled.height * settled.scale).toBeLessThanOrEqual(588);
      expect(onScreen(newest()).x).toBeCloseTo(pressed.x, 6);
      expect(onScreen(newest()).y).toBeGreaterThan(pressed.y);

      // Unfolding holds the line too; the cards come back under it.
      const folded = onScreen(newest());
      click(newest());
      flushSync();
      expect(newest().classList.contains("is-folded")).toBe(false);
      expectAt(newest(), folded);
      view.close();
    });
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
});

test("the wheel pans the board and only ⌘/Ctrl + wheel zooms it", async () => {
  const view = open({ trace: longJob(5), pane: true });
  await until(view.host, ".trace-slot");
  const viewport = view.host.querySelector(".trace-viewport")!;
  const board = () => {
    const style = (view.host.querySelector(".trace-flow") as HTMLElement).style.transform;
    const [, x, y, scale] = /translate\(([^,]+)px, ([^)]+)px\) scale\(([^)]+)\)/.exec(style)!;
    return { x: Number(x), y: Number(y), scale: Number(scale) };
  };
  const wheel = (init: WheelEventInit) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    // happy-dom's WheelEvent drops the modifier keys from its init; a browser's does not.
    for (const key of ["ctrlKey", "metaKey", "shiftKey"] as const) {
      Object.defineProperty(event, key, { value: init[key] ?? false });
    }
    viewport.dispatchEvent(event);
    flushSync();
  };
  const start = board();
  wheel({ deltaY: 120 });
  expect(board()).toEqual({ ...start, y: start.y - 120 });
  wheel({ deltaX: 40 });
  expect(board()).toEqual({ ...start, x: start.x - 40, y: start.y - 120 });
  // A trackpad pinch arrives as ctrl + wheel, and ⌘ + wheel is the mouse's way to the same.
  wheel({ deltaY: -200, ctrlKey: true });
  expect(board().scale).toBeGreaterThan(start.scale);
  const zoomed = board().scale;
  wheel({ deltaY: 200, metaKey: true });
  expect(board().scale).toBeLessThan(zoomed);
  view.close();
});

test("the fit button brings the whole board back from wherever it was dragged, and the percentage goes back to life size", async () => {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("trace-viewport")) {
      return { x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON() { return {}; } } as DOMRect;
    }
    return rect.call(this);
  };
  try {
    await withMeasuredCards(async () => {
      const view = open({ trace: longJob(3), pane: true });
      await until(view.host, ".trace-slot");
      await new Promise((resolve) => setTimeout(resolve, 60));
      flushSync();
      const flow = view.host.querySelector<HTMLElement>(".trace-flow")!;
      const board = () => {
        const [, x, y, scale] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(flow.style.transform)!;
        return { x: Number(x), y: Number(y), scale: Number(scale), width: Number.parseFloat(flow.style.width), height: Number.parseFloat(flow.style.height) };
      };
      const viewport = view.host.querySelector(".trace-viewport")!;
      const wheel = (init: WheelEventInit) => {
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
        for (const key of ["ctrlKey", "metaKey", "shiftKey"] as const) {
          Object.defineProperty(event, key, { value: init[key] ?? false });
        }
        viewport.dispatchEvent(event);
        flushSync();
      };
      const zoomButton = (label: string) => view.host.querySelector<HTMLButtonElement>(`.trace-zoom button[aria-label="${label}"]`);
      // Zoomed in and dragged off into empty canvas.
      for (let i = 0; i < 3; i += 1) click(zoomButton(t.trace.zoomIn));
      wheel({ deltaY: 2000, deltaX: 1500 });
      expect(board().scale).toBeGreaterThan(1);

      const fit = zoomButton(t.trace.zoomFit);
      expect(fit?.title).toBe(t.trace.zoomFit);
      click(fit);
      await new Promise((resolve) => setTimeout(resolve, 450));
      flushSync();
      const fitted = board();
      // All of it inside the view, 12px clear of each edge, the middle of it in the middle.
      expect(fitted.scale).toBeLessThanOrEqual(1);
      expect(fitted.x).toBeGreaterThanOrEqual(12);
      expect(fitted.y).toBeGreaterThanOrEqual(12);
      expect(fitted.x + fitted.width * fitted.scale).toBeLessThanOrEqual(788);
      expect(fitted.y + fitted.height * fitted.scale).toBeLessThanOrEqual(588);
      expect(fitted.x + (fitted.width * fitted.scale) / 2).toBeCloseTo(400, 0);
      // As large as that allows: it fills the view one way, or is drawn at life size.
      const fills =
        Math.abs(fitted.width * fitted.scale - 776) < 1 || Math.abs(fitted.height * fitted.scale - 576) < 1;
      expect(fills || fitted.scale === 1).toBe(true);

      // Zoomed out, the percentage takes it back to 100% and keeps the middle of the view where it was.
      click(zoomButton(t.trace.zoomOut));
      const out = board();
      expect(out.scale).toBeLessThan(fitted.scale);
      const middle = { x: (400 - out.x) / out.scale, y: (300 - out.y) / out.scale };
      const level = view.host.querySelector<HTMLButtonElement>(".trace-zoom-level")!;
      expect(level.title).toBe(t.trace.zoomReset);
      click(level);
      const life = board();
      expect(life.scale).toBe(1);
      expect(level.textContent?.trim()).toBe("100%");
      expect(400 - life.x).toBeCloseTo(middle.x, 6);
      expect(300 - life.y).toBeCloseTo(middle.y, 6);
      view.close();
    });
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
});

/** The viewport an 800 × 600 pane gives the board. */
async function inViewport(run: () => Promise<void>): Promise<void> {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("trace-viewport")) {
      return { x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON() { return {}; } } as DOMRect;
    }
    return rect.call(this);
  };
  try {
    await withMeasuredCards(run);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
}

/** Let the cards measure and the board place itself on them. */
async function laidOut(view: { host: HTMLElement }): Promise<void> {
  await until(view.host, ".trace-slot");
  await new Promise((resolve) => setTimeout(resolve, 60));
  flushSync();
}

function cameraOf(view: { host: HTMLElement }): string {
  return view.host.querySelector<HTMLElement>(".trace-flow")!.style.transform;
}

function pan(view: { host: HTMLElement }, by: { x: number; y: number }): void {
  const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: -by.x, deltaY: -by.y });
  view.host.querySelector(".trace-viewport")!.dispatchEvent(wheel);
  flushSync();
}

test("a board brought forward again is where you left it, with the rounds you unfolded", async () => {
  // A tab that is not the one showing is unmounted: bringing it back mounts the board anew, and it
  // used to open afresh on its newest round instead of where you had been reading.
  await inViewport(async () => {
    const first = open({ trace: longJob(5), pane: true });
    await laidOut(first);
    const opened = cameraOf(first);
    click(first.host.querySelector(".trace-round")!);
    flushSync();
    pan(first, { x: 40, y: 260 });
    const left = cameraOf(first);
    expect(left).not.toBe(opened);
    first.close();

    const again = open({ trace: longJob(5), pane: true });
    await laidOut(again);
    expect(cameraOf(again)).toBe(left);
    expect(again.host.querySelector(".trace-round")?.classList.contains("is-folded")).toBe(false);
    again.close();
  });
});

test("a message's card is centred once: its tab brought forward again stays where you took the board", async () => {
  await inViewport(async () => {
    const focus = { messageId: "m3", turnId: "t-artist" };
    const first = open({ pane: true, focus, focusToken: 1 });
    await laidOut(first);
    const centred = cameraOf(first);
    pan(first, { x: 0, y: -180 });
    const left = cameraOf(first);
    expect(left).not.toBe(centred);
    first.close();

    // The tab still carries the request it was opened with; it has been answered already.
    const again = open({ pane: true, focus, focusToken: 1 });
    await laidOut(again);
    expect(cameraOf(again)).toBe(left);

    // A new request does move it.
    again.props.focus = { messageId: "m1", turnId: null };
    again.props.focusToken = 2;
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 450));
    flushSync();
    expect(cameraOf(again)).not.toBe(left);
    again.close();
  });
});

test("a job picked again in the switcher is where you left it", async () => {
  await inViewport(async () => {
    const view = open({ trace: longJob(5), otherTrace: { ...longJob(3), id: "task-2", title: "上周的排期" }, pane: true, writeBack: true });
    await laidOut(view);
    pan(view, { x: -30, y: 220 });
    const left = cameraOf(view);

    view.props.taskId = "task-2";
    flushSync();
    for (let i = 0; i < 20 && !view.host.querySelector(".trace-titles h2")?.textContent?.includes("上周的排期"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await laidOut(view);
    expect(cameraOf(view)).not.toBe(left);

    view.props.taskId = "task-1";
    flushSync();
    for (let i = 0; i < 20 && !view.host.querySelector(".trace-titles h2")?.textContent?.includes("先出分镜"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await laidOut(view);
    expect(cameraOf(view)).toBe(left);
    view.close();
  });
});

/** The board's camera as numbers: where the middle of an 800 × 600 view is on the board, and the zoom. */
function middleOf(view: { host: HTMLElement }): { x: number; y: number; scale: number } {
  const [, x, y, scale] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(cameraOf(view))!;
  const zoom = Number(scale);
  return { x: (400 - Number(x)) / zoom, y: (300 - Number(y)) / zoom, scale: zoom };
}

function rectOf(el: Element): { x: number; y: number; width: number; height: number } {
  const read = (name: string) => Number(el.getAttribute(name));
  return { x: read("x"), y: read("y"), width: read("width"), height: read("height") };
}

function pointer(el: Element, type: string, at: { x: number; y: number }): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: at.x, clientY: at.y }));
  flushSync();
}

test("the minimap draws every card and frames the view; pressing it slides the board there, and dragging the frame carries it", async () => {
  await inViewport(async () => {
    const view = open({ trace: longJob(5), pane: true });
    await laidOut(view);
    const map = view.host.querySelector(".trace-minimap")!;
    expect(map).not.toBeNull();
    expect(map.querySelectorAll(".minimap-card")).toHaveLength(view.host.querySelectorAll(".trace-slot").length);
    // Folded rounds are their line, on the map as on the board.
    expect(map.querySelectorAll(".minimap-round.is-folded").length).toBe(view.host.querySelectorAll(".trace-round.is-folded").length);
    expect(map.querySelector(".minimap-view")).not.toBeNull();

    // Off into empty canvas, then back by pressing a card on the map: it slides into the middle.
    pan(view, { x: -2400, y: -1800 });
    const target = map.querySelector('.minimap-card[data-turn="t4"]')!;
    const drawn = rectOf(target);
    const slot = [...view.host.querySelectorAll<HTMLElement>(".trace-slot")].find((el) => el.textContent?.includes("回第 4 句"))!;
    const card = { x: Number.parseFloat(slot.style.left) + 124, y: Number.parseFloat(slot.style.top) + slot.offsetHeight / 2 };
    const scale = middleOf(view).scale;
    const at = { x: drawn.x + drawn.width / 2, y: drawn.y + drawn.height / 2 };
    pointer(map, "pointerdown", at);
    pointer(map, "pointerup", at);
    await new Promise((resolve) => setTimeout(resolve, 450));
    flushSync();
    const landed = middleOf(view);
    expect(landed.scale).toBe(scale);
    expect(landed.x).toBeCloseTo(card.x, 3);
    expect(landed.y).toBeCloseTo(card.y, 3);

    // The frame picked up and moved takes the view with it, by as much as the map says.
    const frame = rectOf(map.querySelector(".minimap-view")!);
    const perPixel = 800 / scale / frame.width;
    const from = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    pointer(map, "pointerdown", from);
    // A press on the frame alone moves nothing.
    expect(middleOf(view).x).toBeCloseTo(landed.x, 3);
    pointer(map, "pointermove", { x: from.x - 6, y: from.y - 10 });
    pointer(map, "pointerup", { x: from.x - 6, y: from.y - 10 });
    const moved = middleOf(view);
    expect(moved.x).toBeCloseTo(landed.x - 6 * perPixel, 3);
    expect(moved.y).toBeCloseTo(landed.y - 10 * perPixel, 3);
    view.close();
  });
});

test("the minimap lights and dims what the board does", async () => {
  await inViewport(async () => {
    const view = open({ trace: routedPicture(), pane: true });
    await laidOut(view);
    const chip = [...view.host.querySelectorAll<HTMLButtonElement>(".trace-highlight")].find((b) => b.textContent?.includes("有反馈"))!;
    click(chip);
    flushSync();
    const card = (turn: string) => view.host.querySelector(`.minimap-card[data-turn="${turn}"]`)!;
    expect(card("t-writer").classList.contains("is-lit")).toBe(true);
    expect(card("t-artist").classList.contains("is-dim")).toBe(true);
    // Each card in its status's colour, as on the board.
    expect(card("t-artist").classList.contains("is-running")).toBe(true);
    view.close();
  });
});

test("the minimap can be put away from the zoom pill, and stays away on the next board", async () => {
  await inViewport(async () => {
    const view = open({ pane: true });
    await laidOut(view);
    const toggle = view.host.querySelector<HTMLButtonElement>(".trace-zoom-minimap")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.title).toBe(t.trace.minimapHide);
    expect(view.host.querySelector(".trace-minimap")).not.toBeNull();
    click(toggle);
    flushSync();
    expect(view.host.querySelector(".trace-minimap")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.title).toBe(t.trace.minimapShow);
    expect(loadTraceMinimap()).toBe(false);
    view.close();

    const again = open({ pane: true });
    await laidOut(again);
    expect(again.host.querySelector(".trace-minimap")).toBeNull();
    click(again.host.querySelector<HTMLButtonElement>(".trace-zoom-minimap"));
    flushSync();
    expect(again.host.querySelector(".trace-minimap")).not.toBeNull();
    again.close();
  });
});

test("a viewport too small to spare a corner draws no minimap", async () => {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("trace-viewport")) {
      return { x: 0, y: 0, width: 240, height: 180, top: 0, left: 0, right: 240, bottom: 180, toJSON() { return {}; } } as DOMRect;
    }
    return rect.call(this);
  };
  try {
    const view = open({ pane: true });
    await until(view.host, ".trace-slot");
    flushSync();
    expect(view.host.querySelector(".trace-zoom-minimap")).not.toBeNull();
    expect(view.host.querySelector(".trace-minimap")).toBeNull();
    view.close();
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
});

test("the board shows your stops over its job, lifts one, and its stop menu stops the job or every Bot", async () => {
  const view = open({ pane: true });
  await until(view.host, ".trace-meta");
  const stops: unknown[] = [];
  const lifts: string[] = [];
  const props = view.props as unknown as { holds: Hold[] | null; onStop: (choice: unknown) => void; onLift: (hold: Hold) => unknown };
  props.onStop = (choice) => void stops.push(choice);
  props.onLift = (hold) => void lifts.push(hold.id);
  props.holds = [];
  flushSync();
  click(view.host.querySelector(".stop-menu-trigger"));
  expect([...view.host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["停下这件事《先出分镜》", "停下所有 Bot"]);
  click(buttonByText(view.host, "停下这件事《先出分镜》"));
  expect(stops).toEqual([{ scope: "plan", id: "task-1" }]);

  props.holds = [
    aHold({ id: "h-1", scope: "plan", scope_id: "task-1", plan_title: "先出分镜" }),
    aHold({ id: "h-2", scope: "bot", scope_id: "bot-1" }),
    aHold({ id: "h-3", scope: "bot_plan", scope_id: "bot-2:task-1", plan_title: "先出分镜", lift_on_next_user_message: true }),
    aHold({ id: "h-4", scope: "plan", scope_id: "task-2", plan_title: "上周的排期" }),
  ];
  flushSync();
  // A stop on one Bot's whole work, or on another job, is not this board's.
  expect([...view.host.querySelectorAll(".trace-hold-label")].map((label) => label.textContent)).toEqual(["「先出分镜」这件事", "分镜师在「先出分镜」上的工作"]);
  click(view.host.querySelector(".trace-hold-lift"));
  expect(lifts).toEqual(["h-1"]);
  expect(view.host.querySelector(".trace-hold-error")).toBeNull();
  // A refused lift says so on its chip, where the time was.
  props.onLift = async () => ({ status: 409 });
  flushSync();
  click(view.host.querySelector(".trace-hold-lift"));
  await Promise.resolve();
  flushSync();
  expect(view.host.querySelector(".trace-hold-error")?.textContent).toBe("没做成，再试一次");
  click(view.host.querySelector(".stop-menu-trigger"));
  expect([...view.host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["停下所有 Bot"]);
  view.close();
});

test("with the daemon out of reach the board's stop menu and lifts show but cannot be pressed", async () => {
  const view = open({ pane: true });
  await until(view.host, ".trace-meta");
  const pressed: unknown[] = [];
  const props = view.props as unknown as { holds: Hold[] | null; onStop: (choice: unknown) => void; onLift: (hold: Hold) => unknown; controlsDisabled: boolean };
  props.onStop = (choice) => void pressed.push(choice);
  props.onLift = (hold) => void pressed.push(hold.id);
  props.holds = [aHold({ id: "h-3", scope: "bot_plan", scope_id: "bot-2:task-1", plan_title: "先出分镜" })];
  props.controlsDisabled = true;
  flushSync();
  const trigger = view.host.querySelector<HTMLButtonElement>(".stop-menu-trigger");
  const lift = view.host.querySelector<HTMLButtonElement>(".trace-hold-lift");
  expect(trigger?.disabled).toBe(true);
  expect(lift?.disabled).toBe(true);
  click(trigger);
  click(lift);
  expect(view.host.querySelector('[role="menuitem"]')).toBeNull();
  expect(pressed).toEqual([]);
  // Back in reach: both work again.
  props.controlsDisabled = false;
  flushSync();
  click(view.host.querySelector(".trace-hold-lift"));
  expect(pressed).toEqual(["h-3"]);
  view.close();
});

test("before the daemon has stops the board offers none", async () => {
  const view = open({ pane: true });
  await until(view.host, ".trace-meta");
  expect(view.host.querySelector(".stop-menu-trigger")).toBeNull();
  expect(view.host.querySelector(".trace-holds")).toBeNull();
  view.close();
});

test("your decisions hang under the card they answer: an answer with its question, a 放行, a 退回 with your words", async () => {
  const base = picture();
  const decided: TaskTrace = {
    ...base,
    nodes: [
      ...base.nodes,
      { ...base.nodes[0]!, turn_id: "decision:ask-1", woken_by_turn_id: "t-writer", trigger_message_id: "ask-1", focus_message_id: "ask-1",
        summary: "粉丝纪念向", created_at: "2026-09-22T00:05:00.000Z", decision: { kind: "answer", question: "这支 MV 打算怎么用？" } },
      { ...base.nodes[0]!, turn_id: "decision:card-1", woken_by_turn_id: "t-writer", trigger_message_id: "card-1", focus_message_id: "card-1",
        summary: "人物太粗糙", created_at: "2026-09-22T00:06:00.000Z", decision: { kind: "reject", submission_id: "s1" } },
      { ...base.nodes[0]!, turn_id: "decision:card-2", woken_by_turn_id: "t-writer", trigger_message_id: "card-2", focus_message_id: "card-2",
        summary: "", created_at: "2026-09-22T00:07:00.000Z", decision: { kind: "approve", submission_id: "s2", result: "检查没过，已退回" } },
    ],
  };
  const view = open({ trace: decided });
  await until(view.host, ".trace-decision");
  const chips = [...view.host.querySelectorAll(".trace-decision")].map((chip) => chip.textContent?.trim());
  expect(chips).toEqual(["回答", "退回", "放行"]);
  const cards = [...view.host.querySelectorAll(".trace-card")].filter((card) => card.querySelector(".trace-decision"));
  expect(cards[0]!.querySelector(".trace-wait")?.textContent).toContain("问：这支 MV 打算怎么用？");
  expect(cards[1]!.querySelector(".trace-summary")?.textContent).toBe("人物太粗糙");
  expect(cards[2]!.querySelector(".trace-wait")?.textContent).toContain("检查没过，已退回");
});
