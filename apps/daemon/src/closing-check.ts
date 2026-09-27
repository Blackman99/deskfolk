/**
 * The closing check: before a turn hands a delivery to the user, one short tool-less call reads
 * the job's opening request, what the job has handed over, who did what, and the closing message,
 * and names what is neither delivered nor accounted for. The engine hands that list back to the
 * Bot once — as a failed `send_message` or as a line in the loop — and lets the next reply through
 * whatever it says. It is a nudge with evidence, not a gate: no brief, no default model, an
 * unreadable verdict or a refused call all let the delivery through.
 *
 * A closing message that says the work is still going ("checking the 18 frames, conclusion to
 * follow") is checked too, cited files or not: the turn ends when it goes out, so "later" only
 * happens when a check-back is booked or someone named takes it. A reviewer once closed that way
 * and the group waited on a conclusion nothing was going to write.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { Locale } from "@real-bot/protocol";
import { planFacts } from "./context";
import { extractJsonObject } from "./route-agent";
import type { Store } from "./store";
import { takeCodePoints } from "./text";
import { classifyPath } from "./workspace-paths";

export const CLOSING_CHECK_SYSTEM = `你在替一个 Bot 做收尾自检，不是回答用户，也不能发言。没有工具，不能读工作区。

根据用户消息这份 JSON 决定：ticket 是这一轮要做的那个任务（title 和 spec），没有就是 null；plan 是这件事的规划（goal 目标、acceptance 验收、rules 规则），没有就是 null；brief 是开头那条要求的原文；reply 是这个 Bot 准备发出的收尾消息；deliveries 是这件事已交出的文件，每条有 path 和 excerpt（长文件只给开头，二进制文件没有 excerpt），这一轮交出的排在前面；so_far 是这件事里谁做了什么；ran 是真正执行过的命令和工具调用（this_turn 为 true 的是这一轮的，其余是这件事里之前的轮），每条有 command、exit_code、ok；check_back 是这个 Bot 在这个会话里约好的回看（note 回看时做什么，due_at 什么时候），没约就是 null。

只输出一个 JSON 对象：{"unaddressed": [{"text": "…", "why": "…"}]}。不要 markdown 围栏，不要前言后语，不要 tool-call。

unaddressed 列两类：一是这一轮该交的东西里，deliveries 里看不到做到、reply 里也没有交代去向的项。标准按这个顺序取：有 ticket 就按 ticket.spec 和 plan.acceptance、plan.rules；没有 ticket 就按 plan；没有 plan 才按 brief。text 是要求的原话或紧贴原话的概括，why 一句话说明为什么算没交代。二是没有执行记录的声明：reply 或这一轮交出的文件里说已经跑过、测过、构建过、验证过、量出过数字的（例如「测试全部通过」「构建 0 错误」「在浏览器里验证了导出」「音画偏差 ≤33ms」「21/21 通过」），在 ran 里找不到对应的命令或工具调用，或者对应的那次失败了（ok 为 false 或 exit_code 不是 0），就列出来：text 写那句声明，why 写「ran 里没有对应的执行记录」或「对应的那次执行失败了」。要浏览器、真机或人工才能验证的，ran 里没有做得到的工具调用，一律算找不到。明确写了「未验证」「没跑」并说明原因的不列。

策略：只认看得见的证据，Bot 说「已完成」不算。reply 里明确说了交给谁（点了名的人）、为什么不做、或在等谁的什么东西的，不算 unaddressed；so_far 里别人已经做完的、属于别的任务的，不算。reply 一发出这一轮就结束，没有人会替它接着做：reply 说自己「正在做」「随后 / 稍后给出」「结论后补」的事，只有 check_back 不为 null 且 note 对得上、或 reply 点名交给了别人，才算交代；否则把那件事列出来，why 写「这一轮发出就结束，没约回看也没交给别人」。标准里没提的不要补成要求；寒暄和没有交付物的要求不列。第一类拿不准就不列；第二类只看 ran，对不上就列。没有就返回 {"unaddressed": []}。`;

/** How much of one handed-over file the check reads. */
export const CLOSING_EXCERPT_LIMIT = 3000;
/** Files the check sees: this turn's first, then the job's earlier ones. */
export const CLOSING_DELIVERIES_LIMIT = 12;
/** How much of the closing message the check reads. */
export const CLOSING_REPLY_LIMIT = 3000;
/** Items handed back to the Bot; more than this is a rewrite, not a nudge. */
export const CLOSING_ITEMS_LIMIT = 6;
/** Runs the check sees: this turn's, then the job's earlier ones, newest first among those. */
export const CLOSING_RUNS_LIMIT = 40;
const CLOSING_RUN_COMMAND_MAX = 200;
/** First-byte timeout for the check: the user is waiting on this turn. */
export const CLOSING_CHECK_TIMEOUT_MS = 30_000;
/** Room for up to six items with their reasons, after a reasoning model's thinking. */
export const CLOSING_CHECK_MAX_TOKENS = 1536;

