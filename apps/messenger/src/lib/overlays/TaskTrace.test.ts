import { expect, mock, test } from "bun:test";
import { USER_MEMBER, type SessionTaskSummary, type TaskTrace } from "@real-bot/protocol";

mock.module("monaco-editor-css", () => ({}));
mock.module("monaco-editor/esm/vs/platform/hover/browser/hover.css", () => ({}));
mock.module("monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css", () => ({}));
const { default: TaskTraceView } = await import("./TaskTrace.svelte");
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aGroup } from "../test-fixtures.ts";
import { buttonByText, click, render } from "../test-render.ts";

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
    dir: "work/2026-09-22-先出分镜-7f3k",
    title: "先出分镜",
    session_id: "group-1",
    closed_at: null,
    last_activity_at: "2026-09-22T00:00:00.000Z",
    ...over,
  };
}

function picture(): TaskTrace {
  return {
    id: "task-1",
    dir: "work/2026-09-22-先出分镜-7f3k",
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
        trigger_message_id: "m2",
        focus_message_id: "m3",
        summary: "正在画第一格",
        created_at: "2026-09-22T00:00:02.000Z",
        artifacts: [{ path: "work/2026-09-22-先出分镜-7f3k/board.pdf", message_id: "m3", attachment_id: "a1" }],
        ask: null,
        approval: { message_id: "m-approval", summary: "写入工作区外" },
        passed: 0,
      },
    ],
  };
}

function open(opts: { taskId?: string | null; fail?: boolean; sessionId?: string } = {}) {
  const jumps: Array<[string, string]> = [];
  let closed = 0;
  const asked: string[] = [];
  const api = {
    sessionTasks: async (sessionId: string) => {
      asked.push(sessionId);
      if (sessionId === "direct-9") return [job({ id: "task-9", title: "另一件事" })];
      if (opts.fail) throw new Error("nope");
      return [job(), job({ id: "task-2", title: "上周的排期", closed_at: "2026-09-15T00:00:00.000Z" })];
    },
    taskTrace: async (id: string) =>
      id === "task-1"
        ? picture()
        : { ...picture(), id, title: id === "task-9" ? "另一件事" : "上周的排期", nodes: [] },
    getWorkspaceFileBlob: async () => new Blob(["# 分镜"]),
  };
  const view = render(TaskTraceView, {
    api: api as never,
    taskId: opts.taskId === undefined ? "task-1" : opts.taskId,
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
  });
  return { ...view, jumps, asked, closed: () => closed };
}

async function until(host: HTMLElement, selector: string): Promise<Element> {
  for (let i = 0; i < 20; i += 1) {
    const found = host.querySelector(selector);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`never saw ${selector}`);
}

test("the flow runs top to bottom, a card jumps to its turn, and a file opens under its turn", async () => {
  const view = open();
  await until(view.host, ".trace-stage");
  const stages = [...view.host.querySelectorAll(".trace-stage")].map((stage) =>
    [...stage.querySelectorAll(".trace-card-who")].map((el) => el.textContent?.trim()),
  );
  expect(stages).toEqual([["你"], ["制片"], ["分镜师"]]);
  expect(view.host.querySelectorAll(".trace-flow-link")).toHaveLength(2);
  expect(view.host.querySelector(".trace-card.is-running .trace-summary")?.textContent).toBe("正在画第一格");
  expect(view.host.querySelector(".trace-card.is-completed")).not.toBeNull();
  expect(view.host.querySelector(".trace-card.is-running")).not.toBeNull();
  // The window floats over the chat: no dimmed page behind it, and the node on screen is marked.
  expect(view.host.querySelector(".trace-overlay")?.getAttribute("aria-modal")).toBe("false");
  expect(view.host.querySelectorAll(".trace-card.is-here")).toHaveLength(2);
  expect(view.host.querySelector(".trace-place")?.textContent).toContain("群 · 制作组");
  expect(view.host.querySelector(".trace-output")).toBeNull();

  click(view.host.querySelector(".trace-card.is-running .trace-card-main"));
  expect(view.jumps).toEqual([["direct-1", "m-approval"]]);

  click(buttonByText(view.host, "board.pdf"));
  const output = await until(view.host, ".trace-output");
  expect(output.querySelector(".trace-output-kicker")?.textContent).toBe("分镜师交出");
  expect(output.querySelector(".trace-output-name")?.textContent).toBe("board.pdf");
  expect(view.host.querySelector(".trace-file.is-open")).not.toBeNull();
  // The file hangs under the turn that handed it over, as the next station of the flow.
  expect(view.host.querySelector(".trace-stage:last-child .trace-output")).not.toBeNull();
  expect(view.host.querySelector(".artifact-pane")).toBeNull();
  view.close();
});

test("a phone shows the flow as a page, with nothing to drag or resize", async () => {
  localStorage.setItem("real-bot-trace-window", JSON.stringify({ x: 40, y: 50, width: 500, height: 420 }));
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
    await until(view.host, ".trace-stage");
    const overlay = view.host.querySelector(".trace-overlay");
    expect(overlay?.classList.contains("is-page")).toBe(true);
    expect(overlay?.getAttribute("aria-modal")).toBe("true");
    expect(view.host.querySelector(".trace-resize")).toBeNull();
    const pane = view.host.querySelector(".trace-pane") as HTMLElement;
    expect(pane.style.left).toBe("");
    expect(pane.style.width).toBe("");
  } finally {
    try { view?.close(); } catch { /* the page slide has nothing to animate here */ }
    window.matchMedia = previous;
    localStorage.removeItem("real-bot-trace-window");
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
  await until(view.host, ".trace-stage");
  click(view.host.querySelector("[data-switch]"));
  await until(view.host, ".trace-empty");
  expect(asked).toContain("direct-9");
  expect(view.host.querySelector(".trace-titles h2")?.textContent).toContain("另一件事");
  view.close();
});

test("the switcher opens another job from this session", async () => {
  const view = open();
  await until(view.host, ".trace-job");
  click(buttonByText(view.host, "上周的排期"));
  await until(view.host, ".trace-empty");
  expect(view.host.querySelector(".trace-titles h2")?.textContent).toContain("上周的排期");
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
