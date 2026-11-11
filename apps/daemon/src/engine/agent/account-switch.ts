/**
 * A Claude Agent turn going on on another account (ADR 0110). Claude Code keeps a session's
 * conversation under the account it runs on, so the next account starts a fresh session; what the
 * one before it did in this turn comes along as an app note — its calls, what they returned, what
 * it said — read from the turn's loop. The files and command results are still on disk.
 */
import type { Locale } from "@real-bot/protocol";
import type { ChatMessage } from "../../completions";

/** When an account's limit said nothing of its reset: tried again after this long, never scheduled on. */
export const LIMIT_GUESS_MS = 60 * 60_000;
/** A resume fires this long after the reset it waits for, so the plan has turned over by then. */
export const RESUME_MARGIN_MS = 60_000;

/** A reset as an agent reports it (seconds, or ms from some versions) in ms; null when it said none. */
export function resetMs(resetsAt: number | null | undefined): number | null {
  return typeof resetsAt === "number" && resetsAt > 0 ? resetsAt * (resetsAt < 1e12 ? 1000 : 1) : null;
}

/** How much of the session before comes along: the latest steps first to stay. */
const CARRY_MAX = 6_000;
const CALL_MAX = 160;
const RESULT_MAX = 240;
const SAID_MAX = 400;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const points = [...flat];
  return points.length > max ? `${points.slice(0, max).join("")}…` : flat;
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n");
}

/** The session before, step by step, as short lines. */
function steps(rows: readonly ChatMessage[], en: boolean): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.role === "assistant") {
      const said = textOf(row.content).trim();
      if (said) lines.push(`- ${en ? "You said" : "你说"}：${clip(said, SAID_MAX)}`);
      for (const call of row.tool_calls ?? []) lines.push(`- ${call.name} ${clip(call.arguments, CALL_MAX)}`);
    } else if (row.role === "tool") {
      const out = textOf(row.content).trim();
      if (out) lines.push(`  → ${clip(out, RESULT_MAX)}`);
    } else if (row.role === "user") {
      const note = textOf(row.content).trim();
      if (note) lines.push(`- ${en ? "Read" : "读到"}：${clip(note, RESULT_MAX)}`);
    }
  }
  return lines;
}

/**
 * The note the next session starts with: the account before ran out, and what it did. With nothing
 * done yet, only that the account changed.
 */
export function carryNote(locale: Locale, rows: readonly ChatMessage[]): string {
  const en = locale === "en";
  const head = en
    ? "(App note) The Claude account this turn was running on reached its usage limit, so it goes on in a new session on another of the user's accounts."
    : "（应用提示）这一轮原先用的 Claude 账号用量额度用完了，现在换了用户的另一个账号、开了新会话接着做。";
  const lines = steps(rows, en);
  if (lines.length === 0) return head;
  const kept: string[] = [];
  let size = 0;
  for (let at = lines.length - 1; at >= 0; at--) {
    size += lines[at]!.length + 1;
    if (size > CARRY_MAX) break;
    kept.unshift(lines[at]!);
  }
  const dropped = lines.length - kept.length;
  const more = dropped > 0 ? [en ? `(${dropped} earlier lines left out)` : `（前面还有 ${dropped} 行没列出）`] : [];
  return [
    head,
    en
      ? "What the session before did in this turn (its files and command results are still there; do not redo them):"
      : "上一个会话在这一轮里已经做了这些（文件和命令的结果都还在，不要重做）：",
    ...more,
    ...kept,
    en ? "Pick up where it stopped." : "从断掉的地方接着做。",
  ].join("\n");
}
