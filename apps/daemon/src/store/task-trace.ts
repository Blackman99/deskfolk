/** A job's flow board read model: its turns, messages, files and approvals in order. */
import { INTERRUPT_NOTE_BODY, USER_MEMBER, type TaskTrace, type TaskTraceNode, type TurnStatus } from "@real-bot/protocol";
import type { StoreContext } from "./shared";
import { getTask, isReservedTaskPath, oneLine } from "./tasks";

type TraceTurnRow = {
  id: string;
  session_id: string;
  bot_id: string;
  status: TurnStatus;
  trigger_message_id: string;
  partial_text: string | null;
  ticket_id: string | null;
  created_at: string;
  trigger_body: string;
  trigger_created_at: string;
  trigger_turn_id: string | null;
  trigger_author: string;
  trigger_kind: string;
};

type TraceMessageRow = {
  id: string;
  turn_id: string;
  kind: string;
  body: string;
  created_at: string;
};

type TraceAttachmentRow = {
  id: string;
  message_id: string;
  turn_id: string;
  path: string;
  created_at: string;
};

type TraceApprovalRow = {
  turn_id: string;
  message_id: string | null;
  summary: string | null;
};

/**
 * The turns that share this plan, oldest first, each with what it handed over.
 *
 * A card is a turn. The edge into it is the turn that wrote its trigger; a trigger nobody's turn
 * wrote is you, so the trace grows a card for that message and points the woken turns at it.
 * A Bot woken by another Bot grows no such card — the waking turn is already on the board — and
 * neither does a routine firing, whose trigger is the app's system line.
 */
