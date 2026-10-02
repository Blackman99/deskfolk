import { expect, test } from "bun:test";
import type { Lesson, LessonPatch } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { buttonByText, click, render } from "../test-render.ts";
import LessonsSettings from "./LessonsSettings.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lesson(over: Partial<Lesson> = {}): Lesson {
  return {
    id: "lesson-1",
    scope: "tool",
    scope_id: null,
    hook: "before_tool",
    detector: { tool: "shell", signature: "grep -r@home", head: "grep -r", place: "home", error: "timeout" },
    action: "warn",
    text: "在整个家目录跑「grep -r」这类命令，跑满 600 秒超时被杀过。",
    evidence: [{ turn_id: null, at: "2026-10-03T08:00:00.000Z", seconds: 600 }],
    status: "active",
    hits: 3,
    prevented: 2,
    recurrences: 1,
    created_by: "app",
    confirmed_at: null,
    created_at: "2026-10-03T08:00:00.000Z",
    updated_at: "2026-10-03T08:00:00.000Z",
    ...over,
  };
}

test("a lesson reads as its kind of call, what it does, and how often it held one back; your edits go to the daemon", async () => {
  const patches: Array<[string, LessonPatch]> = [];
  const view = render(LessonsSettings, {
    lessons: [lesson()],
    t,
    onPatch: async (id: string, patch: LessonPatch) => {
      patches.push([id, patch]);
      return lesson({ ...patch, status: patch.status ?? "active", action: patch.action ?? "warn" });
    },
  });
  const row = view.host.querySelector("[data-lesson='lesson-1']")!;
  expect(row.querySelector(".lesson-kind")?.textContent).toBe("grep -r");
  expect(row.querySelector(".lesson-badge")?.textContent?.trim()).toBe(t.lessons.warn);
  expect(row.querySelector(".lesson-stats")?.textContent).toContain(t.lessons.stats(3, 2, 1));
  click(buttonByText(view.host, t.lessons.toBlock));
  await sleep(0);
  expect(patches).toEqual([["lesson-1", { action: "block" }]]);
  expect(row.querySelector(".lesson-badge")?.textContent?.trim()).toBe(t.lessons.block);
  click(buttonByText(view.host, t.lessons.retire));
  await sleep(0);
  expect(patches.at(-1)).toEqual(["lesson-1", { status: "retired" }]);
  expect(row.querySelector(".lesson-badge")?.textContent?.trim()).toBe(t.lessons.retired);
  expect(buttonByText(view.host, t.lessons.restore)).toBeTruthy();
  view.close();
});

test("an edit that did not go through says so and leaves the lesson as it was", async () => {
  const view = render(LessonsSettings, { lessons: [lesson()], t, onPatch: async () => { throw new Error("offline"); } });
  click(buttonByText(view.host, t.lessons.retire));
  await sleep(0);
  expect(view.host.querySelector(".lesson-failed")?.textContent).toBe(t.lessons.failed);
  expect(view.host.querySelector(".lesson-badge")?.textContent?.trim()).toBe(t.lessons.warn);
  view.close();
});

test("a reflection's lesson reads as what it is and only retires; a candidate waits on its card", () => {
  const reflected = (over: Partial<Lesson>) => lesson({ id: over.id, scope: "bot", scope_id: "b1", hook: "before_review", action: "checklist", text: "逐帧比对相邻两镜的首尾机位",
    detector: { tool: "reflection", signature: "reflection:q1", head: "before_review", place: "", error: "review_miss" }, ...over });
  const view = render(LessonsSettings, { lessons: [reflected({ id: "a", status: "active", confirmed_at: "2026-10-03T08:00:00.000Z" }), reflected({ id: "c", status: "candidate" }),
    reflected({ id: "p", status: "active", action: "propose_check", confirmed_at: "2026-10-03T08:00:00.000Z" })], t, onPatch: async () => lesson() });
  const row = (id: string) => view.host.querySelector(`[data-lesson='${id}']`)!;
  expect(row("a").querySelector(".lesson-kind")?.textContent?.trim()).toBe(t.lessons.checklistAt.before_review);
  expect(row("a").querySelector(".lesson-badge")?.textContent?.trim()).toBe(t.lessons.adopted);
  expect(row("c").querySelector(".lesson-badge")?.textContent?.trim()).toBe(t.lessons.candidate);
  expect(row("p").querySelector(".lesson-kind")?.textContent?.trim()).toBe(t.lessons.checkProposal);
  expect([...row("a").querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual([t.lessons.retire]);
  expect(row("a").querySelector(".lesson-stats")?.textContent).toContain(t.lessons.fromReflection);
  view.close();
});

test("a check proposal shows the check itself: its kind, path and text", () => {
  const proposal = lesson({ id: "p", scope: "bot", action: "propose_check", status: "candidate", text: "片名卡在字幕里",
    detector: { tool: "reflection", signature: "reflection:q", head: "before_review", place: "", error: "review_miss",
      check: { item: "片名卡在字幕里", kind: "contains", path: "tasks/ep01/subs.srt", pattern: "第一集" } } });
  const view = render(LessonsSettings, { lessons: [proposal], t, onPatch: async () => proposal });
  const check = view.host.querySelector(".lesson-check")!;
  expect(check.textContent).toContain(t.lessons.checkKind.contains);
  expect([...check.querySelectorAll("code")].map((code) => code.textContent)).toEqual(["tasks/ep01/subs.srt", "第一集"]);
  view.close();
});
