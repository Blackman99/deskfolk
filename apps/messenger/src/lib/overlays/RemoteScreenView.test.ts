import { afterEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import { ApiError } from "../api.ts";
import { copyFor, screenCopy } from "../copy.ts";
import { click, fill, press, render } from "../test-render.ts";
import type { ScreenConnection } from "../remote/screen-connect.ts";
import RemoteScreenView, { type Rfb } from "./RemoteScreenView.svelte";
import { KEYSYM } from "./remote-screen-keys.ts";
import type { RememberedSignIn, ScreenSignIn } from "../remote/screen-sign-in.ts";
import { loadTrackpadMode, saveTrackpadMode } from "./screen-trackpad.ts";
import { loadScreenFlag, saveScreenFlag } from "./screen-prefs.ts";

const t = copyFor("zh");
const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

class FakeRfb extends EventTarget implements Rfb {
  static made: FakeRfb[] = [];
  scaleViewport = false;
  clipViewport = false;
  dragViewport = false;
  resizeSession = true;
  focusOnClick = true;
  background = "";
  keys: Array<[number, boolean]> = [];
  credentials: Array<{ username?: string; password?: string }> = [];
  disconnected = false;
  /** noVNC's canvas, framebuffer-sized, with the gesture listener noVNC's own would be. */
  readonly canvas: HTMLCanvasElement;
  gestures: string[] = [];
  constructor(readonly target: HTMLElement, readonly channel: unknown, readonly options: { credentials?: { username?: string; password?: string } } = {}) {
    super();
    FakeRfb.made.push(this);
    this.canvas = document.createElement("canvas");
    this.canvas.width = 4112;
    this.canvas.height = 2658;
    for (const type of ["gesturestart", "gesturemove", "gestureend"]) {
      this.canvas.addEventListener(type, (event) => this.gestures.push(`${type}:${(event as CustomEvent<{ type: string }>).detail.type}`));
    }
    target.appendChild(this.canvas);
  }
  gesture(type: string, detail: Record<string, unknown>) { this.canvas.dispatchEvent(new CustomEvent(type, { detail })); flushSync(); }
  sendCredentials(credentials: { username?: string; password?: string }) { this.credentials.push(credentials); }
  sendKey(keysym: number, _code: string | null, down?: boolean) { this.keys.push([keysym, down ?? true]); }
  ctrlAltDel = 0;
  sendCtrlAltDel() { this.ctrlAltDel++; }
  disconnect() { this.disconnected = true; }
  fire(type: string, detail?: unknown) { this.dispatchEvent(new CustomEvent(type, { detail })); flushSync(); }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
};

function mountView(options: { connect?: (api: unknown, options?: { smooth?: boolean }) => Promise<ScreenConnection>; status?: () => Promise<{ mode: string }>; keepaliveMs?: number; answerMs?: number; remember?: RememberedSignIn; host?: "mac" | "windows" } = {}) {
  FakeRfb.made = [];
  const calls: string[] = [];
  const closedChannels: number[] = [];
  let made = 0;
  const api = {
    screenStart: async () => ({ session_id: "S1", ice_servers: [], direct: false }),
    screenOffer: async () => ({ sdp: "" }),
    screenTunnel: async () => ({ tunnel_id: 1 }),
    openScreenTunnel: () => { throw new Error("unused"); },
    screenStatus: options.status ?? (async () => ({ mode: "relay" })),
    screenStop: async (id: string) => { calls.push(`stop ${id}`); },
  };
  const connect = options.connect ?? (async () => {
    const index = ++made;
    return { sessionId: `S${index}`, mode: "relay" as const, channel: { close: () => closedChannels.push(index) } as never };
  });
  let closed = 0;
  const view = render(RemoteScreenView as never, {
    api, t: options.host ? { ...t, screen: screenCopy(t, options.host) } : t, onClose: () => { closed++; }, loadRfb: async () => FakeRfb as never, connect: connect as never, keepaliveMs: options.keepaliveMs ?? 60_000, answerMs: options.answerMs ?? 60_000,
    ...(options.remember ? { remember: options.remember } : {}),
    ...(options.host ? { host: options.host } : {}),
  });
  closers.push(view.close);
  return { ...view, calls, closedChannels, closed: () => closed };
}

test("connects through the relay, says so, and leaves noVNC the taps but not the focus", async () => {
  const view = mountView();
  await settle();
  // The channel is up and noVNC is talking: the page says it waits on Screen Sharing.
  expect(view.host.textContent).toContain(t.screen.waitingMac);
  const rfb = FakeRfb.made[0]!;
  expect(rfb.options).toEqual({ shared: true });
  expect(rfb.focusOnClick).toBe(false);
  expect(rfb.resizeSession).toBe(false);
  // Always fitted to its box; zooming moves the box.
  expect([rfb.scaleViewport, rfb.clipViewport, rfb.dragViewport]).toEqual([true, false, false]);
  rfb.fire("connect");
  expect(view.host.querySelector(".screen-route")?.textContent?.trim()).toBe(t.screen.relay);
});

test("the key row holds an armed modifier around the next key, then lets it go", async () => {
  const view = mountView();
  await settle();
  const rfb = FakeRfb.made[0]!;
  rfb.fire("connect");
  click(view.host.querySelector('[data-key="command"]'));
  expect(view.host.querySelector('[data-key="command"]')?.getAttribute("aria-pressed")).toBe("true");
  click(view.host.querySelector('[data-key="left"]'));
  expect(rfb.keys).toEqual([[KEYSYM.command, true], [KEYSYM.left, true], [KEYSYM.left, false], [KEYSYM.command, false]]);
  expect(view.host.querySelector('[data-key="command"]')?.getAttribute("aria-pressed")).toBe("false");
  rfb.keys = [];
  click(view.host.querySelector('[data-key="escape"]'));
  expect(rfb.keys).toEqual([[KEYSYM.escape, true], [KEYSYM.escape, false]]);
});

test("a Windows PC gets its own key row and words, Ctrl+Alt+Del, and no smooth mode", async () => {
  closers.push(() => saveScreenFlag("smooth", false));
  saveScreenFlag("smooth", true);
  const asked: boolean[] = [];
  const view = mountView({
    host: "windows",
    connect: async (_api, options) => {
      asked.push(options?.smooth ?? false);
      return { sessionId: "S1", mode: "direct" as const, channel: { close() {} } as never };
    },
  });
  await settle();
  // A smooth mode saved from a Mac is not asked of a PC.
  expect(asked).toEqual([false]);
  const windows = screenCopy(t, "windows");
  expect(view.host.textContent).toContain(windows.waitingMac);
  const rfb = FakeRfb.made[0]!;
  rfb.fire("connect");
  expect(view.host.querySelector(".screen-smooth")).toBeNull();
  const labels = [...view.host.querySelectorAll<HTMLElement>(".screen-key[data-key]")].map((key) => key.textContent?.trim());
  expect(labels.slice(0, 4)).toEqual(["Ctrl", "Alt", "Win", "⇧"]);
  // Win is the keysym a Mac's ⌘ is, which a Windows VNC server reads as the Windows key.
  click(view.host.querySelector('[data-key="command"]'));
  click(view.host.querySelector('[data-key="escape"]'));
  expect(rfb.keys).toEqual([[KEYSYM.command, true], [KEYSYM.escape, true], [KEYSYM.escape, false], [KEYSYM.command, false]]);
  // Ctrl+Alt+Del goes as noVNC's own; a modifier armed before it is dropped, not held.
  click(view.host.querySelector('[data-key="control"]'));
  click(view.host.querySelector('[data-key="ctrl-alt-del"]'));
  expect(rfb.ctrlAltDel).toBe(1);
  expect(view.host.querySelector('[data-key="control"]')?.getAttribute("aria-pressed")).toBe("false");
});

test("a Mac's key row has no Ctrl+Alt+Del", async () => {
  const view = mountView();
  await settle();
  FakeRfb.made[0]!.fire("connect");
  expect(view.host.querySelector('[data-key="ctrl-alt-del"]')).toBeNull();
  expect(view.host.querySelector('[data-key="command"]')?.textContent?.trim()).toBe("⌘");
});

test("the soft keyboard's text and deletions reach the Mac as keys", async () => {
  const view = mountView();
  await settle();
  const rfb = FakeRfb.made[0]!;
  rfb.fire("connect");
  const input = view.host.querySelector<HTMLInputElement>(".screen-input")!;
  fill(input, " hi");
  expect(rfb.keys).toEqual([[0x68, true], [0x68, false], [0x69, true], [0x69, false]]);
  expect(input.value).toBe(" ");
  rfb.keys = [];
  // Backspace with nothing typed deletes the sentinel, which is how it shows up at all.
  fill(input, "");
  expect(rfb.keys).toEqual([[KEYSYM.backspace, true], [KEYSYM.backspace, false]]);
  rfb.keys = [];
  press(input, "Enter");
  expect(rfb.keys).toEqual([[KEYSYM.enter, true], [KEYSYM.enter, false]]);
});

test("asks for the Mac's account when Screen Sharing does, and asks again after a refusal", async () => {
  const view = mountView();
  await settle();
  const first = FakeRfb.made[0]!;
  first.fire("credentialsrequired", { types: ["username", "password"] });
  expect(view.host.textContent).toContain(t.screen.signInTitle);
  fill(view.host.querySelector('input[autocomplete="username"]'), "me");
  fill(view.host.querySelector('input[type="password"]'), "secret");
  click(view.host.querySelector('button[type="submit"]'));
  expect(first.credentials).toEqual([{ username: "me", password: "secret" }]);
  first.fire("securityfailure", { status: 1 });
  first.fire("disconnect", { clean: false });
  expect(view.host.textContent).toContain(t.screen.wrongPassword);
  fill(view.host.querySelector('input[type="password"]'), "right");
  click(view.host.querySelector('button[type="submit"]'));
  await settle();
  // A fresh connection, signing in from the start with what was just typed.
  expect(FakeRfb.made.length).toBe(2);
  expect(FakeRfb.made[1]!.options.credentials).toEqual({ username: "me", password: "right" });
  expect(view.calls).toContain("stop S1");
});

test("says what to do on the Mac when it refuses, and connects again on request", async () => {
  let failing = true;
  const view = mountView({
    connect: async () => {
      if (failing) throw new ApiError(409, "screen_sharing_off", "off");
      return { sessionId: "S9", mode: "direct", channel: { close() {} } as never };
    },
  });
  await settle();
  expect(view.host.textContent).toContain(t.screen.sharingOff);
  failing = false;
  click([...view.host.querySelectorAll("button")].find((b) => b.textContent?.trim() === t.screen.reconnect));
  await settle();
  FakeRfb.made[0]!.fire("connect");
  expect(view.host.querySelector(".screen-route")?.textContent?.trim()).toBe(t.screen.direct);
});

test("a session the Mac forgot ends the page's connection", async () => {
  const view = mountView({ keepaliveMs: 5, status: async () => { throw new ApiError(404, "screen_session_gone", "gone"); } });
  await settle();
  FakeRfb.made[0]!.fire("connect");
  await new Promise((resolve) => setTimeout(resolve, 30));
  flushSync();
  expect(view.host.textContent).toContain(t.screen.ended);
  expect(FakeRfb.made[0]!.disconnected).toBe(true);
});

test("leaving the page lets go of everything and tells the Mac", async () => {
  const view = mountView();
  await settle();
  const rfb = FakeRfb.made[0]!;
  rfb.fire("connect");
  view.close();
  closers.pop();
  expect(rfb.disconnected).toBe(true);
  expect(view.closedChannels).toEqual([1]);
  expect(view.calls).toEqual(["stop S1"]);
});

test("Screen Sharing that never answers ends in a failure the page can retry, not an endless spinner", async () => {
  const view = mountView({ answerMs: 20 });
  await settle();
  expect(view.host.textContent).toContain(t.screen.waitingMac);
  await new Promise((resolve) => setTimeout(resolve, 40));
  flushSync();
  expect(view.host.textContent).toContain(t.screen.noAnswer);
  expect(FakeRfb.made[0]!.disconnected).toBe(true);
  expect(view.calls).toEqual(["stop S1"]);
  click([...view.host.querySelectorAll("button")].find((b) => b.textContent?.trim() === t.screen.reconnect));
  await settle();
  expect(FakeRfb.made.length).toBe(2);
});

test("a sign-in that Screen Sharing never answers fails the same way", async () => {
  const view = mountView({ answerMs: 20 });
  await settle();
  FakeRfb.made[0]!.fire("credentialsrequired", { types: ["password"] });
  await new Promise((resolve) => setTimeout(resolve, 40));
  flushSync();
  // Asking for a password is an answer: no timeout while the person types.
  expect(view.host.textContent).toContain(t.screen.signInTitle);
  fill(view.host.querySelector('input[type="password"]'), "secret");
  click(view.host.querySelector('button[type="submit"]'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  flushSync();
  expect(view.host.textContent).toContain(t.screen.noAnswer);
});

function memoryRemember(initial: ScreenSignIn | null = null) {
  const log: string[] = [];
  let kept = initial;
  const remember: RememberedSignIn = {
    load: async () => kept,
    save: async (signIn) => { kept = signIn; log.push(`save ${signIn.username}/${signIn.password}`); },
    forget: async () => { kept = null; log.push("forget"); },
  };
  return { remember, log, get kept() { return kept; } };
}

test("a sign-in that gets in is kept, and the next connection signs in by itself", async () => {
  const memory = memoryRemember();
  const first = mountView({ remember: memory.remember });
  await settle();
  FakeRfb.made[0]!.fire("credentialsrequired", { types: ["username", "password"] });
  expect(first.host.querySelector<HTMLInputElement>(".screen-keep input")?.checked).toBe(true);
  fill(first.host.querySelector('input[autocomplete="username"]'), "zhaodongsheng");
  fill(first.host.querySelector('input[type="password"]'), "secret");
  click(first.host.querySelector('button[type="submit"]'));
  expect(memory.log).toEqual([]);
  FakeRfb.made[0]!.fire("connect");
  await settle();
  expect(memory.log).toEqual(["save zhaodongsheng/secret"]);
  first.close();
  closers.pop();

  const second = mountView({ remember: memory.remember });
  await settle();
  expect(FakeRfb.made[0]!.options.credentials).toEqual({ username: "zhaodongsheng", password: "secret" });
  FakeRfb.made[0]!.fire("connect");
  expect(second.host.querySelector(".screen-signin")).toBeNull();
});

test("a kept sign-in Screen Sharing refuses is forgotten and asked for again", async () => {
  const memory = memoryRemember({ username: "zhaodongsheng", password: "old" });
  const view = mountView({ remember: memory.remember });
  await settle();
  FakeRfb.made[0]!.fire("securityfailure", { status: 1 });
  FakeRfb.made[0]!.fire("disconnect", { clean: false });
  await settle();
  expect(memory.log).toEqual(["forget"]);
  expect(view.host.textContent).toContain(t.screen.wrongPassword);
  expect(view.host.querySelector<HTMLInputElement>('input[autocomplete="username"]')?.value).toBe("zhaodongsheng");
});

test("unticking Remember keeps nothing", async () => {
  const memory = memoryRemember();
  const view = mountView({ remember: memory.remember });
  await settle();
  FakeRfb.made[0]!.fire("credentialsrequired", { types: ["password"] });
  click(view.host.querySelector(".screen-keep input"));
  fill(view.host.querySelector('input[type="password"]'), "secret");
  click(view.host.querySelector('button[type="submit"]'));
  FakeRfb.made[0]!.fire("connect");
  await settle();
  expect(memory.kept).toBeNull();
  expect(memory.log).toEqual(["forget"]);
});

test("a picture still on its way says so, with how much has arrived", async () => {
  let bytes = 0;
  const view = mountView({ connect: async () => ({ sessionId: "S1", mode: "relay" as const, channel: { close() {}, get bytesIn() { return bytes; } } as never }) });
  await settle();
  FakeRfb.made[0]!.fire("connect");
  bytes = 3 * 1024 * 1024;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  flushSync();
  expect(view.host.querySelector(".screen-transfer")?.textContent).toBe(t.screen.receiving("3.0", "3.0"));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  flushSync();
  expect(view.host.querySelector(".screen-transfer")).toBeNull();
});

/** happy-dom lays nothing out: the stage is given a phone's size by hand. */
function stageSize(w: number, h: number): () => void {
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return (this as HTMLElement).classList.contains("screen-stage") ? w : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return (this as HTMLElement).classList.contains("screen-stage") ? h : 0; } });
  return () => {
    if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
    if (height) Object.defineProperty(HTMLElement.prototype, "clientHeight", height);
  };
}

