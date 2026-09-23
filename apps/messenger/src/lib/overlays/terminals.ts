import type { Copy } from "../copy.ts";
import type { Terminal } from "@real-bot/protocol";

/**
 * What a reader has taken so far. Bytes arrive from two places — a scrollback read over HTTP and
 * live frames over the socket — and the two overlap by design: subscribing first and reading
 * second would leave a hole, so both are asked for and the overlap is cut here.
 */
export type StreamCursor = { offset: number };

export type Accepted = {
  bytes: Uint8Array;
  cursor: StreamCursor;
  /** Bytes that went past before this reader got to them; the ring had moved on. */
  gap: number;
};

export function startCursor(offset = 0): StreamCursor {
  return { offset };
}

/**
 * Take what is new in this chunk. Anything already written is dropped rather than repeated, a
 * chunk that starts past the cursor reports the hole, and an entirely old chunk yields nothing.
 */
export function accept(cursor: StreamCursor, offset: number, bytes: Uint8Array): Accepted | null {
  const end = offset + bytes.length;
  if (end <= cursor.offset) return null;
  if (offset > cursor.offset) {
    return { bytes, cursor: { offset: end }, gap: offset - cursor.offset };
  }
  const overlap = cursor.offset - offset;
  return { bytes: overlap ? bytes.subarray(overlap) : bytes, cursor: { offset: end }, gap: 0 };
}

export function decodeBase64(data: string): Uint8Array {
  if (!data) return new Uint8Array(0);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Newest last, the way tabs accumulate. */
export function orderTerminals(items: Terminal[]): Terminal[] {
  return [...items].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** Which session a pane should show once the list changes under it. */
export function pickActive(items: Terminal[], current: string | null): string | null {
  if (current && items.some((row) => row.id === current)) return current;
  const live = orderTerminals(items).filter((row) => row.status === "live");
  return (live.at(-1) ?? orderTerminals(items).at(-1))?.id ?? null;
}

/**
 * What to call each session. The daemon titles a shell after its folder, so every one opened in
 * the workspace comes back with the same title; the second and later of a title get a number,
 * oldest first. Computed over the whole list, so a desktop tab and the phone's strip call the
 * same shell the same thing.
 */
export function terminalNames(items: readonly Terminal[]): Map<string, string> {
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  for (const row of orderTerminals([...items])) {
    const base = row.title || "/";
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    names.set(row.id, count === 1 ? base : `${base} ${count}`);
  }
  return names;
}

export function statusLabel(row: Terminal, t: Copy): string | null {
  if (row.status === "live") return null;
  if (row.status === "interrupted") return t.terminal.interrupted;
  return row.exit_code === 0 ? t.terminal.exited : t.terminal.exitedWith.replace("{code}", String(row.exit_code ?? ""));
}

/** The line a pane prints in place of bytes it will never see. */
export function gapNotice(bytes: number, t: Copy): string {
  return `\r\n\x1b[2m${t.terminal.dropped.replace("{bytes}", String(bytes))}\x1b[0m\r\n`;
}

/**
 * Keystrokes, in order, without a request per character.
 *
 * Two things go wrong without this. Concurrent posts can arrive in any order, and a terminal that
 * reorders your typing is worse than one that is slow. And a burst — a paste, a held key — would
 * be one request each. So at most one is ever in flight, and whatever is typed meanwhile rides
 * out together on the next one.
 */
export class InputQueue {
  private buffered: Uint8Array[] = [];
  private inFlight = false;

  constructor(
    private readonly send: (bytes: Uint8Array) => Promise<void>,
    private readonly onError: (cause: unknown) => void = () => undefined,
  ) {}

  push(bytes: Uint8Array): void {
    if (!bytes.length) return;
    this.buffered.push(bytes);
    if (!this.inFlight) void this.drain();
  }

  /** Resolves once nothing is queued or in flight; tests wait on it, the pane does not. */
  async idle(): Promise<void> {
    while (this.inFlight || this.buffered.length) await Promise.resolve();
  }

  private async drain(): Promise<void> {
    this.inFlight = true;
    try {
      while (this.buffered.length) {
        const batch = this.buffered;
        this.buffered = [];
        const total = batch.reduce((sum, chunk) => sum + chunk.length, 0);
        const merged = new Uint8Array(total);
        let filled = 0;
        for (const chunk of batch) { merged.set(chunk, filled); filled += chunk.length; }
        try {
          await this.send(merged);
        } catch (cause) {
          this.onError(cause);
        }
      }
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * The keys a phone keyboard cannot send.
 *
 * Without these a terminal on a phone is a log viewer: there is no Ctrl, no Tab, no arrows, and
 * no Escape on a software keyboard, so a running command could be watched but never stopped and
 * a path could never be completed. Bytes, not key names — the pty's line discipline reads bytes.
 *
 * Only what the keyboard cannot send. `/` and `-` were here too and earned their place by
 * pushing the last key off the edge of a 390px screen.
 */
export const TERMINAL_KEYS: ReadonlyArray<{ id: string; label: string; bytes: string }> = [
  { id: "ctrl-c", label: "^C", bytes: "\x03" },
  { id: "ctrl-d", label: "^D", bytes: "\x04" },
  { id: "tab", label: "Tab", bytes: "\t" },
  { id: "up", label: "↑", bytes: "\x1b[A" },
  { id: "down", label: "↓", bytes: "\x1b[B" },
  { id: "esc", label: "Esc", bytes: "\x1b" },
];
