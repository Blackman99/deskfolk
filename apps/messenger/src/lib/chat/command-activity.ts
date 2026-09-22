import type { StreamFrame, ToolFrame } from "@real-bot/protocol";
import { accept, decodeBase64, startCursor, type StreamCursor } from "../overlays/terminals.ts";

/**
 * What a Bot's commands look like while a turn is running.
 *
 * A ten minute build used to be ten minutes of nothing followed by one message. This holds the
 * little that makes it visible: which command is running, what it has printed so far, and how it
 * ended. All of it is ephemeral on purpose — a reload rebuilds the turn from the transcript, not
 * from here, so nothing is stored and nothing is missed by being late.
 */
export type CommandRow = {
  /** `<turn_id>:<tool_call_id>`, which is also its output stream's id. */
  id: string;
  turnId: string;
  name: string;
  command: string | null;
  running: boolean;
  exitCode: number | null;
  durationMs: number | null;
  /** What it has printed, clipped to the tail a person would actually read. */
  text: string;
};

/** The tail that stays on screen while a command runs. Enough to see progress, not a log viewer. */
export const ACTIVITY_TAIL_BYTES = 8 * 1024;

type Entry = CommandRow & { cursor: StreamCursor };

export class CommandActivity {
  private readonly rows = new Map<string, Entry>();
  private readonly decoder = new TextDecoder();

  /** Only `shell` earns a row: the other tools finish in milliseconds and print nothing. */
  static shows(name: string): boolean {
    return name === "shell";
  }

  applyTool(frame: ToolFrame): void {
    if (!CommandActivity.shows(frame.name)) return;
    const id = `${frame.turn_id}:${frame.id}`;
    const existing = this.rows.get(id);
    if (frame.phase === "started") {
      this.rows.set(id, {
        id, turnId: frame.turn_id, name: frame.name,
        command: frame.command ?? null,
        running: true, exitCode: null, durationMs: null, text: existing?.text ?? "",
        cursor: existing?.cursor ?? startCursor(),
      });
      return;
    }
    if (!existing) return;
    this.rows.set(id, {
      ...existing,
      running: false,
      exitCode: frame.exit_code ?? null,
      durationMs: frame.duration_ms ?? null,
      command: existing.command ?? frame.command ?? null,
    });
  }

  applyStream(frame: StreamFrame): void {
    const existing = this.rows.get(frame.id);
    if (!existing) return;
    const taken = accept(existing.cursor, frame.offset, decodeBase64(frame.data));
    if (!taken) return;
    const text = existing.text + this.decoder.decode(taken.bytes, { stream: true });
    this.rows.set(frame.id, {
      ...existing,
      cursor: taken.cursor,
      text: text.length > ACTIVITY_TAIL_BYTES ? text.slice(text.length - ACTIVITY_TAIL_BYTES) : text,
    });
  }

  /** In the order they started, which is the order they ran. */
  forTurn(turnId: string): CommandRow[] {
    return [...this.rows.values()].filter((row) => row.turnId === turnId).map(strip);
  }

  /** A finished turn keeps nothing: the transcript and the job's trace are what survive. */
  forget(turnId: string): void {
    for (const [id, row] of this.rows) if (row.turnId === turnId) this.rows.delete(id);
  }

  clear(): void {
    this.rows.clear();
  }
}

function strip(entry: Entry): CommandRow {
  const { cursor: _cursor, ...row } = entry;
  return row;
}

/** One line for a finished command: what ran, how it ended, how long it took. */
export function summarize(row: CommandRow): string {
  const head = (row.command ?? row.name).split("\n")[0]!.trim();
  const clipped = head.length > 60 ? `${head.slice(0, 59)}…` : head;
  if (row.running) return clipped;
  const parts = [clipped];
  if (row.exitCode !== null) parts.push(`exit ${row.exitCode}`);
  if (row.durationMs !== null) parts.push(formatDuration(row.durationMs));
  return parts.join(" · ");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}
