/** The situation message: where the turn stands, who is on the team, what is held. */
import { USER_MEMBER, type Locale, type Message } from "@real-bot/protocol";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import type { ChatMessage } from "../completions";
import { readOnlyLine, saidOf, type SaidLine } from "../prompts";
import type { Store } from "../store";
import { takeCodePoints } from "../text";
import { asFolder } from "../workspace-paths";
import { botDisplayName, LATEST_USER_LIMIT, oneLineClip } from "./common";
import { planFacts } from "./plan-facts";
import { planLines } from "./plan-lines";

/** Group-only fact block. Chinese heading in every locale, like TRIGGER_FLAG. */
export const SITUATION_HEADING = "# 局面";

export type SituationFacts = {
  seats: string[];
  waker: string;
  latest_user: string | null;
};

export function situationFacts(
  store: Store,
  sessionId: string,
  trigger: Message,
): SituationFacts {
  const live = store.listLiveTurns({ sessionId });
  const seats: string[] = [];
  const seen = new Set<string>();
  for (const turn of live) {
    const name = botDisplayName(store, turn.bot_id);
    if (seen.has(name)) continue;
    seen.add(name);
    seats.push(name);
  }
  const waker = trigger.author === USER_MEMBER ? "user" : botDisplayName(store, trigger.author);
  const latest = store.listMainMessages(sessionId, 40).find((m) => m.kind === "user");
  let latest_user: string | null = null;
  if (latest) {
    const clipped = takeCodePoints(latest.body.replace(/\s+/g, " ").trim(), LATEST_USER_LIMIT);
    latest_user = clipped.text.length > 0 ? clipped.text : null;
  }
  return { seats, waker, latest_user };
}

/**
 * The facts this turn opens on. Groups get who is here, who has a live turn and who woke this one;
 * every turn, group or direct, gets its job — what it was asked for, what it has handed over, who
 * did what, and this Bot's pending check-back — and its work dir, because that path is the whole
 * point of the shell's default cwd, and a Bot that cannot see it cannot write anywhere on purpose.
 * A direct with no job (a turn from before work dirs) still gets no situation block at all.
 */
