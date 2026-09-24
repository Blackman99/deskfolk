import { expect, test } from "bun:test";
import type { Terminal } from "@real-bot/protocol";
import { accept, decodeBase64, encodeBase64, InputQueue, TERMINAL_KEY_ROWS, orderTerminals, pickActive, startCursor, statusLabel, terminalNames, tildePath } from "./terminals.ts";
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

test("the phone key bar sends bytes a software keyboard cannot, Ctrl-V among them", () => {
  const all = TERMINAL_KEY_ROWS.flat();
  const bytes = Object.fromEntries(all.flatMap((key) => (key.kind === "bytes" ? [[key.id, key.bytes]] : [])));
  expect(bytes["ctrl-c"]).toBe("\x03");
  expect(bytes["ctrl-d"]).toBe("\x04");
  expect(bytes["ctrl-v"]).toBe("\x16");
  expect(bytes["tab"]).toBe("\t");
  expect(bytes["shift-tab"]).toBe("\x1b[Z");
  expect(bytes["esc"]).toBe("\x1b");
  // Enter is on the keyboard too, but a TUI's choices are answered with the keyboard down.
  expect(bytes["enter"]).toBe("\r");
  expect(all.filter((key) => key.kind === "arrow").map((key) => key.id).sort()).toEqual(["down", "left", "right", "up"]);
  expect(all.map((key) => key.kind)).toEqual(expect.arrayContaining(["ctrl", "paste", "keyboard"]));
  // Two full rows of seven: across a 390px screen, none sits off the edge.
  expect(TERMINAL_KEY_ROWS.map((row) => row.length)).toEqual([7, 7]);
  // `/` and `-` are on every keyboard.
  expect(all.some((key) => "label" in key && (key.label === "/" || key.label === "-"))).toBe(false);
  // Every entry is a distinct id, and a label a thumb can read where it has one.
  expect(new Set(all.map((key) => key.id)).size).toBe(all.length);
  expect(all.every((key) => !("label" in key) || key.label.length <= 4)).toBe(true);
});

test("a path under a home folder reads the way the prompt writes it", () => {
  expect(tildePath("/Users/you/real-bot-workspace")).toBe("~/real-bot-workspace");
  expect(tildePath("/Users/you")).toBe("~");
  expect(tildePath("/Users/you/a/b")).toBe("~/a/b");
  expect(tildePath("/tmp/Users/you")).toBe("/tmp/Users/you");
  expect(tildePath("/")).toBe("/");
});

test("shells opened in the same folder are told apart by number, oldest first, the same everywhere", () => {
  const row = (id: string, title: string, created_at: string): Terminal => ({
    id, title, cwd: `/work/${title}`, rows: 24, cols: 80, created_at, status: "live", exit_code: null, stream_end: 0,
  });
  const names = terminalNames([
    row("c", "real-bot", "2026-09-23T03:00:00.000Z"),
    row("a", "real-bot", "2026-09-23T01:00:00.000Z"),
    row("d", "scratch", "2026-09-23T04:00:00.000Z"),
    row("b", "real-bot", "2026-09-23T02:00:00.000Z"),
  ]);
  expect([...["a", "b", "c", "d"]].map((id) => names.get(id))).toEqual(["real-bot", "real-bot 2", "real-bot 3", "scratch"]);
});
