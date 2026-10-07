/**
 * The built-in prompts you edited (ADR 0064): one row per slot and language holding your whole
 * version and the default it was written against, and an append-only list of every change — yours,
 * a Bot's you approved, or the app's when it merged a newer default in. What a slot is and what its
 * default says live in `prompts/registry.ts`; this module only keeps rows, so it never imports it.
 */
import type { Database } from "bun:sqlite";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import type { StoreContext } from "./shared";
import { recordWorkEvent } from "./work-events";

const PROMPTS_SQL = `
CREATE TABLE IF NOT EXISTS prompt_overrides (
  prompt_id TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('zh', 'en')),
  -- Your whole editable text, placeholders included.
  text TEXT NOT NULL,
  -- The default it stands on: what the slot rendered when you wrote it, or the default last merged in.
  base_text TEXT NOT NULL,
  base_env TEXT NOT NULL DEFAULT '{}',
  -- A newer default that did not merge with your text; yours stays in force until you choose.
  conflict_default TEXT,
  conflict_at TEXT,
  revision_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (prompt_id, locale)
);
CREATE TABLE IF NOT EXISTS prompt_revisions (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('edit', 'reset', 'merge', 'keep_mine', 'undo', 'restore')),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'bot', 'app')),
  -- Where a Bot's change came from; no foreign keys, as with memories (ADR 0021): clearing a
  -- conversation deletes its messages, not this record.
  bot_id TEXT,
  turn_id TEXT,
  approval_id TEXT,
  message_id TEXT,
  reason TEXT,
  -- NULL text is the default.
  before_text TEXT,
  before_base TEXT,
  after_text TEXT,
  after_base TEXT,
  undoes TEXT,
  edit_session TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prompt_revisions_slot ON prompt_revisions (prompt_id, locale, created_at);
CREATE INDEX IF NOT EXISTS prompt_revisions_approval ON prompt_revisions (approval_id) WHERE approval_id IS NOT NULL;
`;

export function migratePrompts(db: Database): void {
  db.exec(PROMPTS_SQL);
}

export type PromptLocale = "zh" | "en";
export type PromptOp = "edit" | "reset" | "merge" | "keep_mine" | "undo" | "restore";
export type PromptActor = "user" | "bot" | "app";

export type PromptOverride = {
  prompt_id: string;
  locale: PromptLocale;
  text: string;
  base_text: string;
  base_env: string;
  conflict_default: string | null;
  conflict_at: string | null;
  revision_id: string;
  updated_at: string;
};

export type PromptRevisionRow = {
  id: string;
  prompt_id: string;
  locale: PromptLocale;
  op: PromptOp;
  actor: PromptActor;
  bot_id: string | null;
  turn_id: string | null;
  approval_id: string | null;
  message_id: string | null;
  reason: string | null;
  before_text: string | null;
  before_base: string | null;
  after_text: string | null;
  after_base: string | null;
  undoes: string | null;
  edit_session: string | null;
  created_at: string;
  updated_at: string;
};

export function listPromptOverrides(ctx: StoreContext): PromptOverride[] {
  return ctx.db.query<PromptOverride, []>("SELECT * FROM prompt_overrides ORDER BY prompt_id, locale").all();
}

export function promptOverride(ctx: StoreContext, id: string, locale: string): PromptOverride | null {
  return ctx.db.query<PromptOverride, [string, string]>("SELECT * FROM prompt_overrides WHERE prompt_id = ? AND locale = ?").get(id, locale);
}

/** The latest change to a slot, whatever it was. */
export function promptHead(ctx: StoreContext, id: string, locale: string): PromptRevisionRow | null {
  return ctx.db
    .query<PromptRevisionRow, [string, string]>("SELECT * FROM prompt_revisions WHERE prompt_id = ? AND locale = ? ORDER BY rowid DESC LIMIT 1")
    .get(id, locale);
}

/** A slot's changes, newest first. */
export function listPromptRevisions(ctx: StoreContext, id: string, locale: string, limit = 50): PromptRevisionRow[] {
  return ctx.db
    .query<PromptRevisionRow, [string, string, number]>("SELECT * FROM prompt_revisions WHERE prompt_id = ? AND locale = ? ORDER BY rowid DESC LIMIT ?")
    .all(id, locale, Math.max(1, Math.min(200, limit)));
}

