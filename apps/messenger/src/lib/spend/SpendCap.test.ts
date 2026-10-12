import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { click, fill, render } from "../test-render.ts";
import { spendCopyFor } from "./spend-copy.ts";
import SpendCap from "./SpendCap.svelte";

const copy = spendCopyFor("zh");

function mount(capUsd: number | null, refusal: unknown = null) {
  const set: Array<number | null> = [];
  const view = render(SpendCap, {
    copy,
    capUsd,
    onSetCap: (usd: number | null) => {
      set.push(usd);
      return Promise.resolve(refusal);
    },
  });
  const input = view.host.querySelector("input") as HTMLInputElement;
  return { ...view, input, set };
}

function leave(input: HTMLInputElement): void {
  input.dispatchEvent(new FocusEvent("focus"));
  input.dispatchEvent(new FocusEvent("blur"));
  flushSync();
}

test("no cap: an empty field and no clear button; a number saves on leaving the field", () => {
  const { host, input, set, close } = mount(null);
  try {
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(copy.cap.off);
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([]);
    expect(host.querySelector(".cap-hint")?.textContent?.trim()).toBe(copy.cap.hint);
    input.dispatchEvent(new FocusEvent("focus"));
    fill(input, "5");
    leave(input);
    expect(set).toEqual([5]);
  } finally {
    close();
  }
});

test("a cap shows its amount; clearing it, by the button or an empty field, sets none", () => {
  const { host, input, set, close } = mount(2.5);
  try {
    expect(input.value).toBe("2.5");
    click([...host.querySelectorAll("button")].find((button) => button.textContent === copy.cap.clear));
    input.dispatchEvent(new FocusEvent("focus"));
    fill(input, "");
    leave(input);
    expect(set).toEqual([null, null]);
  } finally {
    close();
  }
});

test("the same amount saves nothing, a bad one says so, and a refusal is said", async () => {
  const same = mount(3);
  try {
    same.input.dispatchEvent(new FocusEvent("focus"));
    fill(same.input, "3");
    leave(same.input);
    expect(same.set).toEqual([]);
    fill(same.input, "-1");
    leave(same.input);
    expect(same.set).toEqual([]);
    expect(same.host.querySelector(".cap-hint")?.textContent?.trim()).toBe(copy.cap.invalid);
  } finally {
    same.close();
  }

  const refused = mount(null, { status: 422 });
  try {
    refused.input.dispatchEvent(new FocusEvent("focus"));
    fill(refused.input, "1");
    leave(refused.input);
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(refused.set).toEqual([1]);
    expect(refused.host.querySelector(".cap-hint")?.textContent?.trim()).toBe(copy.cap.failed);
  } finally {
    refused.close();
  }
});
