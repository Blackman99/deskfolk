import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { render } from "../test-render.ts";
import AutosaveState from "./AutosaveState.svelte";

const t = copyFor("zh");

function say(saving: boolean, failed: boolean, saved: boolean): { text: string; error: boolean } {
  const { host, close } = render(AutosaveState, { t, saving, failed, saved });
  const label = host.querySelector(".settings-save-state");
  const out = { text: label?.textContent?.trim() ?? "", error: label?.classList.contains("is-error") ?? false };
  close();
  return out;
}

test("the label says saving, failed, saved, or the hint before the first change — in that order of weight", () => {
  expect(say(false, false, false)).toEqual({ text: t.sidebar.autoSaveHint, error: false });
  expect(say(false, false, true)).toEqual({ text: t.sidebar.autoSaved, error: false });
  expect(say(false, true, true)).toEqual({ text: t.settings.saveFailed, error: true });
  expect(say(true, true, true)).toEqual({ text: t.sidebar.autoSaving, error: true });
});
