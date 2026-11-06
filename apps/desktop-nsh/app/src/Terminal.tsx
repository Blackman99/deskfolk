/**
 * A runtime terminal on every target: `TerminalGrid` (Rust, `deskfolk/native`) holds and draws the
 * screen; this file attaches it to the runtime the way the messenger's `TerminalView.svelte` does
 * (the screen's replay, then `watch` from its offset, stream frames after it) and takes the keys.
 *
 * Keys: typed text and input methods arrive through a hidden input (composition stays in the input
 * until it commits); Return, Backspace and Escape through its key presses; arrows, Tab and Control
 * chords through `keymap` while the terminal has the keyboard.
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
  }
  const ctrl = /^ctrl\+([a-z])$/.exec(keystroke);
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96);
  return null;
}

const KEYSTROKES = [
  "up", "down", "left", "right", "tab", "shift+tab", "home", "end", "pageup", "pagedown", "delete",
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
  let composing = false;
  // What of the input's text has gone to the pty already; the input is emptied after each change.
  let sent = "";
  let attached = false;
  let input: { focus(): void } | undefined;
  const early: StreamFrame[] = [];

  const send = (text: string) => {
    if (!text) return;
    void runtime.client?.terminalInput(id, encode(text)).catch((e) => console.error("terminal input", String(e)));
  };

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
          composing = e.composing;
        }}
        onChange={(e) => {
          draft.set(e.value);
          if (composing) return;
          const text = e.value;
          if (text.startsWith(sent)) send(text.slice(sent.length));
          // Shorter: a Backspace edited the input; its key press already went to the pty.
          sent = text;
          if (text) {
            setTimeout(() => {
              sent = "";
              draft.set("");
            }, 0);
          }
        }}
        onKeyPress={(e) => {
          if (e.key === "Enter") send("\r");
          else if (e.key === "Backspace") send("\x7f");
          else if (e.key === "Escape") send("\x1b");
        }}
        submitBehavior="submit"
        style={{ position: "absolute", left: 0, bottom: 0, width: 2, height: 2, opacity: 0 }}
      />
    </View>
  );
}
