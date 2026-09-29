/**
 * The organizer (整理跳): one tool-less short completion that keeps a session's plan and tickets
 * in order. It runs after the user speaks and before any turn opens — deciding whether the line
 * continues the current plan, starts another, goes back to an earlier one or is about a job the
 * Bots here are doing in another session, and which ticket it is about — and again once a plan's
 * turns have all ended, to file what was handed over.
 *
 * The prompt and the payload live here; the engine-side orchestration is in `organizer.ts`.
 */
import { USER_MEMBER, type AcceptanceCheckKind, type Message, type TicketStatus } from "@real-bot/protocol";
import { describeCheck } from "../acceptance-eval";
import { sessionLabel } from "../context";
import { extractJsonObject } from "../route-agent";
import {
  CHECK_KINDS,
  CHECKS_MAX,
  isTicketStatus,
  normalizePlanSpec,
  parsePlanSpec,
  type OrganizerCheckInput,
  type OrganizerResult,
  type OrganizerTicketInput,
  type PlanSpec,
  type PlanStatus,
  type Store,
  type Task,
} from "../store";
import { takeCodePoints } from "../text";

export const ORGANIZER_SYSTEM = `你在替这个会话整理「规划」和「任务」，不是回答用户，也不能发言。没有工具，不能读工作区。

规划是一个会话里正在推进的一件事，有要点：kind（类别，用来找先例）、goal（现在到底要做什么）、acceptance（怎么算完成）、rules（用户定过的口径、约束、改善意见）、process（这件事定下来的做法、谁负责哪段）、progress（done / open / blocked）、status（active / done / parked）。任务是规划下能独立交付的一块：title、spec（要做什么、怎么算完成）、status（todo / doing / review / done / parked）、worker（谁负责，写 Bot 名字：建任务时按分工先填，之后按 trace 里实际在做的人改；没人就 null）。

根据用户消息这份 JSON 决定。mode 是 message（用户刚发了一句，message 就是那句）或 settle（这件事的轮都结束了，只更新要点和任务，decision 必须是 continue）。current_plan 是这个会话当前的规划及其任务（可能为 null）；current_plan.checks 是这个规划当前的验收检查——应用自己在本机跑出来的证据，每条有 id、item（对应哪条 acceptance）、kind、what（人话描述）、source（organizer 还是 user）、ticket（任务序号或 null）、last（上一次运行：outcome、detail、at、output，或 null 表示还没跑过）；recent_plans 是这个会话之前推进过的规划，只有 resume 会用到；elsewhere_plans 是这个会话里的 Bot 正在别的会话推进的事（home 是它开在哪，working 是此刻谁在哪做它，said_here 是这个会话里之前归到它的几句），只有 join 会用到；kinds 是已有的类别标签，能对上就原样用，对不上才起一个短的；since_last_revision 是上一版要点之后发生的事：messages（谁说了什么）、artifacts（谁交出了什么文件，归在哪个任务）、trace（谁做了什么、停在哪）、commands（这些轮真正跑过的命令和工具，带退出码和实际跑的目录 cwd）；current_plan.tickets[].files 是落在各任务目录里、被消息引用过的文件；precedents 是同类做完的规划的要点。

只输出一个 JSON 对象，不要 markdown 围栏，不要前言后语，不要 tool-call：
{"decision": "continue" | "new" | "resume" | "join", "resume_plan_id": "…或 null", "join_plan_id": "…或 null", "plan": {"kind": "…", "goal": "…", "acceptance": ["…"], "rules": ["…"], "process": ["…"], "progress": {"done": ["…"], "open": ["…"], "blocked": ["…"]}, "status": "active"}, "tickets": [{"id": "已有任务的 id 或 new-1、new-2…", "title": "…", "spec": "…", "status": "todo", "worker": "Bot 名字或 null"}], "message_ticket": "这条消息在说哪个任务的 id 或 new-N，或 null", "checks": [{"id": "已有检查的 id 或 new-1、new-2…", "remove": true, "item": "对应哪条 acceptance", "ticket": "任务 id、new-N 或 null", "kind": "exists" | "contains" | "matches" | "command", "path": "…", "pattern": "…", "negate": false, "command": "…", "cwd": "…", "expect_exit": 0, "expect_stdout": "…", "timeout_sec": 120}]}

策略：
- decision：同一件事的后续、追问、改要求、问进度，都是 continue；明显换了一件不相干的事才 new；用户说回到之前那件、且 recent_plans 里有对得上的，才 resume 并给 resume_plan_id；这句明显在说 elsewhere_plans 里的某件事（说到它的内容、产物、进展、做法，或接着 said_here 往下说），而不是 current_plan，才 join 并给 join_plan_id。current_plan 为 null 时只能 new 或 join。拿不准就 continue。
- plan：在你选中的那个规划的 spec 上改（continue 是 current_plan，join 是 elsewhere_plans 里那件），不要重写没变的部分。用户的改善意见、口径、约束进 rules；目标变了改 goal；怎么算完成进 acceptance；定下来的做法和分工进 process；progress 按 artifacts、commands 和 trace 更新。status 只在这件事明确做完时 done，明确搁置时 parked。
- acceptance 写用户自己能检查的结果，不写「产出某某文档」「给出结论」这种谁写一份就算的话。要做出能用的东西（软件、网站、脚本、工具）时，必须有一条：「有启动方式（一条命令或一个文件），照着能在本机跑起来并走通主流程」。
- tickets：把要交付的东西拆成任务，一个任务是能独立交出的一块，不要把一句话拆成好几个，也不要每条消息都新建。几个人各做一部分、合起来才是一个能用的东西时，另开一个「联调并给出启动方式」的任务，并在 rules 里写明最终交付放在哪个目录。已有任务用它的 id 引用（join 时是那件事的任务），只写 id 和变了的字段，例如 {"id": "…", "status": "review"}；没变的任务不用列，不列的不动。新任务用 new-1、new-2，要写 title。不能删任务，只能改成 done 或 parked。
- 依据：Bot 说「已完成」「测试通过」「验收通过」不算依据。任务标 review 要有这个任务交出的文件；标 done 要有文件，而且说跑过、测过的要在 commands 里找得到（退出码 0）。只有文档、报告、没有能跑的东西，不能把「做出能用的东西」的任务标 done。有人交出了属于某任务的文件，至少标 review，并写上 worker。
- checks（可选，缺省当空数组）：current_plan.checks 是应用自己跑出来的证据，比 Bot 自称「测试通过」「验收通过」更可信，也比 commands 里的命令记录更可信。只要有一条 checks 是 fail，这个规划就不能标 done，它对应的那个任务也不能标 done（已经是 done 的这次改回 doing）；blocked 或 error 既不算通过也不算失败，算卡住，写进 progress.blocked，不要据此判定完成或失败。只在确定的情况下才提议新检查（id 写 new-1、new-2…），一条 acceptance 最多配 0～2 条：exists/contains/matches 的 path 要能在 files、artifacts 或规则里找到出处；command 必须原样抄自 since_last_revision.commands 里退出码是 0 的那条，连 cwd 一起抄，不能凭空编；也可以是用户自己在消息里写下的命令或文件路径。只能新增，或者按 id 改动、删除 source 是 organizer 的检查（remove: true 是删除，其余字段不写就是不变）；source 是 user 的检查不要碰，也不要用同样的定义再开一条新的。这次答案如果新增或改了 checks，这次就不要把规划或它对应的任务标成 done——等它跑出结果再决定。改写了某条 acceptance 的措辞、而这条正好挂着检查，把这条检查的 item 也一起改成新措辞。
- plan.status 标 done 时，每个任务也要在这次答案里标成 done 或 parked；还有待做或进行中的任务，这件事就没做完。
- message_ticket：mode 是 message 时，这条消息在说哪个任务；一句泛泛的话或问进度就 null。settle 时 null。
- 一切都写短：goal 一句话，列表每条一句。`;

