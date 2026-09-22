/**
 * One terminal session's process.
 *
 * The pty itself lives in the `real-bot-pty` helper, because a controlling terminal can only be
 * acquired between fork and exec (`ioctl(TIOCSCTTY)`), and no spawn API exposes that seam. What
 * is left here is the pipe protocol to it: bytes in, bytes out, and the two out-of-band things a
 * terminal needs — a new window size and a signal that skips the line discipline.
 *
 * Control characters are *not* translated. The helper's pty has a real controlling terminal, so
 * the line discipline turns `^C` into SIGINT for the foreground process group by itself; a
 * keystroke is just a byte. {@link Pty.signal} exists for a Stop button, not for Ctrl-C.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type PtySignal = "SIGINT" | "SIGQUIT" | "SIGTSTP" | "SIGTERM" | "SIGKILL";

/** Darwin signal numbers; the helper takes the number, not the name. */
const SIGNO: Record<PtySignal, number> = {
  SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGTSTP: 18,
};

const FRAME_INPUT = 1;
const FRAME_RESIZE = 2;
const FRAME_SIGNAL = 3;
const FRAME_SHUTDOWN = 4;

export const DEFAULT_ROWS = 24;
export const DEFAULT_COLS = 80;

/** How long the helper gets to take its session down before the daemon stops being polite. */
export const SHUTDOWN_GRACE_MS = 4000;

export class PtyUnavailable extends Error {}

/**
 * Packaged next to the daemon; in a source checkout, whatever `swift build` last produced.
 * The override exists for tests and for a daemon started from somewhere unusual.
 */
export function ptyHelperPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.REAL_BOT_PTY_HELPER;
  if (override) return override;
  const packaged = join(dirname(process.execPath), "real-bot-pty");
  if (existsSync(packaged)) return packaged;
  const root = resolve(import.meta.dir, "../../..");
  for (const configuration of ["release", "debug"]) {
    const built = join(root, "apps/runtime-helper/.build", configuration, "real-bot-pty");
    if (existsSync(built)) return built;
  }
  throw new PtyUnavailable("pty helper is not built");
}

function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

/** The shell a person expects, started as a login shell: launchd hands the daemon a bare PATH. */
export function shellCommand(env: Record<string, string | undefined> = process.env): string[] {
  return [env.SHELL && env.SHELL.startsWith("/") ? env.SHELL : "/bin/zsh", "-l"];
}

export type PtyOptions = {
  cwd: string;
  rows?: number;
  cols?: number;
  command?: string[];
  env?: Record<string, string>;
  helper?: string;
};

export class Pty {
  private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly input: Bun.FileSink;
  private closed = false;
  readonly exited: Promise<number>;
  rows: number;
  cols: number;

  constructor(options: PtyOptions) {
    const helper = options.helper ?? ptyHelperPath();
    this.rows = clampAxis(options.rows, DEFAULT_ROWS);
    this.cols = clampAxis(options.cols, DEFAULT_COLS);
    const command = options.command ?? shellCommand();
    try {
      this.process = Bun.spawn(
        [helper, "--rows", String(this.rows), "--cols", String(this.cols), "--cwd", options.cwd, "--", ...command],
        {
          stdin: "pipe", stdout: "pipe", stderr: "pipe",
          env: options.env ?? {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? "",
            SHELL: command[0] ?? "/bin/zsh",
            TERM: "xterm-256color",
            LANG: process.env.LANG ?? "en_US.UTF-8",
          },
        },
      ) as Bun.Subprocess<"pipe", "pipe", "pipe">;
    } catch {
      throw new PtyUnavailable("could not start the pty helper");
    }
    this.input = this.process.stdin;
    this.exited = this.process.exited;
    void this.exited.then(() => { this.closed = true; });
  }

  get pid(): number {
    return this.process.pid;
  }

  /** Raw bytes from the pty, exactly as the terminal produced them. */
  onData(sink: (chunk: Uint8Array) => void): void {
    void (async () => {
      try {
        for await (const chunk of this.process.stdout as ReadableStream<Uint8Array>) sink(chunk);
      } catch {
        // The helper went away; `exited` is the signal that matters.
      }
    })();
  }

  write(bytes: Uint8Array): void {
    this.send(frame(FRAME_INPUT, bytes));
  }

  resize(rows: number, cols: number): void {
    this.rows = clampAxis(rows, DEFAULT_ROWS);
    this.cols = clampAxis(cols, DEFAULT_COLS);
    this.send(frame(FRAME_RESIZE, new Uint8Array([
      this.rows >> 8, this.rows & 0xff, this.cols >> 8, this.cols & 0xff,
    ])));
  }

  signal(name: PtySignal): void {
    this.send(frame(FRAME_SIGNAL, new Uint8Array([SIGNO[name]])));
  }

  /** Hang up: the helper signals the session and leaves once its own stdin closes. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.input.end(); } catch { /* already gone */ }
  }

  /**
   * End the session for good.
   *
   * SIGKILLing the helper is the wrong move and used to be this: the shell is its own session
   * leader, so killing its parent leaves it running with nothing attached. Ask the helper to
   * take the session down instead, and only reach for SIGKILL if the helper itself is the thing
   * that is stuck.
   */
  kill(): void {
    this.send(frame(FRAME_SHUTDOWN, new Uint8Array(0)));
    this.close();
    const escalate = setTimeout(() => {
      try { this.process.kill(9); } catch { /* already gone */ }
    }, SHUTDOWN_GRACE_MS);
    void this.exited.finally(() => clearTimeout(escalate));
  }

  private send(payload: Uint8Array): void {
    if (this.closed) return;
    try {
      this.input.write(payload);
      this.input.flush();
    } catch {
      this.closed = true;
    }
  }
}

function clampAxis(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1000, Math.max(1, Math.trunc(value)));
}
