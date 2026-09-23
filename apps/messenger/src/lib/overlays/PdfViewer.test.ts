/**
 * The PDF viewer mounted in happy-dom with the pdf.js loader module replaced by a fake document:
 * page placeholders sized from each page, the zoom controls, the page-number jump, the password and
 * broken-file states, find with highlights in the text layer, and the annotation surface (a drag or
 * a click in annotate mode handing over a valid anchor with its quote, numbered marks, the pending
 * box moving, Escape used before the pane hears it). happy-dom has no layout, so rects are stubbed.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { flushSync } from "svelte";
import { validateAnchor, type Annotation, type PdfRegionAnchor } from "@real-bot/protocol";
import { buttonByText, click, fill, press, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import type { PdfDocument, PdfOpenHooks, PdfPage } from "./pdfjs.ts";
import type { TextRun } from "../annotations/pdf-region.ts";

class FakeOpenError extends Error {
  constructor(readonly kind: "broken" | "failed" | "cancelled") {
    super(kind);
  }
}

type Opener = (data: Blob, hooks: PdfOpenHooks) => { promise: Promise<PdfDocument>; cancel: () => void };
let opener: Opener = () => ({ promise: new Promise<PdfDocument>(() => {}), cancel() {} });

mock.module("./pdfjs.ts", () => ({
  openPdf: (data: Blob, hooks: PdfOpenHooks) => opener(data, hooks),
  PdfOpenError: FakeOpenError,
  loadPdfJs: () => Promise.reject(new Error("pdf.js is not loaded in tests")),
}));

const { default: PdfViewer } = await import("./PdfViewer.svelte");
type Labels = import("./PdfViewer.svelte").PdfViewerLabels;
type Draft = import("./PdfViewer.svelte").PdfRegionDraft;

const labels: Labels = {
  loading: "正在打开 PDF…",
  failed: "没能打开这个 PDF。",
  broken: "这个 PDF 已损坏，打不开。",
  password: "这个 PDF 设了密码，输入密码后打开。",
  passwordWrong: "密码不对，再试一次。",
  passwordField: "密码",
  passwordOpen: "打开",
  zoomIn: "放大",
  zoomOut: "缩小",
  zoom: "缩放",
  fitWidth: "适合宽度",
  fitPage: "适合页面",
  pageNumber: "页码",
  pageCount: (total) => `/ ${total} 页`,
  find: "查找",
  findPlaceholder: "在 PDF 里查找",
  findPrev: "上一个",
  findNext: "下一个",
  findClose: "关闭查找",
  findCount: (current, total) => `${current}/${total}`,
  findNone: "没有找到",
  findSearching: "查找中…",
  goTo: "跳到链接的位置",
  region: "在页面上拖出一个框，或点一下",
  mark: (n, remark) => `批注 ${n}：${remark}`,
  pending: "拖动可挪位置",
  resize: "拖动改大小",
  stale: "文件已变，位置可能不准",
};

/** "Hello world" across the top of every page, the second line under it. */
const RUNS: TextRun[] = [
  { text: "Hello world", rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.03 }, eol: true },
  { text: "Second line", rect: { x: 0.1, y: 0.5, w: 0.3, h: 0.03 }, eol: false },
];

const rendered: number[] = [];

function fakePage(n: number, width = 600, height = 800): PdfPage {
  return {
    number: n,
    size: { width, height, userUnit: 1 },
    render: () => {
      rendered.push(n);
      return { promise: Promise.resolve(), cancel() {} };
    },
    renderText: (container) => {
      const spans = RUNS.map((r) => {
        const span = document.createElement("span");
        span.textContent = r.text;
        container.append(span);
        return span;
      });
      return { promise: Promise.resolve(), cancel() {}, divs: () => spans, update() {} };
    },
    textItems: async () => RUNS.map((r) => ({ str: r.text, eol: r.eol === true })),
    textRuns: async () => RUNS,
    links: async () => [],
    snapshot: async () => null,
    release() {},
  };
}

function fakeDoc(sizes: Array<[number, number]>): PdfDocument {
  const pages = sizes.map(([w, h], i) => fakePage(i + 1, w, h));
  return {
    numPages: pages.length,
    page: async (n) => {
      const page = pages[n - 1];
      if (!page) throw new Error(`no page ${n}`);
      return page;
    },
    destinationPage: async () => null,
    destroy() {},
  };
}

const opens = (doc: PdfDocument): Opener => () => ({ promise: Promise.resolve(doc), cancel() {} });

/** Let the fake document's promises and the viewer's effects settle. */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
  }
}

