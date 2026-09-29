import { expect, test } from "bun:test";
import type { AcceptanceCheck, AcceptanceCheckRun, PlanSpec, TaskDetail } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import {
  badgeOf,
  checkSummary,
  checksForLine,
  describeCheck,
  draftFromCheck,
  draftToInput,
  emptyDraft,
  orphanChecks,
  type CheckDraft,
} from "./acceptance-checks.ts";

const zh = copyFor("zh");
const en = copyFor("en");

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

function aSpec(over: Partial<PlanSpec> = {}): PlanSpec {
  return {
    kind: "调研",
    goal: "把三种方案比出高下",
    acceptance: ["有对比表", "有结论"],
    rules: [],
    process: [],
    progress: { done: [], open: [], blocked: [] },
    status: "active",
    ...over,
  };
}

function aDetail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "task-1",
    dir: "work/2026-09-24-diao-yan-abcd",
    title: "调研",
    session_id: "group-1",
    closed_at: null,
    last_activity_at: "2026-09-24T00:00:00.000Z",
    goal: "把三种方案比出高下",
    kind: "调研",
    status: "active",
    ticket_counts: { todo: 0, doing: 0, review: 0, done: 0, parked: 0 },
    brief: null,
    spec: aSpec(),
    spec_updated_at: "2026-09-24T08:30:00.000Z",
    revision: 1,
    revision_actor: "app",
    routine_id: null,
    tickets: [],
    checks: [],
    ...over,
  };
}

test("badgeOf: running outranks the last verdict, absent one it reads as never run", () => {
  expect(badgeOf(aCheck({ running: true, last_run: aRun({ outcome: "fail" }) }))).toBe("running");
  expect(badgeOf(aCheck({ last_run: aRun({ outcome: "pass" }) }))).toBe("pass");
  expect(badgeOf(aCheck({ last_run: aRun({ outcome: "fail" }) }))).toBe("fail");
  expect(badgeOf(aCheck({ last_run: aRun({ outcome: "blocked" }) }))).toBe("blocked");
  expect(badgeOf(aCheck({ last_run: aRun({ outcome: "error" }) }))).toBe("error");
  expect(badgeOf(aCheck({ last_run: null }))).toBe("none");
});

test("checksForLine only returns checks filed under that exact line", () => {
  const a = aCheck({ id: "a", item: "有对比表" });
  const b = aCheck({ id: "b", item: "有结论" });
  const c = aCheck({ id: "c", item: "有对比表" });
  expect(checksForLine([a, b, c], "有对比表")).toEqual([a, c]);
  expect(checksForLine([a, b, c], "没有的行")).toEqual([]);
});

test("orphanChecks keeps checks whose line no longer matches the plan", () => {
  const a = aCheck({ id: "a", item: "有对比表" });
  const b = aCheck({ id: "b", item: "旧的一条" });
  expect(orphanChecks([a, b], ["有对比表", "有结论"])).toEqual([b]);
  expect(orphanChecks([a, b], [])).toEqual([a, b]);
});

test("checkSummary counts how many of the given checks last passed", () => {
  const pass = aCheck({ id: "a", last_run: aRun({ outcome: "pass" }) });
  const fail = aCheck({ id: "b", last_run: aRun({ outcome: "fail" }) });
  const never = aCheck({ id: "c", last_run: null });
  expect(checkSummary([pass, fail, never])).toEqual({ pass: 1, total: 3 });
  expect(checkSummary([])).toEqual({ pass: 0, total: 0 });
});

test("describeCheck: exists", () => {
  const check = aCheck({ kind: "exists", path: "report.md" });
  expect(describeCheck(check, zh)).toBe("report.md 存在且不为空");
  expect(describeCheck(check, en)).toBe("report.md exists and is not empty");
});

