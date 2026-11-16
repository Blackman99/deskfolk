/** A Bot's composer picker: what runs it first, the levels under each runner, and the one PATCH a pick comes to. */
import { expect, test } from "nsh/test";
import type { AgentStatus, AgentsStatusResponse, Bot, PatchBotRequest, Provider } from "@real-bot/protocol";
import { copyFor } from "../../m/copy";
import type { TuneFocus, TuneTree } from "../../m/chat/tune-picker";
import { botTuneLabels, botTuneTree, runnerMovePatch, RUNNER_LEVEL, type BotTuneSource } from "./bot-tune-tree";

const t = copyFor("zh");

const provider = (over: Partial<Provider>): Provider =>
  ({
    id: "p1",
    name: "Alpha",
    base_url: "https://api.example.com/v1",
    key_set: true,
    models: ["grok-4.6", "gemini-3.8-flash"],
    model_catalog: [
      { name: "grok-4.6", price: 3, thinking_levels: ["none", "low", "high"], strengths: [] },
      { name: "gemini-3.8-flash", price: 0.3, thinking_levels: ["none"], strengths: [] },
    ],
    ...over,
  }) as unknown as Provider;
const providers = [provider({}), provider({ id: "p2", name: "Beta", models: ["grok-4.6"], model_catalog: [{ name: "grok-4.6", price: 3, thinking_levels: ["high"], strengths: [] }] })];

const agent = (runner: AgentStatus["runner"], over: Partial<AgentStatus> = {}): AgentStatus =>
  ({
    runner,
    custom_id: null,
    label: runner,
    path: `/usr/local/bin/${runner}`,
    source: "path",
    version: "1.0.0",
    logged_in: true,
    auth: null,
    login_command: null,
    models: [],
    default_model: null,
    proxy: null,
    proxy_source: null,
    checked_at: "2026-11-16T00:00:00.000Z",
    error: null,
    ...over,
  }) as AgentStatus;
const agents: AgentsStatusResponse = {
  items: [
    agent("claude_code"),
    agent("codex", { models: [{ id: "gpt-5.6", name: "GPT-5.6", efforts: ["low", "high"] }, { id: "gpt-5.6-mini", name: "GPT-5.6 mini", efforts: [] }] }),
    agent("grok", { path: null }),
    agent("custom", { custom_id: "a1", label: "Mine" }),
    agent("custom", { custom_id: "a2", label: "Other" }),
  ],
  custom_agents: [
    { id: "a1", name: "Mine", command: "/bin/mine", args: [] },
    { id: "a2", name: "Other", command: "/bin/other", args: [] },
  ],
};

const aBot = (over: Partial<Bot> = {}): Bot =>
  ({
    id: "b1",
    name: "Writer",
    model: null,
    provider_id: null,
    thinking_level: null,
    runner: null,
    agent_model: null,
    agent_effort: null,
    agent_config_dir: null,
    agent_custom_id: null,
    ...over,
  }) as Bot;

function picker(bot: Bot): { tree: TuneTree; picks: PatchBotRequest[]; source: BotTuneSource } {
  const picks: PatchBotRequest[] = [];
  const source: BotTuneSource = { t, bot, providers, agents, claude: null, client: null, onpick: (change) => picks.push(change) };
  return { tree: botTuneTree(source), picks, source };
}

/** Walks the path, a level at a time, as pointing at each row would. */
function walk(tree: TuneTree, steps: [string, string][]): TuneFocus {
  return steps.reduce((focus, [level, value]) => tree.focusAt(level, value, focus), tree.start());
}

const keys = (tree: TuneTree, focus: TuneFocus) => tree.levels(focus).map((level) => level.key);

