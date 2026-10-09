import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { PlanRequirement, RequirementActionRequest, TaskDetail } from "@real-bot/protocol";
import PlanRequirements from "./PlanRequirements.svelte";
import { copyFor } from "../copy.ts";
import { buttonByText, click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { settleTimers as settle } from "../test-async.ts";

const t = copyFor("zh");

function anEntry(over: Partial<PlanRequirement> = {}): PlanRequirement {
  return {
    id: "r1",
    seq: 1,
    quote: "片长约 2 分钟",
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
    last_raised_at: "2026-09-28T04:02:00.000Z",
    source_kind: "message",
    source: { via: "message", session_id: "group-1", message_id: "m1", at: "2026-09-28T04:02:00.000Z" },
    added_by: "scribe",
    inherited_from: null,
    excluded: false,
    supersedes: null,
    ...over,
  };
}

function aDetail(requirements: PlanRequirement[]): TaskDetail {
  return {
    id: "task-9ag7",
    dir: "work/未来世界短片-abcd",
    title: "未来世界短片",
    session_id: "group-1",
    closed_at: null,
    last_activity_at: "2026-09-29T05:22:00.000Z",
    goal: "未来世界短片",
    kind: null,
    status: "active",
    ticket_counts: { todo: 0, doing: 0, review: 0, done: 0, parked: 0 },
    brief: null,
    spec: null,
    spec_updated_at: null,
    revision: 1,
    revision_actor: "app",
    routine_id: null,
    tickets: [],
    requirements,
  };
}

function open(detail: TaskDetail, answer?: (id: string, body: RequirementActionRequest) => Promise<TaskDetail>) {
  const calls: Array<[string, RequirementActionRequest]> = [];
  const saved: TaskDetail[] = [];
  const jumps: Array<[string, string]> = [];
  const props = reactive({
    api: {
      requirementAction: async (id: string, body: RequirementActionRequest) => {
        calls.push([id, body]);
        return answer ? answer(id, body) : detail;
      },
    } as never,
    detail,
    t,
    onSaved: (next: TaskDetail) => saved.push(next),
    onJump: (sessionId: string, messageId: string) => jumps.push([sessionId, messageId]),
  });
  const view = render(PlanRequirements, props as never);
  return { ...view, props, calls, saved, jumps };
}


test("the plan's own entries, what it inherits from EP01, what waits for you and the old rules, each with its words and counts", () => {
  const view = open(
    aDetail([
      anEntry({ id: "run", seq: 9, restated: "母带约 120 秒", times_raised: 7, plans_raised: 3 }),
      anEntry({ id: "arm", seq: 4, quote: "机械臂必须是左手", scope: "project", inherited_from: { task_id: "ep01", title: "EP01" } }),
      anEntry({ id: "door", seq: 5, quote: "每次过门都要有过渡", scope: "project", inherited_from: { task_id: "ep01", title: "EP01" } }),
      anEntry({ id: "change", seq: 40, quote: "改成 3 分钟", status: "proposed", supersedes: { id: "run", seq: 9, quote: "片长约 2 分钟" } }),
      anEntry({ id: "old", seq: 12, quote: "标题别太长", status: "unverified", source_kind: "legacy", source: null, added_by: "import" }),
    ]),
  );
  const host = view.host;
  expect(host.querySelector(".plan-reqs-title")?.textContent).toBe("你的要求");
  expect(host.querySelector(".plan-reqs-count")?.textContent).toBe("3");
  const own = host.querySelector('[data-requirement="run"]')!;
  expect(own.querySelector(".plan-req-seq")?.textContent).toBe("R-9");
  expect(own.querySelector(".plan-req-quote")?.textContent).toBe("「片长约 2 分钟」");
  expect(own.textContent).toContain("转述：母带约 120 秒");
  expect(own.textContent).toContain("已说 7 次（跨 3 件事）");
  expect(own.textContent).toContain("适用：这件事");
  const titles = [...host.querySelectorAll(".plan-reqs-group-title")].map((el) => el.textContent);
  expect(titles).toEqual(["继承自「EP01」的 2 条", "待你确认", "旧规则（出处未核实）"]);
  expect(host.querySelector('[data-requirement="change"]')?.textContent).toContain("要取代 R-9「片长约 2 分钟」");
  expect(host.querySelector('[data-requirement="old"]')?.textContent).toContain("旧规则");
  // Each offers what the daemon takes for it.
  const buttons = (id: string) => [...host.querySelectorAll(`[data-requirement="${id}"] .plan-req-btn`)].map((el) => el.textContent);
  expect(buttons("run")).toEqual(["对这个会话都适用", "不再适用"]);
  expect(buttons("arm")).toEqual(["不适用这件事"]);
  expect(buttons("change")).toEqual(["确认", "不是要求"]);
  expect(buttons("old")).toEqual(["确认", "不是要求"]);
});

test("a press goes to the daemon with the plan it was shown on, and the plan that comes back replaces the board's", async () => {
  const arm = anEntry({ id: "arm", seq: 4, quote: "机械臂必须是左手", scope: "project", inherited_from: { task_id: "ep01", title: "EP01" } });
  const after = aDetail([{ ...arm, excluded: true }]);
  const view = open(aDetail([arm]), async () => after);
  click(buttonByText(view.host, "不适用这件事"));
  await settle();
  expect(view.calls).toEqual([["arm", { action: "not_here", task_id: "task-9ag7" }]]);
  expect(view.saved).toEqual([after]);
  view.props.detail = after;
  await settle();
  expect(view.host.querySelector(".plan-reqs-group-title")?.textContent).toBe("不适用这件事的");
  expect([...view.host.querySelectorAll('[data-requirement="arm"] .plan-req-btn')].map((el) => el.textContent)).toEqual(["恢复"]);
});

test("a refused press says so on its entry and changes nothing; the source jumps to the line you said", async () => {
  const view = open(aDetail([anEntry({ id: "old", status: "unverified", source_kind: "legacy", added_by: "import" })]), async () => {
    throw Object.assign(new Error("conflict"), { status: 409 });
  });
  click(buttonByText(view.host, "确认"));
  await settle();
  expect(view.saved).toEqual([]);
  expect(view.host.querySelector('[data-requirement="old"] .plan-req-error')?.textContent).toBe("没做成，再试一次。");
  click(view.host.querySelector(".plan-req-jump"));
  expect(view.jumps).toEqual([["group-1", "m1"]]);
});

test("nothing written down yet says so", () => {
  const view = open(aDetail([]));
  expect(view.host.querySelector(".plan-reqs-empty")?.textContent).toBe("还没记下要求。");
  expect(view.host.querySelector(".plan-reqs-count")).toBeNull();
});

test("an entry held to one ticket names it as a button when the board can show tickets; a picked ticket lights its own and dims another's", () => {
  const detail = {
    ...aDetail([
      anEntry({ id: "plan", seq: 1 }),
      anEntry({ id: "cut", seq: 2, quote: "粗剪先给我看", scope: "ticket", ticket_id: "tk-1" }),
      anEntry({ id: "music", seq: 3, quote: "配乐要无版权", scope: "ticket", ticket_id: "tk-2" }),
    ]),
    tickets: [
      { id: "tk-1", seq: 1, title: "粗剪" },
      { id: "tk-2", seq: 2, title: "配乐" },
    ] as never,
  };
  const shown: string[] = [];
  const props = reactive({
    api: null,
    detail,
    t,
    onSaved: () => {},
    onJump: () => {},
    selectedTicket: null as string | null,
    onShowTicket: (id: string) => shown.push(id),
  });
  const view = render(PlanRequirements, props as never);
  const row = (id: string) => view.host.querySelector<HTMLElement>(`[data-requirement="${id}"]`)!;
  // Over the plan: plain words. Held to a ticket: that ticket, pressable.
  expect(row("plan").querySelector(".plan-req-ticket")).toBeNull();
  expect(row("plan").textContent).toContain(t.plan.requirements.scope.plan);
  const music = row("music").querySelector<HTMLButtonElement>(".plan-req-ticket")!;
  expect(music.textContent).toBe(t.plan.requirements.scope.ticket("02 配乐"));
  click(music);
  expect(shown).toEqual(["tk-2"]);
  // Nothing picked, nothing stands out.
  expect(view.host.querySelector(".is-ticket-mine, .is-ticket-other")).toBeNull();
  props.selectedTicket = "tk-1";
  flushSync();
  expect(row("cut").classList.contains("is-ticket-mine")).toBe(true);
  expect(row("music").classList.contains("is-ticket-other")).toBe(true);
  expect(row("plan").className).not.toContain("is-ticket");
  view.close();
});

test("without a way to show tickets, an entry's ticket stays plain words", () => {
  const detail = { ...aDetail([anEntry({ id: "cut", scope: "ticket", ticket_id: "tk-1" })]), tickets: [{ id: "tk-1", seq: 1, title: "粗剪" }] as never };
  const view = render(PlanRequirements, reactive({ api: null, detail, t, onSaved: () => {}, onJump: () => {} }) as never);
  expect(view.host.querySelector(".plan-req-ticket")).toBeNull();
  expect(view.host.textContent).toContain(t.plan.requirements.scope.ticket("01 粗剪"));
  view.close();
});

test("an entry is two lines: your words with how often you said them, then the restatement, source, scope and buttons", () => {
  const view = open(aDetail([anEntry({ id: "twice", restated: "母带约 120 秒", times_raised: 2 })]));
  const row = view.host.querySelector('[data-requirement="twice"]')!;
  const line = row.querySelector(".plan-req-line")!;
  expect(line.querySelector(".plan-req-quote")?.textContent).toBe("「片长约 2 分钟」");
  expect(line.querySelector(".plan-req-times")?.textContent).toBe(t.plan.requirements.said(2));
  const sub = row.querySelector(".plan-req-sub")!;
  expect(sub.querySelector(".plan-req-restated")?.textContent).toBe(t.plan.requirements.restated("母带约 120 秒"));
  expect(sub.querySelector(".plan-req-meta")?.textContent).toContain(t.plan.requirements.scope.plan);
  expect([...sub.querySelectorAll(".plan-req-actions .plan-req-btn")].map((el) => el.textContent)).toEqual([
    t.plan.requirements.wholeProject,
    t.plan.requirements.waive,
  ]);
  // In force: its buttons are the quiet kind. Waiting for you: not.
  expect(row.classList.contains("is-settled")).toBe(true);
  view.close();
  const offered = open(aDetail([anEntry({ id: "offer", status: "proposed" })]));
  expect(offered.host.querySelector('[data-requirement="offer"]')?.classList.contains("is-settled")).toBe(false);
  offered.close();
});

test("past ten of the plan's own entries the rest are a press away, and back; a picked ticket shows them all", () => {
  const entries = Array.from({ length: 13 }, (_, i) => anEntry({ id: `r${i + 1}`, seq: i + 1, quote: `要求 ${i + 1}` }));
  const view = open(aDetail(entries));
  const rows = () => view.host.querySelectorAll(".plan-reqs-list .plan-req").length;
  expect(rows()).toBe(10);
  const more = view.host.querySelector<HTMLButtonElement>(".plan-reqs-more")!;
  expect(more.textContent?.trim()).toBe(t.plan.requirements.showAll(3));
  click(more);
  expect(rows()).toBe(13);
  expect(view.host.querySelector(".plan-reqs-more")?.textContent?.trim()).toBe(t.plan.requirements.showFewer);
  click(view.host.querySelector(".plan-reqs-more"));
  expect(rows()).toBe(10);
  view.props.selectedTicket = "tk-1";
  flushSync();
  expect(rows()).toBe(13);
  expect(view.host.querySelector(".plan-reqs-more")).toBeNull();
  view.close();
});

test("words an edit of yours took out are asked about first: retire them, or keep them", async () => {
  const gone = anEntry({ id: "r275", seq: 275, quote: "如果自己整不了模型就改成 2D 动画风格", withdraw_proposed: { edit_id: "e1", at: "2026-10-09T00:54:30.405Z" } });
  const view = open(aDetail([anEntry(), gone]));
  const group = view.host.querySelector(".plan-reqs-group.is-withdrawn")!;
  expect(group.textContent).toContain(t.plan.requirements.withdrawn);
  expect(group.textContent).toContain("如果自己整不了模型就改成 2D 动画风格");
  // It is no longer listed among what is in force.
  expect(view.host.querySelectorAll('[data-requirement="r275"]')).toHaveLength(1);
  click(buttonByText(group, t.plan.requirements.keep));
  await settle();
  expect(view.calls).toEqual([["r275", { action: "keep", task_id: "task-9ag7" }]]);
});
