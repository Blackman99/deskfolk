import { afterEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import { builtinPlaybook, type AcceptanceCheck, type PlanRequirement, type Playbook, type TaskDetail, type TaskTrace } from "@real-bot/protocol";
import { mockMonacoCss } from "../test-mocks.ts";

mockMonacoCss();
import { copyFor } from "../copy.ts";
import { forgetTraceMinimap } from "./trace-minimap.ts";
import { forgetSpentAsks, forgetTraceView, loadTraceView, saveTraceView } from "./trace-view.ts";
import { forgetKeptBoards } from "./task-trace.ts";
import { click } from "../test-render.ts";
import { settle } from "../test-async.ts";
import { detail, job, open, picture, until } from "./task-trace-test-kit.ts";

const t = copyFor("zh");

afterEach(() => {
  forgetKeptBoards();
  forgetTraceMinimap();
  forgetSpentAsks();
  forgetTraceView();
});

function aRequirement(over: Partial<PlanRequirement> = {}): PlanRequirement {
  return {
    id: "req-plan", seq: 1, quote: "不要真人出镜", restated: null, category: null, polarity: "must", dimension: null, value: null,
    status: "open", scope: "plan", ticket_id: null, domain: null, times_raised: 1, plans_raised: 1, last_raised_at: "2026-09-22T00:00:00.000Z",
    source_kind: "message", source: null, added_by: "scribe", inherited_from: null, excluded: false, supersedes: null, ...over,
  };
}

function aTicketCheck(over: Partial<AcceptanceCheck> = {}): AcceptanceCheck {
  return {
    id: "check-1", task_id: "task-1", ticket_id: "tk-1", item: "12 格草图交到 board.pdf", kind: "exists", path: "work/先出分镜-7f3k/01-分镜草图/board.pdf",
    pattern: null, negate: false, command: null, cwd: null, expect_exit: null, expect_stdout: null, timeout_sec: null, source: "user",
    created_at: "2026-09-22T00:00:00.000Z", updated_at: "2026-09-22T00:00:00.000Z", defined_at: "2026-09-22T00:00:00.000Z",
    first_passed_at: null, last_run: null, running: false, ...over,
  };
}

/** task-1 with what the spec holds to its tickets: one requirement over the plan, one for 02 alone, a check filed under 01. */
function linkedDetail(): TaskDetail {
  return detail({
    requirements: [aRequirement(), aRequirement({ id: "req-02", seq: 2, quote: "配乐要无版权", scope: "ticket", ticket_id: "tk-2" })],
    checks: [aTicketCheck()],
  });
}

const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>(".rail-row")];
const rowOf = (host: HTMLElement, title: string) => rows(host).find((row) => row.textContent?.includes(title))!;
const inspector = (host: HTMLElement) => host.querySelector<HTMLElement>(".job-inspector-inner")?.dataset.inspector ?? null;

/** The narrow switch's tabs, as they read: 任务 with its count, 流程, 要点. */
function viewTabs(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>(".trace-views [role='tab']")];
}

function viewTab(host: HTMLElement, label: string): HTMLButtonElement {
  const found = viewTabs(host).find((tab) => tab.textContent?.replace(/\s+/g, "").startsWith(label));
  if (!found) throw new Error(`no view tab ${label}`);
  return found;
}

/** Narrow, which part of the job is on screen; wide, "all". */
function viewOn(host: HTMLElement): string | null {
  return host.querySelector(".job-pane")?.getAttribute("data-view") ?? null;
}

