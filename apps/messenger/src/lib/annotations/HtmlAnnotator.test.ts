/**
 * The HTML annotator's side of going to an annotation: every request reaches the page, the one
 * that already has focus included. (The picker and the rest of the component are covered in
 * html-picker.test.ts.)
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { Annotation } from "@real-bot/protocol";
import { reactive } from "../test-reactive.svelte.ts";
import { render } from "../test-render.ts";
import { closeFullscreenPreview } from "../overlays/fullscreen-preview.ts";
import HtmlAnnotator, { type HtmlAnnotatorLabels } from "./HtmlAnnotator.svelte";

const labels: HtmlAnnotatorLabels = {
  hint: "点选页面上的一个元素",
  keysHint: "↑ ↓ 换外层或内层，Enter 选定，Esc 退出",
  pendingHint: "已选中，写下批注；也可以换到外层或内层",
  outer: "外层",
  inner: "内层",
  marks: "页面上的批注",
  markLabel: (n) => `第 ${n} 条批注`,
  stale: "原文已变",
  notFound: "页面里找不到这个元素了",
  blocked: "这个页面的脚本在这里跑不了，没法点选元素；切到「源码」可以按行批注",
  viewport: {
    group: "预览设备",
    desktop: "电脑",
    tablet: "平板",
    phone: "手机",
    zoomed: (width) => `这个页面按 ${width} 像素宽排版，再像手机浏览器那样缩小到屏幕宽`,
    enlarge: "全屏预览",
    shrink: "退出全屏（Esc）",
  },
};

function row(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "a",
    status: "open",
    relpath: "site/index.html",
    anchor_kind: "html_element",
    anchor: { selector: "body > main > h1", tag: "h1", text: "Title", outer_html: "<h1>Title</h1>", rect: { x: 0, y: 0, w: 1, h: 0.1 } },
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "s1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "s1",
    message_id: "m2",
    body: "标题换一个",
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

const blobs = new Map<string, Blob>();
let realCreate: typeof URL.createObjectURL;
let realRevoke: typeof URL.revokeObjectURL;
// happy-dom would try to navigate the iframe to the fake blob URL; the page is not what is tested.
const happy = (globalThis as unknown as { happyDOM?: { settings: { navigation: { disableChildFrameNavigation: boolean } } } }).happyDOM;
let childFrames = false;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  if (happy) {
    childFrames = happy.settings.navigation.disableChildFrameNavigation;
    happy.settings.navigation.disableChildFrameNavigation = true;
  }
  blobs.clear();
  realCreate = URL.createObjectURL;
  realRevoke = URL.revokeObjectURL;
  let n = 0;
  URL.createObjectURL = (blob: Blob) => {
    n += 1;
    const url = `blob:html-annotator/${n}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  if (happy) happy.settings.navigation.disableChildFrameNavigation = childFrames;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

test("asking again for the annotation that already has focus scrolls the page to it again", async () => {
  const props = reactive({
    html: "<!DOCTYPE html><html><head></head><body><main><h1>Title</h1></main></body></html>",
    scheme: "light" as "light" | "dark",
    title: "site/index.html",
    annotations: [row({ id: "a" }), row({ id: "b", body: "副标题" })],
    focusId: null as string | null,
    focusSeq: 0,
    active: true,
    enabled: true,
    labels,
    nonce: "n0nce",
    onDraft: () => {},
    onPick: () => {},
  });
  const view = render(HtmlAnnotator, props);
  cleanups.push(view.close);
  const frame = view.host.querySelector("iframe") as HTMLIFrameElement;
  const channel = (await blobs.get(frame.getAttribute("src")!)!.text()).match(/"channel":"([0-9a-f]{32})"/)![1];
  const { port1, port2 } = new MessageChannel();
  cleanups.push(() => port1.close());
  const got: Array<Record<string, unknown>> = [];
  port1.onmessage = (ev) => got.push(ev.data as Record<string, unknown>);
  window.dispatchEvent(new MessageEvent("message", { data: { channel, type: "ready" }, source: frame.contentWindow as Window, ports: [port2] }));
  flushSync();
  await settle();
  const focuses = () => got.filter((m) => m.type === "focus");
  props.focusId = "b";
  flushSync();
  await settle();
  expect(focuses()).toEqual([{ channel, type: "focus", n: 2 }]);
  // New rows with the same content and the same focus: nothing to go to.
  props.annotations = props.annotations.map((r) => ({ ...r }));
  flushSync();
  await settle();
  expect(focuses()).toHaveLength(1);
  props.focusSeq += 1;
  flushSync();
  await settle();
  expect(focuses()).toEqual([
    { channel, type: "focus", n: 2 },
    { channel, type: "focus", n: 2 },
  ]);
  expect(view.host.querySelector('.html-annot-chip[data-annotation-id="b"]')?.classList.contains("is-flash")).toBe(true);
});

const MOBILE_PAGE =
  '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>Title</h1></main></body></html>';
const DESKTOP_PAGE = "<!DOCTYPE html><html><head></head><body><main><h1>Title</h1></main></body></html>";

function devicePreview(html: string, over: Record<string, unknown> = {}) {
  const props = reactive({
    html,
    scheme: "light" as "light" | "dark",
    title: "site/index.html",
    annotations: [] as Annotation[],
    focusId: null as string | null,
    active: false,
    enabled: true,
    labels,
    nonce: "n0nce",
    onDraft: () => {},
    onPick: () => {},
    ...over,
  });
  const view = render(HtmlAnnotator, props);
  cleanups.push(view.close);
  const frame = () => view.host.querySelector("iframe") as HTMLIFrameElement;
  const size = () => [Math.round(parseFloat(frame().style.width)), Math.round(parseFloat(frame().style.height))];
  const pick = (device: string) => {
    view.host.querySelector<HTMLButtonElement>(`[data-viewport-device="${device}"]`)!.click();
    flushSync();
  };
  const pressed = () =>
    [...view.host.querySelectorAll<HTMLButtonElement>("[data-viewport-device]")]
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.dataset.viewportDevice);
  /** What the helper in front of the page says once the page has loaded. */
  const report = async (width: number) => {
    const source = await blobs.get(frame().getAttribute("src")!)!.text();
    const channel = source.match(/\(function\(\)\{"use strict";var __name=function\(f\)\{return f\};\([\s\S]*?\)\("([0-9a-f]{32})"\);\}\)\(\);/)?.[1];
    window.dispatchEvent(
      new MessageEvent("message", { data: { channel, type: "content", width }, source: frame().contentWindow as Window }),
    );
    flushSync();
  };
  return { ...view, props, frame, size, pick, pressed, report };
}

