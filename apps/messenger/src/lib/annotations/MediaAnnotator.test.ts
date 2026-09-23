/**
 * The audio / video annotator in happy-dom: the element's duration and position are set by hand
 * (there is no real playback), so these check what the buttons and the timeline do with them —
 * a point, then a span; marks that seek; no crop for audio; a video crop that seeks and comes back.
 */
import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { validateAnchor, type Annotation, type MediaTimeAnchor } from "@real-bot/protocol";
import { buttonByText, click, press, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import MediaAnnotator, { type MediaAnnotatorLabels } from "./MediaAnnotator.svelte";
import type { EncodedCrop } from "./region-box.ts";
import type { FrameDrawer } from "./media-time.ts";

const labels: MediaAnnotatorLabels = {
  markHere: "在此处批注",
  markHereHint: "把当前播放位置记为一个批注点",
  endHere: "到此为止",
  endHereHint: "把批注点延长成一段，到当前播放位置为止",
  timeline: "批注时间轴",
  pending: "待写的批注",
  durationUnknown: "还没读到时长，暂时不能批注",
  spanTooShort: "先播到或拖到终点，至少隔开 1 秒",
  spanPastEnd: "起点超出了现在的时长",
  stale: "文件已变，时间可能不准",
};

type Draft = { anchor: MediaTimeAnchor; crop?: () => Promise<EncodedCrop | null> };

function row(id: string, anchor: MediaTimeAnchor, over: Partial<Annotation> = {}): Annotation {
  return {
    id,
    status: "open",
    relpath: "clips/demo.mp4",
    anchor_kind: "media_time",
    anchor,
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "s1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "s1",
    message_id: "m2",
    body: `remark ${id}`,
    crop_mime: null,
    resolved_by: null,
    resolved_note: null,
    resolved_at: null,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    stale: null,
    ...over,
  };
}

function mountAnnotator(over: { kind?: "audio" | "video"; annotations?: Annotation[]; enabled?: boolean; drawFrame?: FrameDrawer } = {}) {
  const drafts: Draft[] = [];
  const picks: string[] = [];
  const changes: MediaTimeAnchor[] = [];
  let cancels = 0;
  const props = reactive({
    src: "blob:clip",
    kind: over.kind ?? "video",
    annotations: over.annotations ?? [],
    focusId: null as string | null,
    focusSeq: 0,
    active: false,
    enabled: over.enabled ?? true,
    labels,
    pending: null as MediaTimeAnchor | null,
    onDraft: (draft: Draft) => drafts.push(draft),
    onPick: (id: string) => picks.push(id),
    onPendingChange: (anchor: MediaTimeAnchor) => changes.push(anchor),
    onCancel: () => {
      cancels += 1;
    },
    ...(over.drawFrame ? { drawFrame: over.drawFrame } : {}),
  });
  const view = render(MediaAnnotator, props);
  const el = view.host.querySelector("video, audio") as HTMLMediaElement;
  return { ...view, props, el, drafts, picks, changes, cancels: () => cancels };
}

/** What the browser would report: the duration once metadata is in, the position as it plays. */
function report(el: HTMLMediaElement, state: { duration?: number; time?: number }): void {
  if (state.duration !== undefined) {
    const duration = state.duration;
    Object.defineProperty(el, "duration", { configurable: true, get: () => duration });
    el.dispatchEvent(new Event("loadedmetadata"));
  }
  if (state.time !== undefined) {
    el.currentTime = state.time;
    el.dispatchEvent(new Event("timeupdate"));
  }
  flushSync();
}

const valid = (anchor: MediaTimeAnchor) => validateAnchor("media_time", anchor).ok;
const set = (fn: () => void) => {
  fn();
  flushSync();
};

/**
 * A real element lands a seek and then fires `seeked`, and has a picture; happy-dom does neither,
 * so the position is taken over from here. Returns every seek, in order.
 */
function playable(el: HTMLMediaElement, at: number, size = { width: 1280, height: 720 }): number[] {
  let time = at;
  const seeks: number[] = [];
  Object.defineProperty(el, "currentTime", {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = value;
      seeks.push(value);
      queueMicrotask(() => el.dispatchEvent(new Event("seeked")));
    },
  });
  Object.defineProperty(el, "videoWidth", { configurable: true, get: () => size.width });
  Object.defineProperty(el, "videoHeight", { configurable: true, get: () => size.height });
  return seeks;
}

