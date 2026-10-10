import { expect, test } from "bun:test";
import { AGENT_KINDS, type AgentsStatusResponse, type BotRunner } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { findPicked, sourceRows } from "../model-picker.ts";
import { aProvider } from "../test-fixtures.ts";
import {
  agentModelPicker,
  claudeModelPicker,
  endpointModelPicker,
  formatSkillUses,
  mapCreateBotError,
  mapCreateGroupError,
  mapSkillError,
  parseSkillUses,
  pickerValues,
  pinnableThinkingLevels,
  applyModelPin,
  defaultThinkingLevel,
  planCreateBot,
  planCreateGroup,
  planSkill,
} from "./create-form.ts";
import { parseRunnerValue, runnerValueOf } from "../runner-choice.ts";

test("a pinned thinking level rides along; blank is null; an unknown level does not produce a request", () => {
  const base = { name: "Researcher", duties: "read", boundaries: "stay", model: "" };
  expect(planCreateBot({ ...base, thinkingLevel: "high" })).toMatchObject({
    ok: true,
    body: { thinking_level: "high" },
  });
  expect(planCreateBot({ ...base, thinkingLevel: "" })).toMatchObject({
    ok: true,
    body: { thinking_level: null },
  });
  const omitted = planCreateBot(base);
  expect(omitted.ok).toBe(true);
  if (omitted.ok) expect("thinking_level" in omitted.body).toBe(false);
  expect(planCreateBot({ ...base, thinkingLevel: "xhigh" })).toMatchObject({
    ok: true,
    body: { thinking_level: "xhigh" },
  });
  expect(planCreateBot({ ...base, thinkingLevel: "high!" })).toEqual({
    ok: false,
    errors: { thinkingLevel: "invalid" },
  });
  expect(mapCreateBotError(422, "thinking_level must be one the pinned model supports")).toEqual({
    thinkingLevel: "invalid",
  });
});

test("pinnable thinking levels follow the picked model's catalog, or every level when nothing is pinned", () => {
  const providers = [
    {
      id: "p1",
      model_catalog: [
        { name: "cheap-chat", thinking_levels: ["none", "low"] as const },
        { name: "code-pro", thinking_levels: ["high", "medium"] as const },
        { name: "grok-4.6", thinking_levels: ["low", "high", "xhigh"] as const },
      ],
    },
    { id: "p2", model_catalog: [{ name: "code-pro", thinking_levels: ["low"] as const }] },
  ];
  expect(pinnableThinkingLevels("", providers)).toEqual(["none", "low", "medium", "high", "xhigh"]);
  expect(pinnableThinkingLevels("p1::cheap-chat", providers)).toEqual(["none", "low"]);
  expect(pinnableThinkingLevels("p1::code-pro", providers)).toEqual(["medium", "high"]);
  expect(pinnableThinkingLevels("p1::grok-4.6", providers)).toEqual(["low", "high", "xhigh"]);
  expect(pinnableThinkingLevels("code-pro", providers)).toEqual(["low", "medium", "high"]);
  expect(pinnableThinkingLevels("p1::unknown", providers)).toEqual(["none", "low", "medium", "high"]);
});

test("a pinned model lands on the level the app would have picked for it", () => {
  expect(defaultThinkingLevel(["none", "low", "medium", "high"])).toBe("low");
  expect(defaultThinkingLevel(["medium", "high"])).toBe("medium");
  expect(defaultThinkingLevel(["none", "high"])).toBe("none");
  // Only names the endpoint advertised: fall back to the lightest it offers.
  expect(defaultThinkingLevel(["xhigh", "max"])).toBe("xhigh");
  expect(defaultThinkingLevel([])).toBe("");
});