test("describeCheck: contains, with the negate variant", () => {
  const check = aCheck({ kind: "contains", path: "report.md", pattern: "sources/", negate: false });
  expect(describeCheck(check, zh)).toBe("report.md 包含 “sources/”");
  expect(describeCheck(check, en)).toBe("report.md contains “sources/”");
  const negated = aCheck({ kind: "contains", path: "report.md", pattern: "TODO", negate: true });
  expect(describeCheck(negated, zh)).toBe("report.md 不包含 “TODO”");
  expect(describeCheck(negated, en)).toBe("report.md does not contain “TODO”");
});

test("describeCheck: matches, with the negate variant", () => {
  const check = aCheck({ kind: "matches", path: "report.md", pattern: "^\\|.+\\|", negate: false });
  expect(describeCheck(check, zh)).toBe("report.md 匹配 /^\\|.+\\|/");
  expect(describeCheck(check, en)).toBe("report.md matches /^\\|.+\\|/");
  const negated = aCheck({ kind: "matches", path: "report.md", pattern: "TODO", negate: true });
  expect(describeCheck(negated, zh)).toBe("report.md 不匹配 /TODO/");
  expect(describeCheck(negated, en)).toBe("report.md does not match /TODO/");
});

test("describeCheck: command, with and without a cwd", () => {
  const withCwd = aCheck({ kind: "command", command: "bun test", cwd: "work/x/03", expect_exit: 0 });
  expect(describeCheck(withCwd, zh)).toBe("在 work/x/03 运行 `bun test`，期望退出码 0");
  expect(describeCheck(withCwd, en)).toBe("Runs `bun test` in work/x/03, expecting exit code 0");
  const noCwd = aCheck({ kind: "command", command: "bun test", cwd: null, expect_exit: 1 });
  expect(describeCheck(noCwd, zh)).toBe("运行 `bun test`，期望退出码 1");
  expect(describeCheck(noCwd, en)).toBe("Runs `bun test`, expecting exit code 1");
});

test("describeCheck: continuity, by path or by command", () => {
  const byPath = aCheck({ kind: "continuity", path: "renders/ep01_MASTER.mp4", command: null, cwd: null });
  expect(describeCheck(byPath, zh)).toBe("检查 renders/ep01_MASTER.mp4 每个剪切点前后的连贯");
  expect(describeCheck(byPath, en)).toBe("Checks continuity around every cut of renders/ep01_MASTER.mp4");
  const byCommand = aCheck({ kind: "continuity", path: null, command: "grep -o 'shots/.*\\.mp4' stitch.py", cwd: "work/x" });
  expect(describeCheck(byCommand, zh)).toBe("按 `grep -o 'shots/.*\\.mp4' stitch.py`（在 work/x） 列出的镜头顺序检查镜头交界连贯");
  expect(describeCheck(byCommand, en)).toBe("Checks shot-boundary continuity in the order listed by `grep -o 'shots/.*\\.mp4' stitch.py` (in work/x)");
});

test("emptyDraft preselects the given item, else the plan's first acceptance line", () => {
  const draft = emptyDraft(aDetail(), "有结论");
  expect(draft.item).toBe("有结论");
  expect(draft.kind).toBe("exists");
  expect(draft.path).toBe("");
  expect(draft.timeoutSec).toBe("");

  const fallback = emptyDraft(aDetail(), "");
  expect(fallback.item).toBe("有对比表");

  const noSpec = emptyDraft(aDetail({ spec: null }), "");
  expect(noSpec.item).toBe("");
});

test("draftFromCheck round-trips an existing check's fields into editable strings", () => {
  const check = aCheck({
    kind: "command",
    path: null,
    command: "bun test",
    cwd: "work/x",
    expect_exit: 0,
    expect_stdout: "ok",
    timeout_sec: 60,
  });
  const draft = draftFromCheck(check);
  expect(draft).toEqual({
    item: "有对比表",
    kind: "command",
    path: "",
    pattern: "",
    negate: false,
    command: "bun test",
    cwd: "work/x",
    expectExit: "0",
    expectStdout: "ok",
    timeoutSec: "60",
  });
});

