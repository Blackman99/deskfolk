/**
 * A terminal session's screen, kept by the daemon: one headless xterm per session, fed exactly the
 * bytes its stream gets, at the pty's size.
 *
 * Two things only an emulator that sees everything can do. It is what a pane attaches to: the
 * screen as it stands, serialized, and then live bytes from the offset that snapshot was taken
 * at. Replaying raw bytes into a fresh emulator instead garbled full-screen programs, drew them
 * at whatever width the pane happened to have, and ran every request in them again. And it is
 * the one thing that answers a program's requests — device attributes, cursor position, modes,
 * colours — so a desktop pane and a phone showing the same shell never both answer, and nothing
 * answers a request twice. Panes stay silent.
 *
 * Widths follow Unicode 11, the same table the panes use; a different one would put the cursor,
 * the snapshot and every cursor-position answer a cell off after the first emoji.
 */
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";

/** As much history as a pane gets back on attach and a restart keeps. */
export const SCREEN_SCROLLBACK = 2000;

/**
 * The most a snapshot may weigh. It has to fit one remote message (1 MiB, base64 on top); past
 * this, less history goes with it rather than the attach failing.
 */
export const SNAPSHOT_MAX_BYTES = 640 * 1024;

/**
 * How far the emulator may fall behind the pty. A flood (`yes`, `cat` of a large file) arrives
 * faster than it parses; past this the screen stops parsing and is rebuilt from the stream's
 * last bytes once the flood is over, rather than queueing without bound.
 */
export const MAX_BACKLOG_BYTES = 4 * 1024 * 1024;
const REBUILD_QUIET_MS = 150;

export type ScreenSnapshot = { offset: number; data: string; rows: number; cols: number };

/** A pane's colours, `#rrggbb`, so colour requests are answered with what is actually on screen. */
export type ScreenColors = { foreground: string; background: string; cursor?: string; palette?: string[] };

export type TerminalScreenOptions = {
  rows: number;
  cols: number;
  /** Where the requests' answers go: the pty, as if typed. */
  reply: (data: string) => void;
  /** The stream's retained bytes and where they start, for a rebuild after a flood. */
  history: () => { offset: number; bytes: Uint8Array };
  /** The stream offset this screen starts at. */
  start?: number;
};

type Internals = {
  coreService?: { isCursorHidden?: boolean };
  coreMouseService?: { activeEncoding?: string };
  buffer?: { scrollTop?: number; scrollBottom?: number };
};

const ENCODING_MODE: Record<string, string> = { SGR: "1006", SGR_PIXELS: "1016", URXVT: "1015", UTF8: "1005" };
/** DECSCUSR's steady shapes; the blinking one is one less. */
const CURSOR_SHAPE: Record<string, number> = { block: 2, underline: 4, bar: 6 };

/**
 * The serializer ends the normal screen with the terminal's current pen, which is the full-screen
 * program's (the pen is not per screen), then writes that program's screen as if the pen were
 * plain. Plain it is, from there: without this vim came back in the colour of its last `~`. The
 * program's own pen is still put back at the very end.
 */
function plainPenIntoAlternate(serialized: string): string {
  const enter = "\x1b[?1049h\x1b[H";
  const at = serialized.indexOf(enter);
  return at < 0 ? serialized : `${serialized.slice(0, at)}\x1b[0m${serialized.slice(at)}`;
}