export const ORGANIZER_MESSAGES_LIMIT = 30;
export const ORGANIZER_BODY_LIMIT = 600;
export const ORGANIZER_TICKETS_LIMIT = 40;
export const ORGANIZER_ARTIFACTS_LIMIT = 30;
export const ORGANIZER_TRACE_LIMIT = 12;
export const ORGANIZER_RECENT_PLANS = 8;
/** Runs since the last version the organizer sees: enough to tell a test run from a claim. */
export const ORGANIZER_RUNS_LIMIT = 40;
/** Files listed under each ticket, newest cited first. */
export const ORGANIZER_TICKET_FILES = 8;
const RUN_COMMAND_PREVIEW = 160;
export const ORGANIZER_KINDS_LIMIT = 50;
const TICKET_SPEC_PREVIEW = 300;
/** Code points of a check's last run's output the payload keeps — a failure's tail, not its head. */
const ORGANIZER_CHECK_OUTPUT_PREVIEW = 300;
/** Entries a `checks` answer may hold; matches the store's own cap on active checks per plan. */
const ORGANIZER_CHECKS_PAYLOAD_MAX = CHECKS_MAX;

/** The last `limit` code points, marked when something was cut — a run's tail explains a failure, not its head. */
function tailCodePoints(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `…${chars.slice(-(limit - 1)).join("")}` : text;
}