test("a pinch zooms the picture on the phone and never reaches the Mac", async () => {
  const restore = stageSize(400, 800);
  closers.push(restore);
  const view = mountView();
  await settle();
  const rfb = FakeRfb.made[0]!;
  rfb.fire("connect");
  const box = () => view.host.querySelector<HTMLElement>(".screen-canvas")!.style;
  expect(box().width).toBe("400px");
  rfb.gesture("gesturestart", { type: "pinch", clientX: 200, clientY: 400, magnitudeX: 100, magnitudeY: 0 });
  rfb.gesture("gesturemove", { type: "pinch", clientX: 200, clientY: 400, magnitudeX: 250, magnitudeY: 0 });
  rfb.gesture("gestureend", { type: "pinch", clientX: 200, clientY: 400, magnitudeX: 250, magnitudeY: 0 });
  expect(box().width).toBe("1000px");
  expect(rfb.gestures).toEqual([]);
  expect(view.host.querySelector(".screen-zoom")?.textContent?.trim()).toBe(t.screen.fit);
  // Zoomed in, two fingers move the view instead of scrolling the Mac.
  const left = parseFloat(box().left);
  rfb.gesture("gesturestart", { type: "twodrag", clientX: 200, clientY: 400, magnitudeX: 0, magnitudeY: 0 });
  rfb.gesture("gesturemove", { type: "twodrag", clientX: 200, clientY: 400, magnitudeX: 50, magnitudeY: 0 });
  rfb.gesture("gestureend", { type: "twodrag", clientX: 200, clientY: 400, magnitudeX: 50, magnitudeY: 0 });
  expect(parseFloat(box().left)).toBe(left + 50);
  expect(rfb.gestures).toEqual([]);
  // A tap is the Mac's at any zoom.
  rfb.gesture("gesturestart", { type: "onetap", clientX: 10, clientY: 10 });
  expect(rfb.gestures).toEqual(["gesturestart:onetap"]);
  click(view.host.querySelector(".screen-zoom"));
  expect(box().width).toBe("400px");
  // Back at the whole screen, two fingers scroll the Mac again.
  rfb.gesture("gesturestart", { type: "twodrag", clientX: 200, clientY: 400, magnitudeX: 0, magnitudeY: 0 });
  expect(rfb.gestures).toEqual(["gesturestart:onetap", "gesturestart:twodrag"]);
});

