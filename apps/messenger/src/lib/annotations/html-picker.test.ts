/**
 * The HTML element picker (#28): where the injected script lands, what the messenger lets
 * through, the CSS paths, the picker itself run inside a happy-dom page with a fake parent, and
 * the annotator component around the iframe.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { validateAnchor, type Annotation, type HtmlElementAnchor } from "@real-bot/protocol";
import { flushSync } from "svelte";
import { injectHtmlPreviewColorScheme, injectHtmlPreviewNonce } from "../overlays/artifacts.ts";
import { click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import HtmlAnnotator, { type HtmlAnnotatorLabels } from "./HtmlAnnotator.svelte";
import {
  annotatorSource,
  cssPathFor,
  docRect,
  elementText,
  focusMessage,
  injectPicker,
  isChannel,
  marksMessage,
  navMessage,
  newChannel,
  outerHtmlOf,
  pickerMarks,
  pickerScriptSource,
  tagOf,
  validatePickerMessage,
  type PickerMark,
} from "./html-picker.ts";

const CH = "0123456789abcdef0123456789abcdef";
const NONCE = "n0nce";
const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Channel and injection
// ---------------------------------------------------------------------------------------------

test("a channel is 128 random bits in hex, fresh every time", () => {
  const a = newChannel();
  const b = newChannel();
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(isChannel(a)).toBe(true);
  expect(a).not.toBe(b);
  expect(isChannel("0123")).toBe(false);
  expect(isChannel(CH.toUpperCase())).toBe(false);
});

test("the picker script is one IIFE that compiles, holds its channel, and cannot end its own script tag", () => {
  const source = pickerScriptSource(CH);
  expect(source.startsWith("(function(){")).toBe(true);
  expect(source).toContain(`"channel":"${CH}"`);
  expect(source).not.toMatch(/<\/script|<!--/i);
  expect(() => new Function(source)).not.toThrow();
  expect(() => pickerScriptSource("not-a-channel")).toThrow();
  expect(() => pickerScriptSource(`${CH}"</script>`)).toThrow();
});

function parsed(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function firstScript(doc: Document): HTMLScriptElement {
  return doc.querySelector("script") as HTMLScriptElement;
}

const SHAPES: Array<[string, string, number]> = [
  ["a full document", "<!DOCTYPE html><html lang=\"zh\"><head><meta charset=\"utf-8\"><script src=\"a.js\"></script></head><body><p>x</p><script>b()</script></body></html>", 2],
  ["no <head>", "<html><body><p>x</p><script>b()</script></body></html>", 1],
  ["no <html> or <head>", "<p>x</p><script>c()</script>", 1],
  ["only a doctype", "<!DOCTYPE html><p>x</p><script>d()</script>", 1],
  ["a script before <head>", "<!DOCTYPE html><script>early()</script><html lang=\"zh\"><head><title>t</title></head><body></body></html>", 1],
  ["a commented-out <script> and <head>", "<!-- <script>no()</script><head> --><html><head><title>t</title></head><body><script>e()</script></body></html>", 1],
  ["a <header> and a <style> that mention script", "<html><head><style>p::after{content:'<script>'}</style><title>t</title></head><body><header>h</header><script>f()</script></body></html>", 1],
];

for (const [name, html, own] of SHAPES) {
  test(`injection with ${name}: the nonce-carrying picker is the page's first script, inside <head>`, () => {
    const out = injectPicker(html, { channel: CH, nonce: NONCE });
    const doc = parsed(out);
    const first = firstScript(doc);
    expect(first.getAttribute("nonce")).toBe(NONCE);
    expect(first.textContent).toContain(CH);
    expect(doc.head.contains(first)).toBe(true);
    // Everything the page had is still there, after the picker.
    expect(doc.querySelectorAll("script")).toHaveLength(own + 1);
    // Take the picker (and the <head> it may have brought) back out, and the page is what it was.
    const tag = /<script nonce="n0nce">\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/;
    expect(out.match(new RegExp(tag.source, "g"))).toHaveLength(1);
    expect(out.replace(tag, "").replace("<head></head>", "")).toBe(html);
    if (html.startsWith("<!DOCTYPE html>")) expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
  });
}

test("the injection keeps the page's own attributes and never adds a nonce it cannot quote", () => {
  const out = injectPicker("<!DOCTYPE html><html lang=\"zh\"><head></head><body></body></html>", { channel: CH, nonce: `bad"nonce` });
  expect(out).toContain("<script>(function(){");
  expect(parsed(out).documentElement.getAttribute("lang")).toBe("zh");
  expect(injectPicker("<p>x</p>", { channel: CH, nonce: null })).toStartWith("<head><script>(function(){");
});

test("a `>` inside a quoted attribute of <head> or <html> does not split the tag; a stray quote falls back safely", () => {
  const quoted = `<!DOCTYPE html><html data-a="x>y"><head data-b='1>2' lang="zh"><title>t</title></head><body><script>go()</script></body></html>`;
  const out = injectPicker(quoted, { channel: CH, nonce: NONCE });
  const doc = parsed(out);
  expect(doc.documentElement.getAttribute("data-a")).toBe("x>y");
  expect(doc.head.getAttribute("data-b")).toBe("1>2");
  expect(firstScript(doc).textContent).toContain(CH);
  expect(doc.head.contains(firstScript(doc))).toBe(true);
  expect(out.indexOf(`data-b='1>2' lang="zh"><script nonce`)).toBeGreaterThan(0);

  // A quote that never closes before the next tag: the <head> is not trusted, the picker still goes first.
  const stray = `<!DOCTYPE html><html><head x'y><title>it's</title></head><body><script>go()</script></body></html>`;
  const doc2 = parsed(injectPicker(stray, { channel: CH, nonce: NONCE }));
  expect(firstScript(doc2).textContent).toContain(CH);
  expect(doc2.querySelectorAll("script")).toHaveLength(2);
  // A <script> with odd attributes still counts as the page's first script.
  const oddScript = `<!DOCTYPE html><script data-x'>early()</script><html><head></head><body></body></html>`;
  const doc3 = parsed(injectPicker(oddScript, { channel: CH, nonce: NONCE }));
  expect(firstScript(doc3).textContent).toContain(CH);
  expect(doc3.querySelectorAll("script")[1]!.textContent).toBe("early()");
});

test("comments end where the HTML tokenizer ends them, so a script right after one still comes after the picker", () => {
  // `<!-->` and `<!--->` are whole (empty) comments, and `--!>` closes one too: the script after
  // each runs, even though a `-->` further on would seem to hide it.
  for (const html of [
    "<!--><script>early()</script><!-- --><html><head><title>t</title></head><body></body></html>",
    "<!---><script>early()</script><!-- --><html><head><title>t</title></head><body></body></html>",
    "<!-- a --!><script>early()</script> --><html><head><title>t</title></head><body></body></html>",
    "<!DOCTYPE html><!-- <head> --><script>early()</script><html><head></head></html>",
  ]) {
    const out = injectPicker(html, { channel: CH, nonce: NONCE });
    expect(out.indexOf(CH)).toBeGreaterThan(-1);
    expect(out.indexOf(CH)).toBeLessThan(out.indexOf("early()"));
  }
  // An unclosed comment hides the rest of the page; the picker still goes in front of it.
  const open = injectPicker("<!DOCTYPE html><!-- <head><script>x()</script>", { channel: CH, nonce: NONCE });
  expect(open.indexOf(CH)).toBeLessThan(open.indexOf("<!--"));
});

test("an element before <head> puts the picker in front of it: its inline handlers are the page's scripts too", () => {
  for (const [html, before] of [
    ['<!DOCTYPE html><svg onload="steal()"></svg><head><title>t</title></head><body></body>', "<svg"],
    ['<!DOCTYPE html><html lang="zh"><img src="x" onerror="steal()"><head><title>t</title></head>', "<img"],
    ['<html><meta charset="utf-8"><head></head><body><script>go()</script></body></html>', "<meta"],
  ] as const) {
    const out = injectPicker(html, { channel: CH, nonce: NONCE });
    expect(out.indexOf(CH)).toBeLessThan(out.indexOf(before));
    const doc = parsed(out);
    expect(firstScript(doc).textContent).toContain(CH);
    expect(doc.head.contains(firstScript(doc))).toBe(true);
    if (html.includes('lang="zh"')) expect(doc.documentElement.getAttribute("lang")).toBe("zh");
  }
});

test("a <head> inside an attribute value of <html> is not taken for the page's head", () => {
  const html = '<!DOCTYPE html><html data-x="<head>"><head><title>t</title></head><body><script>go()</script></body></html>';
  const out = injectPicker(html, { channel: CH, nonce: NONCE });
  const doc = parsed(out);
  expect(doc.documentElement.getAttribute("data-x")).toBe("<head>");
  expect(firstScript(doc).textContent).toContain(CH);
  expect(doc.querySelectorAll("script")).toHaveLength(2);
  expect(out.indexOf(CH)).toBeLessThan(out.indexOf("<html"));
  // Nor one inside an end tag's attribute value.
  const endTag = '<!DOCTYPE html></x a="<head>"><head></head><body><script>go()</script></body>';
  const out2 = injectPicker(endTag, { channel: CH, nonce: NONCE });
  expect(out2.indexOf(CH)).toBeLessThan(out2.indexOf("</x"));
  expect(out2).toContain('</x a="<head>">');
});

test("the annotator's source is the pane's source, plus the picker only when there is a channel", () => {
  const raw = "<html><head><style>p{}</style></head><body><script>go()</script></body></html>";
  const pane = injectHtmlPreviewNonce(injectHtmlPreviewColorScheme(raw, "dark"), NONCE);
  expect(annotatorSource(raw, { scheme: "dark", nonce: NONCE, channel: null })).toBe(pane);
  const annotating = annotatorSource(raw, { scheme: "dark", nonce: NONCE, channel: CH });
  const doc = parsed(annotating);
  expect(firstScript(doc).textContent).toContain(CH);
  // Every script and style still carries the nonce, the picker's included.
  expect([...doc.querySelectorAll("script, style")].every((el) => el.getAttribute("nonce") === NONCE)).toBe(true);
  expect(doc.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("dark");
});

// ---------------------------------------------------------------------------------------------
// What the messenger lets through
// ---------------------------------------------------------------------------------------------

const frameWindow = { name: "the iframe's window" };
const goodAnchor = (over: Record<string, unknown> = {}) => ({
  selector: "body > main > p:nth-of-type(2)",
  tag: "p",
  text: "第二段",
  outer_html: "<p>第二段</p>",
  rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 },
  ...over,
});
const pickEvent = (anchor: unknown, over: Record<string, unknown> = {}) => ({
  source: frameWindow,
  data: { channel: CH, type: "pick", anchor, ...over },
});

test("a well-formed pick from the iframe becomes an anchor that validateAnchor accepts", () => {
  const reply = validatePickerMessage(pickEvent(goodAnchor()), frameWindow, CH);
  expect(reply?.type).toBe("pick");
  const anchor = (reply as { anchor: HtmlElementAnchor }).anchor;
  expect(anchor).toEqual(goodAnchor() as HtmlElementAnchor);
  expect(validateAnchor("html_element", anchor).ok).toBe(true);
});

test("forged messages are dropped: wrong source, missing or wrong channel, wrong shape", () => {
  const good = pickEvent(goodAnchor());
  expect(validatePickerMessage({ ...good, source: {} }, frameWindow, CH)).toBeNull();
  expect(validatePickerMessage({ ...good, source: null }, null, CH)).toBeNull();
  expect(validatePickerMessage(good, frameWindow, null)).toBeNull();
  expect(validatePickerMessage(good, frameWindow, "f".repeat(32))).toBeNull();
  const { channel: _dropped, ...noChannel } = good.data;
  expect(validatePickerMessage({ source: frameWindow, data: noChannel }, frameWindow, CH)).toBeNull();
  expect(validatePickerMessage({ source: frameWindow, data: { ...good.data, channel: CH.toUpperCase() } }, frameWindow, CH)).toBeNull();
  // Shape: extra or missing keys, anywhere.
  expect(validatePickerMessage(pickEvent(goodAnchor(), { extra: 1 }), frameWindow, CH)).toBeNull();
  expect(validatePickerMessage(pickEvent({ ...goodAnchor(), id: "x" }), frameWindow, CH)).toBeNull();
  const { tag: _tag, ...noTag } = goodAnchor();
  expect(validatePickerMessage(pickEvent(noTag), frameWindow, CH)).toBeNull();
  expect(validatePickerMessage(pickEvent(goodAnchor({ rect: { x: 0, y: 0, w: 1, h: 1, z: 0 } })), frameWindow, CH)).toBeNull();
  expect(validatePickerMessage({ source: frameWindow, data: "pick" }, frameWindow, CH)).toBeNull();
  expect(validatePickerMessage({ source: frameWindow, data: [CH, "pick"] }, frameWindow, CH)).toBeNull();
  expect(validatePickerMessage({ source: frameWindow, data: { channel: CH, type: "eval" } }, frameWindow, CH)).toBeNull();
  expect(validatePickerMessage({ source: frameWindow, data: { channel: CH, type: "cancel", why: "x" } }, frameWindow, CH)).toBeNull();
  expect(validatePickerMessage({ source: frameWindow, data: { channel: CH, type: "cancel" } }, frameWindow, CH)).toEqual({ type: "cancel" });
});

test("oversize or mistyped fields are dropped, not trimmed", () => {
  const drop = (over: Record<string, unknown>) => validatePickerMessage(pickEvent(goodAnchor(over)), frameWindow, CH);
  expect(drop({ text: "字".repeat(301) })).toBeNull();
  expect(drop({ text: "😀".repeat(301) })).toBeNull();
  expect(drop({ text: "x".repeat(100_000) })).toBeNull();
  expect(drop({ outer_html: "<p>" + "x".repeat(1000) + "</p>" })).toBeNull();
  expect(drop({ selector: "p".repeat(2001) })).toBeNull();
  expect(drop({ selector: "   " })).toBeNull();
  expect(drop({ tag: "p onclick=x" })).toBeNull();
  expect(drop({ tag: "o:p" })).toBeNull();
  expect(drop({ text: 12 })).toBeNull();
  expect(drop({ rect: { x: "0", y: 0, w: 1, h: 1 } })).toBeNull();
  expect(drop({ rect: { x: Number.NaN, y: 0, w: 1, h: 1 } })).toBeNull();
  expect(drop({ rect: { x: 0, y: Number.POSITIVE_INFINITY, w: 1, h: 1 } })).toBeNull();
  // At the limit is fine: 300 characters, counted as characters, not UTF-16 units.
  expect(drop({ text: "😀".repeat(300) })?.type).toBe("pick");
});

test("the rect is clamped into the document before it becomes an anchor", () => {
  const reply = validatePickerMessage(pickEvent(goodAnchor({ rect: { x: -0.2, y: 0.9, w: 1.5, h: 0.4 } })), frameWindow, CH);
  const anchor = (reply as { anchor: HtmlElementAnchor }).anchor;
  expect(anchor.rect).toEqual({ x: 0, y: 0.9, w: 1, h: expect.closeTo(0.1, 9) as unknown as number });
  expect(validateAnchor("html_element", anchor).ok).toBe(true);
});

test("ready must hand over exactly one port; missing must answer with mark numbers and a revision", () => {
  const { port1, port2 } = new MessageChannel();
  const ready = { source: frameWindow, data: { channel: CH, type: "ready" } };
  expect(validatePickerMessage({ ...ready, ports: [port2] }, frameWindow, CH)).toEqual({ type: "ready", port: port2 });
  expect(validatePickerMessage({ ...ready, ports: [] }, frameWindow, CH)).toBeNull();
  expect(validatePickerMessage({ ...ready, ports: [port1, port2] }, frameWindow, CH)).toBeNull();
  expect(validatePickerMessage({ ...ready, ports: [{}] }, frameWindow, CH)).toBeNull();
  port1.close();
  port2.close();
  const missing = (ns: unknown, rev: unknown = 3) => validatePickerMessage({ source: frameWindow, data: { channel: CH, type: "missing", ns, rev } }, frameWindow, CH);
  expect(missing([2, 5, 2])).toEqual({ type: "missing", ns: [2, 5], rev: 3 });
  expect(missing([])).toEqual({ type: "missing", ns: [], rev: 3 });
  expect(missing([0])).toBeNull();
  expect(missing([1.5])).toBeNull();
  expect(missing(["1"])).toBeNull();
  expect(missing("1,2")).toBeNull();
  expect(missing(new Array(501).fill(1))).toBeNull();
  expect(missing([1], -1)).toBeNull();
});

// ---------------------------------------------------------------------------------------------
// CSS paths, text, markup, rect
// ---------------------------------------------------------------------------------------------

function pageWindow(body: string, head = ""): Window & { document: Document } {
  const win = new Window({ url: "http://localhost/" });
  win.document.write(`<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`);
  return win as unknown as Window & { document: Document };
}

const SAMPLE = `
  <main>
    <section><h2>A</h2><p>one</p><p>two <b>bold</b></p></section>
    <section id="dup"><p>x</p></section>
    <div id="dup"><span>y</span></div>
    <div id="solo"><ul><li>1</li><li>2</li><li><b>3</b></li></ul></div>
    <div id="9lives"><em>z</em></div>
    <svg><g><rect width="1" height="1"></rect></g><g><circle r="1"></circle><circle r="2"></circle></g></svg>
    <table><tbody><tr><td>c</td><td>d</td></tr></tbody></table>
  </main>
  <footer><p>end</p></footer>`;

test("every element's CSS path resolves back to that element", async () => {
  const win = pageWindow(SAMPLE);
  const doc = win.document;
  const all = [...doc.body.querySelectorAll("*")];
  expect(all.length).toBeGreaterThan(20);
  for (const el of all) expect(doc.querySelector(cssPathFor(el))).toBe(el);
  expect(doc.querySelector(cssPathFor(doc.body))).toBe(doc.body);
  await (win as unknown as { happyDOM: { close(): Promise<void> } }).happyDOM.close();
});

test("paths use :nth-of-type where siblings share a tag, and ids only when unique and plain", async () => {
  const win = pageWindow(SAMPLE);
  const doc = win.document;
  const ps = doc.querySelectorAll("main > section:first-child p");
  expect(cssPathFor(ps[1]!)).toBe("body > main > section:nth-of-type(1) > p:nth-of-type(2)");
  expect(cssPathFor(doc.querySelector("#solo li:nth-child(3) b")!)).toBe("#solo > ul > li:nth-of-type(3) > b");
  // Two elements share id="dup": the id is not used.
  expect(cssPathFor(doc.querySelector("div#dup span")!)).toBe("body > main > div:nth-of-type(1) > span");
  // An id that would need escaping is not used either.
  expect(cssPathFor(doc.querySelector("em")!)).toBe("body > main > div:nth-of-type(3) > em");
  expect(cssPathFor(doc.querySelector("footer p")!)).toBe("body > footer > p");
  expect(cssPathFor(doc.querySelectorAll("circle")[1]!)).toBe("body > main > svg > g:nth-of-type(2) > circle:nth-of-type(2)");
  await (win as unknown as { happyDOM: { close(): Promise<void> } }).happyDOM.close();
});

test("text skips scripts and styles, collapses whitespace, and stops at 300 characters", async () => {
  const win = pageWindow(`
    <article>  Hello
      <script>secret()</script><style>p{}</style>
      <span>world</span>\n\t!</article>
    <img alt="  a  cat " src="x.png">
    <ul id="list"><li>One</li><li>Two</li><li><p>Three</p></li></ul>
    <p id="inline">un-<b>bro</b><em>ken</em> words</p>
    <div id="mixed"><h3>Title</h3>body<br>text</div>
    <p id="long">${"😀".repeat(400)}</p>
    <p id="spaced">${"ab ".repeat(200)}</p>
    <p id="huge">${"😀".repeat(1200)}</p>`);
  const doc = win.document;
  expect(elementText(doc.querySelector("article")!, 300)).toBe("Hello world !");
  // Blocks break words, inline elements do not.
  expect(elementText(doc.querySelector("#list")!, 300)).toBe("One Two Three");
  expect(elementText(doc.querySelector("#inline")!, 300)).toBe("un-broken words");
  expect(elementText(doc.querySelector("#mixed")!, 300)).toBe("Title body text");
  expect(elementText(doc.querySelector("img")!, 300)).toBe("a cat");
  const long = elementText(doc.querySelector("#long")!, 300);
  expect([...long].length).toBe(300);
  const spaced = elementText(doc.querySelector("#spaced")!, 300);
  expect([...spaced].length).toBeLessThanOrEqual(300);
  expect(spaced).toBe(spaced.trim());
  expect([...outerHtmlOf(doc.querySelector("#huge")!, 1000)].length).toBe(1000);
  expect(outerHtmlOf(doc.querySelector("#huge")!, 1000)).not.toMatch(/[\uD800-\uDBFF]$/);
  expect(outerHtmlOf(doc.querySelector("img")!, 1000)).toBe('<img alt="  a  cat " src="x.png">');
  expect(tagOf(doc.querySelector("article")!)).toBe("article");
  await (win as unknown as { happyDOM: { close(): Promise<void> } }).happyDOM.close();
});

test("the rect is the element's box over the document's scroll size, kept within 0–1", async () => {
  const win = pageWindow("<div>box</div>");
  const doc = win.document;
  const el = doc.querySelector("div")!;
  Object.defineProperty(doc.documentElement, "scrollWidth", { value: 1000, configurable: true });
  Object.defineProperty(doc.documentElement, "scrollHeight", { value: 4000, configurable: true });
  Object.defineProperty(win, "pageYOffset", { value: 500, configurable: true });
  el.getBoundingClientRect = () => ({ left: 100, top: 300, width: 250, height: 200, right: 350, bottom: 500, x: 100, y: 300, toJSON: () => ({}) }) as DOMRect;
  expect(docRect(el, win as unknown as Window)).toEqual({ x: 0.1, y: 0.2, w: 0.25, h: 0.05 });
  el.getBoundingClientRect = () => ({ left: -50, top: -600, width: 5000, height: 99999, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const r = docRect(el, win as unknown as Window);
  expect(r.x).toBe(0);
  expect(r.y).toBe(0);
  expect(r.w).toBe(1);
  expect(r.h).toBe(1);
  await (win as unknown as { happyDOM: { close(): Promise<void> } }).happyDOM.close();
});

test("a page that scrolls its <body> instead of the viewport still gets its rect in document terms", async () => {
  const win = pageWindow("<div>box</div>");
  const doc = win.document;
  const el = doc.querySelector("div")!;
  Object.defineProperty(doc.documentElement, "scrollWidth", { value: 1000, configurable: true });
  Object.defineProperty(doc.documentElement, "scrollHeight", { value: 800, configurable: true });
  Object.defineProperty(doc.body, "scrollWidth", { value: 1000, configurable: true });
  Object.defineProperty(doc.body, "scrollHeight", { value: 4000, configurable: true });
  Object.defineProperty(doc.body, "scrollTop", { value: 500, configurable: true });
  Object.defineProperty(win, "pageYOffset", { value: 0, configurable: true });
  el.getBoundingClientRect = () => ({ left: 100, top: 300, width: 250, height: 200, right: 350, bottom: 500, x: 100, y: 300, toJSON: () => ({}) }) as DOMRect;
  expect(docRect(el, win as unknown as Window)).toEqual({ x: 0.1, y: 0.2, w: 0.25, h: 0.05 });
  await (win as unknown as { happyDOM: { close(): Promise<void> } }).happyDOM.close();
});

test("tag names are cut to what the messenger accepts", async () => {
  const long = `x-${"a".repeat(90)}`;
  const win = pageWindow(`<${long}>hi</${long}>`);
  const tag = tagOf(win.document.querySelector(long)!);
  expect(tag.length).toBe(64);
  expect(tag).toMatch(/^[a-z][a-z0-9-]*$/);
  await (win as unknown as { happyDOM: { close(): Promise<void> } }).happyDOM.close();
});

// ---------------------------------------------------------------------------------------------
// The picker, running in a page
// ---------------------------------------------------------------------------------------------

type Posted = { data: Record<string, unknown>; transfer: unknown[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWin = any;

/** A happy-dom page with the picker run in it, as the injected script would run: before the page's scripts. */
function runPicker(body: string, opts: { head?: string; framed?: boolean; settleMs?: number; beforeRun?: (win: AnyWin) => void } = {}) {
  const win: AnyWin = new Window({ url: "http://localhost/" });
  win.document.write(`<!DOCTYPE html><html><head>${opts.head ?? ""}</head><body>${body}</body></html>`);
  const posted: Posted[] = [];
  const parent = {
    postMessage(data: Record<string, unknown>, origin: string, transfer?: unknown[]) {
      expect(origin).toBe("*");
      posted.push({ data, transfer: transfer ?? [] });
    },
  };
  if (opts.framed !== false) Object.defineProperty(win, "parent", { value: parent, configurable: true });
  win.MessageChannel = MessageChannel;
  win.MessagePort = MessagePort;
  opts.beforeRun?.(win);
  new Function("window", pickerScriptSource(CH, { settleMs: opts.settleMs ?? 0 }))(win);
  const ready = posted.find((p) => p.data.type === "ready");
  const port = ready?.transfer[0] as MessagePort | undefined;
  const doc: Document = win.document;
  return {
    win,
    doc,
    posted,
    parent,
    port,
    of: (type: string) => posted.filter((p) => p.data.type === type).map((p) => p.data),
    async send(data: unknown) {
      port!.postMessage(data);
      await settle();
    },
    hover(el: Element) {
      el.dispatchEvent(new win.PointerEvent("pointerover", { bubbles: true }));
    },
    click(el: Element) {
      const ev = new win.MouseEvent("click", { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev as MouseEvent;
    },
    key(key: string, init: Record<string, unknown> = {}) {
      const ev = new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      doc.body.dispatchEvent(ev);
      return ev as KeyboardEvent;
    },
    layer: () => doc.documentElement.querySelector("rb-annot-layer") as HTMLElement | null,
    async close() {
      port?.close();
      await win.happyDOM.close();
    },
  };
}

const PAGE = `<main><h1>Title</h1><section><p id="first">one</p><p>two <a href="https://example.com/">link</a></p><script>page()</script><ul><li>a</li></ul></section></main>`;
const mark = (over: Partial<PickerMark> = {}): PickerMark => ({ n: 1, selector: "main > h1", status: "open", stale: false, check: false, text: "", ...over });

test("the picker hands over a port, and says nothing until it is framed", async () => {
  const page = runPicker(PAGE);
  expect(page.posted).toHaveLength(1);
  expect(page.posted[0]!.data).toEqual({ channel: CH, type: "ready" });
  expect(page.port).toBeDefined();
  expect(page.layer()).toBeNull();
  await page.close();
  const top = runPicker(PAGE, { framed: false });
  expect(top.posted).toHaveLength(0);
  await top.close();
});

test("the picker removes its own script tag before the page's scripts can read the channel", async () => {
  const page = runPicker(PAGE, {
    beforeRun(win) {
      const script = win.document.createElement("script");
      script.textContent = `/* ${CH} */`;
      win.document.head.appendChild(script);
      Object.defineProperty(win.document, "currentScript", { value: script, configurable: true });
    },
  });
  expect(page.doc.documentElement.outerHTML).not.toContain(CH);
  await page.close();
});

test("hover outlines, click picks without the page seeing the click, and the pick passes the messenger's checks", async () => {
  const page = runPicker(PAGE);
  const pageClicks: string[] = [];
  // The page's own handler, registered after the picker like any page script.
  page.win.addEventListener("click", () => pageClicks.push("window"), true);
  page.doc.querySelector("a")!.addEventListener("click", () => pageClicks.push("link"));

  // Not picking yet: the page behaves as usual.
  page.click(page.doc.querySelector("#first")!);
  expect(pageClicks).toEqual(["window"]);
  expect(page.of("pick")).toHaveLength(0);

  await page.send(marksMessage(CH, [], { picking: true, rev: 1 }));
  const link = page.doc.querySelector("a")!;
  page.hover(link);
  const layer = page.layer()!;
  expect(layer).not.toBeNull();
  expect(layer.parentElement).toBe(page.doc.documentElement);
  expect(layer.style.getPropertyValue("pointer-events")).toBe("none");
  const boxes = [...layer.querySelectorAll("rb-annot-box")] as HTMLElement[];
  expect(boxes).toHaveLength(1);
  expect(boxes.every((b) => b.style.getPropertyValue("pointer-events") === "none")).toBe(true);
  expect(boxes[0]!.textContent).toBe("a");

  const ev = page.click(link);
  expect(ev.defaultPrevented).toBe(true);
  expect(pageClicks).toEqual(["window"]);
  const [pick] = page.of("pick");
  expect(pick).toBeDefined();
  const anchor = pick!.anchor as HtmlElementAnchor;
  expect(anchor.tag).toBe("a");
  expect(anchor.text).toBe("link");
  expect(anchor.outer_html).toBe('<a href="https://example.com/">link</a>');
  expect(page.doc.querySelector(anchor.selector)).toBe(link);
  const reply = validatePickerMessage({ source: page.parent, data: pick }, page.parent, CH);
  expect(reply).toEqual({ type: "pick", anchor });
  await page.close();
});

test("↑ and ↓ move the outline to the parent and first child, Enter picks it", async () => {
  const page = runPicker(PAGE);
  await page.send(marksMessage(CH, [], { picking: true, rev: 1 }));
  page.hover(page.doc.querySelector("#first")!);
  expect(page.key("ArrowUp").defaultPrevented).toBe(true);
  page.key("Enter");
  expect((page.of("pick")[0]!.anchor as HtmlElementAnchor).selector).toBe("body > main > section");
  page.key("ArrowUp");
  page.key("ArrowUp");
  page.key("ArrowUp");
  page.key("Enter");
  // Up stops at <body>.
  expect((page.of("pick")[1]!.anchor as HtmlElementAnchor).selector).toBe("body");
  page.key("ArrowDown");
  page.key("ArrowDown");
  page.key("Enter");
  expect((page.of("pick")[2]!.anchor as HtmlElementAnchor).selector).toBe("body > main > h1");
  // Down skips what is not drawn: the section's first element child is a <p>, and <script> never is.
  page.hover(page.doc.querySelector("section")!);
  page.key("ArrowDown");
  page.key("Enter");
  expect((page.of("pick")[3]!.anchor as HtmlElementAnchor).selector).toBe("#first");
  await page.close();
});

test("Escape posts cancel, removes the layer and every listener: the page gets its clicks back", async () => {
  const page = runPicker(PAGE);
  const pageClicks: string[] = [];
  page.doc.querySelector("a")!.addEventListener("click", () => pageClicks.push("link"));
  await page.send(marksMessage(CH, [mark()], { picking: true, rev: 1 }));
  page.hover(page.doc.querySelector("a")!);
  expect(page.layer()).not.toBeNull();
  expect(page.key("Escape").defaultPrevented).toBe(true);
  expect(page.of("cancel")).toEqual([{ channel: CH, type: "cancel" }]);
  expect(page.layer()).toBeNull();
  const before = page.posted.length;
  page.click(page.doc.querySelector("a")!);
  page.key("ArrowUp");
  page.key("Escape");
  await page.send(marksMessage(CH, [mark()], { picking: true, rev: 2 }));
  expect(pageClicks).toEqual(["link"]);
  expect(page.posted.length).toBe(before);
  expect(page.layer()).toBeNull();
  await page.close();
});

test("existing marks are drawn numbered in their status; the pending element gets its own outline", async () => {
  const page = runPicker(PAGE);
  await page.send(
    marksMessage(CH, [mark({ n: 1, selector: "main > h1" }), mark({ n: 2, selector: "#first", status: "draft" }), mark({ n: 4, selector: "ul > li", status: "resolved" }), mark({ n: 5, selector: "#nowhere" })], {
      pending: "body > main > section > p:nth-of-type(2)",
      picking: false,
      rev: 1,
    }),
  );
  const boxes = [...page.layer()!.querySelectorAll(":scope > rb-annot-box")] as HTMLElement[];
  // Four marks and the pending one; no hover outline while not picking.
  expect(boxes).toHaveLength(5);
  expect(boxes.slice(0, 4).map((b) => b.textContent)).toEqual(["1", "2", "4", "5"]);
  expect(boxes[0]!.style.getPropertyValue("border")).toContain("solid");
  expect(boxes[1]!.style.getPropertyValue("border")).toContain("dotted");
  expect(boxes[2]!.style.getPropertyValue("border")).toContain("#8b929c");
  expect(boxes[4]!.style.getPropertyValue("border")).toContain("3px");
  // A mark whose element is not in the page is not shown.
  expect(boxes[3]!.style.getPropertyValue("display")).toBe("none");
  // Not picking: the page keeps its clicks.
  page.click(page.doc.querySelector("#first")!);
  expect(page.of("pick")).toHaveLength(0);
  await page.close();
});

test("after a change, marks whose element or text is gone are reported by number, and not drawn", async () => {
  const page = runPicker(PAGE);
  if (page.doc.readyState !== "complete") page.win.dispatchEvent(new page.win.Event("load"));
  await page.send(
    marksMessage(
      CH,
      [
        mark({ n: 1, selector: "main > h1", stale: true, check: true, text: "Title" }),
        mark({ n: 2, selector: "#first", stale: true, check: true, text: "an older sentence" }),
        mark({ n: 3, selector: "main > aside", stale: true, check: true, text: "gone" }),
        mark({ n: 4, selector: "ul > li" }),
      ],
      { picking: true, rev: 7 },
    ),
  );
  await settle(30);
  expect(page.of("missing")).toEqual([{ channel: CH, type: "missing", ns: [2, 3], rev: 7 }]);
  const numbers = [...page.layer()!.querySelectorAll("rb-annot-box > rb-annot-badge")].map((b) => b.textContent).filter(Boolean);
  expect(numbers).toEqual(["1", "4"]);
  await page.close();
});

test("focus scrolls to the mark; ↑ ↓ from the messenger move a pending anchor, which is picked again", async () => {
  const page = runPicker(PAGE);
  const scrolled: string[] = [];
  page.doc.querySelector("h1")!.scrollIntoView = () => scrolled.push("h1");
  await page.send(marksMessage(CH, [mark({ n: 3, selector: "main > h1" })], { picking: true, pending: "#first", rev: 1 }));
  await page.send(focusMessage(CH, 3));
  expect(scrolled).toEqual(["h1"]);
  await page.send(navMessage(CH, "up"));
  expect((page.of("pick")[0]!.anchor as HtmlElementAnchor).selector).toBe("body > main > section");
  // Without the channel, the port's messages are ignored too.
  await page.send({ ...navMessage(CH, "up"), channel: "f".repeat(32) });
  await page.send({ type: "nav", dir: "up" });
  expect(page.of("pick")).toHaveLength(1);
  await page.close();
});

test("the messenger's messages never reach the page's listeners, and tampered prototypes see no channel", async () => {
  const page = runPicker(PAGE);
  const seen: unknown[] = [];
  page.win.addEventListener("message", (ev: MessageEvent) => seen.push(ev.data));
  const leaks: unknown[] = [];
  const proto = Object.prototype as Record<string, unknown>;
  const realHasOwn = Object.prototype.hasOwnProperty;
  // What a page script could do after the picker started: patch the prototype the messenger's
  // objects inherit from, hoping the picker reads through it.
  Object.defineProperty(proto, "pending", { configurable: true, get(this: Record<string, unknown>) { leaks.push(this); return undefined; } });
  Object.defineProperty(proto, "rev", { configurable: true, get(this: Record<string, unknown>) { leaks.push(this); return undefined; } });
  Object.prototype.hasOwnProperty = function (this: object, key: PropertyKey) {
    leaks.push(this);
    return realHasOwn.call(this, key);
  };
  try {
    await page.send({ channel: CH, type: "marks", marks: [mark()], picking: true });
  } finally {
    Object.prototype.hasOwnProperty = realHasOwn;
    delete proto.pending;
    delete proto.rev;
  }
  expect(seen).toEqual([]);
  expect(leaks.filter((o) => o && typeof o === "object" && (o as { channel?: unknown }).channel === CH)).toEqual([]);
  // And the marks were still applied.
  expect(page.layer()!.querySelector("rb-annot-badge")?.textContent).toBe("1");
  await page.close();
});

test("every element the picker can pick becomes an anchor that the messenger and validateAnchor accept", async () => {
  const long = `x-${"b".repeat(80)}`;
  const page = runPicker(
    `${SAMPLE}
    <${long}>custom</${long}>
    <p id="huge">${"字".repeat(900)} ${"😀".repeat(900)}</p>
    <div><span></span><img src="x.png"><input placeholder=" type  here "><br><hr></div>
    <pre>  keep
      spaces  </pre>
    <p>${"<b>x</b>".repeat(400)}</p>`,
  );
  await page.send(marksMessage(CH, [], { picking: true, rev: 1 }));
  const elements = [...page.doc.body.querySelectorAll("*")].filter((el) => !el.closest("rb-annot-layer"));
  expect(elements.length).toBeGreaterThan(400);
  for (const el of elements) {
    const before = page.of("pick").length;
    page.hover(el);
    page.click(el);
    const picks = page.of("pick");
    expect(picks.length).toBe(before + 1);
    const data = picks.at(-1)!;
    const reply = validatePickerMessage({ source: page.parent, data }, page.parent, CH);
    expect(reply?.type).toBe("pick");
    const anchor = (reply as { anchor: HtmlElementAnchor }).anchor;
    expect(validateAnchor("html_element", anchor).ok).toBe(true);
    expect(page.doc.querySelector(anchor.selector)).toBe(el);
  }
  // And <body> itself, which a click on the page's margin picks.
  page.click(page.doc.documentElement);
  const last = validatePickerMessage({ source: page.parent, data: page.of("pick").at(-1) }, page.parent, CH);
  expect((last as { anchor: HtmlElementAnchor }).anchor.selector).toBe("body");
  await page.close();
});

test("Escape leaves from the page even before the first marks arrive or when nothing can be chosen", async () => {
  const early = runPicker(PAGE);
  expect(early.key("Escape").defaultPrevented).toBe(true);
  expect(early.of("cancel")).toHaveLength(1);
  await early.close();

  const idle = runPicker(PAGE);
  await idle.send(marksMessage(CH, [mark()], { picking: false, rev: 1 }));
  // Composing text (an IME) keeps its Escape.
  expect(idle.key("Escape", { isComposing: true }).defaultPrevented).toBe(false);
  expect(idle.of("cancel")).toHaveLength(0);
  idle.key("Escape");
  expect(idle.of("cancel")).toHaveLength(1);
  expect(idle.layer()).toBeNull();
  await idle.close();
});

test("Enter does not pick an element the page has since removed", async () => {
  const page = runPicker(PAGE);
  await page.send(marksMessage(CH, [], { picking: true, rev: 1 }));
  const h1 = page.doc.querySelector("h1")!;
  page.hover(h1);
  h1.remove();
  page.key("Enter");
  expect(page.of("pick")).toHaveLength(0);
  await page.close();
});

/** An event a page script made up: a browser marks it `isTrusted: false` (happy-dom leaves it undefined). */
function untrusted<E extends Event>(ev: E): E {
  Object.defineProperty(ev, "isTrusted", { value: false });
  return ev;
}

test("the page's own synthetic events neither pick, move the outline nor leave, and reach the page untouched", async () => {
  const page = runPicker(PAGE);
  await page.send(marksMessage(CH, [mark()], { picking: true, rev: 1 }));
  const h1 = page.doc.querySelector("h1")!;
  const first = page.doc.querySelector("#first")!;
  const link = page.doc.querySelector("a")!;
  const pageSaw: string[] = [];
  first.addEventListener("click", () => pageSaw.push("click"));
  page.doc.addEventListener("keydown", (ev: KeyboardEvent) => pageSaw.push(ev.key));

  // The person hovers the heading; a page script then pretends the pointer moved to the link.
  page.hover(h1);
  link.dispatchEvent(untrusted(new page.win.PointerEvent("pointerover", { bubbles: true })));
  // A made-up click picks nothing and is the page's own business.
  const fakeClick = untrusted(new page.win.MouseEvent("click", { bubbles: true, cancelable: true }));
  first.dispatchEvent(fakeClick);
  expect(fakeClick.defaultPrevented).toBe(false);
  expect(pageSaw).toEqual(["click"]);
  // Made-up keys: no move, no pick, no leaving.
  for (const key of ["ArrowUp", "Enter", "Escape"]) {
    const ev = untrusted(new page.win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    page.doc.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  }
  expect(pageSaw).toEqual(["click", "ArrowUp", "Enter", "Escape"]);
  expect(page.of("pick")).toHaveLength(0);
  expect(page.of("cancel")).toHaveLength(0);
  expect(page.layer()).not.toBeNull();

  // The person's Enter picks what the person pointed at.
  page.key("Enter");
  expect((page.of("pick")[0]!.anchor as HtmlElementAnchor).selector).toBe("body > main > h1");
  // With an element pending, a made-up click does not re-point it either.
  await page.send(marksMessage(CH, [mark()], { picking: true, pending: "body > main > h1", rev: 2 }));
  first.dispatchEvent(untrusted(new page.win.MouseEvent("click", { bubbles: true, cancelable: true })));
  expect(page.of("pick")).toHaveLength(1);
  page.key("Escape");
  expect(page.of("cancel")).toHaveLength(1);
  await page.close();
});

test("leaving never hands the picker's handlers to a removeEventListener the page patched", async () => {
  // Keep the picker waiting on DOMContentLoaded and load, so leaving has those to remove too.
  const page = runPicker(PAGE, {
    beforeRun(win) {
      Object.defineProperty(win.document, "readyState", { value: "loading", configurable: true });
    },
  });
  await page.send(marksMessage(CH, [mark()], { picking: true, rev: 1 }));
  const handed: unknown[] = [];
  const spy = (type: string, fn: unknown) => handed.push([type, fn]);
  // What a page script can do after the picker started: shadow the method on window and document,
  // and patch the prototype the document inherits it from.
  let owner = Object.getPrototypeOf(page.doc);
  while (owner && !Object.prototype.hasOwnProperty.call(owner, "removeEventListener")) owner = Object.getPrototypeOf(owner);
  const real = owner.removeEventListener;
  const winOwn = Object.getOwnPropertyDescriptor(page.win, "removeEventListener");
  page.win.removeEventListener = spy;
  (page.doc as unknown as Record<string, unknown>).removeEventListener = spy;
  owner.removeEventListener = spy;
  try {
    page.key("Escape");
  } finally {
    owner.removeEventListener = real;
    if (winOwn) Object.defineProperty(page.win, "removeEventListener", winOwn);
    else delete page.win.removeEventListener;
    delete (page.doc as unknown as Record<string, unknown>).removeEventListener;
  }
  expect(page.of("cancel")).toHaveLength(1);
  expect(handed).toEqual([]);
  // And the listeners are gone: the page gets its clicks back.
  const pageClicks: string[] = [];
  page.doc.querySelector("a")!.addEventListener("click", () => pageClicks.push("link"));
  page.click(page.doc.querySelector("a")!);
  expect(pageClicks).toEqual(["link"]);
  expect(page.of("pick")).toHaveLength(0);
  await page.close();
});

test("resending the same marks (a new pending, picking toggled) keeps a re-checked mark drawn while it is checked again", async () => {
  const page = runPicker(PAGE, { settleMs: 120 });
  if (page.doc.readyState !== "complete") page.win.dispatchEvent(new page.win.Event("load"));
  const checked = [mark({ n: 1, selector: "main > h1", stale: true, check: true, text: "Title" })];
  const badges = () => [...page.layer()!.querySelectorAll("rb-annot-box > rb-annot-badge")].map((b) => b.textContent).filter(Boolean);
  await page.send(marksMessage(CH, checked, { picking: true, rev: 1 }));
  // Not drawn until the check has found it.
  expect(badges()).toEqual([]);
  await settle(200);
  expect(page.of("missing")).toEqual([{ channel: CH, type: "missing", ns: [], rev: 1 }]);
  expect(badges()).toEqual(["1"]);
  // Same marks, new pending: still drawn right away, and checked again under the new revision.
  await page.send(marksMessage(CH, checked, { picking: true, pending: "#first", rev: 2 }));
  expect(badges()).toEqual(["1"]);
  await settle(200);
  expect(page.of("missing").at(-1)).toEqual({ channel: CH, type: "missing", ns: [], rev: 2 });
  // Different marks to check: hidden again until their own check.
  await page.send(marksMessage(CH, [mark({ n: 1, selector: "main > h1", stale: true, check: true, text: "Other" })], { picking: true, rev: 3 }));
  expect(badges()).toEqual([]);
  await settle(200);
  expect(page.of("missing").at(-1)).toEqual({ channel: CH, type: "missing", ns: [1], rev: 3 });
  expect(badges()).toEqual([]);
  await page.close();
});

// ---------------------------------------------------------------------------------------------
// Marks as the messenger sends them
// ---------------------------------------------------------------------------------------------

function row(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    status: "open",
    relpath: "site/index.html",
    anchor_kind: "html_element",
    anchor: { selector: "body > main > h1", tag: "h1", text: "Title", outer_html: "<h1>Title</h1>", rect: { x: 0, y: 0, w: 1, h: 0.1 } },
    content_sha256: "0".repeat(64),
    target_message_id: "m1",
    target_session_id: "sess-1",
    target_turn_id: null,
    bot_id: "bot-1",
    session_id: "sess-1",
    message_id: "m2",
    body: "标题太长",
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

test("marks are numbered over every row, skip rows whose file is gone, and carry text only to re-check", () => {
  const marks = pickerMarks([
    row(),
    row({ id: "gone", stale: { kind: "missing" } }),
    row({ id: "changed", status: "draft", stale: { kind: "changed" } }),
  ]);
  expect(marks).toEqual([
    { n: 1, selector: "body > main > h1", status: "open", stale: false, check: false, text: "" },
    { n: 3, selector: "body > main > h1", status: "draft", stale: true, check: true, text: "Title" },
  ]);
  const msg = marksMessage(CH, marks, { pending: "#first", picking: true, rev: 2 });
  expect(msg).toEqual({ channel: CH, type: "marks", marks, pending: "#first", picking: true, rev: 2 });
  expect(() => structuredClone(msg)).not.toThrow();
});

// ---------------------------------------------------------------------------------------------
// The annotator component
// ---------------------------------------------------------------------------------------------

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

const blobs = new Map<string, Blob>();
const revoked: string[] = [];
let realCreate: typeof URL.createObjectURL;
let realRevoke: typeof URL.revokeObjectURL;

// happy-dom would try to navigate the iframe to the fake blob URL; the page inside is not what
// these tests look at (the picker tests above run it directly).
const happy = (globalThis as unknown as { happyDOM?: { settings: { navigation: { disableChildFrameNavigation: boolean } } } }).happyDOM;
let childFrames = false;

beforeEach(() => {
  if (happy) {
    childFrames = happy.settings.navigation.disableChildFrameNavigation;
    happy.settings.navigation.disableChildFrameNavigation = true;
  }
  blobs.clear();
  revoked.length = 0;
  realCreate = URL.createObjectURL;
  realRevoke = URL.revokeObjectURL;
  let n = 0;
  URL.createObjectURL = (blob: Blob) => {
    n += 1;
    const url = `blob:test/${n}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
});

afterEach(() => {
  if (happy) happy.settings.navigation.disableChildFrameNavigation = childFrames;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

type Calls = { drafts: Array<{ anchor: HtmlElementAnchor; crop?: unknown }>; picks: string[]; changes: HtmlElementAnchor[]; cancels: number; missing: string[][] };

function annotator(over: Record<string, unknown> = {}) {
  const calls: Calls = { drafts: [], picks: [], changes: [], cancels: 0, missing: [] };
  const props = reactive({
    html: "<!DOCTYPE html><html><head><style>h1{}</style></head><body><main><h1>Title</h1></main><script>go()</script></body></html>",
    scheme: "light" as "light" | "dark",
    title: "site/index.html",
    annotations: [] as Annotation[],
    focusId: null as string | null,
    active: false,
    enabled: true,
    labels,
    nonce: NONCE,
    pending: null as HtmlElementAnchor | null,
    onDraft: (draft: { anchor: HtmlElementAnchor; crop?: unknown }) => calls.drafts.push(draft),
    onPick: (id: string) => calls.picks.push(id),
    onPendingChange: (anchor: HtmlElementAnchor) => calls.changes.push(anchor),
    onCancel: () => {
      calls.cancels += 1;
    },
    onMissing: (ids: string[]) => calls.missing.push(ids),
    ...over,
  });
  const view = render(HtmlAnnotator, props);
  const frame = () => view.host.querySelector("iframe") as HTMLIFrameElement;
  const source = async () => blobs.get(frame().getAttribute("src")!)!.text();
  const channelOf = async () => (await source()).match(/"channel":"([0-9a-f]{32})"/)?.[1] ?? null;
  const say = (data: unknown, extra: { source?: unknown; ports?: MessagePort[] } = {}) => {
    window.dispatchEvent(new MessageEvent("message", { data, source: ("source" in extra ? extra.source : frame().contentWindow) as Window, ports: extra.ports ?? [] }));
    flushSync();
  };
  return { ...view, props, calls, frame, source, channelOf, say };
}

test("in normal view the iframe is today's preview: same sandbox, no picker, the page's scripts carry the nonce", async () => {
  const view = annotator();
  const frame = view.frame();
  expect(frame.classList.contains("artifact-frame")).toBe(true);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-modals");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(frame.getAttribute("title")).toBe("site/index.html");
  const html = await view.source();
  expect(html).not.toContain("rb-annot");
  expect(html).toContain(`<script nonce="${NONCE}">go()</script>`);
  expect(html).toContain('<meta name="color-scheme" content="light">');
  expect(view.host.querySelector("[data-html-annot-bar]")).toBeNull();
  view.close();
});

test("annotate mode reloads with the picker first in the page, and leaving it reloads without", async () => {
  const view = annotator();
  const plain = view.frame().getAttribute("src")!;
  view.props.active = true;
  flushSync();
  const annotating = view.frame().getAttribute("src")!;
  expect(annotating).not.toBe(plain);
  expect(revoked).toContain(plain);
  const doc = parsed(await view.source());
  const first = firstScript(doc);
  expect(first.getAttribute("nonce")).toBe(NONCE);
  expect(first.textContent).toContain("rb-annot-layer");
  expect(doc.head.contains(first)).toBe(true);
  expect(view.frame().getAttribute("sandbox")).toBe("allow-scripts allow-modals");
  expect(view.host.querySelector(".html-annot-hint")?.textContent).toBe(labels.hint);
  view.props.active = false;
  flushSync();
  expect(revoked).toContain(annotating);
  expect(await view.source()).not.toContain("rb-annot-layer");
  view.close();
});

test("only the iframe's own window with this injection's channel can hand in a pick; there is no crop", async () => {
  const view = annotator({ active: true });
  const channel = await view.channelOf();
  expect(channel).toMatch(/^[0-9a-f]{32}$/);
  const pick = { channel, type: "pick", anchor: goodAnchor() };
  view.say(pick, { source: window });
  view.say(pick, { source: null });
  view.say({ ...pick, channel: newChannel() });
  view.say({ ...pick, anchor: goodAnchor({ text: "x".repeat(301) }) });
  expect(view.calls.drafts).toEqual([]);
  view.say(pick);
  expect(view.calls.drafts).toHaveLength(1);
  expect(view.calls.drafts[0]!.anchor).toEqual(goodAnchor() as HtmlElementAnchor);
  expect(view.calls.drafts[0]!.crop).toBeUndefined();
  // A pick while one is pending moves it instead.
  view.props.pending = view.calls.drafts[0]!.anchor;
  flushSync();
  view.say({ ...pick, anchor: goodAnchor({ selector: "body > main", tag: "main" }) });
  expect(view.calls.changes.map((a) => a.selector)).toEqual(["body > main"]);
  expect(view.calls.drafts).toHaveLength(1);
  view.close();
});

test("nothing is created when creation is not allowed, but the existing marks are still drawn", async () => {
  const view = annotator({ active: true, enabled: false, annotations: [row({ id: "a" })] });
  const channel = (await view.channelOf())!;
  const { port1, port2 } = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  port1.onmessage = (ev) => got.push(ev.data as Record<string, unknown>);
  view.say({ channel, type: "ready" }, { ports: [port2] });
  await settle();
  expect(got[0]).toMatchObject({ type: "marks", picking: false });
  expect((got[0]!.marks as PickerMark[]).map((m) => m.n)).toEqual([1]);
  view.say({ channel, type: "pick", anchor: goodAnchor() });
  expect(view.calls.drafts).toEqual([]);
  expect(view.host.querySelector(".html-annot-nav")).toBeNull();
  expect(view.host.querySelectorAll(".html-annot-chip")).toHaveLength(1);
  port1.close();
  view.close();
});

test("the same marks handed in again as new row objects are not resent; a real change is", async () => {
  const rows = [row({ id: "a" }), row({ id: "b", status: "draft" })];
  const view = annotator({ active: true, annotations: rows });
  const channel = (await view.channelOf())!;
  const { port1, port2 } = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  port1.onmessage = (ev) => got.push(ev.data as Record<string, unknown>);
  view.say({ channel, type: "ready" }, { ports: [port2] });
  await settle();
  expect(got).toHaveLength(1);
  view.props.annotations = rows.map((r) => ({ ...r }));
  flushSync();
  await settle();
  expect(got).toHaveLength(1);
  // A focus still goes through when the list itself did not change.
  view.props.focusId = "b";
  flushSync();
  await settle();
  expect(got.at(-1)).toEqual({ channel, type: "focus", n: 2 });
  view.props.annotations = [rows[0]!, { ...rows[1]!, status: "open" }];
  flushSync();
  await settle();
  const marks = got.filter((m) => m.type === "marks");
  expect(marks).toHaveLength(2);
  expect((marks[1]!.marks as PickerMark[]).map((m) => m.status)).toEqual(["open", "open"]);
  expect(marks[1]!.rev).toBeGreaterThan(marks[0]!.rev as number);
  port1.close();
  view.close();
});

test("after the handshake the marks go through the port: numbered, pending, picking, and focus", async () => {
  const rows = [row({ id: "a" }), row({ id: "gone", stale: { kind: "missing" } }), row({ id: "c", status: "draft", body: "改成副标题" })];
  const view = annotator({ active: true, annotations: rows });
  const channel = (await view.channelOf())!;
  const { port1, port2 } = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  port1.onmessage = (ev) => got.push(ev.data as Record<string, unknown>);
  view.say({ channel, type: "ready" }, { ports: [port2] });
  await settle();
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({ channel, type: "marks", pending: null, picking: true });
  expect((got[0]!.marks as PickerMark[]).map((m) => m.n)).toEqual([1, 3]);

  // The bar shows the drawn rows by number, with their remark on hover; a click picks.
  const chips = [...view.host.querySelectorAll(".html-annot-chip")] as HTMLButtonElement[];
  expect(chips.map((c) => c.textContent)).toEqual(["1", "3"]);
  expect(chips[1]!.title).toBe("3. 改成副标题");
  expect(chips[1]!.classList.contains("is-draft")).toBe(true);
  expect(chips[1]!.getAttribute("aria-label")).toBe("第 3 条批注");
  click(chips[0]);
  expect(view.calls.picks).toEqual(["a"]);

  view.props.pending = goodAnchor() as HtmlElementAnchor;
  flushSync();
  await settle();
  expect(got.at(-1)).toMatchObject({ type: "marks", pending: goodAnchor().selector });
  expect(view.host.querySelector(".html-annot-hint")?.textContent).toBe(labels.pendingHint);

  view.props.focusId = "c";
  flushSync();
  await settle();
  expect(got.at(-1)).toEqual({ channel, type: "focus", n: 3 });

  click(view.host.querySelectorAll(".html-annot-nav")[0]);
  await settle();
  expect(got.at(-1)).toEqual({ channel, type: "nav", dir: "up" });
  port1.close();
  view.close();
});

test("the page's answer about missing elements names the rows, once per change, and a late answer is ignored", async () => {
  const rows = [row({ id: "a", stale: { kind: "changed" } }), row({ id: "b" }), row({ id: "c", stale: { kind: "changed" } })];
  const view = annotator({ active: true, annotations: rows });
  const channel = (await view.channelOf())!;
  const { port1, port2 } = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  port1.onmessage = (ev) => got.push(ev.data as Record<string, unknown>);
  view.say({ channel, type: "ready" }, { ports: [port2] });
  await settle();
  const rev = got[0]!.rev as number;
  expect((got[0]!.marks as PickerMark[]).filter((m) => m.check).map((m) => [m.n, m.text])).toEqual([[1, "Title"], [3, "Title"]]);
  view.say({ channel, type: "missing", ns: [3], rev: rev - 1 });
  expect(view.calls.missing).toEqual([]);
  // Row 2 was never asked about: a report on it is not believed.
  view.say({ channel, type: "missing", ns: [2, 3], rev });
  expect(view.calls.missing).toEqual([["c"]]);
  view.say({ channel, type: "missing", ns: [3], rev });
  expect(view.calls.missing).toEqual([["c"]]);
  const chip = view.host.querySelector('[data-annotation-id="c"]') as HTMLElement;
  expect(chip.classList.contains("is-missing")).toBe(true);
  expect(chip.title).toContain(labels.notFound);
  expect((view.host.querySelector('[data-annotation-id="a"]') as HTMLElement).title).toContain(labels.stale);
  view.say({ channel, type: "missing", ns: [], rev });
  expect(view.calls.missing).toEqual([["c"], []]);
  port1.close();
  view.close();
});

test("the picker's cancel reaches onCancel and reloads with a fresh channel", async () => {
  const view = annotator({ active: true });
  const channel = await view.channelOf();
  const before = view.frame().getAttribute("src");
  view.say({ channel, type: "cancel" }, { source: {} });
  expect(view.calls.cancels).toBe(0);
  view.say({ channel, type: "cancel" });
  expect(view.calls.cancels).toBe(1);
  expect(view.frame().getAttribute("src")).not.toBe(before);
  const next = await view.channelOf();
  expect(next).not.toBe(channel);
  // The old channel is dead.
  view.say({ channel, type: "pick", anchor: goodAnchor() });
  expect(view.calls.drafts).toEqual([]);
  view.close();
});

test("Escape in the messenger leaves annotate mode without closing the pane; outside annotate mode it passes", () => {
  const view = annotator({ active: true });
  let reachedWindow = 0;
  const onWindow = () => {
    reachedWindow += 1;
  };
  window.addEventListener("keydown", onWindow);
  try {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(view.calls.cancels).toBe(1);
    expect(reachedWindow).toBe(0);
    view.props.active = false;
    flushSync();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(view.calls.cancels).toBe(1);
    expect(reachedWindow).toBe(1);
    // A pending anchor alone is enough to catch it.
    view.props.pending = goodAnchor() as HtmlElementAnchor;
    flushSync();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(view.calls.cancels).toBe(2);
    expect(reachedWindow).toBe(1);
  } finally {
    window.removeEventListener("keydown", onWindow);
    view.close();
  }
});

test("a picker that never says hello (its script blocked by the CSP) turns the hint into a way out", async () => {
  const view = annotator({ active: true, readyWaitMs: 10 });
  const channel = (await view.channelOf())!;
  view.frame().dispatchEvent(new Event("load"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  flushSync();
  expect(view.host.querySelector(".html-annot-hint")?.textContent).toBe(labels.blocked);
  expect(view.host.querySelector(".html-annot-keys")).toBeNull();

  // A late hello still wins, and a picker that answers in time never shows it.
  const { port2 } = new MessageChannel();
  view.say({ channel, type: "ready" }, { ports: [port2] });
  expect(view.host.querySelector(".html-annot-hint")?.textContent).toBe(labels.hint);
  view.frame().dispatchEvent(new Event("load"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  flushSync();
  expect(view.host.querySelector(".html-annot-hint")?.textContent).toBe(labels.hint);
  view.close();
});

test("the object URLs are revoked when the annotator goes away", () => {
  const view = annotator();
  const url = view.frame().getAttribute("src")!;
  view.close();
  expect(revoked).toContain(url);
});
