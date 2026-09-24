/**
 * HTML 元素批注（#28）的选取器。单文件 HTML 跑在 sandbox="allow-scripts allow-modals" 的 iframe 里（不透明源，
 * 信使读不到它的 DOM），所以只在批注模式下往页面最前面注入一小段脚本：悬停描边，点一下回传元素的 CSS 路径、
 * 标签、文本、outer_html 和按文档尺寸归一化的位置；↑ ↓ 换到外层 / 内层，Enter 选定，Esc 退出。已有批注按
 * 信使给的编号画在页面上；文件变过的，顺带核对选择器还找不找得到、文本对不对得上，把找不到的编号报回来。
 *
 * 往来只有两条路：选取器 → 信使用 `parent.postMessage`，信使只收 `source` 是这个 iframe、带本次注入的随机
 * 通道号、形状分毫不差的消息；信使 → 选取器用选取器握手时交出来的 MessagePort，页面自己的脚本看不到。
 * 注入的源码就是下面几个函数的 toString()，测试跑的和页面里跑的是同一份代码。
 */
import {
  ANNOTATION_HTML_OUTER_MAX,
  ANNOTATION_HTML_TEXT_MAX,
  validateAnchor,
  type Annotation,
  type AnnotationStatus,
  type HtmlElementAnchor,
} from "@real-bot/protocol";
import { injectHtmlPreviewColorScheme, injectHtmlPreviewNonce } from "../overlays/artifacts.ts";

/** 128 bits, as 32 lowercase hex characters. */
const CHANNEL_RE = /^[0-9a-f]{32}$/;
/** How long after the page has loaded the re-anchor check waits, so scripts that build the DOM have run. */
export const PICKER_SETTLE_MS = 300;
/** At most this many marks are drawn; more is not a page anyone annotates. */
export const PICKER_MARKS_MAX = 500;
/** `validateAnchor` takes selectors up to 2000 characters. */
export const PICKER_SELECTOR_MAX = 2000;
const TAG_MAX = 64;
const MARK_N_MAX = 100_000;

/** A fresh channel id for one injection: 16 random bytes from `crypto.getRandomValues`. */
export function newChannel(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isChannel(value: unknown): value is string {
  return typeof value === "string" && CHANNEL_RE.test(value);
}

// ---------------------------------------------------------------------------------------------
// The page side. Every function from here to `pickerMain` is serialized with toString() into the
// injected script, so each one closes over nothing in this module: no imports, no module
// constants, no calls to one another except through the `lib` object handed to `pickerMain`.
// ---------------------------------------------------------------------------------------------

/**
 * An element as a CSS path: from `body` (or `head` / `html`) down, one `>` per level, with
 * `:nth-of-type(k)` wherever a parent has more than one child of that tag. A path may start at an
 * id instead, but only one that is unique in the document and needs no escaping.
 */
export function cssPathFor(el: Element): string {
  const doc = el.ownerDocument;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1) {
    const name = node.localName || "";
    if (name === "html" || name === "body" || name === "head") {
      parts.unshift(name);
      break;
    }
    const id = node.getAttribute("id");
    if (id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id) && doc && doc.querySelectorAll("#" + id).length === 1) {
      parts.unshift("#" + id);
      break;
    }
    const parent: Element | null = node.parentElement;
    let position = 0;
    let index = 0;
    let count = 0;
    let at = 0;
    if (parent) {
      for (let sib = parent.firstElementChild; sib; sib = sib.nextElementSibling) {
        at += 1;
        if (sib === node) position = at;
        if (sib.localName === name) {
          count += 1;
          if (sib === node) index = count;
        }
      }
    }
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) parts.unshift(position > 0 ? "*:nth-child(" + position + ")" : "*");
    else parts.unshift(count > 1 ? name + ":nth-of-type(" + index + ")" : name);
    if (!parent) break;
    node = parent;
  }
  return parts.join(" > ");
}

/**
 * What an element says: its text without scripts and styles, whitespace collapsed and trimmed,
 * at most `max` characters; an image or a field falls back to its alt / aria-label / title /
 * placeholder. Anything but an inline element counts as a word break, so `<li>One</li><li>Two</li>`
 * reads "One Two" — without asking for layout, which the check below must not depend on. The
 * re-anchor check compares this, so both ends must compute it the same way.
 */
