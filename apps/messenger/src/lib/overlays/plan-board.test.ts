import { expect, test } from "bun:test";
import { USER_MEMBER, type AcceptanceCheck, type PlanRequirement, type PlanSpec, type SessionTaskSummary, type TaskTraceNode, type TicketCounts, type TicketWithArtifacts } from "@real-bot/protocol";
import { aBot } from "../test-fixtures.ts";
import { botAvatarColor } from "../avatar.ts";
import { rosterLetter } from "../sidebar/roster-letter.ts";
import {
  SPEC_LIST_FIELDS,
  TICKET_STATUS_ORDER,
  actorFace,
  actorName,
  boardState,
  countedTicketCount,
  countsEntries,
  defaultJob,
  isOneShot,
  firstPreviewable,
  latestTurnOfTicket,
  openTicketCount,
  parkedTicketCount,
  parseSpecLines,
  planTitle,
  specLines,
  specWithGoal,
  specWithLines,
  requirementTicket,
  ticketArtifactAttachments,
  ticketBinding,
  ticketObligations,
  ticketTag,
  totalTicketCount,
  completionPercentage,
} from "./plan-board.ts";

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

function aTicket(over: Partial<TicketWithArtifacts> = {}): TicketWithArtifacts {
  return {
    id: "ticket-1",
    task_id: "task-1",
    seq: 1,
    title: "收集资料",
    slug: "01-shou-ji",
    dir: "work/task-1/01-shou-ji",
    spec: "找三种方案的资料",
    status: "doing",
    worker: "bot-1",
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-21T00:00:00.000Z",
    closed_at: null,
    artifacts: [],
    ...over,
  };
}

function aNode(over: Partial<TaskTraceNode> = {}): TaskTraceNode {
  return {
    turn_id: "t-1",
    session_id: "group-1",
    actor: "bot-1",
    status: "completed",
    woken_by_turn_id: null,
    woken_elsewhere: null,
    trigger_message_id: "m1",
    focus_message_id: "m1",
    summary: "干活",
    created_at: "2026-09-20T00:00:00.000Z",
    artifacts: [],
    ask: null,
    approval: null,
    passed: 0,
    ticket_id: null,
    ...over,
  };
}

test("SPEC_LIST_FIELDS is in panel order", () => {
  expect(SPEC_LIST_FIELDS).toEqual(["acceptance", "rules", "process", "progress.done", "progress.open", "progress.blocked"]);
});

test("TICKET_STATUS_ORDER is todo to parked", () => {
  expect(TICKET_STATUS_ORDER).toEqual(["todo", "doing", "review", "done", "parked"]);
});

test("ticketTag pads to two digits", () => {
  expect(ticketTag(1)).toBe("01");
  expect(ticketTag(9)).toBe("09");
  expect(ticketTag(12)).toBe("12");
  expect(ticketTag(123)).toBe("123");
});

test("planTitle is the job's name, else its goal, else the dir", () => {
  expect(planTitle({ goal: "把方案比出高下", title: "调研", dir: "work/x" })).toBe("调研");
  expect(planTitle({ goal: "把方案比出高下", title: "  ", dir: "work/x" })).toBe("把方案比出高下");
  expect(planTitle({ goal: null, title: "调研", dir: "work/x" })).toBe("调研");
  expect(planTitle({ goal: undefined, title: "", dir: "work/x" })).toBe("work/x");
  expect(planTitle({ title: "  ", dir: "work/x" })).toBe("work/x");
});

test("countsEntries keeps only non-zero counts, in status order", () => {
  const counts: TicketCounts = { todo: 2, doing: 0, review: 1, done: 0, parked: 3 };
  expect(countsEntries(counts)).toEqual([
    { status: "todo", count: 2 },
    { status: "review", count: 1 },
    { status: "parked", count: 3 },
  ]);
});

test("countsEntries is empty for missing or all-zero counts", () => {
  expect(countsEntries(null)).toEqual([]);
  expect(countsEntries(undefined)).toEqual([]);
  expect(countsEntries({ todo: 0, doing: 0, review: 0, done: 0, parked: 0 })).toEqual([]);
});