export function situationUserMessage(
  store: Store,
  sessionId: string,
  triggerMessageId: string,
  locale: Locale,
  selfBotId: string,
  turnId: string,
  /** Name the work and plan dirs as host paths (a Claude Agent turn, ADR 0061), not workspace-relative ones. */
  hostPaths = false,
): ChatMessage | null {
  let sessionKind: string;
  try {
    sessionKind = store.getSession(sessionId).kind;
  } catch {
    return null;
  }
  const taskId = store.taskOfTurn(turnId);
  const ticketId = store.ticketOfTurn(turnId);
  const workDir = store.turnWorkDir(turnId);
  const planDir = ticketId ? store.turnPlanDir(turnId) : null;
  const hostRoot = hostPaths ? store.workspacePath() : null;
  const dir = (relpath: string) => (hostRoot ? asFolder(joinPath(hostRoot, relpath)) : `${relpath}/`);
  const workDirLine = workDir
    ? ticketId && planDir
      ? locale === "en"
        ? `This turn's ticket dir: ${dir(workDir)} (plan dir: ${dir(planDir)})`
        : `本轮任务目录：${dir(workDir)}（规划目录：${dir(planDir)}）`
      : locale === "en"
        ? `This turn's work dir: ${dir(workDir)}`
        : `本轮工作目录：${dir(workDir)}`
    : null;
  // The prompt speaks in workspace-relative paths, so a Bot that has to name a host path (a file the
  // user points at outside the workspace, a cwd) used to guess the root and `~` — often `/Users/me`.
  const root = workDir ? store.workspacePath() : null;
  const rootLine = root
    ? locale === "en"
      ? `The workspace root on this machine is ${asFolder(root)} and ~ is ${homedir()}; write host paths from these, never guess.`
      : `工作区根在这台机器上是 ${asFolder(root)}，~ 是 ${homedir()}；要写宿主路径就照这两个写，不要猜。`
    : null;
  const dirLines = [rootLine, workDirLine].filter((line): line is string => !!line);
  const facts = taskId
    ? planFacts(store, { taskId, ticketId, turnId, triggerMessageId, botId: selfBotId, sessionId, locale })
    : null;
  const job = facts ? planLines(facts, locale) : [];
  if (store.getTurn(turnId).mode === "desk") {
    const candidates = store.deskCandidateIds(turnId).map((id) => {
      try {
        const plan = store.planCandidateEvidence(id);
        const activity = locale === "en" ? `Last activity: ${plan.lastActivityAt}` : `最后活动：${plan.lastActivityAt}`;
        const files = plan.recentArtifacts.length ? (locale === "en" ? `Recent artifacts: ${plan.recentArtifacts.join(", ")}` : `最近产物：${plan.recentArtifacts.join("、")}`) : "";
        const quote = plan.lastUserQuote ? (locale === "en" ? `Latest user words: ${oneLineClip(plan.lastUserQuote, 300)}` : `最近用户原话：${oneLineClip(plan.lastUserQuote, 300)}`) : "";
        return [ `${plan.id} · ${plan.title}`, activity, files, quote ].filter(Boolean).join(" · ");
      } catch { return `${id} · ${locale === "en" ? "no longer available" : "已不可用"}`; }
    });
    job.push(locale === "en"
      ? "Desk segment: read and reply before choosing a job. To change the app's settings (endpoints, model settings, MCP servers), call their tools here: that opens no job. work_on selects only the captured candidates below."
      : "桌面段：先读与回答。要改应用的设置（端点、模型设置、MCP 服务器），在这里直接调用对应的工具，不会开新事。work_on 只可选本轮已列出的候选。",
      ...candidates.map((line) => `- ${line}`));
    // The line was read as about none of these jobs (ADR 0057): the first effect opens one for it.
    const request = store.originalUserRequest(turnId);
    if (candidates.length > 0 && request && store.lineReadAsNew(request.id)) job.push(locale === "en"
      ? "The app read the user's line as about none of these jobs: your first effect opens a new job for it. If it is about one of them after all, choose that one with work_on first."
      : "应用读出这句话不是在说上面哪一件：第一次有副作用的调用会为它新开一件事；其实是在说其中某件的话，先用 work_on 选它。");
    else if (candidates.length === 1) job.push(locale === "en"
      ? "The first effect defaults to that job; if unrelated, use work_on({new}) and quote the user first."
      : "第一次副作用默认归到这件事；不相干就先 work_on({new}) 引用用户原话。" );
    else if (candidates.length === 0) job.push(locale === "en"
      ? "No captured candidates: a user's first effect opens one visible job and a produce ticket."
      : "没有候选：用户请求的第一次副作用会可见地新开一件事与产出任务。" );
    else job.push(locale === "en" ? "Choose with work_on before any effect; an ambiguous effect is refused." : "先 work_on 选定再动手；未选归属的副作用会被拒绝。");
  }
  // A read-only turn opens on the stop over it and what it may do, before anything else (ADR 0040).
  const held = readOnlyHeld(store, turnId, locale);
  if (sessionKind !== "group") {
    const lines = [...held, ...job, ...dirLines];
    return lines.length > 0 ? { role: "user", content: `${SITUATION_HEADING}\n\n${lines.join("\n")}` } : null;
  }
  let trigger: Message;
  try {
    trigger = store.getMessage(triggerMessageId);
  } catch {
    return null;
  }
  const group = situationFacts(store, sessionId, trigger);
  const members = store
    .presentBotIds(sessionId)
    .filter((id) => id !== selfBotId)
    .map((id) => `@${botDisplayName(store, id)}`);
  const membersLine =
    locale === "en"
      ? members.length > 0
        ? `Members here (mention by exact full name): ${members.join(", ")}.`
        : "Members here: only you."
      : members.length > 0
        ? `在场成员（点名请逐字写全名）：${members.join("、")}。`
        : "在场成员：只有你。";
  const team = teamLines(store, sessionId, selfBotId, locale);
  const seatLine =
    locale === "en"
      ? group.seats.length > 0
        ? `Live turns in this group: ${group.seats.join(", ")}.`
        : "Live turns in this group: none."
      : group.seats.length > 0
        ? `本群进行中的轮：${group.seats.join("、")}。`
        : "本群没有进行中的轮。";
  const wakerLabel = group.waker === "user" ? "user" : group.waker;
  const wakerLine =
    locale === "en"
      ? `This turn was opened by 【${wakerLabel}】.`
      : `本轮由【${wakerLabel}】叫醒。`;
  const latestLine =
    locale === "en"
      ? group.latest_user
        ? `Latest user line: ${group.latest_user}`
        : "Latest user line: (none)"
      : group.latest_user
        ? `用户最近一条：${group.latest_user}`
        : "用户最近一条：（无）";
  const lines = [...held, membersLine, ...team, seatLine, wakerLine, latestLine, ...job];
  lines.push(...dirLines);
  return { role: "user", content: `${SITUATION_HEADING}\n\n${lines.join("\n")}` };
}

