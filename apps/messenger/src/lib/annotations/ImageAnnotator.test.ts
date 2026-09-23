/**
 * The image annotator mounted in happy-dom: existing rows drawn as numbered boxes in the three
 * states (stale dashed, a gone file not drawn), a drag or a click in annotate mode handing over a
 * valid anchor and its crop, the pending box moving and resizing, and Escape cancelling before the
 * pane hears it. happy-dom has no layout, so the image's drawn rect is stubbed.
 */
import { afterEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import { validateAnchor, type Annotation, type ImageRegionAnchor } from "@real-bot/protocol";
import { click, press, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import type { CanvasFactory } from "./image-region.ts";
import type { EncodedCrop } from "./region-box.ts";
import ImageAnnotator, { type ImageAnnotatorLabels, type ImageRegionDraft } from "./ImageAnnotator.svelte";

const labels: ImageAnnotatorLabels = {
  region: "在图上拖出一个框，或点一下",
  mark: (n, remark) => `批注 ${n}：${remark}`,
  pending: "新批注的位置，拖动可挪位置",
  resize: "拖动改大小",
  stale: "图片已变，位置可能不准",
};

/** Where the stubbed image is drawn: 400×200 at (100, 50), showing a 2000×1000 original. */
const DRAWN = { left: 100, top: 50, width: 400, height: 200 };
const at = (x: number, y: number) => ({ x: DRAWN.left + x * DRAWN.width, y: DRAWN.top + y * DRAWN.height });

function row(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    status: "open",
    relpath: "out/chart.png",
    anchor_kind: "image_region",
    anchor: { x: 0.1, y: 0.2, w: 0.3, h: 0.4, natural_width: 2000, natural_height: 1000 },
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "s1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "s1",
    message_id: "m2",
    body: "图例挡住了曲线",
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

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

type Over = Partial<{
  annotations: Annotation[];
  focusId: string | null;
  focusSeq: number;
  active: boolean;
  enabled: boolean;
  pending: ImageRegionAnchor | null;
  isSvg: boolean;
  svgText: string | null;
  canvas: CanvasFactory;
}>;

function mount(over: Over = {}) {
  const drafts: ImageRegionDraft[] = [];
  const picks: string[] = [];
  const changes: ImageRegionAnchor[] = [];
  let cancels = 0;
  // A `$state` object, so a test can hand the component new props the way the preview would.
  const props = reactive({
    src: "blob:test/chart",
    alt: "out/chart.png",
    isSvg: over.isSvg ?? false,
    svgText: over.svgText ?? null,
    annotations: over.annotations ?? [],
    focusId: over.focusId ?? null,
    focusSeq: over.focusSeq ?? 0,
    active: over.active ?? false,
    enabled: over.enabled ?? true,
    labels,
    onDraft: (draft: ImageRegionDraft) => drafts.push(draft),
    onPick: (id: string) => picks.push(id),
    pending: over.pending,
    onPendingChange: (anchor: ImageRegionAnchor) => changes.push(anchor),
    onCancel: () => {
      cancels += 1;
    },
    cropDeps: over.canvas ? { canvas: over.canvas } : undefined,
  });
  const view = render(ImageAnnotator, props);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    view.close();
  };
  cleanups.push(close);
  const img = view.host.querySelector("img")!;
  const layer = view.host.querySelector("[data-annot-layer]") as HTMLElement;
  return { ...view, props, close, img, layer, drafts, picks, changes, cancels: () => cancels };
}

/** A canvas double that records each draw and encodes to a 3-byte PNG. */
function recordingCanvas(): { factory: CanvasFactory; drawn: number[][] } {
  const drawn: number[][] = [];
  const factory: CanvasFactory = () => ({
    ctx: { drawImage: (_image: CanvasImageSource, ...args: number[]) => void drawn.push(args) },
    encoder: { toBlob: async (type: string) => new Blob([new Uint8Array(3)], { type }) },
  });
  return { factory, drawn };
}

/** Pretend the image loaded and was laid out at {@link DRAWN}. */
function load(img: HTMLImageElement, natural = { width: 2000, height: 1000 }): void {
  Object.defineProperty(img, "naturalWidth", { value: natural.width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: natural.height, configurable: true });
  img.getBoundingClientRect = () =>
    ({ ...DRAWN, x: DRAWN.left, y: DRAWN.top, right: DRAWN.left + DRAWN.width, bottom: DRAWN.top + DRAWN.height, toJSON: () => ({}) }) as DOMRect;
  img.dispatchEvent(new Event("load"));
  flushSync();
}

function pointer(el: Element, type: string, point: { x: number; y: number }, init: PointerEventInit = {}): void {
  el.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, pointerId: 7, button: 0, isPrimary: true, pointerType: "mouse", ...init }),
  );
  flushSync();
}

