/**
 * Taking back a line of yours that no Bot has read yet (撤回, ADR 0069). Such a line waits in a
 * working Bot's inbox: queued for its next step, held by a stop, or waiting for the Bot's next turn
 * or job slot. Taking it back ends every copy of it there (`withdrawn`), keeps it out of what any
 * Bot reads of the conversation from then on (`hidden_from_bots`), erases your words kept from it
 * (an entry of the ledger standing on them is waived, as erasing does), and lets work that was
 * queued only for it go idle. The line stays in the transcript, marked as taken back, with its words
 * for you to send again.
 *
 * A line some Bot has read — one copy of it delivered, or a turn opened on it — is refused: what
 * was read cannot be unread, and changing the line (ADR 0063) is the way to correct it then.
 */
import type { Database } from "bun:sqlite";
import type { Message } from "@real-bot/protocol";
import { HttpError } from "../errors";
import { isoNow } from "../ids";
import { editRefusal } from "./message-edits";
import { assertUserMayPost, getMessage } from "./messages";
import { eraseQuotes } from "./quotes";
import { messageRow, LIVE_TURN_STATUSES, type MessageRow, type StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

export type WithdrawMessageResult = {
  message: Message;
  /** How many copies of the line were taken out of an inbox; 0 when it had already been taken back. */
  withdrawn: number;
  /** The kept words erased with it, and the ledger entries that stood on them, now waived. */
  erased: string[];
  waived: string[];
};

/** The column on the line, and the `withdrawn` state an inbox item can now be in. */
export function migrateMessageWithdraw(db: Database): void {
  const names = db.query<{ name: string }, []>(`PRAGMA table_info(messages)`).all().map((row) => row.name);
  if (names.length > 0 && !names.includes("withdrawn_at")) db.run(`ALTER TABLE messages ADD COLUMN withdrawn_at TEXT`);
  widenInboxStates(db);
}

/**
 * `inbox_items.state` gained `withdrawn`. Its CHECK is a fixed `IN (...)` list, which SQLite cannot
 * widen with `ALTER TABLE`, so an inbox whose list lacks it is rebuilt the way `widenSpendPurposes`
 * rebuilds the ledger: the stored definition with the state added, every row copied in one
 * transaction, its indexes made again. Nothing references the table by a foreign key. Its
 * AUTOINCREMENT counter is carried over, so no item number (`U12`) is ever handed out twice.
 */
function widenInboxStates(db: Database): void {
  const table = db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbox_items'`).get()?.sql;
  if (!table || /'withdrawn'/.test(table)) return;
  const list = /state\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*state\s+IN\s*\(([^)]*)\)\s*\)/i.exec(table);
  if (!list) throw new Error("inbox_items.state has a definition this migration does not know how to widen");
  const widened = table.replace(list[0], list[0].replace(list[1]!, `${list[1]!.trimEnd()}, 'withdrawn'`));
  // A table that was ever renamed is stored as CREATE TABLE "inbox_items".
  const createNew = widened.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"inbox_items"|inbox_items\b)/i, "CREATE TABLE inbox_items_new");
  if (createNew === widened) throw new Error("inbox_items has a definition this migration does not know how to copy");
  const own = db
    .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE tbl_name = 'inbox_items' AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .all();
  const columns = db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('inbox_items')`)
    .all()
    .map((col) => `"${col.name}"`)
    .join(", ");
  db.run(`PRAGMA legacy_alter_table = ON`);
  try {
    db.transaction(() => {
      const counter = db.query<{ seq: number }, []>(`SELECT seq FROM sqlite_sequence WHERE name = 'inbox_items'`).get()?.seq ?? 0;
      db.run(createNew);
      db.run(`INSERT INTO inbox_items_new (${columns}) SELECT ${columns} FROM inbox_items`);
      db.run(`DROP TABLE inbox_items`);
      db.run(`ALTER TABLE inbox_items_new RENAME TO inbox_items`);
      for (const { sql } of own) db.run(sql);
      const now = db.query<{ seq: number }, []>(`SELECT seq FROM sqlite_sequence WHERE name = 'inbox_items'`).get()?.seq ?? null;
      if (now === null) {
        if (counter > 0) db.run(`INSERT INTO sqlite_sequence (name, seq) VALUES ('inbox_items', ?)`, [counter]);
      } else if (now < counter) {
        db.run(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'inbox_items'`, [counter]);
      }
    })();
  } finally {
    db.run(`PRAGMA legacy_alter_table = OFF`);
  }
}

