/**
 * The organizer (整理跳), engine side.
 *
 * Two moments. After the user speaks and before any turn opens, one short call files the line:
 * does it continue the session's current plan, start another, or go back to an earlier one; what
 * the plan is for now; which tickets exist and which one this line is about. The message is
 * stamped with the answer, so every turn it opens — a mention, a judgement that joined, a fork —
 * lands in the same plan and ticket. Once a plan's turns have all ended and it has been quiet for
 * a moment, a second call files what was handed over: ticket states, workers, progress.
 *
 * It fails open. No default model, a refused call, an unreadable answer, a store that refuses the
 * change: the plan stays as it was and turns open where they would have anyway, and the log says
 * which of those it was. The call is billed as its own spend kind so the cost of keeping plans in
 * order is visible.
 *
 * The plan's spec and tickets are mirrored into the workspace as `map.md` and `ticket.md`, the
 * app's own files, so a Bot can read the whole thing and a person can browse it.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { USER_MEMBER, type Message, type ThinkingLevel, type Ticket, type Turn } from "@real-bot/protocol";
import type { CompletionsClient, MappedUsage } from "./completions";
import { atomicWrite } from "./file-integrity";
import { ORGANIZER_SYSTEM, organizerPayload, parseOrganizerResult } from "./prompts/organizer";
import { parsePlanSpec, PLAN_MAP_FILE, TICKET_FILE, type PlanSpec, type Store, type Task } from "./store";
import { classifyPath } from "./workspace-paths";

export type OrganizerRouting = {
  baseUrl: string;
  apiKey: string;
  providerId: string;
  providerName: string;
  model: string;
  thinkingLevel: ThinkingLevel | null;
};

export type OrganizerDeps = {
  store: Store;
  completions: CompletionsClient;
  /** The default endpoint's default model, resolved when a call is about to be made. */
  routing: () => Promise<OrganizerRouting | null>;
  recordSpend: (input: { sessionId: string; target: OrganizerRouting; usage: MappedUsage | null; responded: boolean }) => void;
  draining: () => boolean;
  /** How long a plan has to be quiet after its last turn before it is filed. Tests shorten it. */
  settleQuietMs?: number;
  /** Where a filing that came to nothing says why. Defaults to stderr. */
  log?: (line: string) => void;
};

export type Organizer = {
  /** Files a user message; resolves to where the turns it opens should land. Never rejects. */
  organizeMessage(message: Message): Promise<{ taskId: string | null; ticketId: string | null }>;
  /** A turn reached a terminal state: its plan is filed once it has been quiet for a moment. */
  noteTurnEnded(turn: Turn): void;
  /** Files a plan now, if nothing is running in it and something happened since the last version. */
  settlePlan(taskId: string): Promise<boolean>;
  renderMirrors(taskId: string): void;
  clearTimers(): void;
};

/**
 * How long a message's filing may take, answer included: the call does not stream. The turns the
 * line opens wait on it, and the Bots it wakes already show as thinking meanwhile. Twenty seconds
 * cut off real answers — a reasoning model spent nineteen of them before its first word.
 */
export const ORGANIZER_TIMEOUT_MS = 60_000;
/** A settle has nobody waiting on it. */
export const ORGANIZER_SETTLE_TIMEOUT_MS = 120_000;
/**
 * Room for the plan and its tickets. A short call's default is sized for a verdict, and 256 tokens
 * stopped every plan partway through its JSON, so nothing was ever filed.
 */
export const ORGANIZER_MAX_TOKENS = 4096;
/** Quiet time after a plan's last turn before it is filed, so a fan-out is filed once. */
export const SETTLE_QUIET_MS = 30_000;
/** Whether the plan and its tickets are rendered into the workspace. */
export const MIRROR_FILES = true;
/** Turns of the plan the organizer sees as "so far". */
const TRACE_LIMIT = 12;

