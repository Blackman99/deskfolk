import { expect, test } from "bun:test";
import { backdropClick, isOutside } from "./click-outside.ts";

/** Stand-in for a DOM node: `bun test` has no document, and only `contains` is used. */
function node(...owned: object[]): Node {
  const self = {
    contains: (other: Node | null) => other === (self as unknown as Node) || owned.includes(other as object),
  };
  return self as unknown as Node;
}

const target = {} as Node;

test("a click with no target counts as outside", () => {
  expect(isOutside(null, node(target))).toBe(true);
});

test("a click inside any container is not outside", () => {
  expect(isOutside(target, node(), node(target))).toBe(false);
  expect(isOutside(target, node(target), node())).toBe(false);
});

test("a click inside none of the containers is outside", () => {
  expect(isOutside(target, node(), node())).toBe(true);
});

test("containers that are not mounted yet are skipped", () => {
  expect(isOutside(target, null, undefined)).toBe(true);
  expect(isOutside(target, null, node(target))).toBe(false);
});

test("no containers at all means every click is outside", () => {
  expect(isOutside(target)).toBe(true);
});

const backdrop = {} as EventTarget;
const sheet = {} as EventTarget;

/** A `mousedown`/`click` pair as the browser reports them: `currentTarget` is always the backdrop. */
function on(element: EventTarget): MouseEvent {
  return { target: element, currentTarget: backdrop } as unknown as MouseEvent;
}

test("a press and release on the backdrop dismiss", () => {
  const guard = backdropClick();
  guard.press(on(backdrop));
  expect(guard.isOutside(on(backdrop))).toBe(true);
});

test("a press inside the sheet never dismisses, even when the release lands on the backdrop", () => {
  const guard = backdropClick();
  guard.press(on(sheet));
  // The drag ends over the backdrop, so `click` reports the backdrop as the target.
  expect(guard.isOutside(on(backdrop))).toBe(false);
});

test("a press inside the sheet does not carry over to the next click outside", () => {
  const guard = backdropClick();
  guard.press(on(sheet));
  expect(guard.isOutside(on(backdrop))).toBe(false);
  guard.press(on(backdrop));
  expect(guard.isOutside(on(backdrop))).toBe(true);
});

test("a click inside the sheet never dismisses", () => {
  const guard = backdropClick();
  guard.press(on(sheet));
  expect(guard.isOutside(on(sheet))).toBe(false);
});