export type OrganizerPayload = {
  mode: "message" | "settle";
  session: { id: string; kind: "direct" | "group"; name: string | null; members: string[] };
  message: { id: string; author: string; body: string; attachments: string[]; truncated?: true } | null;
  current_plan: {
    id: string;
    kind: string | null;
    status: PlanStatus;
    brief: string | null;
    revision: number;
    spec: PlanSpec | null;
    tickets: Array<{
      id: string;
      seq: number;
      title: string;
      status: TicketStatus;
      worker: string | null;
      spec: string;
      artifacts: number;
      /** Cited files filed under it or sitting in its folder, newest first. */
      files: string[];
    }>;
    /** This plan's active acceptance checks — the app's own evidence, ahead of a Bot's own say-so. */
    checks: Array<{
      id: string;
      item: string;
      kind: AcceptanceCheckKind;
      /** One line describing what it verifies, e.g. "文件存在：report.md". */
      what: string;
      source: "organizer" | "user";
      ticket: number | null;
      /** Its most recent finished run; null when it has never run. */
      last: { outcome: "pass" | "fail" | "blocked" | "error"; detail: string; at: string; output: string | null } | null;
    }>;
  } | null;
  recent_plans: Array<{ id: string; goal: string; kind: string | null; status: PlanStatus; last_activity_at: string }>;
  /** Jobs the Bots here are on in other sessions: a line here can be about one of them. Message runs only. */
  elsewhere_plans: Array<{
    id: string;
    title: string;
    /** Where it was opened; null once that session is gone. */
    home: string | null;
    /** Who is working on it right now, and where. */
    working: string[];
    status: PlanStatus;
    brief: string | null;
    spec: PlanSpec | null;
    tickets: Array<{ id: string; seq: number; title: string; status: TicketStatus; worker: string | null }>;
    /** The last lines in this session filed under it, oldest first. */
    said_here: Array<{ author: string; body: string }>;
  }>;
  kinds: string[];
  since_last_revision: {
    messages: Array<{ id: string; author: string; kind: string; body: string; ticket_id: string | null; created_at: string; truncated?: true }>;
    artifacts: Array<{ path: string; by: string; ticket_id: string | null; cited_at: string }>;
    trace: string[];
    /** What the plan's turns actually ran, oldest first: who, under which ticket, where, and how it exited. */
    commands: Array<{ by: string; ticket: number | null; command: string; cwd: string | null; exit_code: number | null; ok: boolean; error?: string }>;
  };
  precedents: Array<{ goal: string; process: string[]; rules: string[]; outcome: string[] }>;
};

function nameOf(store: Store, id: string): string {
  if (id === USER_MEMBER) return "user";
  try {
    return store.getBot(id).name;
  } catch {
    return id;
  }
}

function clipBody(body: string, limit: number): { text: string; truncated: boolean } {
  const clipped = takeCodePoints(body.replace(/\s+/g, " ").trim(), limit);
  return { text: clipped.text, truncated: clipped.truncated };
}

