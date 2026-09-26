/**
 * The closing check: before a turn hands a delivery to the user, one short tool-less call reads
 * the job's opening request, what the job has handed over, who did what, and the closing message,
 * and names what is neither delivered nor accounted for. The engine hands that list back to the
 * Bot once — as a failed `send_message` or as a line in the loop — and lets the next reply through
 * whatever it says. It is a nudge with evidence, not a gate: no brief, no default model, an
 * unreadable verdict or a refused call all let the delivery through.
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

根据用户消息这份 JSON 决定：ticket 是这一轮要做的那个任务（title 和 spec），没有就是 null；plan 是这件事的规划（goal 目标、acceptance 验收、rules 规则），没有就是 null；brief 是开头那条要求的原文；reply 是这个 Bot 准备发出的收尾消息；deliveries 是这件事已交出的文件，每条有 path 和 excerpt（长文件只给开头，二进制文件没有 excerpt），这一轮交出的排在前面；so_far 是这件事里谁做了什么。

只输出一个 JSON 对象：{"unaddressed": [{"text": "…", "why": "…"}]}。不要 markdown 围栏，不要前言后语，不要 tool-call。

unaddressed 列的是：这一轮该交的东西里，deliveries 里看不到做到、reply 里也没有交代去向的项。标准按这个顺序取：有 ticket 就按 ticket.spec 和 plan.acceptance、plan.rules；没有 ticket 就按 plan；没有 plan 才按 brief。text 是要求的原话或紧贴原话的概括，why 一句话说明为什么算没交代。

策略：只认看得见的证据，Bot 说「已完成」不算。reply 里明确说了交给谁、为什么不做、或什么时候做的，不算 unaddressed；so_far 里别人已经做完的、属于别的任务的，不算。标准里没提的不要补成要求；寒暄和没有交付物的要求不列。拿不准就不列。没有就返回 {"unaddressed": []}。`;

/** How much of one handed-over file the check reads. */
export const CLOSING_EXCERPT_LIMIT = 3000;
/** Files the check sees: this turn's first, then the job's earlier ones. */
export const CLOSING_DELIVERIES_LIMIT = 12;
/** How much of the closing message the check reads. */
export const CLOSING_REPLY_LIMIT = 3000;
/** Items handed back to the Bot; more than this is a rewrite, not a nudge. */
export const CLOSING_ITEMS_LIMIT = 6;
/** First-byte timeout for the check: the user is waiting on this turn. */
export const CLOSING_CHECK_TIMEOUT_MS = 30_000;

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
  return {
    brief: brief || null,
    plan,
    ticket,
    reply: takeCodePoints(input.reply, CLOSING_REPLY_LIMIT).text,
    deliveries,
    so_far: facts?.trace ?? [],
  };
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
      "Closing check: against the job's opening request, these are neither delivered nor accounted for in your closing message:",
      ...lines,
      "Deliver them, or say who takes them, why not, or when, then close. This is the one reminder this turn.",
    ].join("\n");
  }
  return [
    "收尾自检：对照这件事最初的要求，下面这些既没有交出，收尾里也没有交代去向：",
    ...lines,
    "补上，或在收尾里说明交给谁、为什么不交、什么时候做，再结束。这一轮只提示这一次。",
  ].join("\n");
}
