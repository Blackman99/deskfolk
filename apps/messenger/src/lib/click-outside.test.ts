import { expect, test } from "bun:test";
import { isOutside } from "./click-outside.ts";

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
