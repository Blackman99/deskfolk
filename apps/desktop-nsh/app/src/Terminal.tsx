/**
 * A runtime terminal on every target: `TerminalGrid` (Rust, `deskfolk/native`) holds and draws the
 * screen; this file attaches it to the runtime the way the messenger's `TerminalView.svelte` does
 * (the screen's replay, then `watch` from its offset, stream frames after it) and takes the keys.
 *
 * Keys: typed text and input methods arrive through a hidden input, kept on the cursor's cell so an
 * input method's candidates open there; what it composes is drawn by the grid at the cursor and
 * sent once committed. Return and Backspace come through the input's key presses; arrows, Tab,
 * Escape, Control chords and macOS's line editing (⌘⌫, ⌘←, ⌥←, ...) through `keymap` while the
 * terminal has the keyboard, except while an input method composes: `keymap` sees keys before the
 * input does, so those keys would leave the input method for the shell.
 */
import { cleanup, colorScheme, keymap, signal, View, type ViewRef } from "nsh";
import { Input } from "nsh/base";
import { TerminalGrid, Terminals } from "deskfolk/native";
import type { StreamFrame } from "@real-bot/protocol";
import { runtime } from "./runtime";
import { onWheel } from "./platform/wheel";

export function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]];
    out += table[a >> 2]! + table[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? "=" : table[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? "=" : table[c & 63]!;
  }
  return out;
}

/** What a key sends, by `keymap` keystroke: VT sequences, application cursor keys when asked. */
export function keyBytes(keystroke: string, appCursor: boolean): string | null {
  const arrow = (key: string) => (appCursor ? `\x1bO${key}` : `\x1b[${key}`);
  switch (keystroke) {
    case "up":
      return arrow("A");
    case "down":
      return arrow("B");
    case "right":
      return arrow("C");
    case "left":
      return arrow("D");
    case "tab":
      return "\t";
    case "shift+tab":
      return "\x1b[Z";
    case "home":
      return "\x1b[H";
    case "end":
      return "\x1b[F";
    case "pageup":
      return "\x1b[5~";
    case "pagedown":
      return "\x1b[6~";
    case "delete":
      return "\x1b[3~";
    // Escape is the terminal's: the input would take it as "leave the field" and drop the keyboard.
    case "escape":
      return "\x1b";
    // macOS's line editing, as Terminal.app, iTerm2 and Ghostty send it: ⌘⌫ deletes to the line's
    // start (Ctrl-U), ⌘← / ⌘→ go to its start and end (Ctrl-A / Ctrl-E), ⌥← / ⌥→ a word back and
    // forward (Meta-b / Meta-f), ⌥⌫ deletes the word before the cursor (Meta-Backspace).
    case "cmd+backspace":
      return "\x15";
    case "cmd+left":
      return "\x01";
    case "cmd+right":
      return "\x05";
    case "alt+left":
      return "\x1bb";
    case "alt+right":
      return "\x1bf";
    case "alt+backspace":
      return "\x1b\x7f";
  }
  const ctrl = /^ctrl\+([a-z])$/.exec(keystroke);
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96);
  return null;
}

/**
 * What sends text to terminal `id`'s pty: one request at a time, what was typed meanwhile sent
 * together after it. A request per key, all in flight at once, reached the shell out of order:
 * `exit 3⏎` typed quickly ran as `xi3⏎`.
 */
export function terminalSender(id: string): (text: string) => void {
  let unsent = "";
  let sending = false;
  return (text: string) => {
    if (!text) return;
    unsent += text;
    if (sending) return;
    sending = true;
    void (async () => {
      while (unsent) {
        const chunk = unsent;
        unsent = "";
        const client = runtime.client;
        if (!client) break;
        await client.terminalInput(id, encode(chunk)).catch((e) => console.error("terminal input", String(e)));
      }
      unsent = "";
      sending = false;
    })();
  };
}

const KEYSTROKES = [
  "up", "down", "left", "right", "tab", "shift+tab", "home", "end", "pageup", "pagedown", "delete", "escape",
  "cmd+backspace", "cmd+left", "cmd+right", "alt+left", "alt+right", "alt+backspace",
  ..."abcdefghijklmnopqrstuvwxyz".split("").map((c) => `ctrl+${c}`),
];

