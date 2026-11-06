/**
 * Settings › Agents and the three cards under it. The fixture's runtime has no agent installed, so
 * `live` is the tab on the runtime's own client (Claude Code and every agent not found, the folded
 * group); `stub` is the same tab on an in-memory API with agents found and signed in or out, so
 * the installed states and every action can be pressed without the network (each call is written
 * to `story-log`; `story-mode-*` makes its reads fail, say 404 or hold fresh answers back until `story-release`). `codex`, `grok` (not found), `claude` and `custom` show the cards on their own,
 * not embedded, as the setup wizard mounts them.
 */
import { Scroll, signal, Text, View } from "nsh";
import type { AgentStatus, AgentsStatusResponse, Bot, ClaudeCodeStatus, CustomAgent, UsageAgent, UsageResponse } from "@real-bot/protocol";
import { runtime } from "../src/runtime";
import { AgentCard } from "../src/ui/settings/AgentCard";
import { AgentsTab, type AgentsTabApi, type AgentsTabController } from "../src/ui/settings/AgentsTab";
import { ClaudeAgentCard } from "../src/ui/settings/ClaudeAgentCard";
import { CustomAgentsCard } from "../src/ui/settings/CustomAgentsCard";

/** How the stub answers the reads: well, as a daemon without the routes, failing, or with looks still going behind what it shows. */
const MODES = ["ok", "404", "fail", "refreshing"] as const;
type Mode = (typeof MODES)[number];

const PARTS = ["live", "stub", "codex", "grok", "claude", "custom"] as const;
type Part = (typeof PARTS)[number];

const NOW = "2026-10-10T00:00:00.000Z";

function status(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    runner: "codex", custom_id: null, label: "Codex", path: "/usr/local/bin/codex", source: "path", version: "0.130.0",
    logged_in: true, auth: "ChatGPT Plus", login_command: "codex login", models: [{ id: "gpt-5.6", name: "GPT-5.6", efforts: [] }], default_model: "gpt-5.6",
    proxy: null, proxy_source: null, checked_at: NOW, error: null, ...over,
  };
}

function claudeStatus(over: Partial<ClaudeCodeStatus> = {}): ClaudeCodeStatus {
  return {
    path: "/Users/you/.local/bin/claude", source: "known", version: "2.1.289", sdk_version: "2.1.289", outdated: false,
    logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: null, base_url_set: false,
    proxy: null, proxy_source: null, checked_at: NOW, error: null,
    accounts: [{ config_dir: null, config_directory: "/Users/you/.claude", logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: null, error: null, login_command: "claude auth login" }],
    ...over,
  };
}

const codexWithAccount = (dirs: string[]): AgentStatus =>
  status({
    accounts: [
      { config_dir: null, logged_in: true, auth: "ChatGPT Plus", error: null, login_command: null },
      ...dirs.map((dir) => ({ config_dir: dir, logged_in: false, auth: null, error: null, login_command: `CODEX_HOME=${dir} codex login` })),
    ],
  });

const bots = [
  { id: "b1", runner: "codex", archived_at: null },
  { id: "b2", runner: "codex", archived_at: null },
  { id: "b3", runner: "codex", archived_at: "2026-10-01T00:00:00.000Z" },
] as unknown as Bot[];

const claudeUsage: UsageAgent = {
  runner: "claude_code", custom_id: null, label: "Claude Code", today: { turns: 3, tokens: 1200, estimated_usd: 0.1 },
  accounts: [{ config_dir: null, email: null, available: true, reason: null, plan: "pro", windows: [{ minutes: 300, model: null, percent: 42, resets_at: null }], credits: null, checked_at: NOW, error: null }],
};