function row(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    status: "open",
    relpath: "out/report.pdf",
    anchor_kind: "pdf_region",
    anchor: { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "s1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "s1",
    message_id: "m2",
    body: "这一段数据对不上",
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
  opener = () => ({ promise: new Promise<PdfDocument>(() => {}), cancel() {} });
  rendered.length = 0;
});

type Over = Partial<{
  annotations: Annotation[];
  focusId: string | null;
  focusSeq: number;
  active: boolean;
  enabled: boolean;
  pending: PdfRegionAnchor | null;
  onCancel: (() => void) | undefined;
}>;

function mount(over: Over = {}) {
  const drafts: Draft[] = [];
  const picks: string[] = [];
  const changes: PdfRegionAnchor[] = [];
  let cancels = 0;
  const props = reactive({
    data: new Blob(["%PDF-1.7"], { type: "application/pdf" }),
    theme: "light" as "light" | "dark",
    labels,
    annotations: over.annotations ?? [],
    focusId: over.focusId ?? null,
    focusSeq: over.focusSeq ?? 0,
    active: over.active ?? false,
    enabled: over.enabled ?? true,
    pending: over.pending ?? null,
    onDraft: (draft: Draft) => drafts.push(draft),
    onPick: (id: string) => picks.push(id),
    onPendingChange: (anchor: PdfRegionAnchor) => changes.push(anchor),
    onCancel: "onCancel" in over ? over.onCancel : () => (cancels += 1),
  });
  const view = render(PdfViewer as never, props as never);
  cleanups.push(view.close);
  return { host: view.host, props, drafts, picks, changes, cancels: () => cancels };
}

function pages(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".pdf-page")];
}

/** Pin an element's on-screen rect: happy-dom lays nothing out. */
function stubRect(el: Element, rect: { left: number; top: number; width: number; height: number }): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON() {} }),
  });
}

/**
 * Escapes that reach the element above the mount point: what the preview pane would hear. (Svelte
 * delegates `onkeydown` to the mount point itself, so a listener there fires regardless.)
 */
function listenAbove(host: HTMLElement): { heard: () => number } {
  let heard = 0;
  const parent = host.parentElement!;
  const listener = (ev: Event) => {
    if ((ev as KeyboardEvent).key === "Escape") heard += 1;
  };
  parent.addEventListener("keydown", listener);
  cleanups.push(() => parent.removeEventListener("keydown", listener));
  return { heard: () => heard };
}

function pointer(el: Element, type: string, x: number, y: number, init: PointerEventInit = {}): void {
  el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, button: 0, bubbles: true, cancelable: true, ...init }));
  flushSync();
}

test("pages get placeholders sized from each page, with the page count", async () => {
  opener = opens(fakeDoc([[600, 800], [600, 800], [800, 600]]));
  const { host } = mount();
  expect(host.querySelector(".pdf-status")?.textContent).toBe(labels.loading);
  await settle();
  const list = pages(host);
  expect(list).toHaveLength(3);
  expect(list.map((p) => [p.style.width, p.style.height])).toEqual([
    ["600px", "800px"],
    ["600px", "800px"],
    ["800px", "600px"],
  ]);
  expect(host.querySelector(".pdf-page-total")?.textContent).toBe("/ 3 页");
  expect((host.querySelector("[data-pdf-page-input]") as HTMLInputElement).value).toBe("1");
  // With no IntersectionObserver report yet, the pages around the first one are drawn.
  expect(rendered.sort()).toEqual([1, 2, 3]);
  expect(host.querySelectorAll(".pdf-canvas canvas")).toHaveLength(3);
});

test("the zoom buttons step the zoom and the menu picks one; placeholders follow", async () => {
  opener = opens(fakeDoc([[600, 800], [600, 800]]));
  const { host } = mount();
  await settle();
  const select = host.querySelector<HTMLSelectElement>("[data-pdf-zoom]")!;
  expect(select.value).toBe("fit-width");
  click(host.querySelector("[data-pdf-zoom-in]"));
  expect(pages(host)[0]!.style.width).toBe("660px");
  expect(select.value).toBe("1.1");
  click(host.querySelector("[data-pdf-zoom-out]"));
  click(host.querySelector("[data-pdf-zoom-out]"));
  expect(pages(host)[0]!.style.width).toBe("540px");
  select.value = "2";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
  expect(pages(host)[1]!.style.height).toBe("1600px");
  // ⌘0 goes back to fitting the width (100% while happy-dom reports no width).
  press(host.querySelector("[data-pdf-scroll]"), "0", { metaKey: true });
  expect(select.value).toBe("fit-width");
  expect(pages(host)[0]!.style.width).toBe("600px");
  press(host.querySelector("[data-pdf-scroll]"), "=", { ctrlKey: true });
  expect(pages(host)[0]!.style.width).toBe("660px");
});

