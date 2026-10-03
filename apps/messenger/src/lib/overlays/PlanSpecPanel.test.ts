import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { AcceptanceCheck, AcceptanceCheckRun, PlanSpec, TaskDetail, TaskSpecRevision, TicketWithArtifacts } from "@real-bot/protocol";
import PlanSpecPanel from "./PlanSpecPanel.svelte";
import { copyFor } from "../copy.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
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

function aRun(over: Partial<AcceptanceCheckRun> = {}): AcceptanceCheckRun {
  return {
    id: "run-1",
    check_id: "check-1",
    task_id: "task-1",
    cause: "settle",
    started_at: "2026-09-24T08:00:00.000Z",
    finished_at: "2026-09-24T08:00:01.000Z",
    outcome: "pass",
    exit_code: 0,
    detail: "ok",
    output: null,
    ...over,
  };
}

function aCheck(over: Partial<AcceptanceCheck> = {}): AcceptanceCheck {
  return {
    id: "check-1",
    task_id: "task-1",
    ticket_id: null,
    item: "有对比表",
    kind: "exists",
    path: "report.md",
    pattern: null,
    negate: false,
    command: null,
    cwd: null,
    expect_exit: null,
    expect_stdout: null,
    timeout_sec: null,
    source: "user",
    created_at: "2026-09-24T08:00:00.000Z",
    updated_at: "2026-09-24T08:00:00.000Z",
    defined_at: "2026-09-24T08:00:00.000Z",
    first_passed_at: null,
    last_run: null,
    running: false,
    ...over,
  };
}

function selectValue(el: Element | null | undefined, value: string): void {
  if (!el) throw new Error("selectValue: no element");
  const select = el as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
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
    createCheck: (taskId: string, body: unknown) => Promise<TaskDetail>;
    patchCheck: (checkId: string, body: unknown) => Promise<TaskDetail>;
    deleteCheck: (checkId: string, revision?: string) => Promise<TaskDetail>;
    runChecks: (taskId: string, checkId?: string) => Promise<TaskDetail>;
    confirmCheck: (checkId: string) => Promise<TaskDetail>;
  }> | null;
} = {}) {
  const saved: TaskDetail[] = [];
  const conflicts: number[] = [];
  const jumps: Array<[string, string]> = [];
  const patchCalls: Array<{ taskId: string; body: unknown }> = [];
  const revisionCalls: string[] = [];
  const createCheckCalls: Array<{ taskId: string; body: unknown }> = [];
  const patchCheckCalls: Array<{ checkId: string; body: unknown }> = [];
  const deleteCheckCalls: Array<{ checkId: string; revision?: string }> = [];
  const runChecksCalls: Array<{ taskId: string; checkId?: string }> = [];
  const confirmCheckCalls: string[] = [];

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
          createCheck: async (taskId: string, body: unknown) => {
            createCheckCalls.push({ taskId, body });
            if (over.api?.createCheck) return over.api.createCheck(taskId, body);
            return aDetail({ checks: [aCheck()] });
          },
          patchCheck: async (checkId: string, body: unknown) => {
            patchCheckCalls.push({ checkId, body });
            if (over.api?.patchCheck) return over.api.patchCheck(checkId, body);
            return aDetail({ checks: [aCheck()] });
          },
          deleteCheck: async (checkId: string, revision?: string) => {
            deleteCheckCalls.push({ checkId, revision });
            if (over.api?.deleteCheck) return over.api.deleteCheck(checkId, revision);
            return aDetail({ checks: [] });
          },
          runChecks: async (taskId: string, checkId?: string) => {
            runChecksCalls.push({ taskId, checkId });
            if (over.api?.runChecks) return over.api.runChecks(taskId, checkId);
            return aDetail({ checks: [aCheck({ running: true })] });
          },
          confirmCheck: async (checkId: string) => {
            confirmCheckCalls.push(checkId);
            if (over.api?.confirmCheck) return over.api.confirmCheck(checkId);
            return aDetail({ checks: [] });
          },
        };

  const props = reactive({
    api: api as never,
    detail: over.detail ?? aDetail(),
    t,
    onSaved: (detail: TaskDetail) => saved.push(detail),
    onConflict: () => conflicts.push(1),
    onJump: (sessionId: string, messageId: string) => jumps.push([sessionId, messageId]),
  });

  const view = render(PlanSpecPanel, props as never);
  return {
    ...view,
    props,
    saved,
    conflicts,
    jumps,
    patchCalls,
    revisionCalls,
    createCheckCalls,
    patchCheckCalls,
    deleteCheckCalls,
    runChecksCalls,
    confirmCheckCalls,
  };
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