/** What the organizer reads. Everything is capped so a long plan costs a bounded call. */
export function organizerPayload(
  store: Store,
  input: { mode: "message" | "settle"; sessionId: string; message: Message | null; current: Task | null; trace?: string[] },
): OrganizerPayload {
  const session = store.getSession(input.sessionId);
  const members = store
    .presentParticipants(input.sessionId)
    .map((row) => nameOf(store, row.member))
    .filter((name) => name !== "user");
  const current = input.current;
  const since = current ? store.lastSpecRevisionAt(current.id) : "";
  const messages = current
    ? store.taskMessagesSince(current.id, since, ORGANIZER_MESSAGES_LIMIT).map((row) => {
        const body = clipBody(row.body, ORGANIZER_BODY_LIMIT);
        const item: OrganizerPayload["since_last_revision"]["messages"][number] = {
          id: row.id,
          author: nameOf(store, row.author),
          kind: row.kind,
          body: body.text,
          ticket_id: row.ticket_id,
          created_at: row.created_at,
        };
        if (body.truncated) item.truncated = true;
        return item;
      })
    : [];
  const artifacts = current
    ? store.taskArtifactsSince(current.id, since, ORGANIZER_ARTIFACTS_LIMIT).map((row) => ({
        path: row.path,
        by: nameOf(store, row.author),
        ticket_id: row.ticket_id,
        cited_at: row.cited_at,
      }))
    : [];
  const artifactCounts = new Map<string, number>();
  const ticketFiles = new Map<string, string[]>();
  const currentTickets = current ? store.listTickets(current.id) : [];
  if (current) {
    for (const row of store.taskArtifacts(current.id, () => true, 500)) {
      if (row.ticket_id) artifactCounts.set(row.ticket_id, (artifactCounts.get(row.ticket_id) ?? 0) + 1);
      // A file belongs to a ticket by the message that cited it, or by the folder it sits in: a
      // handoff can land a turn on another ticket while it writes where the work really is.
      for (const ticket of currentTickets) {
        if (row.ticket_id !== ticket.id && !row.path.startsWith(`${ticket.dir}/`)) continue;
        const files = ticketFiles.get(ticket.id) ?? [];
        if (files.length < ORGANIZER_TICKET_FILES && !files.includes(row.path)) files.push(row.path);
        ticketFiles.set(ticket.id, files);
      }
    }
  }
  const seqOf = new Map(currentTickets.map((ticket) => [ticket.id, ticket.seq]));
  const commands: OrganizerPayload["since_last_revision"]["commands"] = current
    ? store.taskRunsSince(current.id, since, ORGANIZER_RUNS_LIMIT).map((run) => {
        const item: OrganizerPayload["since_last_revision"]["commands"][number] = {
          by: nameOf(store, run.bot_id),
          ticket: run.ticket_id ? (seqOf.get(run.ticket_id) ?? null) : null,
          command: clipBody(run.command, RUN_COMMAND_PREVIEW).text,
          cwd: run.cwd,
          exit_code: run.exit_code,
          ok: run.ok === 1,
        };
        if (run.error) item.error = clipBody(run.error, 120).text;
        return item;
      })
    : [];
  const spec = current ? parsePlanSpec(current.spec) : null;
  const precedents: OrganizerPayload["precedents"] = [];
  if (spec?.kind && current) {
    for (const earlier of store.precedentTasks(spec.kind, current.id, 3)) {
      const done = parsePlanSpec(earlier.spec);
      if (done) precedents.push({ goal: done.goal, process: done.process, rules: done.rules, outcome: done.progress.done });
    }
  }
  // A line here can be about a job the Bots here are doing somewhere else; a settle files one plan's own work.
  const elsewhere = input.mode === "message" ? store.elsewherePlans(input.sessionId) : [];
  let message: OrganizerPayload["message"] = null;
  if (input.message) {
    const body = clipBody(input.message.body, ORGANIZER_BODY_LIMIT * 2);
    message = {
      id: input.message.id,
      author: nameOf(store, input.message.author),
      body: body.text,
      attachments: input.message.attachments.map((att) => att.workspace_relpath),
    };
    if (body.truncated) message.truncated = true;
  }
  return {
    mode: input.mode,
    session: { id: session.id, kind: session.kind, name: session.name, members },
    message,
    current_plan: current
      ? {
          id: current.id,
          kind: current.kind,
          status: current.status,
          brief: current.brief ? clipBody(current.brief, ORGANIZER_BODY_LIMIT).text : null,
          revision: store.currentRevision(current.id),
          spec,
          tickets: currentTickets
            .slice(0, ORGANIZER_TICKETS_LIMIT)
            .map((ticket) => ({
              id: ticket.id,
              seq: ticket.seq,
              title: ticket.title,
              status: ticket.status,
              worker: ticket.worker ? nameOf(store, ticket.worker) : null,
              spec: clipBody(ticket.spec, TICKET_SPEC_PREVIEW).text,
              artifacts: artifactCounts.get(ticket.id) ?? 0,
              files: ticketFiles.get(ticket.id) ?? [],
            })),
          checks: store.listChecks(current.id)
            .slice(0, CHECKS_MAX)
            .map((check) => ({
              id: check.id,
              item: check.item,
              kind: check.kind,
              what: describeCheck(check, "zh"),
              source: check.source,
              ticket: check.ticket_id ? (seqOf.get(check.ticket_id) ?? null) : null,
              last: check.last_run
                ? {
                    outcome: check.last_run.outcome ?? "error",
                    detail: check.last_run.detail,
                    at: check.last_run.finished_at ?? check.last_run.started_at,
                    output: check.last_run.output ? tailCodePoints(check.last_run.output, ORGANIZER_CHECK_OUTPUT_PREVIEW) : null,
                  }
                : null,
            })),
        }
      : null,
    recent_plans: store
      .sessionRecentTasks(input.sessionId, ORGANIZER_RECENT_PLANS)
      .filter((task) => !elsewhere.some((plan) => plan.id === task.id))
      .map((task) => {
        const earlier = parsePlanSpec(task.spec);
        return {
          id: task.id,
          goal: earlier?.goal ?? (task.brief ? clipBody(task.brief, 200).text : task.title),
          kind: task.kind,
          status: task.status,
          last_activity_at: store.taskLastActivityAt(task.id),
        };
      }),
    elsewhere_plans: elsewhere.map((plan) => elsewherePlan(store, input.sessionId, plan)),
    kinds: store.distinctTaskKinds(ORGANIZER_KINDS_LIMIT),
    since_last_revision: { messages, artifacts, trace: (input.trace ?? []).slice(-ORGANIZER_TRACE_LIMIT), commands },
    precedents,
  };
}