test("a mobile page runs at each device's own viewport, and a new device is a fresh load that is remembered", async () => {
  window.localStorage.removeItem("real-bot-html-viewport");
  cleanups.push(() => window.localStorage.removeItem("real-bot-html-viewport"));
  const view = devicePreview(MOBILE_PAGE);
  const size = () => view.host.querySelector("[data-html-viewport-size]")?.textContent ?? "";
  expect(view.pressed()).toEqual(["desktop"]);
  expect(view.size()).toEqual([1440, 900]);
  expect(size()).toStartWith("1440 × 900 · ");
  expect(view.host.querySelector("[data-html-viewport-bar]")?.getAttribute("aria-label")).toBe("预览设备");
  const desktopSrc = view.frame().getAttribute("src");
  const desktopSource = await blobs.get(desktopSrc!)!.text();
  // A desktop keeps its scrollbars; only the helper script goes in.
  expect(desktopSource).not.toContain("scrollbar-width:none");
  expect(desktopSource).toContain('<script nonce="n0nce">(function(){"use strict";');

  view.pick("phone");
  await settle();
  expect(view.pressed()).toEqual(["phone"]);
  expect(view.host.querySelector("[data-device]")?.getAttribute("data-device")).toBe("phone");
  expect(view.frame().getAttribute("src")).not.toBe(desktopSrc);
  expect(view.size()).toEqual([390, 844]);
  expect(size()).toStartWith("390 × 844 · ");
  expect(view.host.querySelector("[data-html-viewport-size]")?.getAttribute("title")).toBeNull();
  // A phone has no scrollbars taking room.
  expect(await blobs.get(view.frame().getAttribute("src")!)!.text()).toContain("scrollbar-width:none");
  expect(window.localStorage.getItem("real-bot-html-viewport")).toBe("phone");

  view.pick("tablet");
  await settle();
  expect(view.size()).toEqual([820, 1180]);
});