test("model and thinking level are pinned together or not at all", () => {
  const providers = [
    {
      id: "p1",
      model_catalog: [
        { name: "cheap-chat", thinking_levels: ["none", "low"] as const },
        { name: "grok-4.6", thinking_levels: ["low", "high", "xhigh"] as const },
        { name: "gemini", thinking_levels: ["medium", "max"] as const },
      ],
    },
  ];

  // Automatic clears the level: the app picks both.
  expect(applyModelPin("", "high", providers)).toEqual({ model: "", thinkingLevel: "" });

  // Pinning a model never leaves the level blank.
  expect(applyModelPin("p1::grok-4.6", "", providers)).toEqual({
    model: "p1::grok-4.6",
    thinkingLevel: "low",
  });

  // A level the new model still offers survives the swap.
  expect(applyModelPin("p1::grok-4.6", "high", providers)).toEqual({
    model: "p1::grok-4.6",
    thinkingLevel: "high",
  });

  // One it does not offer falls to that model's default instead of going blank.
  expect(applyModelPin("p1::gemini", "xhigh", providers)).toEqual({
    model: "p1::gemini",
    thinkingLevel: "medium",
  });
  expect(applyModelPin("p1::cheap-chat", "max", providers)).toEqual({
    model: "p1::cheap-chat",
    thinkingLevel: "low",
  });
});

test("whitespace name, duties, and boundaries do not produce a POST", () => {
  expect(
    planCreateBot({ name: "  ", duties: "", boundaries: "\t", model: "" }),
  ).toEqual({
    ok: false,
    errors: { name: "empty", duties: "empty", boundaries: "empty" },
  });
});

test("trimmed bot fields produce the POST body; blank model is null", () => {
  expect(
    planCreateBot({
      name: " Researcher ",
      duties: " read sources ",
      boundaries: " stay in the workspace ",
      avatar: " data:image/jpeg;base64,abc ",
      model: "",
    }),
  ).toEqual({
    ok: true,
    body: {
      name: "Researcher",
      duties: "read sources",
      boundaries: "stay in the workspace",
      avatar: "data:image/jpeg;base64,abc",
      model: null,
      provider_id: null,
    },
  });
});

test("a listed model is sent; an unknown model does not produce a POST", () => {
  expect(
    planCreateBot(
      {
        name: "Researcher",
        duties: "read",
        boundaries: "stay",
        model: "deepseek-v4-pro",
      },
      ["grok-4.5", "deepseek-v4-pro"],
    ),
  ).toEqual({
    ok: true,
    body: {
      name: "Researcher",
      duties: "read",
      boundaries: "stay",
      model: "deepseek-v4-pro",
      provider_id: null,
    },
  });
  expect(
    planCreateBot(
      {
        name: "Researcher",
        duties: "read",
        boundaries: "stay",
        model: "nope",
      },
      ["grok-4.5"],
    ),
  ).toEqual({
    ok: false,
    errors: { model: "invalid" },
  });
});

test("an encoded provider model is sent with provider_id", () => {
  expect(
    planCreateBot(
      {
        name: "Researcher",
        duties: "read",
        boundaries: "stay",
        model: "p1::gpt-4o",
      },
      ["p1::gpt-4o", "p2::deepseek-chat"],
    ),
  ).toEqual({
    ok: true,
    body: {
      name: "Researcher",
      duties: "read",
      boundaries: "stay",
      model: "gpt-4o",
      provider_id: "p1",
    },
  });
});

test("empty group name and fewer than two members do not produce a POST", () => {
  expect(planCreateGroup({ name: "   ", members: ["a"] })).toEqual({
    ok: false,
    errors: { name: "empty", members: "too_few" },
  });
});

test("duplicate member ids still count as one bot", () => {
  expect(planCreateGroup({ name: "Brief", members: ["a", "a"] })).toEqual({
    ok: false,
    errors: { members: "too_few" },
  });
});

test("trimmed group name and two distinct members produce the POST body", () => {
  expect(planCreateGroup({ name: " Brief ", members: ["b", "a", "b"] })).toEqual({
    ok: true,
    body: { name: "Brief", members: ["b", "a"] },
  });
});

test("maps daemon name-conflict onto the name field", () => {
  expect(mapCreateBotError(409, "that name is already used")).toEqual({ name: "conflict" });
  expect(mapCreateBotError(422, "name is required")).toEqual({ name: "empty" });
  expect(mapCreateBotError(422, "duties must be a string")).toEqual({ top: true });
  expect(mapCreateBotError(422, "model must be one of endpoint_models")).toEqual({
    model: "invalid",
  });
});

