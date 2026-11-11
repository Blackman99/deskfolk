/**
 * A job's plan view, in its parts: the overview, the acceptance checks (a pill each, a form to add
 * one), what you asked of it, its retrospective, who does what, its engine, and a ticket's
 * dependencies and hand-over confirmation. The data are protocol objects held here and served by a
 * fake client that answers as the daemon does (the daemon makes jobs only through a Bot's turn),
 * and every call it gets is written to `plan-log`.
 */
import { Scroll, signal, Text, View } from "nsh";
import type {
  AcceptanceCheck,
  AcceptanceCheckInput,
  Bot,
  PlanRequirement,
  RequirementActionRequest,
  Retrospective,
  TaskDetail,
  TicketStatus,
  TicketWithArtifacts,
} from "@real-bot/protocol";
import type { MessengerApi } from "../src/m/messenger-api.ts";
import type { TicketEdits } from "../src/m/overlays/ticket-edits.svelte.ts";
import type { DivisionRow } from "../src/m/overlays/ticket-lanes.ts";
import { copy } from "../src/runtime";
import { Button } from "../src/ui/Button";
import { AcceptanceCheckForm } from "../src/ui/overlays/AcceptanceCheckForm";
import { AcceptanceCheckRow } from "../src/ui/overlays/AcceptanceCheckRow";
import { JobDivision } from "../src/ui/overlays/JobDivision";
import { JobEngine } from "../src/ui/overlays/JobEngine";
import { PlanRequirements } from "../src/ui/overlays/PlanRequirements";
import { PlanRetrospectives } from "../src/ui/overlays/PlanRetrospectives";
import { PlanSpecOverview } from "../src/ui/overlays/PlanSpecOverview";
import { TicketConfirm } from "../src/ui/overlays/TicketConfirm";
import { TicketDepends } from "../src/ui/overlays/TicketDepends";

const AT = "2026-10-06T04:08:55.000Z";

const BOTS = [
  { id: "bot-writer", name: "Writer" },
  { id: "bot-editor", name: "Editor" },
] as Bot[];

function ticket(seq: number, title: string, over: Partial<TicketWithArtifacts> = {}): TicketWithArtifacts {
  return {
    id: `tk-${seq}`,
    task_id: "task-1",
    seq,
    title,
    slug: `t${seq}`,
    dir: `tickets/${seq}`,
    spec: "",
    status: "todo",
    worker: null,
    owner_bot_id: "bot-writer",
    depends_on: [],
    created_at: AT,
    updated_at: AT,
    closed_at: null,
    artifacts: [],
    ...over,
  };
}

function check(id: string, over: Partial<AcceptanceCheck> = {}): AcceptanceCheck {
  return {
    id,
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
    created_at: AT,
    updated_at: AT,
    defined_at: AT,
    first_passed_at: null,
    last_run: null,
    running: false,
    ...over,
  };
}

function requirement(id: string, seq: number, quote: string, over: Partial<PlanRequirement> = {}): PlanRequirement {
  return {
    id,
    seq,
    quote,
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
    last_raised_at: AT,
    source_kind: "message",
    source: { via: "message", session_id: "group-1", message_id: "m1", at: AT },
    added_by: "scribe",
    inherited_from: null,
    excluded: false,
    supersedes: null,
    ...over,
  };
}

const RETROSPECTIVE: Retrospective = {
  id: "retro-1",
  task_id: "task-1",
  bot_id: "bot-writer",
  delivered_at: AT,
  state: "done",
  model: "model",
  summary: "周报先定口径再动笔",
  pitfalls: ["默认按月汇总了"],
  rework_causes: ["开工前没确认口径"],
  keep: ["交付前回读一遍数字"],
  earlier: [{ conclusion: "全盘 grep 会超时", verdict: "recurred" }],
  changes: [
    { kind: "memory", op: "remember", label: "周报口径", target_id: "m1", before: null, after: { subject: "周报口径", body: "按周汇总。" }, why: "第一版被退回", status: "applied" },
    {
      kind: "skill",
      op: "edit",
      label: "写周报",
      target_id: "s1",
      why: "",
      before: { name: "写周报", description: "写周报", body: "1. 收集\n2. 成文。" },
      after: { name: "写周报", description: "写周报", body: "1. 收集\n2. 成文。先确认口径。" },
      status: "applied",
    },
    { kind: "memory", op: "remember", label: "太长的", target_id: null, before: null, after: null, why: "", status: "not_applied", reason: "too_long:body" },
  ],
  note: null,
  created_at: AT,
  finished_at: AT,
};

const DIVISION: DivisionRow[] = [
  { bot: "bot-writer", owns: [1, 2], reviews: [3], turns: 5, onOthers: 1, loose: 1 },
  { bot: "bot-editor", owns: [3], reviews: [], turns: 0, onOthers: 0, loose: 0 },
  { bot: "bot-gone", owns: [], reviews: [], turns: 2, onOthers: 0, loose: 0 },
];

