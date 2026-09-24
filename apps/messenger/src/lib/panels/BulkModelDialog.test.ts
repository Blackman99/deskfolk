import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { PatchBotsModelRequest } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import { modelSelectValue } from "../settings/provider-form.ts";
import { aBot, aProvider, fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, mouseDown, press, render } from "../test-render.ts";
import BulkModelDialog from "./BulkModelDialog.svelte";

const t = copyFor("zh");
const provider = aProvider();
const bots = [
  aBot({ id: "b1", name: "甲", model: "grok-4.6", provider_id: "prov-1", thinking_level: "high" }),
  aBot({ id: "b2", name: "乙", model: "grok-4.6", provider_id: "prov-1", thinking_level: "low" }),
  aBot({ id: "b3", name: "丙" }),
  aBot({ id: "b4", name: "丁", archived_at: "2026-09-20T00:00:00.000Z" }),
];
/** Built the way the shell builds the profile pane's options. */
const modelOptions = provider.models.map((model) => ({
  value: modelSelectValue(provider.id, model),
  label: model,
}));

function open(
  opts: { preselect?: string[]; patchBotsModel?: (body: PatchBotsModelRequest) => Promise<unknown> } = {},
) {
  const sent: PatchBotsModelRequest[] = [];
  const runtime = fakeRuntime(
    { bots, providers: [provider] },
    {
      patchBotsModel: (body: PatchBotsModelRequest) => {
        sent.push(body);
        return opts.patchBotsModel ? opts.patchBotsModel(body) : Promise.resolve(null);
      },
    },
  );
  let closed = 0;
  const view = render(BulkModelDialog, {
    runtime,
    t,
    modelOptions,
    preselect: opts.preselect ?? [],
    onClose: () => (closed += 1),
  });
  return { ...view, runtime, sent, closed: () => closed };
}

/** Each row's name and whether it is ticked, top to bottom. */
function rows(host: HTMLElement): { name: string; ticked: boolean; archived: boolean }[] {
  return [...host.querySelectorAll(".bulk-model-row")].map((row) => ({
    name: row.querySelector(".bulk-model-row-name")?.textContent?.trim() ?? "",
    ticked: (row.querySelector("input[type=checkbox]") as HTMLInputElement).checked,
    archived: row.querySelector(".bulk-model-archived") !== null,
  }));
}