function aDraft(over: Partial<CheckDraft> = {}): CheckDraft {
  return {
    item: "有对比表",
    kind: "exists",
    path: "report.md",
    pattern: "",
    negate: false,
    command: "",
    cwd: "",
    expectExit: "",
    expectStdout: "",
    timeoutSec: "",
    ...over,
  };
}

test("draftToInput: exists needs an item and a path", () => {
  const { errors, input } = draftToInput(aDraft());
  expect(errors).toEqual({});
  expect(input).toEqual({
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
  });

  expect(draftToInput(aDraft({ item: "  " })).errors).toEqual({ item: true });
  expect(draftToInput(aDraft({ path: "" })).errors).toEqual({ path: true });
});

test("draftToInput: contains and matches need a pattern too, and carry negate", () => {
  const contains = draftToInput(aDraft({ kind: "contains", path: "report.md", pattern: "sources/", negate: true }));
  expect(contains.errors).toEqual({});
  expect(contains.input).toMatchObject({ kind: "contains", pattern: "sources/", negate: true });
  expect(draftToInput(aDraft({ kind: "matches", path: "report.md", pattern: "" })).errors).toEqual({ pattern: true });
});

test("draftToInput: command needs a command, parses expect_exit and timeout, drops blank cwd/expect_stdout", () => {
  const draft = aDraft({
    item: "跑测试",
    kind: "command",
    path: "",
    command: "bun test",
    cwd: "  ",
    expectExit: "0",
    expectStdout: "  ",
    timeoutSec: "60",
  });
  const { errors, input } = draftToInput(draft);
  expect(errors).toEqual({});
  expect(input).toEqual({
    item: "跑测试",
    kind: "command",
    path: null,
    pattern: null,
    negate: false,
    command: "bun test",
    cwd: null,
    expect_exit: 0,
    expect_stdout: null,
    timeout_sec: 60,
  });

  expect(draftToInput(aDraft({ kind: "command", command: "" })).errors).toEqual({ command: true });
  expect(draftToInput(aDraft({ kind: "command", command: "bun test", expectExit: "abc" })).errors).toEqual({ expectExit: true });
});

test("draftToInput: continuity needs a path or a command, and sends whichever was filled in", () => {
  const byPath = draftToInput(aDraft({ kind: "continuity", path: "renders/*_MASTER.mp4", command: "" }));
  expect(byPath.errors).toEqual({});
  expect(byPath.input).toEqual({
    item: "有对比表",
    kind: "continuity",
    path: "renders/*_MASTER.mp4",
    pattern: null,
    negate: false,
    command: null,
    cwd: null,
    expect_exit: null,
    expect_stdout: null,
    timeout_sec: null,
  });

  const byCommand = draftToInput(aDraft({ kind: "continuity", path: "", command: "cat list.txt", cwd: "work/x" }));
  expect(byCommand.errors).toEqual({});
  expect(byCommand.input).toEqual({
    item: "有对比表",
    kind: "continuity",
    path: null,
    pattern: null,
    negate: false,
    command: "cat list.txt",
    cwd: "work/x",
    expect_exit: null,
    expect_stdout: null,
    timeout_sec: null,
  });

  expect(draftToInput(aDraft({ kind: "continuity", path: "", command: "" })).errors).toEqual({ pathOrCommand: true });
});

test("draftToInput: timeout must be a blank or an integer from 1 to 600", () => {
  expect(draftToInput(aDraft({ timeoutSec: "" })).errors).toEqual({});
  expect(draftToInput(aDraft({ timeoutSec: "600" })).input?.timeout_sec).toBe(600);
  expect(draftToInput(aDraft({ timeoutSec: "0" })).errors).toEqual({ timeoutSec: true });
  expect(draftToInput(aDraft({ timeoutSec: "601" })).errors).toEqual({ timeoutSec: true });
  expect(draftToInput(aDraft({ timeoutSec: "abc" })).errors).toEqual({ timeoutSec: true });
});