/** An element's box as its inline style says it, trailing zeros dropped (`10.000%` → `10%`). */
function styleOf(el: Element | null): Record<string, string> {
  const style = (el as HTMLElement).style;
  const tidy = (value: string) => `${Number.parseFloat(value)}${value.replace(/^[-\d.]+/, "")}`;
  return { left: tidy(style.left), top: tidy(style.top), width: tidy(style.width), height: tidy(style.height) };
}

test("the image keeps its look, and existing rows are numbered boxes in their state", () => {
  const { host, img } = mount({
    annotations: [
      row({ id: "o" }),
      row({ id: "d", status: "draft", message_id: null, anchor: { x: 0.5, y: 0.5, w: 0.25, h: 0.25, natural_width: 2000, natural_height: 1000 } }),
      row({ id: "r", status: "resolved" }),
      row({ id: "s", stale: { kind: "changed" }, body: "箭头方向反了" }),
      row({ id: "gone", stale: { kind: "missing" } }),
    ],
  });
  expect(img.getAttribute("class")).toContain("artifact-img max-w-full max-h-full block my-0 mx-auto");
  expect(img.getAttribute("src")).toBe("blob:test/chart");
  expect(img.getAttribute("alt")).toBe("out/chart.png");
  const marks = [...host.querySelectorAll(".img-annot-mark")];
  expect(marks.map((m) => m.getAttribute("data-annotation-id"))).toEqual(["o", "d", "r", "s"]);
  expect(marks.map((m) => m.querySelector(".img-annot-num")?.textContent)).toEqual(["1", "2", "3", "4"]);
  expect(marks[0]!.classList.contains("is-open")).toBe(true);
  expect(marks[1]!.classList.contains("is-draft")).toBe(true);
  expect(marks[2]!.classList.contains("is-resolved")).toBe(true);
  expect(marks[3]!.classList.contains("is-stale")).toBe(true);
  expect(marks[0]!.classList.contains("is-stale")).toBe(false);
  // Positioned in percentages of the drawn image, so they follow any resize.
  expect(styleOf(marks[0]!)).toEqual({ left: "10%", top: "20%", width: "30%", height: "40%" });
  expect(styleOf(marks[1]!)).toEqual({ left: "50%", top: "50%", width: "25%", height: "25%" });
  // Hover shows the remark; a stale one says the image changed.
  expect(marks[0]!.getAttribute("title")).toBe("图例挡住了曲线");
  expect(marks[3]!.getAttribute("title")).toBe("箭头方向反了\n图片已变，位置可能不准");
  expect(marks[3]!.getAttribute("aria-label")).toBe("批注 4：箭头方向反了");
  expect(host.querySelector("[data-annot-pending]")).toBeNull();
  // Not laid out yet: the boxes are kept out of sight rather than drawn against the wrong size.
  expect(host.querySelector("[data-annot-layer]")!.classList.contains("is-unmeasured")).toBe(true);
});

test("a click on a mark picks it, and a focused one flashes once the image is shown", async () => {
  const { host, img, picks } = mount({ annotations: [row({ id: "o" }), row({ id: "r", status: "resolved" })], focusId: "r" });
  const scrolled: string[] = [];
  for (const el of host.querySelectorAll<HTMLElement>("[data-annotation-id]")) {
    el.scrollIntoView = () => void scrolled.push(el.dataset.annotationId!);
  }
  click(host.querySelector('[data-annotation-id="o"]'));
  expect(picks).toEqual(["o"]);
  // The file has just opened: the boxes are hidden until the image is there, so the flash waits.
  expect(host.querySelector('[data-annotation-id="r"]')!.classList.contains("is-flash")).toBe(false);
  load(img);
  expect(host.querySelector('[data-annotation-id="r"]')!.classList.contains("is-flash")).toBe(true);
  expect(host.querySelector('[data-annotation-id="o"]')!.classList.contains("is-flash")).toBe(false);
  await Promise.resolve();
  await Promise.resolve();
  expect(scrolled).toEqual(["r"]);
});