test("a wide job is one tab: the title row reads the plan, the rail its tickets, the inspector its spec, with no switch", async () => {
  const view = open({ pane: true });
  await until(view.host, ".rail-row");
  expect(view.host.querySelector(".trace-titles h2")?.textContent).toBe("这件事 · 先出分镜");
  const meta = view.host.querySelector(".trace-meta")!;
  expect(meta.querySelector(".plan-status.is-active")?.textContent).toBe(t.plan.status.active);
  expect(meta.textContent).toContain(t.plan.ticketCounts(2, 2));
  // All three parts side by side, and nothing to switch between.
  expect(viewOn(view.host)).toBe("all");
  expect(view.host.querySelector(".trace-views")).toBeNull();
  expect(view.host.querySelector(".job-rail .ticket-rail")).not.toBeNull();
  expect(view.host.querySelector(".job-flow .trace-stage")).not.toBeNull();
  // The rail, in order, each with its owner's face and its status.
  expect(rows(view.host).map((row) => row.querySelector(".rail-tag")?.textContent)).toEqual(["01", "02"]);
  expect(rowOf(view.host, "分镜草图").querySelector(".rail-avatar")?.getAttribute("title")).toBe("分镜师");
  expect(rowOf(view.host, "配乐").querySelector(".rail-avatar")).toBeNull();
  expect(rowOf(view.host, "分镜草图").querySelector(".rail-stage")?.textContent).toBe(t.plan.ticketStatus.doing);
  // 01's lane has the one turn worked in it; your line and 制片's unfiled turn have rows of their own.
  expect(rowOf(view.host, "分镜草图").querySelectorAll(".rail-mark")).toHaveLength(1);
  expect(view.host.querySelector(".rail-context .rail-title-text")?.textContent).toBe(t.plan.job.yours);
  expect(view.host.querySelector(".rail-context.is-loose")).not.toBeNull();
  // With nothing picked, the inspector is the whole job's spec.
  expect(inspector(view.host)).toBe("spec");
  expect(view.host.querySelector(".job-inspector .insp-label")?.textContent).toBe(t.plan.job.wholeJob);
  expect(view.host.querySelector(".job-inspector")?.textContent).toContain("12 格草图交到 board.pdf");
  // The card that worked in a ticket still wears its number.
  expect(view.host.querySelector(".trace-card.is-running .trace-ticket-tag")?.textContent).toBe("01");
  view.close();
});

test("the rail's counts leave out the dropped and set-aside, as the title row's do", async () => {
  const counts = { todo: 1, doing: 1, review: 0, done: 3, parked: 2 };
  const view = open({ pane: true, detail: detail({ ticket_counts: counts }), jobs: [job({ ticket_counts: counts }), job({ id: "task-2", title: "上周的排期" })] });
  await until(view.host, ".rail-row");
  expect(view.host.querySelector(".trace-meta")?.textContent).toContain("2 未完成 · 共 5 · 作废/搁置 2");
  expect(view.host.querySelector(".rail-counts")?.textContent).toBe(t.plan.ticketCounts(2, 5, 2));
  view.close();
});

test("a ticket picked on the rail lights its cards, turns the inspector to it, and Escape lets go", async () => {
  const view = open({ pane: true });
  await until(view.host, ".rail-row");
  click(rowOf(view.host, "分镜草图"));
  expect(rowOf(view.host, "分镜草图").getAttribute("aria-pressed")).toBe("true");
  expect(view.host.querySelector(".trace-card.is-running")?.classList.contains("is-lit")).toBe(true);
  expect(view.host.querySelector(".trace-card.is-completed")?.classList.contains("is-dim")).toBe(true);
  expect(inspector(view.host)).toBe("ticket");
  expect(view.host.querySelector(".insp-tag")?.textContent).toBe("#01");
  expect(view.host.querySelector(".insp-title")?.textContent).toBe("分镜草图");
  expect(view.host.querySelector(".insp-spec")?.textContent).toBe("画满 12 格");
  // Its files open in the host's preview with the plan's folder as the tree; its latest turn is one press away.
  click([...view.host.querySelectorAll(".insp-link")].find((link) => link.textContent === t.plan.artifacts(1)));
  expect(view.opened).toEqual([{ relpath: "work/先出分镜-7f3k/01-分镜草图/board.pdf", messageId: "m3", forceTree: true, taskId: "task-1", siblings: 1 }]);
  click([...view.host.querySelectorAll(".insp-link")].find((link) => link.textContent === t.plan.jumpToTurn));
  expect(view.jumps).toEqual([["direct-1", "m3"]]);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(view.host.querySelector(".rail-row.is-picked")).toBeNull();
  expect(view.host.querySelector(".trace-card.is-dim")).toBeNull();
  expect(inspector(view.host)).toBe("spec");
  view.close();
});

