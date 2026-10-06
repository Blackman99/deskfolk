import { expect, test } from "bun:test";
import { createRawSnippet, flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { click, press, render } from "../test-render.ts";
import MessageTextSheet from "./MessageTextSheet.svelte";
import { closeMessageText, messageTextOpen } from "./message-text-pages.ts";

const t = copyFor("zh");
const text = createRawSnippet(() => ({ render: () => `<p class="zz-text">第一句。第二句要单独复制。</p>` }));

function openSheet() {
  let closed = 0;
  const view = render(MessageTextSheet, {
    t,
    subject: "Alpha · 10:42",
    onClose: () => {
      closed += 1;
    },
    children: text,
  });
  return { ...view, closed: () => closed };
}

test("the page names itself, says how to select, and shows the message's text", () => {
  const { host, close } = openSheet();
  try {
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(host.querySelector("h2")?.textContent).toBe(t.chat.selectText);
    expect(host.querySelector(".modal-head-subject")?.textContent).toBe("Alpha · 10:42");
    expect(host.querySelector(".message-text-hint")?.textContent).toBe(t.chat.selectTextHint);
    expect(host.querySelector(".message-text .zz-text")?.textContent).toBe("第一句。第二句要单独复制。");
  } finally {
    close();
  }
});

/*
 * Android shows its Copy bar through `contextmenu`; a page that cancels it leaves a selection that
 * cannot be copied. The long-press that selects a word fires one, and so does letting go of a handle.
 */
test("a long-press on the text is left to the phone", () => {
  const { host, close } = openSheet();
  try {
    const longPress = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    host.querySelector(".zz-text")!.dispatchEvent(longPress);
    expect(longPress.defaultPrevented).toBe(false);
  } finally {
    close();
  }
});

test("back, ✕ and Escape close it", () => {
  const { host, close, closed } = openSheet();
  try {
    click(host.querySelector(".modal-back"));
    expect(closed()).toBe(1);
    click(host.querySelector(".modal-close"));
    expect(closed()).toBe(2);
    press(host.querySelector('[role="dialog"]'), "Escape");
    expect(closed()).toBe(3);
  } finally {
    close();
  }
});

test("a press on the backdrop closes it; a selection dragged out of the text does not", () => {
  const { host, close, closed } = openSheet();
  try {
    const backdrop = host.querySelector('[role="dialog"]')!;
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flushSync();
    expect(closed()).toBe(1);
    // Pressed on the text, released past the page's edge: the click lands on the backdrop.
    host.querySelector(".zz-text")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flushSync();
    expect(closed()).toBe(1);
  } finally {
    close();
  }
});

test("while it is open the phone's Back closes it; once it is gone, Back is history's again", () => {
  const { close, closed } = openSheet();
  expect(messageTextOpen()).toBe(true);
  expect(closeMessageText()).toBe(true);
  expect(closed()).toBe(1);
  close();
  expect(messageTextOpen()).toBe(false);
  expect(closeMessageText()).toBe(false);
});