test("a page with no viewport tag is laid out 980 wide on a phone, or as wide as its content, and zoomed to the screen", async () => {
  window.localStorage.setItem("real-bot-html-viewport", "phone");
  cleanups.push(() => window.localStorage.removeItem("real-bot-html-viewport"));
  const view = devicePreview(DESKTOP_PAGE);
  const tall = (width: number) => Math.round((844 * width) / 390);
  expect(view.size()).toEqual([980, tall(980)]);
  expect(view.frame().style.transform).toMatch(/^scale\(/);
  expect(view.host.querySelector("[data-html-viewport-size]")?.getAttribute("title")).toBe(labels.viewport.zoomed(980));

  // The page says its content is 1080 wide (a fixed-width poster): the phone zooms out on all of it.
  await view.report(1080);
  expect(view.size()).toEqual([1080, tall(1080)]);
  // Only the first report counts: widening the layout must not chase a page sized off the viewport.
  await view.report(1300);
  expect(view.size()).toEqual([1080, tall(1080)]);
  // Narrower content never narrows it below what the browser starts at.
  view.pick("tablet");
  await settle();
  await view.report(600);
  expect(view.size()).toEqual([980, Math.round((1180 * 980) / 820)]);

  // A report from anywhere but this page's window is not the helper's.
  view.pick("phone");
  await settle();
  window.dispatchEvent(new MessageEvent("message", { data: { channel: "0".repeat(32), type: "content", width: 2000 }, source: window }));
  flushSync();
  expect(view.size()).toEqual([980, tall(980)]);

  // A desktop browser ignores all of this: its window is the layout.
  view.pick("desktop");
  await settle();
  expect(view.size()).toEqual([1440, 900]);
});

test("a device picked in one preview is the one the next preview opens on, in annotate mode too", async () => {
  window.localStorage.setItem("real-bot-html-viewport", "tablet");
  cleanups.push(() => window.localStorage.removeItem("real-bot-html-viewport"));
  const view = devicePreview(MOBILE_PAGE, { scheme: "dark", active: true });
  expect(view.size()).toEqual([820, 1180]);
  expect(view.host.querySelector("[data-html-stage]")?.classList.contains("is-dark")).toBe(true);
  expect(view.host.querySelector("[data-html-annot-bar]")).not.toBeNull();
  // The picker still runs before everything else, the helper included.
  const source = await blobs.get(view.frame().getAttribute("src")!)!.text();
  const doc = new DOMParser().parseFromString(source, "text/html");
  expect(doc.querySelector("script")?.textContent).toContain("rb-annot-layer");
});

test("full screen fills the window with the same page, and Escape — from the pane or passed on by the page — leaves it", async () => {
  window.localStorage.setItem("real-bot-html-viewport", "phone");
  cleanups.push(() => window.localStorage.removeItem("real-bot-html-viewport"));
  const view = devicePreview(MOBILE_PAGE);
  const root = () => view.host.querySelector("[data-html-annotator]") as HTMLElement;
  const button = () => view.host.querySelector("[data-html-enlarge]") as HTMLButtonElement;
  const frame = view.frame();
  const src = frame.getAttribute("src");
  expect(button().getAttribute("aria-label")).toBe(labels.viewport.enlarge);

  button().click();
  flushSync();
  expect(root().classList.contains("is-enlarged")).toBe(true);
  expect(button().getAttribute("aria-pressed")).toBe("true");
  expect(button().getAttribute("aria-label")).toBe(labels.viewport.shrink);
  // Not a reload: the same frame, the same page, at the same viewport.
  expect(view.frame()).toBe(frame);
  expect(frame.getAttribute("src")).toBe(src);
  expect(view.size()).toEqual([390, 844]);

  // Escape in the messenger leaves full screen and goes no further (it would close the pane).
  const key = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.body.dispatchEvent(key);
  flushSync();
  expect(key.defaultPrevented).toBe(true);
  expect(root().classList.contains("is-enlarged")).toBe(false);

  // With focus in the page, its helper passes the Escape on.
  button().click();
  flushSync();
  const source = await blobs.get(frame.getAttribute("src")!)!.text();
  const channel = source.match(/\(function\(\)\{"use strict";var __name=function\(f\)\{return f\};\([\s\S]*?\)\("([0-9a-f]{32})"\);\}\)\(\);/)?.[1];
  window.dispatchEvent(new MessageEvent("message", { data: { channel, type: "escape" }, source: window }));
  flushSync();
  expect(root().classList.contains("is-enlarged")).toBe(true);
  window.dispatchEvent(new MessageEvent("message", { data: { channel, type: "escape" }, source: frame.contentWindow as Window }));
  flushSync();
  expect(root().classList.contains("is-enlarged")).toBe(false);

  // Out of full screen, an Escape is not the preview's to take.
  const later = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.body.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});

test("choosing an element in full screen goes back to the pane, where the remark is written", async () => {
  const drafts: unknown[] = [];
  const view = devicePreview(MOBILE_PAGE, { active: true, onDraft: (d: unknown) => drafts.push(d) });
  const root = () => view.host.querySelector("[data-html-annotator]") as HTMLElement;
  (view.host.querySelector("[data-html-enlarge]") as HTMLButtonElement).click();
  flushSync();
  expect(root().classList.contains("is-enlarged")).toBe(true);
  const frame = view.frame();
  const channel = (await blobs.get(frame.getAttribute("src")!)!.text()).match(/"channel":"([0-9a-f]{32})"/)![1];
  const anchor = { selector: "body > main > h1", tag: "h1", text: "Title", outer_html: "<h1>Title</h1>", rect: { x: 0, y: 0, w: 1, h: 0.1 } };
  window.dispatchEvent(new MessageEvent("message", { data: { channel, type: "pick", anchor }, source: frame.contentWindow as Window }));
  flushSync();
  expect(drafts).toHaveLength(1);
  expect(root().classList.contains("is-enlarged")).toBe(false);
});


test("phone Back exits HTML full screen while preserving the page, and unmount releases it", () => {
  const view = devicePreview(MOBILE_PAGE);
  const frame = view.frame();
  const src = frame.getAttribute("src");
  const button = view.host.querySelector<HTMLButtonElement>("[data-html-enlarge]")!;
  button.click(); flushSync();
  expect(closeFullscreenPreview()).toBe(true);
  flushSync();
  expect(view.host.querySelector(".is-enlarged")).toBeNull();
  expect(view.frame()).toBe(frame);
  expect(frame.getAttribute("src")).toBe(src);
  expect(closeFullscreenPreview()).toBe(false);
  button.click(); flushSync();
  while (cleanups.length) cleanups.pop()!();
  expect(closeFullscreenPreview()).toBe(false);
});
