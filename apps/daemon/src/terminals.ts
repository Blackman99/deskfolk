/**
 * The shell sessions you opened, and nothing a Bot can reach.
 *
 * Held here rather than in the window so that closing the window does not kill `pnpm dev`. Quit
 * and a daemon that dies both stop the process; the next daemon starts it again in the same
 * place, with the screen it was showing. Ending the session is what forgets it.
 *
 * Each session's screen lives here too ({@link TerminalScreen}): a pane attaches to it rather than
 * replaying bytes, and it alone answers what the programs ask the terminal.
 *
 * Nothing here consults approvals. Approval is what gates a Bot's dangerous actions; you do not
 * ask yourself for permission to run a command on your own machine.
 */
import type { Terminal } from "@real-bot/protocol";
import { userInfo } from "node:os";
import { HttpError } from "./errors";
import { ulid } from "./ids";
import { Pty, PtyUnavailable, shellCommand, type PtySignal } from "./pty";
import { TERMINAL_STREAM_BYTES, type StreamHub } from "./streams";
import type { Store } from "./store";
import { CwdTracker } from "./terminal-cwd";
import { macSystemLocale, terminalEnv } from "./terminal-env";
import { TerminalScreen, type ScreenColors, type ScreenSnapshot } from "./terminal-screen";

/**
 * Where a restored screen ends and the new shell begins. The old session may have stopped
 * anywhere — inside a full-screen program, mid-line, in a colour or a line-drawing charset, with
 * a scroll region set, the mouse or focus reporting on — and the new prompt would inherit all of
 * it: zsh marks a line it did not start with a reverse-video `%`, and focus reports reach the
 * shell as typing. So a soft reset (DECSTR) puts the charset, margins and modes back, mouse
 * reporting and the cursor shape are reset (DECSTR leaves those), and the new shell starts on a
 * line of its own.
 *
 * The alternate screen is left only when the old screen is in it. Leaving it also restores the
 * saved cursor, and a prompt like powerlevel10k saves the cursor on its own first line: told to
 * leave a screen it was never in, the new prompt landed on the old one's second line, and every
 * restart stacked one more line.
 */
const RESTORED_SCREEN_RESET = "\x1b[!p"
  + "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l"
  + "\x1b[0 q\x1b[0m"
  + "\r\n";

export function restoredScreenEnd(screen: Uint8Array): Uint8Array {
  const bytes = Buffer.from(screen.buffer, screen.byteOffset, screen.byteLength);
  const last = (modes: string[], set: "h" | "l") =>
    Math.max(...modes.map((mode) => bytes.lastIndexOf(`\x1b[?${mode}${set}`)));
  const alternate = ["1049", "1047", "47"];
  const inAlternate = last(alternate, "h") > last(alternate, "l");
  return new TextEncoder().encode((inAlternate ? "\x1b[?1049l" : "") + RESTORED_SCREEN_RESET);
}

/** Enough for the way a person works; a runaway caller hits a wall instead of the machine. */
export const MAX_TERMINALS = 8;
export const MAX_INPUT_BYTES = 64 * 1024;

export type TerminalsOptions = {
  streams: StreamHub;
  publish: (event: { event: "terminal.upsert"; occurred_at: string } & Terminal
    | { event: "terminal.removed"; occurred_at: string; id: string }) => void;
  now?: () => Date;
  /**
   * Where a session is remembered so the next daemon can start it again. Absent in tests that
   * never restart; without it a session lives only as long as this process.
   */
  store?: Pick<Store, "listKeptTerminals" | "rememberTerminal" | "forgetTerminal">;
  /** Swapped in tests; production opens a real pty. */
  spawn?: (options: { cwd: string; rows: number; cols: number }) => Pty;
  /**
   * Where Deskfolk's own zsh integration lives, from {@link ensureZshIntegration}. Only zsh
   * sessions use it (see `terminal-env.ts`); absent, a session gets no `ZDOTDIR` and so no OSC 7
   * cwd reporting.
   */
  shellIntegrationDir?: string | null;
};

type Entry = { row: Terminal; pty: Pty | null; screen: TerminalScreen | null };

