import { expect, test } from "bun:test";
import { BUILTIN_MODEL_ROLES, type PromptSummary, type Settings } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { emptySnapshot } from "../snapshot.ts";
import { noBuiltinModels } from "./builtin-models.ts";
import { askOnce, modelShort, promptsTabItems, routingNodeView } from "./routing-map.ts";

const settingsOf = (chosen: Partial<NonNullable<Settings["builtin_models"]>> = {}): Settings => ({
  ...emptySnapshot().settings,
  builtin_models: { ...noBuiltinModels(), ...chosen },
});

function prompt(id: string, over: Partial<PromptSummary> = {}, state: "default" | "edited" | "conflict" = "default", failures = 0): PromptSummary {
  return {
    id,
    group: id.startsWith("call.") ? "call" : "turn",
    title: { zh: id, en: id },
    summary: { zh: "", en: "" },
    locales: [
      { locale: "zh", state, last_actor: state === "default" ? null : "user", last_bot_id: null, updated_at: null, parse_failures: { since_edit: null, last_7_days: failures } },
    ],
    ...over,
  };
}

test("a call's node names its model, or what it follows, and gathers its prompts' marks", () => {
  const items = [
    prompt("call.read_user_line", { role: "reader" }, "edited", 2),
    prompt("call.read_bot_line", { role: "reader" }, "conflict"),
    prompt("call.scribe", { role: "scribe" }),
    prompt("turn.system"),
  ];
  const reader = routingNodeView("reader", settingsOf({ reader: { runner: "claude_code", model: "haiku", config_dir: null } }), items);
  expect(reader).toMatchObject({ model: "haiku · Claude Agent", follows: "default", choosable: true, edited: 2, conflict: true, failures: 2 });
  expect(reader.prompts.map((item) => item.id)).toEqual(["call.read_user_line", "call.read_bot_line"]);
  const scribe = routingNodeView("scribe", settingsOf({ scribe: { provider_id: "p1", model: "grok-4.7" } }), items);
  expect(scribe).toMatchObject({ model: "grok-4.7", edited: 0, conflict: false, failures: 0 });
  expect(routingNodeView("compaction", settingsOf(), items)).toMatchObject({ model: null, follows: "bot", prompts: [] });
});

test("an older daemon only lets reading and organizing be chosen", () => {
  const { builtin_models: _a, ...legacy } = { ...emptySnapshot().settings, reader_model: null, organizer_model: null };
  expect(routingNodeView("reader", legacy as Settings, []).choosable).toBe(true);
  expect(routingNodeView("organizer", legacy as Settings, []).choosable).toBe(true);
  expect(routingNodeView("scribe", legacy as Settings, []).choosable).toBe(false);
});

test("Prompts keeps what no call owns, so a daemon that names no call keeps them all there", () => {
  const owned = prompt("call.scribe", { role: "scribe" });
  const unowned = prompt("call.scribe");
  expect(promptsTabItems([owned, prompt("turn.system")]).map((item) => item.id)).toEqual(["turn.system"]);
  expect(promptsTabItems([unowned])).toEqual([unowned]);
});

test("a model in a few words, with the agent it runs on", () => {
  expect(modelShort({ provider_id: "p1", model: "grok-4.7" })).toBe("grok-4.7");
  expect(modelShort({ runner: "codex", model: "gpt-5.5", config_dir: null })).toBe("gpt-5.5 · Codex");
});

test("a question asked once answers every asker the same", async () => {
  let asked = 0;
  const ask = askOnce(async () => ++asked);
  expect(await Promise.all([ask(), ask(), ask()])).toEqual([1, 1, 1]);
  expect(asked).toBe(1);
});
