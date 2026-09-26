/**
 * The organizer (整理跳): one tool-less short completion that keeps a session's plan and tickets
 * in order. It runs after the user speaks and before any turn opens — deciding whether the line
 * continues the current plan, starts another or goes back to an earlier one, and which ticket it
 * is about — and again once a plan's turns have all ended, to file what was handed over.
 *
 * The prompt and the payload live here; the engine-side orchestration is in `organizer.ts`.
 */
import { USER_MEMBER, type Message, type TicketStatus } from "@real-bot/protocol";
import { extractJsonObject } from "../route-agent";
import {
  isTicketStatus,
  normalizePlanSpec,
  parsePlanSpec,
  type OrganizerResult,
  type OrganizerTicketInput,
  type PlanSpec,
  type PlanStatus,
  type Store,
  type Task,
} from "../store";
import { takeCodePoints } from "../text";

export const ORGANIZER_SYSTEM = `你在替这个会话整理「规划」和「任务」，不是回答用户，也不能发言。没有工具，不能读工作区。

规划是一个会话里正在推进的一件事，有要点：kind（类别，用来找先例）、goal（现在到底要做什么）、acceptance（怎么算完成）、rules（用户定过的口径、约束、改善意见）、process（这件事定下来的做法、谁负责哪段）、progress（done / open / blocked）、status（active / done / parked）。任务是规划下能独立交付的一块：title、spec（要做什么、怎么算完成）、status（todo / doing / review / done / parked）、worker（谁在做，写 Bot 名字，没有就 null）。

根据用户消息这份 JSON 决定。mode 是 message（用户刚发了一句，message 就是那句）或 settle（这件事的轮都结束了，只更新要点和任务，decision 必须是 continue）。current_plan 是这个会话当前的规划及其任务（可能为 null）；recent_plans 是这个会话之前推进过的规划，只有 resume 会用到；kinds 是已有的类别标签，能对上就原样用，对不上才起一个短的；since_last_revision 是上一版要点之后发生的事：messages（谁说了什么）、artifacts（谁交出了什么文件，归在哪个任务）、trace（谁做了什么、停在哪）；precedents 是同类做完的规划的要点。

只输出一个 JSON 对象，不要 markdown 围栏，不要前言后语，不要 tool-call：
{"decision": "continue" | "new" | "resume", "resume_plan_id": "…或 null", "plan": {"kind": "…", "goal": "…", "acceptance": ["…"], "rules": ["…"], "process": ["…"], "progress": {"done": ["…"], "open": ["…"], "blocked": ["…"]}, "status": "active"}, "tickets": [{"id": "已有任务的 id 或 new-1、new-2…", "title": "…", "spec": "…", "status": "todo", "worker": "Bot 名字或 null"}], "message_ticket": "这条消息在说哪个任务的 id 或 new-N，或 null"}

策略：
- decision：同一件事的后续、追问、改要求、问进度，都是 continue；明显换了一件不相干的事才 new；用户说回到之前那件、且 recent_plans 里有对得上的，才 resume 并给 resume_plan_id。current_plan 为 null 时只能 new。拿不准就 continue。
- plan：在 current_plan.spec 的基础上改，不要重写没变的部分。用户的改善意见、口径、约束进 rules；目标变了改 goal；怎么算完成进 acceptance；定下来的做法和分工进 process；progress 按 artifacts 和 trace 更新。status 只在这件事明确做完时 done，明确搁置时 parked。
- tickets：把要交付的东西拆成任务，一个任务是能独立交出的一块，不要把一句话拆成好几个，也不要每条消息都新建。已有任务用它的 id 引用，只改变了的字段；没变的可以不列，不列的不动。新任务用 new-1、new-2。不能删任务，只能改成 done 或 parked。有人交出了属于某任务的文件，把它标 review 或 done，并写上 worker。
- message_ticket：mode 是 message 时，这条消息在说哪个任务；一句泛泛的话或问进度就 null。settle 时 null。
- 一切都写短：goal 一句话，列表每条一句。`;