export function taskTrace(ctx: StoreContext, taskId: string): TaskTrace {
  const task = getTask(ctx, taskId);
  const turns = ctx.db
    .query<TraceTurnRow, [string]>(
      `SELECT t.id, t.session_id, t.bot_id, t.status, t.trigger_message_id, t.partial_text, t.ticket_id, t.created_at,
              m.body AS trigger_body, m.created_at AS trigger_created_at,
              m.turn_id AS trigger_turn_id, m.author AS trigger_author, m.kind AS trigger_kind
       FROM turns t
       JOIN messages m ON m.id = t.trigger_message_id
       WHERE t.task_id = ?
       ORDER BY t.created_at ASC, t.id ASC`,
    )
    .all(taskId);
  const turnIds = new Set(turns.map((turn) => turn.id));

  const spoken = ctx.db
    .query<TraceMessageRow, [string]>(
      `SELECT id, turn_id, kind, body, created_at FROM messages
       WHERE task_id = ? AND turn_id IS NOT NULL AND kind IN ('bot', 'ask', 'system')
       ORDER BY created_at ASC, id ASC`,
    )
    .all(taskId);
  const lastWord = new Map<string, TraceMessageRow>();
  const askByTurn = new Map<string, TraceMessageRow>();
  // The 中断 line is what a cut turn leaves behind. It is written after the last word, so a
  // card that still points at that word lands one row above the note it is about.
  const interruptByTurn = new Map<string, TraceMessageRow>();
  for (const row of spoken) {
    if (!turnIds.has(row.turn_id)) continue;
    if (row.kind === "bot") lastWord.set(row.turn_id, row);
    else if (row.kind === "ask") askByTurn.set(row.turn_id, row);
    else if (row.body === INTERRUPT_NOTE_BODY) interruptByTurn.set(row.turn_id, row);
  }

  const attachments = ctx.db
    .query<TraceAttachmentRow, [string]>(
      // Keyed off this plan's turns rather than the message's own plan: a message written before
      // plans existed carries none, and its files would vanish from the card that produced them.
      `SELECT a.id, a.message_id, m.turn_id AS turn_id, a.workspace_relpath AS path, a.created_at
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       JOIN turns t ON t.id = m.turn_id
       WHERE t.task_id = ?
       ORDER BY a.created_at ASC, a.id ASC`,
    )
    .all(taskId);
  const filesByTurn = new Map<string, TaskTraceNode["artifacts"]>();
  // What you attached to the message that opened a stage belongs on your card, not on nobody's.
  const yourFiles = ctx.db
    .query<TraceAttachmentRow, [string]>(
      `SELECT a.id, a.message_id, m.turn_id AS turn_id, a.workspace_relpath AS path, a.created_at
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.turn_id IS NULL AND m.id IN (
         SELECT trigger_message_id FROM turns WHERE task_id = ?
       )
       ORDER BY a.created_at ASC, a.id ASC`,
    )
    .all(taskId);
  const filesByMessage = new Map<string, TaskTraceNode["artifacts"]>();
  for (const row of yourFiles) {
    const list = filesByMessage.get(row.message_id) ?? [];
    if (list.some((file) => file.path === row.path)) continue;
    list.push({ path: row.path, message_id: row.message_id, attachment_id: row.id });
    filesByMessage.set(row.message_id, list);
  }
  for (const row of attachments) {
    if (!turnIds.has(row.turn_id)) continue;
    if (isReservedTaskPath(task.dir, row.path)) continue;
    const list = filesByTurn.get(row.turn_id) ?? [];
    if (list.some((file) => file.path === row.path)) continue;
    list.push({ path: row.path, message_id: row.message_id, attachment_id: row.id });
    filesByTurn.set(row.turn_id, list);
  }

  const approvals = ctx.db
    .query<TraceApprovalRow, [string]>(
      `SELECT a.turn_id, a.message_id, a.summary
       FROM approvals a
       JOIN turns t ON t.id = a.turn_id
       WHERE t.task_id = ? AND a.status = 'pending' AND t.status = 'waiting_approval'
       ORDER BY a.created_at ASC`,
    )
    .all(taskId);
  const approvalByTurn = new Map<string, TraceApprovalRow>();
  for (const row of approvals) if (!approvalByTurn.has(row.turn_id)) approvalByTurn.set(row.turn_id, row);

  const watched = passersByMessage(ctx, turns.map((turn) => turn.trigger_message_id));

  const nodes: TaskTraceNode[] = [];
  const userCards = new Map<string, string>();
  /**
   * Who sent the message decides whose card this is — not whether its turn happens to be on this
   * board. A handoff from a plan that is not on screen used to be drawn as a line you wrote.
   */
  const sentByYou = (turn: TraceTurnRow) => turn.trigger_author === USER_MEMBER;
  for (const turn of turns) {
    const fromYou = sentByYou(turn);
    if (fromYou && !userCards.has(turn.trigger_message_id)) {
      userCards.set(turn.trigger_message_id, `user:${turn.trigger_message_id}`);
      nodes.push({
        turn_id: `user:${turn.trigger_message_id}`,
        session_id: turn.session_id,
        actor: USER_MEMBER,
        status: "completed",
        woken_by_turn_id: null,
        woken_elsewhere: null,
        trigger_message_id: turn.trigger_message_id,
        focus_message_id: turn.trigger_message_id,
        summary: oneLine(turn.trigger_body),
        created_at: turn.trigger_created_at,
        artifacts: filesByMessage.get(turn.trigger_message_id) ?? [],
        ask: null,
        approval: null,
        passed: watched.get(turn.trigger_message_id) ?? 0,
        ticket_id: null,
      });
    }
  }
  for (const turn of turns) {
    const fromYou = sentByYou(turn);
    const onBoard = Boolean(turn.trigger_turn_id && turnIds.has(turn.trigger_turn_id));
    const wokenBy = fromYou
      ? (userCards.get(turn.trigger_message_id) ?? null)
      : onBoard
        ? turn.trigger_turn_id
        : null;
    // A system line no turn wrote is the app waking the Bot (a routine firing): nobody handed it over.
    const byApp = turn.trigger_kind === "system" && !turn.trigger_turn_id;
    // Woken by someone whose turn belongs to another plan: say so rather than inventing a card.
    const elsewhere = fromYou || onBoard || byApp
      ? null
      : { actor: turn.trigger_author, message_id: turn.trigger_message_id };
    const word = lastWord.get(turn.id);
    const ask = turn.status === "waiting_ask" ? askByTurn.get(turn.id) : undefined;
    const pending = turn.status === "waiting_approval" ? approvalByTurn.get(turn.id) : undefined;
    const cut = turn.status === "interrupted" ? interruptByTurn.get(turn.id) : undefined;
    // Only a turn still writing shows its partial. Waiting on you already has a sentence to show.
    const summary = turn.status === "running" && turn.partial_text?.trim()
      ? oneLine(turn.partial_text)
      : word
        ? oneLine(word.body)
        : oneLine(turn.trigger_body);
    nodes.push({
      turn_id: turn.id,
      session_id: turn.session_id,
      actor: turn.bot_id,
      status: turn.status,
      woken_by_turn_id: wokenBy,
      woken_elsewhere: elsewhere,
      trigger_message_id: turn.trigger_message_id,
      focus_message_id: cut?.id ?? ask?.id ?? word?.id ?? turn.trigger_message_id,
      summary,
      created_at: turn.created_at,
      artifacts: filesByTurn.get(turn.id) ?? [],
      ask: ask ? { message_id: ask.id, question: oneLine(ask.body) } : null,
      approval: pending ? { message_id: pending.message_id, summary: oneLine(pending.summary ?? "") } : null,
      passed: fromYou ? 0 : (watched.get(turn.trigger_message_id) ?? 0),
      ticket_id: turn.ticket_id ?? null,
    });
  }
  nodes.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.turn_id.localeCompare(b.turn_id));
  return {
    id: task.id,
    dir: task.dir,
    title: task.title,
    session_id: task.session_id,
    closed_at: task.closed_at,
    nodes,
  };
}

/** How many Bots watched a trigger instead of joining. A message nobody judged returns nothing. */
function passersByMessage(ctx: StoreContext, messageIds: string[]): Map<string, number> {
  const unique = [...new Set(messageIds)];
  const counts = new Map<string, number>();
  if (unique.length === 0) return counts;
  const marks = unique.map(() => "?").join(", ");
  const rows = ctx.db
    .query<{ message_id: string; n: number }, string[]>(
      `SELECT message_id, COUNT(*) AS n FROM judgements
       WHERE decision = 'pass' AND message_id IN (${marks})
       GROUP BY message_id`,
    )
    .all(...unique);
  for (const row of rows) counts.set(row.message_id, row.n);
  return counts;
}