/** The daemon's answers, kept in memory: what a press changed is what the next read says. */
function stubApi(log: (line: string) => void, mode: () => Mode, hold: { release: (() => void) | null }): AgentsTabApi {
  let claude = claudeStatus();
  let custom: CustomAgent[] = [{ id: "ca-1", name: "my-agent", command: "/bin/my-agent", args: ["acp"] }];
  let codexDirs: string[] = [];
  let codexPath: string | null = "/usr/local/bin/codex";
  let seq = 1;
  const items = (): AgentStatus[] => [
    status({ ...codexWithAccount(codexDirs), path: codexPath, source: codexPath === "/usr/local/bin/codex" ? "path" : "setting" }),
    status({ runner: "grok", label: "Grok", logged_in: false, auth: null, login_command: "grok login", models: [] }),
    status({ runner: "opencode", label: "OpenCode", auth: "OpenCode Go, Alibaba, DeepSeek, Nvidia", models: [{ id: "a/b", name: "a/b", efforts: [] }, { id: "c/d", name: "c/d", efforts: [] }] }),
    status({ runner: "zcode", label: "ZCode", path: null, source: null, version: null, logged_in: null, auth: null, login_command: null, models: [], default_model: null }),
    ...custom.map((agent) => status({ runner: "custom", custom_id: agent.id, label: agent.name, path: agent.command, source: "custom", logged_in: null, auth: null, login_command: null, models: [], default_model: null })),
  ];
  const response = (): AgentsStatusResponse => ({ items: items(), custom_agents: custom });
  const refused = (code: number, message: string) => Object.assign(new Error(message), { status: code });
  return {
    claudeCode: async () => {
      log("claudeCode");
      if (mode() === "404") throw refused(404, "not found");
      return claude;
    },
    detectClaudeCode: async () => (log("detectClaudeCode"), claude),
    setClaudeCodePath: async (path) => (log(`setClaudeCodePath:${path}`), (claude = claudeStatus({ path: path ?? claude.path, source: path ? "setting" : "known" }))),
    setClaudeCodeAccounts: async (dirs) => {
      log(`setClaudeCodeAccounts:${dirs.join(",")}`);
      if (dirs.some((dir) => !dir.startsWith("/") && !dir.startsWith("~/"))) throw refused(422, "not a directory");
      const own = claudeStatus().accounts![0]!;
      claude = claudeStatus({
        accounts: [own, ...dirs.map((dir) => ({ config_dir: dir, config_directory: dir, logged_in: false, auth_method: null, subscription_type: null, email: null, error: null, login_command: `CLAUDE_CONFIG_DIR=${dir} claude auth login` }))],
      });
      return claude;
    },
    agents: async (refresh, wait) => {
      log(wait ? "agents:wait" : refresh ? "agents:refresh" : "agents");
      if (mode() === "404") throw refused(404, "not found");
      if (mode() === "fail") throw new Error("down");
      if (mode() !== "refreshing") return response();
      // As last seen (Codex signed out), the fresh answer held until the story lets it go.
      const seen = response();
      if (!wait) return { ...seen, items: seen.items.map((item) => (item.runner === "codex" ? { ...item, logged_in: false, auth: null } : item)), refreshing: true };
      await new Promise<void>((resolve) => (hold.release = resolve));
      return seen;
    },
    detectAgent: async (runner, customId) => {
      log(`detectAgent:${runner}`);
      return items().find((item) => item.runner === runner && item.custom_id === (customId ?? null))!;
    },
    setAgentPath: async (runner, path) => {
      log(`setAgentPath:${runner}:${path}`);
      codexPath = path ?? "/usr/local/bin/codex";
      return items().find((item) => item.runner === runner)!;
    },
    setAgentAccounts: async (runner, dirs) => {
      log(`setAgentAccounts:${runner}:${dirs.join(",")}`);
      if (dirs.some((dir) => dir === "/home")) throw refused(409, "Bot Writer runs on it");
      codexDirs = dirs;
      return items().find((item) => item.runner === runner)!;
    },
    setCustomAgents: async (list) => {
      log(`setCustomAgents:${list.map((agent) => agent.name).join(",")}`);
      if (list.length < custom.length && custom.some((agent) => agent.name === "busy" && !list.some((other) => other.id === agent.id))) throw refused(409, "Bot Writer runs on busy");
      custom = list.map((agent) => ({ ...agent, id: agent.id ?? `ca-${(seq += 1)}` }));
      return response();
    },
    usage: async (): Promise<UsageResponse> => ({ agents: [claudeUsage] }),
  };
}