export const ORGANIZER_MESSAGES_LIMIT = 30;
export const ORGANIZER_BODY_LIMIT = 600;
export const ORGANIZER_TICKETS_LIMIT = 40;
export const ORGANIZER_ARTIFACTS_LIMIT = 30;
export const ORGANIZER_TRACE_LIMIT = 12;
export const ORGANIZER_RECENT_PLANS = 8;
export const ORGANIZER_KINDS_LIMIT = 50;
const TICKET_SPEC_PREVIEW = 300;

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
    tickets: Array<{ id: string; seq: number; title: string; status: TicketStatus; worker: string | null; spec: string; artifacts: number }>;
  } | null;
  recent_plans: Array<{ id: string; goal: string; kind: string | null; status: PlanStatus; last_activity_at: string }>;
  kinds: string[];
  since_last_revision: {
    messages: Array<{ id: string; author: string; kind: string; body: string; ticket_id: string | null; created_at: string; truncated?: true }>;
    artifacts: Array<{ path: string; by: string; ticket_id: string | null; cited_at: string }>;
    trace: string[];
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
  if (current) {
    for (const row of store.taskArtifacts(current.id, () => true, 500)) {
      if (row.ticket_id) artifactCounts.set(row.ticket_id, (artifactCounts.get(row.ticket_id) ?? 0) + 1);
    }
  }
  const spec = current ? parsePlanSpec(current.spec) : null;
  const precedents: OrganizerPayload["precedents"] = [];
  if (spec?.kind && current) {
    for (const earlier of store.precedentTasks(spec.kind, current.id, 3)) {
      const done = parsePlanSpec(earlier.spec);
      if (done) precedents.push({ goal: done.goal, process: done.process, rules: done.rules, outcome: done.progress.done });
    }
  }
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
          tickets: store
            .listTickets(current.id)
            .slice(0, ORGANIZER_TICKETS_LIMIT)
            .map((ticket) => ({
              id: ticket.id,
              seq: ticket.seq,
              title: ticket.title,
              status: ticket.status,
              worker: ticket.worker ? nameOf(store, ticket.worker) : null,
              spec: clipBody(ticket.spec, TICKET_SPEC_PREVIEW).text,
              artifacts: artifactCounts.get(ticket.id) ?? 0,
            })),
        }
      : null,
    recent_plans: store.sessionRecentTasks(input.sessionId, ORGANIZER_RECENT_PLANS).map((task) => {
      const earlier = parsePlanSpec(task.spec);
      return {
        id: task.id,
        goal: earlier?.goal ?? (task.brief ? clipBody(task.brief, 200).text : task.title),
        kind: task.kind,
        status: task.status,
        last_activity_at: store.taskLastActivityAt(task.id),
      };
    }),
    kinds: store.distinctTaskKinds(ORGANIZER_KINDS_LIMIT),
    since_last_revision: { messages, artifacts, trace: (input.trace ?? []).slice(-ORGANIZER_TRACE_LIMIT) },
    precedents,
  };
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NEW_TICKET = /^new-\d+$/;

/**
 * The organizer's answer, checked field by field. Null means "not usable": the engine then leaves
 * the plan as it was. Never throws.
 */
export function parseOrganizerResult(
  raw: string,
  ctx: { mode: "message" | "settle"; recentPlanIds: ReadonlySet<string>; roster: ReadonlyArray<{ id: string; name: string }> },
): OrganizerResult | null {
  const parsed = extractJsonObject(raw);
  if (!parsed) return null;
  const spec = normalizePlanSpec(parsed.plan);
  if (!spec) return null;
  let decision: OrganizerResult["decision"] = "continue";
  let resumePlanId: string | null = null;
  const decisionRaw = typeof parsed.decision === "string" ? parsed.decision.trim().toLowerCase() : "";
  if (ctx.mode === "message") {
    if (decisionRaw === "new") decision = "new";
    else if (decisionRaw === "resume") {
      const id = typeof parsed.resume_plan_id === "string" ? parsed.resume_plan_id.trim() : "";
      if (ctx.recentPlanIds.has(id)) {
        decision = "resume";
        resumePlanId = id;
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
      const title = typeof row.title === "string" ? row.title.replace(/\s+/g, " ").trim() : "";
      if (!title) continue;
      const status = isTicketStatus(row.status) ? row.status : "todo";
      const workerName = typeof row.worker === "string" ? row.worker.trim().toLowerCase() : "";
      tickets.push({
        id,
        title,
        spec: typeof row.spec === "string" ? row.spec.trim() : "",
        status,
        worker: workerName ? (byName.get(workerName) ?? null) : null,
      });
    }
  }
  let messageTicket: string | null = null;
  if (ctx.mode === "message" && typeof parsed.message_ticket === "string") {
    const id = parsed.message_ticket.trim();
    if (ULID.test(id) || NEW_TICKET.test(id)) messageTicket = id;
  }
  return { decision, resumePlanId, spec, tickets, messageTicket };
}
