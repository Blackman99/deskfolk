import { expect, test } from "bun:test";
import type { Terminal } from "@real-bot/protocol";
import { accept, decodeBase64, encodeBase64, InputQueue, TERMINAL_KEYS, orderTerminals, pickActive, startCursor, statusLabel } from "./terminals.ts";
import { COPY } from "../copy.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

const row = (over: Partial<Terminal> = {}): Terminal => ({
  id: "A", title: "work", cwd: "/w", rows: 24, cols: 80,
  created_at: "2026-09-22T10:00:00.000Z", status: "live", exit_code: null, stream_end: 0, ...over,
});

test("a fresh cursor takes everything", () => {
  const taken = accept(startCursor(), 0, bytes("hello"))!;
  expect(text(taken.bytes)).toBe("hello");
  expect(taken.cursor.offset).toBe(5);
  expect(taken.gap).toBe(0);
});

test("the overlap between a scrollback read and a live frame is written once", () => {
  // Watching and reading both start at 0 on purpose: doing one then the other would lose
  // whatever arrived in between.
  let cursor = startCursor();
  const first = accept(cursor, 0, bytes("hello "))!;
  cursor = first.cursor;
  const second = accept(cursor, 0, bytes("hello world"))!;
  expect(text(second.bytes)).toBe("world");
  expect(second.cursor.offset).toBe(11);
  expect(second.gap).toBe(0);
});

test("a chunk that is entirely old yields nothing", () => {
  const cursor = startCursor(100);
  expect(accept(cursor, 0, bytes("ancient"))).toBeNull();
  expect(accept(cursor, 93, bytes("ancient"))).toBeNull();
});

test("a chunk that starts past the cursor reports the hole rather than hiding it", () => {
  const taken = accept(startCursor(10), 60, bytes("later"))!;
  expect(taken.gap).toBe(50);
  expect(text(taken.bytes)).toBe("later");
  expect(taken.cursor.offset).toBe(65);
});

test("base64 survives bytes that are not text", () => {
  const raw = new Uint8Array([0, 27, 91, 50, 74, 255, 254]);
  expect(decodeBase64(encodeBase64(raw))).toEqual(raw);
  expect(decodeBase64("")).toEqual(new Uint8Array(0));
});

test("sessions are ordered oldest first and the active one survives a list change", () => {
  const a = row({ id: "A", created_at: "2026-09-22T10:00:00.000Z" });
  const b = row({ id: "B", created_at: "2026-09-22T11:00:00.000Z" });
  expect(orderTerminals([b, a]).map((r) => r.id)).toEqual(["A", "B"]);
  expect(pickActive([a, b], "A")).toBe("A");
  expect(pickActive([a, b], "GONE")).toBe("B");
  expect(pickActive([], "A")).toBeNull();
});

test("a live session is preferred over a finished one when the active one disappears", () => {
  const dead = row({ id: "DEAD", status: "exited", created_at: "2026-09-22T12:00:00.000Z" });
  const live = row({ id: "LIVE", created_at: "2026-09-22T09:00:00.000Z" });
  expect(pickActive([dead, live], null)).toBe("LIVE");
});

test("a finished session says how it finished", () => {
  const t = COPY.zh;
  expect(statusLabel(row(), t)).toBeNull();
  expect(statusLabel(row({ status: "exited", exit_code: 0 }), t)).toBe(t.terminal.exited);
  expect(statusLabel(row({ status: "exited", exit_code: 130 }), t)).toContain("130");
  expect(statusLabel(row({ status: "interrupted" }), t)).toBe(t.terminal.interrupted);
});

test("typing keeps its order even when every keystroke is its own call", async () => {
  const sent: string[] = [];
  let release: (() => void) | null = null;
  const queue = new InputQueue(async (bytes) => {
    sent.push(text(bytes));
    // Hold the first request open so the rest have to queue behind it.
    if (sent.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  });
  queue.push(bytes("e"));
  await Promise.resolve();
  for (const ch of "cho hi") queue.push(bytes(ch));
  release?.();
  await queue.idle();
  expect(sent.join("")).toBe("echo hi");
  // A burst becomes one request, not one per character.
  expect(sent.length).toBeLessThan(7);
});

test("a failed send does not wedge the queue", async () => {
  const sent: string[] = [];
  const failures: unknown[] = [];
  let first = true;
  const queue = new InputQueue(
    async (bytes) => {
      if (first) { first = false; throw new Error("offline"); }
      sent.push(text(bytes));
    },
    (cause) => failures.push(cause),
  );
  queue.push(bytes("a"));
  await queue.idle();
  queue.push(bytes("b"));
  await queue.idle();
  expect(failures).toHaveLength(1);
  expect(sent).toEqual(["b"]);
});

test("the phone key row sends bytes a software keyboard cannot", () => {
  const keys = Object.fromEntries(TERMINAL_KEYS.map((key) => [key.id, key.bytes]));
  expect(keys["ctrl-c"]).toBe("\x03");
  expect(keys["ctrl-d"]).toBe("\x04");
  expect(keys["tab"]).toBe("\t");
  expect(keys["up"]).toBe("\x1b[A");
  expect(keys["esc"]).toBe("\x1b");
  // Only keys a software keyboard cannot send: `/` and `-` are on it, and they pushed the last
  // key off the edge of a 390px screen.
  expect(TERMINAL_KEYS).toHaveLength(6);
  expect(TERMINAL_KEYS.some((key) => key.label === "/")).toBe(false);
  // Every entry is a distinct id with a label a thumb can read.
  expect(new Set(TERMINAL_KEYS.map((key) => key.id)).size).toBe(TERMINAL_KEYS.length);
  expect(TERMINAL_KEYS.every((key) => key.label.length <= 4 && key.bytes.length > 0)).toBe(true);
});