test("maps daemon group member and name failures onto the locked kinds", () => {
  expect(mapCreateGroupError(422, "name is required")).toEqual({ name: "empty" });
  expect(mapCreateGroupError(422, "a group needs at least two bots")).toEqual({
    members: "too_few",
  });
  expect(mapCreateGroupError(422, "members must include at least two bots")).toEqual({
    members: "too_few",
  });
  expect(mapCreateGroupError(404, "bot not found")).toEqual({ top: true });
});

test("whitespace skill fields do not produce a POST", () => {
  expect(planSkill({ name: "  ", description: "", body: "\t", uses: "", enabled: true })).toEqual({
    ok: false,
    errors: { name: "empty", description: "empty", body: "empty" },
  });
});

test("trimmed skill fields produce the POST body", () => {
  expect(
    planSkill({
      name: " Commits ",
      description: " when committing ",
      body: " use conventional commits ",
      uses: " GitHub, github ，slack\n time ",
      enabled: false,
    }),
  ).toEqual({
    ok: true,
    body: {
      name: "Commits",
      description: "when committing",
      body: "use conventional commits",
      uses: ["GitHub", "slack", "time"],
      enabled: false,
    },
  });
});

test("skill uses round-trip between the typed list and the array", () => {
  expect(parseSkillUses("")).toEqual([]);
  expect(parseSkillUses(" , ；\n")).toEqual([]);
  expect(formatSkillUses(["github", "slack"])).toBe("github, slack");
  expect(parseSkillUses(formatSkillUses(["github", "slack"]))).toEqual(["github", "slack"]);
});

test("maps daemon skill name-conflict onto the name field", () => {
  expect(mapSkillError(409, "that skill name is already used")).toEqual({ name: "conflict" });
  expect(mapSkillError(422, "name is required")).toEqual({ name: "empty" });
  expect(mapSkillError(422, "description is required")).toEqual({ description: "empty" });
  expect(mapSkillError(422, "body is required")).toEqual({ body: "empty" });
  expect(mapSkillError(422, "a bot can have at most 32 skills")).toEqual({ top: true });
});

const agentBase = { name: "Researcher", duties: "read", boundaries: "stay", model: "" };

test("a Bot on a local agent (ADR 0079) is sent with its runner, a model as that agent names it, and an effort that agent takes", () => {
  expect(planCreateBot({ ...agentBase, runner: "codex", agentModel: "openai/gpt-5.5", agentEffort: "xhigh" })).toMatchObject({
    ok: true,
    body: { runner: "codex", agent_model: "openai/gpt-5.5", agent_effort: "xhigh" },
  });
  const codex = planCreateBot({ ...agentBase, runner: "codex", agentModel: "", agentEffort: "" });
  expect(codex).toMatchObject({ ok: true, body: { runner: "codex", agent_model: null, agent_effort: null } });
  // The field only goes to a daemon that knows custom agents, and only for a custom one.
  if (codex.ok) expect("agent_custom_id" in codex.body).toBe(false);
  // DSH has Off, Grok stops at extra high, OpenCode has no effort at all.
  expect(planCreateBot({ ...agentBase, runner: "dsh", agentEffort: "off" })).toMatchObject({ ok: true, body: { agent_effort: "off" } });
  expect(planCreateBot({ ...agentBase, runner: "grok", agentEffort: "max" })).toEqual({ ok: false, errors: { agentEffort: "invalid" } });
  expect(planCreateBot({ ...agentBase, runner: "opencode", agentEffort: "low" })).toEqual({ ok: false, errors: { agentEffort: "invalid" } });
  expect(planCreateBot({ ...agentBase, runner: "opencode", agentEffort: "" })).toMatchObject({ ok: true, body: { runner: "opencode", agent_effort: null } });
  // Another agent's model is any name without spaces; Claude keeps its stricter one.
  expect(planCreateBot({ ...agentBase, runner: "grok", agentModel: "nvidia/z-ai/glm-5.3" })).toMatchObject({ ok: true });
  expect(planCreateBot({ ...agentBase, runner: "grok", agentModel: "two words" })).toEqual({ ok: false, errors: { agentModel: "invalid" } });
  expect(planCreateBot({ ...agentBase, runner: "claude_code", agentModel: "openai/gpt-5.5" })).toEqual({ ok: false, errors: { agentModel: "invalid" } });
  expect(planCreateBot({ ...agentBase, runner: "claude_code", agentModel: "opus", agentEffort: "max" })).toMatchObject({ ok: true, body: { runner: "claude_code", agent_model: "opus", agent_effort: "max" } });
  // The app's own loop reads the agent fields as Claude's, as it always did.
  expect(planCreateBot({ ...agentBase, runner: "", agentEffort: "off" })).toEqual({ ok: false, errors: { agentEffort: "invalid" } });
  expect(planCreateBot({ ...agentBase, runner: "" })).toMatchObject({ ok: true, body: { runner: null } });
});