test("in annotate mode a drag on the image hands over a valid anchor and keeps the box pending", () => {
  const { host, img, layer, drafts } = mount({ active: true });
  load(img);
  expect(host.querySelector("[data-image-annotator]")!.classList.contains("is-creating")).toBe(true);
  expect(styleOf(layer)).toEqual({ left: "100px", top: "50px", width: "400px", height: "200px" });
  expect(layer.classList.contains("is-unmeasured")).toBe(false);
  pointer(layer, "pointerdown", at(0.1, 0.1));
  pointer(layer, "pointermove", at(0.3, 0.3));
  // The box follows the pointer while it is dragged out.
  expect(styleOf(host.querySelector(".img-annot-live"))).toEqual({ left: "10%", top: "10%", width: "20%", height: "20%" });
  pointer(layer, "pointermove", at(0.4, 0.5));
  pointer(layer, "pointerup", at(0.4, 0.5));
  expect(drafts).toHaveLength(1);
  const anchor = drafts[0]!.anchor;
  expect(anchor).toEqual({ x: 0.1, y: 0.1, w: 0.3, h: 0.4, natural_width: 2000, natural_height: 1000 });
  expect(validateAnchor("image_region", anchor).ok).toBe(true);
  expect(host.querySelector(".img-annot-live")).toBeNull();
  const pending = host.querySelector("[data-annot-pending]");
  expect(styleOf(pending)).toEqual({ left: "10%", top: "10%", width: "30%", height: "40%" });
  expect([...pending!.querySelectorAll("[data-handle]")].map((h) => h.getAttribute("data-handle"))).toEqual(["nw", "ne", "sw", "se"]);
  // With a box pending, another drag does not start a second one.
  pointer(layer, "pointerdown", at(0.7, 0.7));
  pointer(layer, "pointerup", at(0.9, 0.9));
  expect(drafts).toHaveLength(1);
});

test("a click, or a drag shorter than a few pixels, is a small box 4% of the short side", () => {
  const { layer, img, drafts } = mount({ active: true });
  load(img);
  const from = at(0.5, 0.5);
  pointer(layer, "pointerdown", from);
  pointer(layer, "pointermove", { x: from.x + 2, y: from.y + 1 });
  pointer(layer, "pointerup", { x: from.x + 2, y: from.y + 1 });
  expect(drafts).toHaveLength(1);
  // 4% of 1000px is 40px: 0.02 of the 2000px width, 0.04 of the height, centred on the click.
  expect(drafts[0]!.anchor).toEqual({ x: 0.49, y: 0.48, w: 0.02, h: 0.04, natural_width: 2000, natural_height: 1000 });
  expect(validateAnchor("image_region", drafts[0]!.anchor).ok).toBe(true);
});

test("nothing is made when annotating is off, not allowed, or the image has not loaded", () => {
  const off = mount({ active: false });
  load(off.img);
  pointer(off.layer, "pointerdown", at(0.1, 0.1));
  pointer(off.layer, "pointerup", at(0.5, 0.5));
  expect(off.drafts).toHaveLength(0);
  const disabled = mount({ active: true, enabled: false, annotations: [row()] });
  load(disabled.img);
  pointer(disabled.layer, "pointerdown", at(0.1, 0.1));
  pointer(disabled.layer, "pointerup", at(0.5, 0.5));
  expect(disabled.drafts).toHaveLength(0);
  expect(disabled.host.querySelectorAll(".img-annot-mark")).toHaveLength(1);
  const early = mount({ active: true });
  pointer(early.layer, "pointerdown", at(0.1, 0.1));
  pointer(early.layer, "pointerup", at(0.5, 0.5));
  expect(early.drafts).toHaveLength(0);
});

test("a pointer that is cancelled mid-drag leaves nothing behind", () => {
  const { host, layer, img, drafts } = mount({ active: true });
  load(img);
  pointer(layer, "pointerdown", at(0.1, 0.1));
  pointer(layer, "pointermove", at(0.5, 0.5));
  pointer(layer, "pointercancel", at(0.5, 0.5));
  pointer(layer, "pointerup", at(0.5, 0.5));
  expect(drafts).toHaveLength(0);
  expect(host.querySelector(".img-annot-live")).toBeNull();
  expect(host.querySelector("[data-annot-pending]")).toBeNull();
});

test("the pending box moves and resizes, reporting each change", () => {
  const pending: ImageRegionAnchor = { x: 0.1, y: 0.1, w: 0.2, h: 0.2, natural_width: 2000, natural_height: 1000 };
  const moved = mount({ pending });
  load(moved.img);
  const box = moved.host.querySelector("[data-annot-pending]")!;
  pointer(box, "pointerdown", at(0.2, 0.2));
  pointer(box, "pointermove", at(0.3, 0.3));
  pointer(box, "pointerup", at(0.3, 0.3));
  expect(moved.changes).toEqual([{ x: 0.2, y: 0.2, w: 0.2, h: 0.2, natural_width: 2000, natural_height: 1000 }]);
  expect(styleOf(moved.host.querySelector("[data-annot-pending]"))).toEqual({ left: "20%", top: "20%", width: "20%", height: "20%" });
  expect(moved.drafts).toHaveLength(0);

  const resized = mount({ pending });
  load(resized.img);
  const handle = resized.host.querySelector('[data-handle="se"]')!;
  pointer(handle, "pointerdown", at(0.3, 0.3));
  pointer(handle, "pointermove", at(0.5, 0.6));
  pointer(handle, "pointerup", at(0.5, 0.6));
  expect(resized.changes).toEqual([{ x: 0.1, y: 0.1, w: 0.4, h: 0.5, natural_width: 2000, natural_height: 1000 }]);
  // A press that does not move reports nothing.
  const still = mount({ pending });
  load(still.img);
  const stillBox = still.host.querySelector("[data-annot-pending]")!;
  pointer(stillBox, "pointerdown", at(0.2, 0.2));
  pointer(stillBox, "pointerup", at(0.2, 0.2));
  expect(still.changes).toEqual([]);
});

