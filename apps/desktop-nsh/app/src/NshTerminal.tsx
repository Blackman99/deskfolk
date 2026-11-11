/**
 * A runtime terminal on NSH's own `Terminal` (`nsh/base`, longbridge/nsh#1111), behind
 * `--terminal nsh` until it can stand in for the canvas terminal (`Terminal.tsx`). ADR 0107,
 * addendum 18, lists what it still lacks, all of it NSH's to change: an input method's composition
 * drawn at the cursor and its candidates opened there (longbridge/nsh#1626), macOS's ⌘ line editing
 * keys (#1627), and wide characters kept on their cells (#1628).
 *
 * Attached the way the canvas one is: the screen's replay, then `watch` from its offset, frames
 * already on the screen skipped. The replay is asked for once the terminal has laid out and the
 * pty has taken that size, so the runtime draws it for these rows and columns (`Terminal` sizes
 * itself; it takes no size from the app). `RuntimeTerminals` (`deskfolk/native`) gives it an
 * emulator that never answers the program: the runtime's screen does that for every pane.
 */
import { cleanup, Text } from "nsh";
import { Terminal, type TerminalRef } from "nsh/base";
import * as native from "deskfolk/native";
import type { StreamFrame } from "@real-bot/protocol";
import { runtime } from "./runtime";
import { terminalSender } from "./Terminal";

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

// Looked up rather than imported by name: a host built before `RuntimeTerminals` has none, and a
// named import of it would fail the whole bundle there (`dev.ts --watch` publishes TSX ahead of the
// host's rebuild).
const RuntimeTerminals = (native as Partial<typeof native>).RuntimeTerminals;

export function NshTerminal(props: { id: string; onExit?: () => void }) {
  if (!RuntimeTerminals) {
    return <Text class="m-auto p-6 text-[13px] text-ink-muted text-center">This shell was built before RuntimeTerminals: rebuild it (restart pnpm dev) to use --terminal nsh.</Text>;
  }
  const Emulators = RuntimeTerminals;
  const id = props.id;
  const send = terminalSender(id);
  let term: TerminalRef | undefined;
  // One decoder for the stream: a character split across two frames comes out whole.
  const decoder = new TextDecoder();
  let next = 0;
  let attached = false;
  let attaching = false;
  const early: StreamFrame[] = [];

  const show = (frame: StreamFrame) => {
    const bytes = bytesOf(frame.data);
    const fresh = unseen(next, frame.offset, bytes);
    if (!fresh) return;
    next = frame.offset + bytes.length;
    term?.write(decoder.decode(fresh, { stream: true }));
  };

  const stop = runtime.onStream(id, (frame) => {
    if (attached) show(frame);
    else early.push(frame);
    if (frame.closed) props.onExit?.();
  });
  cleanup(stop);

  const attach = async () => {
    const client = runtime.client;
    if (!client) throw new Error("not connected");
    const screen = await client.terminalScreen(id);
    term?.write(new TextDecoder().decode(bytesOf(screen.data)));
    next = screen.offset;
    attached = true;
    for (const frame of early.splice(0)) show(frame);
    await client.watchTerminal(id, screen.offset);
  };

  const resized = (cols: number, rows: number) => {
    void (async () => {
      await runtime.client?.terminalResize(id, rows, cols);
      if (attaching) return;
      attaching = true;
      await attach();
    })().catch((e) => console.error("terminal attach", String(e)));
  };

  // `Terminal` reports a size only when it differs from the 80 × 24 it starts at, so laid out at
  // exactly that size it says nothing (`Term::resize`, longbridge/nsh#1630). Once it has been laid
  // out, a terminal that heard no size by then attaches at that one.
  let laidOut = false;
  const firstLayout = () => {
    if (laidOut) return;
    laidOut = true;
    setTimeout(() => {
      if (!attaching) resized(80, 24);
    }, 100);
  };

  return (
    <Emulators>
      <Terminal
        ref={(r) => (term = r)}
        testID="terminal"
        accessibilityLabel="Terminal"
        scrollback={10000}
        fontSize={13}
        lineHeight={17}
        cursorClass="bg-foreground/50"
        class="flex-1 min-h-0 p-2"
        onData={(e) => send(e.data)}
        onResize={(e) => resized(e.cols, e.rows)}
        onLayout={firstLayout}
      />
    </Emulators>
  );
}
