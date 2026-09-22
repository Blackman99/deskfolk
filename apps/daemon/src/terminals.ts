/**
 * The shell sessions you opened, and nothing a Bot can reach.
 *
 * Held here rather than in the window so that closing the window does not kill `pnpm dev`, and
 * ended by Quit along with everything else. A daemon that dies takes them with it: the next one
 * reports `interrupted` rather than pretending the session survived, which is the same word a
 * turn uses for the same situation.
 *
 * Nothing here consults approvals. Approval is what gates a Bot's dangerous actions; you do not
 * ask yourself for permission to run a command on your own machine.
 */
import type { Terminal } from "@real-bot/protocol";
import { HttpError } from "./errors";
import { ulid } from "./ids";
import { Pty, PtyUnavailable, type PtySignal } from "./pty";
import { TERMINAL_STREAM_BYTES, type StreamHub } from "./streams";

/** Enough for the way a person works; a runaway caller hits a wall instead of the machine. */
export const MAX_TERMINALS = 8;
export const MAX_INPUT_BYTES = 64 * 1024;

export type TerminalsOptions = {
  streams: StreamHub;
  publish: (event: { event: "terminal.upsert"; occurred_at: string } & Terminal
    | { event: "terminal.removed"; occurred_at: string; id: string }) => void;
  now?: () => Date;
  /** Swapped in tests; production opens a real pty. */
  spawn?: (options: { cwd: string; rows: number; cols: number }) => Pty;
};

type Entry = { row: Terminal; pty: Pty };

export class Terminals {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: TerminalsOptions) {}

  list(): Terminal[] {
    return [...this.entries.values()]
      .map((entry) => this.snapshot(entry))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  get(id: string): Terminal {
    return this.snapshot(this.entry(id));
  }

  open(input: { cwd: string; rows?: number; cols?: number }): Terminal {
    if (this.live().length >= MAX_TERMINALS) {
      throw new HttpError(409, "conflict", `at most ${MAX_TERMINALS} terminals at once`);
    }
    const cwd = input.cwd.trim();
    if (!cwd.startsWith("/") || cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(cwd)) {
      throw new HttpError(422, "invalid_args", "cwd must be an absolute path");
    }
    const id = ulid();
    let pty: Pty;
    try {
      pty = (this.options.spawn ?? ((o) => new Pty(o)))({
        cwd, rows: axis(input.rows, 24), cols: axis(input.cols, 80),
      });
    } catch (error) {
      if (error instanceof PtyUnavailable) throw new HttpError(503, "failed", "the terminal helper is not available");
      throw error;
    }
    const row: Terminal = {
      id,
      title: cwd.split("/").filter(Boolean).at(-1) ?? "/",
      cwd,
      rows: pty.rows,
      cols: pty.cols,
      created_at: this.options.now?.().toISOString() ?? new Date().toISOString(),
      status: "live",
      exit_code: null,
      stream_end: 0,
    };
    const entry: Entry = { row, pty };
    this.entries.set(id, entry);
    this.options.streams.open(id, TERMINAL_STREAM_BYTES);
    pty.onData((chunk) => this.options.streams.push(id, chunk));
    void pty.exited.then((code) => {
      entry.row = { ...entry.row, status: "exited", exit_code: code };
      this.options.streams.close(id);
      this.emit(entry);
    });
    this.emit(entry);
    return this.snapshot(entry);
  }

  write(id: string, bytes: Uint8Array): void {
    if (bytes.length > MAX_INPUT_BYTES) throw new HttpError(422, "invalid_args", "input is too large");
    this.liveEntry(id).pty.write(bytes);
  }

  resize(id: string, rows: number, cols: number): Terminal {
    const entry = this.liveEntry(id);
    entry.pty.resize(rows, cols);
    entry.row = { ...entry.row, rows: entry.pty.rows, cols: entry.pty.cols };
    this.emit(entry);
    return this.snapshot(entry);
  }

  /** For a Stop button. Ordinary keys, `^C` included, are bytes: the line discipline owns those. */
  signal(id: string, name: PtySignal): void {
    this.liveEntry(id).pty.signal(name);
  }

  /** Hang up and forget. The stream goes with it; scrollback is not a document. */
  remove(id: string): void {
    const entry = this.entry(id);
    entry.pty.kill();
    this.entries.delete(id);
    this.options.streams.drop(id);
    this.options.publish({ event: "terminal.removed", occurred_at: this.at(), id });
  }

  /** Quit: the sessions end with the daemon rather than outliving the app that owns them. */
  shutdown(): void {
    for (const id of [...this.entries.keys()]) {
      try { this.entries.get(id)?.pty.kill(); } catch { /* already gone */ }
      this.options.streams.drop(id);
    }
    this.entries.clear();
  }

  private live(): Entry[] {
    return [...this.entries.values()].filter((entry) => entry.row.status === "live");
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new HttpError(404, "not_found", "no such terminal");
    return entry;
  }

  private liveEntry(id: string): Entry {
    const entry = this.entry(id);
    if (entry.row.status !== "live") throw new HttpError(409, "conflict", "this terminal has ended");
    return entry;
  }

  private snapshot(entry: Entry): Terminal {
    return { ...entry.row, stream_end: this.options.streams.end(entry.row.id) };
  }

  private emit(entry: Entry): void {
    this.options.publish({ event: "terminal.upsert", occurred_at: this.at(), ...this.snapshot(entry) });
  }

  private at(): string {
    return this.options.now?.().toISOString() ?? new Date().toISOString();
  }
}

function axis(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1000, Math.max(1, Math.trunc(value)));
}