/**
 * Words a closing message uses when the work is still going. A match only means "check this reply
 * too"; the judge decides whether anything is left hanging, so a storyboard line that happens to
 * say 随后 costs one short call and nothing else.
 */
const LATER_WORK =
  /随后|稍后|稍候|回头|待会|过会|晚些|晚点|结论后补|后续再|马上(就)?(给|发|补|出)|正在(逐|进行|核|检|审|处理|生成|渲染|排查|分析|比对|确认|整理|跑)|\b(?:to follow|shortly|in a (?:moment|bit|few minutes)|stay tuned)\b|\bI(?:'ll| will) (?:follow up|get back|report back|post|share|send)\b|\bI'm (?:now )?(?:checking|reviewing|verifying|comparing|working on)\b/i;

/** Whether a closing message says it is still working on something it has not handed over. */
export function promisesLaterWork(text: string): boolean {
  return LATER_WORK.test(text);
}

/** File kinds whose contents the check can read; anything else is named by path only. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css",
  ".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".rb", ".sh", ".sql", ".svg", ".tex", ".rst",
]);
const EXCERPT_BYTES = 64 * 1024;

export type ClosingCheckPayload = {
  brief: string | null;
  plan: { goal: string; acceptance: string[]; rules: string[] } | null;
  ticket: { title: string; spec: string } | null;
  reply: string;
  deliveries: Array<{ path: string; excerpt: string | null; truncated?: true }>;
  so_far: string[];
  /** What was actually run: this turn's commands and MCP calls, then the job's earlier ones. */
  ran: Array<{ by: string; this_turn: boolean; command: string; exit_code: number | null; ok: boolean; error?: string }>;
  check_back: { note: string; due_at: string } | null;
};

export type ClosingItem = { text: string; why: string };

/**
 * The head of a workspace file, for a judge that only has to recognise what is in it. Null for a
 * path outside the workspace, a missing file, or a kind whose bytes are not text.
 */
export function deliveryExcerpt(root: string, relpath: string, limit: number = CLOSING_EXCERPT_LIMIT): { excerpt: string | null; truncated: boolean } {
  if (!TEXT_EXTENSIONS.has(extname(relpath).toLowerCase())) return { excerpt: null, truncated: false };
  const classified = classifyPath(root, relpath);
  if (classified.zone !== "inside" || !existsSync(classified.abs)) return { excerpt: null, truncated: false };
  try {
    const size = statSync(classified.abs).size;
    const buffer = Buffer.alloc(Math.min(size, EXCERPT_BYTES));
    const fd = openSync(classified.abs, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      closeSync(fd);
    }
    const clipped = takeCodePoints(buffer.toString("utf8"), limit);
    return { excerpt: clipped.text, truncated: clipped.truncated || size > buffer.length };
  } catch {
    return { excerpt: null, truncated: false };
  }
}

/**
 * What the check reads. Null when the job has no opening request to check against. This turn's
 * files come first, then what the job had already handed over, so the judge sees the delivery it
 * is asked about before the context.
 */
