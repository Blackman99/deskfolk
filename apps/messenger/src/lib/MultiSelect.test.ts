import { expect, test } from "bun:test";
import MultiSelect from "./MultiSelect.svelte";
import { click, fill, mouseDown, press, render } from "./test-render.ts";

const options = [
  { value: "b1", label: "甲", hint: "收集资料" },
  { value: "b2", label: "乙", hint: "剪片子" },
  { value: "b3", label: "丙" },
];

/**
 * The picker owns `values`, so a test that wants to read the selection back reads the chips —
 * the same thing the person sees. What reaches the form is covered where the form is.
 */
function chips(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".multi-select-chip-label")].map((c) => c.textContent ?? "");
}

function labels(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".multi-select-option-label")].map((c) => c.textContent ?? "");
}

function open(props: Record<string, unknown> = {}) {
  const view = render(MultiSelect as never, {
    id: "picker",
    options,
    noMatchLabel: "没有匹配的。",
    emptyLabel: "名册是空的。",
    removeLabel: "移出",
    ...props,
  } as never);
  mouseDown(view.host.querySelector(".multi-select-field"));
  return view;
}

test("the list opens closed and comes up on a click in the field", () => {
  const { host, close } = render(MultiSelect as never, { id: "picker", options } as never);
  expect(labels(host)).toEqual([]);
  mouseDown(host.querySelector(".multi-select-field"));
  expect(labels(host)).toEqual(["甲", "乙", "丙"]);
  close();
});

test("the query matches a label or a hint, anywhere in it", () => {
  const { host, close } = open();
  fill(host.querySelector("#picker"), "片子");
  expect(labels(host)).toEqual(["乙"]);
  fill(host.querySelector("#picker"), "丙");
  expect(labels(host)).toEqual(["丙"]);
  close();
});

test("a query that matches nothing says so, and an empty list says something else", () => {
  const { host, close } = open();
  fill(host.querySelector("#picker"), "没有这个人");
  expect(host.querySelector(".multi-select-empty")?.textContent?.trim()).toBe("没有匹配的。");
  close();

  const empty = open({ options: [] });
  expect(empty.host.querySelector(".multi-select-empty")?.textContent?.trim()).toBe("名册是空的。");
  empty.close();
});

test("picking several keeps the list open and reports every change", () => {
  const seen: string[][] = [];
  const { host, close } = open({ onchange: (next: string[]) => seen.push(next) });
  click(host.querySelectorAll(".multi-select-option")[0]);
  click(host.querySelectorAll(".multi-select-option")[2]);
  expect(chips(host)).toEqual(["甲", "丙"]);
  expect(labels(host)).toEqual(["甲", "乙", "丙"]);
  expect(seen).toEqual([["b1"], ["b1", "b3"]]);
  close();
});

test("clicking a picked option again takes it back off", () => {
  const { host, close } = open();
  click(host.querySelectorAll(".multi-select-option")[1]);
  expect(chips(host)).toEqual(["乙"]);
  click(host.querySelectorAll(".multi-select-option")[1]);
  expect(chips(host)).toEqual([]);
  close();
});

test("the keyboard walks the list and Enter ticks what it lands on", () => {
  const { host, close } = open();
  const input = host.querySelector("#picker");
  press(input, "ArrowDown");
  press(input, "Enter");
  expect(chips(host)).toEqual(["乙"]);
  press(input, "ArrowUp");
  press(input, "Enter");
  expect(chips(host)).toEqual(["乙", "甲"]);
  close();
});

test("Backspace on an empty query drops the last chip, and never eats a query", () => {
  const { host, close } = open();
  click(host.querySelectorAll(".multi-select-option")[0]);
  click(host.querySelectorAll(".multi-select-option")[1]);
  fill(host.querySelector("#picker"), "甲");
  press(host.querySelector("#picker"), "Backspace");
  expect(chips(host)).toEqual(["甲", "乙"]);
  fill(host.querySelector("#picker"), "");
  press(host.querySelector("#picker"), "Backspace");
  expect(chips(host)).toEqual(["甲"]);
  close();
});

test("closing the list drops the query, so the next open starts on the whole list", () => {
  const { host, close } = open();
  fill(host.querySelector("#picker"), "甲");
  expect(labels(host)).toEqual(["甲"]);
  press(host.querySelector("#picker"), "Escape");
  expect(labels(host)).toEqual([]);
  mouseDown(host.querySelector(".multi-select-field"));
  expect(labels(host)).toEqual(["甲", "乙", "丙"]);
  close();
});

test("a disabled picker neither opens nor lets a chip go", () => {
  const { host, close } = render(MultiSelect as never, {
    id: "picker",
    options,
    values: ["b1"],
    disabled: true,
  } as never);
  mouseDown(host.querySelector(".multi-select-field"));
  expect(labels(host)).toEqual([]);
  click(host.querySelector(".multi-select-chip-remove"));
  expect(chips(host)).toEqual(["甲"]);
  close();
});