test("the picked ticket says what it meets, and its 「在要点里看」 holds the spec to it until you go back", async () => {
  const view = open({ pane: true, detail: linkedDetail() });
  await until(view.host, ".rail-row");
  click(rowOf(view.host, "分镜草图"));
  const owes = view.host.querySelector(".job-inspector .ticket-owes")!;
  const links = t.plan.links;
  expect(owes.querySelector(".ticket-owes-plan")?.textContent).toBe(
    links.planWide([links.acceptanceCount(1), links.rulesCount(1), links.requirementsCount(1)].join(links.join)),
  );
  expect([...owes.querySelectorAll(".ticket-owes-list li")].map((row) => row.textContent)).toEqual([
    `${t.plan.checks.status.none}work/先出分镜-7f3k/01-分镜草图/board.pdf 存在且不为空`,
  ]);
  click(owes.querySelector(".ticket-owes-spec"));
  await settle();
  expect(inspector(view.host)).toBe("spec");
  expect(view.host.querySelector(".insp-back")?.textContent?.trim()).toBe(t.plan.job.backToTicket("#01"));
  const focusStrip = view.host.querySelector(".plan-spec-focus")!;
  expect(focusStrip.querySelector(".plan-spec-ticket-ref")?.textContent).toBe("01");
  expect(view.host.querySelector(".plan-spec-check")?.classList.contains("is-ticket-mine")).toBe(true);
  expect(view.host.querySelector('.plan-req[data-requirement="req-02"]')?.className).toContain("is-ticket-other");
  // Still picked: the rail and the trace say so.
  expect(view.host.querySelector(".rail-row.is-picked .rail-tag")?.textContent).toBe("01");
  expect(view.host.querySelector(".trace-card.is-running")?.classList.contains("is-lit")).toBe(true);
  click(view.host.querySelector(".insp-back"));
  await settle();
  expect(inspector(view.host)).toBe("ticket");
  view.close();
});

test("the spec's ticket names pick that ticket, and its ticket states narrow the rail to one status", async () => {
  const view = open({ pane: true, detail: linkedDetail() });
  await until(view.host, ".rail-row");
  const scope = view.host.querySelector<HTMLButtonElement>('.plan-req[data-requirement="req-02"] .plan-req-ticket')!;
  expect(scope.textContent).toBe(t.plan.requirements.scope.ticket("02 配乐"));
  click(scope);
  await settle();
  expect(view.host.querySelector(".rail-row.is-picked .rail-tag")?.textContent).toBe("02");
  expect(inspector(view.host)).toBe("ticket");
  expect(view.host.querySelector(".insp-tag")?.textContent).toBe("#02");
  // Back on the whole job, a state lets only that status through on the rail, until you clear it.
  click(view.host.querySelector(".insp-icon[aria-label='" + t.plan.job.unpick + "']"));
  await settle();
  const states = [...view.host.querySelectorAll<HTMLButtonElement>(".plan-spec-ticket-state")];
  click(states.find((state) => state.textContent?.includes(t.plan.ticketStatus.doing)));
  await settle();
  expect(rows(view.host).map((row) => row.querySelector(".rail-tag")?.textContent)).toEqual(["01"]);
  expect(view.host.querySelector(".rail-filter")?.textContent).toContain(t.plan.job.filtered(t.plan.ticketStatus.doing));
  click(view.host.querySelector(".rail-filter-clear"));
  expect(rows(view.host)).toHaveLength(2);
  view.close();
});

test("the rail opens out into the board of five columns over the rail and the trace, and closes back", async () => {
  const view = open({ pane: true });
  await until(view.host, ".rail-row");
  click(view.host.querySelector(".rail-expand"));
  await settle();
  expect(view.host.querySelectorAll("[data-board-status]")).toHaveLength(5);
  expect(view.host.querySelector(".job-pane")?.classList.contains("board-open")).toBe(true);
  // The trace is hidden where it is, not unmounted: its camera is kept.
  expect(view.host.querySelector(".job-flow .trace-stage")).not.toBeNull();
  // A card picked on the board turns the inspector to it; the card itself does not unfold.
  const sketch = [...view.host.querySelectorAll(".ticket-row")].find((row) => row.textContent?.includes("分镜草图"))!;
  click(sketch.querySelector(".ticket-main"));
  expect(inspector(view.host)).toBe("ticket");
  expect(sketch.querySelector(".ticket-owes")).toBeNull();
  expect(view.host.querySelector(".job-inspector .ticket-owes")).not.toBeNull();
  // 「在流程里看」 closes the board on the ticket's rounds.
  click(sketch.querySelector(".ticket-show-trace"));
  await settle();
  expect(view.host.querySelector("[data-board-status]")).toBeNull();
  expect(view.host.querySelector(".trace-card.is-running")?.classList.contains("is-lit")).toBe(true);
  // Opened again and closed by its own button.
  click(view.host.querySelector(".rail-expand"));
  await settle();
  click(view.host.querySelector(".job-board-close"));
  await settle();
  expect(view.host.querySelector("[data-board-status]")).toBeNull();
  view.close();
});