test("the header button zooms to one Mac pixel per device pixel, and back", async () => {
  const restore = stageSize(400, 800);
  closers.push(restore);
  const ratio = window.devicePixelRatio;
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
  closers.push(() => Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: ratio }));
  const view = mountView();
  await settle();
  FakeRfb.made[0]!.fire("connect");
  click(view.host.querySelector(".screen-zoom"));
  expect(view.host.querySelector<HTMLElement>(".screen-canvas")!.style.width).toBe("2056px");
  click(view.host.querySelector(".screen-zoom"));
  expect(view.host.querySelector<HTMLElement>(".screen-canvas")!.style.width).toBe("400px");
  // A screen that is sharp when fitted still gets closer.
  FakeRfb.made[0]!.canvas.width = 640;
  FakeRfb.made[0]!.canvas.height = 400;
  FakeRfb.made[0]!.fire("connect");
  click(view.host.querySelector(".screen-zoom"));
  expect(view.host.querySelector<HTMLElement>(".screen-canvas")!.style.width).toBe("800px");
});

/** One touch event on `target`, with every finger on the glass afterwards. */
function touch(target: Element, type: string, fingers: Array<[number, number, number]>): void {
  const touches = fingers.map(([identifier, clientX, clientY]) => new Touch({ identifier, target, clientX, clientY }));
  target.dispatchEvent(new TouchEvent(type, { touches, changedTouches: touches, bubbles: true, cancelable: true }));
  flushSync();
}

