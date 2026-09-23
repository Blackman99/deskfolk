/**
 * The rendered-Markdown annotator mounted in happy-dom: blocks carry their source lines, existing
 * rows get numbered marks in their states (a gone file not drawn), a selection in annotate mode
 * offers the button and hands over a source-line anchor, and Escape cancels before the pane hears
 * it. happy-dom has no layout and no CSS Custom Highlight API: positions are zero unless a test
 * stubs the ranges' boxes, and painting is checked against a stand-in highlight registry.
 */
import { afterEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import { validateAnchor, type Annotation, type TextRangeAnchor } from "@real-bot/protocol";
import { reactive } from "../test-reactive.svelte.ts";
import { click, press, render } from "../test-render.ts";
import MarkdownAnnotator, { type MarkdownAnnotatorLabels, type MarkdownRangeDraft } from "./MarkdownAnnotator.svelte";

const labels: MarkdownAnnotatorLabels = {
  annotate: "批注",
  mark: (n, remark) => `批注 ${n}：${remark}`,
  stale: "文件已改动，位置可能不准",
};

const SOURCE = ["# 周报", "", "本周完成了 **登录改版**，见 [设计稿](https://example.com/d)。", "", "- 下周：接入支付", "- 风险：人手不足"].join("\n");

function row(over: Partial<Annotation> & { anchor?: TextRangeAnchor } = {}): Annotation {
  return {
    id: "a1",
    status: "open",
    relpath: "docs/weekly.md",
    anchor_kind: "text_range",
    anchor: { start_line: 3, start_col: 9, end_line: 3, end_col: 13, quote: "登录改版", prefix: "", suffix: "", view: "rendered" },
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "s1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "s1",
    message_id: "m2",
    body: "改版范围写清楚",
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
  document.getSelection()?.removeAllRanges();
  while (cleanups.length) cleanups.pop()!();
});

type Over = Partial<{
  annotations: Annotation[];
  focusId: string | null;
  active: boolean;
  enabled: boolean;
  pending: TextRangeAnchor | null;
}>;

function mount(over: Over = {}) {
  const calls: string[] = [];
  const drafts: MarkdownRangeDraft[] = [];
  const view = render(MarkdownAnnotator, {
    source: SOURCE,
    annotations: over.annotations ?? [],
    focusId: over.focusId ?? null,
    active: over.active ?? false,
    enabled: over.enabled ?? true,
    labels,
    pending: over.pending ?? null,
    copyLabel: "复制代码",
    copiedLabel: "已复制",
    onDraft: (draft: MarkdownRangeDraft) => drafts.push(draft),
    onPick: (id: string) => calls.push(`pick:${id}`),
    onCancel: () => calls.push("cancel"),
  });
  cleanups.push(view.close);
  return { ...view, calls, drafts };
}

function textNode(host: HTMLElement, text: string): Text {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Text).data.includes(text)) return node as Text;
  }
  throw new Error(`no text ${text}`);
}

/** Select `text` inside the rendered body the way a drag would, and let the page hear it. */
function selectText(host: HTMLElement, text: string): void {
  const node = textNode(host, text);
  const at = node.data.indexOf(text);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + text.length);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  flushSync();
}

test("the body renders with source lines, and rows get numbered marks in their states", () => {
  const { host } = mount({
    annotations: [
      row({ id: "a1" }),
      row({ id: "a2", status: "draft", anchor: { start_line: 5, start_col: 3, end_line: 5, end_col: 5, quote: "下周", prefix: "", suffix: "" } }),
      row({ id: "a3", status: "resolved", stale: { kind: "changed" }, anchor: { start_line: 6, start_col: 3, end_line: 6, end_col: 5, quote: "风险", prefix: "", suffix: "" } }),
      row({ id: "a4", stale: { kind: "missing" } }),
    ],
  });
  expect(host.querySelector("h1")?.getAttribute("data-src-start")).toBe("1");
  expect(host.querySelector("p")?.getAttribute("data-src-start")).toBe("3");
  const marks = [...host.querySelectorAll<HTMLButtonElement>("[data-annotation-id]")];
  expect(marks.map((m) => [m.dataset.annotationId, m.textContent])).toEqual([
    ["a1", "1"],
    ["a2", "2"],
    ["a3", "3"],
  ]);
  expect(marks[0]!.title).toBe("改版范围写清楚");
  expect(marks[0]!.getAttribute("aria-label")).toBe("批注 1：改版范围写清楚");
  expect(marks[1]!.classList.contains("is-draft")).toBe(true);
  expect(marks[2]!.classList.contains("is-resolved")).toBe(true);
  expect(marks[2]!.classList.contains("is-stale")).toBe(true);
  expect(marks[2]!.title).toBe("改版范围写清楚\n文件已改动，位置可能不准");
  // The rendered DOM is left as rendered: marks live in their own layer.
  expect(host.querySelector(".md-body [data-annotation-id]")).toBeNull();
});