export function promptRevision(ctx: StoreContext, id: string): PromptRevisionRow | null {
  return ctx.db.query<PromptRevisionRow, [string]>("SELECT * FROM prompt_revisions WHERE id = ?").get(id);
}

/** The change an approval card let through, for the card's own Undo. */
export function promptRevisionByApproval(ctx: StoreContext, approvalId: string): PromptRevisionRow | null {
  return ctx.db.query<PromptRevisionRow, [string]>("SELECT * FROM prompt_revisions WHERE approval_id = ? ORDER BY rowid DESC LIMIT 1").get(approvalId);
}

export type WritePromptInput = {
  id: string;
  locale: PromptLocale;
  /** Your new text; null puts the slot back on its default. */
  text: string | null;
  /** The default `text` stands on; ignored when `text` is null. */
  base: string | null;
  baseEnv?: Record<string, unknown> | null;
  op: PromptOp;
  actor: PromptActor;
  botId?: string | null;
  turnId?: string | null;
  approvalId?: string | null;
  messageId?: string | null;
  reason?: string | null;
  /** The change you last saw: a different latest change is a 409. Undefined skips the check. */
  ifRevision?: string | null;
  /** One sitting in the editor: your saves in it fold into one change. */
  editSession?: string | null;
  undoes?: string | null;
  /** A newer default that did not merge: marked as the slot's conflict. */
  conflictDefault?: string | null;
};

/**
 * Writes a slot's new text and records the change. A change of yours in the same editor sitting as
 * the latest one updates that change instead of adding another, until a save takes the text back to
 * what it was before that change: going back is a change of its own, and the sitting's next save
 * starts another. Any change keeps a conflict that is already marked, except keep-mine (you chose
 * your text over the newer default) and a slot put back on its default; `conflictDefault` marks one.
 */