test("the crop is cut from the loaded image at the box as it stands when the remark is saved", async () => {
  const drawn: number[][] = [];
  const canvas: CanvasFactory = () => ({
    ctx: { drawImage: (_image: CanvasImageSource, ...args: number[]) => void drawn.push(args) },
    encoder: { toBlob: async (type: string) => new Blob([new Uint8Array(3)], { type }) },
  });
  const { host, layer, img, drafts } = mount({ active: true, canvas });
  load(img);
  pointer(layer, "pointerdown", at(0.25, 0.25));
  pointer(layer, "pointermove", at(0.5, 0.5));
  pointer(layer, "pointerup", at(0.5, 0.5));
  // Moved before saving: the crop follows.
  const box = host.querySelector("[data-annot-pending]")!;
  pointer(box, "pointerdown", at(0.3, 0.3));
  pointer(box, "pointermove", at(0.55, 0.55));
  pointer(box, "pointerup", at(0.55, 0.55));
  const crop: EncodedCrop | null = (await drafts[0]!.crop?.()) ?? null;
  expect(crop).toEqual({ mime: "image/png", base64: "AAAA" });
  // Box 0.5–0.75 of 2000×1000 plus 10% of its size each side: x 950–1550, y 475–775.
  expect(drawn).toEqual([[950, 475, 600, 300, 0, 0, 600, 300]]);
});

test("Escape while choosing or with a box pending cancels before the pane can close", () => {
  let paneHeard = 0;
  const onWindowKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") paneHeard += 1;
  };
  window.addEventListener("keydown", onWindowKey);
  cleanups.push(() => window.removeEventListener("keydown", onWindowKey));

  const choosing = mount({ active: true });
  load(choosing.img);
  press(choosing.layer, "Escape");
  expect(choosing.cancels()).toBe(1);
  expect(paneHeard).toBe(0);
  choosing.close();

  const drawn = mount({ active: true });
  load(drawn.img);
  pointer(drawn.layer, "pointerdown", at(0.1, 0.1));
  pointer(drawn.layer, "pointerup", at(0.4, 0.4));
  expect(drawn.host.querySelector("[data-annot-pending]")).not.toBeNull();
  press(drawn.layer, "Escape");
  expect(drawn.cancels()).toBe(1);
  expect(drawn.host.querySelector("[data-annot-pending]")).toBeNull();
  expect(paneHeard).toBe(0);
  drawn.close();

  // Not annotating and nothing pending: Escape is the pane's.
  const idle = mount({ annotations: [row()] });
  press(idle.layer, "Escape");
  expect(idle.cancels()).toBe(0);
  expect(paneHeard).toBe(1);
});

test("Escape halfway through dragging out a box only drops the box: annotate mode is the next Escape's", () => {
  let paneHeard = 0;
  const onWindowKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") paneHeard += 1;
  };
  window.addEventListener("keydown", onWindowKey);
  cleanups.push(() => window.removeEventListener("keydown", onWindowKey));
  const view = mount({ active: true });
  load(view.img);
  pointer(view.layer, "pointerdown", at(0.1, 0.1));
  pointer(view.layer, "pointermove", at(0.3, 0.3));
  press(view.layer, "Escape");
  expect(view.cancels()).toBe(0);
  expect(view.drafts).toHaveLength(0);
  expect(paneHeard).toBe(0);
  // The pointer lifting afterwards draws nothing.
  pointer(view.layer, "pointerup", at(0.3, 0.3));
  expect(view.drafts).toHaveLength(0);
  press(view.layer, "Escape");
  expect(view.cancels()).toBe(1);
});