test("typing a page number jumps to it; nonsense puts the current one back", async () => {
  opener = opens(fakeDoc([[600, 800], [600, 800], [600, 800], [600, 800]]));
  const { host } = mount();
  await settle();
  const input = host.querySelector<HTMLInputElement>("[data-pdf-page-input]")!;
  const scroller = host.querySelector<HTMLElement>("[data-pdf-scroll]")!;
  fill(input, "3");
  press(input, "Enter");
  // Page 3's top (12 + 2 × (800 + 12)) just under the viewport's top edge.
  expect(scroller.scrollTop).toBe(12 + 2 * 812 - 12);
  expect(input.value).toBe("3");
  fill(input, "99");
  press(input, "Enter");
  expect(scroller.scrollTop).toBe(12 + 3 * 812 - 12);
  expect(input.value).toBe("4");
  fill(input, "abc");
  press(input, "Enter");
  expect(input.value).toBe("4");
});

test("an encrypted PDF asks for its password, says when it is wrong, and opens with the right one", async () => {
  const doc = fakeDoc([[600, 800]]);
  let hooks: PdfOpenHooks | null = null;
  let resolve: (value: PdfDocument) => void = () => {};
  const tried: string[] = [];
  opener = (_data, h) => {
    hooks = h;
    queueMicrotask(() =>
      h.onPassword((pw) => {
        tried.push(pw);
        if (pw === "right") resolve(doc);
        else h.onPassword(() => {}, true);
      }, false),
    );
    return { promise: new Promise<PdfDocument>((r) => (resolve = r)), cancel() {} };
  };
  const { host } = mount();
  await settle();
  expect(hooks).not.toBeNull();
  const form = host.querySelector("[data-pdf-password]")!;
  expect(form.querySelector(".pdf-status")?.textContent).toBe(labels.password);
  const field = form.querySelector<HTMLInputElement>('input[type="password"]')!;
  fill(field, "wrong");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  expect(tried).toEqual(["wrong"]);
  expect(host.querySelector("[data-pdf-password] .pdf-status")?.textContent).toBe(labels.passwordWrong);
  expect(host.querySelector("[data-pdf-password] .pdf-status")?.classList.contains("is-error")).toBe(true);
});

test("the right password opens the document", async () => {
  const doc = fakeDoc([[600, 800], [600, 800]]);
  opener = (_data, h) => {
    let resolve: (value: PdfDocument) => void = () => {};
    queueMicrotask(() => h.onPassword((pw) => (pw === "right" ? resolve(doc) : undefined), false));
    return { promise: new Promise<PdfDocument>((r) => (resolve = r)), cancel() {} };
  };
  const { host } = mount();
  await settle();
  const form = host.querySelector("[data-pdf-password]")!;
  fill(form.querySelector('input[type="password"]'), "right");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  expect(host.querySelector("[data-pdf-password]")).toBeNull();
  expect(pages(host)).toHaveLength(2);
});

test("a broken PDF and a failed load each say so", async () => {
  opener = () => ({ promise: Promise.reject(new FakeOpenError("broken")), cancel() {} });
  const broken = mount();
  await settle();
  expect(broken.host.querySelector("[data-pdf-error]")?.textContent).toBe(labels.broken);
  opener = () => ({ promise: Promise.reject(new Error("worker died")), cancel() {} });
  const failed = mount();
  await settle();
  expect(failed.host.querySelector("[data-pdf-error]")?.textContent).toBe(labels.failed);
});