test("trackpad mode: a finger moves the Mac's pointer by its travel, and a tap clicks where the pointer is", async () => {
  const restore = stageSize(400, 800);
  closers.push(restore, () => saveTrackpadMode(false));
  const sent: number[][] = [];
  const view = mountView({
    connect: async () => ({ sessionId: "S1", mode: "relay" as const, channel: { close() {}, send: (bytes: Uint8Array) => sent.push([...bytes]) } as never }),
  });
  await settle();
  const rfb = FakeRfb.made[0]!;
  rfb.fire("connect");
  const reached: string[] = [];
  for (const type of ["touchstart", "touchmove", "touchend"]) rfb.canvas.addEventListener(type, () => reached.push(type));
  const mode = view.host.querySelector(".screen-mode")!;
  expect(mode.getAttribute("aria-pressed")).toBe("false");
  click(mode);
  expect(mode.getAttribute("aria-pressed")).toBe("true");
  expect(loadTrackpadMode()).toBe(true);
  expect(view.host.querySelector(".screen-tip")?.textContent).toBe(t.screen.trackpadHint);
  const shown = () => {
    const match = view.host.querySelector<HTMLElement>(".screen-pointer")!.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/)!;
    return { x: Number(match[1]), y: Number(match[2]) };
  };
  // The pointer starts in the middle of the Mac's screen: the middle of the fitted picture.
  expect(shown().x).toBeCloseTo(200, 3);
  expect(shown().y).toBeCloseTo(400, 3);

  // A quick 40 px left and 20 down: 2.5× the travel over the picture, in the Mac's pixels.
  const events = () => sent.map((b) => [b[0], b[1], (b[2]! << 8) | b[3]!, (b[4]! << 8) | b[5]!]);
  touch(rfb.canvas, "touchstart", [[1, 300, 500]]);
  touch(rfb.canvas, "touchmove", [[1, 260, 520]]);
  touch(rfb.canvas, "touchend", []);
  expect(events()).toEqual([[5, 0, 1028, 1843]]);
  expect(shown().x).toBeCloseTo(100, 3);
  expect(shown().y).toBeCloseTo(450, 3);

  // A tap anywhere, the black bar above the picture included, clicks at the pointer.
  const stage = view.host.querySelector(".screen-stage")!;
  touch(stage, "touchstart", [[2, 20, 20]]);
  touch(stage, "touchend", []);
  expect(events().slice(1)).toEqual([[5, 1, 1028, 1843], [5, 0, 1028, 1843]]);
  // Two fingers tapped: the right button.
  touch(rfb.canvas, "touchstart", [[3, 100, 400], [4, 160, 400]]);
  touch(rfb.canvas, "touchend", []);
  expect(events().slice(3)).toEqual([[5, 4, 1028, 1843], [5, 0, 1028, 1843]]);
  // noVNC never saw a touch: its own reader would have clicked where the finger was.
  expect(reached).toEqual([]);
  expect(rfb.gestures).toEqual([]);

  // A pinch still zooms the phone's picture, and tells the Mac nothing.
  const count = sent.length;
  touch(rfb.canvas, "touchstart", [[5, 150, 400], [6, 250, 400]]);
  touch(rfb.canvas, "touchmove", [[5, 75, 400], [6, 325, 400]]);
  touch(rfb.canvas, "touchend", []);
  expect(view.host.querySelector<HTMLElement>(".screen-canvas")!.style.width).toBe("1000px");
  expect(sent.length).toBe(count);

  // Back to touching the screen itself: the touches are noVNC's again, and the drawn pointer goes.
  click(mode);
  expect(loadTrackpadMode()).toBe(false);
  expect(view.host.querySelector(".screen-pointer")).toBeNull();
  touch(rfb.canvas, "touchstart", [[7, 10, 10]]);
  expect(reached).toEqual(["touchstart"]);
});