export default function SettingsAgents() {
  const part = signal<Part>("live");
  const log = signal("");
  const title = signal("title:");
  const back = signal("back:");
  let controller: AgentsTabController | null = null;
  const note = (line: string) => log.set(log() ? `${log()} ${line}` : line);
  const mode = signal<Mode>("ok");
  const hold: { release: (() => void) | null } = { release: null };
  const api = stubApi(note, () => mode(), hold);
  /** Settings changes made from the cards part, as the wizard keeps them. */
  const codex = signal<AgentStatus>(codexWithAccount(["/Users/you/.codex-b"]));
  const claudeSeen = signal("claude:");
  const customs = signal<CustomAgent[]>([{ id: "ca-1", name: "my-agent", command: "/bin/my-agent", args: ["acp", "--stdio"] }]);
  const customApi = { setCustomAgents: api.setCustomAgents };

  return (
    <View testID="settings-agents" class="flex-1 bg-bg">
      <View class="flex-row flex-wrap gap-2 p-3 border-b border-line">
        <Each of={PARTS} key={(item) => item}>
          {(item) => (
            <View role="button" testID={`story-show-${item()}`} onPress={() => part.set(item())} class={`px-2 py-1 border rounded-(--radius-sm) ${part() === item() ? "border-brand" : "border-line"}`}>
              <Text class="text-[12px] text-ink">{item()}</Text>
            </View>
          )}
        </Each>
        <View role="button" testID="story-title" onPress={() => title.set(`title:${controller?.sectionTitle() ?? ""}`)} class="px-2 py-1 border border-line rounded-(--radius-sm)">
          <Text class="text-[12px] text-ink">section title</Text>
        </View>
        <View role="button" testID="story-back" onPress={() => back.set(`back:${controller?.backFromSection() ?? "none"}`)} class="px-2 py-1 border border-line rounded-(--radius-sm)">
          <Text class="text-[12px] text-ink">back</Text>
        </View>
        <Each of={MODES} key={(item) => item}>
          {(item) => (
            <View role="button" testID={`story-mode-${item()}`} onPress={() => mode.set(item())} class={`px-2 py-1 border rounded-(--radius-sm) ${mode() === item() ? "border-brand" : "border-line"}`}>
              <Text class="text-[12px] text-ink">{`mode ${item()}`}</Text>
            </View>
          )}
        </Each>
        <View role="button" testID="story-release" onPress={() => hold.release?.()} class="px-2 py-1 border border-line rounded-(--radius-sm)">
          <Text class="text-[12px] text-ink">release</Text>
        </View>
        <Text testID="story-title-text" class="text-[12px] text-ink-muted">{title()}</Text>
        <Text testID="story-back-text" class="text-[12px] text-ink-muted">{back()}</Text>
        <Text testID="story-claude" class="text-[12px] text-ink-muted">{claudeSeen()}</Text>
        <Text testID="story-codex" class="text-[12px] text-ink-muted">{`codex:${codex().logged_in}:${codex().accounts?.length ?? 0}`}</Text>
        <Text testID="story-customs" class="text-[12px] text-ink-muted">{`customs:${customs().map((agent) => agent.name).join(",")}`}</Text>
        <Text testID="story-log" class="text-[12px] text-ink-muted">{`log:${log()}`}</Text>
      </View>
      <Scroll class="flex-1">
        <View class="flex-col gap-4 p-4 max-w-[720px]">
          {/* The runtime's client is set when it connects and is not a signal: the shell opens Settings after that, so the story does too. */}
          <If when={part() === "live" && runtime.connection === "connected"}>
            <AgentsTab api={runtime.client as unknown as AgentsTabApi | null} bots={runtime.snapshot.bots} controller={(c) => (controller = c)} />
          </If>
          <If when={part() === "stub"}>
            <AgentsTab api={api} bots={bots} controller={(c) => (controller = c)} />
          </If>
          <If when={part() === "codex"}>
            <AgentCard status={codex()} api={api} onChange={(next) => codex.set(next)} />
          </If>
          <If when={part() === "grok"}>
            <AgentCard status={status({ runner: "grok", label: "Grok", path: null, source: null, version: null, logged_in: null, auth: null, login_command: null, models: [], default_model: null })} api={api} />
          </If>
          <If when={part() === "claude"}>
            <ClaudeAgentCard api={api} onstatus={(next) => claudeSeen.set(`claude:${next.logged_in}`)} usage={claudeUsage} />
          </If>
          <If when={part() === "custom"}>
            <CustomAgentsCard agents={customs()} api={customApi} onChange={(response) => customs.set(response.custom_agents)} />
          </If>
        </View>
      </Scroll>
    </View>
  );
}
