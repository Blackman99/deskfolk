import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { Bot, TaskDetail, TaskTraceNode, Ticket, TicketWithArtifacts } from "@real-bot/protocol";
import TicketList from "./TicketList.svelte";
import { copyFor } from "../copy.ts";
import { aBot } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";

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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
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
  expect(rows[0]?.querySelector(".ticket-status")?.textContent).toBe(t.plan.ticketStatus.doing);
  expect(rows[1]?.querySelector(".ticket-status")?.textContent).toBe(t.plan.ticketStatus.review);
  expect(rows[0]?.querySelector(".ticket-who-text")?.textContent).toBe(t.plan.worker("制片"));
  expect(rows[1]?.querySelector(".ticket-who-text")?.textContent).toBe(t.plan.nobody);
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