test("a click on a mark picks it", () => {
  const { host, calls } = mount({ annotations: [row({ id: "a1" })] });
  click(host.querySelector('[data-annotation-id="a1"]'));
  expect(calls).toEqual(["pick:a1"]);
});

test("in annotate mode a selection offers the button, and the button hands over a source-line anchor", () => {
  const { host, drafts } = mount({ active: true });
  expect(host.querySelector("[data-annotate-button]")).toBeNull();
  selectText(host, "登录改版");
  const button = host.querySelector("[data-annotate-button]");
  expect(button?.textContent).toBe("批注");
  click(button);
  expect(drafts).toHaveLength(1);
  const anchor = drafts[0]!.anchor;
  expect(validateAnchor("text_range", anchor).ok).toBe(true);
  expect(anchor).toMatchObject({ start_line: 3, start_col: 9, end_line: 3, end_col: 13, quote: "登录改版", view: "rendered" });
  expect(anchor.prefix.endsWith("本周完成了 **")).toBe(true);
  expect(drafts[0]!.crop).toBeUndefined();
  expect(host.querySelector("[data-annotate-button]")).toBeNull();
});

test("outside annotate mode, or when adding is not allowed, a selection is only a selection", () => {
  const off = mount({ active: false });
  selectText(off.host, "登录改版");
  expect(off.host.querySelector("[data-annotate-button]")).toBeNull();
  off.close();
  cleanups.pop();

  const blocked = mount({ active: true, enabled: false });
  selectText(blocked.host, "登录改版");
  expect(blocked.host.querySelector("[data-annotate-button]")).toBeNull();
});

test("Escape while choosing drops the button and cancels, and the pane never hears it", () => {
  const { host, calls } = mount({ active: true });
  const heard: string[] = [];
  const onWindow = (ev: KeyboardEvent) => heard.push(ev.key);
  window.addEventListener("keydown", onWindow);
  cleanups.push(() => window.removeEventListener("keydown", onWindow));
  selectText(host, "接入支付");
  expect(host.querySelector("[data-annotate-button]")).not.toBeNull();
  press(document.body, "Escape");
  expect(calls).toEqual(["cancel"]);
  expect(heard).toEqual([]);
  expect(host.querySelector("[data-annotate-button]")).toBeNull();
});

test("Escape with a range pending cancels it; with nothing going on it is left to the pane", () => {
  const pending = mount({ pending: { start_line: 5, start_col: 3, end_line: 5, end_col: 5, quote: "下周", prefix: "", suffix: "", view: "rendered" } });
  press(document.body, "Escape");
  expect(pending.calls).toEqual(["cancel"]);
  pending.close();
  cleanups.pop();

  const idle = mount();
  const heard: string[] = [];
  const onWindow = (ev: KeyboardEvent) => heard.push(ev.key);
  window.addEventListener("keydown", onWindow);
  cleanups.push(() => window.removeEventListener("keydown", onWindow));
  press(document.body, "Escape");
  expect(idle.calls).toEqual([]);
  expect(heard).toEqual(["Escape"]);
});

type FakeHighlight = Set<AbstractRange> & { priority: number };

/** Stand in for the CSS Custom Highlight API, which happy-dom does not have. */
function fakeHighlights(): Map<string, FakeHighlight> {
  const registry = new Map<string, FakeHighlight>();
  const cssBefore = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  const highlightBefore = Object.getOwnPropertyDescriptor(globalThis, "Highlight");
  Object.defineProperty(globalThis, "CSS", { value: { highlights: registry }, configurable: true, writable: true });
  Object.defineProperty(globalThis, "Highlight", {
    value: class extends Set<AbstractRange> {
      priority = 0;
    },
    configurable: true,
    writable: true,
  });
  cleanups.unshift(() => {
    if (cssBefore) Object.defineProperty(globalThis, "CSS", cssBefore);
    else delete (globalThis as { CSS?: unknown }).CSS;
    if (highlightBefore) Object.defineProperty(globalThis, "Highlight", highlightBefore);
    else delete (globalThis as { Highlight?: unknown }).Highlight;
  });
  return registry;
}

