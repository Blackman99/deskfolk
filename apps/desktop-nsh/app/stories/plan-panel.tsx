/**
 * A job's whole plan view (`PlanSpecPanel`): the goal, what needs you, the contract and its
 * checks, the progress, the job's name, scale and versions. The plan is held here and served by a
 * fake client that answers as the daemon does; every call it gets is written to `panel-log`.
 * Buttons stand in for the parent (`JobInspector`): pick a ticket, drop the client, make a save
 * conflict, show an empty plan, and read back the state.
 */
import { Scroll, signal, Text, View } from "nsh";
import type { AcceptanceCheck, Bot, PlanSpec, TaskDetail, TaskSpecRevision, TicketWithArtifacts } from "@real-bot/protocol";
import type { MessengerApi } from "../src/m/messenger-api.ts";
import { Button } from "../src/ui/Button";
import { PlanSpecPanel } from "../src/ui/overlays/PlanSpecPanel";

const AT = "2026-10-06T04:08:55.000Z";
const BOTS = [{ id: "bot-writer", name: "Writer" }] as Bot[];

function ticket(seq: number, title: string, status: TicketWithArtifacts["status"]): TicketWithArtifacts {
  return {
    id: `tk-${seq}`,
    task_id: "task-1",
    seq,
    title,
    slug: `t${seq}`,
    dir: `tickets/${seq}`,
    spec: "",
    status,
    worker: null,
    owner_bot_id: "bot-writer",
    depends_on: [],
    created_at: AT,
    updated_at: AT,
    closed_at: null,
    artifacts: [],
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

const run = (id: string, outcome: "pass" | "fail", detail: string) =>
  ({ id: `r-${id}`, check_id: id, task_id: "task-1", cause: "settle", started_at: AT, finished_at: AT, outcome, exit_code: outcome === "pass" ? 0 : 1, detail, output: null }) as AcceptanceCheck["last_run"];

const SPEC: PlanSpec = {
  kind: "写作",
  goal: "写出本周周报",
  acceptance: ["有对比表", "有结论"],
  rules: ["数字回读一遍"],
  process: [],
  progress: { done: ["收集数据"], open: ["写正文"], blocked: ["等财务给口径"] },
  status: "active",
};

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
    ticket_counts: { todo: 0, doing: 1, review: 0, done: 1, parked: 0 },
    brief: null,
    spec: SPEC,
    spec_updated_at: AT,
    revision: 3,
    revision_actor: "app",
    routine_id: null,
    submissions_on: true,
    supervision_on: true,
    tickets: [ticket(1, "收集数据", "done"), ticket(2, "写正文", "doing")],
    checks: [
      check("c-pass", { last_run: run("c-pass", "pass", "文件在") }),
      check("c-fail", { item: "有结论", ticket_id: "tk-2", last_run: run("c-fail", "fail", "退出码 1") }),
    ],
    requirements: [
      {
        id: "offer",
        seq: 40,
        quote: "改成 3 分钟",
        restated: null,
        category: null,
        polarity: "must",
        dimension: null,
        value: null,
        status: "proposed",
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
      },
    ],
    retrospectives: [],
  } as unknown as TaskDetail;
}

export default function PlanPanel() {
  const detail = signal<TaskDetail>(startDetail());
  const log = signal<string[]>([]);
  const selected = signal<string | null>(null);
  const noApi = signal(false);
  const conflict = signal(false);
  const said = (line: string) => log.set([...log(), line]);
  const replace = (next: TaskDetail) => {
    detail.set(next);
    return next;
  };

  const api = {
    async renamePlan(_id: string, body: { title: string }) {
      said(`rename:${body.title}`);
      return replace({ ...detail(), title: body.title.trim() });
    },
    async setPlanScale(_id: string, body: { scale: "large" | "single" }) {
      said(`scale:${body.scale}`);
      return replace({ ...detail(), scale: { value: body.scale, by: "user", at: AT, why: null, unit: body.scale === "large" ? "章" : null } });
    },
    async patchTaskSpec(_id: string, body: { spec: PlanSpec; if_revision: number }) {
      said(`patchSpec:rev${body.if_revision}:goal=${body.spec.goal}:acc=${body.spec.acceptance.join("|")}:blocked=${body.spec.progress.blocked.join("|")}`);
      if (conflict()) throw Object.assign(new Error("conflict"), { status: 409 });
      return replace({ ...detail(), spec: body.spec, revision: detail().revision + 1, revision_actor: "user" });
    },
    async taskSpecRevisions(_id: string) {
      said("history");
      return [
        { id: "rev-3", task_id: "task-1", revision: 3, actor: "app", spec: SPEC, tickets_snapshot: [], source_message_id: "m9", source_turn_id: null, session_id: "group-1", created_at: AT },
        { id: "rev-2", task_id: "task-1", revision: 2, actor: "user", spec: { ...SPEC, goal: "写周报" }, tickets_snapshot: [], source_message_id: null, source_turn_id: null, session_id: null, created_at: AT, cause: "hold" },
      ] as TaskSpecRevision[];
    },
    async runChecks(_id: string) {
      said("runChecks");
      return replace({ ...detail(), checks: (detail().checks ?? []).map((c) => ({ ...c, last_run: run(c.id, "pass", "这次通过了") })) });
    },
    async requirementAction(id: string, body: { action: string }) {
      said(`requirement:${id}:${body.action}`);
      return replace({ ...detail(), requirements: (detail().requirements ?? []).map((r) => (r.id === id ? { ...r, status: "open" as const } : r)) });
    },
  } as unknown as MessengerApi;

  const read = () =>
    `read:title=${detail().title};goal=${detail().spec?.goal ?? ""};rev=${detail().revision};scale=${detail().scale?.value ?? ""};selected=${selected() ?? ""}`;
  const shown = signal("");

  return (
    <Scroll class="flex-1 bg-bg">
      <View class="flex-row flex-wrap gap-2 p-3">
        <Button testID="story-select" size="sm" onPress={() => selected.set(selected() ? null : "tk-2")}>选中票</Button>
        <Button testID="story-no-api" size="sm" onPress={() => noApi.set(!noApi())}>只读</Button>
        <Button testID="story-conflict" size="sm" onPress={() => conflict.set(true)}>制造冲突</Button>
        <Button testID="story-empty" size="sm" onPress={() => replace({ ...detail(), spec: null, revision: 0, brief: "每周写一份周报" })}>空计划</Button>
        <Button testID="story-scale-single" size="sm" onPress={() => replace({ ...detail(), scale: { value: "single", by: "user", at: AT, why: null, unit: null } })}>单件</Button>
        <Button testID="story-read" size="sm" onPress={() => shown.set(read())}>读回</Button>
        <Text testID="story-state" class="text-[11px] text-ink-muted">{shown()}</Text>
        <Text testID="panel-log" class="text-[11px] text-ink-muted">{log().join("\n") || "—"}</Text>
      </View>
      <PlanSpecPanel
        api={noApi() ? null : api}
        detail={detail()}
        onSaved={replace}
        onConflict={() => said("conflict")}
        onJump={(session, message) => said(`jump:${session}:${message}`)}
        selectedTicket={selected()}
        onShowTicket={(id) => said(`ticket:${id}`)}
        onClearTicket={() => selected.set(null)}
        onShowTickets={(status) => said(`tickets:${status}`)}
        bots={BOTS}
        deletedLabel="已删除"
        onScrollToProposed={(target) => {
          void target.measure().then((box) => said(`scrollToProposed:${box ? "measured" : "gone"}`));
        }}
      />
    </Scroll>
  );
}