/** Let queued microtasks and a macrotask run: a seek lands, a crop reaches its drawing. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const png: EncodedCrop = { mime: "image/png", base64: "AAAA" };

test("「在此处批注」 then 「到此为止」 makes a valid span, and seeking back still orders it", () => {
  const { host, props, el, drafts, changes, close } = mountAnnotator();
  report(el, { duration: 120, time: 12.5 });
  click(buttonByText(host, "在此处批注"));
  expect(drafts).toHaveLength(1);
  expect(drafts[0]!.anchor).toEqual({ start_ms: 12_500, duration_ms: 120_000 });
  expect(valid(drafts[0]!.anchor)).toBe(true);
  expect(typeof drafts[0]!.crop).toBe("function");

  // The preview holds it while the remark is written.
  set(() => (props.pending = drafts[0]!.anchor));
  expect([...host.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain("在此处批注");
  expect(host.querySelector("[data-media-pending-label]")?.textContent).toBe("00:12");
  expect(host.querySelector("[data-media-pending-label]")?.getAttribute("title")).toBe("待写的批注");
  expect(host.querySelector("[data-media-pending]")?.classList.contains("is-point")).toBe(true);

  // Too close to the start: off, and says why.
  report(el, { time: 12.9 });
  expect(buttonByText(host, "到此为止").disabled).toBe(true);
  expect(host.querySelector(".media-annot-hint")?.textContent).toBe("先播到或拖到终点，至少隔开 1 秒");

  report(el, { time: 40 });
  expect(buttonByText(host, "到此为止").disabled).toBe(false);
  expect(host.querySelector(".media-annot-hint")).toBeNull();
  expect(host.querySelector(".media-annot-preview")).not.toBeNull();
  click(buttonByText(host, "到此为止"));
  expect(changes).toEqual([{ start_ms: 12_500, end_ms: 40_000, duration_ms: 120_000 }]);
  expect(valid(changes[0]!)).toBe(true);
  expect(drafts).toHaveLength(1);

  set(() => (props.pending = changes[0]!));
  expect(host.querySelector("[data-media-pending-label]")?.textContent).toBe("00:12–00:40");
  expect(host.querySelector("[data-media-pending]")?.classList.contains("is-span")).toBe(true);

  // The person seeks back before the point and presses again: the span grows from the point, in order.
  report(el, { time: 5 });
  click(buttonByText(host, "到此为止"));
  expect(changes[1]).toEqual({ start_ms: 5_000, end_ms: 12_500, duration_ms: 120_000 });
  expect(valid(changes[1]!)).toBe(true);
  close();
});

test("marks are numbered in order, styled by status, and a click seeks there and picks it", () => {
  const { host, el, picks, close } = mountAnnotator({
    annotations: [
      row("a", { start_ms: 30_000, duration_ms: 120_000 }),
      row("b", { start_ms: 60_000, end_ms: 90_000, duration_ms: 120_000 }, { status: "draft", message_id: null }),
      row("gone", { start_ms: 1_000, duration_ms: 120_000 }, { stale: { kind: "missing" } }),
      row("late", { start_ms: 150_000, duration_ms: 200_000 }, { stale: { kind: "changed" } }),
      row("c", { start_ms: 100_000, duration_ms: 120_000 }, { status: "resolved", stale: { kind: "changed" } }),
    ],
  });
  // Nothing is placed before the player knows how long the file is.
  expect(host.querySelector("[data-mark-id]")).toBeNull();
  report(el, { duration: 120, time: 0 });
  const marks = [...host.querySelectorAll<HTMLButtonElement>("[data-mark-id]")];
  expect(marks.map((m) => m.dataset.markId)).toEqual(["a", "b", "c"]);
  expect(marks.map((m) => m.textContent?.trim())).toEqual(["1", "2", "5"]);
  expect(marks[0]!.style.left).toBe("25.000%");
  expect(marks[0]!.classList.contains("is-point")).toBe(true);
  expect(marks[0]!.classList.contains("is-open")).toBe(true);
  expect(marks[1]!.style.left).toBe("50.000%");
  expect(marks[1]!.style.width).toBe("25.000%");
  expect(marks[1]!.classList.contains("is-span")).toBe(true);
  expect(marks[1]!.classList.contains("is-draft")).toBe(true);
  expect(marks[2]!.classList.contains("is-resolved")).toBe(true);
  expect(marks[2]!.classList.contains("is-stale")).toBe(true);
  // Hovering shows the remark.
  expect(marks[0]!.title).toBe("1 · 00:30\nremark a");
  expect(marks[2]!.title).toBe("5 · 01:40 · 文件已变，时间可能不准\nremark c");

  click(marks[1]);
  expect(el.currentTime).toBe(60);
  expect(picks).toEqual(["b"]);

  // A tap on the bare timeline seeks to that share of the duration.
  const lanes = host.querySelector(".media-annot-lanes") as HTMLElement;
  lanes.getBoundingClientRect = () => ({ left: 100, top: 0, width: 400, height: 20, right: 500, bottom: 20, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;
  lanes.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 10 }));
  flushSync();
  expect(el.currentTime).toBe(30);
  expect(picks).toEqual(["b"]);
  close();
});

test("audio renders an <audio> player and its drafts carry no crop", () => {
  const { host, el, drafts, close } = mountAnnotator({ kind: "audio" });
  expect(el.tagName).toBe("AUDIO");
  expect(host.querySelector("video")).toBeNull();
  report(el, { duration: 3_723.4, time: 3_600 });
  click(buttonByText(host, "在此处批注"));
  expect(drafts).toHaveLength(1);
  expect(drafts[0]!.anchor).toEqual({ start_ms: 3_600_000, duration_ms: 3_723_400 });
  expect(valid(drafts[0]!.anchor)).toBe(true);
  expect("crop" in drafts[0]!).toBe(false);
  close();
});

test("a video crop is the frame at the anchor's start, and playback comes back to where it was", async () => {
  const drawn: number[] = [];
  const png: EncodedCrop = { mime: "image/png", base64: "AAAA" };
  const { host, props, el, drafts, close } = mountAnnotator({
    drawFrame: async (source, rect) => {
      drawn.push(source.currentTime);
      expect(rect).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
      return png;
    },
  });
  report(el, { duration: 120, time: 12.5 });
  click(buttonByText(host, "在此处批注"));
  set(() => (props.pending = drafts[0]!.anchor));

  // It keeps playing while the remark is written; a real element fires `seeked` after a seek.
  let time = 30;
  Object.defineProperty(el, "currentTime", {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = value;
      queueMicrotask(() => el.dispatchEvent(new Event("seeked")));
    },
  });
  Object.defineProperty(el, "videoWidth", { configurable: true, get: () => 1280 });
  Object.defineProperty(el, "videoHeight", { configurable: true, get: () => 720 });
  await el.play();
  expect(el.paused).toBe(false);

  expect(await drafts[0]!.crop!()).toEqual(png);
  expect(drawn).toEqual([12.5]);
  expect(el.currentTime).toBe(30);
  expect(el.paused).toBe(false);

  // Turned into a span that starts earlier: the crop follows the anchor as it is now.
  set(() => (props.pending = { start_ms: 5_000, end_ms: 12_500, duration_ms: 120_000 }));
  el.pause();
  expect(await drafts[0]!.crop!()).toEqual(png);
  expect(drawn).toEqual([12.5, 5]);
  expect(el.currentTime).toBe(30);
  expect(el.paused).toBe(true);
  close();
});

test("closing the preview while a crop is under way does not leave the video playing off the page", async () => {
  let closeNow: () => void = () => {};
  const { host, props, el, drafts, close } = mountAnnotator({
    drawFrame: async () => {
      closeNow();
      return { mime: "image/png", base64: "AAAA" };
    },
  });
  closeNow = close;
  report(el, { duration: 120, time: 12.5 });
  click(buttonByText(host, "在此处批注"));
  set(() => (props.pending = drafts[0]!.anchor));
  let time = 30;
  Object.defineProperty(el, "currentTime", {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = value;
      queueMicrotask(() => el.dispatchEvent(new Event("seeked")));
    },
  });
  Object.defineProperty(el, "videoWidth", { configurable: true, get: () => 1280 });
  Object.defineProperty(el, "videoHeight", { configurable: true, get: () => 720 });
  await el.play();
  const crop = await drafts[0]!.crop!();
  expect(crop?.mime).toBe("image/png");
  expect(el.isConnected).toBe(false);
  expect(el.paused).toBe(true);
});

test("Escape with an anchor pending cancels it without reaching the pane; otherwise it passes", () => {
  const { host, props, el, cancels, close } = mountAnnotator();
  report(el, { duration: 120, time: 10 });
  // The shell closes the preview from a window keydown handler: that is what must not hear it.
  let reached = 0;
  const onWindow = () => {
    reached += 1;
  };
  window.addEventListener("keydown", onWindow);
  press(buttonByText(host, "在此处批注"), "Escape");
  expect(reached).toBe(1);
  expect(cancels()).toBe(0);

  set(() => (props.pending = { start_ms: 10_000, duration_ms: 120_000 }));
  press(buttonByText(host, "到此为止"), "Escape");
  expect(cancels()).toBe(1);
  expect(reached).toBe(1);

  // 「在此处批注」 is gone once the point is taken, so focus is usually on the page, not in here.
  press(document.body, "Escape");
  expect(cancels()).toBe(2);
  expect(reached).toBe(1);
  // From the player itself too.
  press(el, "Escape");
  expect(cancels()).toBe(3);
  expect(reached).toBe(1);

  // Something nearer the key (the composer, an open list) that already took it is left alone.
  const taken = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  taken.preventDefault();
  document.body.dispatchEvent(taken);
  expect(cancels()).toBe(3);
  // So is a key typed into an input method.
  press(document.body, "Escape", { isComposing: true });
  expect(cancels()).toBe(3);
  // Other keys pass.
  press(document.body, "Enter");
  expect(reached).toBe(4);

  // Once nothing is pending, Escape goes on to the pane again.
  set(() => (props.pending = null));
  press(document.body, "Escape");
  expect(cancels()).toBe(3);
  expect(reached).toBe(5);
  window.removeEventListener("keydown", onWindow);
  close();
});

test("without onCancel, Escape is not swallowed even with an anchor pending", () => {
  const { props, el, close } = mountAnnotator();
  report(el, { duration: 120, time: 10 });
  set(() => {
    props.onCancel = undefined as never;
    props.pending = { start_ms: 10_000, duration_ms: 120_000 };
  });
  let reached = 0;
  const onWindow = () => {
    reached += 1;
  };
  window.addEventListener("keydown", onWindow);
  press(document.body, "Escape");
  expect(reached).toBe(1);
  window.removeEventListener("keydown", onWindow);
  close();
});

test("an unmounted annotator stops listening for Escape", () => {
  const { props, el, cancels, close } = mountAnnotator();
  report(el, { duration: 120, time: 10 });
  set(() => (props.pending = { start_ms: 10_000, duration_ms: 120_000 }));
  close();
  press(document.body, "Escape");
  expect(cancels()).toBe(0);
});

test("with annotating off, marks are still drawn and nothing can be started; a pending one can still end", () => {
  const { host, props, el, close } = mountAnnotator({ enabled: false, annotations: [row("a", { start_ms: 30_000, duration_ms: 120_000 })] });
  report(el, { duration: 120, time: 50 });
  expect(host.querySelectorAll("[data-mark-id]")).toHaveLength(1);
  expect([...host.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["1"]);
  // The preview turns `enabled` off while an anchor waits for its remark.
  set(() => (props.pending = { start_ms: 10_000, duration_ms: 120_000 }));
  expect(buttonByText(host, "到此为止").disabled).toBe(false);
  close();

  const none = mountAnnotator({ enabled: false });
  report(none.el, { duration: 120 });
  expect(none.host.querySelector("[data-media-timeline]")).toBeNull();
  expect(none.host.querySelector("button")).toBeNull();
  none.close();
});

test("a new focus seeks to that annotation, flashes its mark and scrolls it into view; one past the end is left alone", async () => {
  const { host, props, el, close } = mountAnnotator({
    annotations: [
      row("a", { start_ms: 30_000, duration_ms: 120_000 }),
      row("b", { start_ms: 60_000, end_ms: 90_000, duration_ms: 120_000 }),
      row("late", { start_ms: 150_000, duration_ms: 200_000 }, { stale: { kind: "changed" } }),
    ],
  });
  report(el, { duration: 120, time: 0 });
  const scrolled: string[] = [];
  for (const mark of host.querySelectorAll<HTMLElement>("[data-mark-id]")) {
    mark.scrollIntoView = () => scrolled.push(mark.dataset.markId ?? "");
  }
  set(() => (props.focusId = "b"));
  expect(el.currentTime).toBe(60);
  expect(host.querySelector('[data-mark-id="b"]')?.classList.contains("is-flash")).toBe(true);
  expect(host.querySelector('[data-mark-id="a"]')?.classList.contains("is-flash")).toBe(false);
  await settle();
  expect(scrolled).toEqual(["b"]);

  set(() => (props.focusId = "late"));
  expect(el.currentTime).toBe(60);
  await settle();
  expect(scrolled).toEqual(["b"]);
  close();
});

test("a crop asked for after the preview let go of the anchor is still the frame at its start", async () => {
  const drawn: number[] = [];
  const { host, props, el, drafts, changes, close } = mountAnnotator({
    drawFrame: async (source) => {
      drawn.push(source.currentTime);
      return png;
    },
  });
  report(el, { duration: 120, time: 12.5 });
  click(buttonByText(host, "在此处批注"));
  set(() => (props.pending = drafts[0]!.anchor));
  // Seeks back before ending it: the span now starts earlier than the point.
  report(el, { time: 5 });
  click(buttonByText(host, "到此为止"));
  expect(changes).toEqual([{ start_ms: 5_000, end_ms: 12_500, duration_ms: 120_000 }]);
  set(() => (props.pending = changes[0]!));
  set(() => (props.pending = null));

  playable(el, 20);
  expect(await drafts[0]!.crop!()).toEqual(png);
  expect(drawn).toEqual([5]);
  expect(el.currentTime).toBe(20);
  close();
});

test("while a crop is under way the buttons wait and the playhead does not follow the detour", async () => {
  // Each crop's drawing waits until the test lets it go.
  let release: () => void = () => {};
  let drawing = false;
  const { host, props, el, drafts, changes, close } = mountAnnotator({
    drawFrame: async () => {
      drawing = true;
      await new Promise<void>((resolve) => (release = resolve));
      return png;
    },
  });
  report(el, { duration: 120, time: 12.5 });
  click(buttonByText(host, "在此处批注"));
  set(() => (props.pending = drafts[0]!.anchor));
  playable(el, 40);
  report(el, { time: 40 });
  const playhead = () => (host.querySelector(".media-annot-playhead") as HTMLElement).style.left;
  expect(playhead()).toBe("33.333%");
  expect(buttonByText(host, "到此为止").disabled).toBe(false);

  // The preview saves: it asks for the crop while the anchor is still pending.
  const cropping = drafts[0]!.crop!();
  await settle();
  flushSync();
  expect(drawing).toBe(true);
  expect(el.currentTime).toBe(12.5);
  expect(playhead()).toBe("33.333%");
  expect(buttonByText(host, "到此为止").disabled).toBe(true);
  // A press that lands anyway does not read the detour as the playback position.
  click(buttonByText(host, "到此为止"));
  expect(changes).toEqual([]);

  release();
  expect(await cropping).toEqual(png);
  flushSync();
  expect(el.currentTime).toBe(40);
  expect(playhead()).toBe("33.333%");
  expect(buttonByText(host, "到此为止").disabled).toBe(false);

  // And once the anchor is gone, 「在此处批注」 waits for a crop the same way.
  set(() => (props.pending = null));
  drawing = false;
  const again = drafts[0]!.crop!();
  await settle();
  flushSync();
  expect(drawing).toBe(true);
  expect(buttonByText(host, "在此处批注").disabled).toBe(true);
  click(buttonByText(host, "在此处批注"));
  expect(drafts).toHaveLength(1);
  release();
  await again;
  flushSync();
  expect(buttonByText(host, "在此处批注").disabled).toBe(false);
  close();
});

test("two crops asked for at once run one after the other, each coming back to the real position", async () => {
  const drawn: number[] = [];
  const { host, props, el, drafts, close } = mountAnnotator({
    drawFrame: async (source) => {
      drawn.push(source.currentTime);
      return png;
    },
  });
  report(el, { duration: 120, time: 12.5 });
  click(buttonByText(host, "在此处批注"));
  set(() => (props.pending = drafts[0]!.anchor));
  const seeks = playable(el, 30);
  const [first, second] = await Promise.all([drafts[0]!.crop!(), drafts[0]!.crop!()]);
  expect(first).toEqual(png);
  expect(second).toEqual(png);
  expect(drawn).toEqual([12.5, 12.5]);
  expect(seeks).toEqual([12.5, 30, 12.5, 30]);
  expect(el.currentTime).toBe(30);
  close();
});

test("「到此为止」 says so when the point now lies past the end the player reports", () => {
  const { host, props, el, drafts, changes, close } = mountAnnotator();
  report(el, { duration: 120, time: 100 });
  click(buttonByText(host, "在此处批注"));
  set(() => (props.pending = drafts[0]!.anchor));
  // The file was swapped for a shorter one while the remark was being written.
  report(el, { duration: 80, time: 50 });
  expect(buttonByText(host, "到此为止").disabled).toBe(true);
  expect(host.querySelector(".media-annot-hint")?.textContent).toBe("起点超出了现在的时长");
  click(buttonByText(host, "到此为止"));
  expect(changes).toEqual([]);
  close();
});

test("on a phone-narrow timeline, points a few seconds apart are dealt into separate lanes", () => {
  const Real = globalThis.ResizeObserver;
  const fire: Array<() => void> = [];
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      fire.push(() => callback([], this as unknown as ResizeObserver));
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  try {
    const { host, el, close } = mountAnnotator({
      annotations: [row("p1", { start_ms: 60_000, duration_ms: 180_000 }), row("p2", { start_ms: 70_000, duration_ms: 180_000 })],
    });
    report(el, { duration: 180, time: 0 });
    const lanes = () => [...host.querySelectorAll<HTMLElement>("[data-mark-id]")].map((m) => m.style.getPropertyValue("--lane"));
    expect(lanes()).toEqual(["0", "0"]);

    // Laid out at a phone's width, where a point's mark is 40px wide.
    const track = host.querySelector(".media-annot-lanes") as HTMLElement;
    Object.defineProperty(track, "clientWidth", { configurable: true, get: () => 310 });
    track.style.setProperty("--lane-h", "40px");
    for (const run of fire) run();
    flushSync();
    expect(lanes()).toEqual(["0", "1"]);
    expect(track.style.getPropertyValue("--lanes")).toBe("2");
    close();
  } finally {
    globalThis.ResizeObserver = Real;
  }
});

test("without a duration nothing can be started, and the reason shows once the metadata is in", () => {
  const { host, el, drafts, close } = mountAnnotator();
  // Still loading: the button waits quietly.
  const button = buttonByText(host, "在此处批注");
  expect(button.disabled).toBe(true);
  expect(host.querySelector(".media-annot-hint")).toBeNull();
  // A stream with no end.
  report(el, { duration: Number.POSITIVE_INFINITY, time: 4 });
  expect(buttonByText(host, "在此处批注").disabled).toBe(true);
  expect(host.querySelector(".media-annot-hint")?.textContent).toBe("还没读到时长，暂时不能批注");
  click(buttonByText(host, "在此处批注"));
  expect(drafts).toEqual([]);
  close();
});

test("asking again for the annotation that already has focus seeks back to its start; new rows alone do not", async () => {
  const rows = [row("b", { start_ms: 60_000, end_ms: 90_000, duration_ms: 120_000 })];
  const { host, props, el, close } = mountAnnotator({ annotations: rows });
  report(el, { duration: 120, time: 0 });
  set(() => (props.focusId = "b"));
  expect(el.currentTime).toBe(60);
  // Playback moves on past it.
  report(el, { time: 100 });
  // A snapshot hands the same rows in again: not a request to go anywhere.
  set(() => (props.annotations = rows.map((r) => ({ ...r }))));
  expect(el.currentTime).toBe(100);
  set(() => (props.focusSeq += 1));
  expect(el.currentTime).toBe(60);
  expect(host.querySelector('[data-mark-id="b"]')?.classList.contains("is-flash")).toBe(true);
  close();
});
