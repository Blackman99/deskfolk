import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { Bot, TaskDetail, TaskTraceNode, Ticket, TicketWithArtifacts } from "@real-bot/protocol";
import TicketList from "./TicketList.svelte";
import { copyFor } from "../copy.ts";
import { aBot } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { settle } from "../test-async.ts";

const t = copyFor("zh");

const writer = aBot({ id: "bot-1", name: "制片" });

function aTicket(over: Partial<TicketWithArtifacts> = {}): TicketWithArtifacts {
  return {
    id: "ticket-1",
    task_id: "task-1",
    seq: 1,
    title: "收集资料",
    slug: "01-shou-ji",
    dir: "work/task-1/01-shou-ji",
    spec: "",
    status: "doing",
    worker: "bot-1",
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-21T00:00:00.000Z",
    closed_at: null,
    artifacts: [],
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
    brief: null,
    spec: null,
    spec_updated_at: null,
    revision: 3,
    revision_actor: "app",
    routine_id: null,
    tickets: [aTicket()],
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


function rowFor(host: HTMLElement, title: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>(".ticket-row")].find(
    (row) => row.querySelector(".ticket-title")?.textContent?.trim() === title,
  );
  if (!found) throw new Error(`no ticket row titled ${title}`);
  return found;
}

/** Drive the row's status Select the way a person would: open it, then click the option. */
function pickStatus(row: HTMLElement, label: string): void {
  click(row.querySelector(".real-select-trigger"));
  const option = [...row.querySelectorAll<HTMLElement>(".real-select-option")].find((el) =>
    el.textContent?.includes(label),
  );
  if (!option) throw new Error(`no status option ${label}`);
  click(option);
}

function open(over: {
  detail?: TaskDetail;
  nodes?: TaskTraceNode[];
  bots?: Bot[];
  api?: Partial<{
    patchTicket: (ticketId: string, body: unknown) => Promise<Ticket>;
  }> | null;
} = {}) {
  const selected: Array<string | null> = [];
  const jumps: Array<[string, string]> = [];
  const openedArtifacts: TicketWithArtifacts[] = [];
  const patched: Ticket[] = [];
  const conflicts: number[] = [];
  const patchCalls: Array<{ ticketId: string; body: unknown }> = [];

  const api =
    over.api === null
      ? null
      : {
          patchTicket: async (ticketId: string, body: unknown) => {
            patchCalls.push({ ticketId, body });
            if (over.api?.patchTicket) return over.api.patchTicket(ticketId, body);
            const status = (body as { status?: Ticket["status"] }).status ?? "doing";
            return { ...aTicket({ id: ticketId, status }) };
          },
        };

  const props = reactive({
    api: api as never,
    detail: over.detail ?? aDetail(),
    nodes: over.nodes ?? [],
    bots: over.bots ?? [writer],
    youLabel: "你",
    deletedLabel: "已删除",
    t,
    selectedId: null as string | null,
    providers: [] as never,
    onSelect: (ticketId: string | null) => {
      selected.push(ticketId);
      props.selectedId = ticketId;
    },
    onJump: (sessionId: string, messageId: string) => jumps.push([sessionId, messageId]),
    onOpenArtifacts: (ticket: TicketWithArtifacts) => openedArtifacts.push(ticket),
    onPatched: (ticket: Ticket) => patched.push(ticket),
    onConflict: () => conflicts.push(1),
  });

  const view = render(TicketList, props as never);
  return { ...view, props, selected, jumps, openedArtifacts, patched, conflicts, patchCalls };
}

test("rows render in seq order with tag, title, status, and worker", () => {
  const view = open({
    detail: aDetail({
      tickets: [
        aTicket({ id: "t2", seq: 2, title: "画分镜", status: "review", worker: null }),
        aTicket({ id: "t1", seq: 1, title: "收集资料", status: "doing", worker: "bot-1" }),
      ],
    }),
  });
  const rows = [...view.host.querySelectorAll(".ticket-row")];
  expect(rows.map((r) => r.querySelector(".ticket-title")?.textContent)).toEqual(["收集资料", "画分镜"]);
  expect(rows.map((r) => r.querySelector(".ticket-tag")?.textContent)).toEqual(["01", "02"]);
  // The status is the row's own menu, its face the status.
  expect(rows[0]?.querySelector(".ticket-status")?.textContent?.trim()).toBe(t.plan.ticketStatus.doing);
  expect(rows[1]?.querySelector(".ticket-status")?.textContent?.trim()).toBe(t.plan.ticketStatus.review);
  expect(rows[0]?.querySelector(".ticket-head .real-select-trigger")).not.toBeNull();
  expect(rows[0]?.querySelector(".ticket-who-text")?.textContent).toBe(t.plan.worker("制片"));
  expect(rows[1]?.querySelector(".ticket-who-text")?.textContent).toBe(t.plan.nobody);
  view.close();
});

test("a stage the status does not say shows in its place, with how many of the ticket's parts passed", () => {
  const view = open({
    detail: aDetail({
      tickets: [
        aTicket({ id: "t1", seq: 1, title: "分镜", status: "review", stage: "in_review", parts: { total: 12, approved: 11 } }),
        aTicket({ id: "t2", seq: 2, title: "母带", status: "doing", stage: "rework" }),
        aTicket({ id: "t3", seq: 3, title: "旧任务", status: "review", stage: null, parts: { total: 0, approved: 0 } }),
      ],
    }),
  });
  const rows = [...view.host.querySelectorAll(".ticket-row")];
  expect(rows.map((r) => r.querySelector(".ticket-status")?.textContent?.trim())).toEqual([
    t.plan.ticketStage.in_review,
    t.plan.ticketStage.rework,
    t.plan.ticketStatus.review,
  ]);
  // The colour still follows the status the stage reads as.
  expect(rows[1]?.querySelector(".ticket-status")?.classList.contains("is-doing")).toBe(true);
  expect(rows.map((r) => r.querySelector(".ticket-parts")?.textContent ?? null)).toEqual(["11/12 已通过", null, null]);
  view.close();
});

test("from level 5 a ticket's reviewer is set on its row, offering only Bots of the plan's conversation and never the Bot on it; below it there is no such menu", async () => {
  const other = aBot({ id: "bot-2", name: "审片" });
  const outsider = aBot({ id: "bot-3", name: "别处的" });
  const view = open({ bots: [writer, other, outsider], detail: aDetail({ submissions_on: true, reviewer_ids: ["bot-1", "bot-2"], tickets: [aTicket({ id: "t1", worker: "bot-1", reviewer_bot_id: null })] }) });
  const row = rowFor(view.host, "收集资料");
  // Unpicked, the row has its status menu only; picked, the reviewer's menu opens below it.
  expect(row.querySelectorAll(".real-select-trigger")).toHaveLength(1);
  click(row.querySelector(".ticket-main"));
  flushSync();
  const menus = row.querySelectorAll(".real-select-trigger");
  expect(menus).toHaveLength(2);
  expect(row.querySelector(".ticket-settings .ticket-setting-label")?.textContent).toBe(t.plan.reviewer);
  click(menus[1]);
  const options = [...row.querySelectorAll<HTMLElement>(".real-select-option")].map((el) => el.textContent?.trim());
  expect(options).toEqual([t.plan.noReviewer, "审片"]);
  click([...row.querySelectorAll<HTMLElement>(".real-select-option")].find((el) => el.textContent?.includes("审片"))!);
  await settle();
  expect(view.patchCalls).toEqual([{ ticketId: "t1", body: { reviewer_bot_id: "bot-2", if_revision: 3 } }]);
  view.close();

  const below = open({ detail: aDetail({ tickets: [aTicket({ id: "t1" })] }) });
  click(rowFor(below.host, "收集资料").querySelector(".ticket-main"));
  flushSync();
  expect(rowFor(below.host, "收集资料").querySelectorAll(".real-select-trigger")).toHaveLength(1);
  expect(below.host.querySelector(".ticket-settings")).toBeNull();
  below.close();
});

test("a ticket filed with its Bot but not started yet reads as that Bot's to do, not as being done", () => {
  const view = open({
    detail: aDetail({ tickets: [aTicket({ id: "t1", seq: 1, title: "收集资料", status: "todo", worker: "bot-1" })] }),
  });
  const who = view.host.querySelector(".ticket-row .ticket-who-text")?.textContent;
  expect(who).toBe(t.plan.worker("制片", false));
  expect(who).not.toBe(t.plan.worker("制片"));
  view.close();
});

test("the header shows the plan's ticket counts, and no tickets says so", () => {
  const view = open({
    detail: aDetail({ ticket_counts: { todo: 1, doing: 2, review: 0, done: 3, parked: 0 }, tickets: [] }),
  });
  expect(view.host.querySelector(".ticket-list-counts")?.textContent).toBe(t.plan.ticketCounts(3, 6));
  expect(view.host.querySelector(".ticket-list-empty")?.textContent).toBe(t.plan.ticketsNone);
  view.close();
});

test("clicking a row selects it, and clicking the selected row again clears it", () => {
  const view = open();
  const row = rowFor(view.host, "收集资料");
  click(row.querySelector(".ticket-main"));
  expect(view.selected).toEqual(["ticket-1"]);
  expect(row.classList.contains("is-selected")).toBe(true);

  click(row.querySelector(".ticket-main"));
  expect(view.selected).toEqual(["ticket-1", null]);
  expect(row.classList.contains("is-selected")).toBe(false);
  view.close();
});

test("the artifacts button only appears when the ticket has artifacts, and opens that ticket", () => {
  const withFiles = aTicket({
    id: "t1",
    title: "有产物",
    artifacts: [{ path: "work/t1/report.md", message_id: "m1", attachment_id: "a1" }],
  });
  const withoutFiles = aTicket({ id: "t2", seq: 2, title: "没产物", artifacts: [] });
  const view = open({ detail: aDetail({ tickets: [withFiles, withoutFiles] }) });

  const rowWith = rowFor(view.host, "有产物");
  const rowWithout = rowFor(view.host, "没产物");
  expect(rowWithout.querySelector(".ticket-artifacts")).toBeNull();
  expect(rowWith.querySelector(".ticket-artifacts")?.textContent).toContain(t.plan.artifacts(1));

  click(rowWith.querySelector(".ticket-artifacts"));
  expect(view.openedArtifacts).toEqual([withFiles]);
  // Clicking the action did not also select the row.
  expect(view.selected).toEqual([]);
  view.close();
});

test("the jump button only appears when a node worked in that ticket, and jumps to the newest one", () => {
  const noTurns = aTicket({ id: "t1", title: "没有轮次" });
  const withTurns = aTicket({ id: "t2", seq: 2, title: "有轮次" });
  const older = aNode({ turn_id: "n1", ticket_id: "t2", session_id: "group-1", focus_message_id: "m-old", created_at: "2026-09-20T00:00:00.000Z" });
  const newer = aNode({ turn_id: "n2", ticket_id: "t2", session_id: "direct-1", focus_message_id: "m-new", created_at: "2026-09-21T00:00:00.000Z" });
  const view = open({ detail: aDetail({ tickets: [noTurns, withTurns] }), nodes: [older, newer] });

  expect(rowFor(view.host, "没有轮次").querySelector(".ticket-jump")).toBeNull();
  click(rowFor(view.host, "有轮次").querySelector(".ticket-jump"));
  expect(view.jumps).toEqual([["direct-1", "m-new"]]);
  expect(view.selected).toEqual([]);
  view.close();
});

test("changing status calls patchTicket with the status and if_revision, then onPatched", async () => {
  const view = open({ detail: aDetail({ revision: 7 }) });
  const row = rowFor(view.host, "收集资料");
  pickStatus(row, t.plan.ticketStatus.review);
  await settle();
  expect(view.patchCalls).toEqual([{ ticketId: "ticket-1", body: { status: "review", if_revision: 7 } }]);
  expect(view.patched).toHaveLength(1);
  expect(view.patched[0]?.status).toBe("review");
  // Driving the select did not select the row.
  expect(view.selected).toEqual([]);
  view.close();
});

test("a 409 on a status change tells the parent to reload, with no local error text", async () => {
  const view = open({
    api: {
      patchTicket: async () => {
        throw { status: 409, message: "stale" };
      },
    },
  });
  const row = rowFor(view.host, "收集资料");
  pickStatus(row, t.plan.ticketStatus.done);
  await settle();
  expect(view.conflicts).toEqual([1]);
  expect(row.querySelector(".ticket-error")).toBeNull();
  expect(view.patched).toEqual([]);
  view.close();
});

test("another error on a status change shows saveFailed under that row", async () => {
  const view = open({
    api: {
      patchTicket: async () => {
        throw new Error("boom");
      },
    },
  });
  const row = rowFor(view.host, "收集资料");
  pickStatus(row, t.plan.ticketStatus.done);
  await settle();
  expect(view.conflicts).toEqual([]);
  expect(row.querySelector(".ticket-error")?.textContent).toBe(t.plan.saveFailed);
  view.close();
});

test("without an api there is no status select, but artifacts and jump still work", () => {
  const ticket = aTicket({
    id: "t1",
    artifacts: [{ path: "work/t1/a.md", message_id: "m1", attachment_id: "a1" }],
  });
  const node = aNode({ ticket_id: "t1" });
  const view = open({ api: null, detail: aDetail({ tickets: [ticket] }), nodes: [node] });
  const row = rowFor(view.host, "收集资料");
  expect(row.querySelector(".real-select-trigger")).toBeNull();
  expect(row.querySelector(".ticket-artifacts")).not.toBeNull();
  expect(row.querySelector(".ticket-jump")).not.toBeNull();
  view.close();
});

test("from level 4 an open ticket says who has the ball and what it waits for; below it, nothing", () => {
  const detail = aDetail({
    supervision_on: true,
    tickets: [
      aTicket({ id: "t1", seq: 1, title: "收集资料", ball: { kind: "owner", bot_id: "bot-1" } }),
      aTicket({ id: "t2", seq: 2, title: "画分镜", ball: { kind: "user", reason: "ceiling" }, depends_on: ["t1"] }),
      aTicket({ id: "t3", seq: 3, title: "剪辑", status: "done" }),
    ],
  });
  const view = open({ detail });
  const rows = [...view.host.querySelectorAll(".ticket-row")];
  // In the line under the title, after who is on it.
  const balls = rows.map((row) => row.querySelector(".ticket-meta .ticket-ball")?.textContent?.trim() ?? null);
  const waits = rows.map((row) => row.querySelector(".ticket-meta .ticket-depends")?.textContent?.trim() ?? null);
  expect(balls).toEqual([(t.plan.ball.owner as (name: string) => string)("制片"), t.plan.ball.ceiling, null]);
  expect(waits).toEqual([null, t.plan.dependsOn("#01"), null]);
  view.close();
  const below = open({ detail: aDetail({ tickets: [aTicket({ id: "t1" }), aTicket({ id: "t2", seq: 2 })] }) });
  click(below.host.querySelector(".ticket-main"));
  flushSync();
  expect(below.host.querySelector(".ticket-ball")).toBeNull();
  expect(below.host.querySelector(".ticket-depends-toggle")).toBeNull();
  below.close();
});

test("the dependency editor sets which tickets one waits for", async () => {
  const detail = aDetail({ supervision_on: true, tickets: [aTicket({ id: "t1", seq: 1 }), aTicket({ id: "t2", seq: 2, title: "画分镜", depends_on: [] })] });
  const view = open({ detail });
  const row = [...view.host.querySelectorAll(".ticket-row")][1]!;
  click(row.querySelector(".ticket-main"));
  flushSync();
  expect(row.querySelector(".ticket-depends-toggle")?.textContent?.trim()).toBe(t.plan.dependsNothing);
  click(row.querySelector(".ticket-depends-toggle"));
  flushSync();
  const box = row.querySelector<HTMLInputElement>(".ticket-depends-option input")!;
  expect(row.querySelector(".ticket-depends-option")?.textContent).toContain("01 收集资料");
  box.click();
  await Promise.resolve();
  expect(view.patchCalls).toEqual([{ ticketId: "t2", body: { depends_on: ["t1"], if_revision: 3 } }]);
  view.close();
});

test("a ticket that already waits on this one cannot be chosen: it would make a loop", () => {
  const detail = aDetail({ supervision_on: true, tickets: [aTicket({ id: "t1", seq: 1 }), aTicket({ id: "t2", seq: 2, depends_on: ["t1"] }), aTicket({ id: "t3", seq: 3, depends_on: ["t2"] })] });
  const view = open({ detail });
  const first = [...view.host.querySelectorAll(".ticket-row")][0]!;
  click(first.querySelector(".ticket-main"));
  flushSync();
  click(first.querySelector(".ticket-depends-toggle"));
  flushSync();
  const options = [...first.querySelectorAll<HTMLLabelElement>(".ticket-depends-option")];
  expect(options.map((option) => [option.textContent?.replace(/\s+/g, " ").trim(), option.querySelector("input")!.disabled])).toEqual([["02 收集资料", true], ["03 收集资料", true]]);
  view.close();
});

test("a reviewer no longer in the plan's conversation still reads by name in its menu", () => {
  const reviewer = aBot({ id: "bot-9", name: "审片员" });
  const view = open({ detail: aDetail({ submissions_on: true, reviewer_ids: [], tickets: [aTicket({ reviewer_bot_id: "bot-9" })] }), bots: [writer, reviewer] });
  // Unpicked, the line says who reviews it.
  expect(view.host.querySelector(".ticket-meta .ticket-meta-reviewer")?.textContent).toBe(t.plan.reviewedBy("审片员"));
  click(view.host.querySelector(".ticket-main"));
  flushSync();
  expect(view.host.querySelector(".ticket-meta-reviewer")).toBeNull();
  expect(view.host.querySelector(".ticket-reviewer-wrap")?.textContent).toContain("审片员");
  expect(view.host.querySelector(".ticket-reviewer-wrap")?.textContent).not.toContain("bot-9");
  view.close();
});

test("below level 5 a ticket waiting on you is one to mark done, not an approval; a parked ticket cannot be waited for, and a loop already there can be undone", () => {
  const review = open({ detail: aDetail({ supervision_on: true, tickets: [aTicket({ ball: { kind: "user", reason: "review" } })] }) });
  expect(review.host.querySelector(".ticket-ball")?.textContent?.trim()).toBe(t.plan.ball.acceptance as string);
  review.close();
  const staged = open({ detail: aDetail({ supervision_on: true, submissions_on: true, tickets: [aTicket({ ball: { kind: "user", reason: "review" } })] }) });
  expect(staged.host.querySelector(".ticket-ball")?.textContent?.trim()).toBe(t.plan.ball.review as string);
  staged.close();
  const view = open({ detail: aDetail({ supervision_on: true, tickets: [aTicket({ id: "t1", seq: 1, depends_on: ["t2"] }), aTicket({ id: "t2", seq: 2, depends_on: ["t1"] }), aTicket({ id: "t3", seq: 3, status: "parked" })] }) });
  const first = [...view.host.querySelectorAll(".ticket-row")][0]!;
  click(first.querySelector(".ticket-main"));
  flushSync();
  click(first.querySelector(".ticket-depends-toggle"));
  flushSync();
  const options = [...first.querySelectorAll<HTMLLabelElement>(".ticket-depends-option")];
  expect(options.map((option) => option.querySelector("input")!.disabled)).toEqual([false, true]);
  expect(options[1]!.title).toBe(t.plan.dependsParked);
  view.close();
});

test("from level 7 a ticket's model is set from the endpoints' models, or put back to the Bot's own", async () => {
  const providers = [{ id: "p-1", name: "主端点", models: ["grk", "gemini"] }, { id: "p-2", name: "备用", models: ["mimo"] }] as never;
  const view = open({ detail: aDetail({ routing_on: true, tickets: [aTicket({ model_override: { provider_id: "p-1", model: "gemini" } })] }) });
  view.props.providers = providers;
  flushSync();
  expect(view.host.querySelector(".ticket-meta .ticket-meta-model")?.textContent).toBe(t.plan.onModel("gemini"));
  click(view.host.querySelector(".ticket-main"));
  flushSync();
  const wrap = view.host.querySelector(".ticket-model-wrap");
  expect(wrap?.textContent).toContain("gemini · 主端点");
  view.close();
  const below = open({ detail: aDetail({ tickets: [aTicket()] }) });
  below.props.providers = providers;
  flushSync();
  click(below.host.querySelector(".ticket-main"));
  flushSync();
  expect(below.host.querySelector(".ticket-model-wrap")).toBeNull();
  below.close();
});

test("the picked ticket says what it meets: nothing yet on a plan with no spec, ledger or checks; its button opens the spec", () => {
  let specOpened = 0;
  const props = reactive({
    api: null,
    detail: aDetail({ tickets: [aTicket(), aTicket({ id: "ticket-2", seq: 2, title: "写结论", status: "todo" })] }),
    nodes: [],
    bots: [writer],
    youLabel: "你",
    deletedLabel: "已删除",
    t,
    selectedId: "ticket-1" as string | null,
    onSelect: () => {},
    onJump: () => {},
    onOpenArtifacts: () => {},
    onPatched: () => {},
    onConflict: () => {},
    onShowSpec: () => (specOpened += 1),
  });
  const view = render(TicketList, props as never);
  expect(view.host.querySelector(".ticket-list-hint")?.textContent).toBe(t.plan.links.ticketsHint);
  // Only the picked row says it.
  expect(view.host.querySelectorAll(".ticket-owes")).toHaveLength(1);
  const owes = rowFor(view.host, "收集资料").querySelector(".ticket-owes")!;
  expect(owes.querySelector(".ticket-owes-plan")?.textContent).toBe(t.plan.links.planWideNone);
  expect(owes.querySelector(".ticket-owes-list")).toBeNull();
  click(owes.querySelector(".ticket-owes-spec"));
  expect(specOpened).toBe(1);
  view.close();
});

test("a filter set from outside narrows even a short list, and shows the bar to undo it", () => {
  const props = reactive({
    api: null,
    detail: aDetail({ tickets: [aTicket(), aTicket({ id: "ticket-2", seq: 2, title: "写结论", status: "todo" })] }),
    nodes: [],
    bots: [writer],
    youLabel: "你",
    deletedLabel: "已删除",
    t,
    selectedId: null as string | null,
    onSelect: () => {},
    onJump: () => {},
    onOpenArtifacts: () => {},
    onPatched: () => {},
    onConflict: () => {},
    statusFilter: "all" as string,
  });
  const view = render(TicketList, props as never);
  // Two tickets: no bar of its own.
  expect(view.host.querySelector(".ticket-filters")).toBeNull();
  props.statusFilter = "todo";
  flushSync();
  expect([...view.host.querySelectorAll(".ticket-row .ticket-title")].map((title) => title.textContent)).toEqual(["写结论"]);
  click(view.host.querySelector(".ticket-filter-btn"));
  flushSync();
  expect(props.statusFilter).toBe("all");
  expect(view.host.querySelectorAll(".ticket-row")).toHaveLength(2);
  view.close();
});

test("the rest of the card picks the ticket as its title does, and only the picked one shows its settings", () => {
  const detail = aDetail({ supervision_on: true, submissions_on: true, reviewer_ids: ["bot-1"], tickets: [aTicket({ id: "t1", spec: "找三种方案" }), aTicket({ id: "t2", seq: 2, title: "写结论" })] });
  const view = open({ detail });
  expect(view.host.querySelector(".ticket-settings")).toBeNull();
  click(rowFor(view.host, "写结论").querySelector(".ticket-body"));
  flushSync();
  expect(view.selected).toEqual(["t2"]);
  expect(view.host.querySelectorAll(".ticket-settings")).toHaveLength(1);
  expect(rowFor(view.host, "写结论").querySelector(".ticket-settings")).not.toBeNull();
  expect([...rowFor(view.host, "写结论").querySelectorAll(".ticket-setting-label")].map((label) => label.textContent)).toEqual([t.plan.reviewer, t.plan.editDepends]);
  view.close();
});

test("an approved ticket says who made it, a dropped one is nobody's, and neither waits on anything", () => {
  // 2026-10-03: an approved poster read 「已通过 · 设计师在做 · 要等 #02 先完成」 once the slogans it
  // depended on were handed in again, and a dropped ticket read 「搁置 · 设计师在做」: it is nobody's.
  const detail = aDetail({
    supervision_on: true,
    tickets: [
      aTicket({ id: "t1", seq: 1, title: "做一张海报", status: "parked", worker: "bot-1" }),
      aTicket({ id: "t2", seq: 2, title: "三句宣传语", status: "review", worker: "bot-1" }),
      aTicket({ id: "t3", seq: 3, title: "竖版海报", status: "done", worker: "bot-1", depends_on: ["t2"] }),
    ],
  });
  const view = open({ detail });
  const who = [...view.host.querySelectorAll(".ticket-row")].map((row) => row.querySelector(".ticket-who-text")?.textContent?.trim() ?? null);
  expect(who).toEqual([null, t.plan.worker("制片", true), t.plan.workerDone("制片")]);
  expect(rowFor(view.host, "竖版海报").querySelector(".ticket-depends")).toBeNull();
  view.close();
});

test("a large job's sample carries its tag, and a ticket waiting for it says it waits for your approval of it (ADR 0060)", () => {
  const view = open({
    detail: aDetail({
      supervision_on: true,
      tickets: [
        aTicket({ id: "t1", seq: 1, title: "设定集", status: "done", stage: "approved" }),
        aTicket({ id: "t2", seq: 2, title: "第一场", sample: true, depends_on: ["t1"], ball: { kind: "owner", bot_id: "bot-1" } }),
        aTicket({ id: "t3", seq: 3, title: "第二场", status: "todo", sample: false, depends_on: ["t2"], ball: { kind: "app", reason: "waits", waits_for: "t2" } }),
        aTicket({ id: "t4", seq: 4, title: "配乐", status: "todo", depends_on: ["t1"], ball: { kind: "app", reason: "waits", waits_for: "t1" } }),
      ],
    }),
  });
  expect(rowFor(view.host, "第一场").querySelector(".ticket-sample")?.textContent).toBe(t.plan.sample);
  expect(rowFor(view.host, "第二场").querySelector(".ticket-sample")).toBeNull();
  expect(rowFor(view.host, "第二场").querySelector(".ticket-ball")?.textContent).toBe("等样片 #02 你放行");
  expect(rowFor(view.host, "配乐").querySelector(".ticket-ball")?.textContent).toBe("等 #01 先交");
  view.close();
});
