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