test("a status changed in the inspector goes through the job's one queue of edits", async () => {
  const view = open({ pane: true });
  await until(view.host, ".rail-row");
  click(rowOf(view.host, "配乐"));
  const menu = view.host.querySelector<HTMLButtonElement>(".job-inspector .insp-status-menu .real-select-trigger, .job-inspector .insp-status-menu button")!;
  click(menu);
  const done = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((option) => option.textContent?.trim() === t.plan.ticketStatus.done)!;
  click(done);
  await settle();
  expect(view.patched).toEqual([["tk-2", { status: "done", if_revision: 2 }]]);
  view.close();
});

test("switching the job switches every part: the rail, the trace and the inspector", async () => {
  const view = open({ pane: true });
  await until(view.host, ".rail-row");
  click(rowOf(view.host, "分镜草图"));
  click(await until(view.host, ".trace-title-trigger"));
  click([...view.host.querySelectorAll<HTMLElement>(".trace-job")].find((row) => row.textContent?.includes("上周的排期")));
  for (let i = 0; i < 20 && !view.host.querySelector(".trace-titles h2")?.textContent?.includes("上周的排期"); i += 1) await settle();
  expect(view.host.querySelector(".trace-titles h2")?.textContent).toContain("上周的排期");
  // task-2 has no tickets: no rail, and its spec beside the trace.
  expect(view.host.querySelector(".ticket-rail")).toBeNull();
  expect(inspector(view.host)).toBe("spec");
  view.close();
});

test("a tab saved before the job was one tab opens as it asked: the board opened out, or the spec held to its ticket", async () => {
  const board = open({ pane: true, view: "board" });
  await until(board.host, "[data-board-status]");
  expect(board.host.querySelectorAll("[data-board-status]")).toHaveLength(5);
  board.close();
  const spec = open({ pane: true, view: "spec", detail: linkedDetail(), ask: { ticket: "tk-1" }, askToken: 3 });
  await until(spec.host, ".plan-spec-focus");
  expect(spec.host.querySelector(".plan-spec-focus .plan-spec-ticket-ref")?.textContent).toBe("01");
  expect(spec.host.querySelector(".rail-row.is-picked .rail-tag")?.textContent).toBe("01");
  spec.close();
});

test("a tab's request is acted on once its job is here, and not again when the tab comes back", async () => {
  const first = open({ pane: true, view: "board", ask: { ticket: "tk-2" }, askToken: 41 });
  await until(first.host, ".rail-row.is-picked");
  expect(first.host.querySelector(".rail-row.is-picked .rail-tag")?.textContent).toBe("02");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  first.close();
  const again = open({ pane: true, view: "board", ask: { ticket: "tk-2" }, askToken: 41 });
  await until(again.host, ".rail-row");
  await settle();
  expect(again.host.querySelector(".rail-row.is-picked")).toBeNull();
  again.props.ask = { ticket: "tk-1" };
  again.props.askToken = 42;
  await until(again.host, ".rail-row.is-picked");
  expect(again.host.querySelector(".rail-row.is-picked .rail-tag")?.textContent).toBe("01");
  again.close();
});

test("a plan with no tickets has no rail; a daemon that predates plans draws the trace alone", async () => {
  const empty = open({ pane: true, detail: { ...detail(), tickets: [] } });
  await until(empty.host, ".job-inspector");
  expect(empty.host.querySelector(".ticket-rail")).toBeNull();
  expect(empty.host.querySelector(".job-pane")?.classList.contains("has-rail")).toBe(false);
  empty.close();
  const old = open({ detail: false, pane: true });
  await until(old.host, ".trace-slot");
  expect(old.host.querySelector(".trace-titles h2")?.textContent).toContain("先出分镜");
  expect(old.host.querySelector(".ticket-rail")).toBeNull();
  expect(old.host.querySelector(".job-inspector")).toBeNull();
  expect(old.host.querySelector(".trace-views")).toBeNull();
  expect(old.host.querySelectorAll(".trace-card")).toHaveLength(3);
  old.close();
});

