import { expect, mock, test } from "bun:test";
import { flushSync } from "svelte";
import { USER_MEMBER, type RouteRecord, type SessionTaskSummary, type TaskDetail, type TaskTrace } from "@real-bot/protocol";

mock.module("monaco-editor-css", () => ({}));
mock.module("monaco-editor/esm/vs/platform/hover/browser/hover.css", () => ({}));
mock.module("monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css", () => ({}));
const { default: TaskTraceView } = await import("./TaskTrace.svelte");
const { default: TraceView } = await import("./TraceView.svelte");
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aGroup } from "../test-fixtures.ts";
import { buttonByText, click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";

const t = copyFor("zh");

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
  /** What the plan endpoint answers; `false` is a daemon that predates plans (404). */
  detail?: TaskDetail | false;
  focus?: { messageId: string; turnId: string | null } | null;
  focusToken?: number;
  /** Mount the board itself, the way a pane does, instead of the phone's page around it. */
  pane?: boolean;
} = {}) {
  const jumps: Array<[string, string]> = [];
  const settled: string[] = [];
  const opened: Opened[] = [];
  const patched: Array<[string, Record<string, unknown>]> = [];
  let closed = 0;
  const asked: string[] = [];
  const api = {
    sessionTasks: async (sessionId: string) => {
      asked.push(sessionId);
      if (sessionId === "direct-9") return [job({ id: "task-9", title: "另一件事" })];
      if (opts.fail) throw new Error("nope");
      return [job({ goal: opts.detail === false ? null : "先出分镜的草图和配乐" }), job({ id: "task-2", title: "上周的排期", closed_at: "2026-09-15T00:00:00.000Z", status: "done" })];
    },
    taskTrace: async (id: string) =>
      id === "task-1"
        ? (opts.trace ?? picture())
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
  });
  const view = render(opts.pane ? TraceView : TaskTraceView, props as never);
  return { ...view, props, jumps, asked, settled, opened, patched, closed: () => closed };
}

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

test("the header reads the plan — goal, status, kind, ticket counts — the spec sits under it, and the rail lists the tickets", async () => {
  const view = open({ pane: true });
  await until(view.host, ".ticket-row");
  expect(view.host.querySelector(".trace-titles h2")?.textContent).toContain("先出分镜的草图和配乐");
  const meta = view.host.querySelector(".trace-meta")!;
  expect(meta.querySelector(".plan-status.is-active")?.textContent).toBe(t.plan.status.active);
  expect(meta.textContent).toContain("分镜");
  expect(meta.textContent).toContain(t.plan.ticketCounts(2, 2));
  // A pane has the room: the spec opens with the board.
  const toggle = view.host.querySelector(".plan-spec-toggle")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(view.host.querySelector(".plan-spec")?.textContent).toContain("12 格草图交到 board.pdf");
  expect(view.host.querySelector(".plan-spec")?.textContent).toContain("不要真人");
  // The rail, in order, with who is on what.
  const rows = [...view.host.querySelectorAll(".ticket-row")];
  expect(rows.map((row) => row.querySelector(".ticket-tag")?.textContent)).toEqual(["01", "02"]);
  expect(rows[0]?.textContent).toContain("分镜草图");
  expect(rows[0]?.textContent).toContain(t.plan.worker("分镜师"));
  expect(rows[1]?.textContent).toContain(t.plan.nobody);
  // The card that worked in a ticket wears its number.
  expect(view.host.querySelector(".trace-card.is-running .trace-ticket-tag")?.textContent).toBe("01");
  expect(view.host.querySelector(".trace-card.is-completed .trace-ticket-tag")).toBeNull();
  // The switcher rows read the same way.
  click(await until(view.host, ".trace-title-trigger"));
  const jobs = [...view.host.querySelectorAll(".trace-job")];
  expect(jobs[0]?.querySelector(".trace-job-title")?.textContent).toBe("先出分镜的草图和配乐");
  expect(jobs[1]?.querySelector(".plan-status.is-done")).not.toBeNull();
  view.close();
});

test("a ticket picked in the rail lights its cards and dims the rest; Escape lets go of it", async () => {
  const view = open({ pane: true });
  await until(view.host, ".ticket-row");
  click(view.host.querySelector(".ticket-row .ticket-main"));
  expect(view.host.querySelector(".ticket-row.is-selected .ticket-tag")?.textContent).toBe("01");
  expect(view.host.querySelector(".trace-card.is-running")?.classList.contains("is-lit")).toBe(true);
  expect(view.host.querySelector(".trace-card.is-completed")?.classList.contains("is-dim")).toBe(true);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(view.host.querySelector(".ticket-row.is-selected")).toBeNull();
  expect(view.host.querySelector(".trace-card.is-dim")).toBeNull();
  // A ticket's files open in the host's preview, with the plan's folder as the tree.
  click(view.host.querySelector(".ticket-row .ticket-artifacts"));
  expect(view.opened).toEqual([{ relpath: "work/先出分镜-7f3k/01-分镜草图/board.pdf", messageId: "m3", forceTree: true, taskId: "task-1", siblings: 1 }]);
  // And its latest turn is one click away.
  click(view.host.querySelector(".ticket-row .ticket-jump"));
  expect(view.jumps).toEqual([["direct-1", "m3"]]);
  view.close();
});

test("a phone opens with the spec folded and shows the rail and the tree in turn", async () => {
  const view = open();
  await until(view.host, ".ticket-row");
  expect(view.host.querySelector(".plan-spec-toggle")?.getAttribute("aria-expanded")).toBe("false");
  const tabs = [...view.host.querySelectorAll(".trace-segments [role='tab']")];
  expect(tabs.map((tab) => tab.textContent)).toEqual([t.plan.segmentTrace, t.plan.segmentTickets]);
  click(tabs[1]);
  expect(view.host.querySelector(".trace-pane")?.classList.contains("is-tickets")).toBe(true);
  click(tabs[0]);
  expect(view.host.querySelector(".trace-pane")?.classList.contains("is-tickets")).toBe(false);
  view.close();
});

test("a daemon that predates plans still draws the tree, without the spec or the rail", async () => {
  const view = open({ detail: false, pane: true });
  await until(view.host, ".trace-slot");
  expect(view.host.querySelector(".trace-titles h2")?.textContent).toContain("先出分镜");
  expect(view.host.querySelector(".plan-spec")).toBeNull();
  expect(view.host.querySelector(".trace-rail")).toBeNull();
  expect(view.host.querySelector(".trace-segments")).toBeNull();
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