export function elementText(el: Element, max: number): string {
  const limit = max * 4 + 256;
  const inline = /^(a|abbr|b|bdi|bdo|cite|code|data|dfn|em|font|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var)$/i;
  const isBreak = (n: Node): boolean => n.nodeType === 1 && !inline.test((n as Element).localName);
  let out = "";
  let node: Node | null = el.firstChild;
  while (node && out.length < limit) {
    if (node.nodeType === 3 || node.nodeType === 4) out += node.nodeValue || "";
    else if (isBreak(node)) out += " ";
    if (node.nodeType === 1 && node.firstChild && !/^(script|style|template|noscript)$/i.test((node as Element).localName)) {
      node = node.firstChild;
      continue;
    }
    // Climb out of everything that has ended; leaving a block is a break too.
    while (node && node !== el && !node.nextSibling) {
      node = node.parentNode;
      if (node && node !== el && isBreak(node)) out += " ";
    }
    if (!node || node === el) break;
    node = node.nextSibling;
  }
  let text = out.replace(/\s+/g, " ").trim();
  const attrs = ["alt", "aria-label", "title", "placeholder"];
  for (let i = 0; i < attrs.length && !text; i += 1) text = (el.getAttribute(attrs[i]!) || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(text.slice(0, max * 2));
  return chars.length > max ? chars.slice(0, max).join("").trim() : chars.join("");
}

/** The element's markup, cut to `max` characters. */
export function outerHtmlOf(el: Element, max: number): string {
  const html = String(el.outerHTML || "");
  const chars = Array.from(html.slice(0, max * 2));
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
}

/** Where the element sits, as shares (0–1) of the document's scroll size. */
export function docRect(el: Element, win: Window): { x: number; y: number; w: number; h: number } {
  const doc = el.ownerDocument;
  const de = doc.documentElement;
  const body = doc.body;
  const r = el.getBoundingClientRect();
  // A page that scrolls its <body> instead of the viewport (html{overflow:hidden}) reports the offset there.
  const sx = win.pageXOffset || (de ? de.scrollLeft : 0) || (body ? body.scrollLeft : 0) || 0;
  const sy = win.pageYOffset || (de ? de.scrollTop : 0) || (body ? body.scrollTop : 0) || 0;
  const width = Math.max(de ? de.scrollWidth : 0, body ? body.scrollWidth : 0, de ? de.clientWidth : 0);
  const height = Math.max(de ? de.scrollHeight : 0, body ? body.scrollHeight : 0, de ? de.clientHeight : 0);
  const unit = (v: number): number => (v > 0 ? (v < 1 ? Math.round(v * 1e6) / 1e6 : 1) : 0);
  const x = width > 0 ? unit((r.left + sx) / width) : 0;
  const y = height > 0 ? unit((r.top + sy) / height) : 0;
  const w = width > 0 ? Math.max(0, Math.min(unit(r.width / width), 1 - x)) : 0;
  const h = height > 0 ? Math.max(0, Math.min(unit(r.height / height), 1 - y)) : 0;
  return { x, y, w, h };
}

/**
 * The element's name as an anchor stores it: lowercase letters, digits and hyphens, at most 64
 * characters (a longer custom element name is cut, or the messenger would drop the pick).
 */
export function tagOf(el: Element): string {
  const name = String(el.localName || "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return (/^[a-z]/.test(name) ? name : "x-" + name).slice(0, 64);
}

type PickerConfig = {
  channel: string;
  textMax: number;
  outerMax: number;
  settleMs: number;
  marksMax: number;
  selectorMax: number;
};

type PickerLib = {
  cssPathFor: typeof cssPathFor;
  elementText: typeof elementText;
  outerHtmlOf: typeof outerHtmlOf;
  docRect: typeof docRect;
  tagOf: typeof tagOf;
};

type PageMark = { n: number; selector: string; status: string; stale: boolean; check: boolean; text: string };
type PageBox = { n: number; selector: string; status: string; stale: boolean; box: HTMLElement; el: Element | null };

/**
 * The picker itself. It runs before any of the page's own scripts, takes what it needs from the
 * page's globals right then, and keeps all of its state in this closure. It only ever reads the
 * DOM the page already has, posts picks / cancel / missing to its parent, and draws outlines in
 * one inline-styled, pointer-events:none layer that it removes when it exits.
 */
function pickerMain(win: any, cfg: PickerConfig, lib: PickerLib): void {
  const doc = win.document;
  const parentWin = win.parent;
  if (!doc || !parentWin || parentWin === win) return;
  // Out of the DOM before the page's scripts can read the channel id off it.
  const self = doc.currentScript;
  if (self && self.parentNode) self.parentNode.removeChild(self);

  // Taken now, before the page can patch them: reading a message goes through these only, so a
  // patched getter or prototype never sees one.
  const apply = Reflect.apply;
  const hasOwn = Object.prototype.hasOwnProperty;
  const isArray = Array.isArray;
  const MEvent = win.MessageEvent;
  const dataDesc = MEvent && MEvent.prototype ? Object.getOwnPropertyDescriptor(MEvent.prototype, "data") : undefined;
  const dataGet = dataDesc && typeof dataDesc.get === "function" ? dataDesc.get : null;
  const MPort = win.MessagePort;
  const portClose = MPort && MPort.prototype && typeof MPort.prototype.close === "function" ? MPort.prototype.close : null;
  // Leaving goes through these too, as they are now: a removeEventListener the page patched or
  // shadowed later would be handed our handlers.
  const winOff = win.removeEventListener;
  const docOff = doc.removeEventListener;
  const own = (o: any, key: string): any => (o !== null && typeof o === "object" && apply(hasOwn, o, [key]) ? o[key] : undefined);
  // The page's scripts share this window and can dispatch events of their own (el.click(), a
  // made-up Escape or pointerover): those would pick, re-point the anchor waiting for its remark,
  // or leave annotate mode without the person. Only the person's input counts; the page's own
  // events pass to the page untouched. `isTrusted` is an unforgeable own property of every event
  // in a browser; a DOM that leaves it undefined (a test's) is treated as the person.
  const synthetic = (ev: any): boolean => ev.isTrusted === false;

  const ACCENT = "#2563eb";
  const MUTED = "#8b929c";
  const TOP = "2147483647";
  const SKIP = /^(script|style|template|noscript|link|meta|title|base|head)$/;
  const BASE: Record<string, string> = {
    margin: "0",
    padding: "0",
    "pointer-events": "none",
    "box-sizing": "border-box",
    display: "block",
    visibility: "visible",
    opacity: "1",
    transform: "none",
    float: "none",
    "min-width": "0",
    "min-height": "0",
    "max-width": "none",
    "max-height": "none",
    outline: "none",
    filter: "none",
    "clip-path": "none",
    animation: "none",
    transition: "none",
  };

  let alive = true;
  let picking = false;
  let pendingSel: string | null = null;
  let marks: PageMark[] = [];
  let rev = 0;
  let verified = true;
  let missing: Record<number, boolean> = Object.create(null);
  let current: Element | null = null;
  let focusN = 0;
  let layer: HTMLElement | null = null;
  let hoverBox: HTMLElement | null = null;
  let hoverTag: HTMLElement | null = null;
  let pendingBox: HTMLElement | null = null;
  let boxes: PageBox[] = [];
  let domReady = doc.readyState !== "loading";
  let loaded = doc.readyState === "complete";
  let checkDue = false;
  /** The marks the last check was about; while they stay the same, its answer stays drawn. */
  let checkKey = "";
  let checkTimer: any = 0;
  let tickTimer: any = 0;
  let flashTimer: any = 0;
  let placing = false;
  let port: any = null;

  function post(msg: any, transfer?: any[]): void {
    try {
      if (transfer) parentWin.postMessage(msg, "*", transfer);
      else parentWin.postMessage(msg, "*");
    } catch (e) {
      // The messenger is gone; nothing to tell.
    }
  }

  function css(node: HTMLElement, props: Record<string, string>): void {
    for (const key in props) if (apply(hasOwn, props, [key])) node.style.setProperty(key, props[key]!, "important");
  }

  function make(tag: string): HTMLElement {
    const node = doc.createElement(tag) as HTMLElement;
    css(node, BASE);
    return node;
  }

  function ensureLayer(): HTMLElement | null {
    if (layer && layer.parentNode) return layer;
    const root = doc.documentElement;
    if (!root || !domReady) return null;
    layer = make("rb-annot-layer");
    css(layer, { position: "absolute", left: "0", top: "0", width: "0", height: "0", overflow: "visible", "z-index": TOP, border: "0", background: "none" });
    layer.setAttribute("aria-hidden", "true");
    root.appendChild(layer);
    if (!tickTimer) tickTimer = win.setInterval(place, 500);
    return layer;
  }

  function paint(box: HTMLElement, kind: string, stale: boolean, flash: boolean): void {
    const color = kind === "resolved" ? MUTED : ACCENT;
    const fill =
      kind === "resolved"
        ? "rgba(139,146,156,0.10)"
        : kind === "draft"
          ? "rgba(37,99,235,0.05)"
          : kind === "pending"
            ? "rgba(37,99,235,0.16)"
            : kind === "hover"
              ? "rgba(37,99,235,0.08)"
              : "rgba(37,99,235,0.10)";
    css(box, {
      position: "absolute",
      "z-index": TOP,
      border: (kind === "pending" ? "3px " : "2px ") + (stale ? "dashed " : kind === "draft" ? "dotted " : "solid ") + color,
      "border-radius": "3px",
      background: fill,
      "box-shadow": flash ? "0 0 0 4px rgba(37,99,235,0.45)" : kind === "pending" ? "0 0 0 1px rgba(255,255,255,0.9)" : "none",
    });
  }

  function label(box: HTMLElement, text: string, kind: string, stale: boolean): HTMLElement {
    const tag = make("rb-annot-badge");
    const edge = kind === "resolved" ? MUTED : ACCENT;
    css(tag, {
      position: "absolute",
      left: "-2px",
      top: "-18px",
      height: "16px",
      "min-width": "16px",
      padding: "0 4px",
      "border-radius": "8px",
      font: "600 11px/16px system-ui, -apple-system, sans-serif",
      "letter-spacing": "0",
      "text-transform": "none",
      "text-align": "center",
      "white-space": "nowrap",
      color: kind === "draft" ? ACCENT : "#fff",
      background: kind === "draft" ? "#fff" : edge,
      border: kind === "draft" || stale ? "1px " + (stale ? "dashed " : "dotted ") + edge : "0",
    });
    tag.textContent = text;
    box.appendChild(tag);
    return tag;
  }

  function find(selector: string): Element | null {
    let el: Element | null = null;
    try {
      el = doc.querySelector(selector);
    } catch (e) {
      return null;
    }
    if (el && layer && (el === layer || layer.contains(el))) return null;
    return el;
  }

  function put(box: HTMLElement, el: Element | null): void {
    if (!el || !el.isConnected) {
      css(box, { display: "none" });
      return;
    }
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 || r.height > 0)) {
      css(box, { display: "none" });
      return;
    }
    const left = r.left + (win.pageXOffset || 0);
    const top = r.top + (win.pageYOffset || 0);
    css(box, { display: "block", left: left + "px", top: top + "px", width: r.width + "px", height: r.height + "px" });
    const tag = box.firstChild as HTMLElement | null;
    if (tag) css(tag, top < 18 ? { top: "2px", left: "2px" } : { top: "-18px", left: "-2px" });
  }

  function redraw(): void {
    if (!alive || !domReady) return;
    const root = ensureLayer();
    if (!root) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    boxes = [];
    for (let i = 0; i < marks.length; i += 1) {
      const m = marks[i]!;
      // A mark on a changed file waits for the check, and one the check could not find is not drawn.
      if (m.check && (!verified || missing[m.n] === true)) continue;
      const box = make("rb-annot-box");
      paint(box, m.status, m.stale, false);
      label(box, String(m.n), m.status, m.stale);
      root.appendChild(box);
      boxes[boxes.length] = { n: m.n, selector: m.selector, status: m.status, stale: m.stale, box, el: null };
    }
    pendingBox = null;
    if (pendingSel) {
      pendingBox = make("rb-annot-box");
      paint(pendingBox, "pending", false, false);
      root.appendChild(pendingBox);
    }
    hoverBox = null;
    hoverTag = null;
    if (picking) {
      hoverBox = make("rb-annot-box");
      paint(hoverBox, "hover", false, false);
      hoverTag = label(hoverBox, "", "open", false);
      root.appendChild(hoverBox);
    }
    place();
  }

  function place(): void {
    if (!alive || !layer) return;
    if (!layer.parentNode) {
      // The page threw our layer away (replaced the document's children); draw it again.
      layer = null;
      redraw();
      return;
    }
    for (let i = 0; i < boxes.length; i += 1) {
      const entry = boxes[i]!;
      entry.el = find(entry.selector);
      put(entry.box, entry.el);
    }
    const pendingEl = pendingSel ? find(pendingSel) : null;
    if (pendingBox) put(pendingBox, pendingEl);
    if (hoverBox) {
      if (current && current !== pendingEl && current.isConnected) {
        if (hoverTag) hoverTag.textContent = lib.tagOf(current);
        put(hoverBox, current);
      } else css(hoverBox, { display: "none" });
    }
    if (focusN) flashMark(focusN);
  }

  function schedulePlace(): void {
    if (!alive || !layer || placing) return;
    placing = true;
    const run = (): void => {
      placing = false;
      place();
    };
    if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(run);
    else win.setTimeout(run, 16);
  }

  function flashMark(n: number): void {
    for (let i = 0; i < boxes.length; i += 1) {
      const entry = boxes[i]!;
      if (entry.n !== n || !entry.el) continue;
      focusN = 0;
      try {
        entry.el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      } catch (e) {
        // Scrolling is a nicety.
      }
      paint(entry.box, entry.status, entry.stale, true);
      if (flashTimer) win.clearTimeout(flashTimer);
      flashTimer = win.setTimeout(() => {
        flashTimer = 0;
        paint(entry.box, entry.status, entry.stale, false);
      }, 1400);
      return;
    }
  }

  function setCurrent(el: Element | null): void {
    if (el === current) return;
    current = el;
    place();
  }

  function targetOf(ev: any): Element | null {
    let t = ev.target;
    if (t && t.nodeType === 3) t = t.parentNode;
    if (!t || t.nodeType !== 1) return null;
    if (layer && (t === layer || layer.contains(t))) return null;
    if (t.localName === "html" || t.localName === "head") return doc.body || null;
    return t;
  }

  function pick(el: Element): void {
    let anchor: { selector: string; tag: string; text: string; outer_html: string; rect: { x: number; y: number; w: number; h: number } };
    try {
      anchor = {
        selector: lib.cssPathFor(el),
        tag: lib.tagOf(el),
        text: lib.elementText(el, cfg.textMax),
        outer_html: lib.outerHtmlOf(el, cfg.outerMax),
        rect: lib.docRect(el, win),
      };
    } catch (e) {
      return;
    }
    if (!anchor.selector || anchor.selector.length > cfg.selectorMax) return;
    post({ channel: cfg.channel, type: "pick", anchor });
  }

  function move(dir: string): void {
    const pendingEl = pendingSel ? find(pendingSel) : null;
    const from = current && current.isConnected ? current : pendingEl;
    if (!from) {
      setCurrent(doc.body || null);
      return;
    }
    let next: Element | null = null;
    if (dir === "up") {
      if (from.localName !== "body") {
        const up = from.parentElement;
        next = up && up.localName !== "html" ? up : doc.body || null;
      }
    } else {
      for (let c = from.firstElementChild; c; c = c.nextElementSibling) {
        if (!SKIP.test(c.localName) && c !== layer) {
          next = c;
          break;
        }
      }
    }
    if (!next || next === from) return;
    setCurrent(next);
    try {
      next.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (e) {
      // Scrolling is a nicety.
    }
    // The element waiting for its remark follows the outline.
    if (pendingSel) pick(next);
  }

  function halt(ev: any): void {
    if (ev.cancelable) ev.preventDefault();
    ev.stopImmediatePropagation();
  }

  function onHover(ev: any): void {
    if (!alive || !picking || synthetic(ev)) return;
    const t = targetOf(ev);
    if (t) setCurrent(t);
  }

  function onPress(ev: any): void {
    if (!alive || !picking || synthetic(ev)) return;
    const type = ev.type;
    // A press while picking is ours: no link, button, form or page handler sees it.
    if (type === "mousedown" || type === "click" || type === "dblclick" || type === "auxclick") {
      if (ev.cancelable) ev.preventDefault();
    }
    ev.stopImmediatePropagation();
    // Cancelling mousedown also keeps the frame from taking focus; take it for the document
    // (no element in it), so ↑ ↓ Enter Esc work after a click.
    if (type === "mousedown" && typeof win.focus === "function") {
      try {
        win.focus();
      } catch (e) {
        // Focus is a nicety.
      }
    }
    if (type === "click" && !ev.button) {
      const t = targetOf(ev);
      if (t) {
        setCurrent(t);
        pick(t);
      }
    }
  }

  function onKey(ev: any): void {
    if (!alive || synthetic(ev)) return;
    const key = ev.key;
    // The picker is only ever in the page in annotate mode (or with an element pending), and keys
    // pressed in here never reach the messenger: Escape always leaves, choosing or not.
    if (key === "Escape") {
      if (ev.isComposing) return;
      halt(ev);
      cancel();
      return;
    }
    if (!picking) return;
    if (key === "ArrowUp" || key === "ArrowDown") {
      halt(ev);
      move(key === "ArrowUp" ? "up" : "down");
    } else if (key === "Enter" && current && current.isConnected) {
      halt(ev);
      pick(current);
    }
  }

  function scheduleCheck(): void {
    let any = false;
    for (let i = 0; i < marks.length; i += 1) if (marks[i]!.check) any = true;
    if (checkTimer) {
      win.clearTimeout(checkTimer);
      checkTimer = 0;
    }
    checkDue = any;
    if (any && loaded) checkTimer = win.setTimeout(runCheck, cfg.settleMs);
  }

  function runCheck(): void {
    checkTimer = 0;
    checkDue = false;
    if (!alive) return;
    const ns: number[] = [];
    missing = Object.create(null);
    for (let i = 0; i < marks.length; i += 1) {
      const m = marks[i]!;
      if (!m.check) continue;
      const el = find(m.selector);
      if (!el || lib.elementText(el, cfg.textMax) !== m.text) {
        ns[ns.length] = m.n;
        missing[m.n] = true;
      }
    }
    verified = true;
    post({ channel: cfg.channel, type: "missing", ns, rev });
    redraw();
  }

  function applyMarks(data: any): void {
    const list = own(data, "marks");
    if (!isArray(list)) return;
    const next: PageMark[] = [];
    const count = list.length < cfg.marksMax ? list.length : cfg.marksMax;
    for (let i = 0; i < count; i += 1) {
      const m = list[i];
      const n = own(m, "n");
      const selector = own(m, "selector");
      const status = own(m, "status");
      if (typeof n !== "number" || !(n >= 1 && n <= 100000) || n % 1 !== 0) continue;
      if (typeof selector !== "string" || !selector || selector.length > cfg.selectorMax) continue;
      if (status !== "open" && status !== "draft" && status !== "resolved") continue;
      const text = own(m, "text");
      next[next.length] = {
        n,
        selector,
        status,
        stale: own(m, "stale") === true,
        check: own(m, "check") === true,
        text: typeof text === "string" ? text : "",
      };
    }
    marks = next;
    const pending = own(data, "pending");
    pendingSel = typeof pending === "string" && pending && pending.length <= cfg.selectorMax ? pending : null;
    picking = own(data, "picking") === true;
    const r = own(data, "rev");
    rev = typeof r === "number" && r >= 0 && r % 1 === 0 ? r : 0;
    // Every change of pending / picking resends the list. When the marks to re-check are the same
    // ones, the last answer stays drawn until the new check replaces it, so they do not blink.
    let key = "";
    for (let i = 0; i < marks.length; i += 1) {
      const m = marks[i]!;
      if (m.check) key += m.n + "\u0000" + m.selector + "\u0000" + m.text + "\u0001";
    }
    if (key !== checkKey) {
      checkKey = key;
      missing = Object.create(null);
      verified = key === "";
    }
    if (!picking) current = null;
    redraw();
    scheduleCheck();
  }

  function onPortMessage(ev: any): void {
    if (!alive) return;
    const data = dataGet ? apply(dataGet, ev, []) : ev.data;
    if (own(data, "channel") !== cfg.channel) return;
    const type = own(data, "type");
    if (type === "marks") applyMarks(data);
    else if (type === "focus") {
      const n = own(data, "n");
      if (typeof n === "number" && n >= 1) {
        focusN = n;
        if (layer) flashMark(n);
      }
    } else if (type === "nav") {
      const dir = own(data, "dir");
      if (picking && (dir === "up" || dir === "down")) move(dir);
    }
  }

  function onDom(): void {
    domReady = true;
    redraw();
  }

  function onLoad(): void {
    loaded = true;
    domReady = true;
    redraw();
    if (checkDue && !checkTimer) checkTimer = win.setTimeout(runCheck, cfg.settleMs);
  }

  const capture = { capture: true };
  const quiet = { capture: true, passive: true };
  const listeners: Array<[any, string, (ev: any) => void, any]> = [
    [win, "pointerover", onHover, capture],
    [win, "pointermove", onHover, capture],
    [win, "pointerdown", onPress, capture],
    [win, "pointerup", onPress, capture],
    [win, "mousedown", onPress, capture],
    [win, "mouseup", onPress, capture],
    [win, "click", onPress, capture],
    [win, "dblclick", onPress, capture],
    [win, "auxclick", onPress, capture],
    [win, "touchstart", onPress, quiet],
    [win, "touchend", onPress, quiet],
    [win, "keydown", onKey, capture],
    [win, "scroll", schedulePlace, quiet],
    [win, "resize", schedulePlace, quiet],
  ];

  function cancel(): void {
    post({ channel: cfg.channel, type: "cancel" });
    teardown();
  }

  function teardown(): void {
    alive = false;
    picking = false;
    current = null;
    const off = (target: any, type: string, fn: (ev: any) => void, opts?: any): void => {
      try {
        apply(target === doc ? docOff : winOff, target, [type, fn, opts]);
      } catch (e) {
        // The handlers check `alive` first, so one left behind does nothing.
      }
    };
    for (let i = 0; i < listeners.length; i += 1) {
      const l = listeners[i]!;
      off(l[0], l[1], l[2], l[3]);
    }
    off(doc, "DOMContentLoaded", onDom);
    off(win, "load", onLoad);
    if (checkTimer) win.clearTimeout(checkTimer);
    if (tickTimer) win.clearInterval(tickTimer);
    if (flashTimer) win.clearTimeout(flashTimer);
    checkTimer = tickTimer = flashTimer = 0;
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    layer = hoverBox = hoverTag = pendingBox = null;
    boxes = [];
    if (port && portClose) {
      try {
        apply(portClose, port, []);
      } catch (e) {
        // Already closed.
      }
    }
    port = null;
  }

  // Registered before any of the page's scripts run, so ours are the first listeners called.
  for (let i = 0; i < listeners.length; i += 1) {
    const l = listeners[i]!;
    l[0].addEventListener(l[1], l[2], l[3]);
  }
  if (!domReady) doc.addEventListener("DOMContentLoaded", onDom);
  if (!loaded) win.addEventListener("load", onLoad);

  // The way back in: a port only this closure holds. The messenger's marks never pass through the
  // window's message event, where the page's own listeners would see them.
  const MChannel = win.MessageChannel;
  if (typeof MChannel === "function") {
    try {
      const pipe = new MChannel();
      port = pipe.port1;
      port.onmessage = onPortMessage;
      post({ channel: cfg.channel, type: "ready" }, [pipe.port2]);
    } catch (e) {
      port = null;
    }
  }
}

/**
 * The script injected into the page: the functions above, by their own source, in one IIFE.
 * `settleMs` is for tests; the page waits {@link PICKER_SETTLE_MS} before its re-anchor check.
 */
export function pickerScriptSource(channel: string, opts: { settleMs?: number } = {}): string {
  if (!isChannel(channel)) throw new Error("picker channel must be 32 hex characters");
  const cfg: PickerConfig = {
    channel,
    textMax: ANNOTATION_HTML_TEXT_MAX,
    outerMax: ANNOTATION_HTML_OUTER_MAX,
    settleMs: Math.max(0, Math.floor(opts.settleMs ?? PICKER_SETTLE_MS)),
    marksMax: PICKER_MARKS_MAX,
    selectorMax: PICKER_SELECTOR_MAX,
  };
  const lib = [
    `cssPathFor:${cssPathFor.toString()}`,
    `elementText:${elementText.toString()}`,
    `outerHtmlOf:${outerHtmlOf.toString()}`,
    `docRect:${docRect.toString()}`,
    `tagOf:${tagOf.toString()}`,
  ].join(",");
  // `__name` is a no-op stand-in for the helper some bundlers insert when they keep function names.
  return `(function(){"use strict";var __name=function(f){return f};(${pickerMain.toString()})(window,${JSON.stringify(cfg)},{${lib}});})();`;
}

type HeadScan = { headEnd: number; htmlEnd: number; doctypeEnd: number };

/**
 * Where the doctype, `<html …>` and `<head …>` end, looking only at what comes before the page's
 * first other start tag. Any element can run the page's code — a `<script>`, but also an inline
 * handler (`<svg onload>`, `<img onerror>`) — so the scan stops at the first one, and nothing is
 * skipped as raw text. Comments end where the HTML tokenizer ends them: `<!-->` and `<!--->` are
 * whole comments, and `--!>` closes one as well as `-->`.
 */
function scanHead(html: string): HeadScan {
  const found: HeadScan = { headEnd: -1, htmlEnd: -1, doctypeEnd: -1 };
  // `<html>` and `<head>` run to the first `>` outside a quoted attribute value (`<head data-x="a>b">`);
  // a quote that would swallow a `<` is not taken for a value, so such a tag does not match here
  // and counts as an other tag below (the picker then goes in front of it). An end tag stops the
  // scan as well: its attribute values could hold what looks like a `<head>`.
  const re = /<!--(?:>|->|[\s\S]*?(?:--!?>|$))|<!doctype\b[^>]*>|<(head|html)(?=[\s/>])(?:[^<>"']|"[^"<]*"|'[^'<]*')*>|<\/?[a-z]/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const token = m[0];
    if (token.startsWith("<!--")) continue;
    if (token.startsWith("<!")) {
      if (found.doctypeEnd < 0) found.doctypeEnd = m.index + token.length;
      continue;
    }
    const name = m[1]?.toLowerCase();
    if (name !== "head" && name !== "html") break;
    const key = name === "head" ? "headEnd" : "htmlEnd";
    if (found[key] < 0) found[key] = m.index + token.length;
  }
  return found;
}

/**
 * The page with the picker in front of everything it runs: right after `<head …>` when nothing but
 * the doctype and `<html …>` comes before it; in a new `<head>` after `<html …>` when the page has
 * no head there; otherwise in a new `<head>` at the very start (after the doctype), where the
 * parser opens `<html>` and `<head>` around it and folds the page's own later into them. The script
 * tag carries the CSP nonce like the page's own scripts do.
 */
export function injectPicker(html: string, opts: { channel: string; nonce?: string | null; settleMs?: number }): string {
  const token = opts.nonce?.trim();
  const attr = token && !/["'<>]/.test(token) ? ` nonce="${token}"` : "";
  const tag = `<script${attr}>${pickerScriptSource(opts.channel, { settleMs: opts.settleMs })}</script>`;
  const at = scanHead(html);
  const splice = (index: number, text: string): string => html.slice(0, index) + text + html.slice(index);
  if (at.headEnd >= 0) return splice(at.headEnd, tag);
  if (at.htmlEnd >= 0) return splice(at.htmlEnd, `<head>${tag}</head>`);
  return splice(Math.max(at.doctypeEnd, 0), `<head>${tag}</head>`);
}

/**
 * The preview's HTML, built the way the pane builds it (colour scheme, then the CSP nonce on the
 * page's own scripts and styles), plus the picker when there is a channel — only in annotate mode.
 */
export function annotatorSource(
  raw: string,
  opts: { scheme: "light" | "dark"; nonce: string | null | undefined; channel: string | null; settleMs?: number },
): string {
  const page = injectHtmlPreviewNonce(injectHtmlPreviewColorScheme(raw, opts.scheme), opts.nonce);
  return opts.channel ? injectPicker(page, { channel: opts.channel, nonce: opts.nonce, settleMs: opts.settleMs }) : page;
}

// ---------------------------------------------------------------------------------------------
// The messenger side.
// ---------------------------------------------------------------------------------------------

/** One existing annotation as the page draws it. `text` travels only when the page must re-check it. */
export type PickerMark = { n: number; selector: string; status: AnnotationStatus; stale: boolean; check: boolean; text: string };

export type MarksMessage = {
  channel: string;
  type: "marks";
  marks: PickerMark[];
  /** The selector of the element waiting for its remark. */
  pending: string | null;
  /** Whether hover and click choose an element right now. */
  picking: boolean;
  /** Echoed by the page's `missing` answer, so a late answer to an older list is dropped. */
  rev: number;
};

/**
 * This file's html_element rows as marks, numbered 1..n in the order given (the number counts
 * every row, drawn or not, so it matches the list). A row whose file is gone is not drawn; a row
 * whose file changed is drawn only once the page has found its element with the same text.
 */
export function pickerMarks(rows: readonly Annotation[]): PickerMark[] {
  const out: PickerMark[] = [];
  rows.forEach((row, i) => {
    if (row.anchor_kind !== "html_element" || row.stale?.kind === "missing") return;
    const anchor = row.anchor as HtmlElementAnchor;
    if (typeof anchor.selector !== "string" || !anchor.selector.trim() || anchor.selector.length > PICKER_SELECTOR_MAX) return;
    const check = row.stale != null;
    out.push({
      n: i + 1,
      selector: anchor.selector,
      status: row.status,
      stale: check,
      check,
      text: check && typeof anchor.text === "string" ? anchor.text : "",
    });
  });
  return out;
}

/** The marks, as plain data (the rows may be reactive proxies, which do not clone). */
export function marksMessage(
  channel: string,
  marks: readonly PickerMark[],
  opts: { pending?: string | null; picking?: boolean; rev?: number } = {},
): MarksMessage {
  return {
    channel,
    type: "marks",
    marks: marks.map((m) => ({ n: m.n, selector: m.selector, status: m.status, stale: m.stale, check: m.check, text: m.check ? m.text : "" })),
    pending: opts.pending ?? null,
    picking: opts.picking === true,
    rev: opts.rev ?? 0,
  };
}

/** Scroll the page to mark `n` and flash it. */
export function focusMessage(channel: string, n: number): { channel: string; type: "focus"; n: number } {
  return { channel, type: "focus", n };
}

/** Move the outline to the parent (`up`) or first child (`down`), as ↑ / ↓ do in the page. */
export function navMessage(channel: string, dir: "up" | "down"): { channel: string; type: "nav"; dir: "up" | "down" } {
  return { channel, type: "nav", dir };
}

export type PickerReply =
  | { type: "ready"; port: MessagePort }
  | { type: "pick"; anchor: HtmlElementAnchor }
  | { type: "cancel" }
  | { type: "missing"; ns: number[]; rev: number };

type MessageLike = { source: unknown; data: unknown; ports?: ReadonlyArray<unknown> };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactly(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

/** A string of at most `max` characters (code points), checked without spreading a huge one. */
function textUpTo(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max * 2 && [...value].length <= max;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * What the picker said, or null. Only a message from `expectedSource` (the iframe's window),
 * carrying this injection's channel, in exactly the shape the picker sends, gets through: the
 * page's own scripts share that window and may post anything. A pick's fields are checked for type
 * and length, its rect clamped to 0–1, and the result must pass `validateAnchor`.
 */
export function validatePickerMessage(event: MessageLike, expectedSource: unknown, channel: string | null): PickerReply | null {
  if (!isChannel(channel)) return null;
  if (expectedSource == null || event.source !== expectedSource) return null;
  const data = event.data;
  if (!isPlainRecord(data) || data.channel !== channel) return null;
  switch (data.type) {
    case "ready": {
      if (!hasExactly(data, ["channel", "type"])) return null;
      const ports = event.ports;
      const port = ports && ports.length === 1 ? ports[0] : null;
      if (!port || typeof (port as MessagePort).postMessage !== "function") return null;
      return { type: "ready", port: port as MessagePort };
    }
    case "cancel":
      return hasExactly(data, ["channel", "type"]) ? { type: "cancel" } : null;
    case "missing": {
      if (!hasExactly(data, ["channel", "type", "ns", "rev"])) return null;
      const { ns, rev } = data;
      if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 0) return null;
      if (!Array.isArray(ns) || ns.length > PICKER_MARKS_MAX) return null;
      if (!ns.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MARK_N_MAX)) return null;
      return { type: "missing", ns: [...new Set(ns as number[])], rev };
    }
    case "pick": {
      if (!hasExactly(data, ["channel", "type", "anchor"])) return null;
      const anchor = data.anchor;
      if (!isPlainRecord(anchor) || !hasExactly(anchor, ["selector", "tag", "text", "outer_html", "rect"])) return null;
      const { selector, tag, text, outer_html, rect } = anchor;
      if (typeof selector !== "string" || !selector.trim() || selector.length > PICKER_SELECTOR_MAX) return null;
      if (typeof tag !== "string" || tag.length > TAG_MAX || !/^[a-z][a-z0-9-]*$/i.test(tag)) return null;
      if (!textUpTo(text, ANNOTATION_HTML_TEXT_MAX) || !textUpTo(outer_html, ANNOTATION_HTML_OUTER_MAX)) return null;
      if (!isPlainRecord(rect) || !hasExactly(rect, ["x", "y", "w", "h"])) return null;
      const box = [rect.x, rect.y, rect.w, rect.h];
      if (!box.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
      const x = clamp01(rect.x as number);
      const y = clamp01(rect.y as number);
      const w = Math.min(clamp01(rect.w as number), 1 - x);
      const h = Math.min(clamp01(rect.h as number), 1 - y);
      const check = validateAnchor("html_element", { selector, tag, text, outer_html, rect: { x, y, w, h } });
      return check.ok ? { type: "pick", anchor: check.anchor as HtmlElementAnchor } : null;
    }
    default:
      return null;
  }
}