export function createOrganizer(deps: OrganizerDeps): Organizer {
  const store = deps.store;
  const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  const chains = new Map<string, Promise<unknown>>();
  const log = deps.log ?? ((line: string) => console.error(line));

  function traceLines(taskId: string): string[] {
    try {
      return store
        .taskTrace(taskId)
        .nodes.slice(-TRACE_LIMIT)
        .map((node) => `【${node.actor === USER_MEMBER ? "user" : nameOf(node.actor)}】${node.summary}`);
    } catch {
      return [];
    }
  }

  function nameOf(id: string): string {
    try {
      return store.getBot(id).name;
    } catch {
      return id;
    }
  }

  async function call(input: {
    mode: "message" | "settle";
    sessionId: string;
    message: Message | null;
    current: Task | null;
  }): Promise<ReturnType<typeof parseOrganizerResult>> {
    const routing = await deps.routing();
    if (!routing || deps.draining()) return null;
    const payload = organizerPayload(store, {
      mode: input.mode,
      sessionId: input.sessionId,
      message: input.message,
      current: input.current,
      trace: input.current ? traceLines(input.current.id) : [],
    });
    // Which filing this was, for the line that says why it came to nothing.
    const what = input.mode === "message" ? `message ${input.message?.id}` : `plan ${input.current?.id}`;
    let result;
    try {
      result = await deps.completions.judge({
        baseUrl: routing.baseUrl,
        apiKey: routing.apiKey,
        model: routing.model,
        messages: [
          { role: "system", content: ORGANIZER_SYSTEM },
          { role: "user", content: JSON.stringify(payload) },
        ],
        signal: new AbortController().signal,
        timeoutMs: input.mode === "message" ? ORGANIZER_TIMEOUT_MS : ORGANIZER_SETTLE_TIMEOUT_MS,
        maxTokens: ORGANIZER_MAX_TOKENS,
      });
    } catch (error) {
      log(`[organizer] filing ${what}: the call threw, nothing filed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    try {
      deps.recordSpend({
        sessionId: input.sessionId,
        target: routing,
        usage: result.usage,
        responded: result.failKind === null || result.failKind === "incomplete",
      });
    } catch {
      // the ledger is best-effort; the answer still counts
    }
    // Every way this comes to nothing is said, not swallowed: a filing that never lands looks,
    // from the board, exactly like one that has not been tried.
    if (result.failKind && result.failKind !== "incomplete") {
      log(`[organizer] filing ${what}: the call failed (${result.failKind}), nothing filed`);
      return null;
    }
    // A cut-off plan is not a shorter plan: its tickets and progress would be whatever fit.
    if (result.truncated) {
      log(`[organizer] filing ${what}: the answer stopped at the ${ORGANIZER_MAX_TOKENS}-token cap, nothing filed`);
      return null;
    }
    const parsed = parseOrganizerResult(result.content ?? "", {
      mode: input.mode,
      recentPlanIds: new Set(store.sessionRecentTasks(input.sessionId).map((task) => task.id)),
      roster: store.listBots().map((bot) => ({ id: bot.id, name: bot.name })),
    });
    if (!parsed) log(`[organizer] filing ${what}: the answer did not read as a plan, nothing filed`);
    return parsed;
  }

  function shouldFile(message: Message): boolean {
    if (message.kind !== "user" || message.author !== USER_MEMBER) return false;
    if (!message.body.trim() && message.attachments.length === 0) return false;
    try {
      // A batch of annotations continues the plan that delivered the artifact; filing it would
      // stamp a competing one.
      if (store.annotationsOfMessage(message.id).length > 0) return false;
      if (store.presentBotIds(message.session_id).length === 0) return false;
    } catch {
      return false;
    }
    return true;
  }

  async function organizeOne(message: Message): Promise<{ taskId: string | null; ticketId: string | null }> {
    const current = store.sessionCurrentTask(message.session_id);
    const fallback = { taskId: current?.id ?? null, ticketId: null };
    if (deps.draining() || !shouldFile(message)) return fallback;
    const parsed = await call({ mode: "message", sessionId: message.session_id, message, current });
    if (!parsed) return fallback;
    let applied;
    try {
      applied = store.transaction(() =>
        store.applyOrganizerResult({
          sessionId: message.session_id,
          current,
          result: parsed,
          source: { messageId: message.id, turnId: null, messageBody: message.body },
        }),
      );
    } catch (error) {
      log(`[organizer] could not apply the filing of ${message.id}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
    renderMirrors(applied.task.id);
    return { taskId: applied.task.id, ticketId: applied.messageTicketId };
  }

  async function organizeMessage(message: Message): Promise<{ taskId: string | null; ticketId: string | null }> {
    // One session's messages are filed in the order they arrived: the second waits for the first's decision.
    const previous = chains.get(message.session_id) ?? Promise.resolve();
    const run = previous.then(
      () => organizeOne(message),
      () => organizeOne(message),
    );
    chains.set(message.session_id, run.catch(() => undefined));
    try {
      return await run;
    } catch {
      return { taskId: store.sessionCurrentTask(message.session_id)?.id ?? null, ticketId: null };
    } finally {
      if (chains.get(message.session_id) === run) chains.delete(message.session_id);
    }
  }

  async function settlePlan(taskId: string): Promise<boolean> {
    if (deps.draining() || inFlight.has(taskId)) return false;
    let task: Task;
    try {
      task = store.getTask(taskId);
    } catch {
      return false;
    }
    if (!task.session_id) return false;
    if (store.taskLiveTurnCount(taskId) > 0) return false;
    const since = store.lastSpecRevisionAt(taskId);
    if (store.taskMessagesSince(taskId, since, 1).length === 0 && store.taskArtifactsSince(taskId, since, 1).length === 0) {
      return false;
    }
    inFlight.add(taskId);
    try {
      const parsed = await call({ mode: "settle", sessionId: task.session_id, message: null, current: task });
      if (!parsed) return false;
      const lastTurn = store.db
        .query<{ id: string }, [string]>(`SELECT id FROM turns WHERE task_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`)
        .get(taskId);
      try {
        store.transaction(() =>
          store.applyOrganizerResult({
            sessionId: task.session_id!,
            current: task,
            result: { ...parsed, decision: "continue", resumePlanId: null, messageTicket: null },
            source: { messageId: null, turnId: lastTurn?.id ?? null, messageBody: "" },
          }),
        );
      } catch (error) {
        log(`[organizer] could not apply the settling of ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      renderMirrors(taskId);
      return true;
    } finally {
      inFlight.delete(taskId);
    }
  }

  function noteTurnEnded(turn: Turn): void {
    if (!turn.task_id || deps.draining()) return;
    if (turn.status === "running" || turn.status === "waiting_ask" || turn.status === "waiting_approval") return;
    const taskId = turn.task_id;
    const existing = settleTimers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      settleTimers.delete(taskId);
      void settlePlan(taskId).catch((error) => console.error(`[organizer] settling ${taskId} failed`, error));
    }, deps.settleQuietMs ?? SETTLE_QUIET_MS);
    timer.unref?.();
    settleTimers.set(taskId, timer);
  }

  function renderMirrors(taskId: string): void {
    if (!MIRROR_FILES) return;
    const root = store.workspacePath();
    if (!root) return;
    let task: Task;
    try {
      task = store.getTask(taskId);
    } catch {
      return;
    }
    const spec = parsePlanSpec(task.spec);
    if (!spec) return;
    const tickets = store.listTickets(taskId);
    const planDir = classifyPath(root, task.dir);
    if (planDir.zone !== "inside") return;
    try {
      mkdirSync(planDir.abs, { recursive: true });
      atomicWrite(join(planDir.abs, PLAN_MAP_FILE), renderPlanMap(task, spec, tickets, nameOf));
    } catch (error) {
      console.error(`[organizer] could not write ${task.dir}/${PLAN_MAP_FILE}`, error);
    }
    for (const ticket of tickets) {
      const dir = classifyPath(root, ticket.dir);
      if (dir.zone !== "inside") continue;
      try {
        mkdirSync(dir.abs, { recursive: true });
        atomicWrite(join(dir.abs, TICKET_FILE), renderTicketFile(task, spec, ticket, nameOf));
      } catch (error) {
        console.error(`[organizer] could not write ${ticket.dir}/${TICKET_FILE}`, error);
      }
    }
    void existsSync;
  }

  function clearTimers(): void {
    for (const timer of settleTimers.values()) clearTimeout(timer);
    settleTimers.clear();
  }

  return { organizeMessage, noteTurnEnded, settlePlan, renderMirrors, clearTimers };
}

const PLAN_STATUS_ZH: Record<PlanSpec["status"], string> = { active: "进行中", done: "已完成", parked: "搁置" };
const TICKET_STATUS_ZH: Record<Ticket["status"], string> = { todo: "待做", doing: "进行中", review: "待验收", done: "已完成", parked: "搁置" };

function bullets(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- （无）";
}

function number(seq: number): string {
  return String(seq).padStart(2, "0");
}

/** `map.md`: the plan's spec and its ticket index, as the app last organized them. */
export function renderPlanMap(task: Task, spec: PlanSpec, tickets: readonly Ticket[], nameOf: (id: string) => string): string {
  const rows = tickets.map((ticket) => {
    const who = ticket.worker ? nameOf(ticket.worker) : "";
    const rel = ticket.dir.startsWith(`${task.dir}/`) ? ticket.dir.slice(task.dir.length + 1) : ticket.dir;
    return `| ${number(ticket.seq)} | ${ticket.title.replace(/\|/g, "\\|")} | ${TICKET_STATUS_ZH[ticket.status]} | ${who} | ${rel}/ |`;
  });
  return [
    `# ${spec.goal}`,
    "",
    `- 类别：${spec.kind ?? "（未定）"}`,
    `- 状态：${PLAN_STATUS_ZH[spec.status]}`,
    `- 目录：${task.dir}/`,
    ...(task.brief ? [`- 开头的要求：${task.brief.replace(/\s+/g, " ").trim()}`] : []),
    "",
    "## 验收",
    bullets(spec.acceptance),
    "",
    "## 规则",
    bullets(spec.rules),
    "",
    "## 流程与分工",
    bullets(spec.process),
    "",
    "## 进展",
    `- 已完成：${spec.progress.done.join("、") || "（无）"}`,
    `- 待做：${spec.progress.open.join("、") || "（无）"}`,
    `- 卡住：${spec.progress.blocked.join("、") || "（无）"}`,
    "",
    "## 任务",
    "",
    ...(rows.length > 0 ? ["| # | 任务 | 状态 | 谁在做 | 目录 |", "|---|---|---|---|---|", ...rows] : ["（还没有拆出任务）"]),
    "",
    "_由应用整理，每次整理后重写；改要点请在流程图里改，不要手改这个文件。_",
    "",
  ].join("\n");
}

/** `ticket.md`: one ticket, with the plan's acceptance and rules it is measured against. */
export function renderTicketFile(task: Task, spec: PlanSpec, ticket: Ticket, nameOf: (id: string) => string): string {
  return [
    `# ${number(ticket.seq)} ${ticket.title}`,
    "",
    `- 规划：${spec.goal}（${task.dir}/${PLAN_MAP_FILE}）`,
    `- 状态：${TICKET_STATUS_ZH[ticket.status]}`,
    `- 谁在做：${ticket.worker ? nameOf(ticket.worker) : "（还没人接）"}`,
    `- 目录：${ticket.dir}/`,
    "",
    "## 要点",
    ticket.spec.trim() || "（还没写）",
    "",
    "## 规划的验收",
    bullets(spec.acceptance),
    "",
    "## 规划的规则",
    bullets(spec.rules),
    "",
    "_由应用整理，每次整理后重写；不要手改这个文件。_",
    "",
  ].join("\n");
}