test("openTicketCount sums todo, doing, and review only", () => {
  expect(openTicketCount({ todo: 1, doing: 2, review: 3, done: 4, parked: 5 })).toBe(6);
  expect(openTicketCount(null)).toBe(0);
});

test("totalTicketCount sums every status", () => {
  expect(totalTicketCount({ todo: 1, doing: 2, review: 3, done: 4, parked: 5 })).toBe(15);
  expect(totalTicketCount(undefined)).toBe(0);
});

test("completionPercentage computes rounded done percentage", () => {
  expect(completionPercentage({ todo: 1, doing: 1, review: 0, done: 2, parked: 0 })).toBe(50);
  expect(completionPercentage({ todo: 0, doing: 0, review: 0, done: 3, parked: 0 })).toBe(100);
  expect(completionPercentage({ todo: 1, doing: 0, review: 0, done: 0, parked: 0 })).toBe(0);
  expect(completionPercentage(null)).toBe(0);
});

test("completionPercentage leaves out tickets that are parked, dropped or set aside: they are not work still to do", () => {
  // 3 of 4 tickets that count are done; the two parked ones are neither done nor left to do.
  expect(completionPercentage({ todo: 1, doing: 0, review: 0, done: 3, parked: 2 })).toBe(75);
  expect(completionPercentage({ todo: 0, doing: 0, review: 0, done: 1, parked: 4 })).toBe(100);
  // Nothing but parked tickets: nothing to be a share of.
  expect(completionPercentage({ todo: 0, doing: 0, review: 0, done: 0, parked: 3 })).toBe(0);
});

test("countedTicketCount is every ticket but the parked, and parkedTicketCount is the rest", () => {
  const counts: TicketCounts = { todo: 1, doing: 2, review: 3, done: 4, parked: 5 };
  expect(countedTicketCount(counts)).toBe(10);
  expect(parkedTicketCount(counts)).toBe(5);
  expect(countedTicketCount(null)).toBe(0);
  expect(parkedTicketCount(undefined)).toBe(0);
});

function aSummary(over: Partial<SessionTaskSummary> = {}): SessionTaskSummary {
  return {
    id: "task-1",
    dir: "work/x",
    title: "x",
    session_id: "group-1",
    closed_at: null,
    last_activity_at: "2026-09-22T00:00:00.000Z",
    goal: null,
    kind: null,
    status: "active",
    ticket_counts: { todo: 0, doing: 0, review: 0, done: 0, parked: 0 },
    ...over,
  };
}

test("boardState reads a settled job the way the daemon's ball does: dormant first, then parked, then done", () => {
  expect(boardState(aSummary())).toBeNull();
  expect(boardState(aSummary({ status: "done" }))).toBe("ended");
  expect(boardState(aSummary({ status: "parked" }))).toBe("parked");
  expect(boardState(aSummary({ dormant_since: "2026-09-23T00:00:00.000Z" }))).toBe("dormant");
  // Dormancy outranks the status it was set aside under.
  expect(boardState(aSummary({ status: "done", dormant_since: "2026-09-23T00:00:00.000Z" }))).toBe("dormant");
  expect(boardState(aSummary({ status: "parked", dormant_since: "2026-09-23T00:00:00.000Z" }))).toBe("dormant");
  expect(boardState(aSummary({ dormant_since: null }))).toBeNull();
});

test("isOneShot: a closed job with no tickets and a single turn", () => {
  const closed = { status: "done" as const, closed_at: "2026-09-22T01:00:00.000Z" };
  expect(isOneShot(aSummary({ ...closed, turn_count: 1 }))).toBe(true);
  expect(isOneShot(aSummary({ ...closed, turn_count: 0 }))).toBe(true);
  // Any one of the three says it is closed.
  expect(isOneShot(aSummary({ status: "done", turn_count: 1 }))).toBe(true);
  expect(isOneShot(aSummary({ status: "parked", turn_count: 1 }))).toBe(true);
  expect(isOneShot(aSummary({ closed_at: "2026-09-22T01:00:00.000Z", turn_count: 1 }))).toBe(true);
  expect(isOneShot(aSummary({ dormant_since: "2026-09-23T00:00:00.000Z", turn_count: 1 }))).toBe(true);
});

