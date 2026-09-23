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