test("one of your own ACP agents is `custom:<id>`: sent as runner custom with agent_custom_id, and refused without an id", () => {
  expect(planCreateBot({ ...agentBase, runner: "custom:acp-1" })).toMatchObject({ ok: true, body: { runner: "custom", agent_custom_id: "acp-1" } });
  expect(planCreateBot({ ...agentBase, runner: "custom" })).toEqual({ ok: false, errors: { agentCustomId: "invalid" } });
  expect(mapCreateBotError(422, "agent_custom_id must name one of your custom agents")).toEqual({ agentCustomId: "invalid" });
  // An agent that takes no effort level says so by its own name first.
  expect(mapCreateBotError(422, "OpenCode takes no effort level: agent_effort must be null")).toEqual({ agentEffort: "invalid" });
  expect(mapCreateBotError(422, "agent_effort must be one of low, medium or null")).toEqual({ agentEffort: "invalid" });
});

test("the runner as a picker holds it round-trips: '' the app, a runner's name, custom:<id> for your own agent", () => {
  expect(parseRunnerValue("")).toEqual({ runner: null, customId: null });
  expect(parseRunnerValue("codex")).toEqual({ runner: "codex", customId: null });
  expect(parseRunnerValue("custom:acp-1")).toEqual({ runner: "custom", customId: "acp-1" });
  expect(parseRunnerValue("custom")).toEqual({ runner: "custom", customId: null });
  expect(parseRunnerValue("some-future-agent")).toEqual({ runner: null, customId: null });
  expect(runnerValueOf("custom", "acp-1")).toBe("custom:acp-1");
  expect(runnerValueOf("custom", null)).toBe("custom");
  expect(runnerValueOf("grok", "ignored")).toBe("grok");
  expect(runnerValueOf(null)).toBe("");
});

const t = copyFor("zh");

test("the endpoint picker is one source per endpoint of provider::model values, with automatic above them; a save is checked against every value it offers", () => {
  const providers = [aProvider({ id: "p-1", name: "First", models: ["grok-4.6"] }), aProvider({ id: "p-2", name: "Second", models: ["qwen-4"] }), aProvider({ id: "p-3", name: "Empty", models: [] })];
  const data = endpointModelPicker(providers, t);
  expect(data.specials).toEqual([{ value: "", label: t.sidebar.botModelDefault }]);
  expect(data.sources.map((source) => [source.label, sourceRows(source).map((row) => row.value)])).toEqual([
    ["First", ["p-1::grok-4.6"]],
    ["Second", ["p-2::qwen-4"]],
  ]);
  expect(findPicked(data, "p-2::qwen-4")?.source?.label).toBe("Second");
  expect(pickerValues(data)).toEqual(["", "p-1::grok-4.6", "p-2::qwen-4"]);
  const draft = { name: "R", duties: "d", boundaries: "b", model: "p-2::qwen-4" };
  expect(planCreateBot(draft, pickerValues(data))).toMatchObject({ ok: true, body: { model: "qwen-4", provider_id: "p-2" } });
  expect(planCreateBot({ ...draft, model: "p-2::gone" }, pickerValues(data))).toEqual({ ok: false, errors: { model: "invalid" } });
});

