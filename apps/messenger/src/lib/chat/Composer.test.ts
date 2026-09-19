import { expect, test } from "bun:test";
import { flushSync, tick } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aDirect, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { render } from "../test-render.ts";
import Composer from "./Composer.svelte";

const t = copyFor("zh");

function open(draft = "写点什么") {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.selectedId = selected.id;
  runtime.draft = draft;
  const sent: File[][] = [];
  const view = render(Composer, {
    runtime,
    t,
    selected,
    onSend: async (files: File[]) => {
      sent.push(files);
      runtime.draft = "";
    },
    onPickPrompt: () => {},
  });
  const editor = view.host.querySelector(".composer-input") as HTMLElement;
  return { ...view, runtime, editor, sent };
}

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
