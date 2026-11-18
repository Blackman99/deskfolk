/**
 * A runtime terminal on NSH's own `Terminal` (`nsh/base`), on every target: the workbench's
 * terminal tabs, the phone's terminal page (`ui/overlays/TerminalPage.tsx`, whose key bar reaches
 * in through `onHandle`) and `--pane terminal`. `Terminal` draws the lines, scrolls the history, selects and
 * copies, takes the keys (⌘ line editing on Apple platforms, bracketed pastes) and an input
 * method's composition at the cursor; this file attaches it to the runtime the way the messenger's
 * `TerminalView.svelte` does.
 *
 * Attached once the terminal has laid out and the pty has taken that size: the screen's replay, so
 * the runtime draws it for these rows and columns (`Terminal` sizes itself; it takes no size from
 * the app), then `watch` from its offset, frames already on the screen skipped. `RuntimeTerminals`
 * (`deskfolk/native`) gives it an emulator that never answers the program (the runtime's screen
 * does that for every pane) and draws in the app's palette. Taken off the screen it stops watching.
 */
import { cleanup, colorScheme } from "nsh";
import { Terminal, type TerminalRef } from "nsh/base";
import { RuntimeTerminals } from "deskfolk/native";
import type { StreamFrame } from "@real-bot/protocol";
import { bracketedPasteMode, cursorKeysMode } from "./m/overlays/terminal-keys.ts";
import { runtime } from "./runtime";

/** Text as the runtime's terminal input takes it: UTF-8 in base64. */
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

/** Base64 as bytes. */
export function bytesOf(base64: string): Uint8Array {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * What of a frame of `bytes` from stream offset `offset` is not on a screen that has reached `next`:
 * all of it, its end, or nothing (`null`).
 */
export function unseen(next: number, offset: number, bytes: Uint8Array): Uint8Array | null {
  const end = offset + bytes.length;
  if (end <= next) return null;
  return offset >= next ? bytes : bytes.subarray(next - offset);
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

/**
 * What the phone's key bar reaches the terminal through: text for the pty in the order typing goes,
 * the keyboard, and whether the program on screen asked for application cursor keys.
 */
export type TerminalHandle = {
  send(text: string): void;
  focus(): void;
  applicationCursorKeys(): boolean;
  bracketedPaste(): boolean;
};

export function NshTerminal(props: {
  id: string;
  onExit?: () => void;
  onHandle?: (handle: TerminalHandle) => void;
  /** What typed text becomes before it goes (the phone's Ctrl, latched for the next key). */
  typed?: (data: string) => string;
}) {
  const id = props.id;
  const send = terminalSender(id);
  let term: TerminalRef | undefined;
  // One decoder for the stream: a character split across two frames comes out whole.
  const decoder = new TextDecoder();
  let next = 0;
  let attached = false;
  let attaching = false;
  let application = false;
  let bracketed = false;
  const early: StreamFrame[] = [];

  const write = (text: string) => {
    application = cursorKeysMode(text, application);
    bracketed = bracketedPasteMode(text, bracketed);
    term?.write(text);
  };

  const show = (frame: StreamFrame) => {
    const bytes = bytesOf(frame.data);
    const fresh = unseen(next, frame.offset, bytes);
    if (!fresh) return;
    next = frame.offset + bytes.length;
    write(decoder.decode(fresh, { stream: true }));
  };

  const stop = runtime.onStream(id, (frame) => {
    if (attached) show(frame);
    else early.push(frame);
    if (frame.closed) props.onExit?.();
  });
  cleanup(stop);
  // Off the screen, the bytes stop coming: over the relay they would cost a phone's data for
  // nothing. The next mount reads the screen again and watches from there.
  cleanup(() => {
    if (attached) void runtime.client?.unwatchTerminal(id).catch(() => undefined);
  });
  props.onHandle?.({ send, focus: () => term?.focus(), applicationCursorKeys: () => application, bracketedPaste: () => bracketed });

  const attach = async () => {
    const client = runtime.client;
    if (!client) throw new Error("not connected");
    const screen = await client.terminalScreen(id);
    write(new TextDecoder().decode(bytesOf(screen.data)));
    next = screen.offset;
    attached = true;
    for (const frame of early.splice(0)) show(frame);
    await client.watchTerminal(id, screen.offset);
  };

  // `Terminal` reports its size once it is laid out, then on every change.
  const resized = (cols: number, rows: number) => {
    void (async () => {
      await runtime.client?.terminalResize(id, rows, cols);
      if (attaching) return;
      attaching = true;
      await attach();
    })().catch((e) => console.error("terminal attach", String(e)));
  };

  return (
    <RuntimeTerminals dark={colorScheme() === "dark"}>
      <Terminal
        ref={(r) => (term = r)}
        testID="terminal"
        accessibilityLabel="Terminal"
        scrollback={10000}
        fontSize={13}
        lineHeight={17}
        cursorClass="bg-brand/55"
        class="flex-1 min-h-0 p-2"
        onData={(e) => send(props.typed ? props.typed(e.data) : e.data)}
        onResize={(e) => resized(e.cols, e.rows)}
      />
    </RuntimeTerminals>
  );
}
