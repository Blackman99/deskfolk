/** Schema catch-up for messages: annotations, ask choices, quotes and control buttons. */
import { FILE_DROP_SESSION_ID, type MessageControl } from "@real-bot/protocol";
import type { Database } from "bun:sqlite";
import { askAnswerText, readAskAnswer } from "../ask";
import { ulid } from "../ids";
import { clipQuote } from "./quotes";

/** A batch of annotations sent into your direct records the Bot↔Bot message it came from. */
export function migrateAnnotations(db: Database): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((row) => row.name);
  if (!cols.includes("annotation_source_message_id")) {
    db.run("ALTER TABLE messages ADD COLUMN annotation_source_message_id TEXT");
  }
  // The file an annotation is on, symlinks and letter case resolved, beside the path as it was
  // cited: the Bot's tools look files up resolved. A row without one matches on its relpath only.
  const annotationCols = db.query<{ name: string }, []>("PRAGMA table_info(annotations)").all().map((row) => row.name);
  if (!annotationCols.includes("file_key")) db.run("ALTER TABLE annotations ADD COLUMN file_key TEXT");
  db.run("CREATE INDEX IF NOT EXISTS annotations_file_key ON annotations (file_key, status)");
}

/**
 * A question carries the choices its Bot offered and, once you answer, your answer. Questions
 * asked before this have neither; their answers stay the separate messages they were posted as.
 */
export function migrateAskChoices(db: Database): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((row) => row.name);
  if (!cols.includes("ask_spec")) db.run("ALTER TABLE messages ADD COLUMN ask_spec TEXT");
  if (!cols.includes("ask_answer")) db.run("ALTER TABLE messages ADD COLUMN ask_answer TEXT");
}

/**
 * Your words were only in the transcript before ADR 0040 P3. The first open that finds none kept
 * copies what the transcript still holds — your lines, your answers to questions, the annotations
 * you sent — filed as the lines are, so the plans already under way have them too. From then on each
 * is kept as it lands (store/quotes.ts) and none is ever deleted, so this never runs twice; lines an
 * older build writes while it shares the database are not caught up later.
 */
export function backfillQuotes(db: Database): void {
  if (db.query("SELECT 1 FROM user_quotes LIMIT 1").get()) return;
  type Row = { message_id: string; session_id: string; task_id: string | null; ticket_id: string | null; body: string; at: string };
  // A cached query, not a prepared statement: an unfinalized one keeps the file open after close.
  const keep = db.query(
    `INSERT INTO user_quotes (id, message_id, session_id, task_id, ticket_id, via, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const copy = (via: "message" | "ask_answer" | "annotation", row: Row) => {
    if (row.body.trim()) keep.run(ulid(Date.parse(row.at)), row.message_id, row.session_id, row.task_id, row.ticket_id, via, clipQuote(row.body), row.at);
  };
  // A batch of annotations went out as a line naming the Bots it is for, then whatever you added;
  // with nothing added, the line holds no words of yours (sending one now keeps none either).
  const names = db.query<{ name: string }, []>("SELECT name FROM bots").all().map((row) => row.name).sort((a, b) => b.length - a.length);
  const onlyNames = (body: string): boolean => {
    let rest = body.trim();
    for (;;) {
      const name = names.find((n) => rest.startsWith(`@${n}`));
      if (!name) return rest === "";
      rest = rest.slice(name.length + 1).trim();
    }
  };
  db.transaction(() => {
    const lines = db
      .query<Row & { batch: number }, [string]>(
        `SELECT id AS message_id, session_id, task_id, ticket_id, body, created_at AS at,
                EXISTS (SELECT 1 FROM annotations a WHERE a.message_id = messages.id) AS batch
         FROM messages WHERE kind = 'user' AND session_id != ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(FILE_DROP_SESSION_ID);
    for (const row of lines) if (!(row.batch && onlyNames(row.body))) copy("message", row);
    const answers = db
      .query<Omit<Row, "body" | "at"> & { ask_answer: string }, []>(
        `SELECT id AS message_id, session_id, task_id, ticket_id, ask_answer FROM messages
         WHERE kind = 'ask' AND ask_answer IS NOT NULL ORDER BY created_at ASC, rowid ASC`,
      )
      .all();
    for (const row of answers) {
      const answer = readAskAnswer(row.ask_answer);
      if (answer) copy("ask_answer", { ...row, body: askAnswerText(answer), at: answer.answered_at });
    }
    // Each under the plan of the delivery it is about, as sending one files it now.
    const annotations = db
      .query<Row, []>(
        `SELECT a.message_id, a.session_id, t.task_id, t.ticket_id, a.body, m.created_at AS at
         FROM annotations a JOIN messages m ON m.id = a.message_id LEFT JOIN turns t ON t.id = a.target_turn_id
         WHERE a.status != 'draft' ORDER BY m.created_at ASC, a.rowid ASC`,
      )
      .all();
    for (const row of annotations) copy("annotation", row);
  })();
}

/**
 * What the app made of your stops on a line (`MessageControl`, ADR 0040 P2): the hint on a line of
 * yours it did not act on, the receipt or status answer it wrote itself. Null on every other line.
 */
export function migrateMessageControl(db: Database): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((row) => row.name);
  if (!cols.includes("control")) db.run("ALTER TABLE messages ADD COLUMN control TEXT");
  // The note stopped work opens again on once you lift the stop is for the Bot it wakes, not a line
  // of the conversation (ADR 0041). Notes written before the column are found by how the note opens,
  // a line only `resumeNote` writes.
  if (!cols.includes("bot_only")) {
    db.run("ALTER TABLE messages ADD COLUMN bot_only INTEGER NOT NULL DEFAULT 0");
    db.run(
      `UPDATE messages SET bot_only = 1
       WHERE kind = 'system' AND (body LIKE '（应用提示）用户叫停了这件工作，现在解除了%' OR body LIKE '(App note) The user had stopped this work and has now lifted the stop%')`,
    );
  }
  // The app's answer to a 进度询问 is marked as its status answer, so it shows as the app's line
  // (ADR 0041). Before the mark it was the one line kept from the Bots that carried no control —
  // every other one is a receipt, a status answer about your stops or a restart notice, which always
  // had one; the answer is also the only such line filed under a plan. Every open, not once: an
  // installed app from before the mark that shares this data folder keeps writing them unmarked.
  const statusAnswer: MessageControl = { kind: "status", hold_ids: [], offer: [], scopes: [] };
  db.run(
    `UPDATE messages SET control = ? WHERE kind = 'system' AND hidden_from_bots = 1 AND control IS NULL AND task_id IS NOT NULL`,
    [JSON.stringify(statusAnswer)],
  );
}
