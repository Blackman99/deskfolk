import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { PlanSpec, TaskDetail, TaskSpecRevision } from "@real-bot/protocol";
import PlanSpecPanel from "./PlanSpecPanel.svelte";
import { copyFor } from "../copy.ts";
import { click, fill, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { specWithLines } from "./plan-board.ts";

const t = copyFor("zh");

function aSpec(over: Partial<PlanSpec> = {}): PlanSpec {
  return {
    kind: "调研",
    goal: "把三种方案比出高下",
    acceptance: ["有对比表", "有结论"],
    rules: ["别改现有代码"],
    process: ["先收集，再比较"],
    progress: { done: ["收集完了"], open: ["写结论"], blocked: [] },
    status: "active",
    ...over,
  };
}

function aDetail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "task-1",
    dir: "work/2026-09-24-调研-abcd",
    title: "调研",
    session_id: "group-1",
    closed_at: null,
    last_activity_at: "2026-09-24T00:00:00.000Z",
    goal: "把三种方案比出高下",
    kind: "调研",
    status: "active",
    ticket_counts: { todo: 1, doing: 1, review: 0, done: 0, parked: 0 },
    brief: "先看看哪种方案适合我们",
    spec: aSpec(),
    spec_updated_at: "2026-09-24T08:30:00.000Z",
    revision: 3,
    revision_actor: "app",
    routine_id: null,
    tickets: [],
    ...over,
  };
}

function aRevision(over: Partial<TaskSpecRevision> = {}): TaskSpecRevision {
  return {
    id: "rev-1",
    task_id: "task-1",
    revision: 1,
    actor: "app",
    spec: aSpec({ goal: "最初的目标" }),
    tickets_snapshot: [],
    source_message_id: "m1",
    source_turn_id: "t1",
    session_id: "group-1",
    created_at: "2026-09-23T00:00:00.000Z",
    ...over,
  };
}