test("isOneShot is false for a job still going, one that took two turns, one with a ticket, or one with no count", () => {
  const closed = { status: "done" as const };
  expect(isOneShot(aSummary({ turn_count: 1 }))).toBe(false);
  expect(isOneShot(aSummary({ ...closed, turn_count: 2 }))).toBe(false);
  expect(isOneShot(aSummary({ ...closed, turn_count: 1, ticket_counts: { todo: 0, doing: 0, review: 0, done: 0, parked: 1 } }))).toBe(false);
  // A daemon that does not count turns never folds a job.
  expect(isOneShot(aSummary(closed))).toBe(false);
});

test("defaultJob is the newest job that is not a one-shot, else the newest", () => {
  const shot = (id: string) => aSummary({ id, status: "done", turn_count: 1 });
  const real = (id: string) => aSummary({ id, status: "done", turn_count: 5 });
  expect(defaultJob([shot("a"), shot("b"), real("c"), real("d")])?.id).toBe("c");
  expect(defaultJob([real("a"), shot("b")])?.id).toBe("a");
  expect(defaultJob([shot("a"), shot("b")])?.id).toBe("a");
  expect(defaultJob([])).toBeNull();
});

test("latestTurnOfTicket finds the newest node worked in that ticket", () => {
  const older = aNode({ turn_id: "t-old", ticket_id: "ticket-1", created_at: "2026-09-20T00:00:00.000Z" });
  const newer = aNode({ turn_id: "t-new", ticket_id: "ticket-1", created_at: "2026-09-21T00:00:00.000Z" });
  const other = aNode({ turn_id: "t-other", ticket_id: "ticket-2", created_at: "2026-09-22T00:00:00.000Z" });
  expect(latestTurnOfTicket([older, newer, other], "ticket-1")).toBe(newer);
});

test("latestTurnOfTicket breaks a created_at tie by array order (last one wins)", () => {
  const first = aNode({ turn_id: "t-first", ticket_id: "ticket-1", created_at: "2026-09-20T00:00:00.000Z" });
  const second = aNode({ turn_id: "t-second", ticket_id: "ticket-1", created_at: "2026-09-20T00:00:00.000Z" });
  expect(latestTurnOfTicket([first, second], "ticket-1")).toBe(second);
});

test("latestTurnOfTicket is null when no node worked in that ticket", () => {
  const node = aNode({ ticket_id: "ticket-2" });
  expect(latestTurnOfTicket([node], "ticket-1")).toBeNull();
  expect(latestTurnOfTicket([], "ticket-1")).toBeNull();
});

test("ticketArtifactAttachments mirrors TraceView's sibling shape", () => {
  const ticket = aTicket({
    updated_at: "2026-09-21T10:00:00.000Z",
    artifacts: [
      { path: "work/task-1/01/report.md", message_id: "m1", attachment_id: "a1" },
      { path: "work/task-1/01/board.pdf", message_id: "m2", attachment_id: "a2", exists: false },
    ],
  });
  expect(ticketArtifactAttachments(ticket)).toEqual([
    {
      id: "a1",
      message_id: "m1",
      workspace_relpath: "work/task-1/01/report.md",
      original_filename: "report.md",
      created_at: "2026-09-21T10:00:00.000Z",
    },
    {
      id: "a2",
      message_id: "m2",
      workspace_relpath: "work/task-1/01/board.pdf",
      original_filename: "board.pdf",
      created_at: "2026-09-21T10:00:00.000Z",
      exists: false,
    },
  ]);
});

test("ticketArtifactAttachments falls back to the whole path when there is no slash", () => {
  const ticket = aTicket({ artifacts: [{ path: "report.md", message_id: "m1", attachment_id: "a1" }] });
  expect(ticketArtifactAttachments(ticket)[0]?.original_filename).toBe("report.md");
});

test("firstPreviewable prefers an existing non-dir row", () => {
  const rows = [
    { id: "a1", message_id: "m1", workspace_relpath: "a", original_filename: "a", created_at: "", is_dir: true },
    { id: "a2", message_id: "m1", workspace_relpath: "b", original_filename: "b", created_at: "", exists: false },
    { id: "a3", message_id: "m1", workspace_relpath: "c", original_filename: "c", created_at: "" },
  ];
  expect(firstPreviewable(rows)?.id).toBe("a3");
});