test("a phone has the job's three parts behind one switch, and a ticket picked comes up as a sheet", async () => {
  const view = open({ detail: linkedDetail() });
  await until(view.host, ".trace-views");
  const selected = () => viewTabs(view.host).map((tab) => tab.getAttribute("aria-selected"));
  expect(viewTabs(view.host).map((tab) => tab.textContent?.replace(/\s+/g, ""))).toEqual([`${t.plan.job.segmentTasks}2`, t.plan.segmentTrace, t.plan.segmentSpec]);
  expect(selected()).toEqual(["false", "true", "false"]);
  expect(viewOn(view.host)).toBe("trace");
  expect(view.host.querySelector(".job-inspector")).toBeNull();
  click(viewTab(view.host, t.plan.job.segmentTasks));
  expect(viewOn(view.host)).toBe("board");
  click(rowOf(view.host, "配乐"));
  expect(view.host.querySelector(".job-inspector")?.classList.contains("is-sheet")).toBe(true);
  expect(inspector(view.host)).toBe("ticket");
  // Its 「在要点里看」 turns to the spec, held to it.
  click(view.host.querySelector(".job-inspector .ticket-owes-spec"));
  await settle();
  expect(viewOn(view.host)).toBe("spec");
  expect(view.host.querySelector(".plan-spec-focus .plan-spec-ticket-ref")?.textContent).toBe("02");
  expect(view.host.querySelector(".job-inspector")?.classList.contains("is-sheet")).toBe(false);
  view.close();
});

test("narrow, one part at a time has the body, hidden in place, and the one picked is the next job's too", async () => {
  const view = open({});
  await until(view.host, ".trace-views");
  const on = () => [".job-rail", ".job-flow"].map((selector) => view.host.querySelector(selector)?.classList.contains("is-on"));
  expect(on()).toEqual([false, true]);
  click(viewTab(view.host, t.plan.job.segmentTasks));
  expect(on()).toEqual([true, false]);
  click(viewTab(view.host, t.plan.segmentSpec));
  expect(view.host.querySelector(".job-inspector")?.classList.contains("is-on")).toBe(true);
  expect(loadTraceView()).toBe("spec");
  view.close();
  const again = open({});
  await until(again.host, ".trace-views");
  expect(viewOn(again.host)).toBe("spec");
  again.close();
});

test("narrow, a message asking for its card brings the trace up without changing the part remembered", async () => {
  saveTraceView("board");
  const view = open({ focus: { messageId: "m3", turnId: "t-artist" }, focusToken: 1 });
  await until(view.host, ".trace-views");
  expect(viewOn(view.host)).toBe("trace");
  click(viewTab(view.host, t.plan.job.segmentTasks));
  expect(viewOn(view.host)).toBe("board");
  view.props.focus = { messageId: "m3", turnId: "t-artist" };
  view.props.focusToken = 2;
  await settle();
  expect(viewOn(view.host)).toBe("trace");
  expect(loadTraceView()).toBe("board");
  view.close();
});

test("narrow, a plan with no tickets has no tickets to switch to, and a part left on them falls back to the trace", async () => {
  saveTraceView("board");
  const view = open({ detail: { ...detail(), tickets: [] } });
  await until(view.host, ".trace-views");
  expect(viewTabs(view.host).map((tab) => tab.textContent?.trim())).toEqual([t.plan.segmentTrace, t.plan.segmentSpec]);
  expect(viewOn(view.host)).toBe("trace");
  view.close();
});

/** 制片 (bot-1) working 分镜师's ticket 01 turn after turn, the way 审片员 worked 视频导演's on 2026-10-11. */
function reviewedInAllButName(): TaskTrace {
  const trace = picture();
  const at = (i: number) => new Date(Date.parse("2026-09-22T00:00:03.000Z") + i * 60_000).toISOString();
  for (let i = 0; i < 5; i += 1) {
    trace.nodes.push({ ...trace.nodes[2]!, turn_id: `t-review-${i}`, actor: "bot-1", status: "completed", ticket_id: "tk-1", created_at: at(i), artifacts: [], approval: null });
  }
  return trace;
}

test("the whole job's view says who does what: each Bot's tickets as written down beside the turns it ran", async () => {
  const view = open({ pane: true });
  await until(view.host, ".job-division");
  const rows = [...view.host.querySelectorAll<HTMLElement>(".job-division tbody tr")];
  expect(rows.map((row) => [...row.querySelectorAll("th, td")].map((cell) => cell.textContent?.replace(/\s+/g, " ").trim()))).toEqual([
    ["制片", "—", "—", `1 ${t.plan.job.division.loose(1)}`],
    ["分镜师", "#01", "—", "1"],
  ]);
  expect(view.host.querySelector(".job-division .job-block-note")).toBeNull();
  view.close();
});