test("trackpad mode is kept on this phone for the next connection", async () => {
  const restore = stageSize(400, 800);
  closers.push(restore, () => saveTrackpadMode(false));
  saveTrackpadMode(true);
  const view = mountView();
  await settle();
  FakeRfb.made[0]!.fire("connect");
  expect(view.host.querySelector(".screen-mode")?.getAttribute("aria-pressed")).toBe("true");
  expect(view.host.querySelector(".screen-pointer")).not.toBeNull();
  // Said only on switching it on, not on every connection.
  expect(view.host.querySelector(".screen-tip")).toBeNull();
});

test("smooth mode starts the connection again asking the Mac to go lower, and says what it did", async () => {
  closers.push(() => saveScreenFlag("smooth", false));
  const asked: boolean[] = [];
  let answer: ScreenConnection["smooth"] = { applied: true, width: 2336, height: 1510, from_width: 4112, from_height: 2658 };
  let made = 0;
  const view = mountView({
    connect: async (_api, options) => {
      asked.push(options?.smooth ?? false);
      return { sessionId: `S${++made}`, mode: "direct" as const, channel: { close() {} } as never, ...(options?.smooth ? { smooth: answer } : {}) };
    },
  });
  await settle();
  FakeRfb.made[0]!.fire("connect");
  const button = view.host.querySelector(".screen-smooth")!;
  expect(button.getAttribute("aria-pressed")).toBe("false");
  click(button);
  await settle();
  expect(loadScreenFlag("smooth")).toBe(true);
  expect(asked).toEqual([false, true]);
  expect(view.calls).toContain("stop S1");
  // Said once the screen is up, not while it is still signing in.
  expect(view.host.querySelector(".screen-tip")).toBeNull();
  FakeRfb.made[1]!.fire("connect");
  expect(view.host.querySelector(".screen-smooth")?.getAttribute("aria-pressed")).toBe("true");
  expect(view.host.querySelector(".screen-tip")?.textContent).toBe(t.screen.smoothApplied("2336×1510"));
  // Off again: a plain connection, and nothing to say.
  click(view.host.querySelector(".screen-smooth"));
  await settle();
  FakeRfb.made[2]!.fire("connect");
  expect(asked).toEqual([false, true, false]);
  expect(view.host.querySelector(".screen-tip")).toBeNull();
  // A Mac too old to answer, and one already at a low resolution.
  answer = null;
  click(view.host.querySelector(".screen-smooth"));
  await settle();
  FakeRfb.made[3]!.fire("connect");
  expect(view.host.querySelector(".screen-tip")?.textContent).toBe(t.screen.smoothUnsupported);
  answer = { applied: false, reason: "already_low" };
  click(view.host.querySelector(".screen-smooth"));
  await settle();
  FakeRfb.made.at(-1)!.fire("connect");
  click(view.host.querySelector(".screen-smooth"));
  await settle();
  FakeRfb.made.at(-1)!.fire("connect");
  expect(view.host.querySelector(".screen-tip")?.textContent).toBe(t.screen.smoothAlreadyLow);
});

test("a new framebuffer size keeps the trackpad pointer where it was on the screen", async () => {
  const restore = stageSize(400, 800);
  closers.push(restore, () => saveTrackpadMode(false));
  saveTrackpadMode(true);
  const view = mountView();
  await settle();
  const rfb = FakeRfb.made[0]!;
  rfb.fire("connect");
  const shown = () => view.host.querySelector<HTMLElement>(".screen-pointer")!.style.transform;
  const before = shown();
  // Screen Sharing announced 2336×1510: noVNC resizes its canvas.
  rfb.canvas.width = 2336;
  rfb.canvas.height = 1510;
  await settle();
  expect(shown()).toBe(before);
  expect(view.host.querySelector<HTMLElement>(".screen-canvas")!.style.width).toBe("400px");
});
