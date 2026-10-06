import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, fill, press, render } from "../test-render.ts";
import MessageEditor from "./MessageEditor.svelte";

const t = copyFor("zh");

function editor(opts: { value?: string; saving?: boolean; error?: string | null } = {}) {
  const calls: string[] = [];
  const props = reactive({
    t,
    value: opts.value ?? "片长 30 秒",
    saving: opts.saving ?? false,
    error: opts.error ?? null,
    onInput: (value: string) => {
      props.value = value;
      calls.push(`input:${value}`);
    },
    onSave: () => calls.push("save"),
    onCancel: () => calls.push("cancel"),
  });
  const view = render(MessageEditor, props);
  const field = view.host.querySelector<HTMLTextAreaElement>("textarea")!;
  return { ...view, props, calls, field };
}

test("opens on the line's words, focused, with the caret after them", () => {
  const { field, close } = editor();
  expect(field.value).toBe("片长 30 秒");
  expect(document.activeElement).toBe(field);
  expect(field.selectionStart).toBe("片长 30 秒".length);
  close();
});

test("Enter keeps the change; Shift+Enter is a new line; Esc leaves the line as it was", () => {
  const { field, calls, close } = editor();
  fill(field, "片长 45 秒");
  press(field, "Enter", { shiftKey: true });
  expect(calls).toEqual(["input:片长 45 秒"]);
  press(field, "Enter");
  expect(calls.at(-1)).toBe("save");
  press(field, "Escape");
  expect(calls.at(-1)).toBe("cancel");
  close();
});

test("an Enter that only confirms an input method's candidate is no save", () => {
  const { field, calls, close } = editor();
  press(field, "Enter", { isComposing: true });
  press(field, "Enter", { keyCode: 229 });
  expect(calls).toEqual([]);
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  press(field, "Enter");
  expect(calls).toEqual([]);
  close();
});

test("the buttons save and cancel; saving holds both and the field, and a refusal is said under it", () => {
  const { host, calls, props, field, close } = editor();
  click(buttonByText(host, t.chat.editSave));
  click(buttonByText(host, t.chat.editCancel));
  expect(calls).toEqual(["save", "cancel"]);

  props.saving = true;
  press(field, "Enter");
  expect(calls).toEqual(["save", "cancel"]);
  expect(buttonByText(host, t.chat.editSaving).disabled).toBe(true);
  expect(buttonByText(host, t.chat.editCancel).disabled).toBe(true);
  expect(field.disabled).toBe(true);

  props.saving = false;
  props.error = t.chat.editNotEditable;
  flushSync();
  expect(host.querySelector("[role=alert]")?.textContent).toBe(t.chat.editNotEditable);
  expect(field.getAttribute("aria-invalid")).toBe("true");
  close();
});
