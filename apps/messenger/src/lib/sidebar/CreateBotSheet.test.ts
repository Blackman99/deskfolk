import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aProvider, fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import CreateBotSheet from "./CreateBotSheet.svelte";

const t = copyFor("zh");

function open() {
  const closed: true[] = [];
  const runtime = fakeRuntime();
  const view = render(CreateBotSheet, { runtime, bots: [], t, modelOptions: [], onClose: () => closed.push(true) });
  return { ...view, runtime, closed };
}

/**
 * The frame that turns this dialog into a page below 680px lives in `modals.css`; a dialog opts
 * into it with `page-on-phone` and by carrying the way back its ✕ is replaced with.
 */
test("the new-Bot form is a page on a phone, with a way back where a phone keeps it", () => {
  const { host, closed, close } = open();
  const backdrop = host.querySelector('.modal-backdrop');
  expect(backdrop?.classList.contains('page-on-phone')).toBe(true);
  const back = host.querySelector('.modal-head .modal-back');
  expect(back).not.toBeNull();
  // The ✕ stays for wider windows, where the dialog is still a dialog.
  expect(host.querySelector('.modal-head .modal-close')).not.toBeNull();
  click(back);
  expect(closed).toHaveLength(1);
  close();
});

/** ADR 0078: set up on Claude Code alone, a new Bot starts on Claude Agent; with an endpoint, on the app. */
test("the new-Bot form starts on Claude Agent when there is no endpoint a Bot could run on", () => {
  for (const [providers, runner] of [
    [[], t.sidebar.botRunnerClaude],
    [[aProvider({ key_set: false, base_url: "https://api.example.com/v1" })], t.sidebar.botRunnerClaude],
    [[aProvider({ key_set: false, base_url: "http://localhost:11434/v1" })], t.sidebar.botRunnerApp],
    [[aProvider({ key_set: true })], t.sidebar.botRunnerApp],
  ] as const) {
    const runtime = fakeRuntime({ providers: [...providers] });
    const view = render(CreateBotSheet, { runtime, bots: [], t, modelOptions: [], onClose: () => {} });
    expect(view.host.querySelector("#bot-runner")?.textContent?.trim()).toBe(runner);
    view.close();
  }
});
