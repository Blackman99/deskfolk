import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aProvider } from "../test-fixtures.ts";
import { modelSelectValue } from "../settings/provider-form.ts";
import {
  AUTO_CHOICE,
  botPinLabel,
  bulkModelErrorCopy,
  bulkModelOptions,
  choiceSelectValue,
  initialSelection,
  liveSelection,
  mapBulkModelError,
  orderBulkRows,
  pickBulkModel,
  planBulkModel,
  selectAllActive,
} from "./bulk-model.ts";

const t = copyFor("zh");
const ARCHIVED = "2026-09-20T00:00:00.000Z";
const roster = [
  aBot({ id: "b1", name: "甲" }),
  aBot({ id: "b2", name: "乙" }),
  aBot({ id: "b3", name: "丙", archived_at: ARCHIVED }),
  aBot({ id: "b4", name: "丁" }),
];
const providers = [
  aProvider(),
  aProvider({
    id: "prov-2",
    name: "Second",
    models: ["deep-r2"],
    model_catalog: [{ name: "deep-r2", price: 1, thinking_levels: ["low", "high", "max"], strengths: [] }],
  }),
];
const grok = modelSelectValue("prov-1", "grok-4.6");
const flash = modelSelectValue("prov-1", "gemini-3.8-flash");
const deep = modelSelectValue("prov-2", "deep-r2");

test("the opening pick keeps what is on the roster and in use, in roster order", () => {
  expect(initialSelection(roster, ["b4", "b1", "gone", "b3"])).toEqual(["b1", "b4"]);
  expect(initialSelection(roster, [])).toEqual([]);
});

test("rows put the opening pick first and the archived last, and keep roster order within each", () => {
  const rows = orderBulkRows(roster, new Set(["b4"]));
  expect(rows.map((bot) => bot.id)).toEqual(["b4", "b1", "b2", "b3"]);
  expect(orderBulkRows(roster, new Set()).map((bot) => bot.id)).toEqual(["b1", "b2", "b4", "b3"]);
});

test("a tick for a Bot that left the roster no longer counts, and a double tick counts once", () => {
  expect(liveSelection(roster, ["b2", "gone", "b2", "b1"])).toEqual(["b2", "b1"]);
});

test("select all takes every Bot in use and leaves the archived to a tick by hand", () => {
  expect(selectAllActive(roster, [])).toEqual(["b1", "b2", "b4"]);
  // An archived Bot already ticked stays ticked.
  expect(selectAllActive(roster, ["b3"])).toEqual(["b1", "b2", "b3", "b4"]);
});

test("the picker lists automatic first, then the profile pane's own options", () => {
  const options = bulkModelOptions([{ value: grok, label: "grok-4.6" }], "自动");
  expect(options).toEqual([
    { value: AUTO_CHOICE, label: "自动" },
    { value: grok, label: "grok-4.6" },
  ]);
});

test("the picker shows its placeholder until you pick, then the pick", () => {
  expect(choiceSelectValue(null)).toBe("");
  expect(choiceSelectValue({ model: "", thinkingLevel: "" })).toBe(AUTO_CHOICE);
  expect(choiceSelectValue({ model: grok, thinkingLevel: "low" })).toBe(grok);
});

test("picking a model lands on its default level; automatic clears the level", () => {
  expect(pickBulkModel(grok, null, providers)).toEqual({ model: grok, thinkingLevel: "low" });
  expect(pickBulkModel(flash, null, providers)).toEqual({ model: flash, thinkingLevel: "none" });
  expect(pickBulkModel(AUTO_CHOICE, { model: grok, thinkingLevel: "high" }, providers)).toEqual({
    model: "",
    thinkingLevel: "",
  });
});

test("swapping models keeps the chosen level when the new model offers it, else its default", () => {
  const high = { model: grok, thinkingLevel: "high" };
  expect(pickBulkModel(deep, high, providers)).toEqual({ model: deep, thinkingLevel: "high" });
  expect(pickBulkModel(flash, high, providers)).toEqual({ model: flash, thinkingLevel: "none" });
  // From automatic there is no level to keep.
  expect(pickBulkModel(deep, { model: "", thinkingLevel: "" }, providers)).toEqual({
    model: deep,
    thinkingLevel: "low",
  });
});

test("there is nothing to send until a Bot is ticked and a model is picked", () => {
  expect(planBulkModel([], { model: grok, thinkingLevel: "low" })).toBeNull();
  expect(planBulkModel(["b1"], null)).toBeNull();
});

test("a pinned model goes out with its endpoint and the level on screen, once per Bot", () => {
  expect(planBulkModel(["b1", "b2", "b1"], { model: grok, thinkingLevel: "high" })).toEqual({
    bot_ids: ["b1", "b2"],
    model: "grok-4.6",
    provider_id: "prov-1",
    thinking_level: "high",
  });
});

test("automatic clears model and endpoint and sends no level at all", () => {
  const body = planBulkModel(["b1", "b2"], { model: "", thinkingLevel: "" });
  expect(body).toEqual({ bot_ids: ["b1", "b2"], model: null, provider_id: null });
  expect(body && "thinking_level" in body).toBe(false);
});

test("a model with no level picked leaves the level to the daemon's default", () => {
  const body = planBulkModel(["b1"], { model: grok, thinkingLevel: "" });
  expect(body).toEqual({ bot_ids: ["b1"], model: "grok-4.6", provider_id: "prov-1" });
});

