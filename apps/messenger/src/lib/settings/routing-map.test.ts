import { expect, test } from "bun:test";
import { BUILTIN_MODEL_ROLES, type PromptSummary, type Settings } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { emptySnapshot } from "../snapshot.ts";
import { noBuiltinModels } from "./builtin-models.ts";
import { askOnce, modelShort, promptsTabItems, ROUTING_LANES, routingCounts, routingNodes, routingNodeView } from "./routing-map.ts";

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

test("the map draws every built-in call once, and the Bot's own turn", () => {
  const nodes = routingNodes();
  expect(nodes.filter((node) => node !== "turn").sort()).toEqual([...BUILTIN_MODEL_ROLES].sort());
  expect(nodes.filter((node) => node === "turn")).toHaveLength(1);
  // A line of yours is read before it wakes a Bot; the scribe runs beside the reading.
  const line = ROUTING_LANES.find((lane) => lane.key === "line")!;
  expect(line.steps.map((step) => step.node)).toEqual(["reader", "turn", "judge"]);
  expect(line.steps[0]!.branches.map((branch) => branch.node)).toEqual(["scribe"]);
});

test("every lane and arrow has words in both languages", () => {
  for (const copy of [copyFor("zh"), copyFor("en")]) {
    for (const lane of ROUTING_LANES) {
      expect(copy.routing.lanes[lane.key].length).toBeGreaterThan(0);
      for (const step of lane.steps) {
        if (step.edge) expect(copy.routing.edges[step.edge].length).toBeGreaterThan(0);
        for (const branch of step.branches) expect(copy.routing.edges[branch.edge].length).toBeGreaterThan(0);
      }
    }
  }
});

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

test("the page's count is the calls you changed, a model or a prompt, each once; a conflict marks it", () => {
  const items = [
    prompt("call.organizer", { role: "organizer" }, "edited"),
    prompt("call.read_user_line", { role: "reader" }, "edited"),
    prompt("call.read_bot_line", { role: "reader" }, "edited"),
    prompt("turn.system", {}, "conflict"),
  ];
  expect(routingCounts(settingsOf(), [])).toEqual({ changed: 0, conflict: false });
  expect(routingCounts(settingsOf({ organizer: { provider_id: "p1", model: "m" }, composer: { provider_id: "p1", model: "m" } }), items)).toEqual({ changed: 3, conflict: false });
  expect(routingCounts(settingsOf(), [prompt("call.scribe", { role: "scribe" }, "conflict")])).toEqual({ changed: 1, conflict: true });
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
