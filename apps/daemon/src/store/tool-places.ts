/**
 * Where each tool call of a Bot's turn worked (ADR 0097), for the task map. A row is made as the
 * call starts, or as its card opens when the card comes first (a Claude Agent turn asks before its
 * call starts), and closed as it ends; it holds the place read from the call's arguments, never the
 * arguments. The replay reads a conversation's rows back with your answers on their cards.
 */
import type { AgentShellAction, AgentToolPlace, SessionReplay, SessionReplayCall, SessionReplayLine } from "@real-bot/protocol";
import { isoNow, ulid } from "../ids";
import { type StoreContext } from "./shared";

/**
 * Rows kept per session. A long job is a few thousand calls (one music video took 888 steps); past
 * this the oldest go, a few at a time rather than on every write.
 */
export const TOOL_PLACES_KEPT_PER_SESSION = 20_000;
/** The most calls a replay carries, newest kept. */
export const REPLAY_CALLS_MAX = 5_000;

export type ToolPlaceRow = {
  id: string;
  session_id: string;
  turn_id: string;
  bot_id: string;
  task_id: string | null;
  ticket_id: string | null;
  tool_call_id: string;
  tool: string;
  place: string;
  action: string | null;
  file: string | null;
  model: string | null;
  approval_id: string | null;
  started_at: string;
  finished_at: string | null;
  ok: number | null;
  error_code: string | null;
  duration_ms: number | null;
};

export type ToolPlaceStart = {
  turnId: string;
  toolCallId: string;
  tool: string;
  place: AgentToolPlace;
  action?: AgentShellAction | null;
  file?: string | null;
  model?: string | null;
  at?: string;
};

type TurnOwner = { session_id: string; bot_id: string; task_id: string | null; ticket_id: string | null };

let writes = 0;

function prune(ctx: StoreContext, sessionId: string): void {
  const edge = ctx.db
    .query<{ started_at: string; id: string }, [string, number]>(
      `SELECT started_at, id FROM tool_places WHERE session_id = ? ORDER BY started_at DESC, id DESC LIMIT 1 OFFSET ?`,
    )
    .get(sessionId, TOOL_PLACES_KEPT_PER_SESSION);
  if (edge) ctx.db.run(`DELETE FROM tool_places WHERE session_id = ? AND (started_at, id) <= (?, ?)`, [sessionId, edge.started_at, edge.id]);
}

/**
 * A call starting: its row, made or brought up to date. A row its card made first takes the
 * call's own place, model and start, and is open again until the call ends. Null for a turn the
 * store does not hold (a scenario's own events).
 */
export function beginToolPlace(ctx: StoreContext, input: ToolPlaceStart): ToolPlaceRow | null {
  const turn = ctx.db
    .query<TurnOwner, [string]>(`SELECT session_id, bot_id, task_id, ticket_id FROM turns WHERE id = ?`)
    .get(input.turnId);
  if (!turn) return null;
  const at = input.at ?? isoNow();
  const row = ctx.db
    .query<ToolPlaceRow, Array<string | null>>(
      `INSERT INTO tool_places (id, session_id, turn_id, bot_id, task_id, ticket_id, tool_call_id, tool, place, action, file, model, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (turn_id, tool_call_id) DO UPDATE SET tool = excluded.tool, place = excluded.place, action = excluded.action,
         file = excluded.file, model = COALESCE(excluded.model, tool_places.model), started_at = excluded.started_at,
         finished_at = NULL, ok = NULL, error_code = NULL, duration_ms = NULL
       RETURNING *`,
    )
    .get(ulid(Date.parse(at)), turn.session_id, input.turnId, turn.bot_id, turn.task_id, turn.ticket_id, input.toolCallId, input.tool,
      JSON.stringify(input.place), input.action ?? null, input.file ?? null, input.model ?? null, at)!;
  if (++writes % 200 === 0) prune(ctx, turn.session_id);
  return row;
}

/** A call ending, or its card answered: how it came out. A later end (the call run after its card) wins. */
export function finishToolPlace(
  ctx: StoreContext,
  input: { turnId: string; toolCallId: string; ok: boolean; errorCode?: string | null; durationMs?: number | null; at?: string },
): ToolPlaceRow | null {
  return ctx.db
    .query<ToolPlaceRow, Array<string | number | null>>(
      `UPDATE tool_places SET finished_at = ?, ok = ?, error_code = ?, duration_ms = COALESCE(?, duration_ms)
       WHERE turn_id = ? AND tool_call_id = ? RETURNING *`,
    )
    .get(input.at ?? isoNow(), input.ok ? 1 : 0, input.errorCode ?? null, input.durationMs ?? null, input.turnId, input.toolCallId) ?? null;
}

/**
 * The card you are asked on for a call: tied to its row, or a row made for it when the card comes
 * before the call starts, at the place the card names, so a call you refuse is still on the map.
 */