/** How much of a Bot's duties the line naming what each one does quotes. */
const DUTIES_LINE = 40;

/**
 * What each Bot here does, and who the user confirmed as the group's lead — told to the lead as its
 * job. The block named the others only (「在场成员：@文案。」), and on 2026-10-04's real-model runs the
 * poster group's lead wrote the slogans itself in two of four jobs, never laying the work out for
 * 文案, whose duties are 「写宣传语和文案」.
 */
function teamLines(store: Store, sessionId: string, selfBotId: string, locale: Locale): string[] {
  const en = locale === "en";
  const roles = store.presentBotIds(sessionId).filter((id) => id !== selfBotId).flatMap((id) => {
    try {
      const duties = oneLineClip(store.getBot(id).duties ?? "", DUTIES_LINE).trim();
      return duties ? [`@${botDisplayName(store, id)}${en ? ": " : "："}${duties}`] : [];
    } catch {
      return [];
    }
  });
  const lines = roles.length > 0 ? [en ? `What each does: ${roles.join("; ")}.` : `各自做什么：${roles.join("；")}。`] : [];
  const lead = store.db.query<{ member: string }, [string]>(`SELECT p.member FROM session_participants p JOIN bots b ON b.id = p.member
    WHERE p.session_id = ? AND p.left_at IS NULL AND p.is_lead = 1 AND b.deleted_at IS NULL AND b.archived_at IS NULL LIMIT 1`).get(sessionId)?.member;
  if (lead === selfBotId) {
    lines.push(en
      ? "You are this group's lead, as the user confirmed: lay out the parts others should make with plan_items (who makes each, who reviews it), then delegate on those tickets; for a reply in words only, delegate with expects answer."
      : "你是用户在这个群里确认的负责人：要别人做的部分，先用 plan_items 拆成任务、写明谁做谁审，再委派到那张任务；只要一句答复的，委派时 expects 用 answer。");
  } else if (lead) {
    lines.push(en ? `This group's lead, as the user confirmed, is @${botDisplayName(store, lead)}: laying the work out and handing it out is theirs.` : `用户确认的这个群的负责人是 @${botDisplayName(store, lead)}：拆活、派活由它定。`);
  }
  return lines;
}

/** For a read-only turn, the line naming the stop over it — the newest you said, if you said one; else nothing. */
function readOnlyHeld(store: Store, turnId: string, locale: Locale): string[] {
  let mode;
  try {
    mode = store.getTurn(turnId).mode;
  } catch {
    return [];
  }
  if (mode !== "readonly") return [];
  const holds = store.turnHeldBy(turnId);
  let said: SaidLine = null;
  for (const hold of [...holds].reverse()) {
    if (!hold.source_message_id) continue;
    try {
      said = saidOf(store.getMessage(hold.source_message_id));
      break;
    } catch {
      // that line was cleared; an older stop may still name one
    }
  }
  return [readOnlyLine(locale, said)];
}