export class TerminalScreen {
  private term!: Terminal;
  private serializer!: SerializeAddon;
  /** Stream offset of everything handed to the emulator, and of everything it has parsed. */
  private written: number;
  private parsed: number;
  /** Answers are dropped while the emulator is parsing bytes before this offset: history. */
  private quietUntil = 0;
  private colors: ScreenColors | null = null;
  private lagging = false;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly options: TerminalScreenOptions) {
    this.written = this.parsed = options.start ?? 0;
    this.create(options.rows, options.cols);
  }

  get rows(): number {
    return this.term.rows;
  }

  get cols(): number {
    return this.term.cols;
  }

  /** Live output: parsed, and whatever it asks is answered. */
  feed(chunk: Uint8Array): void {
    if (!chunk.length || this.disposed) return;
    this.written += chunk.length;
    if (this.lagging) {
      this.scheduleRebuild();
      return;
    }
    if (this.written - this.parsed > MAX_BACKLOG_BYTES) {
      this.lagging = true;
      this.scheduleRebuild();
      return;
    }
    this.write(chunk);
  }

  /** Bytes that are history — a screen a previous daemon left — parsed without answering anything. */
  restore(bytes: Uint8Array): void {
    if (!bytes.length || this.disposed) return;
    this.written += bytes.length;
    this.quietUntil = this.written;
    this.write(bytes);
  }

  resize(rows: number, cols: number): void {
    if (this.disposed || (rows === this.term.rows && cols === this.term.cols)) return;
    this.term.resize(cols, rows);
  }

  /** ⌘K: history and screen, keeping the line the cursor is on. */
  clear(): void {
    if (!this.disposed) this.term.clear();
  }

  /** The colours of the pane that last attached, for the colour requests only a pane can answer. */
  setColors(colors: ScreenColors): void {
    this.colors = colors;
  }

  /** The screen once everything handed over so far is parsed, and the offset live bytes resume at. */
  snapshot(): Promise<ScreenSnapshot> {
    if (this.lagging) this.rebuild();
    return new Promise((resolve) => {
      this.term.write("", () => resolve({ offset: this.parsed, data: this.serialize(), rows: this.rows, cols: this.cols }));
    });
  }

  /** The screen as parsed so far, for a restart to put back. Output still queued is a few milliseconds' worth. */
  serialize(): string {
    const extra = this.unserializedState();
    let text = "";
    for (const scrollback of [SCREEN_SCROLLBACK, 500, 0]) {
      text = plainPenIntoAlternate(this.serializer.serialize({ scrollback })) + extra;
      if (Buffer.byteLength(text) <= SNAPSHOT_MAX_BYTES) return text;
    }
    return text;
  }

  dispose(): void {
    this.disposed = true;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.term.dispose();
  }

  private create(rows: number, cols: number): void {
    this.term = new Terminal({ rows, cols, scrollback: SCREEN_SCROLLBACK, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer as never);
    this.term.loadAddon(new Unicode11Addon() as never);
    this.term.unicode.activeVersion = "11";
    this.term.onData((data) => {
      if (this.parsed >= this.quietUntil) this.options.reply(data);
    });
    // xterm answers colour requests from a renderer's theme, and a headless one has none.
    for (const ident of [10, 11, 12]) {
      this.term.parser.registerOscHandler(ident, (data) => this.answerDynamicColor(ident, data));
    }
    this.term.parser.registerOscHandler(4, (data) => this.answerPaletteColor(data));
  }

  private write(bytes: Uint8Array): void {
    const length = bytes.length;
    this.term.write(bytes, () => {
      this.parsed += length;
    });
  }

  /**
   * What the serializer leaves out and a pane needs to carry on as the program expects: a hidden
   * cursor, the mouse encoding (a TUI reading SGR mouse reports gets garbage in the default
   * one), and a scroll region, set last and around a saved cursor since setting one homes it.
   */
  private unserializedState(): string {
    const core = (this.term as unknown as { _core?: Internals })._core;
    let out = "";
    // Only a shape a program chose: the pane's own (a blinking block) stays otherwise.
    const { cursorStyle = "block", cursorBlink = false } = this.term.options;
    if (cursorStyle !== "block" || cursorBlink) out += `\x1b[${CURSOR_SHAPE[cursorStyle] - (cursorBlink ? 1 : 0)} q`;
    if (core?.coreService?.isCursorHidden) out += "\x1b[?25l";
    const encoding = ENCODING_MODE[core?.coreMouseService?.activeEncoding ?? ""];
    if (encoding) out += `\x1b[?${encoding}h`;
    const top = core?.buffer?.scrollTop ?? 0;
    const bottom = core?.buffer?.scrollBottom ?? this.term.rows - 1;
    if (top !== 0 || bottom !== this.term.rows - 1) out += `\x1b7\x1b[${top + 1};${bottom + 1}r\x1b8`;
    return out;
  }

  /** OSC 10/11/12: text, background, cursor. `?` asks; anything else sets, which a headless screen ignores. */
  private answerDynamicColor(ident: number, data: string): boolean {
    const parts = data.split(";");
    if (!parts.includes("?")) return false;
    parts.forEach((part, index) => {
      const which = ident + index;
      const colour = which === 10 ? this.colors?.foreground
        : which === 11 ? this.colors?.background
        : which === 12 ? (this.colors?.cursor ?? this.colors?.foreground) : undefined;
      if (part === "?" && colour) this.answer(`\x1b]${which};${xRgb(colour)}\x1b\\`);
    });
    return true;
  }

  /** OSC 4: `index;?` pairs for the sixteen colours a pane reports; the rest go unanswered. */
  private answerPaletteColor(data: string): boolean {
    const parts = data.split(";");
    let asked = false;
    for (let i = 0; i + 1 < parts.length; i += 2) {
      if (parts[i + 1] !== "?") continue;
      asked = true;
      const index = Number(parts[i]);
      const colour = Number.isInteger(index) ? this.colors?.palette?.[index] : undefined;
      if (colour) this.answer(`\x1b]4;${index};${xRgb(colour)}\x1b\\`);
    }
    return asked;
  }

  private answer(data: string): void {
    if (this.parsed >= this.quietUntil) this.options.reply(data);
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    const timer = setTimeout(() => this.rebuild(), REBUILD_QUIET_MS);
    timer.unref?.();
    this.rebuildTimer = timer;
  }

  /**
   * After a flood: a fresh emulator from the stream's retained bytes, parsed as history. That is
   * the old way of drawing a screen, and only ever used for this.
   */
  private rebuild(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    if (!this.lagging || this.disposed) return;
    const { rows, cols } = this.term;
    this.term.dispose();
    this.create(rows, cols);
    const history = this.options.history();
    this.lagging = false;
    this.written = this.parsed = history.offset;
    this.restore(history.bytes);
  }
}

/** `#rrggbb` as the `rgb:rrrr/gggg/bbbb` form colour answers use. */
function xRgb(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return "rgb:0000/0000/0000";
  return `rgb:${match[1]}${match[1]}/${match[2]}${match[2]}/${match[3]}${match[3]}`.toLowerCase();
}
