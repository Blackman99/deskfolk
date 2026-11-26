/** The consultant add picker: agent -> account (when several) -> model -> level (`consult-tune-tree.ts`). */
import { expect, test } from "nsh/test";
import type { AgentStatus, AgentsStatusResponse, ClaudeCodeStatus, ConsultMember } from "@real-bot/protocol";
import { copyFor } from "../../m/copy";
import type { TuneFocus, TuneTree } from "../../m/chat/tune-picker";
import { CONSULT_AGENT_LEVEL, consultAccountChoices, consultAccountLabel, consultTuneTree, type ConsultTuneSource } from "./consult-tune-tree";

const t = copyFor("zh");

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
    checked_at: "2026-11-24T00:00:00.000Z",
    error: null,
    ...over,
  }) as AgentStatus;

const claudeMulti: ClaudeCodeStatus = {
  path: "/usr/local/bin/claude",
  version: "2.1.329",
  logged_in: true,
  email: "home@example.com",
  accounts: [
    { config_dir: null, config_directory: null, logged_in: true, auth_method: "claude.ai", subscription_type: "max", email: "home@example.com", error: null, login_command: "" },
    { config_dir: "/Users/me/.claude-work", config_directory: "/Users/me/.claude-work", logged_in: true, auth_method: "claude.ai", subscription_type: "max", email: "work@example.com", error: null, login_command: "" },
  ],
} as unknown as ClaudeCodeStatus;

const agentsMulti: AgentsStatusResponse = {
  items: [
    agent("codex", {
      models: [{ id: "gpt-5.6", name: "GPT-5.6", efforts: ["low", "high"] }, { id: "gpt-5.6-mini", name: "GPT-5.6 mini", efforts: [] }],
      accounts: [
        { config_dir: null, logged_in: true, auth: "personal", login_command: null, error: null },
        { config_dir: "/Users/me/.codex-work", logged_in: true, auth: "team", login_command: null, error: null },
      ],
    }),
    agent("antigravity", {
      models: [{ id: "agy-pro", name: "Agy Pro", efforts: [] }],
    }),
    agent("grok", {
      models: [{ id: "grok-4", name: "Grok 4", efforts: [] }],
      accounts: [{ config_dir: null, logged_in: true, auth: "main", login_command: null, error: null }],
    }),
  ],
  custom_agents: [],
};

function walk(tree: TuneTree, steps: [string, string][]): TuneFocus {
  return steps.reduce((focus, [level, value]) => tree.focusAt(level, value, focus), tree.start());
}

const keys = (tree: TuneTree, focus: TuneFocus) => tree.levels(focus).map((level) => level.key);

test("shows an account level for agents with multiple accounts, and omits it for single-account or accountless agents", () => {
  const picks: ConsultMember[] = [];
  const source: ConsultTuneSource = { t, agents: agentsMulti, claude: claudeMulti, client: null, onPick: (m) => picks.push(m) };
  const tree = consultTuneTree(source);

  const onClaude = walk(tree, [[CONSULT_AGENT_LEVEL, "claude_code"]]);
  expect(keys(tree, onClaude)).toEqual([CONSULT_AGENT_LEVEL, "account", "model", "effort"]);
  expect(tree.rows("account", onClaude)).toEqual([
    { value: "", label: "home@example.com", disabled: false },
    { value: "/Users/me/.claude-work", label: "work@example.com", disabled: false },
  ]);

  const onCodex = walk(tree, [[CONSULT_AGENT_LEVEL, "codex"]]);
  expect(keys(tree, onCodex)).toEqual([CONSULT_AGENT_LEVEL, "account", "model", "effort"]);
  expect(tree.rows("account", onCodex).map((row) => row.value)).toEqual(["", "/Users/me/.codex-work"]);

  // Antigravity has no accounts; Grok here has only one.
  expect(keys(tree, walk(tree, [[CONSULT_AGENT_LEVEL, "antigravity"]]))).toEqual([CONSULT_AGENT_LEVEL, "model", "effort"]);
  expect(keys(tree, walk(tree, [[CONSULT_AGENT_LEVEL, "grok"]]))).toEqual([CONSULT_AGENT_LEVEL, "model", "effort"]);
});

test("picking a non-default account emits config_dir; picking the default account omits it", async () => {
  const picks: ConsultMember[] = [];
  const asked: Array<string | null> = [];
  const client = {
    claudeCodeModels: async (configDir?: string | null) => {
      asked.push(configDir ?? null);
      return { config_dir: configDir ?? null, models: [], checked_at: "", error: null };
    },
  };
  const tree = consultTuneTree({ t, agents: agentsMulti, claude: claudeMulti, client, onPick: (m) => picks.push(m) });

  tree.commit("effort", walk(tree, [[CONSULT_AGENT_LEVEL, "claude_code"], ["account", "/Users/me/.claude-work"], ["model", "opus"], ["effort", "high"]]));
  tree.commit("effort", walk(tree, [[CONSULT_AGENT_LEVEL, "claude_code"], ["account", ""], ["model", "opus"], ["effort", "high"]]));
  tree.commit("model", walk(tree, [[CONSULT_AGENT_LEVEL, "codex"], ["account", "/Users/me/.codex-work"], ["model", "gpt-5.6-mini"]]));
  // Committing at agent or account level does nothing.
  tree.commit("account", walk(tree, [[CONSULT_AGENT_LEVEL, "codex"], ["account", "/Users/me/.codex-work"]]));

  await Promise.resolve();
  expect(picks).toEqual([
    { agent: "claude_code", model: "opus", effort: "high", config_dir: "/Users/me/.claude-work" },
    { agent: "claude_code", model: "opus", effort: "high" },
    { agent: "codex", model: "gpt-5.6-mini", effort: null, config_dir: "/Users/me/.codex-work" },
  ]);
  expect(asked).toContain("/Users/me/.claude-work");
});

test("consultAccountLabel names the account when multiple accounts exist or config_dir is set, and returns null otherwise", () => {
  expect(consultAccountChoices("antigravity", agentsMulti, claudeMulti, t)).toBeNull();
  expect(consultAccountLabel({ agent: "claude_code", model: "opus", effort: null, config_dir: "/Users/me/.claude-work" }, agentsMulti, claudeMulti, t)).toBe("work@example.com");
  expect(consultAccountLabel({ agent: "claude_code", model: "opus", effort: null }, agentsMulti, claudeMulti, t)).toBe("home@example.com");
  expect(consultAccountLabel({ agent: "grok", model: "grok-4", effort: null }, agentsMulti, claudeMulti, t)).toBeNull();
  expect(consultAccountLabel({ agent: "claude_code", model: "opus", effort: null, config_dir: "/Users/me/.claude-gone" }, null, null, t)).toBe("/Users/me/.claude-gone");
});