test("a single-finger drag works like a mouse drag, and an SVG is measured in its viewBox", () => {
  const { layer, img, drafts } = mount({ active: true, isSvg: true, svgText: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"><path d="M0 0"/></svg>' });
  // The browser's own guess for a viewBox-only SVG is not what the anchor is measured in.
  load(img, { width: 300, height: 150 });
  const touch = { pointerType: "touch", pointerId: 11 };
  pointer(layer, "pointerdown", at(0.5, 0.25), touch);
  pointer(layer, "pointermove", at(0.75, 0.75), touch);
  pointer(layer, "pointerup", at(0.75, 0.75), touch);
  expect(drafts.map((d) => d.anchor)).toEqual([{ x: 0.5, y: 0.25, w: 0.25, h: 0.5, natural_width: 800, natural_height: 400 }]);
});

test("a long press on a mark shows its remark, and the tap it ends with does not also pick it", async () => {
  const { host, picks } = mount({ annotations: [row({ id: "o", body: "标题字号太小" })] });
  const mark = host.querySelector('[data-annotation-id="o"]')!;
  pointer(mark, "pointerdown", { x: 0, y: 0 }, { pointerType: "touch" });
  expect(host.querySelector(".img-annot-peek")).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 560));
  flushSync();
  expect(host.querySelector(".img-annot-peek")?.textContent).toBe("标题字号太小");
  pointer(mark, "pointerup", { x: 0, y: 0 }, { pointerType: "touch" });
  click(mark);
  expect(picks).toEqual([]);
  // The next tap is an ordinary one.
  pointer(mark, "pointerdown", { x: 0, y: 0 }, { pointerType: "touch" });
  pointer(mark, "pointerup", { x: 0, y: 0 }, { pointerType: "touch" });
  click(mark);
  expect(picks).toEqual(["o"]);
  expect(host.querySelector(".img-annot-peek")).toBeNull();
});

test("while annotating, a mark's number still opens it instead of starting a box", () => {
  const { host, img, drafts, picks } = mount({ active: true, annotations: [row({ id: "o" })] });
  load(img);
  const num = host.querySelector('[data-annotation-id="o"] .img-annot-num')!;
  pointer(num, "pointerdown", at(0.1, 0.2));
  pointer(num, "pointerup", at(0.1, 0.2));
  click(num);
  expect(drafts).toHaveLength(0);
  expect(picks).toEqual(["o"]);
});

test("a handle pressed off its corner resizes from where it was grabbed, without a jump", () => {
  const pending: ImageRegionAnchor = { x: 0.1, y: 0.1, w: 0.4, h: 0.5, natural_width: 2000, natural_height: 1000 };
  const { host, img, changes } = mount({ pending });
  load(img);
  const handle = host.querySelector('[data-handle="se"]')!;
  const corner = at(0.5, 0.6);
  // A finger lands 7px right of and 6px below the corner, then moves 20px each way.
  pointer(handle, "pointerdown", { x: corner.x + 7, y: corner.y + 6 });
  pointer(handle, "pointermove", { x: corner.x + 27, y: corner.y + 26 });
  pointer(handle, "pointerup", { x: corner.x + 27, y: corner.y + 26 });
  // The corner moved those 20px (0.05 of 400, 0.1 of 200), not onto the finger.
  expect(changes).toEqual([{ x: 0.1, y: 0.1, w: 0.45, h: 0.6, natural_width: 2000, natural_height: 1000 }]);
  // Dragged past the image's edge, the corner stops at it.
  pointer(handle, "pointerdown", { x: at(0.55, 0.7).x + 7, y: at(0.55, 0.7).y + 6 });
  pointer(handle, "pointermove", { x: 5000, y: 5000 });
  pointer(handle, "pointerup", { x: 5000, y: 5000 });
  expect(changes[1]).toEqual({ x: 0.1, y: 0.1, w: 0.9, h: 0.9, natural_width: 2000, natural_height: 1000 });
  for (const anchor of changes) expect(validateAnchor("image_region", anchor).ok).toBe(true);
});

test("a small pending box keeps one handle just outside its corner, and can still be moved", () => {
  const { host, img, layer, changes } = mount({ active: true });
  load(img);
  // A click: 0.02 × 0.04 of the image, an 8px square on screen.
  pointer(layer, "pointerdown", at(0.5, 0.5));
  pointer(layer, "pointerup", at(0.5, 0.5));
  const box = host.querySelector("[data-annot-pending]")!;
  expect(box.classList.contains("is-compact")).toBe(true);
  const handles = [...box.querySelectorAll("[data-handle]")];
  expect(handles.map((h) => h.getAttribute("data-handle"))).toEqual(["se"]);
  expect(handles[0]!.classList.contains("is-outside")).toBe(true);
  // Its body is still there to grab.
  pointer(box, "pointerdown", at(0.5, 0.5));
  pointer(box, "pointermove", at(0.6, 0.6));
  pointer(box, "pointerup", at(0.6, 0.6));
  expect(changes).toEqual([{ x: 0.59, y: 0.58, w: 0.02, h: 0.04, natural_width: 2000, natural_height: 1000 }]);
  // Grown past the threshold by its one handle, it gets all four back once released.
  const se = box.querySelector('[data-handle="se"]')!;
  const corner = at(0.61, 0.62);
  pointer(se, "pointerdown", corner);
  pointer(se, "pointermove", at(0.9, 0.95));
  expect(box.querySelectorAll("[data-handle]")).toHaveLength(1);
  pointer(se, "pointerup", at(0.9, 0.95));
  expect(box.classList.contains("is-compact")).toBe(false);
  expect([...box.querySelectorAll("[data-handle]")].map((h) => h.getAttribute("data-handle"))).toEqual(["nw", "ne", "sw", "se"]);
});

