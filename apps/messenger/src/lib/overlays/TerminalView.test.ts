import { expect, mock, test } from "bun:test";
import type { Terminal } from "@real-bot/protocol";

type KeyHandler = (event: KeyboardEvent) => boolean;

/** Every emulator the view made, so a test can press its keys and read its options. */
const made: FakeTerminal[] = [];

// xterm draws to a canvas happy-dom does not have; the container's choices are what is under test.
class FakeTerminal {
  /** What fit would measure the pane as; happy-dom has no layout to measure. */
  static size = { rows: 24, cols: 80 };
  rows = FakeTerminal.size.rows;
  cols = FakeTerminal.size.cols;
  options: Record<string, unknown>;
  unicode = { activeVersion: "6" };
  keyHandler: KeyHandler | null = null;
  cleared = 0;
  selection = "";
  pasted: string[] = [];
  /** Registered request handlers; a DA1 in what is written is put to them the way xterm would. */
  requestHandlers: Array<{ id: { prefix?: string; final: string }; fn: () => boolean }> = [];
  /** Each write, and for one carrying `ESC [ c` whether a handler swallowed it. */
  written: Array<{ text: string; swallowedDA1: boolean | null }> = [];
  parser = {
    registerCsiHandler: (id: { prefix?: string; final: string }, fn: () => boolean) => {
      this.requestHandlers.push({ id, fn });
      return { dispose() {} };
    },
    registerDcsHandler: () => ({ dispose() {} }),
    registerOscHandler: () => ({ dispose() {} }),
  };
  private dataSink: ((data: string) => void) | null = null;
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    made.push(this);
  }
  loadAddon(addon: { activate?: (term: FakeTerminal) => void }) { addon.activate?.(this); }
  open() {}
  onData(sink: (data: string) => void) { this.dataSink = sink; }
  attachCustomKeyEventHandler(handler: KeyHandler) { this.keyHandler = handler; }
  reset() {}
  write(data: string | Uint8Array, done?: () => void) {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const da1 = this.requestHandlers.find((h) => h.id.final === "c" && !h.id.prefix);
    this.written.push({ text, swallowedDA1: text.includes("\x1b[c") ? (da1?.fn() ?? false) : null });
    done?.();
  }
  focus() {}
  clear() { this.cleared += 1; }
  resizedTo: Array<[number, number]> = [];
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; this.resizedTo.push([cols, rows]); }
  hasSelection() { return this.selection !== ""; }
  getSelection() { return this.selection; }
  paste(text: string) { this.pasted.push(text); this.dataSink?.(text); }
  dispose() {}
  /** A keystroke the way xterm hands it to the custom handler: true means xterm goes on with it. */
  key(key: string, init: KeyboardEventInit = {}): boolean {
    return this.keyHandler!(new KeyboardEvent("keydown", { key, cancelable: true, ...init }));
  }
}

