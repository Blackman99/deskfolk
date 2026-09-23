import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { MAX_BACKLOG_BYTES, SNAPSHOT_MAX_BYTES, TerminalScreen } from "./terminal-screen";

const bytes = (text: string) => new TextEncoder().encode(text);

function screen(options: { rows?: number; cols?: number; history?: () => { offset: number; bytes: Uint8Array } } = {}) {
  const replies: string[] = [];
  const s = new TerminalScreen({
    rows: options.rows ?? 10,
    cols: options.cols ?? 40,
    reply: (data) => replies.push(data),
    history: options.history ?? (() => ({ offset: 0, bytes: new Uint8Array(0) })),
  });
  return { s, replies };
}

/** What a pane shows once it has written a snapshot: the lines, the buffer and the cursor. */
async function drawn(data: string, rows = 10, cols = 40) {
  const term = new Terminal({ rows, cols, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(data, resolve));
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)!.translateToString(true));
  const core = (term as unknown as { _core: { coreService: { isCursorHidden: boolean }; coreMouseService: { activeEncoding: string }; buffer: { scrollTop: number; scrollBottom: number } } })._core;
  return {
    text: lines.join("\n").trimEnd(), type: buffer.type, x: buffer.cursorX, y: buffer.cursorY,
    hidden: core.coreService.isCursorHidden, encoding: core.coreMouseService.activeEncoding,
    region: [core.buffer.scrollTop, core.buffer.scrollBottom],
  };
}


test("a program's request is answered once, by the screen, as if typed", async () => {
  const { s, replies } = screen();
  s.feed(bytes("\x1b[c"));
  await s.snapshot();
  expect(replies).toEqual(["\x1b[?1;2c"]);
});

test("a request in restored history is not answered; the same request live afterwards is", async () => {
  // A TUI asked at startup once. Answering it again on every restart typed `1;2c` at the prompt.
  const { s, replies } = screen();
  s.restore(bytes("claude\x1b[>0q\x1b[?u\x1b[c\x1b[6n\r\n"));
  s.feed(bytes("\x1b[c"));
  await s.snapshot();
  expect(replies).toEqual(["\x1b[?1;2c"]);
});

test("a snapshot draws the same screen: a full-screen program, its cursor, its mouse and its scroll region", async () => {
  const { s } = screen();
  s.feed(bytes("$ vim notes\r\n"));
  s.feed(bytes("\x1b[?1049h\x1b[H\x1b[1mnotes\x1b[0m\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[2;9r\x1b[5;7Hhere"));
  const snap = await s.snapshot();
  const pane = await drawn(snap.data);
  expect(pane.type).toBe("alternate");
  expect(pane.text.split("\n")[0]).toBe("notes");
  expect(pane.text).toContain("      here");
  expect([pane.x, pane.y]).toEqual([10, 4]);
  expect(pane.hidden).toBe(true);
  expect(pane.encoding).toBe("SGR");
  expect(pane.region).toEqual([1, 8]);
  // Leaving the program in the pane goes back to the shell underneath, as it would have.
  const after = new Terminal({ rows: 10, cols: 40, allowProposedApi: true });
  await new Promise<void>((resolve) => after.write(snap.data + "\x1b[?1049l", resolve));
  expect(after.buffer.active.getLine(0)!.translateToString(true)).toBe("$ vim notes");
});

test("a snapshot's offset is where its bytes end, so live frames after it are neither lost nor doubled", async () => {
  const { s } = screen();
  s.feed(bytes("first "));
  const pending = s.snapshot();
  s.feed(bytes("second"));
  const snap = await pending;
  expect(snap.offset).toBe("first ".length);
  expect((await drawn(snap.data)).text).toBe("first");
  expect((await s.snapshot()).offset).toBe("first second".length);
});

test("colour requests are answered with the attached pane's colours, and not before there is one", async () => {
  const { s, replies } = screen();
  s.feed(bytes("\x1b]11;?\x07"));
  await s.snapshot();
  expect(replies).toEqual([]);
  s.setColors({ foreground: "#0f172a", background: "#ffffff", palette: ["#0f172a", "#dc2626"] });
  s.feed(bytes("\x1b]11;?\x07\x1b]10;?\x1b\\\x1b]4;1;?\x07"));
  await s.snapshot();
  expect(replies).toEqual(["\x1b]11;rgb:ffff/ffff/ffff\x1b\\", "\x1b]10;rgb:0f0f/1717/2a2a\x1b\\", "\x1b]4;1;rgb:dcdc/2626/2626\x1b\\"]);
  // Restored history asked too; that was a previous program's question.
  replies.length = 0;
  s.restore(bytes("\x1b]11;?\x07"));
  await s.snapshot();
  expect(replies).toEqual([]);
});

