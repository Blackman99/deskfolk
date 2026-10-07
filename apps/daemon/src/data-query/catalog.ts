/**
 * What the tables a Bot may read are for (ADR 0065): one line each for the ones that tell how work
 * went, so `describe_data` gives more than column names. Times are ISO 8601 UTC strings; ids are
 * ULIDs; `payload`, `spec`, `detail`-like columns hold JSON (read them with json_extract).
 */
import type { Locale } from "@real-bot/protocol";

type Line = { zh: string; en: string };

export const TABLE_NOTES: Readonly<Record<string, Line>> = {
  bots: { zh: "名册上的 Bot：名字、职责、边界、钉的模型、运行方式；deleted_at / archived_at 非空的是删了或归档了。", en: "Bots: name, duties, boundaries, pinned model, runner; deleted_at / archived_at." },
  profile_revisions: { zh: "Bot 人设的每一次修改：谁改的（actor）、改前改后。", en: "Changes to a Bot's profile: actor, before, after." },
  sessions: { zh: "会话：私聊和群；kind 区分，name 是群名。", en: "Conversations: kind (direct / group), name." },
  session_participants: { zh: "会话里有谁（member 是 Bot id 或 user），谁是群负责人，何时离开。", en: "Conversation members (member: a Bot id or user), group lead, when they left." },
  messages: { zh: "会话里的每一条消息：author、kind（user / bot / system / ask / approval…）、body、turn_id、task_id（归在哪件事）。", en: "Messages: author, kind (user / bot / system / ask / approval\u2026), body, turn_id, task_id." },
  message_filings: { zh: "一条消息归到哪几件事、由谁归的（你、读句、Bot）。", en: "Which jobs a message is filed under, and by whom." },
  user_quotes: { zh: "你说过的话的原样副本（body），和转录分开保存；task_id 是它归到的规划。", en: "Your words verbatim (body), apart from transcripts; task_id." },
  turns: { zh: "Bot 的每一轮：bot_id、session_id、trigger_message_id、status（running / completed / interrupted / stopped…）、end_reason（done / answered / blocked…）、开始结束时间；跳数和结局在 turn_route_decisions。", en: "Turns: bot_id, session_id, trigger_message_id, status (running / completed / interrupted / stopped\u2026), end_reason (done / answered / blocked\u2026); hops and outcome: turn_route_decisions." },
  turn_runs: { zh: "一轮里每一段执行的记录（重启后接着做的也在）。", en: "Each run of a turn, including runs resumed after a restart." },
  turn_route_decisions: { zh: "每一轮用了哪个模型和思考档、为什么、跳数（hops）、结局（outcome、fail_kind）、出过哪些工具错误（tool_failures）。", en: "Per turn: model, thinking level and why; hops; outcome, fail_kind; tool_failures." },
  tool_executions: { zh: "Bot 调过的每一次工具：tool、哪一轮、outcome / error_code、起止时间、有没有副作用（side_effect）。", en: "Tool calls: tool, turn_id, outcome (succeeded / failed / refused / unknown), error_code, side_effect." },
  tasks: { zh: "规划（一件事）：title、kind（这类活的标签，常为空）、brief（开头那条要求）、spec（要点 JSON：目标、做法、进展、验收、规则）、status 和 stage（交付阶段）、delivered_at、lead_bot_id、所在会话。", en: "Jobs: title, kind (often empty), brief, spec (JSON), status, stage, delivered_at, lead_bot_id, session_id." },
  task_spec_revisions: { zh: "规划要点的每一版：谁改的（整理跳、你、叫停）。", en: "Versions of a job's spec, and who changed it." },
  tickets: { zh: "任务：task_id（规划）、title、spec、status 和 stage（5 级起的阶段）、owner_bot_id、reviewer_bot_id、depends_on。", en: "Tickets: task_id, title, spec, status, stage, owner_bot_id, reviewer_bot_id, depends_on." },
  ticket_parts: { zh: "任务的分件（镜头等）和各自的阶段。", en: "A ticket's parts (shots\u2026) and their stages." },
  submissions: { zh: "每一次交付：交了哪些文件、检查结果、审查结论、结局（放行、退回、返工）。", en: "Hand-overs: task_id, state (approved / rejected / superseded\u2026), origin, checks, reviews." },
  acceptance_checks: { zh: "规划的验收检查：kind、路径或命令、谁定的（origin）、是否确认。", en: "A job's acceptance checks: kind, path or command, origin, confirmed." },
  acceptance_check_runs: { zh: "每次检查跑出的结果：outcome（pass / fail / error / blocked）、detail、时间。", en: "Check runs: outcome (pass / fail / error / blocked), detail." },
  requirements: { zh: "需求台账：每条要求站在你的原话上（quote）、转述（restated）、类别、scope（part / ticket / plan / project / standing）和 scope_id（scope 是 plan 时就是 tasks.id）、origin_task_id、说过几次（times_raised）、状态。没有 task_id 列。", en: "Requirements ledger: quote (your words), restated, category, scope (part / ticket / plan / project / standing), scope_id (tasks.id for plan), origin_task_id, times_raised, status. No task_id." },
  delegations: { zh: "Bot 之间的委派：谁请谁做什么、在等什么、交回了没有。", en: "Delegations between Bots: who asked whom for what, and how it came back." },
  work_events: { zh: "工作记录，只追加：kind 是事件种类（如 submission.gates_failed、complaint.rework、control.hold、prompt.parse_failed），payload 是 JSON。", en: "Append-only work log: kind (e.g. end.rejected, complaint.rework, prompt.parse_failed), at, payload (JSON)." },
  quality_events: { zh: "出了问题的事件按类归档：category 是 execution / unclear / model / pipeline / review_miss / orchestration。", en: "What went wrong: kind, category (execution / unclear / model / pipeline / review_miss / orchestration), task_id, bot_id." },
  lessons: { zh: "应用记下的教训：命令超时的拦截规则、反思提出的清单项和检查，status 是候选、生效或停用。", en: "Lessons: timed-out command rules, checklist items; status." },
  reflections: { zh: "收窄的反思：误放行或卡在能力天花板后，当事 Bot 提了什么。", en: "Narrowed reflections after an overturned approval or a ceiling." },
  retrospectives: { zh: "完工复盘：bot_id、task_id、state、summary、findings（JSON：pitfalls / rework_causes / keep / earlier）、changes（对记忆和技能的改动和结局）。", en: "Retrospectives: bot_id, task_id, state, summary, findings (JSON: pitfalls / rework_causes / keep / earlier), changes." },
  memories: { zh: "每个 Bot 的记忆：subject、body、enabled。只能读；不要把别的 Bot 的记忆抄成你自己的，除非用户要。", en: "Each Bot's memories: subject, body, enabled. Never copy another Bot's into yours unless the user asks." },
  skills: { zh: "每个 Bot 的技能：name、description、body、enabled。", en: "Each Bot's skills: name, description, body, enabled." },
  shared_skills: { zh: "你共享给所有 Bot 的项目技能。", en: "Project skills shared with every Bot." },
  organizer_runs: { zh: "整理跳每一次调模型：原始答案、决定、落没落地、没落地的原因。", en: "Organizer calls: raw answer, decision, whether it landed and why not." },
  judgements: { zh: "群里没点名时每个 Bot 的下场 / 旁观判断和理由。", en: "Join / pass judgements on unmentioned group lines, with reasons." },
  spend: { zh: "花费账本，每次端点调用一行：kind / purpose、模型、token、实报或估算的金额。", en: "Spend ledger, one row per endpoint call: kind / purpose, model, tokens (cached_tokens), cost." },
  approvals: { zh: "批准卡：kind_key、要做的事（summary / target）、status（pending / allowed_once / denied / voided）。", en: "Approval cards: kind_key, summary, target, status (pending / allowed_once / denied / voided)." },
  holds: { zh: "叫停：范围、谁叫的、何时解除。", en: "Holds: scope, who made them, when lifted." },
  check_backs: { zh: "回看与等待：谁约的、何时到、核对什么、结局。", en: "Check-backs and waits: who, when due, what to verify, what happened." },
  routines: { zh: "日程：标题、要做的事、时间表、挂在哪个 Bot 上。", en: "Routines: title, instruction, schedule, Bot." },
  annotations: { zh: "你在产物上写的批注：路径、位置、意见、状态。", en: "Your annotations: path, anchor, comment, status." },
  prompt_overrides: { zh: "你改过的内置提示词（ADR 0064）：现在的全文、它依据的默认、冲突时的新默认。", en: "Built-in prompts you edited: the text in force, its default, a conflicting newer default." },
  prompt_revisions: { zh: "内置提示词的每一次修改：谁（你 / Bot / 应用）、为什么、前后全文、经哪张批准卡。", en: "Changes to built-in prompts: who, why, before, after, approval card." },
};

