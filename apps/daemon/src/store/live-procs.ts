/**
 * The commands still running, by the boot that started them and the daemon process that boot ran
 * in (ADR 0040 I10). A row is written the moment a spawn hands back its pid and deleted when that
 * process exits, so whatever the daemon died of, the next boot can find what the last one left
 * running and stop it. What does the killing lives in `../live-procs.ts`; this is only the table.
 */
import { isoNow } from "../ids";
import { takeCodePoints } from "../text";
import type { StoreContext } from "./shared";

export type LiveProc = {
  boot_id: string;
  pid: number;
  pgid: number | null;
  turn_id: string | null;
  tool_call_id: string | null;
  command: string;
  started_at: string;
  proc_start_time: string | null;
  platform: string;
  daemon_pid: number;
  daemon_start_time: string | null;
};

/** Enough of the command line to tell one from another in a log; the row is not a transcript. */
export const LIVE_PROC_COMMAND_MAX = 300;

export function registerLiveProc(
  ctx: StoreContext,
  input: {
    bootId: string;
    pid: number;
    pgid: number | null;
    turnId?: string | null;
    toolCallId?: string | null;
    command: string;
    platform: string;
    daemonPid: number;
  },
): void {
  const command = takeCodePoints(input.command.replace(/\s+/g, " ").trim(), LIVE_PROC_COMMAND_MAX).text;
  // OR REPLACE: a pid the OS handed out again within this boot is a new process, and the row
  // left for the old one would otherwise make this spawn fail.
  ctx.db.run(
    `INSERT OR REPLACE INTO live_procs
       (boot_id, pid, pgid, turn_id, tool_call_id, command, started_at, proc_start_time, platform, daemon_pid, daemon_start_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    [input.bootId, input.pid, input.pgid, input.turnId ?? null, input.toolCallId ?? null, command, isoNow(), input.platform, input.daemonPid],
  );
}

/**
 * Both start times, the command's and its daemon's, read from the OS just after the spawn; a row
 * already gone (the process exited first) stays gone.
 */
export function noteLiveProcStart(ctx: StoreContext, bootId: string, pid: number, startTime: string, daemonStartTime: string): void {
  ctx.db.run(
    `UPDATE live_procs SET proc_start_time = ?, daemon_start_time = ? WHERE boot_id = ? AND pid = ?`,
    [startTime, daemonStartTime, bootId, pid],
  );
}

export function forgetLiveProc(ctx: StoreContext, bootId: string, pid: number): void {
  ctx.db.run(`DELETE FROM live_procs WHERE boot_id = ? AND pid = ?`, [bootId, pid]);
}

/**
 * Every row not written by `bootId`: what earlier boots left behind or, in a copy of a live
 * database, the rows of the daemon still running on the original.
 */
export function liveProcsFromOtherBoots(ctx: StoreContext, bootId: string): LiveProc[] {
  return ctx.db
    .query<LiveProc, [string]>(`SELECT * FROM live_procs WHERE boot_id <> ? ORDER BY started_at, pid`)
    .all(bootId);
}
