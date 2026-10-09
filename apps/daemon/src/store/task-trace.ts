/** A job's flow board read model: its turns, messages, files and approvals in order. */
import { INTERRUPT_NOTE_BODY, USER_MEMBER, type TaskTrace, type TaskTraceDecision, type TaskTraceNode, type TurnStatus } from "@real-bot/protocol";
import { askAnswerText, readAskAnswer } from "../ask";
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
  // A reply in several parts often ends on its files alone: the card says the last part with words
  // in it (IG MV, 2026-10-08: nine cards drew blank, seven of them over words the Bot had said).
  const lastWord = new Map<string, TraceMessageRow>();
  const lastPart = new Map<string, TraceMessageRow>();
  const askByTurn = new Map<string, TraceMessageRow>();
  // The 中断 line is what a cut turn leaves behind. It is written after the last word, so a
  // card that still points at that word lands one row above the note it is about.
  const interruptByTurn = new Map<string, TraceMessageRow>();
  for (const row of spoken) {
    if (!turnIds.has(row.turn_id)) continue;
    if (row.kind === "bot") {
      lastPart.set(row.turn_id, row);
      if (oneLine(row.body)) lastWord.set(row.turn_id, row);
    }
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
    const part = lastPart.get(turn.id);
    const ask = turn.status === "waiting_ask" ? askByTurn.get(turn.id) : undefined;
    const pending = turn.status === "waiting_approval" ? approvalByTurn.get(turn.id) : undefined;
    const cut = turn.status === "interrupted" ? interruptByTurn.get(turn.id) : undefined;
    // Only a turn still writing shows its partial. Waiting on you already has a sentence to show. A
    // turn that handed over files and said nothing has no words: the line that woke it is not its own.
    const summary = turn.status === "running" && turn.partial_text?.trim()
      ? oneLine(turn.partial_text)
      : word
        ? oneLine(word.body)
        : part
          ? ""
          : oneLine(turn.trigger_body);
    nodes.push({
      turn_id: turn.id,
      session_id: turn.session_id,
      actor: turn.bot_id,
      status: turn.status,
      woken_by_turn_id: wokenBy,
      woken_elsewhere: elsewhere,
      trigger_message_id: turn.trigger_message_id,
      focus_message_id: cut?.id ?? ask?.id ?? word?.id ?? part?.id ?? turn.trigger_message_id,
      summary,
      created_at: turn.created_at,
      artifacts: filesByTurn.get(turn.id) ?? [],
      ask: ask ? { message_id: ask.id, question: oneLine(ask.body) } : null,
      approval: pending ? { message_id: pending.message_id, summary: oneLine(pending.summary ?? "") } : null,
      passed: fromYou ? 0 : (watched.get(turn.trigger_message_id) ?? 0),
      ticket_id: turn.ticket_id ?? null,
    });
  }
  nodes.push(...decisionNodes(ctx, taskId, turnIds, nodes));
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

