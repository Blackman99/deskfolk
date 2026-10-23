import { afterEach, expect, test } from "bun:test";
import { keptFocus } from "./kept-focus.ts";

/** What SvelteKit does to focus on a popstate: blur, then the body. */
function popstate(): void {
  (document.activeElement as HTMLElement | null)?.blur();
  document.body.tabIndex = -1;
  document.body.focus();
  document.body.removeAttribute("tabindex");
}

/** `later` held back, so a test runs it where SvelteKit's own timer would have run first. */
function deferred() {
  const queue: Array<() => void> = [];
  return { later: (run: () => void) => queue.push(run), flush: () => queue.splice(0).forEach((run) => run()) };
}

/** Its own corner of the page: the document is shared with every other test file. */
let root: HTMLElement;
function mount(html: string): void {
  root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
}

afterEach(() => {
  root?.remove();
  (document.activeElement as HTMLElement | null)?.blur();
});

test("the field the click focused gets focus back once the step back has landed", () => {
  mount(`<textarea id="a"></textarea><textarea id="b"></textarea>`);
  const b = document.getElementById("b") as HTMLTextAreaElement;
  b.focus();
  const { later, flush } = deferred();
  const kept = keptFocus(document, later, () => false);
  kept.hold();
  popstate();
  kept.restore();
  expect(document.activeElement).toBe(document.body);
  flush();
  expect(document.activeElement).toBe(b);
});

test("a contenteditable gets its caret back where it was", () => {
  mount(`<div id="c" contenteditable="true">hello world</div>`);
  const c = document.getElementById("c")!;
  c.focus();
  const range = document.createRange();
  range.setStart(c.firstChild!, 5);
  range.collapse(true);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  const { later, flush } = deferred();
  const kept = keptFocus(document, later, () => false);
  kept.hold();
  popstate();
  document.getSelection()!.removeAllRanges();
  kept.restore();
  flush();
  expect(document.activeElement).toBe(c);
  const caret = document.getSelection()!.getRangeAt(0);
  expect([caret.startContainer, caret.startOffset]).toEqual([c.firstChild!, 5]);
});

test("nothing is put back when something else took focus meanwhile, the field is gone, or the navigation was another", () => {
  mount(`<textarea id="a"></textarea><input id="other" />`);
  const a = document.getElementById("a") as HTMLTextAreaElement;
  const other = document.getElementById("other") as HTMLInputElement;
  const { later, flush } = deferred();
  const kept = keptFocus(document, later, () => false);

  a.focus();
  kept.hold();
  popstate();
  kept.restore();
  other.focus();
  flush();
  expect(document.activeElement).toBe(other);

  a.focus();
  kept.hold();
  popstate();
  a.remove();
  kept.restore();
  flush();
  expect(document.activeElement).toBe(document.body);

  root.append(a);
  a.focus();
  kept.hold();
  kept.drop();
  popstate();
  kept.restore();
  flush();
  expect(document.activeElement).toBe(document.body);
});

test("a touch screen keeps none: the field there is on a screen sliding away", () => {
  mount(`<textarea id="a"></textarea>`);
  const a = document.getElementById("a") as HTMLTextAreaElement;
  a.focus();
  const { later, flush } = deferred();
  const kept = keptFocus(document, later, () => true);
  kept.hold();
  popstate();
  kept.restore();
  flush();
  expect(document.activeElement).toBe(document.body);
});

test("with only the body focused there is nothing to hold", () => {
  const { later, flush } = deferred();
  const kept = keptFocus(document, later, () => false);
  popstate();
  kept.hold();
  kept.restore();
  flush();
  expect(document.activeElement).toBe(document.body);
});