test("find (⌘F) counts matches across pages, highlights them in the text layer, and Escape closes it first", async () => {
  opener = opens(fakeDoc([[600, 800], [600, 800], [600, 800]]));
  const { host } = mount();
  await settle();
  const scroller = host.querySelector<HTMLElement>("[data-pdf-scroll]")!;
  press(scroller, "f", { metaKey: true });
  await settle(2);
  const input = host.querySelector<HTMLInputElement>("[data-pdf-find-input]")!;
  expect(input).not.toBeNull();
  fill(input, "WORLD");
  // While the typing settles it says "searching", never a premature "no match".
  expect(host.querySelector(".pdf-find-count")?.textContent).toBe(labels.findSearching);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await settle();
  expect(host.querySelector(".pdf-find-count")?.textContent).toBe("1/3");
  expect(host.querySelectorAll(".pdf-hl")).toHaveLength(3);
  expect(host.querySelectorAll(".pdf-hl.is-selected")).toHaveLength(1);
  expect(host.querySelector('.pdf-page[data-page="1"] .pdf-hl.is-selected')?.textContent).toBe("world");
  press(input, "Enter");
  await settle();
  expect(host.querySelector(".pdf-find-count")?.textContent).toBe("2/3");
  expect(host.querySelector('.pdf-page[data-page="2"] .pdf-hl.is-selected')).not.toBeNull();
  press(input, "Enter", { shiftKey: true });
  press(input, "Enter", { shiftKey: true });
  await settle();
  expect(host.querySelector(".pdf-find-count")?.textContent).toBe("3/3");
  // Escape closes find and stops there: the pane around the viewer never hears it.
  const pane = listenAbove(host);
  press(input, "Escape");
  await settle(2);
  expect(host.querySelector("[data-pdf-find-input]")).toBeNull();
  expect(host.querySelectorAll(".pdf-hl")).toHaveLength(0);
  expect(host.querySelector('.pdf-page[data-page="1"] .pdf-text span')?.textContent).toBe("Hello world");
  expect(pane.heard()).toBe(0);
  // Nothing left to close: Escape goes on to the pane.
  press(scroller, "Escape");
  expect(pane.heard()).toBe(1);
});

test("a drag in annotate mode hands over a valid anchor with the text under the box as its quote", async () => {
  opener = opens(fakeDoc([[600, 800], [600, 800]]));
  const { host, drafts } = mount({ active: true });
  await settle();
  const overlay = host.querySelector('.pdf-marks[data-page="2"]')!;
  expect(overlay.classList.contains("is-active")).toBe(true);
  expect(overlay.getAttribute("title")).toBe(labels.region);
  stubRect(overlay, { left: 100, top: 50, width: 600, height: 800 });
  pointer(overlay, "pointerdown", 100 + 0.05 * 600, 50 + 0.08 * 800);
  pointer(overlay, "pointermove", 100 + 0.3 * 600, 50 + 0.12 * 800);
  expect(host.querySelector(".pdf-mark.is-drawing")).not.toBeNull();
  pointer(overlay, "pointermove", 100 + 0.45 * 600, 50 + 0.2 * 800);
  pointer(overlay, "pointerup", 100 + 0.45 * 600, 50 + 0.2 * 800);
  await settle();
  expect(host.querySelector(".pdf-mark.is-drawing")).toBeNull();
  expect(drafts).toHaveLength(1);
  const { anchor, crop } = drafts[0]!;
  expect(anchor.page).toBe(2);
  expect(anchor.x).toBeCloseTo(0.05);
  expect(anchor.y).toBeCloseTo(0.08);
  expect(anchor.w).toBeCloseTo(0.4);
  expect(anchor.h).toBeCloseTo(0.12);
  expect(anchor.quote).toBe("Hello world");
  expect(validateAnchor("pdf_region", anchor)).toEqual({ ok: true, anchor });
  // happy-dom cannot draw a page, so the crop comes back empty rather than failing.
  expect(await crop!()).toBeNull();
});

test("a click makes a small square box; outside annotate mode, or when disabled, nothing is made", async () => {
  opener = opens(fakeDoc([[600, 800]]));
  const first = mount({ active: true });
  await settle();
  const overlay = first.host.querySelector('.pdf-marks[data-page="1"]')!;
  stubRect(overlay, { left: 0, top: 0, width: 600, height: 800 });
  pointer(overlay, "pointerdown", 300, 400);
  pointer(overlay, "pointerup", 301, 401);
  await settle();
  expect(first.drafts).toHaveLength(1);
  const a = first.drafts[0]!.anchor;
  // 4% of the short side (600 × 0.04 = 24px) on both axes.
  expect(a.w * 600).toBeCloseTo(24);
  expect(a.h * 800).toBeCloseTo(24);
  expect(a.x + a.w / 2).toBeCloseTo(0.5);
  expect(validateAnchor("pdf_region", a).ok).toBe(true);
  expect(a.quote).toBeUndefined();
  first.props.active = false;
  flushSync();
  expect(overlay.classList.contains("is-active")).toBe(false);
  pointer(overlay, "pointerdown", 10, 10);
  pointer(overlay, "pointerup", 200, 200);
  first.props.active = true;
  first.props.enabled = false;
  flushSync();
  pointer(overlay, "pointerdown", 10, 10);
  pointer(overlay, "pointerup", 200, 200);
  await settle();
  expect(first.drafts).toHaveLength(1);
});