function parse(raw: string | null): Record<string, unknown> {
  try {
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Your decisions on this job as cards of yours (2026-10-10): each answer to a Bot's question, each
 * 放行 and 退回 of a hand-over (from its card: only your press marks one; the work log called every
 * 放行 the app's until then), and each line of yours that put a ticket back to rework, hung under the
 * card of the turn it answers. Before, the trace showed only the lines that woke a turn: on the IG MV
 * job four answers and fourteen card presses — the points the job turned on — were nowhere on it.
 * A rework line that already has its card (it woke a turn) is marked on that card instead.
 */
function decisionNodes(ctx: StoreContext, taskId: string, turnIds: ReadonlySet<string>, cards: TaskTraceNode[]): TaskTraceNode[] {
  const out: TaskTraceNode[] = [];
  const onBoard = (turnId: string | null | undefined): string | null => (turnId && turnIds.has(turnId) ? turnId : null);
  const card = (input: { id: string; sessionId: string; at: string; summary: string; answers: string | null; ticketId: string | null; decision: TaskTraceDecision }): TaskTraceNode => ({
    turn_id: `decision:${input.id}`,
    session_id: input.sessionId,
    actor: USER_MEMBER,
    status: "completed",
    woken_by_turn_id: onBoard(input.answers),
    woken_elsewhere: null,
    trigger_message_id: input.id,
    focus_message_id: input.id,
    summary: input.summary,
    created_at: input.at,
    artifacts: [],
    ask: null,
    approval: null,
    passed: 0,
    ticket_id: input.ticketId,
    decision: input.decision,
  });

  // Questions a Bot asked in this job's turns, and your answers.
  for (const row of ctx.db.query<{ id: string; session_id: string; turn_id: string; ticket_id: string | null; body: string; ask_answer: string }, [string]>(
    `SELECT m.id, m.session_id, m.turn_id, t.ticket_id, m.body, m.ask_answer FROM messages m JOIN turns t ON t.id = m.turn_id
     WHERE t.task_id = ? AND m.kind = 'ask' AND m.ask_answer IS NOT NULL`).all(taskId)) {
    const answer = readAskAnswer(row.ask_answer);
    if (!answer) continue;
    out.push(card({ id: row.id, sessionId: row.session_id, at: answer.answered_at, summary: oneLine(askAnswerText(answer)), answers: row.turn_id,
      ticketId: row.ticket_id, decision: { kind: "answer", question: oneLine(row.body) } }));
  }

  // Your presses on hand-over cards, and your 退回 with what you said.
  const submissions = new Map(ctx.db.query<{ id: string; turn_id: string | null; ticket_id: string; updated_at: string }, [string]>(
    "SELECT id, turn_id, ticket_id, updated_at FROM submissions WHERE task_id = ?").all(taskId).map((row) => [row.id, row]));
  const events = ctx.db.query<{ at: string; kind: string; actor: string; ticket_id: string | null; payload: string }, [string]>(
    `SELECT at, kind, actor, ticket_id, payload FROM work_events WHERE task_id = ?
       AND kind IN ('review.recorded', 'submission.approved', 'complaint.rework', 'complaint.rework_undone') ORDER BY seq`).all(taskId);
  const rejectedByYou = new Map<string, { at: string; note: string | null }>();
  const resolvedAt = new Map<string, string>();
  for (const event of events) {
    const payload = parse(event.payload);
    const id = typeof payload.submission_id === "string" ? payload.submission_id : null;
    if (!id) continue;
    if (event.kind === "review.recorded" && event.actor === USER_MEMBER && payload.outcome === "reject") {
      rejectedByYou.set(id, { at: event.at, note: typeof payload.note === "string" ? payload.note : null });
    } else if (event.kind === "submission.approved" || (event.kind === "review.recorded" && payload.outcome === "approve")) {
      resolvedAt.set(id, event.at);
    }
  }
  for (const row of ctx.db.query<{ id: string; session_id: string; created_at: string; control: string }, [string]>(
    `SELECT id, session_id, created_at, control FROM messages WHERE kind = 'system' AND json_valid(control)
       AND json_extract(control, '$.kind') = 'review_item' AND json_extract(control, '$.task_id') = ?`).all(taskId)) {
    const control = parse(row.control);
    const acted = Array.isArray(control.acted) ? control.acted : [];
    const id = typeof control.submission_id === "string" ? control.submission_id : null;
    const submission = id ? submissions.get(id) : undefined;
    if (!id || !submission) continue;
    const result = typeof control.result === "string" ? control.result : null;
    if (acted.includes("approve")) {
      out.push(card({ id: row.id, sessionId: row.session_id, at: resolvedAt.get(id) ?? submission.updated_at, summary: "", answers: submission.turn_id,
        ticketId: submission.ticket_id, decision: { kind: "approve", submission_id: id } }));
    } else if (acted.includes("reject")) {
      const yours = rejectedByYou.get(id);
      // A 退回 with no word of yours behind it is a 放行 whose checks then failed.
      out.push(yours
        ? card({ id: row.id, sessionId: row.session_id, at: yours.at, summary: yours.note ? oneLine(yours.note) : "", answers: submission.turn_id,
          ticketId: submission.ticket_id, decision: { kind: "reject", submission_id: id } })
        : card({ id: row.id, sessionId: row.session_id, at: submission.updated_at, summary: "", answers: submission.turn_id, ticketId: submission.ticket_id,
          decision: { kind: "approve", submission_id: id, ...(result ? { result } : {}) } }));
    }
  }

  // Lines of yours that put a ticket back to rework (not ones you undid).
  const undone = new Set(events.filter((event) => event.kind === "complaint.rework_undone").map((event) => parse(event.payload).card_id).filter(Boolean));
  for (const event of events) {
    if (event.kind !== "complaint.rework") continue;
    const payload = parse(event.payload);
    if (payload.card_id && undone.has(payload.card_id)) continue;
    const messageId = typeof payload.message_id === "string" ? payload.message_id : null;
    if (!messageId) continue;
    const existing = cards.find((node) => node.turn_id === `user:${messageId}`);
    if (existing) {
      existing.decision = { kind: "rework" };
      continue;
    }
    const line = ctx.db.query<{ session_id: string; body: string }, [string]>("SELECT session_id, body FROM messages WHERE id = ?").get(messageId);
    if (!line) continue;
    const latest = [...submissions.values()].filter((row) => row.ticket_id === event.ticket_id && row.updated_at <= event.at)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    out.push(card({ id: messageId, sessionId: line.session_id, at: event.at, summary: oneLine(line.body), answers: latest?.turn_id ?? null,
      ticketId: event.ticket_id, decision: { kind: "rework" } }));
  }
  return out;
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
