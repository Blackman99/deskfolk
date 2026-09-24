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
  /** How many times the shell was handed the focus, which on a phone raises the keyboard. */
  focused = 0;
  blurred = 0;
  modes = { applicationCursorKeysMode: false, mouseTrackingMode: "none" };
  buffer = { active: { type: "normal" } };
  /** xterm's own element, made by `open`, with a screen of 16px rows. */
  element: HTMLElement | undefined;
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
  /**
   * The public Terminal hides its viewport on `_core`, and that viewport exists only after
   * `open`. macOS measures no scrollbar and xterm keeps 15 anyway.
   */
  _core: { viewport?: { scrollBarWidth: number } } = {};
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    made.push(this);
  }
  loadAddon(addon: { activate?: (term: FakeTerminal) => void }) { addon.activate?.(this); }
  open(parent: HTMLElement) {
    this._core.viewport = { scrollBarWidth: 15 };
    this.element = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () => ({ height: this.rows * 16 }) as DOMRect;
    this.element.append(screen);
    parent.append(this.element);
  }
  onData(sink: (data: string) => void) { this.dataSink = sink; }
  attachCustomKeyEventHandler(handler: KeyHandler) { this.keyHandler = handler; }
  reset() {}
  write(data: string | Uint8Array, done?: () => void) {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const da1 = this.requestHandlers.find((h) => h.id.final === "c" && !h.id.prefix);
    this.written.push({ text, swallowedDA1: text.includes("\x1b[c") ? (da1?.fn() ?? false) : null });
    done?.();
  }
  focus() { this.focused += 1; }
  blur() { this.blurred += 1; }
  clear() { this.cleared += 1; }
  resizedTo: Array<[number, number]> = [];
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; this.resizedTo.push([cols, rows]); }
  hasSelection() { return this.selection !== ""; }
  getSelection() { return this.selection; }
  paste(text: string) { this.pasted.push(text); this.dataSink?.(text); }
  /** A key on the software keyboard, as xterm hands it on. */
  type(data: string) { this.dataSink?.(data); }
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
import { flushSync } from "svelte";
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

test("the phone's page names the shell it shows, and its title switches between all of them", async () => {
  const { api, watched } = fakeApi([older, newer]);
  const closed: number[] = [];
  const view = render(TerminalView, {
    api: api as never, workspacePath: "/work/real-bot", rows: [older, newer], t,
    onStream: () => () => {}, onChanged: () => {}, onClose: () => closed.push(1), tabIds: "all",
  });
  await settle();
  // It opens on the newest live one; the title says which, and how many there are.
  expect(watched.at(-1)).toBe("term-new");
  expect(view.host.querySelector(".terminal-title-text")?.textContent).toBe("real-bot 2");
  expect(view.host.querySelector(".terminal-title-count")?.textContent).toBe("2");
  expect(view.host.querySelector(".terminal-sessions")).toBeNull();
  click(view.host.querySelector(".terminal-title"));
  const tabs = [...view.host.querySelectorAll(".terminal-sessions .terminal-tab-name")].map((el) => el.textContent);
  expect(tabs).toEqual(["real-bot", "real-bot 2"]);
  click(view.host.querySelector(".terminal-sessions .terminal-tab"));
  await settle();
  expect(watched.at(-1)).toBe("term-old");
  expect(view.host.querySelector(".terminal-sessions")).toBeNull();
  // A new one is + in the header, and Back leaves the page.
  expect(view.host.querySelector(".terminal-add")).not.toBeNull();
  click(view.host.querySelector(".terminal-back"));
  expect(closed).toEqual([1]);
  view.close();
});

test("with one shell the title is only a title, and nothing drops from it", async () => {
  const { api } = fakeApi([older]);
  const view = render(TerminalView, {
    api: api as never, workspacePath: "/work/real-bot", rows: [older], t,
    onStream: () => () => {}, onChanged: () => {}, onClose: () => {}, tabIds: "all",
  });
  await settle();
  expect(view.host.querySelector<HTMLButtonElement>(".terminal-title")?.disabled).toBe(true);
  expect(view.host.querySelector(".terminal-title-count")).toBeNull();
  view.close();
});