/** Lines of this session already filed under a plan elsewhere that the organizer reads. */
export const ORGANIZER_SAID_HERE = 3;

/**
 * A job the Bots here are on elsewhere, whole enough to be revised: a line filed there rewrites its
 * spec the way a continue rewrites the current plan's, so the organizer needs the spec it builds on.
 */
function elsewherePlan(store: Store, sessionId: string, plan: Task): OrganizerPayload["elsewhere_plans"][number] {
  const locale = store.settingsCached().locale;
  const working = store
    .listLiveTurns()
    .filter((turn) => turn.task_id === plan.id)
    .map((turn) => `${nameOf(store, turn.bot_id)}（${sessionLabel(store, turn.session_id, null, locale) ?? "?"}）`);
  const said_here = store
    .listMainMessages(sessionId, 40)
    .filter((row) => row.task_id === plan.id)
    .slice(0, ORGANIZER_SAID_HERE)
    .reverse()
    .map((row) => ({ author: nameOf(store, row.author), body: clipBody(row.body, 200).text }));
  return {
    id: plan.id,
    title: plan.title,
    home: plan.session_id ? sessionLabel(store, plan.session_id, null, locale) : null,
    working: [...new Set(working)],
    status: plan.status,
    brief: plan.brief ? clipBody(plan.brief, ORGANIZER_BODY_LIMIT).text : null,
    spec: parsePlanSpec(plan.spec),
    tickets: store
      .listTickets(plan.id)
      .slice(0, ORGANIZER_TICKETS_LIMIT)
      .map((ticket) => ({
        id: ticket.id,
        seq: ticket.seq,
        title: ticket.title,
        status: ticket.status,
        worker: ticket.worker ? nameOf(store, ticket.worker) : null,
      })),
    said_here,
  };
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NEW_TICKET = /^new-\d+$/;

/**
 * The optional top-level `checks` array of an organizer answer: proposed, edited or removed
 * acceptance checks. Pure and lossy on purpose — malformed entries are dropped, not fixed up.
 * `existing` is this plan's own check ids as the payload showed them; an id the model was never
 * shown (hallucinated, or another plan's) is dropped here, the same way an unlisted ticket id is.
 * Everything else the store's own rules cover: only an `organizer` check may be touched by id, a
 * command needs evidence in this plan (`commandSeenInPlan`), and the caps on how many are active
 * and how many a single run may add.
 */
export function parseOrganizerChecks(raw: unknown, existing: ReadonlySet<string>): OrganizerCheckInput[] {
  if (!Array.isArray(raw)) return [];
  const out: OrganizerCheckInput[] = [];
  for (const entry of raw) {
    if (out.length >= ORGANIZER_CHECKS_PAYLOAD_MAX) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const opening = NEW_TICKET.test(id);
    if (!opening && !(ULID.test(id) && existing.has(id))) continue;
    if (row.remove === true) {
      if (!opening) out.push({ id, remove: true });
      continue;
    }
    const check: OrganizerCheckInput = { id };
    if (typeof row.item === "string") check.item = row.item.replace(/\s+/g, " ").trim();
    if (typeof row.kind === "string" && (CHECK_KINDS as readonly string[]).includes(row.kind)) {
      check.kind = row.kind as AcceptanceCheckKind;
    }
    if (typeof row.path === "string") check.path = row.path;
    if (typeof row.pattern === "string") check.pattern = row.pattern;
    if (typeof row.negate === "boolean") check.negate = row.negate;
    if (typeof row.command === "string") check.command = row.command;
    if (typeof row.cwd === "string") check.cwd = row.cwd;
    if (typeof row.expect_exit === "number" && Number.isFinite(row.expect_exit)) check.expect_exit = row.expect_exit;
    if (typeof row.expect_stdout === "string") check.expect_stdout = row.expect_stdout;
    if (typeof row.timeout_sec === "number" && Number.isFinite(row.timeout_sec)) check.timeout_sec = row.timeout_sec;
    if (row.ticket === null) check.ticket = null;
    else if (typeof row.ticket === "string") check.ticket = row.ticket.trim();
    out.push(check);
  }
  return out;
}

/**
 * The organizer's answer, checked field by field. Null means "not usable": the engine then leaves
 * the plan as it was. Never throws.
 */
export function parseOrganizerResult(
  raw: string,
  ctx: {
    mode: "message" | "settle";
    recentPlanIds: ReadonlySet<string>;
    /** Plans the Bots here are on elsewhere; a join names one of them. */
    elsewherePlanIds?: ReadonlySet<string>;
    roster: ReadonlyArray<{ id: string; name: string }>;
    /** This plan's own check ids, as shown in the payload; a `checks` entry naming any other id is dropped. */
    existingCheckIds?: ReadonlySet<string>;
  },
): OrganizerResult | null {
  const parsed = extractJsonObject(raw);
  if (!parsed) return null;
  const spec = normalizePlanSpec(parsed.plan);
  if (!spec) return null;
  let decision: OrganizerResult["decision"] = "continue";
  let resumePlanId: string | null = null;
  let joinPlanId: string | null = null;
  const decisionRaw = typeof parsed.decision === "string" ? parsed.decision.trim().toLowerCase() : "";
  if (ctx.mode === "message") {
    if (decisionRaw === "new") decision = "new";
    else if (decisionRaw === "resume") {
      const id = typeof parsed.resume_plan_id === "string" ? parsed.resume_plan_id.trim() : "";
      if (ctx.recentPlanIds.has(id)) {
        decision = "resume";
        resumePlanId = id;
      }
    } else if (decisionRaw === "join") {
      const id = typeof parsed.join_plan_id === "string" ? parsed.join_plan_id.trim() : "";
      if (ctx.elsewherePlanIds?.has(id)) {
        decision = "join";
        joinPlanId = id;
      }
    }
  }
  const byName = new Map(ctx.roster.map((bot) => [bot.name.trim().toLowerCase(), bot.id]));
  const tickets: OrganizerTicketInput[] = [];
  if (Array.isArray(parsed.tickets)) {
    for (const entry of parsed.tickets) {
      if (tickets.length >= ORGANIZER_TICKETS_LIMIT) break;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      if (!ULID.test(id) && !NEW_TICKET.test(id)) continue;
      const opening = NEW_TICKET.test(id);
      const title = typeof row.title === "string" ? row.title.replace(/\s+/g, " ").trim() : "";
      // A new ticket needs a name. An existing one is referenced by id with only what changed, so
      // a missing title, status or worker there means "as it was" — not blank, todo or nobody.
      if (opening && !title) continue;
      const workerName = typeof row.worker === "string" ? row.worker.trim().toLowerCase() : "";
      const worker = workerName ? (byName.get(workerName) ?? null) : null;
      const ticket: OrganizerTicketInput = { id, spec: typeof row.spec === "string" ? row.spec.trim() : "" };
      if (title) ticket.title = title;
      if (isTicketStatus(row.status)) ticket.status = row.status;
      else if (opening) ticket.status = "todo";
      if (worker || opening) ticket.worker = worker;
      tickets.push(ticket);
    }
  }
  let messageTicket: string | null = null;
  if (ctx.mode === "message" && typeof parsed.message_ticket === "string") {
    const id = parsed.message_ticket.trim();
    if (ULID.test(id) || NEW_TICKET.test(id)) messageTicket = id;
  }
  const checks = parseOrganizerChecks(parsed.checks, ctx.existingCheckIds ?? new Set());
  return { decision, resumePlanId, joinPlanId, spec, tickets, messageTicket, checks };
}