test("existing rows are numbered boxes with their status; stale is dashed; gone files and pages are not drawn", async () => {
  opener = opens(fakeDoc([[600, 800], [600, 800]]));
  const annotations = [
    row({ id: "open" }),
    row({ id: "draft", status: "draft", message_id: null, anchor: { page: 2, x: 0.5, y: 0.5, w: 0.2, h: 0.1 } }),
    row({ id: "gone", stale: { kind: "missing" } }),
    row({ id: "far", anchor: { page: 7, x: 0.1, y: 0.1, w: 0.1, h: 0.1 } }),
    row({ id: "old", status: "resolved", stale: { kind: "changed" } }),
  ];
  const { host, picks } = mount({ annotations });
  await settle();
  const marks = [...host.querySelectorAll<HTMLElement>(".pdf-mark[data-annotation-id]")];
  expect(marks.map((m) => [m.dataset.annotationId, m.closest(".pdf-page")?.getAttribute("data-page"), m.textContent?.trim()])).toEqual([
    ["open", "1", "1"],
    ["old", "1", "5"],
    ["draft", "2", "2"],
  ]);
  expect(marks[0]!.classList.contains("is-open")).toBe(true);
  expect(marks[1]!.classList.contains("is-resolved")).toBe(true);
  expect(marks[1]!.classList.contains("is-stale")).toBe(true);
  expect(marks[2]!.classList.contains("is-draft")).toBe(true);
  expect(marks[0]!.style.left).toBe("10.000%");
  expect(marks[0]!.style.top).toBe("20.000%");
  const badge = marks[0]!.querySelector("button")!;
  expect(badge.getAttribute("title")).toBe("这一段数据对不上");
  expect(badge.getAttribute("aria-label")).toBe("批注 1：这一段数据对不上");
  expect(marks[1]!.querySelector("button")!.getAttribute("title")).toBe(`这一段数据对不上\n${labels.stale}`);
  click(badge);
  expect(picks).toEqual(["open"]);
});

test("focusing a row scrolls its page into view and flashes its box", async () => {
  opener = opens(fakeDoc([[600, 800], [600, 800], [600, 800]]));
  const annotations = [row({ id: "p3", anchor: { page: 3, x: 0.1, y: 0.5, w: 0.2, h: 0.1 } })];
  const { host, props } = mount({ annotations });
  await settle();
  const scroller = host.querySelector<HTMLElement>("[data-pdf-scroll]")!;
  expect(scroller.scrollTop).toBe(0);
  props.focusId = "p3";
  flushSync();
  await settle(2);
  // Half-way down page 3 (top 12 + 2 × 812), a third of the (unmeasured, 0px) viewport.
  expect(scroller.scrollTop).toBe(12 + 2 * 812 + 0.5 * 800);
  expect(host.querySelector('.pdf-mark[data-annotation-id="p3"]')?.classList.contains("is-flash")).toBe(true);
});

test("the pending box has handles, moves and resizes, and reports the new anchor with its quote", async () => {
  opener = opens(fakeDoc([[600, 800]]));
  const pending: PdfRegionAnchor = { page: 1, x: 0.4, y: 0.4, w: 0.2, h: 0.05 };
  const { host, changes } = mount({ active: true, pending });
  await settle();
  const overlay = host.querySelector('.pdf-marks[data-page="1"]')!;
  // A box is waiting for its remark: no new drawing.
  expect(overlay.classList.contains("is-active")).toBe(false);
  stubRect(overlay, { left: 0, top: 0, width: 600, height: 800 });
  const box = host.querySelector<HTMLElement>("[data-pdf-pending]")!;
  expect(box.querySelectorAll(".pdf-handle")).toHaveLength(4);
  // Drag it up onto the first line: from (0.5, 0.42) to (0.2, 0.1).
  pointer(box, "pointerdown", 300, 336);
  pointer(overlay, "pointermove", 120, 80);
  expect(box.style.left).toBe("10.000%");
  pointer(overlay, "pointerup", 120, 80);
  await settle();
  expect(changes).toHaveLength(1);
  expect(changes[0]!.x).toBeCloseTo(0.1);
  expect(changes[0]!.y).toBeCloseTo(0.08);
  // The box covers the first two thirds of the line's width, so two thirds of its characters.
  expect(changes[0]!.quote).toBe("Hello w");
  // Shrink it from its bottom-right corner.
  const se = host.querySelector("[data-pdf-pending] .pdf-handle.is-se")!;
  pointer(se, "pointerdown", 180, 104);
  pointer(overlay, "pointermove", 90, 90);
  pointer(overlay, "pointerup", 90, 90);
  await settle();
  expect(changes).toHaveLength(2);
  expect(changes[1]!.w).toBeCloseTo(0.05);
  expect(validateAnchor("pdf_region", changes[1]).ok).toBe(true);
  // Arrow keys nudge it.
  press(host.querySelector("[data-pdf-pending]"), "ArrowRight");
  await settle();
  expect(changes).toHaveLength(3);
  expect(changes[2]!.x).toBeCloseTo(0.11);
});

