/**
 * The shells you had open, kept so the next daemon can start them again.
 *
 * The process itself dies with the daemon — a pty cannot be handed across a restart — and what
 * survives is where it was and the screen it was showing. The next start opens a new shell there.
 * Ending the session is what removes the row.
 */
import type { StoreContext } from "./shared";

export type KeptTerminal = {
  id: string;
  cwd: string;
  rows: number;
  cols: number;
  created_at: string;
  scrollback: Uint8Array;
};

type Row = {
  id: string;
  cwd: string;
  rows: number;
  cols: number;
  created_at: string;
  scrollback: Uint8Array;
};

export function listKeptTerminals(ctx: StoreContext): KeptTerminal[] {
  return ctx.db
    .query<Row, []>(`SELECT id, cwd, rows, cols, created_at, scrollback FROM terminals ORDER BY created_at ASC`)
    .all()
    .map((row) => ({ ...row, scrollback: new Uint8Array(row.scrollback) }));
}

export function rememberTerminal(ctx: StoreContext, row: KeptTerminal): void {
  ctx.db.run(
    `INSERT INTO terminals (id, cwd, rows, cols, created_at, scrollback) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, rows = excluded.rows, cols = excluded.cols, scrollback = excluded.scrollback`,
    [row.id, row.cwd, row.rows, row.cols, row.created_at, row.scrollback],
  );
}

export function forgetTerminal(ctx: StoreContext, id: string): void {
  ctx.db.run(`DELETE FROM terminals WHERE id = ?`, [id]);
}