function startDetail(): TaskDetail {
  return {
    id: "task-1",
    dir: "work/weekly-abcd",
    title: "周报",
    session_id: "group-1",
    closed_at: null,
    last_activity_at: AT,
    goal: "写出本周周报",
    kind: "写作",
    status: "active",
    ticket_counts: { todo: 0, doing: 1, review: 1, done: 1, parked: 1 },
    brief: null,
    spec: {
      kind: "写作",
      goal: "写出本周周报",
      acceptance: ["有对比表", "有结论"],
      rules: [],
      process: [],
      progress: { done: [], open: [], blocked: [] },
      status: "active",
    },
    spec_updated_at: AT,
    revision: 3,
    revision_actor: "app",
    routine_id: null,
    submissions_on: true,
    supervision_on: true,
    tickets: [
      ticket(1, "收集数据", { status: "done" }),
      ticket(2, "写正文", { status: "doing", depends_on: ["tk-3"], owner_bot_id: "bot-editor" }),
      ticket(3, "终稿审阅", { status: "review", stage: "submitted", depends_on: ["tk-1"] }),
      ticket(4, "排版", { status: "parked" }),
    ],
    checks: [
      check("c-pass", { last_run: { id: "r1", check_id: "c-pass", task_id: "task-1", cause: "settle", started_at: AT, finished_at: AT, outcome: "pass", exit_code: 0, detail: "文件在", output: null } }),
      check("c-fail", {
        item: "有结论",
        kind: "command",
        path: null,
        command: "make check",
        expect_exit: 0,
        last_run: { id: "r2", check_id: "c-fail", task_id: "task-1", cause: "settle", started_at: AT, finished_at: AT, outcome: "fail", exit_code: 1, detail: "退出码 1", output: "line one\nline two" },
      }),
      check("c-offer", { item: "有结论", origin: "derived", derived_state: "proposed", bind_kind: "glob" } as Partial<AcceptanceCheck>),
    ],
    requirements: [
      requirement("run", 9, "片长约 2 分钟", { restated: "母带约 120 秒", times_raised: 3, plans_raised: 2 }),
      requirement("cut", 10, "粗剪先给我看", { scope: "ticket", ticket_id: "tk-1" }),
      requirement("arm", 4, "口径按周", { scope: "project", inherited_from: { task_id: "ep01", title: "EP01" } }),
      requirement("offer", 40, "改成 3 分钟", { status: "proposed", supersedes: { id: "run", seq: 9, quote: "片长约 2 分钟" } }),
    ],
    retrospectives: [RETROSPECTIVE],
  };
}

