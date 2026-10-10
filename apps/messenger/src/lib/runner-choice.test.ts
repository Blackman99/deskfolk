import { expect, test } from "bun:test";
import { AGENT_KINDS, type AgentsStatusResponse, type BotRunner, type Provider } from "@real-bot/protocol";
import { copyFor } from "./copy.ts";
import { agentAccountOptions, agentBlocker, agentEffortsOf, agentLabelOf, agentModelsOf, agentReady, agentStatusOf, runnerOptions, setupRunnerOf } from "./runner-choice.ts";

const t = copyFor("zh");

function status(runner: BotRunner, over: Record<string, unknown> = {}) {
  return {
    runner, custom_id: null, label: AGENT_KINDS[runner].label, path: `/usr/local/bin/${runner}`, source: "path", version: "1", logged_in: true, auth: null,
    login_command: null, models: [], default_model: null, proxy: null, proxy_source: null, checked_at: "2026-10-10T00:00:00.000Z", error: null, ...over,
  };
}
const found = (items: ReturnType<typeof status>[], custom_agents: AgentsStatusResponse["custom_agents"] = []) => ({ items, custom_agents }) as unknown as AgentsStatusResponse;

test("what stands in the way of an agent, and which are ready: not found first, then signed out; unknown is no blocker", () => {
  expect(agentBlocker(null)).toBeNull();
  expect(agentBlocker(status("codex") as never)).toBeNull();
  expect(agentBlocker(status("codex", { path: null, logged_in: false }) as never)).toBe("missing");
  expect(agentBlocker(status("codex", { logged_in: false }) as never)).toBe("signed_out");
  // `null`: it cannot tell without a turn, which is not signed out.
  expect(agentReady(status("grok", { logged_in: null }) as never)).toBe(true);
  expect(agentReady(status("grok", { logged_in: false }) as never)).toBe(false);
});

test("an agent's status, its name and its efforts come from the daemon's list and the protocol's table; your own ACP agent by id", () => {
  const agents = found([status("codex"), status("custom", { custom_id: "a", label: "甲" }), status("custom", { custom_id: "b", label: "乙" })], [
    { id: "a", name: "甲", command: "a", args: [] },
    { id: "b", name: "乙", command: "b", args: [] },
  ]);
  expect(agentStatusOf(agents, "codex")?.label).toBe("Codex");
  expect(agentStatusOf(agents, "custom", "b")?.label).toBe("乙");
  expect(agentStatusOf(agents, "grok")).toBeNull();
  expect(agentStatusOf(null, "codex")).toBeNull();
  expect(agentLabelOf("codex", null, null)).toBe("Codex");
  expect(agentLabelOf("custom", "a", agents)).toBe("甲");
  expect(agentLabelOf("custom", "gone", agents)).toBe(AGENT_KINDS.custom.label);
  expect(agentEffortsOf("grok")).toEqual(["low", "medium", "high", "xhigh"]);
  expect(agentEffortsOf("opencode")).toEqual([]);
  // The app's own loop reads the agent fields as Claude's.
  expect(agentEffortsOf(null)).toEqual(AGENT_KINDS.claude_code.efforts);
});

test("the models to offer are what the agent listed, else the default it named, else none", () => {
  expect(agentModelsOf(status("codex", { models: [{ id: "a", name: "A", efforts: [] }], default_model: "b" }) as never).map((model) => model.id)).toEqual(["a"]);
  expect(agentModelsOf(status("codex", { default_model: "b" }) as never).map((model) => model.id)).toEqual(["b"]);
  expect(agentModelsOf(status("codex") as never)).toEqual([]);
  expect(agentModelsOf(null)).toEqual([]);
});

