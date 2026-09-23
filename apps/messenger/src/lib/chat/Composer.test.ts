import { expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID, USER_MEMBER } from "@real-bot/protocol";
import { flushSync, tick } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aDirect, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { render } from "../test-render.ts";
import Composer from "./Composer.svelte";

const t = copyFor("zh");

function open(draft = "写点什么", remote = false) {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  runtime.draft = draft;
  runtime.remote = remote;
  const sent: File[][] = [];
  const view = render(Composer, {
    runtime,
    t,
    selected,
    onSend: async (files: File[]) => {
      sent.push(files);
      runtime.draft = "";
    },
    onPickPrompt: (prompt: string) => { runtime.draft = prompt; },
  });
  const editor = view.host.querySelector(".composer-input") as HTMLElement;
  return { ...view, runtime, editor, sent };
}

test("single-line text is vertically centered within the action button height", () => {
  const viewport = (window as unknown as {
    happyDOM: { setViewport: (size: { width: number; height: number }) => void };
  }).happyDOM;
  const original = { width: window.innerWidth, height: window.innerHeight };
  try {
    for (const width of [320, 390, 680, 1180]) {
      viewport.setViewport({ width, height: 844 });
      for (const draft of ["", "中文输入 test"]) {
        const { host, editor, close } = open(draft);
        try {
          const input = getComputedStyle(editor);
          const button = getComputedStyle(host.querySelector(".composer-action")!);
          const line = parseFloat(input.lineHeight);
          const top = parseFloat(input.paddingTop);
          const bottom = parseFloat(input.paddingBottom);
          expect(top).toBe(bottom);
          expect(line + top + bottom).toBe(parseFloat(button.height));
          expect(parseFloat(input.minHeight)).toBe(parseFloat(button.height));
        } finally {
          close();
        }
      }
    }
  } finally {
    viewport.setViewport(original);
  }
});

test("phone suggestions stay in one scrollable row and insert the complete prompt", () => {
  const viewport = (window as unknown as {
    happyDOM: { setViewport: (size: { width: number; height: number }) => void };
  }).happyDOM;
  const original = { width: window.innerWidth, height: window.innerHeight };
  try {
    for (const width of [320, 390, 680]) {
      viewport.setViewport({ width, height: 844 });
      const { host, runtime, editor, sent, close } = open("");
      try {
        const prompt = "核对所有镜头字幕与配音细节。".repeat(50);
        runtime.composerSuggestions = Array.from({ length: 3 }, (_, i) => ({
          id: String(i), label: "请审片员复审并同步完整结果".repeat(20), prompt,
        }));
        flushSync();
        const bar = host.querySelector(".composer-suggest-bar")!;
        const style = getComputedStyle(bar);
        expect(style.flexWrap).toBe("nowrap");
        expect(style.overflowX).toBe("auto");
        expect(style.overflowY).toBe("hidden");
        expect(style.pointerEvents).toBe("auto");
        const chip = bar.querySelector("button")!;
        expect(getComputedStyle(chip).whiteSpace).toBe("nowrap");
        expect(getComputedStyle(chip).textOverflow).toBe("ellipsis");
        expect(getComputedStyle(chip).maxWidth).toBe("85%");
        expect(getComputedStyle(editor).maxHeight).toBe("min(120px, 25dvh)");
        chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        flushSync();
        expect(runtime.draft).toBe(prompt);
        expect(editor.textContent).toBe(prompt);
        expect(sent).toHaveLength(0);
      } finally {
        close();
      }
    }
  } finally {
    viewport.setViewport(original);
  }
});

/** The editor follows `runtime.draft`, whoever set it — a quote reply, a starter chip, a send. */
test("the contenteditable mirrors the runtime draft", async () => {
  const { editor, runtime, close } = open("初始草稿");
  expect(editor.textContent).toContain("初始草稿");
  runtime.draft = "换成别的";
  await tick();
  flushSync();
  expect(editor.textContent).toContain("换成别的");
  close();
});