test("firstPreviewable falls back to any existing row, then the first row", () => {
  const onlyMissing = [
    { id: "a1", message_id: "m1", workspace_relpath: "a", original_filename: "a", created_at: "", exists: false },
    { id: "a2", message_id: "m1", workspace_relpath: "b", original_filename: "b", created_at: "", exists: false },
  ];
  expect(firstPreviewable(onlyMissing)?.id).toBe("a1");

  const onlyDirs = [
    { id: "a1", message_id: "m1", workspace_relpath: "a", original_filename: "a", created_at: "", is_dir: true },
  ];
  expect(firstPreviewable(onlyDirs)?.id).toBe("a1");
});

test("firstPreviewable is null for an empty list", () => {
  expect(firstPreviewable([])).toBeNull();
});

test("specLines reads each field, including the nested progress ones", () => {
  const spec = aSpec();
  expect(specLines(spec, "acceptance")).toBe(spec.acceptance);
  expect(specLines(spec, "rules")).toBe(spec.rules);
  expect(specLines(spec, "process")).toBe(spec.process);
  expect(specLines(spec, "progress.done")).toBe(spec.progress.done);
  expect(specLines(spec, "progress.open")).toBe(spec.progress.open);
  expect(specLines(spec, "progress.blocked")).toBe(spec.progress.blocked);
});

test("parseSpecLines trims, drops blanks, and drops exact repeats", () => {
  expect(parseSpecLines("  a  \n\n b \n\na\n")).toEqual(["a", "b"]);
});

test("parseSpecLines strips a leading dash or bullet", () => {
  expect(parseSpecLines("- a\n• b\nc")).toEqual(["a", "b", "c"]);
});

test("parseSpecLines drops a line that is only a bullet", () => {
  expect(parseSpecLines("- \n•\na")).toEqual(["a"]);
});

test("parseSpecLines dedupes after stripping bullets, not before", () => {
  expect(parseSpecLines("- a\na")).toEqual(["a"]);
});

test("parseSpecLines on empty text is an empty list", () => {
  expect(parseSpecLines("")).toEqual([]);
  expect(parseSpecLines("   \n  \n")).toEqual([]);
});

test("specWithLines replaces one field and deep-copies progress, without mutating the input", () => {
  const spec = aSpec();
  const next = specWithLines(spec, "acceptance", ["新的验收"]);
  expect(next.acceptance).toEqual(["新的验收"]);
  expect(spec.acceptance).toEqual(["有对比表", "有结论"]);
  expect(next).not.toBe(spec);
  expect(next.progress).not.toBe(spec.progress);
});

test("specWithLines replaces a progress sub-field without touching its siblings", () => {
  const spec = aSpec();
  const next = specWithLines(spec, "progress.open", ["写结论草稿"]);
  expect(next.progress.open).toEqual(["写结论草稿"]);
  expect(next.progress.done).toEqual(spec.progress.done);
  expect(next.progress.blocked).toEqual(spec.progress.blocked);
  expect(spec.progress.open).toEqual(["写结论"]);
});

test("specWithGoal trims and replaces the goal", () => {
  const spec = aSpec();
  const next = specWithGoal(spec, "  新目标  ");
  expect(next.goal).toBe("新目标");
  expect(spec.goal).toBe("把三种方案比出高下");
});

test("specWithGoal keeps the old goal on a blank edit", () => {
  const spec = aSpec();
  expect(specWithGoal(spec, "   ").goal).toBe(spec.goal);
  expect(specWithGoal(spec, "").goal).toBe(spec.goal);
});

test("actorFace for the user has no bot palette", () => {
  const face = actorFace(USER_MEMBER, new Map(), "你", "已删除");
  expect(face).toEqual({ src: null, letter: rosterLetter("你"), palette: null });
});

test("actorFace for a known bot uses its avatar, name letter, and a palette keyed by id", () => {
  const bot = aBot({ id: "bot-1", name: "分镜师", avatar: "<svg/>" });
  const face = actorFace("bot-1", new Map([["bot-1", bot]]), "你", "已删除");
  expect(face.src).toBe("data:image/svg+xml;utf8,%3Csvg%2F%3E");
  expect(face.letter).toBe(rosterLetter("分镜师"));
  expect(face.palette).toEqual(botAvatarColor("bot-1"));
});