function mountPhone(items: Terminal[] = [older], over: Record<string, unknown> = {}) {
  const { api, typed } = fakeApi(items);
  const view = render(TerminalView, {
    api: { ...api, ...over } as never, workspacePath: "/work/real-bot", rows: items, t,
    onStream: () => () => {}, onChanged: () => {}, onClose: () => {}, tabIds: "all",
  });
  const key = (id: string) => view.host.querySelector<HTMLButtonElement>(`.terminal-keys [data-key="${id}"]`);
  return { view, typed, key, term: () => made.at(-1)! };
}

test("a key on the phone's bar goes to the shell and never raises the keyboard", async () => {
  const { view, typed, key, term } = mountPhone();
  await settle();
  const before = term().focused;
  click(key("ctrl-v"));
  click(key("ctrl-c"));
  click(key("enter"));
  click(key("shift-tab"));
  await settle();
  expect(typed.join("")).toBe("\x16\x03\r\x1b[Z");
  expect(term().focused).toBe(before);
  // Nor does the press take the focus away from the shell, which would drop a keyboard that is up.
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  key("esc")!.dispatchEvent(press);
  expect(press.defaultPrevented).toBe(true);
  view.close();
});

test("the bar's Ctrl applies to the next key, from the keyboard or the bar, and then lets go", async () => {
  const { view, typed, key, term } = mountPhone();
  await settle();
  click(key("ctrl"));
  expect(key("ctrl")?.getAttribute("aria-pressed")).toBe("true");
  term().type("r");
  await settle();
  expect(typed.join("")).toBe("\x12");
  expect(key("ctrl")?.getAttribute("aria-pressed")).toBe("false");
  term().type("r");
  click(key("ctrl"));
  click(key("left"));
  await settle();
  expect(typed.join("")).toBe("\x12r\x1b[1;5D");
  // Tapped twice, it is off again and the next key is plain.
  click(key("ctrl"));
  click(key("ctrl"));
  term().type("a");
  await settle();
  expect(typed.join("")).toBe("\x12r\x1b[1;5Da");
  view.close();
});

test("the bar's arrows follow the cursor-key mode the program on screen set", async () => {
  const { view, typed, key, term } = mountPhone();
  await settle();
  click(key("up"));
  term().modes.applicationCursorKeysMode = true;
  click(key("up"));
  await settle();
  expect(typed.join("")).toBe("\x1b[A\x1bOA");
  view.close();
});

test("an arrow held on the bar repeats until it is let go, and the click that ends it adds nothing", async () => {
  const { view, typed, key } = mountPhone();
  await settle();
  const down = key("down")!;
  down.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 560));
  down.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
  click(down);
  await settle();
  const held = typed.join("").split("\x1b[B").length - 1;
  await new Promise((resolve) => setTimeout(resolve, 150));
  await settle();
  expect(held).toBeGreaterThanOrEqual(3);
  expect(typed.join("").split("\x1b[B").length - 1).toBe(held);
  view.close();
});

test("the keyboard key is the one that raises and drops the keyboard", async () => {
  const { view, key, term } = mountPhone();
  await settle();
  const before = term().focused;
  expect(key("keyboard")?.getAttribute("aria-label")).toBe(t.terminal.showKeyboard);
  click(key("keyboard"));
  expect(term().focused).toBe(before + 1);
  // xterm's textarea takes the focus inside the terminal's host.
  const field = document.createElement("textarea");
  view.host.querySelector(".terminal-host")!.appendChild(field);
  field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  await settle();
  expect(key("keyboard")?.getAttribute("aria-label")).toBe(t.terminal.hideKeyboard);
  click(key("keyboard"));
  expect(term().blurred).toBe(1);
  field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await settle();
  expect(key("keyboard")?.getAttribute("aria-pressed")).toBe("false");
  view.close();
});