export function closingCheckPayload(
  store: Store,
  input: {
    taskId: string;
    ticketId?: string | null;
    turnId: string;
    botId: string;
    sessionId: string;
    reply: string;
    paths: readonly string[];
    locale: Locale;
  },
): ClosingCheckPayload | null {
  let brief: string;
  try {
    brief = (store.getTask(input.taskId).brief ?? "").trim();
  } catch {
    return null;
  }
  const facts = planFacts(store, {
    taskId: input.taskId,
    ticketId: input.ticketId ?? null,
    turnId: input.turnId,
    triggerMessageId: null,
    botId: input.botId,
    sessionId: input.sessionId,
    locale: input.locale,
  });
  const plan = facts?.goal ? { goal: facts.goal, acceptance: facts.acceptance, rules: facts.rules } : null;
  const ticket = facts?.ticket ? { title: facts.ticket.title, spec: facts.ticket.spec } : null;
  if (!brief && !plan) return null;
  const root = store.workspacePath();
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const path of input.paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    ordered.push(path);
  }
  for (const path of facts?.artifacts ?? []) {
    if (seen.has(path)) continue;
    seen.add(path);
    ordered.push(path);
  }
  const deliveries = ordered.slice(0, CLOSING_DELIVERIES_LIMIT).map((path) => {
    const head = root ? deliveryExcerpt(root, path) : { excerpt: null, truncated: false };
    return head.truncated ? { path, excerpt: head.excerpt, truncated: true as const } : { path, excerpt: head.excerpt };
  });
  let booked: { note: string; due_at: string } | null = null;
  try {
    const row = store.pendingCheckBack(input.botId, input.sessionId);
    if (row) booked = { note: row.note, due_at: row.due_at };
  } catch {
    booked = null;
  }
  return {
    brief: brief || null,
    plan,
    ticket,
    reply: takeCodePoints(input.reply, CLOSING_REPLY_LIMIT).text,
    deliveries,
    so_far: facts?.trace ?? [],
    ran: closingRuns(store, input.taskId, input.turnId),
    check_back: booked,
  };
}

/** This turn's runs, then as many of the job's earlier ones as fit, so a claim can be held against a run. */
function closingRuns(store: Store, taskId: string, turnId: string): ClosingCheckPayload["ran"] {
  const names = new Map<string, string>();
  const nameOf = (id: string): string => {
    if (!names.has(id)) {
      try {
        names.set(id, store.getBot(id).name);
      } catch {
        names.set(id, id);
      }
    }
    return names.get(id)!;
  };
  let mine: ReturnType<Store["turnRuns"]> = [];
  let earlier: ReturnType<Store["turnRuns"]> = [];
  try {
    mine = store.turnRuns(turnId).slice(-CLOSING_RUNS_LIMIT);
    earlier = store
      .taskRunsSince(taskId, "", CLOSING_RUNS_LIMIT * 2)
      .filter((run) => run.turn_id !== turnId)
      .slice(-(CLOSING_RUNS_LIMIT - mine.length));
  } catch {
    return [];
  }
  return [...mine.map((run) => ({ run, thisTurn: true })), ...earlier.map((run) => ({ run, thisTurn: false }))]
    .slice(0, CLOSING_RUNS_LIMIT)
    .map(({ run, thisTurn }) => {
      const item: ClosingCheckPayload["ran"][number] = {
        by: nameOf(run.bot_id),
        this_turn: thisTurn,
        command: takeCodePoints(run.command, CLOSING_RUN_COMMAND_MAX).text,
        exit_code: run.exit_code,
        ok: run.ok === 1,
      };
      if (run.error) item.error = takeCodePoints(run.error, 120).text;
      return item;
    });
}

/** The verdict's list, or null when the answer is not in the shape asked for (which lets the delivery through). */
export function parseClosingCheck(raw: string): ClosingItem[] | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.unaddressed)) return null;
  const items: ClosingItem[] = [];
  for (const entry of parsed.unaddressed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    const why = typeof row.why === "string" ? row.why.replace(/\s+/g, " ").trim() : "";
    items.push({ text, why });
  }
  return items.slice(0, CLOSING_ITEMS_LIMIT);
}

/** The one line the Bot gets back, in the turn's locale. */
export function closingCheckNote(locale: Locale, items: readonly ClosingItem[]): string {
  const lines = items.map((item) => `- ${item.text}${item.why ? (locale === "en" ? ` (${item.why})` : `（${item.why}）`) : ""}`);
  if (locale === "en") {
    return [
      "Closing check: against the job's opening request, these are neither delivered nor accounted for in your closing message, or are claims with no run behind them:",
      ...lines,
      "Deliver them now; for what you cannot, say in the closing who takes it or why not; anything you will only finish later needs a check_back booked first (the turn ends when the reply goes out). A claim with no run: run it now, or say plainly that it was not verified and why (for instance, nothing here can drive a browser). Then close. This is the one reminder this turn.",
    ].join("\n");
  }
  return [
    "收尾自检：对照这件事最初的要求，下面这些既没有交出、收尾里也没有交代去向，或者是说做过却没有执行记录的声明：",
    ...lines,
    "现在补上；做不了的在收尾里说明交给谁、为什么不交；非要以后再做的先用 check_back 约回看（收尾一发出这一轮就结束）。没有执行记录的声明：现在去跑，跑不了就在收尾里写明「未验证」和原因（比如这里没有能开浏览器的工具）。然后再收尾。这一轮只提示这一次。",
  ].join("\n");
}
