import { expect, test } from "bun:test";
import type { PlanRequirement } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { changeAge, lastChangeLabel, requirementActions, requirementGroups, requirementScope, requirementSource, requirementTimes } from "./plan-requirements.ts";

const zh = copyFor("zh");
const en = copyFor("en");

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

test("entries group into the plan's own, what it inherits by the plan that set it, what waits for you, old rules and those set aside", () => {
  const groups = requirementGroups([
    anEntry({ id: "own-1", seq: 1 }),
    anEntry({ id: "own-2", seq: 2, times_raised: 3 }),
    anEntry({ id: "arm", seq: 3, scope: "project", inherited_from: { task_id: "ep01", title: "EP01" } }),
    anEntry({ id: "door", seq: 4, scope: "project", inherited_from: { task_id: "ep01", title: "EP01" } }),
    anEntry({ id: "change", seq: 5, status: "proposed", supersedes: { id: "own-1", seq: 1, quote: "片长约 2 分钟" } }),
    anEntry({ id: "old", seq: 6, status: "unverified", source_kind: "legacy", source: null }),
    anEntry({ id: "aside", seq: 7, scope: "project", inherited_from: { task_id: "ep01", title: "EP01" }, excluded: true }),
  ]);
  expect(groups.own.map((entry) => entry.id)).toEqual(["own-2", "own-1"]);
  expect(groups.inherited).toEqual([{ taskId: "ep01", title: "EP01", entries: [expect.objectContaining({ id: "arm" }), expect.objectContaining({ id: "door" })] }]);
  expect(groups.proposed.map((entry) => entry.id)).toEqual(["change"]);
  expect(groups.unverified.map((entry) => entry.id)).toEqual(["old"]);
  expect(groups.excluded.map((entry) => entry.id)).toEqual(["aside"]);
});

test("each entry offers only what the daemon takes for it", () => {
  const withSession = { session_id: "group-1" };
  expect(requirementActions(anEntry(), withSession)).toEqual(["whole_project", "waive"]);
  expect(requirementActions(anEntry(), { session_id: null })).toEqual(["waive"]);
  // A line you typed on this board goes when you take it out of the rules or Done when.
  expect(requirementActions(anEntry({ source_kind: "board" }), withSession)).toEqual(["whole_project"]);
  expect(requirementActions(anEntry({ scope: "project", inherited_from: { task_id: "ep01", title: "EP01" } }), withSession)).toEqual(["not_here"]);
  expect(requirementActions(anEntry({ scope: "project" }), withSession)).toEqual(["waive"]);
  expect(requirementActions(anEntry({ status: "proposed" }), withSession)).toEqual(["confirm", "reject"]);
  expect(requirementActions(anEntry({ status: "unverified", scope: "project", inherited_from: { task_id: "ep01", title: "EP01" } }), withSession)).toEqual([
    "confirm",
    "reject",
    "not_here",
  ]);
  expect(requirementActions(anEntry({ excluded: true, scope: "project" }), withSession)).toEqual(["here_again"]);
});

test("where it holds, where the words came from, and how often you said it, in words", () => {
  const detail = { tickets: [{ id: "t1", seq: 3, title: "Shot 01–03" }] as never };
  expect(requirementScope(anEntry({ scope: "ticket", ticket_id: "t1" }), detail, zh.plan.requirements)).toBe("适用：任务 03 Shot 01–03");
  expect(requirementScope(anEntry({ scope: "project" }), detail, zh.plan.requirements)).toBe("适用：这个会话的每件事");
  expect(requirementScope(anEntry({ scope: "standing", domain: "video" }), detail, en.plan.requirements)).toBe("For every video job");
  expect(requirementSource(anEntry({ added_by: "capture" }), zh.plan.requirements)).toBe("你的原话，整句记下");
  expect(requirementSource(anEntry({ source_kind: "legacy", source: null }), zh.plan.requirements)).toBe("旧规则");
  expect(requirementSource(anEntry({ source_kind: "board", source: { via: "board", session_id: null, message_id: null, at: "x" } }), zh.plan.requirements)).toBe("你在流程图写的");
  expect(requirementTimes(anEntry(), zh.plan.requirements)).toBeNull();
  expect(requirementTimes(anEntry({ times_raised: 7, plans_raised: 3 }), zh.plan.requirements)).toBe("已说 7 次（跨 3 件事）");
  expect(requirementTimes(anEntry({ times_raised: 2 }), en.plan.requirements)).toBe("said 2 times");
});

test("the board's head says how long ago the plan last changed and what changed", () => {
  const now = Date.parse("2026-09-29T10:00:00.000Z");
  expect(changeAge("2026-09-29T09:59:30.000Z", now)).toEqual({ unit: "now", count: 0 });
  expect(changeAge("2026-09-29T09:57:00.000Z", now)).toEqual({ unit: "minute", count: 3 });
  expect(changeAge("2026-09-29T07:00:00.000Z", now)).toEqual({ unit: "hour", count: 3 });
  expect(changeAge("2026-09-27T10:00:00.000Z", now)).toEqual({ unit: "day", count: 2 });
  expect(lastChangeLabel({ last_change: { at: "2026-09-29T09:57:00.000Z", what: "任务 02《粗剪》：待验收" } }, now, zh.plan)).toBe("上次变化 3 分钟前（任务 02《粗剪》：待验收）");
  expect(lastChangeLabel({ last_change: { at: "2026-09-29T09:59:59.000Z", what: "you edited the plan" } }, now, en.plan)).toBe("Last change just now (you edited the plan)");
  expect(lastChangeLabel({}, now, zh.plan)).toBeNull();
});