/**
 * Why this line cannot be taken back, as the code and words a refusal carries, or null when it can.
 * Only a plain line of yours, as for a change (`editRefusal`), that is still waiting somewhere and
 * that no Bot has read.
 */
export function withdrawRefusal(ctx: StoreContext, row: MessageRow): { status: number; code: string; message: string } | null {
  const notYours = editRefusal(ctx, row);
  if (notYours) return { status: 422, code: "not_withdrawable", message: notYours };
  if (ctx.db.query(`SELECT 1 FROM turns WHERE trigger_message_id = ? LIMIT 1`).get(row.id)) {
    return { status: 409, code: "already_read", message: "a Bot has already read this line: it opened a turn" };
  }
  const states = ctx.db
    .query<{ state: string }, [string]>(`SELECT state FROM inbox_items WHERE message_id = ? AND edit_id IS NULL`)
    .all(row.id)
    .map((item) => item.state);
  if (states.length === 0) return { status: 409, code: "not_queued", message: "this line is not waiting for any Bot" };
  if (states.some((state) => state !== "queued" && state !== "held")) {
    return { status: 409, code: "already_read", message: "a Bot has already read this line" };
  }
  return null;
}

export function withdrawMessage(ctx: StoreContext, id: string, input: { userActionId: string }): WithdrawMessageResult {
  return ctx.commit(() => {
    const row = messageRow(ctx, id);
    // Not yours to write in — a Bot↔Bot direct — is refused as a post there would be.
    assertUserMayPost(ctx, row.session_id);
    if (row.withdrawn_at) return { message: getMessage(ctx, id), withdrawn: 0, erased: [], waived: [] };
    const refusal = withdrawRefusal(ctx, row);
    if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message);
    const now = isoNow();
    const items = ctx.db
      .query<{ seq: number; work_item_id: string | null }, [string, string]>(
        `UPDATE inbox_items SET state = 'withdrawn', disposed_at = ? WHERE message_id = ? AND state IN ('queued', 'held')
         RETURNING seq, work_item_id`,
      )
      .all(now, id);
    ctx.db.run(`UPDATE messages SET withdrawn_at = ?, hidden_from_bots = 1 WHERE id = ?`, [now, id]);
    // Work queued for this line alone has nothing left to wake it: it stops counting as in line.
    for (const workItemId of new Set(items.flatMap((item) => (item.work_item_id ? [item.work_item_id] : [])))) {
      ctx.db.run(
        `UPDATE work_items SET state = 'idle', updated_at = ?1 WHERE id = ?2 AND state = 'queued'
           AND NOT EXISTS (SELECT 1 FROM inbox_items i WHERE i.work_item_id = ?2 AND i.state IN ('queued', 'held') AND i.wakes = 1)
           AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.work_item_id = ?2 AND t.status IN ${LIVE_TURN_STATUSES})`,
        [now, workItemId],
      );
    }
    // Your words from it go, and whatever the ledger made of them with them: you took them back.
    const quotes = ctx.db
      .query<{ id: string }, [string]>(`SELECT id FROM user_quotes WHERE message_id = ? AND redacted_at IS NULL ORDER BY created_at, rowid`)
      .all(id)
      .map((quote) => quote.id);
    const { quotes: erased, waived } = quotes.length > 0 ? eraseQuotes(ctx, quotes, now) : { quotes: [], waived: [] };
    recordWorkEvent(ctx, {
      kind: "message.withdrawn",
      actor: "user",
      sessionId: row.session_id,
      taskId: row.task_id ?? null,
      ticketId: row.ticket_id ?? null,
      payload: { message: id, user_action_id: input.userActionId, items: items.map((item) => item.seq), erased, waived },
    });
    return { message: getMessage(ctx, id), withdrawn: items.length, erased, waived };
  });
}