export function CanvasTerminal(props: { id: string; onExit?: () => void }) {
  const id = props.id;
  const focused = signal(false);
  // Moved after changes made through `Terminals`, at most once a frame however many frames of
  // output came in, so the grid draws again once per frame rather than once per frame of bytes.
  const version = signal(0);
  let drawPending = false;
  const touched = () => {
    if (drawPending) return;
    drawPending = true;
    setTimeout(() => {
      drawPending = false;
      version.update((v) => v + 1);
    }, 16);
  };
  const draft = signal("");
  // An input method's composition: whether one is open, and what it holds (the grid draws that).
  let composing = false;
  const composition = signal("");
  // What the input holds, as its last change said (a composition's commit comes before its end).
  let field = "";
  // What of the input's text has gone to the pty already; the input is emptied after each change.
  let sent = "";
  let attached = false;
  let input: { focus(): void } | undefined;
  const early: StreamFrame[] = [];

  const send = terminalSender(id);

  const stop = runtime.onStream(id, (frame) => {
    if (!attached) {
      early.push(frame);
      return;
    }
    if (Terminals.feed(id, frame.data, frame.offset)) touched();
    if (frame.closed) props.onExit?.();
  });
  cleanup(stop);

  void (async () => {
    const client = runtime.client;
    if (!client) throw new Error("not connected");
    const screen = await client.terminalScreen(id);
    Terminals.reset(id, screen.rows, screen.cols, screen.data, screen.offset);
    attached = true;
    for (const frame of early.splice(0)) Terminals.feed(id, frame.data, frame.offset);
    touched();
    await client.watchTerminal(id, screen.offset);
  })().catch((e) => console.error("terminal attach", String(e)));

  // The wheel and two-finger scrolling move through the history, a line per cell height
  // (`terminal.rs`: 1.25 × the font size), the remainder carried to the next event.
  let area: ViewRef | undefined;
  let carried = 0;
  const FONT_SIZE = 13;
  onWheel(
    () => area,
    (e) => {
      const lines = carried - e.dy / Math.ceil(FONT_SIZE * 1.25);
      const whole = Math.trunc(lines);
      carried = lines - whole;
      if (whole === 0) return;
      Terminals.scroll(id, whole);
      touched();
    },
  );

  // Where the cursor is drawn (`[x, y, width, height]` from the grid's top-left; empty while the view
  // is back in the history), read again after every change. A shell built before `caret` has none.
  const caret = (): number[] => {
    version();
    return Terminals.caret?.(id) ?? [];
  };
  // The input sits on the cursor's cell, a cell tall and wide enough that a composition does not
  // scroll it, so an input method opens its candidates under the cursor; it stays invisible (the
  // grid draws the composition) and lets presses through to the terminal.
  const inputBox = () => {
    const [x, y, , height] = caret();
    return x === undefined || y === undefined || height === undefined
      ? { position: "absolute" as const, left: 0, bottom: 0, width: 2, height: 2, opacity: 0, pointerEvents: "none" as const }
      : { position: "absolute" as const, left: x, top: y, width: 320, height, opacity: 0, pointerEvents: "none" as const };
  };

  // The input's text as a change, past what was sent; emptied on the next turn.
  const typed = (text: string) => {
    if (text.startsWith(sent)) send(text.slice(sent.length));
    // Shorter: a Backspace edited the input; its key press already went to the pty.
    sent = text;
    if (text) {
      setTimeout(() => {
        sent = "";
        field = "";
        draft.set("");
      }, 0);
    }
  };

  let unbind: (() => void) | null = null;
  const bindKeys = () => {
    unbind?.();
    const bindings: Record<string, (e: { keystroke: string }) => void> = {};
    for (const keystroke of KEYSTROKES) {
      bindings[keystroke] = () => {
        const [appCursor] = Terminals.modes(id);
        const bytes = keyBytes(keystroke, appCursor ?? false);
        if (bytes) send(bytes);
      };
    }
    unbind = keymap.bind(bindings, { when: "always", repeat: true });
  };
  cleanup(() => unbind?.());

  return (
    <View class="flex-1" onPress={() => input?.focus()} testID="terminal" ref={(node) => (area = node)}>
      <TerminalGrid
        id={id}
        fontSize={FONT_SIZE}
        dark={colorScheme() === "dark"}
        focused={focused()}
        version={version()}
        preedit={composition()}
        onResize={(e) => void runtime.client?.terminalResize(id, e.rows, e.cols)}
      />
      <Input
        ref={(node) => (input = node)}
        value={draft()}
        testID="terminal-keys"
        onFocus={() => {
          focused.set(true);
          bindKeys();
        }}
        onBlur={() => {
          focused.set(false);
          unbind?.();
          unbind = null;
        }}
        onCompositionChange={(e) => {
          const ended = composing && !e.composing;
          composing = e.composing;
          composition.set(e.composing ? e.text : "");
          // While it composes, the keys are the input method's: arrows and Tab pick candidates,
          // Escape cancels.
          if (e.composing) {
            unbind?.();
            unbind = null;
          } else if (focused() && !unbind) bindKeys();
          // What it committed came in the input's last change, before this end: send it now.
          if (ended) {
            draft.set(field);
            typed(field);
          }
        }}
        onChange={(e) => {
          field = e.value;
          // A commit comes while the composition is still open; it is sent when that ends. A value
          // set meanwhile would wait for the end and land on what the user types next.
          if (composing) return;
          draft.set(e.value);
          typed(e.value);
        }}
        onKeyPress={(e) => {
          // Backspace while composing edits the composition (emptying it reports one too).
          if (composing) return;
          if (e.key === "Enter") send("\r");
          else if (e.key === "Backspace") send("\x7f");
          else if (e.key === "Escape") send("\x1b");
        }}
        submitBehavior="submit"
        style={inputBox()}
      />
    </View>
  );
}