/** A ready-made read-only query for a question asked often; `query_data { recipe }` runs it by id. */
export type Recipe = { id: string; zh: string; en: string; sql: string };

/**
 * The questions an analysis starts from, written once against the real columns so a Bot does not
 * spend its first steps finding tables and guessing column names. `catalog.test.ts` runs each one
 * through the guard on seeded records. The overview lists them by id and line; the SQL comes back
 * with the answer, for a Bot that wants to narrow it.
 */
export const RECIPES: readonly Recipe[] = [
  {
    id: "sent_back_by_kind",
    zh: "每类活（没标类的按活自己）：交出几次、被退回几次（含你退回的 by_you）、投诉、交付后才补的要求、最糟的几件。",
    en: "Per kind of work (an unlabeled job counts alone): hand-overs, sent back (by_you is part of it), complaints, late requirements, worst jobs.",
    sql: "WITH s AS (SELECT task_id, COUNT(*) AS hand_overs, SUM(state = 'rejected') AS sent_back FROM submissions WHERE origin <> 'organizer' GROUP BY task_id), q AS (SELECT task_id, SUM(kind = 'user_rejected') AS by_you, SUM(kind = 'complaint') AS complaints, SUM(kind = 'requirement_after_delivery') AS late_asks FROM quality_events WHERE task_id IS NOT NULL GROUP BY task_id), j AS (SELECT COALESCE(NULLIF(t.kind, ''), t.title) AS kind, t.title, t.delivered_at, IFNULL(s.hand_overs, 0) AS hand_overs, IFNULL(s.sent_back, 0) AS sent_back, IFNULL(q.by_you, 0) AS by_you, IFNULL(q.complaints, 0) AS complaints, IFNULL(q.late_asks, 0) AS late_asks FROM tasks t LEFT JOIN s ON s.task_id = t.id LEFT JOIN q ON q.task_id = t.id), r AS (SELECT j.*, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY sent_back + complaints + late_asks DESC, delivered_at DESC) AS n FROM j) SELECT kind, COUNT(*) AS jobs, SUM(hand_overs) AS hand_overs, SUM(sent_back) AS sent_back, SUM(by_you) AS by_you, SUM(complaints) AS complaints, SUM(late_asks) AS late_asks, MAX(delivered_at) AS last_delivered, GROUP_CONCAT(CASE WHEN n <= 3 AND sent_back + complaints + late_asks > 0 THEN title END, ' | ') AS worst_jobs FROM r GROUP BY kind HAVING SUM(sent_back + complaints + late_asks) > 0 ORDER BY SUM(sent_back + complaints + late_asks) DESC LIMIT 20",
  },
  {
    id: "endings_refused",
    zh: "收尾被拦，按原因：几次、几轮、哪些 Bot、最近一次。",
    en: "Refused endings by reason: times, turns, Bots, last time.",
    sql: "SELECT json_extract(e.payload, '$.code') AS code, COUNT(*) AS times, COUNT(DISTINCT e.turn_id) AS turns, GROUP_CONCAT(DISTINCT b.name) AS bots, MAX(e.at) AS last_at FROM work_events e LEFT JOIN bots b ON b.id = e.bot_id WHERE e.kind = 'end.rejected' GROUP BY code ORDER BY times DESC",
  },
  {
    id: "trouble_by_kind",
    zh: "出过的错，按类别和类型：几次、几件活、几个 Bot。",
    en: "What went wrong by category and kind: times, jobs, Bots.",
    sql: "SELECT category, kind, COUNT(*) AS times, COUNT(DISTINCT task_id) AS jobs, COUNT(DISTINCT bot_id) AS bots, MAX(created_at) AS last_at FROM quality_events GROUP BY category, kind ORDER BY times DESC LIMIT 40",
  },
  {
    id: "unreadable_answers",
    zh: "应用自己的调用读不懂回答：按提示词、语言、修订、原因。",
    en: "Unreadable answers of the app's own calls: by prompt, language, revision, reason.",
    sql: "SELECT json_extract(payload, '$.prompt') AS prompt, json_extract(payload, '$.locale') AS locale, IFNULL(json_extract(payload, '$.revision'), 'default') AS revision, json_extract(payload, '$.reason') AS reason, COUNT(*) AS times, MAX(at) AS last_at FROM work_events WHERE kind = 'prompt.parse_failed' GROUP BY 1, 2, 3, 4 ORDER BY times DESC LIMIT 30",
  },
  {
    id: "recent_retrospectives",
    zh: "最近找到返工原因的完工复盘：活、Bot、总结、返工原因。",
    en: "Recent retrospectives with causes of rework: job, Bot, summary, causes.",
    sql: "SELECT r.finished_at, t.title AS job, t.kind, b.name AS bot, r.summary, json_extract(r.findings, '$.rework_causes') AS rework_causes FROM retrospectives r LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN bots b ON b.id = r.bot_id WHERE r.state = 'done' AND json_array_length(r.findings, '$.rework_causes') > 0 ORDER BY r.finished_at DESC LIMIT 6",
  },
  {
    id: "tool_errors",
    zh: "哪些工具常失败或被拒：按工具、结局、错误码。",
    en: "Tools that fail or are refused most: tool, outcome, error code.",
    sql: "SELECT tool, outcome, error_code, COUNT(*) AS times, COUNT(DISTINCT turn_id) AS turns, MAX(finished_at) AS last_at FROM tool_executions WHERE outcome IN ('failed', 'refused') GROUP BY tool, outcome, error_code ORDER BY times DESC LIMIT 30",
  },
];

export function tableNote(name: string, locale: Locale): string | null {
  return TABLE_NOTES[name]?.[locale] ?? null;
}