test("Escape with a box pending, or while choosing, cancels it before the pane hears it", async () => {
  opener = opens(fakeDoc([[600, 800]]));
  const { host, props, cancels } = mount({ active: true, pending: { page: 1, x: 0.1, y: 0.1, w: 0.1, h: 0.1 } });
  await settle();
  const pane = listenAbove(host);
  press(host.querySelector("[data-pdf-scroll]"), "Escape");
  expect(cancels()).toBe(1);
  expect(pane.heard()).toBe(0);
  props.pending = null;
  flushSync();
  press(host.querySelector("[data-pdf-scroll]"), "Escape");
  expect(cancels()).toBe(2);
  expect(pane.heard()).toBe(0);
  props.active = false;
  flushSync();
  press(host.querySelector("[data-pdf-scroll]"), "Escape");
  expect(cancels()).toBe(2);
  expect(pane.heard()).toBe(1);
});

test("a drag in progress is dropped by Escape without making anything", async () => {
  opener = opens(fakeDoc([[600, 800]]));
  const { host, drafts, cancels } = mount({ active: true });
  await settle();
  const overlay = host.querySelector('.pdf-marks[data-page="1"]')!;
  stubRect(overlay, { left: 0, top: 0, width: 600, height: 800 });
  pointer(overlay, "pointerdown", 10, 10);
  pointer(overlay, "pointermove", 200, 200);
  press(host.querySelector("[data-pdf-scroll]"), "Escape");
  expect(host.querySelector(".pdf-mark.is-drawing")).toBeNull();
  pointer(overlay, "pointerup", 200, 200);
  await settle();
  expect(drafts).toHaveLength(0);
  expect(cancels()).toBe(0);
});

/** Escapes that reach the window: what the shell's pane-closing listener would hear. */
function listenWindow(): { heard: () => number } {
  let heard = 0;
  const listener = (ev: Event) => {
    if ((ev as KeyboardEvent).key === "Escape") heard += 1;
  };
  window.addEventListener("keydown", listener);
  cleanups.push(() => window.removeEventListener("keydown", listener));
  return { heard: () => heard };
}

test("Escape while choosing is caught even with focus outside the viewer; otherwise it goes on", async () => {
  opener = opens(fakeDoc([[600, 800]]));
  const { props, cancels } = mount({ active: true });
  await settle();
  const shell = listenWindow();
  // Focus on the preview's own controls (here: nowhere in particular) — the document hears it.
  press(document.body, "Escape");
  expect(cancels()).toBe(1);
  expect(shell.heard()).toBe(0);
  props.active = false;
  flushSync();
  press(document.body, "Escape");
  expect(cancels()).toBe(1);
  expect(shell.heard()).toBe(1);
  // A box waiting for its remark engages it too, annotate mode or not.
  props.pending = { page: 1, x: 0.1, y: 0.1, w: 0.1, h: 0.1 };
  flushSync();
  press(document.body, "Escape");
  expect(cancels()).toBe(2);
  expect(shell.heard()).toBe(1);
});

test("a drag released outside the page still ends, and follows the page if it scrolls meanwhile", async () => {
  opener = opens(fakeDoc([[600, 800]]));
  const { host, drafts } = mount({ active: true });
  await settle();
  const overlay = host.querySelector('.pdf-marks[data-page="1"]')!;
  stubRect(overlay, { left: 0, top: 0, width: 600, height: 800 });
  pointer(overlay, "pointerdown", 60, 80);
  // The page scrolls up by 100px under a still pointer, then the pointer leaves the viewer.
  stubRect(overlay, { left: 0, top: -100, width: 600, height: 800 });
  pointer(document.body, "pointermove", 300, 200);
  expect(host.querySelector<HTMLElement>(".pdf-mark.is-drawing")?.style.top).toBe("10.000%");
  pointer(document.body, "pointerup", 300, 200);
  await settle();
  expect(host.querySelector(".pdf-mark.is-drawing")).toBeNull();
  expect(drafts).toHaveLength(1);
  const a = drafts[0]!.anchor;
  expect([a.x, a.y, a.w, a.h].map((v) => Number(v.toFixed(4)))).toEqual([0.1, 0.1, 0.4, 0.275]);
  expect(validateAnchor("pdf_region", a).ok).toBe(true);
  // Nothing is left listening: a later stray release makes nothing.
  pointer(document.body, "pointerup", 10, 10);
  await settle();
  expect(drafts).toHaveLength(1);
});