async function until(host: HTMLElement, selector: string): Promise<Element> {
  for (let i = 0; i < 20; i += 1) {
    const found = host.querySelector(selector);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync();
  }
  throw new Error(`never saw ${selector}`);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

function listBlock(host: HTMLElement, label: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>(".plan-spec-list")].find(
    (block) => block.querySelector(".plan-spec-list-label")?.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no list block labelled ${label}`);
  return found;
}

function open(over: {
  detail?: TaskDetail;
  api?: Partial<{
    patchTaskSpec: (taskId: string, body: unknown) => Promise<TaskDetail>;
    taskSpecRevisions: (taskId: string) => Promise<TaskSpecRevision[]>;
  }> | null;
  defaultOpen?: boolean;
} = {}) {
  const saved: TaskDetail[] = [];
  const conflicts: number[] = [];
  const jumps: Array<[string, string]> = [];
  const patchCalls: Array<{ taskId: string; body: unknown }> = [];
  const revisionCalls: string[] = [];

  const api =
    over.api === null
      ? null
      : {
          patchTaskSpec: async (taskId: string, body: unknown) => {
            patchCalls.push({ taskId, body });
            if (over.api?.patchTaskSpec) return over.api.patchTaskSpec(taskId, body);
            return aDetail({ revision: 4 });
          },
          taskSpecRevisions: async (taskId: string) => {
            revisionCalls.push(taskId);
            if (over.api?.taskSpecRevisions) return over.api.taskSpecRevisions(taskId);
            return [];
          },
        };

  const props = reactive({
    api: api as never,
    detail: over.detail ?? aDetail(),
    t,
    defaultOpen: over.defaultOpen ?? true,
    onSaved: (detail: TaskDetail) => saved.push(detail),
    onConflict: () => conflicts.push(1),
    onJump: (sessionId: string, messageId: string) => jumps.push([sessionId, messageId]),
  });

  const view = render(PlanSpecPanel, props as never);
  return { ...view, props, saved, conflicts, jumps, patchCalls, revisionCalls };
}

test("renders the goal and every spec list, in order", () => {
  const view = open();
  const labels = [...view.host.querySelectorAll(".plan-spec-list-label")].map((el) => el.textContent?.trim());
  expect(labels).toEqual([
    t.plan.spec.acceptance,
    t.plan.spec.rules,
    t.plan.spec.process,
    `${t.plan.spec.progress} · ${t.plan.spec.done}`,
    `${t.plan.spec.progress} · ${t.plan.spec.open}`,
    `${t.plan.spec.progress} · ${t.plan.spec.blocked}`,
  ]);
  expect(view.host.querySelector(".plan-spec-goal-text")?.textContent).toBe("把三种方案比出高下");
  const acceptance = listBlock(view.host, t.plan.spec.acceptance);
  expect([...acceptance.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["有对比表", "有结论"]);
  const blocked = listBlock(view.host, `${t.plan.spec.progress} · ${t.plan.spec.blocked}`);
  expect(blocked.querySelector(".plan-spec-empty-line")?.textContent).toBe(t.plan.empty);
  view.close();
});

test("the toggle collapses to a one-line summary and expands back", () => {
  const view = open();
  const toggle = view.host.querySelector<HTMLButtonElement>(".plan-spec-toggle")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(view.host.querySelector(".plan-spec-body")).not.toBeNull();

  click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(view.host.querySelector(".plan-spec-body")).toBeNull();
  const summary = view.host.querySelector(".plan-spec-summary")!;
  expect(summary.textContent).toContain(`${t.plan.kind}: 调研`);
  expect(summary.textContent).toContain(t.plan.revision(3));

  click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(view.host.querySelector(".plan-spec-body")).not.toBeNull();
  view.close();
});

test("editing a list field prefills one line per item and saves the replaced list", async () => {
  const view = open();
  const block = listBlock(view.host, t.plan.spec.acceptance);
  click(block.querySelector(".plan-spec-edit-btn"));
  const textarea = block.querySelector<HTMLTextAreaElement>(".plan-spec-textarea")!;
  expect(textarea.value).toBe("有对比表\n有结论");

  fill(textarea, "新验收一\n新验收二");
  click(block.querySelector<HTMLButtonElement>(".plan-spec-save-btn"));
  await settle();

  expect(view.patchCalls).toHaveLength(1);
  expect(view.patchCalls[0]?.taskId).toBe("task-1");
  expect(view.patchCalls[0]?.body).toEqual({
    spec: specWithLines(aDetail().spec!, "acceptance", ["新验收一", "新验收二"]),
    if_revision: 3,
  });
  expect(view.saved).toHaveLength(1);
  // Left edit mode.
  expect(block.querySelector(".plan-spec-textarea")).toBeNull();
  view.close();
});

test("cancel leaves the list unedited", () => {
  const view = open();
  const block = listBlock(view.host, t.plan.spec.rules);
  click(block.querySelector(".plan-spec-edit-btn"));
  fill(block.querySelector(".plan-spec-textarea"), "改了但不保存");
  click(block.querySelector<HTMLButtonElement>(".plan-spec-cancel-btn"));
  expect(block.querySelector(".plan-spec-textarea")).toBeNull();
  expect([...block.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["别改现有代码"]);
  view.close();
});

test("editing the goal saves through specWithGoal", async () => {
  const view = open();
  click(view.host.querySelector(".plan-spec-edit-btn"));
  const input = view.host.querySelector<HTMLInputElement>(".plan-spec-goal-input")!;
  expect(input.value).toBe("把三种方案比出高下");
  fill(input, "新的目标");
  click(view.host.querySelector<HTMLButtonElement>(".plan-spec-save-btn"));
  await settle();
  expect(view.patchCalls[0]?.body).toEqual({
    spec: { ...aDetail().spec!, goal: "新的目标" },
    if_revision: 3,
  });
  expect(view.saved).toHaveLength(1);
  view.close();
});

test("a 409 shows the conflict message and tells the parent to reload", async () => {
  const view = open({
    api: {
      patchTaskSpec: async () => {
        throw { status: 409, message: "conflict" };
      },
    },
  });
  const block = listBlock(view.host, t.plan.spec.process);
  click(block.querySelector(".plan-spec-edit-btn"));
  click(block.querySelector<HTMLButtonElement>(".plan-spec-save-btn"));
  await settle();
  expect(view.conflicts).toEqual([1]);
  expect(block.querySelector(".plan-spec-error")?.textContent).toBe(t.plan.conflict);
  expect(view.saved).toHaveLength(0);
  view.close();
});

test("another error shows saveFailed and stays in edit mode", async () => {
  const view = open({
    api: {
      patchTaskSpec: async () => {
        throw new Error("boom");
      },
    },
  });
  const block = listBlock(view.host, t.plan.spec.process);
  click(block.querySelector(".plan-spec-edit-btn"));
  click(block.querySelector<HTMLButtonElement>(".plan-spec-save-btn"));
  await settle();
  expect(view.conflicts).toEqual([]);
  expect(block.querySelector(".plan-spec-error")?.textContent).toBe(t.plan.saveFailed);
  expect(block.querySelector(".plan-spec-textarea")).not.toBeNull();
  view.close();
});

test("the buttons disable while a save is in flight", async () => {
  let resolveSave: ((detail: TaskDetail) => void) | undefined;
  const view = open({
    api: {
      patchTaskSpec: () =>
        new Promise<TaskDetail>((resolve) => {
          resolveSave = resolve;
        }),
    },
  });
  const block = listBlock(view.host, t.plan.spec.rules);
  click(block.querySelector(".plan-spec-edit-btn"));
  click(block.querySelector<HTMLButtonElement>(".plan-spec-save-btn"));
  await settle();
  expect(block.querySelector<HTMLButtonElement>(".plan-spec-save-btn")?.disabled).toBe(true);
  expect(block.querySelector<HTMLButtonElement>(".plan-spec-cancel-btn")?.disabled).toBe(true);
  resolveSave?.(aDetail({ revision: 4 }));
  await settle();
  view.close();
});

test("history loads lazily on first open and jump calls onJump", async () => {
  const view = open({ api: { taskSpecRevisions: async () => [aRevision()] } });
  click(view.host.querySelector(".plan-spec-history-toggle"));
  await until(view.host, ".plan-spec-revision");
  expect(view.revisionCalls).toEqual(["task-1"]);
  const row = view.host.querySelector(".plan-spec-revision")!;
  expect(row.querySelector(".plan-spec-revision-n")?.textContent).toBe(t.plan.revision(1));
  expect(row.querySelector(".plan-spec-revision-goal")?.textContent).toBe("最初的目标");
  click(row.querySelector(".plan-spec-revision-jump"));
  expect(view.jumps).toEqual([["group-1", "m1"]]);

  // Collapsing and reopening at the same revision does not ask again.
  click(view.host.querySelector(".plan-spec-history-toggle"));
  click(view.host.querySelector(".plan-spec-history-toggle"));
  await settle();
  expect(view.revisionCalls).toEqual(["task-1"]);
  view.close();
});

test("an empty history says so", async () => {
  const view = open({ api: { taskSpecRevisions: async () => [] } });
  click(view.host.querySelector(".plan-spec-history-toggle"));
  await until(view.host, ".plan-spec-history-none");
  expect(view.host.querySelector(".plan-spec-history-none")?.textContent).toBe(t.plan.historyNone);
  view.close();
});

test("before its first write-up the plan is one line: nothing yet, and the opening request", () => {
  // A panel of blanks with a version 0 and an "organizing" note that stayed up whether or not
  // anything was being written up took a quarter of the board to say nothing.
  const view = open({ detail: aDetail({ spec: null, revision: 0, revision_actor: null, brief: "先看看方案" }) });
  const panel = view.host.querySelector(".plan-spec");
  expect(panel?.classList.contains("is-empty")).toBe(true);
  expect(panel?.getAttribute("title")).toBe(t.plan.noSpec);
  expect(view.host.querySelector(".plan-spec-empty")?.textContent).toBe(t.plan.noSpecShort);
  expect(view.host.querySelector(".plan-spec-brief")?.textContent).toContain("先看看方案");
  expect(view.host.querySelector(".plan-spec-toggle")).toBeNull();
  expect(view.host.querySelector(".plan-spec-foot")).toBeNull();
  view.close();
});

test("a null spec past revision 0 keeps the panel, so its history can still be opened", () => {
  const view = open({ detail: aDetail({ spec: null, revision: 2, brief: null }) });
  expect(view.host.querySelector(".plan-spec")?.classList.contains("is-empty")).toBe(false);
  expect(view.host.querySelector(".plan-spec-empty")?.textContent).toBe(t.plan.noSpec);
  expect(view.host.querySelector(".plan-spec-brief")).toBeNull();
  expect(view.host.querySelector(".plan-spec-history-toggle")).not.toBeNull();
  view.close();
});

test("without an api the panel is read-only: no edit buttons, no history toggle", () => {
  const view = open({ api: null });
  expect(view.host.querySelectorAll(".plan-spec-edit-btn")).toHaveLength(0);
  expect(view.host.querySelector(".plan-spec-history-toggle")).toBeNull();
  view.close();
});

test("defaultOpen false starts collapsed", () => {
  const view = open({ defaultOpen: false });
  expect(view.host.querySelector(".plan-spec-toggle")?.getAttribute("aria-expanded")).toBe("false");
  expect(view.host.querySelector(".plan-spec-body")).toBeNull();
  view.close();
});