export function writePrompt(ctx: StoreContext, input: WritePromptInput): PromptRevisionRow | null {
  const head = promptHead(ctx, input.id, input.locale);
  if (input.ifRevision !== undefined && (head?.id ?? null) !== input.ifRevision) {
    throw new HttpError(409, "prompt_changed", "this prompt changed since you loaded it");
  }
  const current = promptOverride(ctx, input.id, input.locale);
  const now = isoNow();
  const afterBase = input.text === null ? null : input.base;
  if (input.text !== null && afterBase === null) throw new HttpError(422, "invalid_args", "an edited prompt needs the default it stands on");
  if (current?.text === input.text && (input.text === null || current?.base_text === afterBase) && input.op !== "keep_mine" && input.conflictDefault === undefined) {
    return head;
  }
  if (current === null && input.text === null) return head;
  const sitting = input.actor === "user" && input.editSession && head && head.actor === "user" && head.op === "edit"
    && head.edit_session === input.editSession && (current?.revision_id ?? null) === head.id;
  // Typed back to what the sitting's change started from: folding would leave a change of nothing,
  // so the way back is recorded on its own, and nothing after it folds into it.
  const back = sitting && input.text === head!.before_text && afterBase === head!.before_base;
  const fold = sitting && !back;
  let revision: PromptRevisionRow;
  if (fold) {
    ctx.db.run("UPDATE prompt_revisions SET after_text = ?, after_base = ?, updated_at = ? WHERE id = ?", [input.text, afterBase, now, head!.id]);
    revision = promptRevision(ctx, head!.id)!;
  } else {
    revision = ctx.db
      .query<PromptRevisionRow, Array<string | null>>(
        `INSERT INTO prompt_revisions (id, prompt_id, locale, op, actor, bot_id, turn_id, approval_id, message_id, reason,
           before_text, before_base, after_text, after_base, undoes, edit_session, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        ulid(), input.id, input.locale, input.op, input.actor, input.botId ?? null, input.turnId ?? null, input.approvalId ?? null,
        input.messageId ?? null, input.reason ?? null, current?.text ?? null, current?.base_text ?? null, input.text, afterBase,
        input.undoes ?? null, back ? null : (input.editSession ?? null), now, now,
      )!;
  }
  if (input.text === null) {
    ctx.db.run("DELETE FROM prompt_overrides WHERE prompt_id = ? AND locale = ?", [input.id, input.locale]);
    return revision;
  }
  const keepConflict = input.op !== "keep_mine";
  const conflictDefault = input.conflictDefault !== undefined ? input.conflictDefault : keepConflict ? (current?.conflict_default ?? null) : null;
  const conflictAt = input.conflictDefault !== undefined ? (input.conflictDefault === null ? null : now) : keepConflict ? (current?.conflict_at ?? null) : null;
  ctx.db.run(
    `INSERT INTO prompt_overrides (prompt_id, locale, text, base_text, base_env, conflict_default, conflict_at, revision_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (prompt_id, locale) DO UPDATE SET text = excluded.text, base_text = excluded.base_text, base_env = excluded.base_env,
       conflict_default = excluded.conflict_default, conflict_at = excluded.conflict_at, revision_id = excluded.revision_id, updated_at = excluded.updated_at`,
    [input.id, input.locale, input.text, afterBase!, JSON.stringify(input.baseEnv ?? (current ? JSON.parse(current.base_env) : {})),
      conflictDefault, conflictAt, revision.id, now],
  );
  return revision;
}

/** A newer default that did not merge with your text: shown beside it, yours stays in force. */
export function markPromptConflict(ctx: StoreContext, id: string, locale: string, newDefault: string): void {
  ctx.db.run("UPDATE prompt_overrides SET conflict_default = ?, conflict_at = ? WHERE prompt_id = ? AND locale = ?", [newDefault, isoNow(), id, locale]);
}

/** A conflict that no longer stands (the default went back to what your text stands on). */
export function clearPromptConflict(ctx: StoreContext, id: string, locale: string): void {
  ctx.db.run("UPDATE prompt_overrides SET conflict_default = NULL, conflict_at = NULL WHERE prompt_id = ? AND locale = ? AND conflict_default IS NOT NULL", [id, locale]);
}

/**
 * An answer to one of the app's own calls came back and could not be read: one `prompt.parse_failed`
 * in the work log, naming the prompt and the revision of yours it ran on (null: the default).
 */
export function notePromptParseFailure(
  ctx: StoreContext,
  input: { prompt: string; locale: string; revision: string | null; reason: string; sessionId?: string | null; taskId?: string | null; botId?: string | null },
): void {
  recordWorkEvent(ctx, {
    kind: "prompt.parse_failed",
    actor: "prompts",
    botId: input.botId ?? null,
    taskId: input.taskId ?? null,
    sessionId: input.sessionId ?? null,
    payload: { prompt: input.prompt, locale: input.locale, revision: input.revision, reason: input.reason },
  });
}

/**
 * Answers that could not be read, since a time: on one revision of a slot (null: on its default), or
 * on any of them.
 */
export function promptParseFailures(ctx: StoreContext, id: string, locale: string, revision: string | null | "any", since = ""): number {
  return ctx.db
    .query<{ n: number }, [string, string, number, string | null, string]>(
      `SELECT COUNT(*) AS n FROM work_events WHERE kind = 'prompt.parse_failed'
         AND json_extract(payload, '$.prompt') = ? AND json_extract(payload, '$.locale') = ?
         AND (? OR json_extract(payload, '$.revision') IS ?) AND at >= ?`,
    )
    .get(id, locale, revision === "any" ? 1 : 0, revision === "any" ? null : revision, since)!.n;
}

/** Who a change came from, for its line in the history: the Bot's name and the conversation of its message. */
export function promptRevisionSource(ctx: StoreContext, row: Pick<PromptRevisionRow, "bot_id" | "message_id" | "turn_id">): { bot_name: string | null; session_id: string | null } {
  const bot = row.bot_id ? ctx.db.query<{ name: string }, [string]>("SELECT name FROM bots WHERE id = ?").get(row.bot_id) : null;
  const viaMessage = row.message_id ? ctx.db.query<{ session_id: string }, [string]>("SELECT session_id FROM messages WHERE id = ?").get(row.message_id) : null;
  const viaTurn = !viaMessage && row.turn_id ? ctx.db.query<{ session_id: string }, [string]>("SELECT session_id FROM turns WHERE id = ?").get(row.turn_id) : null;
  return { bot_name: bot?.name ?? null, session_id: viaMessage?.session_id ?? viaTurn?.session_id ?? null };
}
