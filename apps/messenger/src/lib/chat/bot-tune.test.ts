import { expect, test } from "bun:test";
import type { AgentStatus } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aProvider } from "../test-fixtures.ts";
import { agentBotPatch, agentTuneModels, endpointPatch, endpointTuneLabels, pinnedEndpoint } from "./bot-tune.ts";

const t = copyFor("zh");
const providers = [
  aProvider({ id: "p1", name: "Alpha" }),
  aProvider({ id: "p2", name: "Beta", models: ["grok-4.6"], model_catalog: [{ name: "grok-4.6", price: 3, thinking_levels: ["high"], strengths: [] }] }),
];
const unpinned = { model: null, provider_id: null, thinking_level: null };

test("a pin's endpoint is its own, else the first that lists the model; automatic has none", () => {
  expect(pinnedEndpoint(unpinned, providers)).toBe("");
  expect(pinnedEndpoint({ model: "grok-4.6", provider_id: "p2" }, providers)).toBe("p2");
  // From before pins named their endpoint.
  expect(pinnedEndpoint({ model: "grok-4.6", provider_id: null }, providers)).toBe("p1");
  expect(pinnedEndpoint({ model: "gone", provider_id: null }, providers)).toBe("");
});

test("a pick on the app's own loop is one change, or none when nothing moves", () => {
  // Automatic, from automatic: nothing.
  expect(endpointPatch(unpinned, providers, { endpoint: "", model: "" })).toBeNull();
  expect(endpointPatch({ model: "grok-4.6", provider_id: "p1", thinking_level: "low" }, providers, { endpoint: "", model: "" })).toEqual({
    model: null,
    provider_id: null,
    thinking_level: null,
  });
  // An endpoint alone is no pick.
  expect(endpointPatch(unpinned, providers, { endpoint: "p1", model: "" })).toBeNull();
  // A model without a level keeps the Bot's when the model takes it, else the model's default.
  expect(endpointPatch({ model: "gemini-3.8-flash", provider_id: "p1", thinking_level: "low" }, providers, { endpoint: "p1", model: "grok-4.6" })).toEqual({
    model: "grok-4.6",
    provider_id: "p1",
    thinking_level: "low",
  });
  expect(endpointPatch({ model: "gemini-3.8-flash", provider_id: "p1", thinking_level: "low" }, providers, { endpoint: "p2", model: "grok-4.6" })).toEqual({
    model: "grok-4.6",
    provider_id: "p2",
    thinking_level: "high",
  });
  // The same pin and level: nothing; another level: the change names the pin with it.
  expect(endpointPatch({ model: "grok-4.6", provider_id: "p1", thinking_level: "low" }, providers, { endpoint: "p1", model: "grok-4.6", thinking: "low" })).toBeNull();
  expect(endpointPatch({ model: "grok-4.6", provider_id: "p1", thinking_level: "low" }, providers, { endpoint: "p1", model: "grok-4.6", thinking: "high" })).toEqual({
    model: "grok-4.6",
    provider_id: "p1",
    thinking_level: "high",
  });
});

test("the closed picker says automatic, or the pin with its level, its endpoint once there are two, and a pin no list has", () => {
  expect(endpointTuneLabels(t, unpinned, providers)).toMatchObject({ value: t.sidebar.botModelDefault, level: null, aside: null, endpoint: null });
  const pinned = endpointTuneLabels(t, { model: "grok-4.6", provider_id: "p2", thinking_level: "high" }, providers);
  expect(pinned).toMatchObject({ value: "grok-4.6", level: "高", aside: "Beta" });
  expect(pinned.title).toBe("Beta\ngrok-4.6\n高");
  expect(endpointTuneLabels(t, { model: "grok-4.6", provider_id: "p2", thinking_level: "high" }, [providers[1]!]).aside).toBeNull();
  expect(endpointTuneLabels(t, { model: "old-model", provider_id: "p1", thinking_level: null }, providers).title).toBe(`Alpha\nold-model · ${t.sidebar.botModelUnlisted}`);
});

const status = (over: Partial<AgentStatus>): AgentStatus => ({
  runner: "grok", custom_id: null, label: "Grok", path: "/bin/grok", source: "path", version: "1", logged_in: true, auth: null, login_command: null,
  models: [], default_model: null, proxy: null, proxy_source: null, checked_at: "t", error: null, ...over,
});

test("an agent's models carry the levels it takes, and none falls back to Claude's", () => {
  const grok = agentTuneModels(status({ models: [{ id: "grok-5", name: "Grok 5", efforts: [] }, { id: "grok-mini", name: "", efforts: ["low", "max", "high"] }] }), "grok", "grok-old", "默认模型");
  expect(grok.map((row) => [row.value, row.display_name, row.efforts])).toEqual([
    ["default", "默认模型", ["low", "medium", "high", "xhigh"]],
    ["grok-5", "Grok 5", ["low", "medium", "high", "xhigh"]],
    // Its own, those Grok takes: not 最大.
    ["grok-mini", "grok-mini", ["low", "high"]],
    // Set elsewhere, not listed: still a row.
    ["grok-old", "grok-old", ["low", "medium", "high", "xhigh"]],
  ]);
  const opencode = agentTuneModels(status({ runner: "opencode", default_model: "anthropic/sonnet" }), "opencode", "", "默认模型");
  expect(opencode.map((row) => [row.value, row.efforts])).toEqual([["default", []], ["anthropic/sonnet", []]]);
  expect(agentTuneModels(null, "codex", "", "默认模型").map((row) => row.value)).toEqual(["default"]);
});

test("an agent pick goes into the Bot's own fields", () => {
  expect(agentBotPatch({ config_dir: "/a", model: null, effort: "high" })).toEqual({ agent_config_dir: "/a", agent_model: null, agent_effort: "high" });
  expect(agentBotPatch({ model: "grok-5" })).toEqual({ agent_model: "grok-5" });
});
