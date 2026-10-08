import { expect, test } from "bun:test";
import type { Bot, Retrospective, RetrospectiveChange, TaskDetail } from "@real-bot/protocol";
import PlanRetrospectives from "./PlanRetrospectives.svelte";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import { buttonByText, click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { changedLines, reasonText } from "./plan-retrospectives.ts";
import { settleTimers as settle } from "../test-async.ts";

const t = copyFor("zh");
const bot = { id: "bot-1", name: "视频导演" } as Bot;

function aChange(over: Partial<RetrospectiveChange> = {}): RetrospectiveChange {
  return { kind: "memory", op: "remember", label: "漫改画风", target_id: "m1", before: null,
    after: { subject: "漫改画风", body: "改编动漫默认做成动画。" }, why: "第一版被退回", status: "applied", ...over };
}

function aRetrospective(over: Partial<Retrospective> = {}): Retrospective {
  return {
    id: "retro-1",
    task_id: "task-1",
    bot_id: "bot-1",
    delivered_at: "2026-10-06T04:08:55.000Z",
    state: "done",
    model: "gemini",
    summary: "漫改片先定画风和配音语言",
    pitfalls: ["默认做成了真人风格"],
    rework_causes: ["开工前没确认画风", "配音没按角色性别选声"],
    keep: ["交付前回听每一句配音"],
    earlier: [{ conclusion: "全盘 grep 会超时", verdict: "recurred" }],
    changes: [
      aChange(),
      aChange({ kind: "skill", op: "edit", label: "关键帧出片", target_id: "s1", why: "",
        before: { name: "关键帧出片", description: "做短片", body: "1. 先算账\n2. 配音。" },
        after: { name: "关键帧出片", description: "做短片", body: "1. 先算账\n2. 配音。按角色性别选声。" } }),
      aChange({ op: "remember", label: "太长的", target_id: null, after: null, why: "", status: "not_applied", reason: "too_long:body" }),
      aChange({ op: "forget", label: "旧习惯", target_id: "m2", before: { subject: "旧习惯", body: "先出真人样片。" }, after: null, why: "", status: "undone" }),
    ],
    note: null,
    created_at: "2026-10-06T04:39:00.000Z",
    finished_at: "2026-10-06T04:39:30.000Z",
    ...over,
  };
}

function aDetail(retrospectives: Retrospective[]): TaskDetail {
  return {
    id: "task-1", dir: "work/全职猎人-abcd", title: "全职猎人", session_id: "group-1", closed_at: null, last_activity_at: "2026-10-06T04:39:30.000Z",
    goal: "全职猎人", kind: null, status: "done", ticket_counts: { todo: 0, doing: 0, review: 0, done: 1, parked: 0 }, brief: null, spec: null,
    spec_updated_at: null, revision: 1, revision_actor: "app", routine_id: null, tickets: [], retrospectives,
  };
}

function open(detail: TaskDetail, answer?: (id: string, index: number) => Promise<TaskDetail>) {
  const calls: Array<[string, number]> = [];
  const saved: TaskDetail[] = [];
  const props = reactive({
    api: {
      undoRetrospectiveChange: async (id: string, index: number) => {
        calls.push([id, index]);
        return answer ? answer(id, index) : detail;
      },
    } as never,
    detail,
    t,
    bots: [bot],
    deletedLabel: "已删除",
    onSaved: (next: TaskDetail) => saved.push(next),
  });
  return { ...render(PlanRetrospectives, props as never), props, calls, saved };
}


test("a retrospective reads as what tripped the Bot up, what made you send work back, what to keep, and each change it made", () => {
  const view = open(aDetail([aRetrospective()]));
  const host = view.host;
  expect(host.querySelector(".plan-retros-title")?.textContent).toBe("完工复盘");
  expect(host.querySelector(".plan-retro-bot")?.textContent).toBe("视频导演");
  expect(host.querySelector(".plan-retro-summary")?.textContent).toBe("漫改片先定画风和配音语言");
  const lists = [...host.querySelectorAll(".plan-retro-list")].map((el) => [el.querySelector(".plan-retro-list-label")?.textContent,
    [...el.querySelectorAll("li")].map((li) => li.textContent?.trim())]);
  expect(lists).toEqual([
    ["让你返工的做法", ["开工前没确认画风", "配音没按角色性别选声"]],
    ["踩的坑", ["默认做成了真人风格"]],
    ["下次照做", ["交付前回听每一句配音"]],
    ["以前的结论", ["又犯了 全盘 grep 会超时"]],
  ]);
  const changes = [...host.querySelectorAll(".plan-retro-change")];
  expect(changes.map((el) => el.querySelector(".plan-retro-change-title")?.textContent)).toEqual([
    "新记忆「漫改画风」", "改了技能「关键帧出片」", "新记忆「太长的」", "删掉记忆「旧习惯」"]);
  // Made: an undo each. Not made: why, in your words. Taken back: says so.
  expect(changes.map((el) => el.querySelector(".plan-retro-undo")?.textContent ?? el.querySelector(".plan-retro-tag")?.textContent ?? null))
    .toEqual(["撤销", "撤销", null, "已撤销"]);
  expect(changes[2]!.querySelector(".plan-retro-reason")?.textContent).toBe("没写进去：太长了");
  expect(changes[0]!.querySelector(".plan-retro-why")?.textContent).toBe("第一版被退回");
  // A skill's change shows the lines it touched, not the whole body.
  expect([...changes[1]!.querySelectorAll(".plan-retro-line")].map((el) => el.textContent)).toEqual(["−2. 配音。", "+2. 配音。按角色性别选声。"]);
  expect(changes[0]!.querySelector(".plan-retro-side.is-after")?.textContent).toBe("现在改编动漫默认做成动画。");
});

test("撤销 goes to the daemon with the change's place, and the plan that comes back replaces the board's; a 409 says it changed since", async () => {
  const after = aDetail([aRetrospective({ changes: aRetrospective().changes.map((change, index) => (index === 0 ? { ...change, status: "undone" as const } : change)) })]);
  const view = open(aDetail([aRetrospective()]), async () => after);
  click(view.host.querySelectorAll(".plan-retro-undo")[0]);
  await settle();
  expect(view.calls).toEqual([["retro-1", 0]]);
  expect(view.saved).toEqual([after]);

  const refused = open(aDetail([aRetrospective()]), async () => {
    throw new ApiError(409, "conflict", "changed since the retrospective made it");
  });
  click(refused.host.querySelectorAll(".plan-retro-undo")[1]);
  await settle();
  expect(refused.saved).toEqual([]);
  expect(refused.host.querySelector('[data-change="1"] .plan-retro-error')?.textContent).toBe("撤销没成：它之后又被改过，现在是新的样子。");
});

test("one running or failed says so, and a deleted Bot reads as deleted", () => {
  const view = open(aDetail([
    aRetrospective({ id: "a", state: "failed", note: "truncated", changes: [], bot_id: "gone" }),
    aRetrospective({ id: "b", state: "pending", changes: [], created_at: "2026-10-06T05:00:00.000Z" }),
  ]));
  const muted = [...view.host.querySelectorAll(".plan-retro-muted")].map((el) => el.textContent);
  expect(muted).toEqual(["复盘没跑成：回答没写完，什么都没改。", "视频导演 正在复盘…"]);
  expect([...view.host.querySelectorAll(".plan-retro-bot")].map((el) => el.textContent)).toEqual(["已删除", "视频导演"]);
  expect(() => buttonByText(view.host, "撤销")).toThrow();
});

test("the daemon's reason codes read in your language; a skill's diff marks only what changed, with a gap between changes", () => {
  const c = t.plan.retrospective;
  expect(reasonText("edit_repeated:2:3", c)).toBe("第 2 处：它指的那段原文出现了 3 次");
  expect(reasonText("drops:`voice` `shot`", c)).toBe("会丢掉 `voice` `shot`");
  expect(reasonText("off", c)).toBe("你停用了它");
  expect(reasonText("something_new", c)).toBe("被拒绝了");
  expect(reasonText(undefined, c)).toBe("被拒绝了");
  expect(changedLines("a\nb\nc\nd\ne", "a\nB\nc\nd\ne\nf")).toEqual([
    { kind: "del", text: "b" }, { kind: "add", text: "B" }, { kind: "gap", text: "" }, { kind: "add", text: "f" }]);
  expect(changedLines("same", "same")).toEqual([]);
  expect(reasonText("edit_missing:1", copyFor("en").plan.retrospective)).toBe("edit 1: the passage it names is not in the skill");
});