test("the Claude picker is Claude Code's default above its aliases; a name that is none stays a row of its own", () => {
  const plain = claudeModelPicker(t, "opus");
  expect(plain.specials).toEqual([{ value: "", label: t.sidebar.botAgentModelDefault }]);
  expect(plain.sources.map((source) => sourceRows(source).map((row) => row.value))).toEqual([["sonnet", "opus", "haiku", "fable"]]);
  expect(claudeModelPicker(t, "").specials).toHaveLength(1);
  const held = claudeModelPicker(t, "claude-opus-4-6");
  expect(held.specials.map((row) => row.value)).toEqual(["", "claude-opus-4-6"]);
  expect(findPicked(held, "claude-opus-4-6")?.source).toBeNull();
});

const agents = (over: Record<string, unknown> = {}): AgentsStatusResponse => ({
  items: (["codex", "dsh", "custom"] as BotRunner[]).map((runner) => ({
    runner, custom_id: runner === "custom" ? "acp-1" : null, label: runner === "custom" ? "我的 ACP" : AGENT_KINDS[runner].label,
    path: `/usr/local/bin/${runner}`, source: "path", version: "1", logged_in: true, auth: null, login_command: null,
    models: runner === "codex" ? [{ id: "gpt-5.5", name: "GPT-5.5", efforts: [] }] : [], default_model: runner === "codex" ? "gpt-5.5" : null,
    proxy: null, proxy_source: null, checked_at: "2026-10-10T00:00:00.000Z", error: null, ...(runner === "codex" ? over : {}),
  })),
  custom_agents: [{ id: "acp-1", name: "我的 ACP", command: "my-acp", args: [] }],
}) as unknown as AgentsStatusResponse;

test("an agent's picker is its own listed models by plain name, its default above them, and a model it does not list stays a row", () => {
  const data = agentModelPicker(agents(), t, "codex", null, "o9-private");
  expect(data.specials).toEqual([
    { value: "", label: t.sidebar.botAgentModelDefaultOf("Codex"), detail: "gpt-5.5" },
    { value: "o9-private", label: "o9-private" },
  ]);
  expect(data.sources.map((source) => [source.label, sourceRows(source).map((row) => row.value)])).toEqual([["Codex", ["gpt-5.5"]]]);
  // A listed model, or none, adds no row of its own.
  expect(agentModelPicker(agents(), t, "codex", null, "gpt-5.5").specials).toHaveLength(1);
  expect(agentModelPicker(agents(), t, "codex", null, "").specials).toHaveLength(1);
  // It takes a name typed as it spells it, and refuses one with a space.
  const source = data.sources[0]!;
  expect(source.custom?.("openai/gpt-6")).toBe("openai/gpt-6");
  expect(source.custom?.("gpt 6")).toBeNull();
});

test("an agent that lists nothing, is not found, or cannot be asked still takes a typed name; your own ACP agent is its own source", () => {
  const dsh = agentModelPicker(agents(), t, "dsh", null, "");
  expect(dsh.sources).toHaveLength(1);
  expect(dsh.sources[0]).toMatchObject({ key: "agent:dsh", label: "DSH", note: t.modelPicker.typeShort });
  expect(dsh.specials).toEqual([{ value: "", label: t.sidebar.botAgentModelDefaultOf("DSH") }]);
  for (const found of [agents({ path: null }), agents({ logged_in: false }), null]) {
    const data = agentModelPicker(found, t, "codex", null, "");
    expect(data.sources).toHaveLength(1);
    expect(sourceRows(data.sources[0]!)).toEqual([]);
    expect(data.sources[0]!.custom?.("gpt-5.5")).toBe("gpt-5.5");
    expect(data.sources[0]!.disabled).toBeUndefined();
  }
  const acp = agentModelPicker(agents(), t, "custom", "acp-1", "");
  expect(acp.sources.map((source) => source.key)).toEqual(["agent:custom:acp-1"]);
  expect(acp.specials[0]!.label).toBe(t.sidebar.botAgentModelDefaultOf("我的 ACP"));
  // One removed from Settings: still a source to type into, under its kind's name.
  expect(agentModelPicker(agents(), t, "custom", "acp-gone", "").sources[0]).toMatchObject({ key: "agent:custom:acp-gone", label: AGENT_KINDS.custom.label });
});