test("turning annotate mode off mid-drag hands nothing over", async () => {
  opener = opens(fakeDoc([[600, 800]]));
  const { host, props, drafts } = mount({ active: true });
  await settle();
  const overlay = host.querySelector('.pdf-marks[data-page="1"]')!;
  stubRect(overlay, { left: 0, top: 0, width: 600, height: 800 });
  pointer(overlay, "pointerdown", 10, 10);
  pointer(overlay, "pointermove", 200, 200);
  props.active = false;
  flushSync();
  pointer(overlay, "pointerup", 200, 200);
  await settle();
  expect(drafts).toHaveLength(0);
});

test("pressing a handle without moving leaves the box; a handle grabbed off its corner does not jump", async () => {
  opener = opens(fakeDoc([[600, 800]]));
  const pending: PdfRegionAnchor = { page: 1, x: 0.4, y: 0.4, w: 0.2, h: 0.1 };
  const { host, changes } = mount({ active: true, pending });
  await settle();
  stubRect(host.querySelector('.pdf-marks[data-page="1"]')!, { left: 0, top: 0, width: 600, height: 800 });
  const se = () => host.querySelector("[data-pdf-pending] .pdf-handle.is-se")!;
  // The corner is at (360, 400); the press lands 6px right of and below it, on the handle.
  pointer(se(), "pointerdown", 366, 406);
  pointer(se(), "pointerup", 367, 406);
  await settle();
  expect(changes).toHaveLength(0);
  pointer(se(), "pointerdown", 366, 406);
  pointer(document.body, "pointermove", 426, 486);
  pointer(document.body, "pointerup", 426, 486);
  await settle();
  expect(changes).toHaveLength(1);
  // Moved by exactly the pointer's 60 × 80px, not by the 6px it was grabbed off the corner.
  expect(changes[0]!.w * 600).toBeCloseTo(120 + 60);
  expect(changes[0]!.h * 800).toBeCloseTo(80 + 80);
  expect(changes[0]!.x).toBeCloseTo(0.4);
});

test("a focus that arrives before its row scrolls once the row does", async () => {
  opener = opens(fakeDoc([[600, 800], [600, 800], [600, 800]]));
  const { host, props } = mount({ focusId: "late" });
  await settle();
  const scroller = host.querySelector<HTMLElement>("[data-pdf-scroll]")!;
  expect(scroller.scrollTop).toBe(0);
  props.annotations = [row({ id: "late", anchor: { page: 2, x: 0.1, y: 0.25, w: 0.2, h: 0.1 } })];
  flushSync();
  await settle(2);
  expect(scroller.scrollTop).toBe(12 + 812 + 0.25 * 800);
  expect((host.querySelector("[data-pdf-page-input]") as HTMLInputElement).value).toBe("2");
  expect(host.querySelector('.pdf-mark[data-annotation-id="late"]')?.classList.contains("is-flash")).toBe(true);
});

test("reopening find searches the last query again instead of saying nothing matches", async () => {
  opener = opens(fakeDoc([[600, 800], [600, 800]]));
  const { host } = mount();
  await settle();
  const scroller = host.querySelector<HTMLElement>("[data-pdf-scroll]")!;
  press(scroller, "f", { ctrlKey: true });
  await settle(2);
  fill(host.querySelector("[data-pdf-find-input]"), "second");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await settle();
  expect(host.querySelector(".pdf-find-count")?.textContent).toBe("1/2");
  press(host.querySelector("[data-pdf-find-input]"), "Escape");
  await settle(2);
  expect(host.querySelectorAll(".pdf-hl")).toHaveLength(0);
  press(scroller, "f", { ctrlKey: true });
  await settle(2);
  expect((host.querySelector("[data-pdf-find-input]") as HTMLInputElement).value).toBe("second");
  expect(host.querySelector(".pdf-find-count")?.textContent).not.toBe(labels.findNone);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await settle();
  expect(host.querySelector(".pdf-find-count")?.textContent).toBe("1/2");
  expect(host.querySelectorAll(".pdf-hl")).toHaveLength(2);
});