export class Terminals {
  private readonly entries = new Map<string, Entry>();
  /** Quit and a crash stop the processes without forgetting them, so an exit must not erase the row. */
  private stopping = false;
  /** Output arrives in a stream; the screen is written down about once a second, and again on the way out. */
  private readonly pendingRemember = new Set<string>();
  private rememberTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: TerminalsOptions) {
    for (const kept of options.store?.listKeptTerminals() ?? []) this.restore(kept);
  }

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
      pty = this.spawnPty({ cwd, rows: axis(input.rows, 24), cols: axis(input.cols, 80) });
    } catch (error) {
      if (error instanceof PtyUnavailable) throw new HttpError(503, "failed", "the terminal helper is not available");
      throw error;
    }
    const row: Terminal = {
      id,
      title: titleFor(cwd),
      cwd,
      rows: pty.rows,
      cols: pty.cols,
      created_at: this.options.now?.().toISOString() ?? new Date().toISOString(),
      status: "live",
      exit_code: null,
      stream_end: 0,
    };
    const entry: Entry = { row, pty, screen: null };
    this.attach(entry);
    this.remember(entry);
    this.emit(entry);
    return this.snapshot(entry);
  }

  /**
   * A session the previous daemon was still running. Same id, same place, with the screen it had
   * already shown replayed into the new one. One whose directory is gone, or whose shell will not
   * start, is reported ended rather than dropped: the pane that was showing it stays put.
   */
  private restore(kept: { id: string; cwd: string; rows: number; cols: number; created_at: string; scrollback: Uint8Array }): void {
    let pty: Pty;
    try {
      pty = this.spawnPty({ cwd: kept.cwd, rows: kept.rows, cols: kept.cols });
    } catch {
      // One session that will not start must not stop the daemon from coming up.
      this.ended(kept, null);
      return;
    }
    const entry: Entry = {
      row: {
        id: kept.id,
        title: titleFor(kept.cwd),
        cwd: kept.cwd,
        rows: pty.rows,
        cols: pty.cols,
        created_at: kept.created_at,
        status: "live",
        exit_code: null,
        stream_end: 0,
      },
      pty,
      screen: null,
    };
    this.attach(entry);
    // History for the screen: parsed, never answered. What it asked belonged to the old process.
    if (kept.scrollback.length) {
      for (const bytes of [kept.scrollback, restoredScreenEnd(kept.scrollback)]) {
        this.options.streams.push(kept.id, bytes);
        entry.screen?.restore(bytes);
      }
    }
    this.remember(entry);
    this.emit(entry);
  }

  /** A session that could not be started again, kept so its pane still has something to show. */
  private ended(kept: { id: string; cwd: string; rows: number; cols: number; created_at: string }, code: number | null): void {
    const row: Terminal = {
      id: kept.id,
      title: titleFor(kept.cwd),
      cwd: kept.cwd,
      rows: kept.rows,
      cols: kept.cols,
      created_at: kept.created_at,
      status: "exited",
      exit_code: code,
      stream_end: 0,
    };
    const entry: Entry = { row, pty: null, screen: null };
    this.entries.set(kept.id, entry);
    this.options.streams.open(kept.id, TERMINAL_STREAM_BYTES);
    this.options.streams.close(kept.id);
    this.emit(entry);
  }

  private attach(entry: Entry): void {
    const pty = entry.pty;
    if (!pty) return;
    this.entries.set(entry.row.id, entry);
    this.options.streams.open(entry.row.id, TERMINAL_STREAM_BYTES);
    const id = entry.row.id;
    // Fed exactly what the stream gets, so a snapshot's offset is a stream offset.
    const screen = new TerminalScreen({
      rows: pty.rows,
      cols: pty.cols,
      start: this.options.streams.end(id),
      reply: (data) => {
        if (entry.row.status === "live") entry.pty?.write(new TextEncoder().encode(data));
      },
      history: () => {
        const read = this.options.streams.read(id, 0);
        return { offset: read.offset, bytes: read.bytes };
      },
    });
    entry.screen = screen;
    // One tracker per session, fed only from live output. Restored scrollback is pushed straight
    // to the stream, never through here, so replaying it on a restart cannot move the cwd.
    const cwdTracker = new CwdTracker();
    pty.onData((chunk) => {
      this.options.streams.push(id, chunk);
      screen.feed(chunk);
      const cwd = cwdTracker.feed(chunk);
      // A prompt reports the same dir every time; only a change is worth an event.
      if (cwd && cwd !== entry.row.cwd) {
        entry.row = { ...entry.row, cwd, title: titleFor(cwd) };
        this.remember(entry);
        this.emit(entry);
      }
      this.scheduleRemember(entry);
    });
    void pty.exited.then((code) => {
      entry.row = { ...entry.row, status: "exited", exit_code: code };
      this.options.streams.close(entry.row.id);
      // Stopping keeps the row: the process died with the daemon, and the next one starts it again.
      if (!this.stopping) this.remember(entry);
      this.emit(entry);
    });
  }

  /** Coalesce a burst of output into one write. `shutdown` records the screen itself, so this can lag. */
  private scheduleRemember(entry: Entry): void {
    if (this.stopping || !this.options.store) return;
    this.pendingRemember.add(entry.row.id);
    if (this.rememberTimer) return;
    const timer = setTimeout(() => {
      this.rememberTimer = null;
      const ids = [...this.pendingRemember];
      this.pendingRemember.clear();
      if (this.stopping) return;
      for (const id of ids) {
        const current = this.entries.get(id);
        if (current?.row.status === "live") this.remember(current);
      }
    }, 1000);
    timer.unref?.();
    this.rememberTimer = timer;
  }

  /** The screen as it stands, so a restart can show it again. An ended session has nothing to resume. */
  private remember(entry: Entry): void {
    const store = this.options.store;
    if (!store) return;
    if (entry.row.status !== "live") {
      store.forgetTerminal(entry.row.id);
      return;
    }
    // The screen serialized rather than the raw bytes: a restart puts back exactly what was
    // showing, full-screen programs included, instead of replaying the last 256 KiB.
    const screen = entry.screen
      ? new TextEncoder().encode(entry.screen.serialize())
      : this.options.streams.read(entry.row.id, 0).bytes;
    store.rememberTerminal({
      id: entry.row.id,
      cwd: entry.row.cwd,
      rows: entry.row.rows,
      cols: entry.row.cols,
      created_at: entry.row.created_at,
      scrollback: screen,
    });
  }

  write(id: string, bytes: Uint8Array): void {
    if (bytes.length > MAX_INPUT_BYTES) throw new HttpError(422, "invalid_args", "input is too large");
    this.liveEntry(id).pty.write(bytes);
  }

  resize(id: string, rows: number, cols: number): Terminal {
    const entry = this.liveEntry(id);
    entry.pty.resize(rows, cols);
    entry.screen?.resize(entry.pty.rows, entry.pty.cols);
    entry.row = { ...entry.row, rows: entry.pty.rows, cols: entry.pty.cols };
    this.remember(entry);
    this.emit(entry);
    return this.snapshot(entry);
  }

  /**
   * What a pane attaches to: the screen now, and the stream offset live bytes resume at. A
   * session with no screen (one that could not be started again) is an empty one.
   */
  screen(id: string): Promise<ScreenSnapshot> {
    const entry = this.entry(id);
    if (!entry.screen) {
      return Promise.resolve({ offset: this.options.streams.end(id), data: "", rows: entry.row.rows, cols: entry.row.cols });
    }
    return entry.screen.snapshot();
  }

  /** ⌘K, for every pane: history and screen go, the cursor's line stays. */
  clear(id: string): void {
    this.entry(id).screen?.clear();
  }

  /** The colours of the pane that just attached, for the colour requests the screen answers. */
  colors(id: string, colors: ScreenColors): void {
    this.entry(id).screen?.setColors(colors);
  }

  /** For a Stop button. Ordinary keys, `^C` included, are bytes: the line discipline owns those. */
  signal(id: string, name: PtySignal): void {
    this.liveEntry(id).pty.signal(name);
  }

  /** Hang up and forget. The stream goes with it; scrollback is not a document. */
  remove(id: string): void {
    const entry = this.entry(id);
    entry.pty?.kill();
    entry.screen?.dispose();
    this.entries.delete(id);
    this.options.streams.drop(id);
    this.options.store?.forgetTerminal(id);
    this.options.publish({ event: "terminal.removed", occurred_at: this.at(), id });
  }

  /**
   * Stop every process. What was still running is kept, so the next daemon starts it again where
   * it was; a session the person already ended is not.
   */
  shutdown(): void {
    this.stopping = true;
    if (this.rememberTimer) {
      clearTimeout(this.rememberTimer);
      this.rememberTimer = null;
    }
    this.pendingRemember.clear();
    for (const entry of this.entries.values()) {
      if (entry.row.status === "live") this.remember(entry);
    }
    for (const [id, entry] of [...this.entries]) {
      try { entry.pty?.kill(); } catch { /* already gone */ }
      entry.screen?.dispose();
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

  private liveEntry(id: string): Entry & { pty: Pty } {
    const entry = this.entry(id);
    if (entry.row.status !== "live" || !entry.pty) throw new HttpError(409, "conflict", "this terminal has ended");
    return entry as Entry & { pty: Pty };
  }

  private snapshot(entry: Entry): Terminal {
    return { ...entry.row, stream_end: this.options.streams.end(entry.row.id) };
  }

  /**
   * A real pty by default, with the environment and (for zsh) the shell integration a person
   * opening their own Terminal would get. Tests override {@link TerminalsOptions.spawn} entirely,
   * so none of that machinery runs for them.
   */
  private spawnPty(input: { cwd: string; rows: number; cols: number }): Pty {
    if (this.options.spawn) return this.options.spawn(input);
    const command = shellCommand();
    return new Pty({
      ...input,
      command,
      env: terminalEnv(process.env, {
        shell: command[0] ?? "/bin/zsh",
        zshIntegrationDir: this.options.shellIntegrationDir ?? null,
        systemLocale: macSystemLocale(),
        username: userInfo().username,
      }),
    });
  }

  private emit(entry: Entry): void {
    this.options.publish({ event: "terminal.upsert", occurred_at: this.at(), ...this.snapshot(entry) });
  }

  private at(): string {
    return this.options.now?.().toISOString() ?? new Date().toISOString();
  }
}

/** A tab label: the last segment of the cwd, or `/` at the root. */
function titleFor(cwd: string): string {
  return cwd.split("/").filter(Boolean).at(-1) ?? "/";
}

function axis(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1000, Math.max(1, Math.trunc(value)));
}