test("it opens on what runs the Bot: the app on your endpoints, Claude Agent, then your other agents", () => {
  const { tree } = picker(aBot());
  const start = tree.start();
  expect(keys(tree, start)).toEqual([RUNNER_LEVEL, "endpoint"]);
  expect(tree.checked(RUNNER_LEVEL, start)).toBe("");
  const rows = tree.rows(RUNNER_LEVEL, start);
  expect(rows.slice(0, 3).map((row) => [row.value, row.label])).toEqual([
    ["", "端点"],
    ["claude_code", "Claude Agent"],
    ["codex", "Codex"],
  ]);
  expect(rows[0]!.detail).toBe(t.composer.tuneRunnerAppHint);
  expect(rows[1]!.detail).toBe(t.composer.tuneRunnerAgent);
  // Not found on this computer: listed, not a pick, with the reason.
  const grok = rows.find((row) => row.value === "grok")!;
  expect(grok.disabled).toBe(true);
  expect(grok.detail).toBe(t.sidebar.botRunnerAgentMissingShort);
  expect(rows.some((row) => row.value === "custom:a2" && row.label === "Other")).toBe(true);
  // Every runner opens what is under it; each wears a mark, the app's a plain endpoint tile.
  expect(rows.every((row) => tree.opensMore(RUNNER_LEVEL, row.value, start))).toBe(true);
  expect(rows[0]!.mark).toEqual({ kind: "custom", name: "端点" });
  expect(rows[2]!.mark).toEqual({ kind: "agent", runner: "codex", name: "Codex" });
});

test("a Bot on an agent opens on that agent's levels, its own model checked", () => {
  const { tree } = picker(aBot({ runner: "codex", agent_model: "gpt-5.6", agent_effort: "high" }));
  const start = tree.start();
  expect(start[RUNNER_LEVEL]).toBe("codex");
  expect(keys(tree, start)).toEqual([RUNNER_LEVEL, "model", "effort"]);
  expect(tree.checked(RUNNER_LEVEL, start)).toBe("codex");
  expect(tree.checked("model", start)).toBe("gpt-5.6");
  expect(tree.checked("effort", start)).toBe("high");
});

test("another runner starts over at its own levels: no model of the one before carries", () => {
  const { tree } = picker(aBot({ runner: "codex", agent_model: "gpt-5.6", agent_effort: "high" }));
  const onApp = tree.focusAt(RUNNER_LEVEL, "", tree.start());
  expect(onApp).toEqual({ [RUNNER_LEVEL]: "", endpoint: "", model: "", thinking: "" });
  expect(keys(tree, onApp)).toEqual([RUNNER_LEVEL, "endpoint"]);
  const onClaude = tree.focusAt(RUNNER_LEVEL, "claude_code", tree.start());
  expect(onClaude.model).toBe("");
  expect(onClaude.effort).toBe("");
  // Back on its own runner: its own path again.
  expect(tree.focusAt(RUNNER_LEVEL, "codex", onApp).model).toBe("gpt-5.6");
  // A level under a runner keeps the runner on the path.
  expect(walk(tree, [[RUNNER_LEVEL, ""], ["endpoint", "p1"]])[RUNNER_LEVEL]).toBe("");
});

test("a pick under the runner the Bot is on changes what it changed before, the runner left alone", () => {
  const { tree, picks } = picker(aBot({ model: "grok-4.6", provider_id: "p1", thinking_level: "low" }));
  tree.commit("thinking", walk(tree, [["endpoint", "p1"], ["model", "grok-4.6"], ["thinking", "high"]]));
  expect(picks).toEqual([{ model: "grok-4.6", provider_id: "p1", thinking_level: "high" }]);
  // Codex's own picker, the agent's names put back into the Bot's.
  const codex = picker(aBot({ runner: "codex", agent_model: "gpt-5.6", agent_effort: "high" }));
  codex.tree.commit("effort", walk(codex.tree, [["model", "gpt-5.6-mini"], ["effort", "low"]]));
  expect(codex.picks).toEqual([{ agent_model: "gpt-5.6-mini", agent_effort: "low" }]);
});

test("from the app's own loop onto an agent: one PATCH names the runner and all the agent runs on", () => {
  const { tree, picks } = picker(aBot({ model: "grok-4.6", provider_id: "p1", thinking_level: "low" }));
  tree.commit("effort", walk(tree, [[RUNNER_LEVEL, "codex"], ["model", "gpt-5.6"], ["effort", "high"]]));
  // A model with no levels is a pick of its own; the agent's default (no model) too, its stale model cleared.
  tree.commit("model", walk(tree, [[RUNNER_LEVEL, "codex"], ["model", "gpt-5.6-mini"]]));
  tree.commit("model", walk(tree, [[RUNNER_LEVEL, "custom:a1"], ["model", ""]]));
  expect(picks).toEqual([
    { runner: "codex", agent_model: "gpt-5.6", agent_effort: "high", agent_config_dir: null },
    { runner: "codex", agent_model: "gpt-5.6-mini", agent_effort: null, agent_config_dir: null },
    { runner: "custom", agent_custom_id: "a1", agent_model: null, agent_effort: null, agent_config_dir: null },
  ]);
});