test("a row names the pin as model · level, the model alone, or automatic", () => {
  const labels = { auto: t.sidebar.botModelDefault, levels: t.sidebar.thinkingLevels };
  expect(botPinLabel({ model: null, thinking_level: null }, labels)).toBe("自动");
  expect(botPinLabel({ model: "grok-4.6", thinking_level: null }, labels)).toBe("grok-4.6");
  expect(botPinLabel({ model: "grok-4.6", thinking_level: "high" }, labels)).toBe("grok-4.6 · 高");
  // A level the endpoint advertised and the app has no word for shows as the endpoint spells it.
  expect(botPinLabel({ model: "deep-r2", thinking_level: "turbo" }, labels)).toBe("deep-r2 · turbo");
});

test("with more than one endpoint, a row also names the endpoint its model runs on", () => {
  const labels = { auto: t.sidebar.botModelDefault, levels: t.sidebar.thinkingLevels };
  const two = [
    { id: "prov-1", name: "Default" },
    { id: "prov-2", name: "Other" },
  ];
  const pinned = { model: "grok-4.6", thinking_level: "high", provider_id: "prov-2" };
  expect(botPinLabel(pinned, labels, two)).toBe("grok-4.6 · 高 · Other");
  expect(botPinLabel({ ...pinned, provider_id: "prov-1" }, labels, two)).toBe("grok-4.6 · 高 · Default");
  expect(botPinLabel({ ...pinned, thinking_level: null }, labels, two)).toBe("grok-4.6 · Other");
  // One endpoint needs no name; an unpinned endpoint or automatic has none to show.
  expect(botPinLabel(pinned, labels, two.slice(0, 1))).toBe("grok-4.6 · 高");
  expect(botPinLabel({ ...pinned, provider_id: null }, labels, two)).toBe("grok-4.6 · 高");
  expect(botPinLabel({ model: null, thinking_level: null, provider_id: "prov-2" }, labels, two)).toBe("自动");
});

test("a refused model or endpoint reads as a model problem", () => {
  expect(mapBulkModelError(422, "model must be one of endpoint_models", roster)).toEqual({ kind: "model" });
  expect(mapBulkModelError(422, "model must be one of the provider models", roster)).toEqual({
    kind: "model",
  });
  expect(mapBulkModelError(404, "provider not found", roster)).toEqual({ kind: "model" });
});

test("a refused level reads as a level problem", () => {
  expect(
    mapBulkModelError(422, "thinking_level must be one the pinned model supports", roster),
  ).toEqual({ kind: "thinking" });
  expect(mapBulkModelError(422, "thinking_level needs a pinned model", roster)).toEqual({
    kind: "thinking",
  });
});

test("a missing Bot is named when the message carries its id or its quoted name", () => {
  expect(mapBulkModelError(404, "bot not found: b2", roster)).toEqual({ kind: "bot", name: "乙" });
  expect(mapBulkModelError(422, 'bot "丁" is deleted', roster)).toEqual({ kind: "bot", name: "丁" });
  // Deleted meanwhile: gone from the snapshot too, so there is no name left to give.
  expect(mapBulkModelError(404, "bot not found: 01GONE", roster)).toEqual({ kind: "bot", name: null });
});

test("the batch cap says how many fit in one go", () => {
  expect(mapBulkModelError(422, "bot_ids can name at most 200 Bots", roster)).toEqual({
    kind: "too_many",
    max: 200,
  });
});

test("a bare not found, or anything else, stays general", () => {
  // A daemon without this endpoint answers with the router's own 404.
  expect(mapBulkModelError(404, "not found", roster)).toEqual({ kind: "generic" });
  // Naming a Bot is not the same as it being missing: a repeated id is the dialog's own slip.
  expect(mapBulkModelError(422, "bot_ids names b2 more than once", roster)).toEqual({ kind: "generic" });
  expect(mapBulkModelError(422, "bot_ids must name at least one Bot", roster)).toEqual({ kind: "generic" });
  expect(mapBulkModelError(409, "conflict", roster)).toEqual({ kind: "generic" });
  // The runtime's own refusal over a remote link, which has no bulk route.
  expect(mapBulkModelError(0, "Not available over a remote link", roster)).toEqual({ kind: "generic" });
});

test("every refusal says what to do and that no Bot was changed", () => {
  const lines = [
    bulkModelErrorCopy({ kind: "model" }, t.bulkModel),
    bulkModelErrorCopy({ kind: "thinking" }, t.bulkModel),
    bulkModelErrorCopy({ kind: "bot", name: "乙" }, t.bulkModel),
    bulkModelErrorCopy({ kind: "bot", name: null }, t.bulkModel),
    bulkModelErrorCopy({ kind: "too_many", max: 200 }, t.bulkModel),
    bulkModelErrorCopy({ kind: "generic" }, t.bulkModel),
  ];
  expect(lines).toEqual([
    t.bulkModel.errorModel,
    t.bulkModel.errorThinking,
    t.bulkModel.errorBot("乙"),
    t.bulkModel.errorBotGone,
    t.bulkModel.errorTooMany(200),
    t.bulkModel.errorGeneric,
  ]);
  expect(lines[4]).toContain("200");
  expect(lines[2]).toContain("乙");
  for (const line of lines) expect(line).toContain("没有改动任何 Bot");
  const en = copyFor("en").bulkModel;
  for (const line of [
    en.errorModel,
    en.errorThinking,
    en.errorBot("Writer"),
    en.errorBotGone,
    en.errorTooMany(200),
    en.errorGeneric,
  ]) {
    expect(line).toContain("No bot was changed");
  }
});
