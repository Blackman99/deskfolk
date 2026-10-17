import { afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { flushSync } from "svelte";
import { USER_MEMBER, type Hold, type RouteRecord, type SessionTaskSummary, type TaskTrace } from "@real-bot/protocol";
import { mockMonacoCss } from "../test-mocks.ts";

mockMonacoCss();
const { default: TaskTraceView } = await import("./TaskTrace.svelte");
import { copyFor } from "../copy.ts";
import { forgetTraceMinimap, loadTraceMinimap } from "./trace-minimap.ts";
import { forgetSpentAsks } from "./trace-view.ts";
import { forgetKeptBoards } from "./task-trace.ts";
import { aBot, aDirect, aGroup, aHold } from "../test-fixtures.ts";
import { buttonByText, click, press, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { settle } from "../test-async.ts";

import { writer, artist, group, direct, job, detail, picture, drag, type Opened, open, until, aRecord, routedPicture, withMeasuredCards } from "./task-trace-test-kit.ts";

const t = copyFor("zh");

// A board left in one test would otherwise come back where that test left it in the next.
afterEach(() => {
  forgetKeptBoards();
  forgetTraceMinimap();
  forgetSpentAsks();
});

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

test("a card that runs on as the one before it did says it once: chip for the model, no ticket or place again", async () => {
  const base = routedPicture();
  const artistTurn = base.nodes[2]!;
  const again = (turn: string, from: string, at: string, model: string) => ({
    ...artistTurn,
    turn_id: turn,
    status: "completed" as const,
    woken_by_turn_id: from,
    approval: null,
    artifacts: [],
    summary: `${turn} 的话`,
    created_at: at,
    route: {
      record: aRecord({ turn_id: turn, session_id: "direct-1", bot_id: "bot-2", model, thinking_level: "medium", signature: "writing", chain_id: turn }),
      review: null,
      learning: null,
    },
  });
  const view = open({
    trace: { ...base, nodes: [...base.nodes, again("t-artist-2", "t-artist", "2026-09-22T00:00:03.000Z", "gemini-3.8"), again("t-artist-3", "t-artist-2", "2026-09-22T00:00:04.000Z", "gemini-3.9")] },
  });
  await until(view.host, ".trace-slot");
  const cardOf = (summary: string) =>
    [...view.host.querySelectorAll<HTMLElement>(".trace-card")].find((card) => card.querySelector(".trace-summary")?.textContent === summary)!;
  // The direct and ticket 01 are named where the work moved there, on the first card in them.
  expect(cardOf("正在画第一格").querySelector(".trace-place")).not.toBeNull();
  expect(cardOf("正在画第一格").querySelector(".trace-ticket-tag")?.textContent).toBe("01");
  for (const later of ["t-artist-2 的话", "t-artist-3 的话"]) {
    expect(cardOf(later).querySelector(".trace-place")).toBeNull();
    expect(cardOf(later).querySelector(".trace-ticket-tag")).toBeNull();
  }
  // The same model choice as the card before is a chip; a changed one is a whole line again.
  const repeated = cardOf("t-artist-2 的话");
  expect(repeated.querySelector(".trace-route-line")).toBeNull();
  const chip = repeated.querySelector<HTMLButtonElement>(".trace-route-chip")!;
  expect(chip.textContent).toBe("gemini-3.8");
  expect(chip.closest(".trace-card-main")).toBeNull();
  expect(cardOf("t-artist-3 的话").querySelector(".trace-route-chip")).toBeNull();
  expect(cardOf("t-artist-3 的话").querySelector(".trace-route-model")?.textContent).toBe("gemini-3.9");
  // The chip still opens what came of the turn, under its card.
  click(chip);
  flushSync();
  expect(chip.getAttribute("aria-expanded")).toBe("true");
  expect(repeated.closest(".trace-slot")?.querySelector(".trace-route")).not.toBeNull();
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
  // A finished card wears no colour, so a live one stands out of it — in the dark too, where the
  // live card's border is the solid teal, not a wash that settles into the line's grey.
  const palette = document.createElement("style");
  palette.textContent = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");
  const previousTheme = document.documentElement.getAttribute("data-theme");
  document.head.append(palette);
  document.documentElement.dataset.theme = "dark";
  try {
    expect(getComputedStyle(view.host.querySelector(".trace-card.is-completed")!).borderTopColor).toBe("#2e393e");
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
  // Your own card carries no status: it was sent. A finished turn says nothing either; the live one does.
  expect([...view.host.querySelectorAll(".trace-status")].map((status) => status.textContent)).toEqual([t.trace.status.running]);
  expect(view.host.querySelector(".trace-card.is-completed .trace-status")).toBeNull();

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