function row(host: HTMLElement, name: string): HTMLInputElement {
  const found = [...host.querySelectorAll(".bulk-model-row")].find(
    (el) => el.querySelector(".bulk-model-row-name")?.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no row for ${name}`);
  return found.querySelector("input[type=checkbox]") as HTMLInputElement;
}

function applyButton(host: HTMLElement): HTMLButtonElement {
  return host.querySelector(".modal-foot button") as HTMLButtonElement;
}

/** Opens the model picker and picks the option with this label. */
function pick(host: HTMLElement, label: string): void {
  click(host.querySelector("#bulk-model-pick"));
  const option = [...host.querySelectorAll(".real-select-option")].find(
    (el) => el.querySelector(".real-select-option-label")?.firstChild?.textContent?.trim() === label,
  );
  if (!option) throw new Error(`no option ${label}`);
  click(option);
}

function levelChips(host: HTMLElement): { label: string; on: boolean }[] {
  return [...host.querySelectorAll("[role=radiogroup] [role=radio]")].map((chip) => ({
    label: chip.textContent?.trim() ?? "",
    on: chip.getAttribute("aria-checked") === "true",
  }));
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

test("opened from a group, its present Bots come ticked and first; an archived one does not", () => {
  const { host, close } = open({ preselect: ["b2", "b4", "gone"] });
  expect(rows(host)).toEqual([
    { name: "乙", ticked: true, archived: false },
    { name: "甲", ticked: false, archived: false },
    { name: "丙", ticked: false, archived: false },
    { name: "丁", ticked: false, archived: true },
  ]);
  expect(host.querySelector(".bulk-model-count")?.textContent?.trim()).toBe(t.bulkModel.selected(1));
  close();
});

test("each row says what the Bot runs on now", () => {
  const { host, close } = open();
  const pins = [...host.querySelectorAll(".bulk-model-row-pin")].map((el) => el.textContent?.trim());
  expect(pins).toEqual(["grok-4.6 · 高", "grok-4.6 · 低", "自动", "自动"]);
  close();
});

test("apply stays off until a Bot is ticked and a model is picked", () => {
  const { host, close } = open();
  expect(applyButton(host).disabled).toBe(true);
  click(row(host, "甲"));
  expect(applyButton(host).disabled).toBe(true);
  pick(host, "gemini-3.8-flash");
  expect(applyButton(host).disabled).toBe(false);
  expect(applyButton(host).textContent?.trim()).toBe(t.bulkModel.apply(1));
  click(row(host, "甲"));
  expect(applyButton(host).disabled).toBe(true);
  close();
});

test("a model brings its own levels with the default chosen, and apply sends model and level together", async () => {
  const { host, sent, closed, close } = open({ preselect: ["b1", "b2"] });
  pick(host, "grok-4.6");
  expect(levelChips(host)).toEqual([
    { label: "不思考", on: false },
    { label: "低", on: true },
    { label: "高", on: false },
  ]);
  click([...host.querySelectorAll("[role=radio]")].find((chip) => chip.textContent?.trim() === "高"));
  click(applyButton(host));
  await settle();
  expect(sent).toEqual([
    { bot_ids: ["b1", "b2"], model: "grok-4.6", provider_id: "prov-1", thinking_level: "high" },
  ]);
  expect(closed()).toBe(1);
  close();
});

test("swapping models keeps the level when the new one offers it and falls to its default when not", () => {
  const { host, close } = open({ preselect: ["b1"] });
  pick(host, "grok-4.6");
  click([...host.querySelectorAll("[role=radio]")].find((chip) => chip.textContent?.trim() === "高"));
  pick(host, "gemini-3.8-flash");
  expect(levelChips(host)).toEqual([{ label: "不思考", on: true }]);
  close();
});

test("automatic hides the level picker and sends no level", async () => {
  const { host, sent, close } = open({ preselect: ["b1", "b2"] });
  pick(host, "grok-4.6");
  expect(host.querySelector("[role=radiogroup]")).not.toBeNull();
  pick(host, t.sidebar.botModelDefault);
  expect(host.querySelector("[role=radiogroup]")).toBeNull();
  expect(host.textContent).toContain(t.bulkModel.autoHint);
  click(applyButton(host));
  await settle();
  expect(sent).toEqual([{ bot_ids: ["b1", "b2"], model: null, provider_id: null }]);
  close();
});

test("a refusal keeps every tick and the pick, and says nothing was changed", async () => {
  const { host, closed, close } = open({
    preselect: ["b1", "b2"],
    patchBotsModel: () =>
      Promise.resolve(new ApiError(422, "invalid_args", "model must be one of the provider models")),
  });
  pick(host, "grok-4.6");
  click(applyButton(host));
  await settle();
  expect(closed()).toBe(0);
  expect(host.querySelector("[role=alert]")?.textContent?.trim()).toBe(t.bulkModel.errorModel);
  expect(rows(host).filter((r) => r.ticked).map((r) => r.name)).toEqual(["甲", "乙"]);
  expect(host.querySelector("#bulk-model-pick")?.textContent?.trim()).toBe("grok-4.6");
  expect(applyButton(host).disabled).toBe(false);
  // Touching the picks again clears the message.
  click(row(host, "丙"));
  expect(host.querySelector("[role=alert]")).toBeNull();
  close();
});

test("a refusal that names a missing Bot says which one", async () => {
  const { host, close } = open({
    preselect: ["b1", "b2"],
    patchBotsModel: () => Promise.resolve(new ApiError(404, "not_found", "bot not found: b2")),
  });
  pick(host, "grok-4.6");
  click(applyButton(host));
  await settle();
  expect(host.querySelector("[role=alert]")?.textContent?.trim()).toBe(t.bulkModel.errorBot("乙"));
  close();
});

test("select all ticks every Bot in use but no archived one; clear unticks them all", () => {
  const { host, close } = open();
  click(buttonByText(host, t.bulkModel.selectAll));
  expect(rows(host).map((r) => r.ticked)).toEqual([true, true, true, false]);
  click(row(host, "丁"));
  click(buttonByText(host, t.bulkModel.clear));
  expect(rows(host).every((r) => !r.ticked)).toBe(true);
  expect(host.querySelector(".bulk-model-count")?.textContent?.trim()).toBe(t.bulkModel.selected(0));
  close();
});

test("an archived Bot can still be ticked by hand and goes out with the rest", async () => {
  const { host, sent, close } = open({ preselect: ["b1"] });
  click(row(host, "丁"));
  pick(host, "gemini-3.8-flash");
  click(applyButton(host));
  await settle();
  expect(sent[0]?.bot_ids).toEqual(["b1", "b4"]);
  close();
});

test("Escape closes the dialog, but with the picker open it only closes the picker", () => {
  const { host, closed, close } = open();
  const trigger = host.querySelector("#bulk-model-pick");
  click(trigger);
  expect(host.querySelector(".real-select-option")).not.toBeNull();
  // A real keystroke is cancelable; the picker cancels the one it used to close its list.
  press(trigger, "Escape", { cancelable: true });
  expect(host.querySelector(".real-select-option")).toBeNull();
  expect(closed()).toBe(0);
  press(trigger, "Escape", { cancelable: true });
  expect(closed()).toBe(1);
  close();
});

test("the dialog's Escape does not reach the drawer or window behind it", () => {
  const { host, close } = open();
  let reached = 0;
  const onKey = () => (reached += 1);
  window.addEventListener("keydown", onKey);
  press(host.querySelector(".bulk-model-row input"), "Escape");
  window.removeEventListener("keydown", onKey);
  expect(reached).toBe(0);
  close();
});

test("a click outside closes it; a drag that starts inside does not", () => {
  const { host, closed, close } = open();
  const backdrop = host.querySelector(".modal-backdrop") as HTMLElement;
  mouseDown(host.querySelector(".modal-dialog"));
  click(backdrop);
  expect(closed()).toBe(0);
  mouseDown(backdrop);
  click(backdrop);
  expect(closed()).toBe(1);
  close();
});

test("it is a labelled modal dialog and takes focus when it opens", () => {
  const { host, close } = open();
  const dialog = host.querySelector("[role=dialog]") as HTMLElement;
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  const title = host.querySelector(`#${dialog.getAttribute("aria-labelledby")}`);
  expect(title?.textContent?.trim()).toBe(t.bulkModel.title);
  expect(document.activeElement).toBe(dialog);
  close();
});

test("with no Bot on the roster it says so and offers nothing to tick", () => {
  const runtime = fakeRuntime({ bots: [], providers: [provider] });
  const { host, close } = render(BulkModelDialog, {
    runtime,
    t,
    modelOptions,
    preselect: [],
    onClose: () => {},
  });
  expect(host.textContent).toContain(t.bulkModel.empty);
  expect(host.querySelectorAll(".bulk-model-row")).toHaveLength(0);
  close();
});