test("the account picker names this computer's own first, then each listed directory, and keeps one that is no longer listed", () => {
  const accounts = [
    { config_dir: null, logged_in: true, auth: "ChatGPT Plus", error: null, login_command: "codex login" },
    { config_dir: "/opt/b", logged_in: true, auth: null, error: null, login_command: "x" },
  ];
  const codex = status("codex", { accounts }) as never;
  expect(agentAccountOptions(codex, "", t)).toEqual([
    { value: "", label: `${t.sidebar.botAgentAccountDefault} · ChatGPT Plus` },
    { value: "/opt/b", label: "/opt/b" },
  ]);
  expect(agentAccountOptions(codex, "/opt/gone", t).at(-1)).toEqual({ value: "/opt/gone", label: "/opt/gone" });
  // An agent with no config directories has no accounts, whatever its status holds.
  expect(agentAccountOptions(status("grok", { accounts }) as never, "", t)).toEqual([{ value: "", label: t.sidebar.botAgentAccountDefault }]);
});

test("a new Bot starts on the app while an endpoint can run it, else on the agent the app was set up on, else Claude Agent", () => {
  const withKey = [{ base_url: "https://api.example.com/v1", key_set: true }] as Pick<Provider, "base_url" | "key_set">[];
  const keyless = [{ base_url: "https://api.example.com/v1", key_set: false }] as Pick<Provider, "base_url" | "key_set">[];
  const codex = { runner: "codex", model: "gpt-5.5", config_dir: null } as const;
  expect(setupRunnerOf(withKey, codex)).toBe("");
  expect(setupRunnerOf([], codex)).toBe("codex");
  expect(setupRunnerOf(keyless, { runner: "custom", model: "m", config_dir: null, custom_id: "acp-1" })).toBe("custom:acp-1");
  expect(setupRunnerOf([], null)).toBe("claude_code");
  expect(setupRunnerOf([], { provider_id: "p1", model: "m" })).toBe("claude_code");
});

test("the runner picker offers agents only once the daemon has listed them, never disables the one a Bot is on, and keeps a runner that is not listed", () => {
  const agents = found([status("codex", { path: null }), status("grok")]);
  expect(runnerOptions(t, null, "").map((option) => option.value)).toEqual(["", "claude_code"]);
  const listed = runnerOptions(t, agents, "codex");
  expect(listed.find((option) => option.value === "codex")).toMatchObject({ disabled: false, hint: t.sidebar.botRunnerAgentMissingShort });
  expect(runnerOptions(t, agents, "").find((option) => option.value === "codex")).toMatchObject({ disabled: true });
  expect(listed.map((option) => option.value)).toEqual(["", "claude_code", "codex", "grok", "opencode", "antigravity", "zcode"]);
  // Where the daemon has not listed it (the phone): still a choice, under its name.
  expect(runnerOptions(t, null, "zcode").at(-1)).toMatchObject({ value: "zcode", label: "ZCode" });
});

test("every agent row wears its logo, Claude Agent the spark, your own ACP agent the plain glyph, and the app's own loop none", () => {
  const agents = found([status("codex"), status("grok")], [{ id: "ca-1", name: "my-agent", command: "/bin/x", args: [] }]);
  const options = runnerOptions(t, agents, "");
  expect(options.find((option) => option.value === "")?.source).toBeUndefined();
  expect(options.find((option) => option.value === "claude_code")?.source).toEqual({ kind: "claude-agent", name: t.claudeAgent.title });
  expect(options.find((option) => option.value === "codex")?.source).toEqual({ kind: "agent", runner: "codex", name: "Codex" });
  expect(options.find((option) => option.value === "custom:ca-1")?.source).toEqual({ kind: "agent", runner: "custom", name: "my-agent" });
  // Every row but the app's own carries one, however the agents were listed.
  expect(options.filter((option) => option.value !== "").every((option) => option.source !== undefined)).toBe(true);
  // A runner kept only because a Bot is on it (not listed, or since removed) still wears its logo.
  expect(runnerOptions(t, null, "zcode").at(-1)?.source).toEqual({ kind: "agent", runner: "zcode", name: "ZCode" });
  expect(runnerOptions(t, agents, "custom:gone").at(-1)).toMatchObject({ value: "custom:gone", source: { kind: "agent", runner: "custom" } });
});