export function cardForToolPlace(
  ctx: StoreContext,
  input: { turnId: string; toolCallId: string; approvalId: string; fallback: Omit<ToolPlaceStart, "turnId" | "toolCallId"> },
): void {
  const linked = ctx.db.run(`UPDATE tool_places SET approval_id = ? WHERE turn_id = ? AND tool_call_id = ?`, [input.approvalId, input.turnId, input.toolCallId]);
  if (linked.changes > 0) return;
  if (!beginToolPlace(ctx, { turnId: input.turnId, toolCallId: input.toolCallId, ...input.fallback })) return;
  ctx.db.run(`UPDATE tool_places SET approval_id = ? WHERE turn_id = ? AND tool_call_id = ?`, [input.approvalId, input.turnId, input.toolCallId]);
}

function placeOf(raw: string): AgentToolPlace {
  try {
    const place = JSON.parse(raw) as AgentToolPlace;
    return place && typeof place === "object" && typeof place.zone === "string" ? place : { zone: "none" };
  } catch {
    return { zone: "none" };
  }
}

/** What your answer on a call's card was, in the replay's words; the app's own refusals as its rules. */
function decisionOf(row: ToolPlaceRow & { approval_status: string | null }): SessionReplayCall["decision"] {
  if (row.approval_status === "allowed_once") return { decision: "accept", source: "user_temporary", reason_type: null };
  if (row.approval_status === "denied") return { decision: "reject", source: "user_reject", reason_type: null };
  if (row.ok === 0 && (row.error_code === "held" || row.error_code === "denied" || row.error_code === "readonly")) {
    return { decision: "reject", source: "hook", reason_type: row.error_code };
  }
  return null;
}

/**
 * Your lines in a conversation, and your answers to its Bots' questions, oldest first. An answer is
 * written on the question itself (`ask_answer`); a line of yours taken as one is that answer, and a
 * line the app carried out itself (a stop, a status question) asked nothing of the Bots.
 */
function saidIn(ctx: StoreContext, sessionId: string): SessionReplayLine[] {
  const rows = ctx.db
    .query<{ kind: string; author: string; body: string; ask_answer: string | null; created_at: string }, [string]>(
      `SELECT kind, author, body, ask_answer, created_at FROM messages
       WHERE session_id = ? AND bot_only = 0 AND withdrawn_at IS NULL
         AND ((kind = 'user' AND taken_as IS NULL) OR (kind = 'ask' AND ask_answer IS NOT NULL))
       ORDER BY created_at, message_seq, id`,
    )
    .all(sessionId);
  const out: SessionReplayLine[] = [];
  for (const row of rows) {
    if (row.kind === "user") {
      out.push({ kind: "say", at: row.created_at, text: row.body });
      continue;
    }
    let answer: { selected?: unknown; custom?: unknown; answered_at?: unknown };
    try {
      answer = JSON.parse(row.ask_answer!) as typeof answer;
    } catch {
      continue;
    }
    const answers = [...(Array.isArray(answer.selected) ? answer.selected.filter((x): x is string => typeof x === "string") : []),
      ...(typeof answer.custom === "string" && answer.custom.trim() ? [answer.custom] : [])];
    const at = typeof answer.answered_at === "string" ? answer.answered_at : row.created_at;
    out.push({ kind: "answer", at, asked_at: row.created_at, questions: [row.body], answers, bot_id: row.author });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** A conversation's calls for the task map, newest REPLAY_CALLS_MAX at most, oldest first. */
export function sessionReplay(ctx: StoreContext, sessionId: string): SessionReplay {
  const rows = ctx.db
    .query<ToolPlaceRow & { approval_status: string | null }, [string, number]>(
      `SELECT p.*, a.status AS approval_status FROM tool_places p LEFT JOIN approvals a ON a.id = p.approval_id
       WHERE p.session_id = ? ORDER BY p.started_at DESC, p.id DESC LIMIT ?`,
    )
    .all(sessionId, REPLAY_CALLS_MAX + 1);
  const truncated = rows.length > REPLAY_CALLS_MAX;
  const kept = rows.slice(0, REPLAY_CALLS_MAX).reverse();
  const bots: string[] = [];
  const calls = kept.map((row): SessionReplayCall => {
    if (!bots.includes(row.bot_id)) bots.push(row.bot_id);
    const started = Date.parse(row.started_at);
    const finished = row.finished_at ? Date.parse(row.finished_at) : NaN;
    return {
      id: row.tool_call_id,
      at: row.started_at,
      bot_id: row.bot_id,
      turn_id: row.turn_id,
      task_id: row.task_id,
      tool: row.tool,
      place: placeOf(row.place),
      ...(row.action ? { action: row.action as AgentShellAction } : {}),
      model: row.model,
      file: row.file,
      // A call still open has not failed; a refused one never ran.
      ok: row.ok !== 0,
      duration_ms: row.duration_ms ?? (Number.isFinite(finished) ? Math.max(0, finished - started) : 0),
      decision: decisionOf(row),
    };
  });
  return { session_id: sessionId, calls, bots, said: saidIn(ctx, sessionId), truncated };
}
