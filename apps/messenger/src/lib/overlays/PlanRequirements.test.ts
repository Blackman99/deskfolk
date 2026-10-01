import { expect, test } from "bun:test";
import type { PlanRequirement, RequirementActionRequest, TaskDetail } from "@real-bot/protocol";
import PlanRequirements from "./PlanRequirements.svelte";
import { copyFor } from "../copy.ts";
import { buttonByText, click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";

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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