test("a new file closes the find bar and draws its own pages", async () => {
  opener = opens(fakeDoc([[600, 800], [600, 800]]));
  const { host, props } = mount();
  await settle();
  press(host.querySelector("[data-pdf-scroll]"), "f", { metaKey: true });
  await settle(2);
  expect(host.querySelector("[data-pdf-find-input]")).not.toBeNull();
  opener = opens(fakeDoc([[800, 600]]));
  props.data = new Blob(["%PDF-1.7 other"], { type: "application/pdf" });
  flushSync();
  await settle();
  expect(host.querySelector("[data-pdf-find-input]")).toBeNull();
  expect(pages(host).map((p) => p.style.width)).toEqual(["800px"]);
});

test("a WebKit trackpad pinch zooms the pages", async () => {
  opener = opens(fakeDoc([[600, 800]]));
  const { host } = mount();
  await settle();
  const scroller = host.querySelector<HTMLElement>("[data-pdf-scroll]")!;
  const gesture = (type: string, scale: number) => {
    const ev = Object.assign(new Event(type, { cancelable: true }), { scale });
    scroller.dispatchEvent(ev);
    flushSync();
    return ev;
  };
  // WebKit would otherwise magnify the whole window.
  expect(gesture("gesturestart", 1).defaultPrevented).toBe(true);
  expect(gesture("gesturechange", 1.5).defaultPrevented).toBe(true);
  expect(gesture("gestureend", 1.5).defaultPrevented).toBe(true);
  // The pinch's scale times the zoom it began at (100% while happy-dom reports no width).
  expect(pages(host)[0]!.style.width).toBe("900px");
  expect(host.querySelector<HTMLSelectElement>("[data-pdf-zoom]")!.value).toBe("1.5");
  // With no pinch under way, a stray end changes nothing.
  expect(gesture("gestureend", 3).defaultPrevented).toBe(false);
  expect(pages(host)[0]!.style.width).toBe("900px");
});

test("Ctrl + wheel zooms by the wheel's distance, and a plain wheel is left to scroll", async () => {
  opener = opens(fakeDoc([[600, 800]]));
  const { host } = mount();
  await settle();
  const scroller = host.querySelector<HTMLElement>("[data-pdf-scroll]")!;
  const plain = new WheelEvent("wheel", { deltaY: 100, cancelable: true });
  scroller.dispatchEvent(plain);
  expect(plain.defaultPrevented).toBe(false);
  const pinch = new WheelEvent("wheel", { deltaY: -300 * Math.log(2), ctrlKey: true, cancelable: true });
  // happy-dom's WheelEvent drops the modifier keys from its init.
  Object.defineProperty(pinch, "ctrlKey", { value: true });
  scroller.dispatchEvent(pinch);
  expect(pinch.defaultPrevented).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  flushSync();
  expect(pages(host)[0]!.style.width).toBe("1200px");
});

test("the find button toggles the bar, and the theme reaches the root", async () => {
  opener = opens(fakeDoc([[600, 800]]));
  const { host, props } = mount();
  await settle();
  click(host.querySelector("[data-pdf-find-toggle]"));
  await settle(2);
  expect(host.querySelector("[data-pdf-find-input]")).not.toBeNull();
  click(buttonByText(host, "✕"));
  expect(host.querySelector("[data-pdf-find-input]")).toBeNull();
  expect(host.querySelector(".pdf-viewer")?.getAttribute("data-pdf-theme")).toBe("light");
  props.theme = "dark";
  flushSync();
  expect(host.querySelector(".pdf-viewer")?.getAttribute("data-pdf-theme")).toBe("dark");
});

test("asking again for the row that already has focus scrolls back to it; new rows alone do not", async () => {
  opener = opens(fakeDoc([[600, 800], [600, 800], [600, 800]]));
  const annotations = [row({ id: "p3", anchor: { page: 3, x: 0.1, y: 0.5, w: 0.2, h: 0.1 } })];
  const { host, props } = mount({ annotations, focusId: "p3" });
  await settle();
  const scroller = host.querySelector<HTMLElement>("[data-pdf-scroll]")!;
  const at = 12 + 2 * 812 + 0.5 * 800;
  expect(scroller.scrollTop).toBe(at);
  scroller.scrollTop = 0;
  props.annotations = annotations.map((r) => ({ ...r }));
  flushSync();
  await settle(2);
  expect(scroller.scrollTop).toBe(0);
  props.focusSeq += 1;
  flushSync();
  await settle(2);
  expect(scroller.scrollTop).toBe(at);
  expect(host.querySelector('.pdf-mark[data-annotation-id="p3"]')?.classList.contains("is-flash")).toBe(true);
});