test("the preview's pending box stays movable and resizable with annotate mode and new picks off", () => {
  const pending: ImageRegionAnchor = { x: 0.1, y: 0.1, w: 0.4, h: 0.5, natural_width: 2000, natural_height: 1000 };
  const { host, img, changes, drafts } = mount({ pending, active: false, enabled: false });
  load(img);
  const box = host.querySelector("[data-annot-pending]")!;
  expect([...box.querySelectorAll("[data-handle]")].map((h) => h.getAttribute("data-handle"))).toEqual(["nw", "ne", "sw", "se"]);
  pointer(box, "pointerdown", at(0.2, 0.2));
  pointer(box, "pointermove", at(0.3, 0.25));
  pointer(box, "pointerup", at(0.3, 0.25));
  expect(changes).toEqual([{ x: 0.2, y: 0.15, w: 0.4, h: 0.5, natural_width: 2000, natural_height: 1000 }]);
  const nw = host.querySelector('[data-handle="nw"]')!;
  pointer(nw, "pointerdown", at(0.2, 0.15));
  pointer(nw, "pointermove", at(0.1, 0.1));
  pointer(nw, "pointerup", at(0.1, 0.1));
  expect(changes[1]).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.55, natural_width: 2000, natural_height: 1000 });
  expect(drafts).toHaveLength(0);
});

test("once the preview holds the box as pending, annotate mode can end and the crop follows later moves", async () => {
  const canvas = recordingCanvas();
  const view = mount({ active: true, canvas: canvas.factory });
  load(view.img);
  pointer(view.layer, "pointerdown", at(0.25, 0.25));
  pointer(view.layer, "pointerup", at(0.5, 0.5));
  // What the preview does on onDraft: keep the anchor as `pending`, leave annotate mode.
  view.props.pending = view.drafts[0]!.anchor;
  view.props.active = false;
  flushSync();
  const box = view.host.querySelector("[data-annot-pending]")!;
  expect(styleOf(box)).toEqual({ left: "25%", top: "25%", width: "25%", height: "25%" });
  pointer(box, "pointerdown", at(0.3, 0.3));
  pointer(box, "pointermove", at(0.55, 0.55));
  pointer(box, "pointerup", at(0.55, 0.55));
  expect(view.changes).toEqual([{ x: 0.5, y: 0.5, w: 0.25, h: 0.25, natural_width: 2000, natural_height: 1000 }]);
  view.props.pending = view.changes[0]!;
  flushSync();
  expect(styleOf(view.host.querySelector("[data-annot-pending]"))).toEqual({ left: "50%", top: "50%", width: "25%", height: "25%" });
  expect(await view.drafts[0]!.crop?.()).toEqual({ mime: "image/png", base64: "AAAA" });
  expect(canvas.drawn).toEqual([[950, 475, 600, 300, 0, 0, 600, 300]]);
  // The preview drops it: nothing is left on the image.
  view.props.pending = null;
  flushSync();
  expect(view.host.querySelector("[data-annot-pending]")).toBeNull();
});

test("a new image drops the box drawn on the old one, and the old draft's crop gives nothing", async () => {
  const canvas = recordingCanvas();
  const view = mount({ active: true, canvas: canvas.factory });
  load(view.img);
  pointer(view.layer, "pointerdown", at(0.1, 0.1));
  pointer(view.layer, "pointerup", at(0.4, 0.4));
  expect(view.host.querySelector("[data-annot-pending]")).not.toBeNull();
  view.props.src = "blob:test/other";
  flushSync();
  expect(view.img.getAttribute("src")).toBe("blob:test/other");
  expect(view.host.querySelector("[data-annot-pending]")).toBeNull();
  expect(await view.drafts[0]!.crop?.()).toBeNull();
  expect(canvas.drawn).toEqual([]);
  // Nothing can be drawn on the new image until it has loaded.
  const root = view.host.querySelector("[data-image-annotator]")!;
  expect(root.classList.contains("is-creating")).toBe(false);
  load(view.img);
  expect(root.classList.contains("is-creating")).toBe(true);
});