test("actorFace for an unknown bot falls back to the deleted label", () => {
  const face = actorFace("bot-ghost", new Map(), "你", "已删除");
  expect(face.src).toBeNull();
  expect(face.letter).toBe(rosterLetter("已删除"));
  expect(face.palette).toEqual(botAvatarColor("bot-ghost"));
});

test("actorName mirrors actorFace's naming", () => {
  const bot = aBot({ id: "bot-1", name: "分镜师" });
  expect(actorName(USER_MEMBER, new Map(), "你", "已删除")).toBe("你");
  expect(actorName("bot-1", new Map([["bot-1", bot]]), "你", "已删除")).toBe("分镜师");
  expect(actorName("bot-ghost", new Map(), "你", "已删除")).toBe("已删除");
});

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
    source: null,
    added_by: "scribe",
    inherited_from: null,
    excluded: false,
    supersedes: null,
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

test("ticketBinding: an item held to the ticket in focus is its own, to another ticket is another's, to none holds for all", () => {
  expect(ticketBinding("ticket-1", "ticket-1")).toBe("mine");
  expect(ticketBinding("ticket-2", "ticket-1")).toBe("other");
  expect(ticketBinding(null, "ticket-1")).toBeNull();
  expect(ticketBinding(undefined, "ticket-1")).toBeNull();
  // Nothing in focus: nothing stands out and nothing dims.
  expect(ticketBinding("ticket-1", null)).toBeNull();
});

test("requirementTicket: only a ticket's or a part's entry holds for one ticket", () => {
  expect(requirementTicket(anEntry({ scope: "ticket", ticket_id: "ticket-1" }))).toBe("ticket-1");
  expect(requirementTicket(anEntry({ scope: "part", ticket_id: "ticket-1" }))).toBe("ticket-1");
  expect(requirementTicket(anEntry({ scope: "plan" }))).toBeNull();
  expect(requirementTicket(anEntry({ scope: "project", ticket_id: "ticket-1" }))).toBeNull();
  expect(requirementTicket(anEntry({ scope: "standing" }))).toBeNull();
});

test("ticketObligations: the plan's acceptance, rules and requirements in force for every ticket, plus what is held to this one", () => {
  const detail = {
    spec: aSpec({ acceptance: ["a", "b"], rules: ["r"] }),
    requirements: [
      anEntry({ id: "plan", seq: 1 }),
      anEntry({ id: "project", seq: 2, scope: "project", inherited_from: { task_id: "task-0", title: "前一件" } }),
      anEntry({ id: "mine-late", seq: 9, scope: "ticket", ticket_id: "ticket-1" }),
      anEntry({ id: "mine", seq: 4, scope: "part", ticket_id: "ticket-1" }),
      anEntry({ id: "other", seq: 5, scope: "ticket", ticket_id: "ticket-2" }),
      // Not in force: offered, an old rule, set not to hold here.
      anEntry({ id: "proposed", seq: 6, status: "proposed", scope: "ticket", ticket_id: "ticket-1" }),
      anEntry({ id: "unverified", seq: 7, status: "unverified" }),
      anEntry({ id: "excluded", seq: 8, excluded: true }),
    ],
    checks: [aCheck({ id: "plan-check" }), aCheck({ id: "mine-check", ticket_id: "ticket-1" }), aCheck({ id: "other-check", ticket_id: "ticket-2" })],
  };
  const owes = ticketObligations(detail, "ticket-1");
  expect(owes.acceptance).toBe(2);
  expect(owes.rules).toBe(1);
  expect(owes.planRequirements).toBe(2);
  expect(owes.requirements.map((entry) => entry.id)).toEqual(["mine", "mine-late"]);
  expect(owes.checks.map((check) => check.id)).toEqual(["mine-check"]);
});

test("ticketObligations on a plan with no spec, ledger or checks yet owes nothing", () => {
  expect(ticketObligations({ spec: null }, "ticket-1")).toEqual({ acceptance: 0, rules: 0, planRequirements: 0, requirements: [], checks: [] });
});