test("a ticket worked by a Bot besides its owner says so on the rail, and the inspector offers that Bot as its reviewer", async () => {
  const view = open({ pane: true, trace: reviewedInAllButName(), detail: detail({ submissions_on: true, reviewer_ids: ["bot-1", "bot-2"] }) });
  await until(view.host, ".rail-row");
  expect(rowOf(view.host, "分镜草图").querySelector(".rail-besides")?.textContent?.trim()).toBe(t.plan.job.ranAlso("制片"));
  click(rowOf(view.host, "分镜草图"));
  expect([...view.host.querySelectorAll(".job-inspector [data-ran-bot]")].map((who) => who.textContent?.replace(/\s+/g, " ").trim())).toEqual(["制片 5", "分镜师 1"]);
  const hint = view.host.querySelector(".job-inspector .ticket-reviewer-hint")!;
  expect(hint.textContent).toContain(t.plan.job.reviewerHint("制片", 5));
  click(hint.querySelector("button"));
  await settle();
  expect(view.patched).toEqual([["tk-1", { reviewer_bot_id: "bot-1", if_revision: 2 }]]);
  view.close();
});

test("no reviewer is offered where reviews are off, or for fewer than five turns", async () => {
  const off = open({ pane: true, trace: reviewedInAllButName() });
  await until(off.host, ".rail-row");
  click(rowOf(off.host, "分镜草图"));
  expect(off.host.querySelector(".job-inspector [data-ran-bot]")).not.toBeNull();
  expect(off.host.querySelector(".ticket-reviewer-hint")).toBeNull();
  off.close();
  const few = open({ pane: true, detail: detail({ submissions_on: true, reviewer_ids: ["bot-1", "bot-2"] }) });
  await until(few.host, ".rail-row");
  click(rowOf(few.host, "分镜草图"));
  expect(few.host.querySelector(".ticket-reviewer-hint")).toBeNull();
  few.close();
});

test("the job names the engine its own calls run under, what it leaves off, and opens Roles on it", async () => {
  const general: Playbook = { id: "general", builtin: true, base_id: "general", name: null, revision: 0, revision_id: null, diff: { v: 1, steps: {} }, resolved: builtinPlaybook("general"), updated_at: null };
  const view = open({ pane: true, playbooks: { default_id: "general", items: [general] } });
  await until(view.host, ".job-engine");
  const block = view.host.querySelector(".job-engine")!;
  expect(block.querySelector(".job-engine-chip")?.textContent).toBe(t.plan.job.engine.chip(t.playbooks.builtin.general));
  expect(block.querySelector(".job-engine-why")?.textContent).toBe(t.plan.job.engine.fallback);
  expect(block.querySelector(".job-block-note")?.textContent).toBe(
    `${t.plan.job.engine.off([t.playbooks.steps.scribe!.name, t.playbooks.steps.retrospective!.name, t.playbooks.steps.reflection!.name].join("、"))} · ${t.plan.job.engine.sessions(2)}`,
  );
  // The title row says it too, and both open Roles on it.
  click([...view.host.querySelectorAll<HTMLButtonElement>(".job-chip")].find((chip) => chip.textContent === t.plan.job.engine.chip(t.playbooks.builtin.general)));
  click(block.querySelector(".job-engine-open"));
  expect(view.rolesOpened).toEqual(["general", "general"]);
  view.close();
  // A daemon older than engines: nothing is said of one.
  const old = open({ pane: true });
  await until(old.host, ".job-division");
  expect(old.host.querySelector(".job-engine")).toBeNull();
  old.close();
});

test("the title row says how many things need you, and takes you to the whole job's plan", async () => {
  const failing = detail({
    checks: [aTicketCheck({ last_run: { id: "run-1", check_id: "check-1", task_id: "task-1", cause: "settle", started_at: "2026-09-22T00:00:00.000Z", finished_at: "2026-09-22T00:00:01.000Z", outcome: "fail", exit_code: 1, detail: "没找到", output: null } })],
  });
  const view = open({ pane: true, detail: failing });
  await until(view.host, ".rail-row");
  const chip = [...view.host.querySelectorAll<HTMLButtonElement>(".job-chip.is-attention")];
  expect(chip.map((button) => button.textContent)).toEqual([t.plan.job.attention(1)]);
  click(rowOf(view.host, "分镜草图"));
  expect(inspector(view.host)).toBe("ticket");
  click(chip[0]);
  await settle();
  expect(inspector(view.host)).toBe("spec");
  expect(view.host.querySelector(".rail-row.is-picked")).toBeNull();
  view.close();
  const quiet = open({ pane: true });
  await until(quiet.host, ".rail-row");
  expect(quiet.host.querySelector(".job-chip.is-attention")).toBeNull();
  quiet.close();
});