const texts = (highlight: FakeHighlight | undefined): string[] => [...(highlight ?? [])].map((range) => (range as Range).toString());

test("marks are painted as highlights by status, the pending range apart, the focused one flashed", () => {
  const registry = fakeHighlights();
  const { close } = mount({
    annotations: [
      row({ id: "a1" }),
      row({ id: "a2", status: "draft", stale: { kind: "changed" }, anchor: { start_line: 6, start_col: 3, end_line: 6, end_col: 5, quote: "风险", prefix: "- ", suffix: "：人手不足" } }),
    ],
    pending: { start_line: 5, start_col: 6, end_line: 5, end_col: 10, quote: "接入支付", prefix: "", suffix: "", view: "rendered" },
    focusId: "a1",
  });
  expect(texts(registry.get("rb-md-annot-open"))).toEqual(["登录改版"]);
  expect(texts(registry.get("rb-md-annot-draft-stale"))).toEqual(["风险"]);
  expect(texts(registry.get("rb-md-annot-pending"))).toEqual(["接入支付"]);
  expect(texts(registry.get("rb-md-annot-flash"))).toEqual(["登录改版"]);
  close();
  cleanups.splice(cleanups.indexOf(close), 1);
  // Unmounting takes its highlights with it.
  expect(registry.size).toBe(0);
});

test("a click on marked text picks it, and hovering it shows the remark", async () => {
  const proto = Range.prototype as { getClientRects: () => unknown };
  const original = proto.getClientRects;
  proto.getClientRects = function (this: Range) {
    return this.toString().includes("登录改版") ? [{ left: 40, top: 30, right: 90, bottom: 46, width: 50, height: 16 }] : [];
  };
  cleanups.unshift(() => {
    proto.getClientRects = original;
  });
  const { host, calls } = mount({ annotations: [row({ id: "a1" })] });
  const mark = host.querySelector<HTMLElement>('[data-annotation-id="a1"]')!;
  expect(mark.style.left).toBe("40px");
  expect(mark.style.top).toBe("30px");

  const paragraph = host.querySelector("p")!;
  paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 60, clientY: 38 }));
  paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 300, clientY: 300 }));
  expect(calls).toEqual(["pick:a1"]);

  const body = host.querySelector<HTMLElement>(".md-annot-body")!;
  body.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 60, clientY: 38, pointerType: "mouse" }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  flushSync();
  expect(body.title).toBe("改版范围写清楚");
  body.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
  flushSync();
  expect(body.hasAttribute("title")).toBe(false);
});

test("a touch that clears the selection before its click still hands over the anchor", () => {
  const { host, drafts } = mount({ active: true });
  selectText(host, "接入支付");
  const button = host.querySelector<HTMLElement>("[data-annotate-button]")!;
  button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
  // The tap lands outside the text: the page drops the selection before the click arrives.
  document.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  flushSync();
  expect(host.querySelector("[data-annotate-button]")).not.toBeNull();
  click(host.querySelector("[data-annotate-button]"));
  expect(drafts).toHaveLength(1);
  expect(drafts[0]!.anchor).toMatchObject({ start_line: 5, start_col: 6, end_line: 5, end_col: 10, quote: "接入支付", view: "rendered" });
});

test("a selection running out of the body still offers the button; turning either switch off takes it away", () => {
  const props = reactive({ active: true, enabled: true });
  const drafts: MarkdownRangeDraft[] = [];
  const view = render(MarkdownAnnotator, {
    source: SOURCE,
    annotations: [],
    focusId: null,
    get active() {
      return props.active;
    },
    get enabled() {
      return props.enabled;
    },
    labels,
    copyLabel: "复制代码",
    copiedLabel: "已复制",
    onDraft: (draft: MarkdownRangeDraft) => drafts.push(draft),
    onPick: () => {},
  });
  cleanups.push(view.close);
  const outside = document.createElement("p");
  outside.textContent = "outside";
  document.body.appendChild(outside);
  cleanups.push(() => outside.remove());
  const range = document.createRange();
  const tail = textNode(view.host, "人手不足");
  range.setStart(tail, tail.data.indexOf("人手不足"));
  range.setEnd(outside.firstChild!, 3);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  flushSync();
  expect(view.host.querySelector("[data-annotate-button]")).not.toBeNull();

  props.enabled = false;
  flushSync();
  expect(view.host.querySelector("[data-annotate-button]")).toBeNull();
  props.enabled = true;
  flushSync();
  // Back on with the selection still there: offered again.
  expect(view.host.querySelector("[data-annotate-button]")).not.toBeNull();
  click(view.host.querySelector("[data-annotate-button]"));
  expect(drafts[0]!.anchor).toMatchObject({ start_line: 6, start_col: 6, end_line: 6, end_col: 10, quote: "人手不足" });

  document.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  flushSync();
  props.active = false;
  flushSync();
  expect(view.host.querySelector("[data-annotate-button]")).toBeNull();
});