test("paste on the bar pastes the phone's clipboard and leaves the keyboard where it was", async () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "git status" } });
  const { view, key, term } = mountPhone();
  try {
    await settle();
    const before = term().focused;
    click(key("paste"));
    await settle();
    expect(term().pasted).toEqual(["git status"]);
    expect(term().focused).toBe(before);
  } finally {
    view.close();
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

test("⋯ holds stop, find and clear, and ending the session asks first", async () => {
  const signals: string[] = [];
  const closedIds: string[] = [];
  const { view, term } = mountPhone([older], {
    terminalSignal: async (_id: string, signal: string) => { signals.push(signal); },
    closeTerminal: async (id: string) => { closedIds.push(id); },
  });
  await settle();
  const more = () => view.host.querySelector(".terminal-more > .terminal-icon");
  const item = (text: string) => [...view.host.querySelectorAll(".terminal-menu button")].find((b) => b.textContent?.trim() === text);
  click(more());
  click(item(t.terminal.stop));
  await settle();
  expect(signals).toEqual(["SIGINT"]);
  expect(view.host.querySelector(".terminal-menu")).toBeNull();
  click(more());
  click(item(t.terminal.clear));
  expect(term().cleared).toBe(1);
  click(more());
  click(item(t.terminal.end));
  expect(view.host.querySelector(".terminal-menu .terminal-confirm")?.textContent).toBe(t.terminal.endConfirm);
  expect(closedIds).toEqual([]);
  click(view.host.querySelector(".terminal-menu-confirm .is-armed"));
  await settle();
  expect(closedIds).toEqual(["term-old"]);
  view.close();
});

test("tapping 结束会话 in ⋯ keeps the menu open on its confirm, even once the button is gone", async () => {
  // A browser runs microtasks between listeners, so by the time a real tap reaches the window the
  // menu has already swapped 结束会话 for its confirm and the tapped button is off the page. The
  // `click` helper flushes only after every listener; this flushes where the browser does.
  const flushBetween = () => flushSync();
  document.addEventListener("click", flushBetween);
  const closedIds: string[] = [];
  const { view } = mountPhone([older], { closeTerminal: async (id: string) => { closedIds.push(id); } });
  try {
    await settle();
    click(view.host.querySelector(".terminal-more > .terminal-icon"));
    click(view.host.querySelector(".terminal-menu .terminal-end"));
    expect(view.host.querySelector(".terminal-menu .terminal-confirm")?.textContent).toBe(t.terminal.endConfirm);
    click(view.host.querySelector(".terminal-menu-confirm .is-armed"));
    await settle();
    expect(closedIds).toEqual(["term-old"]);
  } finally {
    document.removeEventListener("click", flushBetween);
    view.close();
  }
});

test("the page's back closes an open ⋯ menu and the find bar before it leaves", async () => {
  const closed: string[] = [];
  const { api } = fakeApi([older]);
  const pane = render((await import("./TerminalPane.svelte")).default, {
    api: api as never, workspacePath: "/work/real-bot", rows: [older], t,
    onStream: () => () => {}, onChanged: () => {}, onClose: () => closed.push("page"),
  });
  await settle();
  const back = () => pane.host.querySelector<HTMLButtonElement>(".terminal-back");
  click(pane.host.querySelector(".terminal-more > .terminal-icon"));
  expect(pane.host.querySelector(".terminal-menu")).not.toBeNull();
  click(back());
  expect(pane.host.querySelector(".terminal-menu")).toBeNull();
  expect(closed).toEqual([]);

  click(pane.host.querySelector(".terminal-more > .terminal-icon"));
  click([...pane.host.querySelectorAll(".terminal-menu button")].find((button) => button.textContent?.trim() === t.terminal.find));
  await settle();
  expect(pane.host.querySelector(".terminal-find")).not.toBeNull();
  click(back());
  expect(pane.host.querySelector(".terminal-find")).toBeNull();
  expect(closed).toEqual([]);

  click(back());
  expect(closed).toEqual(["page"]);
  pane.close();
});

test("a tap outside the menu closes it", async () => {
  const { view } = mountPhone();
  await settle();
  click(view.host.querySelector(".terminal-more > .terminal-icon"));
  expect(view.host.querySelector(".terminal-menu")).not.toBeNull();
  click(view.host.querySelector(".terminal-host"));
  expect(view.host.querySelector(".terminal-menu")).toBeNull();
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

test("opening the terminal claims no scrollbar, so the columns reach the pane edge", async () => {
  const { view, term } = mountTab();
  await settle();
  expect(term()._core.viewport?.scrollBarWidth).toBe(0);
  view.close();
});

test("on the phone, a swipe over a program holding the mouse reaches it as the wheel", async () => {
  // Claude Code and the like: xterm leaves their history to them and does nothing with a touch.
  const { view, term } = mountPhone();
  await settle();
  const xterm = term();
  xterm.modes.mouseTrackingMode = "any";
  xterm.buffer.active.type = "alternate";
  const wheels: number[] = [];
  xterm.element!.addEventListener("wheel", (event) => wheels.push((event as WheelEvent).deltaY));
  const screen = xterm.element!.querySelector(".xterm-screen")!;
  const touch = (type: string, y: number) =>
    screen.dispatchEvent(
      new TouchEvent(type, {
        touches: [new Touch({ identifier: 0, target: screen, clientX: 50, clientY: y })],
        bubbles: true,
        cancelable: true,
      }),
    );
  touch("touchstart", 100);
  touch("touchmove", 148);
  expect(wheels).toEqual([-1, -1, -1]);
  view.close();
});

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

test("a pane reads the screen first and watches from where it ends, so the daemon sends no backlog", async () => {
  // Watching from 0 had the daemon send its whole ring again, only for the pane to cut all of it:
  // over a phone's link, the first second of every attach.
  const { api } = screenApi({ offset: 5000, text: "screen", rows: 24, cols: 80 });
  const calls: string[] = [];
  const { view } = await attach({
    ...api,
    terminalScreen: async (id: string) => { calls.push(`screen ${id}`); return api.terminalScreen(); },
    watchTerminal: async (id: string, from: number) => { calls.push(`watch ${id} ${from}`); },
  });
  try {
    expect(calls).toEqual(["screen term-old", "watch term-old 5000"]);
  } finally {
    view.close();
  }
});

test("switching away while an attach is still reading leaves the new one to finish on its own", async () => {
  // The overtaken attach used to clear the new one's state as it gave up, which let the new
  // session's live bytes in ahead of its screen, as "output outran the reader" the size of the
  // whole stream.
  const { api } = fakeApi([older, newer]);
  const sinks = new Map<string, (frame: { offset: number; data: string }) => void>();
  const watched: string[] = [];
  const release = new Map<string, () => void>();
  const reads = new Map(["term-new", "term-old"].map((id) => [id, new Promise<void>((resolve) => release.set(id, resolve))]));
  const view = render(TerminalView, {
    api: {
      ...api,
      terminalScreen: async (id: string) => {
        await reads.get(id);
        return { offset: id === "term-new" ? 100 : 7000, data: btoa(`${id} screen`), rows: 24, cols: 80 };
      },
      watchTerminal: async (id: string) => { watched.push(id); },
    } as never,
    workspacePath: "/work/real-bot", rows: [older, newer], t,
    onStream: (id: string, sink: (frame: { offset: number; data: string }) => void) => { sinks.set(id, sink); return () => {}; },
    onChanged: () => {}, onClose: () => {}, tabIds: "all",
  });
  try {
    await settle();
    // It opened on the newest; switch to the other while both screens are still on their way.
    click(view.host.querySelector(".terminal-title"));
    click(view.host.querySelector(".terminal-sessions .terminal-tab"));
    await settle();
    // The one given up on lands first, then a live frame arrives before the current screen does.
    release.get("term-new")!();
    await settle();
    sinks.get("term-old")!({ offset: 7000, data: btoa("LIVE") });
    release.get("term-old")!();
    await settle();
    const term = made.at(-1)!;
    const text = term.written.map((w) => w.text).join("");
    expect(text).toContain("term-old screen");
    expect(text).not.toContain("term-new screen");
    expect(term.written.at(-1)!.text).toBe("LIVE");
    expect(text).not.toContain(t.terminal.dropped.split("{bytes}")[0]!);
    // The one given up on is never watched, so its bytes do not travel for nobody.
    expect(watched).toEqual(["term-old"]);
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
