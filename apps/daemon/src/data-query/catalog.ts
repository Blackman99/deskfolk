/**
 * What the tables a Bot may read are for (ADR 0065): one line each for the ones that tell how work
 * went, so `describe_data` gives more than column names. Times are ISO 8601 UTC strings; ids are
 * ULIDs; `payload`, `spec`, `detail`-like columns hold JSON (read them with json_extract).
 */
import type { Locale } from "@real-bot/protocol";

type Line = { zh: string; en: string };

export const TABLE_NOTES: Readonly<Record<string, Line>> = {
  bots: { zh: "名册上的 Bot：名字、职责、边界、钉的模型、运行方式；deleted_at / archived_at 非空的是删了或归档了。", en: "The roster's Bots: name, duties, boundaries, pinned model, runner; deleted_at / archived_at mark removed or archived ones." },
  profile_revisions: { zh: "Bot 人设的每一次修改：谁改的（actor）、改前改后。", en: "Every change to a Bot's profile: who (actor), before and after." },
  sessions: { zh: "会话：私聊和群；kind 区分，name 是群名。", en: "Conversations: directs and groups (kind); name is a group's name." },
  session_participants: { zh: "会话里有谁（member 是 Bot id 或 user），谁是群负责人，何时离开。", en: "Who is in a conversation (member: a Bot id or user), the group lead, when they left." },
  messages: { zh: "会话里的每一条消息：author、kind（user / bot / system / ask / approval…）、body、turn_id、task_id（归在哪件事）。", en: "Every message: author, kind (user / bot / system / ask / approval…), body, turn_id, task_id (the job it is filed under)." },
  message_filings: { zh: "一条消息归到哪几件事、由谁归的（你、读句、Bot）。", en: "Which jobs a message is filed under, and who filed it (you, a line reading, a Bot)." },
  user_quotes: { zh: "你说过的话的原样副本，和转录分开保存。", en: "Your words exactly as you wrote them, kept apart from transcripts." },
  turns: { zh: "Bot 的每一轮：哪个 Bot、哪个会话、被哪条消息触发、status（done / failed / interrupted…）、开始结束时间、跳数。", en: "Every turn: Bot, conversation, trigger message, status (done / failed / interrupted…), start and end, hops." },
  turn_runs: { zh: "一轮里每一段执行的记录（重启后接着做的也在）。", en: "Each run of a turn, including runs resumed after a restart." },
  turn_route_decisions: { zh: "每一轮用了哪个模型和思考档、为什么、怎么结束的、出过哪些工具错误（tool_failures）。", en: "Which model and thinking level each turn used and why, how it ended, its tool failures (tool_failures)." },
  tool_executions: { zh: "Bot 调过的每一次工具：tool、哪一轮、outcome / error_code、起止时间、有没有副作用（side_effect）。", en: "Every tool call: tool, turn, outcome / error_code, start and finish, whether it had a side effect (side_effect)." },
  tasks: { zh: "规划（一件事）：title、brief（开头那条要求）、spec（要点 JSON：目标、做法、进展、验收、规则）、status 和 stage（交付阶段）、lead_bot_id、所在会话。", en: "Plans (jobs): title, brief (the opening request), spec (JSON: goal, process, progress, acceptance, rules), status and stage, lead_bot_id, home conversation." },
  task_spec_revisions: { zh: "规划要点的每一版：谁改的（整理跳、你、叫停）。", en: "Every version of a plan's spec, and who changed it (organizer, you, a hold)." },
  tickets: { zh: "任务：task_id（规划）、title、spec、status 和 stage（5 级起的阶段）、owner_bot_id、reviewer_bot_id、depends_on。", en: "Tickets: task_id (plan), title, spec, status and stage (the stages from level 5), owner_bot_id, reviewer_bot_id, depends_on." },
  ticket_parts: { zh: "任务的分件（镜头等）和各自的阶段。", en: "A ticket's parts (shots and the like) and their stages." },
  submissions: { zh: "每一次交付：交了哪些文件、检查结果、审查结论、结局（放行、退回、返工）。", en: "Every hand-over: files, check results, review verdicts, and what became of it (approved, sent back, rework)." },
  acceptance_checks: { zh: "规划的验收检查：kind、路径或命令、谁定的（origin）、是否确认。", en: "A plan's acceptance checks: kind, path or command, who defined it (origin), whether confirmed." },
  acceptance_check_runs: { zh: "每次检查跑出的结果：outcome（pass / fail / error / blocked）、detail、时间。", en: "Each check run: outcome (pass / fail / error / blocked), detail, time." },
  requirements: { zh: "需求台账：每条要求站在你的原话上（quote）、转述、类别、作用范围、说过几次、状态。", en: "The requirements ledger: each requirement on your own words (quote), restated, category, scope, times said, status." },
  delegations: { zh: "Bot 之间的委派：谁请谁做什么、在等什么、交回了没有。", en: "Delegations between Bots: who asked whom for what, what is awaited, whether it came back." },
  work_events: { zh: "工作记录，只追加：kind 是事件种类（如 submission.gates_failed、complaint.rework、control.hold、prompt.parse_failed），payload 是 JSON。", en: "The append-only work log: kind names the event (e.g. submission.gates_failed, complaint.rework, control.hold, prompt.parse_failed), payload is JSON." },
  quality_events: { zh: "出了问题的事件按类归档：category 是 execution / unclear / model / pipeline / review_miss / orchestration。", en: "What went wrong, by category: execution / unclear / model / pipeline / review_miss / orchestration." },
  lessons: { zh: "应用记下的教训：命令超时的拦截规则、反思提出的清单项和检查，status 是候选、生效或停用。", en: "Lessons: timed-out command rules, checklist items and checks from reflections; status candidate, active or retired." },
  reflections: { zh: "收窄的反思：误放行或卡在能力天花板后，当事 Bot 提了什么。", en: "Narrowed reflections: what a Bot proposed after an overturned approval or a ceiling." },
  retrospectives: { zh: "完工复盘：哪个 Bot、哪件事、总结、发现、对记忆和技能的改动和结局。", en: "Retrospectives: Bot, job, summary, findings, and the changes to memories and skills with what became of them." },
  memories: { zh: "每个 Bot 的记忆：subject、body、enabled。只能读；不要把别的 Bot 的记忆抄成你自己的，除非用户要。", en: "Each Bot's memories: subject, body, enabled. Read-only; do not copy another Bot's memory into yours unless the user asks." },
  skills: { zh: "每个 Bot 的技能：name、description、body、enabled。", en: "Each Bot's skills: name, description, body, enabled." },
  shared_skills: { zh: "你共享给所有 Bot 的项目技能。", en: "Project skills you shared with every Bot." },
  organizer_runs: { zh: "整理跳每一次调模型：原始答案、决定、落没落地、没落地的原因。", en: "Each organizer call: raw answer, decision, whether it landed and why not." },
  judgements: { zh: "群里没点名时每个 Bot 的下场 / 旁观判断和理由。", en: "Each Bot's join / pass judgement on an unmentioned group line, with its reason." },
  spend: { zh: "花费账本，每次端点调用一行：kind / purpose、模型、token、实报或估算的金额。", en: "The spend ledger, one row per endpoint call: kind / purpose, model, tokens, reported or estimated cost." },
  approvals: { zh: "批准卡：kind_key、要做的事（summary / target）、status（pending / allowed_once / denied / voided）。", en: "Approval cards: kind_key, what was asked (summary / target), status (pending / allowed_once / denied / voided)." },
  holds: { zh: "叫停：范围、谁叫的、何时解除。", en: "Holds: scope, who made them, when lifted." },
  check_backs: { zh: "回看与等待：谁约的、何时到、核对什么、结局。", en: "Check-backs and waits: who booked them, when due, what to verify, what happened." },
  routines: { zh: "日程：标题、要做的事、时间表、挂在哪个 Bot 上。", en: "Routines: title, instruction, schedule, Bot." },
  annotations: { zh: "你在产物上写的批注：路径、位置、意见、状态。", en: "Your annotations on artifacts: path, anchor, comment, status." },
  prompt_overrides: { zh: "你改过的内置提示词（ADR 0064）：现在的全文、它依据的默认、冲突时的新默认。", en: "Built-in prompts you edited (ADR 0064): the text in force, the default it stands on, a newer default in conflict." },
  prompt_revisions: { zh: "内置提示词的每一次修改：谁（你 / Bot / 应用）、为什么、前后全文、经哪张批准卡。", en: "Every change to a built-in prompt: who (you / a Bot / the app), why, before and after, through which approval card." },
};

export function tableNote(name: string, locale: Locale): string | null {
  return TABLE_NOTES[name]?.[locale] ?? null;
}