test("a focus set later scrolls to its mark and flashes it; one set before its row arrives waits for it", async () => {
  const registry = fakeHighlights();
  const scrolled: string[] = [];
  const proto = Element.prototype as { scrollIntoView?: (arg?: unknown) => void };
  const original = proto.scrollIntoView;
  proto.scrollIntoView = function (this: Element) {
    scrolled.push(this.textContent ?? "");
  };
  cleanups.unshift(() => {
    proto.scrollIntoView = original;
  });
  const props = reactive({ annotations: [row({ id: "a1" })], focusId: null as string | null });
  const view = render(MarkdownAnnotator, {
    source: SOURCE,
    get annotations() {
      return props.annotations;
    },
    get focusId() {
      return props.focusId;
    },
    active: false,
    enabled: true,
    labels,
    copyLabel: "复制代码",
    copiedLabel: "已复制",
    onDraft: () => {},
    onPick: () => {},
  });
  cleanups.push(view.close);
  expect(registry.get("rb-md-annot-flash")).toBeUndefined();
  props.focusId = "a1";
  flushSync();
  expect(texts(registry.get("rb-md-annot-flash"))).toEqual(["登录改版"]);
  expect(scrolled.some((text) => text.includes("登录改版"))).toBe(true);
  expect(view.host.querySelector('[data-annotation-id="a1"]')?.classList.contains("is-flash")).toBe(true);

  // A row that is not there yet: nothing flashes until it arrives.
  props.focusId = "a2";
  flushSync();
  const flashed = texts(registry.get("rb-md-annot-flash"));
  expect(flashed).not.toContain("风险");
  props.annotations = [
    row({ id: "a1" }),
    row({ id: "a2", anchor: { start_line: 6, start_col: 3, end_line: 6, end_col: 5, quote: "风险", prefix: "", suffix: "" } }),
  ];
  flushSync();
  expect(texts(registry.get("rb-md-annot-flash"))).toEqual(["风险"]);
});

test("asking again for the mark that already has focus scrolls to it and flashes it again", () => {
  const registry = fakeHighlights();
  const scrolled: string[] = [];
  const proto = Element.prototype as { scrollIntoView?: (arg?: unknown) => void };
  const original = proto.scrollIntoView;
  proto.scrollIntoView = function (this: Element) {
    scrolled.push(this.textContent ?? "");
  };
  cleanups.unshift(() => {
    proto.scrollIntoView = original;
  });
  const props = reactive({ annotations: [row({ id: "a1" })], focusId: "a1" as string | null, focusSeq: 0 });
  const view = render(MarkdownAnnotator, {
    source: SOURCE,
    get annotations() {
      return props.annotations;
    },
    get focusId() {
      return props.focusId;
    },
    get focusSeq() {
      return props.focusSeq;
    },
    active: false,
    enabled: true,
    labels,
    copyLabel: "复制代码",
    copiedLabel: "已复制",
    onDraft: () => {},
    onPick: () => {},
  });
  cleanups.push(view.close);
  expect(scrolled.filter((text) => text.includes("登录改版"))).toHaveLength(1);
  // New rows with the same focus are no request.
  props.annotations = [row({ id: "a1" })];
  flushSync();
  expect(scrolled.filter((text) => text.includes("登录改版"))).toHaveLength(1);
  props.focusSeq += 1;
  flushSync();
  expect(scrolled.filter((text) => text.includes("登录改版"))).toHaveLength(2);
  expect(texts(registry.get("rb-md-annot-flash"))).toEqual(["登录改版"]);
});