const searches: Array<{ step: string; query: string }> = [];
mock.module("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
mock.module("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
mock.module("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
mock.module("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
mock.module("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
mock.module("@xterm/addon-search", () => ({
  SearchAddon: class {
    private listener: ((r: { resultIndex: number; resultCount: number }) => void) | null = null;
    onDidChangeResults(listener: (r: { resultIndex: number; resultCount: number }) => void) { this.listener = listener; }
    findNext(query: string, options: { incremental?: boolean }) {
      searches.push({ step: options.incremental ? "typed" : "next", query });
      this.listener?.({ resultIndex: 0, resultCount: 3 });
      return true;
    }
    findPrevious(query: string) { searches.push({ step: "previous", query }); return true; }
    clearDecorations() { searches.push({ step: "clear", query: "" }); }
  },
}));
mock.module("@xterm/xterm/css/xterm.css", () => ({}));
if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} };
}
const { default: TerminalView } = await import("./TerminalView.svelte");
import { copyFor } from "../copy.ts";
import { click, fill, press, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { TERMINAL_FONT_SIZE, terminalFontSize } from "./terminal-font.svelte.ts";

const t = copyFor("zh");

function row(id: string, created_at: string, over: Partial<Terminal> = {}): Terminal {
  return { id, title: "real-bot", cwd: "/work/real-bot", rows: 24, cols: 80, created_at, status: "live", exit_code: null, stream_end: 0, ...over };
}

const older = row("term-old", "2026-09-23T01:00:00.000Z");
const newer = row("term-new", "2026-09-23T02:00:00.000Z");

function fakeApi(items: Terminal[]) {
  const watched: string[] = [];
  const opened: string[] = [];
  const typed: string[] = [];
  const resized: Array<[number, number]> = [];
  const api = {
    terminals: async () => items,
    watchTerminal: async (id: string) => { watched.push(id); },
    unwatchTerminal: async () => {},
    terminalScrollback: async () => ({ offset: 0, data: "" }),
    terminalResize: async (_id: string, rows: number, cols: number) => { resized.push([rows, cols]); },
    terminalInput: async (_id: string, data: string) => { typed.push(atob(data)); },
    openTerminal: async (cwd: string) => { opened.push(cwd); return row("term-made", "2026-09-23T03:00:00.000Z"); },
  };
  return { api, watched, opened, typed, resized };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("a workbench tab shows its own shell and no strip, even when a newer one is live", async () => {
  // Picking "the newest live one" here used to turn every terminal tab into the same shell the
  // moment it was switched to.
  const { api, watched } = fakeApi([older, newer]);
  const view = render(TerminalView, {
    api: api as never, workspacePath: "/work/real-bot", rows: [older, newer], t,
    onStream: () => () => {}, onChanged: () => {}, onClose: () => {}, tabIds: ["term-old"],
  });
  await settle();
  expect(watched).toEqual(["term-old"]);
  expect(view.host.querySelector(".terminal-tabs")).toBeNull();
  expect(view.host.querySelector(".terminal-cwd")?.textContent).toBe("/work/real-bot");
  view.close();
});

test("a tab whose shell never started offers to start one, and becomes that terminal", async () => {
  const { api, opened } = fakeApi([]);
  const bound: string[] = [];
  const view = render(TerminalView, {
    api: api as never, workspacePath: "/work/real-bot", rows: [], t,
    onStream: () => () => {}, onChanged: () => {}, onClose: () => {}, tabIds: [],
    onBind: (id: string) => bound.push(id),
  });
  await settle();
  const start = view.host.querySelector<HTMLButtonElement>(".terminal-empty .terminal-new");
  expect(start?.textContent?.trim()).toBe(t.terminal.newSession);
  click(start);
  await settle();
  expect(opened).toEqual(["/work/real-bot"]);
  expect(bound).toEqual(["term-made"]);
  view.close();
});

test("the phone's page gathers every shell as its tabs, told apart by number", async () => {
  const { api, watched } = fakeApi([older, newer]);
  const view = render(TerminalView, {
    api: api as never, workspacePath: "/work/real-bot", rows: [older, newer], t,
    onStream: () => () => {}, onChanged: () => {}, onClose: () => {}, tabIds: "all",
  });
  await settle();
  const tabs = [...view.host.querySelectorAll(".terminal-tab .terminal-tab-name")].map((el) => el.textContent);
  expect(tabs).toEqual(["real-bot", "real-bot 2"]);
  // It opens on the newest live one, and a tab switches to another.
  expect(watched.at(-1)).toBe("term-new");
  click(view.host.querySelector(".terminal-tab"));
  await settle();
  expect(watched.at(-1)).toBe("term-old");
  expect(view.host.querySelector(".terminal-tabs .terminal-new")).not.toBeNull();
  view.close();
});

function mountTab(items: Terminal[] = [older]) {
  const { api, typed, resized } = fakeApi(items);
  const view = render(TerminalView, {
    api: api as never, workspacePath: "/work/real-bot", rows: items, t,
    onStream: () => () => {}, onChanged: () => {}, onClose: () => {}, tabIds: [items[0]!.id],
  });
  return { view, typed, resized, term: () => made.at(-1)! };
}

test("the ⌘ keys a Mac terminal gives meaning to reach the shell as its editing bytes", async () => {
  const { view, typed, term } = mountTab();
  await settle();
  expect(term().key("ArrowLeft", { metaKey: true })).toBe(false);
  expect(term().key("Backspace", { metaKey: true })).toBe(false);
  await settle();
  // In order; how the queue batched them is its own business.
  expect(typed.join("")).toBe("\x01\x15");
  // Anything else is still xterm's to turn into bytes.
  expect(term().key("a")).toBe(true);
  expect(term().key("c", { metaKey: true })).toBe(true);
  view.close();
});

test("⌘K clears the terminal and sends the shell nothing", async () => {
  const { view, typed, term } = mountTab();
  await settle();
  expect(term().key("k", { metaKey: true })).toBe(false);
  await settle();
  expect(term().cleared).toBe(1);
  expect(typed).toEqual([]);
  view.close();
});

test("⌘F opens find over the terminal; Enter steps, Escape closes it and nothing else", async () => {
  searches.length = 0;
  const { view, term } = mountTab();
  await settle();
  expect(view.host.querySelector(".terminal-find")).toBeNull();
  term().key("f", { metaKey: true });
  await settle();
  const field = view.host.querySelector<HTMLInputElement>(".terminal-find input");
  expect(field).not.toBeNull();
  fill(field, "error");
  expect(view.host.querySelector(".terminal-find-count")?.textContent).toBe("1/3");
  press(field, "Enter");
  press(field, "Enter", { shiftKey: true });
  expect(searches.map((s) => s.step)).toEqual(["typed", "next", "previous"]);
  let escaped = false;
  const onWindow = () => { escaped = true; };
  window.addEventListener("keydown", onWindow);
  press(field, "Escape");
  window.removeEventListener("keydown", onWindow);
  expect(view.host.querySelector(".terminal-find")).toBeNull();
  expect(searches.at(-1)?.step).toBe("clear");
  // The window unwinds Escape into closing whatever is open behind; this one was only the bar's.
  expect(escaped).toBe(false);
  // ⌘G goes on with the last query without the bar.
  term().key("g", { metaKey: true });
  expect(searches.at(-1)).toEqual({ step: "next", query: "error" });
  view.close();
});

test("the terminal's colours follow the window between light and dark", async () => {
  const root = document.documentElement;
  const before = root.getAttribute("data-theme");
  root.setAttribute("data-theme", "dark");
  const { view, term } = mountTab();
  try {
    await settle();
    const dark = term().options.theme as { background: string; blue: string };
    expect(term().options.minimumContrastRatio).toBe(1);
    root.setAttribute("data-theme", "light");
    await settle();
    const light = term().options.theme as { background: string; blue: string };
    expect(light.blue).not.toBe(dark.blue);
    expect(term().options.minimumContrastRatio).toBe(4.5);
  } finally {
    view.close();
    if (before === null) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", before);
  }
});

test("⌘+ and ⌘0 resize the text of the terminal in front of you", async () => {
  const { view, term } = mountTab();
  try {
    await settle();
    terminalFontSize.step(0);
    await settle();
    term().key("=", { metaKey: true });
    await settle();
    expect(term().options.fontSize).toBe(TERMINAL_FONT_SIZE.initial + 1);
    term().key("0", { metaKey: true });
    await settle();
    expect(term().options.fontSize).toBe(TERMINAL_FONT_SIZE.initial);
  } finally {
    view.close();
    localStorage.clear();
  }
});

test("Unicode 11 widths are on, so emoji take the two cells programs expect", async () => {
  const { view, term } = mountTab();
  await settle();
  expect(term().unicode.activeVersion).toBe("11");
  expect(term().options.allowProposedApi).toBe(true);
  view.close();
});

test("a session opened at 80×24 is told the size of the pane that shows it, once", async () => {
  // It was opened before any pane had measured it; the pane never changed size itself, which is
  // exactly when this used to go unsaid and leave the shell wrapping at 80 columns.
  FakeTerminal.size = { rows: 52, cols: 156 };
  const { view, resized, term } = mountTab();
  try {
    await settle();
    expect(resized).toEqual([[52, 156]]);
    // Measuring again at the same size — the next pane observation, a font step that fits the
    // same grid — does not ask the pty to redraw.
    term().key("=", { metaKey: true });
    await settle();
    expect(resized).toEqual([[52, 156]]);
  } finally {
    FakeTerminal.size = { rows: 24, cols: 80 };
    view.close();
    localStorage.clear();
  }
});

test("typing takes the size back from whichever other client last resized the session", async () => {
  // The phone showed this shell last and left it at its own size; the pane here never changed.
  FakeTerminal.size = { rows: 52, cols: 156 };
  const phoneSized = row("term-old", "2026-09-23T01:00:00.000Z", { rows: 40, cols: 45 });
  const { api, resized } = fakeApi([phoneSized]);
  const state = reactive({ rows: [phoneSized] });
  const view = render(TerminalView, {
    api: api as never, workspacePath: "/work/real-bot", get rows() { return state.rows; }, t,
    onStream: () => () => {}, onChanged: () => {}, onClose: () => {}, tabIds: ["term-old"],
  });
  try {
    await settle();
    expect(resized).toEqual([[52, 156]]);
    // The pty reports this pane's size back, and then the phone takes it again.
    state.rows = [{ ...phoneSized, rows: 52, cols: 156 }];
    await settle();
    state.rows = [{ ...phoneSized, rows: 40, cols: 45 }];
    await settle();
    made.at(-1)!.paste("l");
    await settle();
    expect(resized).toEqual([[52, 156], [52, 156]]);
  } finally {
    FakeTerminal.size = { rows: 24, cols: 80 };
    view.close();
  }
});

test("a request in the history is not answered again on reattach; the same request live is", async () => {
  // A TUI asked `ESC [ c` once at startup. Replaying that asked again, and the answer landed at
  // the next prompt as `1;2c`, once more for every reattach.
  const history = new TextEncoder().encode("claude\x1b[>0q\x1b[?u\x1b[c\r\n$ ");
  const { api } = fakeApi([older]);
  const sinks: Array<(frame: { offset: number; data: string }) => void> = [];
  const view = render(TerminalView, {
    api: { ...api, terminalScrollback: async () => ({ offset: 0, data: btoa(String.fromCharCode(...history)) }) } as never,
    workspacePath: "/work/real-bot", rows: [older], t,
    onStream: (_id: string, sink: (frame: { offset: number; data: string }) => void) => { sinks.push(sink); return () => {}; },
    onChanged: () => {}, onClose: () => {}, tabIds: ["term-old"],
  });
  try {
    for (let i = 0; i < 20 && !made.at(-1)?.written.some((w) => w.swallowedDA1 !== null); i += 1) await settle();
    const term = made.at(-1)!;
    expect(term.written.find((w) => w.text.includes("claude"))?.swallowedDA1).toBe(true);
    // Live output after the replay: a program that asks now gets its answer.
    sinks.at(-1)!({ offset: history.length, data: btoa("\x1b[c") });
    expect(term.written.at(-1)).toEqual({ text: "\x1b[c", swallowedDA1: false });
  } finally {
    view.close();
  }
});

/** A daemon that keeps the screen: the snapshot it hands over, and what the pane tells it. */
function screenApi(snapshot: { offset: number; text: string; rows: number; cols: number }) {
  const base = fakeApi([older]);
  const told = { scrollbackRead: 0, cleared: 0, colors: [] as Array<{ background: string }> };
  const api = {
    ...base.api,
    terminalScreen: async () => ({ offset: snapshot.offset, data: btoa(snapshot.text), rows: snapshot.rows, cols: snapshot.cols }),
    terminalScrollback: async () => { told.scrollbackRead += 1; return { offset: 0, data: "" }; },
    clearTerminalScreen: async () => { told.cleared += 1; },
    terminalColors: async (_id: string, colors: { background: string }) => { told.colors.push(colors); },
  };
  return { api, told, resized: base.resized };
}

async function attach(api: unknown, sinks: Array<(frame: { offset: number; data: string }) => void> = []) {
  const count = made.length;
  const view = render(TerminalView, {
    api: api as never, workspacePath: "/work/real-bot", rows: [older], t,
    onStream: (_id: string, sink: (frame: { offset: number; data: string }) => void) => { sinks.push(sink); return () => {}; },
    onChanged: () => {}, onClose: () => {}, tabIds: ["term-old"],
  });
  for (let i = 0; i < 20 && !(made.length > count && made.at(-1)!.written.length); i += 1) await settle();
  return { view, term: made.at(-1)!, sinks };
}

test("a pane attaches to the daemon's screen: drawn at its size, then live bytes from its offset", async () => {
  const { api, told } = screenApi({ offset: 5, text: "\x1b[?1049hvim", rows: 30, cols: 100 });
  const { view, term, sinks } = await attach(api);
  try {
    // The raw bytes are not read at all, and the screen went in at the size it was taken at.
    expect(told.scrollbackRead).toBe(0);
    expect(term.resizedTo[0]).toEqual([100, 30]);
    expect(term.written[0]!.text).toBe("\x1b[?1049hvim");
    // A frame that straddles the snapshot is cut where the snapshot ends.
    sinks.at(-1)!({ offset: 0, data: btoa("01234NEW") });
    expect(term.written.at(-1)!.text).toBe("NEW");
  } finally {
    view.close();
  }
});

test("once the daemon answers, the pane answers nothing, live or replayed", async () => {
  // Two panes on one shell would each have answered, and the second answer arrived as typing.
  const { api } = screenApi({ offset: 0, text: "", rows: 24, cols: 80 });
  const { view, term, sinks } = await attach(api);
  try {
    sinks.at(-1)!({ offset: 0, data: btoa("\x1b[c") });
    expect(term.written.at(-1)).toEqual({ text: "\x1b[c", swallowedDA1: true });
  } finally {
    view.close();
  }
});

test("the pane tells the daemon its colours on attach and when the theme changes, and ⌘K clears there too", async () => {
  const root = document.documentElement;
  const before = root.getAttribute("data-theme");
  root.setAttribute("data-theme", "light");
  const { api, told } = screenApi({ offset: 0, text: "", rows: 24, cols: 80 });
  const { view, term } = await attach(api);
  try {
    await settle();
    expect(told.colors.map((c) => c.background)).toEqual(["#ffffff"]);
    root.setAttribute("data-theme", "dark");
    await settle();
    expect(told.colors.at(-1)!.background).toBe("#161e2b");
    term.key("k", { metaKey: true });
    await settle();
    expect(told.cleared).toBe(1);
  } finally {
    view.close();
    if (before === null) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", before);
  }
});