test("from an agent onto the app's own loop: the endpoint pin, and the agent's model, level and account cleared", () => {
  const { tree, picks } = picker(aBot({ runner: "codex", agent_model: "gpt-5.6", agent_effort: "high" }));
  tree.commit("thinking", walk(tree, [[RUNNER_LEVEL, ""], ["endpoint", "p1"], ["model", "grok-4.6"], ["thinking", "low"]]));
  // Automatic is a pick even when the Bot has no pin to clear: the move is the change.
  tree.commit("endpoint", walk(tree, [[RUNNER_LEVEL, ""], ["endpoint", ""]]));
  expect(picks).toEqual([
    { runner: null, agent_model: null, agent_effort: null, agent_config_dir: null, model: "grok-4.6", provider_id: "p1", thinking_level: "low" },
    { runner: null, agent_model: null, agent_effort: null, agent_config_dir: null, model: null, provider_id: null, thinking_level: null },
  ]);
});

test("back onto the app's own loop on the model it kept: that model, at its own level", () => {
  const bot = aBot({ runner: "claude_code", model: "grok-4.6", provider_id: "p2", thinking_level: "high", agent_model: "opus" });
  const { tree, picks } = picker(bot);
  // The pin it kept is where the endpoints open, checked.
  const onApp = tree.focusAt(RUNNER_LEVEL, "", tree.start());
  expect(onApp.endpoint).toBe("p2");
  expect(tree.checked("endpoint", onApp)).toBe("p2");
  tree.commit("model", walk(tree, [[RUNNER_LEVEL, ""], ["endpoint", "p2"], ["model", "grok-4.6"]]));
  expect(picks).toEqual([{ runner: null, agent_model: null, agent_effort: null, agent_config_dir: null, model: "grok-4.6", provider_id: "p2", thinking_level: "high" }]);
});

test("from one of your ACP agents to another: the other one named, the first one's model gone", () => {
  const { tree, picks } = picker(aBot({ runner: "custom", agent_custom_id: "a1", agent_model: "mine-large" }));
  expect(tree.checked(RUNNER_LEVEL, tree.start())).toBe("custom:a1");
  tree.commit("model", walk(tree, [[RUNNER_LEVEL, "custom:a2"], ["model", ""]]));
  expect(picks).toEqual([{ runner: "custom", agent_custom_id: "a2", agent_model: null, agent_effort: null, agent_config_dir: null }]);
});

test("a daemon that keeps no accounts for a Bot is sent none", () => {
  const bot = { model: null, provider_id: null, thinking_level: null } as Pick<Bot, "model" | "provider_id" | "thinking_level" | "agent_config_dir">;
  expect(runnerMovePatch(bot, providers, "codex", "model", { [RUNNER_LEVEL]: "codex", model: "gpt-5.6-mini", effort: "" })).toEqual({
    runner: "codex",
    agent_model: "gpt-5.6-mini",
    agent_effort: null,
  });
  // Claude's account goes with a move onto Claude Agent.
  expect(runnerMovePatch(aBot(), providers, "claude_code", "effort", { [RUNNER_LEVEL]: "claude_code", account: "/Users/me/.claude-b", model: "opus", effort: "high" })).toEqual({
    runner: "claude_code",
    agent_model: "opus",
    agent_effort: "high",
    agent_config_dir: "/Users/me/.claude-b",
  });
});

test("the room it keeps is the widest path any runner opens, not just the one the Bot is on", () => {
  const { tree } = picker(aBot({ runner: "codex", agent_model: "gpt-5.6-mini" }));
  expect(tree.room(tree.start()).map((level) => level.key)).toEqual([RUNNER_LEVEL, "endpoint", "model", "thinking"]);
});

test("the closed picker reads what runs the Bot by its mark, then its model", () => {
  expect(botTuneLabels(picker(aBot({ model: "grok-4.6", provider_id: "p2", thinking_level: "high" })).source)).toMatchObject({ value: "grok-4.6", aside: "Beta" });
  const codex = botTuneLabels(picker(aBot({ runner: "codex", agent_model: "gpt-5.6", agent_effort: "high" })).source);
  expect(codex.mark).toEqual({ kind: "agent", runner: "codex", name: "Codex" });
  expect(codex.value).toBe("GPT-5.6");
});
