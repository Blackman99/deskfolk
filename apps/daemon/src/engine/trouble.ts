/**
 * Trouble inside a turn that steps its job up (ADR 0054): tool arguments that were not JSON twice in
 * a row, or the same tool called wrongly three times in a row. Pure counting; the turn loop acts on it.
 */
import type { TurnTrouble } from "../store/escalation";

export const MALFORMED_IN_ROW = 2;
export const SAME_TOOL_FAILS_IN_ROW = 3;

/**
 * The failures that are the model's own doing: arguments the tool cannot take, a call it was refused
 * (a guard, a lesson), a tool for the lead it is not, a mention of nobody, a tool that does not exist.
 * Everything else — a missing file, a timeout, an MCP server's error or quota, a hold, your denial, a
 * call replayed after a restart (`repeated_effect`) — can happen to any model and says nothing about this one.
 */
const THE_MODELS = new Set(["invalid_args", "refused", "use_delegate", "unknown_mention"]);

export function modelsMistake(code: string | undefined, message: string | undefined): boolean {
  return Boolean(code && THE_MODELS.has(code)) || (code === "failed" && Boolean(message?.startsWith("unknown tool:")));
}

export type TroubleCount = { malformed: number; tool: string | null; fails: number };

export function troubleCount(): TroubleCount {
  return { malformed: 0, tool: null, fails: 0 };
}

/** Arguments that are not a JSON object; an empty string is a call with none, which is fine. */
export function malformedArguments(raw: string): boolean {
  if (raw.trim() === "") return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return !parsed || typeof parsed !== "object" || Array.isArray(parsed);
  } catch {
    return true;
  }
}

/** One call's arguments read; the trouble it makes, if any. */
export function noteArguments(count: TroubleCount, raw: string): TurnTrouble | null {
  count.malformed = malformedArguments(raw) ? count.malformed + 1 : 0;
  return count.malformed === MALFORMED_IN_ROW ? "malformed_tool_json" : null;
}

/** One call's outcome; the trouble it makes, if any. A failure that is not the model's mistake leaves the count as it was. */
export function noteOutcome(count: TroubleCount, tool: string, ok: boolean, error?: { code?: string; message?: string }): TurnTrouble | null {
  if (ok) {
    count.tool = null;
    count.fails = 0;
    return null;
  }
  if (!modelsMistake(error?.code, error?.message)) return null;
  count.fails = count.tool === tool ? count.fails + 1 : 1;
  count.tool = tool;
  return count.fails === SAME_TOOL_FAILS_IN_ROW ? "tool_failures" : null;
}
