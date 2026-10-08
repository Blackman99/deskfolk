/**
 * Live bytes from a terminal or from a Bot's running command, on the same socket as events but
 * outside their cursor: ephemeral, never sequenced, never caught up, never a resnapshot. Ten
 * megabytes of build output must not cost every client a full reload, which is exactly what
 * putting this in the event ring would do.
 *
 * The cursor is a byte offset, so a transport may coalesce or re-chunk freely.
 */
/**
 * A shell session you opened yourself. Held by the daemon, so it outlives the window. Quit and a
 * daemon that dies stop the process; the next daemon starts it again in the same place. Ending
 * the session is what forgets it. Not a Bot's tool, not approval-gated, and invisible to every Bot.
 */
export type Terminal = {
  id: string;
  /** Last segment of {@link Terminal.cwd}, for a tab label. */
  title: string;
  /**
   * Where the shell last reported being — zsh does this on its own, via the daemon's own shell
   * integration — or, until it reports, where the session was opened.
   */
  cwd: string;
  rows: number;
  cols: number;
  created_at: string;
  /** `interrupted` means the daemon went away underneath it, same word the transcript uses. A restart starts a new shell rather than reporting one. */
  status: "live" | "exited" | "interrupted";
  exit_code: number | null;
  /** Total bytes ever written to its stream; a reader resumes from an offset. */
  stream_end: number;
};

/** What a Stop button can send. Ordinary keys, `^C` included, are bytes the tty line discipline owns. */
export const TERMINAL_SIGNALS = ["SIGINT", "SIGQUIT", "SIGTSTP", "SIGTERM", "SIGKILL"] as const;
export type TerminalSignal = (typeof TERMINAL_SIGNALS)[number];

/** Retained bytes from an offset, for a reader that just connected or fell behind. */
export type TerminalScrollback = {
  offset: number;
  /** base64 */
  data: string;
  skipped: number;
  end: number;
  closed: boolean;
};

/**
 * A session's screen as the daemon holds it. Written into an empty terminal it draws what is on
 * screen now — a full-screen program included, with its modes and cursor — at `rows` × `cols`;
 * live bytes resume at `offset`. This is what a pane attaches to; {@link TerminalScrollback} is
 * the raw bytes, kept for readers that predate it.
 */
export type TerminalScreenSnapshot = {
  offset: number;
  /** base64 of the serialized screen, UTF-8 */
  data: string;
  rows: number;
  cols: number;
};

/**
 * A pane's colours, `#rrggbb`. The daemon answers a program's colour requests (OSC 10/11/12/4)
 * with those of the pane that last attached, since only a pane knows what it is drawing in.
 */
export type TerminalColors = {
  foreground: string;
  background: string;
  cursor?: string;
  /** The sixteen ANSI colours, black to bright white. */
  palette?: string[];
};