export default function Plan() {
  const detail = signal<TaskDetail>(startDetail());
  const log = signal<string[]>([]);
  const adding = signal(false);
  const focus = signal<string | null>(null);
  const said = (line: string) => log.set([...log(), line]);
  const replace = (next: TaskDetail) => {
    detail.set(next);
    return next;
  };
  const checks = () => detail().checks ?? [];
  let nextCheck = 1;

  const api = {
    async createCheck(_task: string, body: AcceptanceCheckInput) {
      said(`createCheck:${body.kind}:${body.item}`);
      return replace({ ...detail(), checks: [...checks(), check(`c-new-${nextCheck++}`, { ...body } as Partial<AcceptanceCheck>)] });
    },
    async patchCheck(id: string, body: Partial<AcceptanceCheckInput>) {
      said(`patchCheck:${id}:${body.kind ?? ""}`);
      return replace({ ...detail(), checks: checks().map((c) => (c.id === id ? { ...c, ...(body as Partial<AcceptanceCheck>) } : c)) });
    },
    async confirmCheck(id: string) {
      said(`confirmCheck:${id}`);
      return replace({ ...detail(), checks: checks().map((c) => (c.id === id ? { ...c, derived_state: "active" as const } : c)) });
    },
    async deleteCheck(id: string) {
      said(`deleteCheck:${id}`);
      return replace({ ...detail(), checks: checks().filter((c) => c.id !== id) });
    },
    async runChecks(_task: string, id?: string) {
      said(`runChecks:${id ?? ""}`);
      return replace({
        ...detail(),
        checks: checks().map((c) =>
          c.id === id && c.last_run ? { ...c, last_run: { ...c.last_run, outcome: "pass" as const, detail: "这次通过了", output: null } } : c,
        ),
      });
    },
    async requirementAction(id: string, body: RequirementActionRequest) {
      said(`requirement:${id}:${body.action}`);
      if (id === "cut") throw new Error("refused");
      const next = (detail().requirements ?? []).map((r) => {
        if (r.id !== id) return r;
        if (body.action === "confirm") return { ...r, status: "open" as const };
        if (body.action === "not_here" || body.action === "waive") return { ...r, excluded: true };
        return r;
      });
      return replace({ ...detail(), requirements: next });
    },
    async undoRetrospectiveChange(id: string, index: number) {
      said(`undo:${id}:${index}`);
      const next = (detail().retrospectives ?? []).map((r) =>
        r.id === id ? { ...r, changes: r.changes.map((c, i) => (i === index ? { ...c, status: "undone" as const } : c)) } : r,
      );
      return replace({ ...detail(), retrospectives: next });
    },
    async patchTicket(id: string, body: { depends_on?: string[]; status?: string }) {
      said(`patchTicket:${id}:${body.depends_on ? `depends=${body.depends_on.join(",")}` : `status=${body.status}`}`);
      const tickets = detail().tickets.map((tk) => (tk.id === id ? { ...tk, ...(body as Partial<TicketWithArtifacts>) } : tk));
      replace({ ...detail(), tickets });
      return tickets.find((tk) => tk.id === id)!;
    },
  } as unknown as MessengerApi;

  // The mirrored `TicketEdits` builds a `derived` in its field initialisers, before its `#host` exists,
  // and NSH's `computed` runs at once: it cannot be made here yet. This answers what the two
  // components read and call (`confirming`, `errorId`, `patchingId`, `queueMove`, `keepCard`, `toggleDepends`).
  const confirming = signal<{ id: string; status: TicketStatus } | null>(null);
  const patchingId = signal<string | null>(null);
  const errorId = signal<string | null>(null);
  const edits = {
    get confirming() {
      return confirming();
    },
    get patchingId() {
      return patchingId();
    },
    get errorId() {
      return errorId();
    },
    requestStatus(tk: TicketWithArtifacts, status: TicketStatus) {
      confirming.set({ id: tk.id, status });
    },
    queueMove(id: string, status: TicketStatus) {
      confirming.set(null);
      void api.patchTicket(id, { status }).then(() => said(`moved:${id}:${status}`));
    },
    keepCard(id: string) {
      if (confirming()?.id === id) confirming.set(null);
      said(`kept:${id}`);
    },
    async toggleDepends(tk: TicketWithArtifacts, other: string) {
      const current = tk.depends_on ?? [];
      patchingId.set(tk.id);
      await (api as unknown as { patchTicket(id: string, body: object): Promise<unknown> }).patchTicket(tk.id, {
        depends_on: current.includes(other) ? current.filter((id) => id !== other) : [...current, other],
      });
      patchingId.set(null);
    },
  } as unknown as TicketEdits;
  const review = () => detail().tickets.find((tk) => tk.id === "tk-3")!;
  const states = () =>
    (["todo", "doing", "review", "done", "parked"] as const)
      .map((status) => ({ status, count: detail().tickets.filter((tk) => tk.status === status).length }))
      .filter((s) => s.count > 0);
  const passed = () => checks().filter((c) => c.last_run?.outcome === "pass").length;

  return (
    <Scroll class="flex-1 bg-bg">
      <View class="flex-row gap-4 p-6 items-start">
        <View class="flex-1 gap-4 min-w-0">
          <PlanSpecOverview ticketStates={states()} checks={{ pass: passed(), total: checks().length }} onShowTickets={(status) => focus.set(status)}>
            <Text class="text-[12px] text-ink-secondary">{detail().goal}</Text>
          </PlanSpecOverview>
          <View class="gap-2 p-3 rounded-(--radius-md) border border-line bg-pane items-start">
            <Each of={checks()} key={(c) => c.id}>
              {(c) => <AcceptanceCheckRow api={api} detail={detail()} check={c()} onSaved={replace} />}
            </Each>
            <If
              when={adding()}
              else={<Button testID="add-check" size="sm" onPress={() => adding.set(true)}>添加检查</Button>}
            >
              <AcceptanceCheckForm
                api={api}
                detail={detail()}
                editing={null}
                onSaved={(next) => {
                  adding.set(false);
                  replace(next);
                }}
                onCancel={() => adding.set(false)}
              />
            </If>
          </View>
          <PlanRequirements
            api={api}
            detail={detail()}
            onSaved={replace}
            onJump={(session, message) => said(`jump:${session}:${message}`)}
            selectedTicket={null}
            onShowTicket={(id) => said(`ticket:${id}`)}
          />
          <PlanRetrospectives api={api} detail={detail()} bots={BOTS} deletedLabel="已删除" onSaved={replace} />
        </View>
        <View class="w-[340px] gap-4">
          <JobDivision rows={DIVISION} bots={BOTS} youLabel="你" deletedLabel="已删除" />
          <JobEngine name="Claude Code" why="own" off={["复盘", "分工"]} sessions={2} onOpen={() => said("engine:open")} />
          <JobEngine name="本地模型" why="fallback" off={[]} sessions={1} stopped />
          <View class="gap-2">
            <Button testID="request-review-move" size="sm" onPress={() => edits.requestStatus(review(), "doing")}>把终稿审阅移到进行中</Button>
            <TicketConfirm ticket={review()} edits={edits} />
            <TicketDepends detail={detail()} ticket={review()} edits={edits} />
          </View>
          <Text testID="plan-log" class="text-[11px] text-ink-muted">{log().join("\n") || "—"}</Text>
          <Text testID="plan-focus" class="text-[11px] text-ink-muted">{`focus:${focus() ?? ""}`}</Text>
        </View>
      </View>
    </Scroll>
  );
}