test("the panel reads whole: no fold of its own — the side panel or the tab is the fold — with its kind and version in the head", () => {
  const view = open();
  expect(view.host.querySelector(".plan-spec-toggle")).toBeNull();
  expect(view.host.querySelector(".plan-spec-body")).not.toBeNull();
  const head = view.host.querySelector(".plan-spec-head")!;
  expect(head.querySelector(".plan-spec-title")?.textContent).toBe(t.plan.spec.title);
  expect(head.querySelector(".plan-spec-kind-badge")?.textContent).toBe("调研");
  expect(head.querySelector(".plan-spec-rev-badge")?.textContent).toBe(t.plan.revision(3));
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

test("a version a stop of yours wrote says so, in the history and as the latest", async () => {
  const view = open({
    detail: aDetail({ revision_actor: "app", revision_cause: "hold" }),
    api: { taskSpecRevisions: async () => [aRevision({ revision: 3, cause: "hold" }), aRevision({ id: "rev-2", revision: 2, actor: "user", cause: null })] },
  });
  expect(view.host.querySelector(".plan-spec-actor")?.textContent).toBe("叫停改的");
  click(view.host.querySelector(".plan-spec-history-toggle"));
  await until(view.host, ".plan-spec-revision");
  const actors = [...view.host.querySelectorAll(".plan-spec-revision-actor")];
  expect(actors.map((actor) => actor.textContent)).toEqual(["叫停改的", "你改的"]);
  expect(actors[0]!.classList.contains("is-hold")).toBe(true);
  view.close();
});

test("an empty history says so", async () => {
  const view = open({ api: { taskSpecRevisions: async () => [] } });
  click(view.host.querySelector(".plan-spec-history-toggle"));
  await until(view.host, ".plan-spec-history-none");
  expect(view.host.querySelector(".plan-spec-history-none")?.textContent).toBe(t.plan.historyNone);
  view.close();
});

test("before its first write-up the plan says nothing is written up yet, and shows the opening request", () => {
  // A panel of blanks with a version 0 and an "organizing" note that stayed up whether or not
  // anything was being written up said nothing; there is no version and no history yet either.
  const view = open({ detail: aDetail({ spec: null, revision: 0, revision_actor: null, brief: "先看看方案" }) });
  const panel = view.host.querySelector(".plan-spec");
  expect(panel?.classList.contains("is-empty")).toBe(true);
  expect(view.host.querySelector(".plan-spec-empty")?.textContent).toBe(t.plan.noSpec);
  expect(view.host.querySelector(".plan-spec-brief")?.textContent).toContain("先看看方案");
  expect(view.host.querySelector(".plan-spec-rev-badge")).toBeNull();
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


test("acceptance checks: pills render after each line's text, the head chip counts all active checks, and orphans land in their own sub-block", () => {
  const passRun = { id: "r1", check_id: "c1", task_id: "task-1", cause: "settle" as const, started_at: "2026-09-24T08:00:00.000Z", finished_at: "2026-09-24T08:00:01.000Z", outcome: "pass" as const, exit_code: 0, detail: "ok", output: null };
  const failRun = { ...passRun, id: "r2", check_id: "c2", outcome: "fail" as const, exit_code: 1, detail: "no" };
  const passCheck = aCheck({ id: "c1", item: "有对比表", last_run: passRun });
  const failCheck = aCheck({ id: "c2", item: "有结论", last_run: failRun });
  const orphan = aCheck({ id: "c3", item: "旧的一条", last_run: null });
  const view = open({ detail: aDetail({ checks: [passCheck, failCheck, orphan] }) });
  const acceptance = listBlock(view.host, t.plan.spec.acceptance);
  const items = [...acceptance.querySelectorAll("li")];
  expect(items[0]?.querySelector(".check-pill.is-pass")).not.toBeNull();
  expect(items[1]?.querySelector(".check-pill.is-fail")).not.toBeNull();
  expect(acceptance.querySelector(".plan-spec-checks-summary")?.textContent).toBe(t.plan.checks.summary(1, 3));
  const orphans = acceptance.querySelector(".plan-spec-checks-orphans")!;
  expect(orphans.querySelector(".plan-spec-checks-orphans-title")?.textContent).toBe(t.plan.checks.orphansTitle);
  expect(orphans.querySelector(".check-pill.is-none")).not.toBeNull();
  view.close();
});

test("checks from your words sit in their own sub-block under your words; unbound, they cannot be rerun, and none is edited here", () => {
  const unbound = aCheck({
    id: "c9",
    item: "时长约 2 分钟",
    kind: "measure",
    path: null,
    origin: "derived",
    measure: { dimension: "duration", min: 108, max: 132 },
    bind_kind: null,
    bind_glob: null,
  });
  const view = open({ detail: aDetail({ checks: [aCheck({ id: "c1", item: "有对比表" }), unbound] }) });
  const acceptance = listBlock(view.host, t.plan.spec.acceptance);
  const blocks = [...acceptance.querySelectorAll(".plan-spec-checks-orphans")];
  expect(blocks.map((block) => block.querySelector(".plan-spec-checks-orphans-title")?.textContent)).toEqual([t.plan.checks.derivedTitle]);
  const words = blocks[0]!.querySelector("li")!;
  expect(words.textContent).toContain("时长约 2 分钟");
  expect(words.querySelector(".check-pill.is-unbound")?.textContent).toContain(t.plan.checks.status.unbound);
  // Not bound, it counts toward nothing yet.
  expect(acceptance.querySelector(".plan-spec-checks-summary")?.textContent).toBe(t.plan.checks.summary(0, 1));

  click(words.querySelector<HTMLButtonElement>(".check-pill"));
  expect(words.querySelector(".check-desc")?.textContent).toContain("时长 108–132 秒");
  expect(words.querySelector(".check-meta")?.textContent).toContain(t.plan.checks.sourceDerived);
  expect(buttonByText(words, t.plan.checks.rerun).disabled).toBe(true);
  expect([...words.querySelectorAll("button")].some((button) => button.textContent === t.plan.edit)).toBe(false);
  expect(buttonByText(words, t.plan.checks.remove)).not.toBeNull();
  view.close();
});

test("a check from your words you have not confirmed shows its result as information and is yours to confirm; it counts toward nothing", async () => {
  const derived = (over: Partial<AcceptanceCheck>) =>
    aCheck({
      kind: "measure",
      origin: "derived",
      path: "EP01_MASTER.mp4",
      bind_kind: "glob",
      bind_glob: "*MASTER*",
      measure: { dimension: "duration", min: 108, max: 132 },
      ...over,
    });
  const gate = derived({ id: "c8", item: "时长约 2 分钟", derived_state: "active", last_run: aRun({ outcome: "pass" }) });
  const offer = derived({
    id: "c9",
    item: "时长 3 分钟",
    derived_state: "proposed",
    measure: { dimension: "duration", min: 162, max: 198 },
    last_run: aRun({ outcome: "fail", detail: "107.00 秒，要时长 162–198 秒" }),
  });
  const confirmed = aDetail({ checks: [{ ...offer, derived_state: "active" }] });
  const view = open({ detail: aDetail({ checks: [aCheck({ id: "c1", item: "有对比表" }), gate, offer] }), api: { confirmCheck: async () => confirmed } });
  const acceptance = listBlock(view.host, t.plan.spec.acceptance);
  const [inForce, offered] = [...acceptance.querySelectorAll(".plan-spec-checks-orphans li")];
  expect(inForce!.querySelector(".check-pill.is-pass")).not.toBeNull();
  expect(offered!.querySelector(".check-pill.is-proposed")?.textContent).toContain(`${t.plan.checks.status.proposed} · ${t.plan.checks.status.fail}`);
  // The offer counts toward nothing; the gate does.
  expect(acceptance.querySelector(".plan-spec-checks-summary")?.textContent).toBe(t.plan.checks.summary(1, 2));

  click(offered!.querySelector<HTMLButtonElement>(".check-pill"));
  expect(offered!.querySelector(".check-state")?.textContent).toBe("未确认的检查：107.00 秒，你说的是时长 3 分钟（待你确认）");
  expect(buttonByText(offered!, t.plan.checks.rerun).disabled).toBe(false);
  click(buttonByText(offered!, t.plan.checks.confirm));
  await settle();
  expect(view.confirmCheckCalls).toEqual(["c9"]);
  expect(view.saved).toEqual([confirmed]);
  view.close();
});

test("跑检查 runs every active check for the plan and disables while the request is in flight", async () => {
  let resolveRun: ((detail: TaskDetail) => void) | undefined;
  const view = open({
    detail: aDetail({ checks: [aCheck()] }),
    api: { runChecks: () => new Promise<TaskDetail>((resolve) => { resolveRun = resolve; }) },
  });
  const acceptance = listBlock(view.host, t.plan.spec.acceptance);
  const runBtn = acceptance.querySelector<HTMLButtonElement>(".plan-spec-checks-run-btn")!;
  click(runBtn);
  expect(view.runChecksCalls).toEqual([{ taskId: "task-1", checkId: undefined }]);
  expect(runBtn.disabled).toBe(true);
  resolveRun?.(aDetail({ checks: [aCheck({ running: true })] }));
  await settle();
  expect(view.saved).toHaveLength(1);
  view.close();
});

test("+ 检查 opens the form; saving posts createCheck with the drafted input for the chosen line and kind", async () => {
  const view = open();
  const acceptance = listBlock(view.host, t.plan.spec.acceptance);
  click(acceptance.querySelector<HTMLButtonElement>(".plan-spec-checks-add-btn"));
  const form = acceptance.querySelector(".check-form")!;
  selectValue(form.querySelector("select"), "有结论");
  click(buttonByText(form, t.plan.checks.kindContains));
  const inputs = () => [...form.querySelectorAll<HTMLInputElement>(".check-form-input")];
  fill(inputs()[0], "report.md");
  fill(inputs()[1], "sources/");
  click(buttonByText(form, t.plan.save));
  await settle();
  expect(view.createCheckCalls).toEqual([
    {
      taskId: "task-1",
      body: {
        item: "有结论",
        kind: "contains",
        path: "report.md",
        pattern: "sources/",
        negate: false,
        command: null,
        cwd: null,
        expect_exit: null,
        expect_stdout: null,
        timeout_sec: null,
      },
    },
  ]);
  expect(view.saved).toHaveLength(1);
  view.close();
});

test("the form maps 422 codes and a 409 to copy, and passes through invalid_args' own message", async () => {
  async function tryCreate(err: { status: number; code: string; message: string }): Promise<string | null> {
    const view = open({ api: { createCheck: async () => { throw err; } } });
    const acceptance = listBlock(view.host, t.plan.spec.acceptance);
    click(acceptance.querySelector<HTMLButtonElement>(".plan-spec-checks-add-btn"));
    const form = acceptance.querySelector(".check-form")!;
    fill(form.querySelector(".check-form-input"), "report.md");
    click(buttonByText(form, t.plan.save));
    await settle();
    const message = form.querySelector(".field-error")?.textContent ?? null;
    view.close();
    return message;
  }
  expect(await tryCreate({ status: 422, code: "outside_workspace", message: "x" })).toBe(t.plan.checks.outsideWorkspace);
  expect(await tryCreate({ status: 422, code: "too_many_checks", message: "x" })).toBe(t.plan.checks.tooManyChecks);
  expect(await tryCreate({ status: 422, code: "invalid_args", message: "item 太长了" })).toBe("item 太长了");
  expect(await tryCreate({ status: 409, code: "check_gone", message: "x" })).toBe(t.plan.checks.checkGone);
});

test("a check row expands to show its description, source and actions; editing patches, deleting asks to confirm", async () => {
  const check = aCheck({ id: "c1", item: "有对比表", source: "organizer" });
  const view = open({ detail: aDetail({ checks: [check] }) });
  const acceptance = listBlock(view.host, t.plan.spec.acceptance);
  click(acceptance.querySelector(".check-pill"));
  expect(acceptance.querySelector(".check-desc")?.textContent).toBe("report.md 存在且不为空");
  expect(acceptance.querySelector(".check-meta")?.textContent).toContain(t.plan.checks.sourceOrganizer);
  expect(acceptance.querySelector(".check-meta")?.textContent).toContain(t.plan.checks.neverRun);

  const checkActions = acceptance.querySelector(".check-actions")!;
  click(buttonByText(checkActions, t.plan.edit));
  const form = acceptance.querySelector(".check-form")!;
  fill(form.querySelector(".check-form-input"), "other.md");
  click(buttonByText(form, t.plan.save));
  await settle();
  expect(view.patchCheckCalls).toEqual([
    {
      checkId: "c1",
      body: {
        item: "有对比表",
        kind: "exists",
        path: "other.md",
        pattern: null,
        negate: false,
        command: null,
        cwd: null,
        expect_exit: null,
        expect_stdout: null,
        timeout_sec: null,
        if_revision: check.updated_at,
      },
    },
  ]);
  expect(view.saved).toHaveLength(1);

  click(buttonByText(acceptance, t.plan.checks.remove));
  click(buttonByText(acceptance, t.plan.checks.confirmRemove));
  await settle();
  expect(view.deleteCheckCalls).toEqual([{ checkId: "c1", revision: check.updated_at }]);
  expect(view.saved).toHaveLength(2);
  view.close();
});

test("without an api, check pills still show but their actions and the run/add buttons are hidden", () => {
  const view = open({ api: null, detail: aDetail({ checks: [aCheck()] }) });
  const acceptance = listBlock(view.host, t.plan.spec.acceptance);
  expect(acceptance.querySelector(".check-pill")).not.toBeNull();
  expect(acceptance.querySelector(".plan-spec-checks-add-btn")).toBeNull();
  expect(acceptance.querySelector(".plan-spec-checks-run-btn")).toBeNull();
  click(acceptance.querySelector(".check-pill"));
  expect(acceptance.querySelector(".check-desc")).not.toBeNull();
  expect(acceptance.querySelector(".check-actions")).toBeNull();
  view.close();
});

function aTicketRow(over: Partial<TicketWithArtifacts> = {}): TicketWithArtifacts {
  return {
    id: "tk-1",
    task_id: "task-1",
    seq: 1,
    title: "收集资料",
    slug: "01-shou-ji",
    dir: "work/task-1/01-shou-ji",
    spec: "",
    status: "doing",
    worker: null,
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-21T00:00:00.000Z",
    closed_at: null,
    artifacts: [],
    ...over,
  };
}

test("a picked ticket heads the spec it meets; a check filed under another ticket steps back and names it; the tickets' states open the list", () => {
  const shownTickets: string[] = [];
  const statuses: string[] = [];
  const detail = aDetail({
    tickets: [aTicketRow(), aTicketRow({ id: "tk-2", seq: 2, title: "写结论", status: "todo" })],
    ticket_counts: { todo: 1, doing: 1, review: 0, done: 0, parked: 0 },
    checks: [aCheck({ id: "c-02", ticket_id: "tk-2" }), aCheck({ id: "c-plan", item: "有结论" })],
  });
  const props = reactive({
    api: null,
    detail,
    t,
    onSaved: () => {},
    onConflict: () => {},
    onJump: () => {},
    selectedTicket: "tk-1" as string | null,
    onShowTicket: (id: string) => shownTickets.push(id),
    onClearTicket: () => {
      props.selectedTicket = null;
    },
    onShowTickets: (status: string) => statuses.push(status),
  });
  const view = render(PlanSpecPanel, props as never);
  const strip = view.host.querySelector(".plan-spec-focus")!;
  expect(strip.querySelector(".plan-spec-focus-label")?.textContent).toBe(t.plan.links.focus);
  expect(strip.querySelector(".plan-spec-ticket-ref")?.textContent).toBe("01");
  expect(strip.querySelector(".plan-spec-focus-title")?.textContent).toBe("收集资料");
  expect(strip.querySelector(".plan-spec-focus-hint")?.textContent).toBe(t.plan.links.focusHint);
  // It sits above the goal: the spec is read against it.
  expect(view.host.querySelector(".plan-spec-body")?.firstElementChild?.classList.contains("plan-spec-focus")).toBe(true);
  const checks = [...view.host.querySelectorAll<HTMLElement>(".plan-spec-check")];
  expect(checks.map((check) => check.querySelector(".plan-spec-ticket-ref")?.textContent ?? null)).toEqual(["02", null]);
  expect(checks[0]?.classList.contains("is-ticket-other")).toBe(true);
  expect(checks[1]?.className).not.toContain("is-ticket");
  click(checks[0]?.querySelector("button.plan-spec-ticket-ref"));
  click(strip.querySelector(".plan-spec-focus-ticket"));
  expect(shownTickets).toEqual(["tk-2", "tk-1"]);
  // Above the written progress, where the tickets themselves stand.
  const states = [...view.host.querySelectorAll<HTMLButtonElement>(".plan-spec-ticket-state")];
  expect(states.map((state) => state.textContent?.replace(/\s+/g, ""))).toEqual(["待做1", "进行中1"]);
  expect(view.host.querySelector(".plan-spec-ticket-states + .plan-spec-section.is-progress")).not.toBeNull();
  click(states[0]);
  expect(statuses).toEqual(["todo"]);
  // The strip puts the ticket down; nothing steps back any more.
  click(strip.querySelector(".plan-spec-focus-clear"));
  flushSync();
  expect(view.host.querySelector(".plan-spec-focus")).toBeNull();
  expect(view.host.querySelector(".is-ticket-other")).toBeNull();
  view.close();
});

test("a plan without tickets has no ticket states, and a picked ticket that is not this plan's draws no strip", () => {
  const view = render(
    PlanSpecPanel,
    reactive({ api: null, detail: aDetail({ ticket_counts: { todo: 0, doing: 0, review: 0, done: 0, parked: 0 } }), t, onSaved: () => {}, onConflict: () => {}, onJump: () => {}, selectedTicket: "elsewhere" }) as never,
  );
  expect(view.host.querySelector(".plan-spec-ticket-states")).toBeNull();
  expect(view.host.querySelector(".plan-spec-focus")).toBeNull();
  view.close();
});