test("a screen too heavy for one remote message goes with less history rather than failing", async () => {
  const { s } = screen({ rows: 50, cols: 200 });
  let colourful = "";
  for (let line = 0; line < 3000; line++) {
    for (let cell = 0; cell < 50; cell++) colourful += `\x1b[38;5;${(line + cell) % 256}m\x1b[48;5;${cell}mab`;
    colourful += "\x1b[0m\r\n";
  }
  s.feed(bytes(colourful + "the end"));
  const snap = await s.snapshot();
  expect(Buffer.byteLength(snap.data)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
  expect((await drawn(snap.data, 50, 200)).text.endsWith("the end")).toBe(true);
});

test("a flood past the backlog is dropped, and the screen is rebuilt from the stream once it stops", async () => {
  const tail = bytes("\x1b[2J\x1b[Hafter the flood\x1b[c");
  let total = 0;
  const { s, replies } = screen({ history: () => ({ offset: total - tail.length, bytes: tail }) });
  const flood = new Uint8Array(MAX_BACKLOG_BYTES + 1).fill(0x79); // "yyyy…"
  total = flood.length + tail.length;
  s.feed(flood);
  s.feed(tail);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const snap = await s.snapshot();
  expect(snap.offset).toBe(total);
  expect((await drawn(snap.data)).text).toContain("after the flood");
  // The tail is history by then: its request belonged to the flood's moment.
  expect(replies).toEqual([]);
});

test("⌘K clears history and screen, keeping the cursor's line", async () => {
  const { s } = screen();
  s.feed(bytes("old output\r\nmore\r\n$ "));
  await s.snapshot();
  s.clear();
  expect((await drawn((await s.snapshot()).data)).text).toBe("$");
});

test("a resize takes the pty's new size, which the next snapshot is drawn at", async () => {
  const { s } = screen();
  s.resize(20, 100);
  const snap = await s.snapshot();
  expect([snap.rows, snap.cols]).toEqual([20, 100]);
});

test("emoji take two cells, as they do in the panes", async () => {
  const { s, replies } = screen();
  s.feed(bytes("😀\x1b[6n"));
  await s.snapshot();
  expect(replies).toEqual(["\x1b[1;3R"]);
});

test("a full-screen program is drawn in its own colours, not in the pen it last drew with", async () => {
  // The serializer ends the shell's screen with the terminal's current pen — the program's, blue
  // from drawing its `~` lines — then writes the program's screen as if the pen were plain. vim
  // came back all bright blue.
  const { s } = screen();
  s.feed(bytes("$ vim\r\n\x1b[?1049h\x1b[H\x1b[mVIMLINE\r\n\x1b[94m~"));
  const snap = await s.snapshot();
  const term = new Terminal({ rows: 10, cols: 40, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(snap.data + "x", resolve));
  const buffer = term.buffer.active;
  expect(buffer.getLine(0)!.translateToString(true)).toBe("VIMLINE");
  expect(buffer.getLine(0)!.getCell(0)!.isFgDefault()).toBe(true);
  // The pen the program holds now is still its own: what it writes next is blue, as it would be.
  expect(buffer.getLine(1)!.getCell(0)!.getFgColor()).toBe(12);
  expect(buffer.getLine(1)!.getCell(1)!.getFgColor()).toBe(12);
});

test("a cursor shape a program chose comes back with it, and the pane's own is left alone otherwise", async () => {
  const bar = screen();
  bar.s.feed(bytes("\x1b[6 q"));
  const snap = await bar.s.snapshot();
  const term = new Terminal({ rows: 10, cols: 40, allowProposedApi: true, cursorBlink: true });
  await new Promise<void>((resolve) => term.write(snap.data, resolve));
  expect([term.options.cursorStyle, term.options.cursorBlink]).toEqual(["bar", false]);
  const plain = screen();
  plain.s.feed(bytes("$ "));
  expect(await plain.s.snapshot().then((x) => x.data)).not.toContain(" q");
});
