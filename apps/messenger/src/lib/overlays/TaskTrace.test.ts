import { expect, mock, test } from "bun:test";
import { flushSync } from "svelte";
import { USER_MEMBER, type SessionTaskSummary, type TaskTrace } from "@real-bot/protocol";

mock.module("monaco-editor-css", () => ({}));
mock.module("monaco-editor/esm/vs/platform/hover/browser/hover.css", () => ({}));
mock.module("monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css", () => ({}));
const { default: TaskTraceView } = await import("./TaskTrace.svelte");
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
  const props = reactive({
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
  const view = render(TaskTraceView, props as never);
  return { ...view, props, jumps, asked, closed: () => closed };
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
  await until(view.host, ".trace-slot");
  // Cards sit where the layout put them, so reading order is the y they were given.
  const byRow = [...view.host.querySelectorAll<HTMLElement>(".trace-slot")]
    .map((slot) => ({
      top: Number.parseInt(slot.style.top, 10),
      who: slot.querySelector(".trace-card-who")?.textContent?.trim(),
    }))
    .sort((a, b) => a.top - b.top);
  expect(byRow.map((row) => row.who)).toEqual(["你", "制片", "分镜师"]);
  expect(new Set(byRow.map((row) => row.top)).size).toBe(3);
  // Every handoff is a drawn curve now, not a divider between rows.
  const edges = [...view.host.querySelectorAll(".trace-edges path")];
  expect(edges).toHaveLength(2);
  expect(edges.every((edge) => (edge.getAttribute("d") ?? "").includes("C"))).toBe(true);
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
  expect(view.host.querySelector(".trace-slot .trace-output")).not.toBeNull();
  expect(view.host.querySelector(".artifact-pane")).toBeNull();
  view.close();
});

test("any corner resizes the window, and the corner across from it stays put", async () => {
  localStorage.setItem("real-bot-trace-window", JSON.stringify({ x: 300, y: 200, width: 440, height: 480 }));
  const view = open();
  try {
    await until(view.host, ".trace-slot");
    const grips = [...view.host.querySelectorAll(".trace-resize")];
    const corner = (grip: Element) =>
      [...grip.classList].find((name) => name.startsWith("trace-resize-"));
    expect(grips.map(corner)).toEqual([
      "trace-resize-nw",
      "trace-resize-ne",
      "trace-resize-sw",
      "trace-resize-se",
    ]);
    // Nothing is drawn on the corner; only the cursor says a corner is a corner.
    expect(grips.every((grip) => grip.textContent === "")).toBe(true);

    drag(grips[0]!, { x: -60, y: -40 });
    const pane = view.host.querySelector(".trace-pane") as HTMLElement;
    // The top-left went out by the drag; the bottom-right is where it was: 740, 680.
    expect([pane.style.left, pane.style.top, pane.style.width, pane.style.height]).toEqual([
      "240px",
      "160px",
      "500px",
      "520px",
    ]);
    expect(JSON.parse(localStorage.getItem("real-bot-trace-window") ?? "null")).toEqual({
      x: 240,
      y: 160,
      width: 500,
      height: 520,
    });

    drag(grips[3]!, { x: -100, y: -100 });
    // Pulling the bottom-right in leaves the top-left alone.
    expect([pane.style.left, pane.style.top, pane.style.width, pane.style.height]).toEqual([
      "240px",
      "160px",
      "400px",
      "420px",
    ]);
  } finally {
    view.close();
    localStorage.removeItem("real-bot-trace-window");
  }
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
    await until(view.host, ".trace-slot");
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

test("on a phone, Back steps out of full screen and leaves the flow standing", async () => {
  const previous = window.matchMedia;
  let view: ReturnType<typeof open> | undefined;
  window.matchMedia = ((query: string) => ({
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
    const back = (view.app as unknown as { backFromFullOutput: () => boolean }).backFromFullOutput;
    // Nothing over the flow: Back is history's, and the flow is what it closes.
    expect(back()).toBe(false);

    click(buttonByText(view.host, "board.pdf"));
    const output = await until(view.host, ".trace-output");
    // A file unfolded under its card is part of this page, so Back still belongs to history.
    expect(back()).toBe(false);
    expect(view.host.querySelector(".trace-output")).not.toBeNull();

    click(output.querySelector(".trace-output-full"));
    flushSync();
    expect(view.host.querySelector(".trace-output-layer .trace-output.is-full")).not.toBeNull();
    // Full screen is a page over the flow: Back takes that page and stops.
    expect(back()).toBe(true);
    flushSync();
    expect(view.host.querySelector(".trace-output.is-full")).toBeNull();
    expect(view.host.querySelector(".trace-slot .trace-output")).not.toBeNull();
    expect(back()).toBe(false);
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
      return this.classList.contains("trace-slot") ? 80 + (this.textContent?.length ?? 0) : 0;
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

    // The same job, fetched again — which is all a live turn does.
    (view.props as { reloadToken: number }).reloadToken = 1;
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 60));
    flushSync();
    expect(tops()).toEqual(measured);
  });
});