test("Escape with the preview's pending box cancels it outside annotate mode, and stops there", () => {
  let paneHeard = 0;
  const onWindowKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") paneHeard += 1;
  };
  window.addEventListener("keydown", onWindowKey);
  cleanups.push(() => window.removeEventListener("keydown", onWindowKey));
  const pending: ImageRegionAnchor = { x: 0.1, y: 0.1, w: 0.4, h: 0.5, natural_width: 2000, natural_height: 1000 };
  const view = mount({ pending, active: false });
  load(view.img);
  // Focus is on the page, not in the image: Escape is still the box's first.
  press(document.body, "Escape");
  expect(view.cancels()).toBe(1);
  expect(paneHeard).toBe(0);
  // Once the preview has dropped it, Escape belongs to the pane again.
  view.props.pending = null;
  flushSync();
  press(document.body, "Escape");
  expect(view.cancels()).toBe(1);
  expect(paneHeard).toBe(1);
});

test("while a box is being dragged out, Escape drops it and leaving annotate mode drops it too", () => {
  const view = mount({ active: true });
  load(view.img);
  pointer(view.layer, "pointerdown", at(0.1, 0.1));
  pointer(view.layer, "pointermove", at(0.4, 0.4));
  expect(view.host.querySelector(".img-annot-live")).not.toBeNull();
  press(document.body, "Escape");
  // Only the drag is dropped; leaving annotate mode is the next Escape's.
  expect(view.cancels()).toBe(0);
  expect(view.host.querySelector(".img-annot-live")).toBeNull();
  pointer(view.layer, "pointerup", at(0.4, 0.4));
  expect(view.drafts).toHaveLength(0);
  // Mode switched off mid-drag.
  pointer(view.layer, "pointerdown", at(0.1, 0.1));
  pointer(view.layer, "pointermove", at(0.4, 0.4));
  view.props.active = false;
  flushSync();
  pointer(view.layer, "pointerup", at(0.4, 0.4));
  expect(view.drafts).toHaveLength(0);
  expect(view.host.querySelector(".img-annot-live")).toBeNull();
});

/** A ResizeObserver the test fires by hand: happy-dom's never reports a size. */
function fakeResizeObserver(): { fire: () => void; restore: () => void } {
  const g = globalThis as unknown as { ResizeObserver: unknown };
  const saved = g.ResizeObserver;
  const callbacks = new Set<() => void>();
  g.ResizeObserver = class {
    private readonly cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
    }
    observe(): void {
      callbacks.add(this.cb);
    }
    unobserve(): void {}
    disconnect(): void {
      callbacks.delete(this.cb);
    }
  };
  return {
    fire: () => {
      for (const cb of callbacks) cb();
      flushSync();
    },
    restore: () => {
      g.ResizeObserver = saved;
    },
  };
}

function drawAt(img: HTMLImageElement, rect: { left: number; top: number; width: number; height: number }): void {
  img.getBoundingClientRect = () =>
    ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => ({}) }) as DOMRect;
}

test("the layer follows the image when the pane resizes, and a drag on it gives the same anchor", () => {
  const ro = fakeResizeObserver();
  cleanups.push(ro.restore);
  const view = mount({ active: true, annotations: [row({ id: "o" })] });
  load(view.img);
  expect(styleOf(view.layer)).toEqual({ left: "100px", top: "50px", width: "400px", height: "200px" });
  // The pane narrows: the image is drawn at half the size, further left.
  const small = { left: 40, top: 20, width: 200, height: 100 };
  drawAt(view.img, small);
  ro.fire();
  expect(styleOf(view.layer)).toEqual({ left: "40px", top: "20px", width: "200px", height: "100px" });
  // The box itself is in percent of the layer, so it did not have to move.
  expect(styleOf(view.host.querySelector('[data-annotation-id="o"]'))).toEqual({ left: "10%", top: "20%", width: "30%", height: "40%" });
  const p = (x: number, y: number) => ({ x: small.left + x * small.width, y: small.top + y * small.height });
  pointer(view.layer, "pointerdown", p(0.1, 0.1));
  pointer(view.layer, "pointermove", p(0.4, 0.5));
  pointer(view.layer, "pointerup", p(0.4, 0.5));
  expect(view.drafts.map((d) => d.anchor)).toEqual([{ x: 0.1, y: 0.1, w: 0.3, h: 0.4, natural_width: 2000, natural_height: 1000 }]);
});