test("Enter sends", () => {
  const { editor, sent, close } = open();
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  flushSync();
  expect(sent).toHaveLength(1);
  close();
});

test("Shift+Enter does not send", () => {
  const { editor, sent, close } = open();
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
  flushSync();
  expect(sent).toHaveLength(0);
  close();
});

test("Enter while the IME is composing does not send", () => {
  const { editor, sent, close } = open();
  editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  flushSync();
  expect(sent).toHaveLength(0);
  close();
});

/** Confirming a candidate fires `compositionend` and then a leftover Enter. It must not send. */
test("the Enter right after the IME commits is swallowed", () => {
  const { editor, sent, close } = open();
  editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  editor.dispatchEvent(new CompositionEvent("compositionend", { data: "字", bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  flushSync();
  expect(sent).toHaveLength(0);
  close();
});

test("an empty draft cannot be sent", () => {
  const { editor, sent, close } = open("");
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  flushSync();
  expect(sent).toHaveLength(0);
  close();
});

test("the jump-to-bottom control hides inside the input and floats clear of it when shown", () => {
  const { host, close } = open("");
  const slot = host.querySelector(".scroll-bottom-slot") as HTMLElement;
  const button = slot.querySelector(".scroll-bottom-btn") as HTMLButtonElement;
  const hidden = getComputedStyle(button);
  const slotStyle = getComputedStyle(slot);
  expect(slot.classList.contains("is-shown")).toBe(false);
  expect(hidden.transform).toContain("translateY(76px)");
  expect(hidden.borderRadius).toBe("50%");
  expect(hidden.pointerEvents).toBe("none");
  expect(button.tabIndex).toBe(-1);
  expect(slotStyle.overflow).toBe("hidden");
  expect(slotStyle.top).toBe("-44px");
  close();
});

test("showing the jump-to-bottom control slides it out of the card and keeps it clickable", () => {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  let jumps = 0;
  const view = render(Composer, {
    runtime,
    t,
    selected,
    showScrollBottom: true,
    onScrollToBottom: () => { jumps += 1; },
    onSend: async () => {},
    onPickPrompt: () => {},
  });
  const slot = view.host.querySelector(".scroll-bottom-slot") as HTMLElement;
  const button = slot.querySelector(".scroll-bottom-btn") as HTMLButtonElement;
  expect(slot.classList.contains("is-shown")).toBe(true);
  expect(getComputedStyle(button).transform).toContain("translateY(0)");
  expect(getComputedStyle(button).pointerEvents).toBe("auto");
  expect(button.tabIndex).toBe(0);
  expect(button.getAttribute("aria-label")).toBe(t.chat.scrollToBottom);
  button.click();
  expect(jumps).toBe(1);
  view.close();
});

test("the remote attachment limit sits inside an empty composer", () => {
  const { host, runtime, close } = open("", true);
  expect(host.querySelector(".composer-inline-limit")?.textContent).toContain(t.composer.attachLimit);
  runtime.draft = "已经开始输入";
  flushSync();
  expect(host.querySelector(".composer-inline-limit")).toBeNull();
  close();
});

/** You can read a Bot↔Bot direct, but there is nowhere to type: you are not a participant. */
test("a Bot to Bot direct shows the read-only notice and no way in", () => {
  const selected = aBotDirect();
  const runtime = reactive(
    fakeRuntime({
      bots: [aBot({ id: "bot-1" }), aBot({ id: "bot-2" })],
      sessions: [selected],
    }),
  );
  runtime.selectedId = selected.id;
  const view = render(Composer, {
    runtime,
    t,
    selected,
    onSend: async () => {},
    onPickPrompt: () => {},
  });
  expect(view.host.querySelector(".composer-locked-message")?.textContent).toContain(
    t.chat.botBotLockedNotice,
  );
  const editor = view.host.querySelector(".composer-input") as HTMLElement;
  expect(editor.getAttribute("contenteditable")).toBe("false");
  expect((view.host.querySelector(".attach-btn") as HTMLButtonElement)?.disabled).toBe(true);
  view.close();
});