test("an SVG that loaded before it was laid out is measured in the shape it is drawn in", () => {
  const ro = fakeResizeObserver();
  cleanups.push(ro.restore);
  const view = mount({ active: true, isSvg: true });
  // The browser's made-up 300×150 for a size-less SVG, reported while the pane was still hidden.
  drawAt(view.img, { left: 0, top: 0, width: 0, height: 0 });
  Object.defineProperty(view.img, "naturalWidth", { value: 300, configurable: true });
  Object.defineProperty(view.img, "naturalHeight", { value: 150, configurable: true });
  view.img.dispatchEvent(new Event("load"));
  flushSync();
  // Nothing to aim at yet.
  expect(view.layer.classList.contains("is-unmeasured")).toBe(true);
  // Laid out square: 300×150 is not its shape, so it is 1024 on the long side in the drawn shape.
  drawAt(view.img, { left: 0, top: 0, width: 400, height: 400 });
  ro.fire();
  expect(view.layer.classList.contains("is-unmeasured")).toBe(false);
  pointer(view.layer, "pointerdown", { x: 200, y: 200 });
  pointer(view.layer, "pointerup", { x: 200, y: 200 });
  const anchor = view.drafts[0]!.anchor;
  expect([anchor.natural_width, anchor.natural_height]).toEqual([1024, 1024]);
  // A click is square on a square image.
  expect(anchor.w).toBeCloseTo(anchor.h, 9);
  expect(validateAnchor("image_region", anchor).ok).toBe(true);
});

test("Escape's listener is attached once while engaged, not again on every move of a drag", () => {
  const pending: ImageRegionAnchor = { x: 0.1, y: 0.1, w: 0.2, h: 0.2, natural_width: 2000, natural_height: 1000 };
  const view = mount({ pending });
  load(view.img);
  const added: string[] = [];
  const removed: string[] = [];
  const add = document.addEventListener;
  const remove = document.removeEventListener;
  document.addEventListener = function (this: Document, type: string, ...rest: unknown[]) {
    added.push(type);
    return (add as (...args: unknown[]) => void).call(this, type, ...rest);
  } as typeof document.addEventListener;
  document.removeEventListener = function (this: Document, type: string, ...rest: unknown[]) {
    removed.push(type);
    return (remove as (...args: unknown[]) => void).call(this, type, ...rest);
  } as typeof document.removeEventListener;
  try {
    const box = view.host.querySelector("[data-annot-pending]")!;
    pointer(box, "pointerdown", at(0.2, 0.2));
    for (let i = 1; i <= 8; i += 1) pointer(box, "pointermove", at(0.2 + i * 0.01, 0.2 + i * 0.01));
    pointer(box, "pointerup", at(0.28, 0.28));
  } finally {
    document.addEventListener = add;
    document.removeEventListener = remove;
  }
  expect(view.changes).toHaveLength(1);
  expect(added.filter((t) => t === "keydown")).toEqual([]);
  expect(removed.filter((t) => t === "keydown")).toEqual([]);
});

test("a broken or not yet loaded image keeps its boxes out of sight", () => {
  const { host, img } = mount({ annotations: [row({ id: "o" })] });
  // Laid out (alt text, a broken-image icon) but never loaded.
  drawAt(img, { left: 0, top: 0, width: 16, height: 16 });
  const layer = host.querySelector("[data-annot-layer]")!;
  expect(layer.classList.contains("is-unmeasured")).toBe(true);
  load(img);
  expect(layer.classList.contains("is-unmeasured")).toBe(false);
});

test("a mark focused, let go and focused again flashes again", () => {
  const view = mount({ annotations: [row({ id: "o" }), row({ id: "r", status: "resolved" })] });
  load(view.img);
  const r = () => view.host.querySelector('[data-annotation-id="r"]')!;
  view.props.focusId = "r";
  flushSync();
  expect(r().classList.contains("is-flash")).toBe(true);
  // The list lets go before the flash has run out.
  view.props.focusId = null;
  flushSync();
  expect(r().classList.contains("is-flash")).toBe(false);
  view.props.focusId = "r";
  flushSync();
  expect(r().classList.contains("is-flash")).toBe(true);
});

test("asking again for the mark that already has focus scrolls to it and flashes it again", async () => {
  const scrolled: string[] = [];
  const proto = Element.prototype as { scrollIntoView?: (arg?: unknown) => void };
  const original = proto.scrollIntoView;
  proto.scrollIntoView = function (this: Element) {
    const id = (this as HTMLElement).dataset?.annotationId;
    if (id) scrolled.push(id);
  };
  cleanups.push(() => {
    proto.scrollIntoView = original;
  });
  const view = mount({ annotations: [row({ id: "o" }), row({ id: "r", status: "resolved" })] });
  load(view.img);
  const r = () => view.host.querySelector('[data-annotation-id="r"]')!;
  view.props.focusId = "r";
  flushSync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scrolled).toEqual(["r"]);
  // The flash has run its course and the person has scrolled away; the list asks for it again.
  await new Promise((resolve) => setTimeout(resolve, 1450));
  expect(r().classList.contains("is-flash")).toBe(false);
  view.props.focusSeq += 1;
  flushSync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scrolled).toEqual(["r", "r"]);
  expect(r().classList.contains("is-flash")).toBe(true);
});
