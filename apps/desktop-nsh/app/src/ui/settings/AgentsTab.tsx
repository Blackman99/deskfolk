/**
 * Settings › Agents (ADR 0061, ADR 0079, `settings/AgentsTab.svelte`): every local agent as one
 * line: its logo, whether it can run a Bot now, how it is signed in, how many models it lists and
 * how many Bots it runs; the ones not installed folded away at the foot, then your own ACP agents.
 * A line opens to that agent's details and settings (its path, its other accounts): in place on a
 * wide window, one at a time, and as a page of its own on a phone, Back going to the list. Asked
 * once when the tab opens, from this Mac or over the relay from a phone.
 *
 * Props: `api` (`AgentsTabApi`, the runtime's client; null draws nothing); `bots` (the roster, to
 * say how many Bots each agent runs); `controller` (called once with the Svelte-exported
 * `sectionTitle()`, the open agent's name for a phone's page head or null on the list and on a
 * wide window, and `backFromSection()`, Back on a phone from an agent's page to the list, true when
 * it did).
 * Not carried over: the Svelte phone breakpoint was 720; here it is `narrowWindow()` (680).
 * Test ids: `agents-tab`, `agents-page-<key>`, `agents-recheck-all`, `agents-unreachable`,
 * `agents-failed` (and `agents-retry`), `agents-loading`, `agents-missing-toggle`; per line
 * `agent-row-<key>` (the line), `agent-row-head-<key>`, `agent-row-summary-<key>`,
 * `agent-row-bots-<key>`, `agent-row-state-<key>`, `agent-row-open-<key>` (the open body). The key is
 * `claude_code`, the runner, `custom:<id>` or `custom-agents`.
 */
import { effect, signal, untracked, Text, View, type JSX } from "nsh";
import type { AgentStatus, AgentsStatusResponse, Bot, BotRunner, ClaudeCodeStatus } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { agentCommand, agentKey, agentUnreachable } from "../../m/settings/agents.ts";
import { claudeAccountLabel } from "../../m/settings/claude-agent.ts";
import { UsageFeed, type UsageApi } from "../../m/usage/usage-feed.svelte.ts";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { AgentCard, type AgentCardApi } from "./AgentCard";
import { AgentLogo } from "./AgentLogo";
import { ClaudeAgentCard, type ClaudeAgentApi } from "./ClaudeAgentCard";
import { CustomAgentsCard, type CustomAgentsApi } from "./CustomAgentsCard";
import { AgentNote } from "./agent-parts";
import { XsButton } from "./provider-fields";

export type AgentsTabApi = ClaudeAgentApi &
  AgentCardApi &
  CustomAgentsApi &
  Partial<UsageApi> & {
    agents: (refresh?: boolean, wait?: boolean) => Promise<AgentsStatusResponse>;
  };

export type AgentsTabController = { sectionTitle: () => string | null; backFromSection: () => boolean };

type RowState = "ready" | "signin" | "missing" | "checking";
type Row = { key: string; runner: BotRunner; label: string; state: RowState; summary: string; bots: number; agent: AgentStatus | null };

/** Still being asked keeps its place among the ready ones: Claude's line does not jump when it answers. */
const ORDER: Record<RowState, number> = { ready: 0, checking: 0, signin: 1, missing: 2 };

export function AgentsTab(props: {
  api: AgentsTabApi | null;
  /** The roster, to say how many Bots each agent runs. */
  bots?: readonly Bot[];
  controller?: (controller: AgentsTabController) => void;
}) {
  const t = () => copy();
  const phone = () => narrowWindow();

  const claude = signal<ClaudeCodeStatus | null>(null);
  const claudeUnreachable = signal(false);
  const list = signal<AgentsStatusResponse | null>(null);
  const loading = signal(false);
  const failed = signal(false);
  /** Not there: a phone paired with a Mac on a Deskfolk from before the relay carried it. */
  const unavailable = signal(false);
  const rechecking = signal(false);
  /** The line opened: `claude_code`, an agent's key, or `custom-agents` for your own ACP agents. */
  const opened = signal<string | null>(null);
  const missingShown = signal(false);
  /** Each agent's usage, a line under each account (ADR 0080): asked once when the tab opens. */
  const usage = new UsageFeed();
  const usageOf = (runner: BotRunner, customId: string | null = null) =>
    usage.agents?.find((agent) => agent.runner === runner && (agent.custom_id ?? null) === (customId ?? null)) ?? null;

  /** The ask still out, so a check of all made while the first answer is coming waits for it, then asks again. */
  let inFlight: Promise<void> | null = null;

  async function loadAgents(client: AgentsTabApi, refresh = false): Promise<void> {
    if (inFlight) {
      if (!refresh) return inFlight;
      await inFlight;
    }
    inFlight = askAgents(client, refresh);
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function askAgents(client: AgentsTabApi, refresh: boolean): Promise<void> {
    loading.set(true);
    failed.set(false);
    try {
      list.set(await client.agents(refresh));
      unavailable.set(false);
    } catch (error) {
      if (agentUnreachable(error)) unavailable.set(true);
      else failed.set(true);
    } finally {
      loading.set(false);
    }
    // Shown as last seen, some looked at again behind it: their fresh answers when they come.
    if (list()?.refreshing) void followUp(client);
  }

  /** Waiting on the looks the daemon has going, so the lines it showed from before catch up by themselves. */
  const catchingUp = signal(false);
  async function followUp(client: AgentsTabApi): Promise<void> {
    if (catchingUp()) return;
    catchingUp.set(true);
    try {
      const fresh = await client.agents(false, true);
      list.set({ ...fresh, refreshing: false });
    } catch {
      // The lines stay as last seen; "Check all again" asks afresh.
    } finally {
      catchingUp.set(false);
    }
  }

  async function loadClaude(client: AgentsTabApi, refresh = false): Promise<void> {
    try {
      claude.set(await (refresh ? client.detectClaudeCode() : client.claudeCode()));
      claudeUnreachable.set(false);
    } catch (error) {
      if ((error as { status?: number }).status === 404) claudeUnreachable.set(true);
    }
  }

  // Asks once per client; untracked, so an answer does not set off the next ask.
  effect(() => {
    const client = props.api;
    if (!client) return;
    untracked(() => {
      void loadClaude(client);
      void loadAgents(client);
      if (client.usage) void usage.load(client as UsageApi);
    });
  });

  async function recheckAll(): Promise<void> {
    const api = props.api;
    if (!api || rechecking()) return;
    rechecking.set(true);
    try {
      await Promise.all([loadClaude(api, true), loadAgents(api, true)]);
    } finally {
      rechecking.set(false);
    }
  }

  function changed(next: AgentStatus): void {
    const current = list();
    if (!current) return;
    list.set({ ...current, items: current.items.map((item) => (agentKey(item) === agentKey(next) ? next : item)) });
  }

  function botsOn(runner: BotRunner, customId: string | null): number {
    return (props.bots ?? []).filter((bot) => !bot.archived_at && (bot.runner ?? null) === runner && (runner !== "custom" || bot.agent_custom_id === customId)).length;
  }

  const claudeRow = (): Row => {
    const c = t();
    const status = claude();
    const base = { key: "claude_code", runner: "claude_code" as const, label: c.claudeAgent.title, bots: botsOn("claude_code", null), agent: null };
    if (claudeUnreachable()) return { ...base, state: "checking", summary: c.agents.list.unreachable };
    if (!status) return { ...base, state: "checking", summary: c.agents.loading };
    if (!status.path) return { ...base, state: "missing", summary: c.agents.list.notFound("claude") };
    if (status.logged_in === false) return { ...base, state: "signin", summary: c.agents.list.signedOut(null) };
    return { ...base, state: "ready", summary: [claudeAccountLabel(status, c), status.version].filter(Boolean).join(" · ") };
  };

  function agentRow(status: AgentStatus): Row {
    const c = t();
    const customId = status.custom_id ?? null;
    const custom = customId ? (list()?.custom_agents.find((entry) => entry.id === customId) ?? null) : null;
    const base = { key: customId ? `custom:${customId}` : status.runner, runner: status.runner, label: status.label, bots: botsOn(status.runner, customId), agent: status };
    if (!status.path) return { ...base, state: "missing", summary: c.agents.list.notFound(agentCommand(status, custom)) };
    if (status.logged_in === false) return { ...base, state: "signin", summary: c.agents.list.signedOut(status.login_command) };
    const providers = status.auth?.split(/,\s*/).filter(Boolean) ?? [];
    const signIn =
      status.logged_in !== true
        ? c.agents.list.signInLater
        : providers.length > 2
          ? c.agents.list.signedInMany(providers[0]!, providers.length)
          : (status.auth ?? null);
    const models = status.models.length > 0 ? c.agents.list.models(status.models.length) : null;
    return { ...base, state: "ready", summary: [signIn, models].filter(Boolean).join(" · ") || c.agents.signedIn(null) };
  }

  const rows = (): Row[] => [claudeRow(), ...(list()?.items ?? []).map(agentRow)].sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  /** Found or to sign in: the agents there are to use. The rest wait folded at the foot. */
  const shownRows = () => rows().filter((row) => row.state !== "missing");
  const missingRows = () => rows().filter((row) => row.state === "missing");
  const customRow = (): Row | null => {
    const current = list();
    return current
      ? { key: "custom-agents", runner: "custom", label: t().agents.list.customRow, state: "ready", summary: t().agents.list.customSummary(current.custom_agents.length), bots: 0, agent: null }
      : null;
  };
  const openRow = (): Row | null => {
    const custom = customRow();
    return [...rows(), ...(custom ? [custom] : [])].find((row) => row.key === opened()) ?? null;
  };

  function toggle(row: Row): void {
    opened.set(opened() === row.key ? null : row.key);
  }

  props.controller?.({
    /** The open agent's name for the page head on a phone; null on the list, and on a wide window. */
    sectionTitle: () => (phone() ? (openRow()?.label ?? null) : null),
    /** Back on a phone from an agent's page goes to the list. */
    backFromSection: () => {
      if (!phone() || !opened()) return false;
      opened.set(null);
      return true;
    },
  });

  /** The open line's card; each prop reads its signals where it is used, so a check there shows at once. */
  function detail(row: () => Row): JSX.Element {
    return (
      <>
        <If when={row().key === "claude_code"}>
          <ClaudeAgentCard api={props.api} embedded usage={usageOf("claude_code")} onstatus={(status) => claude.set(status)} />
        </If>
        <If when={row().key === "custom-agents" ? list() : null}>
          {(current) => <CustomAgentsCard agents={current().custom_agents} api={props.api} embedded onChange={(response) => list.set(response)} />}
        </If>
        <If when={row().agent}>
          {(agent) => (
            <AgentCard
              status={agent()}
              api={props.api}
              embedded
              usage={usageOf(agent().runner, agent().custom_id)}
              custom={agent().custom_id ? (list()?.custom_agents.find((entry) => entry.id === agent().custom_id) ?? null) : null}
              onChange={changed}
            />
          )}
        </If>
      </>
    );
  }

  /** The state's dot, with its word on a wide window; on a phone the dot and the summary carry it. */
  const DOT: Record<RowState, string> = { ready: "bg-ok", signin: "bg-warn", missing: "bg-muted-light", checking: "bg-muted-light" };

  function line(row: () => Row, withState: boolean, first: boolean): JSX.Element {
    const open = () => opened() === row().key;
    return (
      <View
        testID={`agent-row-${row().key}`}
        class={`${open() && !phone() ? "bg-line-subtle" : ""} ${first ? "" : "border-t border-line"}`}
      >
        <View
          role="button"
          testID={`agent-row-head-${row().key}`}
          accessibilityLabel={row().label}
          accessibilityState={phone() ? undefined : { expanded: open() }}
          onPress={() => toggle(row())}
          class={`cursor-pointer select-none flex-row items-center gap-3 hover:bg-line-subtle ${phone() ? "min-h-14 px-3 py-[10px]" : "px-[14px] py-[10px]"}`}
        >
          <AgentLogo runner={row().runner} size={28} />
          <View class="flex-1 min-w-0 flex-col gap-[2px]">
            <Text class="text-[14px] font-semibold text-ink">{row().label}</Text>
            <Text testID={`agent-row-summary-${row().key}`} class="text-[12px] text-ink-muted line-clamp-1">
              {row().summary}
            </Text>
          </View>
          <If when={row().bots > 0}>
            <View testID={`agent-row-bots-${row().key}`} class="px-[7px] py-px rounded-full bg-chip border border-chip-line">
              <Text class="text-[11px] text-ink-secondary">{t().agents.list.bots(row().bots)}</Text>
            </View>
          </If>
          <If when={withState}>
            <View testID={`agent-row-state-${row().key}`} class="flex-row items-center gap-[5px]">
              <View class={`w-[7px] h-[7px] rounded-full ${DOT[row().state]}`} />
              <If when={!phone()}>
                <Text class={`text-[12px] ${row().state === "signin" ? "text-warn-text" : "text-ink-secondary"}`}>{t().agents.list.state[row().state]}</Text>
              </If>
            </View>
          </If>
          <Icon name={phone() ? "chevron-right" : open() ? "chevron-up" : "chevron-down"} size={16} class="tint-ink-muted" />
        </View>
        <If when={open() && !phone()}>
          <View testID={`agent-row-open-${row().key}`} class="pl-[54px] pr-[14px] pt-1 pb-[14px] border-t border-line-subtle">
            {detail(row)}
          </View>
        </If>
      </View>
    );
  }

  return (
    <If when={props.api}>
      <View testID="agents-tab" class="flex-col gap-3 min-w-0">
        <If
          when={phone() ? openRow() : null}
          else={
            <>
              <View class="flex-row items-start gap-3">
                <View class="flex-1">
                  <AgentNote>{t().agents.list.intro}</AgentNote>
                </View>
                <XsButton
                  label={rechecking() || catchingUp() ? t().agents.checking : t().agents.list.recheckAll}
                  testID="agents-recheck-all"
                  disabled={rechecking() || catchingUp()}
                  onPress={() => void recheckAll()}
                />
              </View>
              <View
                role="list"
                accessibilityLabel={t().settings.tabAgents}
                class="bg-pane border border-line rounded-(--radius-md) overflow-hidden"
                style={{ boxShadow: shadow("xs") }}
              >
                <Each of={shownRows()} key={(row) => row.key}>
                  {(row) => line(row, true, row().key === (shownRows()[0] ?? customRow())?.key)}
                </Each>
                <If when={customRow()}>{(row) => line(row, false, shownRows().length === 0)}</If>
              </View>
              <If when={unavailable()}>
                <View testID="agents-unreachable">
                  <AgentNote>{t().agents.unreachable}</AgentNote>
                </View>
              </If>
              <If when={!unavailable() && failed()}>
                <View role="alert" testID="agents-failed" class="flex-row flex-wrap items-center gap-2">
                  <AgentNote>{t().agents.loadFailed}</AgentNote>
                  <XsButton label={t().agents.retry} testID="agents-retry" disabled={loading()} onPress={() => props.api && void loadAgents(props.api)} />
                </View>
              </If>
              <If when={!unavailable() && !failed() && loading() && !list()}>
                <View testID="agents-loading">
                  <AgentNote>{t().agents.loading}</AgentNote>
                </View>
              </If>
              <If when={missingRows().length > 0}>
                <View
                  role="button"
                  testID="agents-missing-toggle"
                  accessibilityState={{ expanded: missingShown() }}
                  onPress={() => missingShown.set(!missingShown())}
                  class="cursor-pointer select-none self-start flex-row items-center gap-[6px] py-[2px]"
                >
                  <Icon name={missingShown() ? "chevron-down" : "chevron-right"} size={16} class="tint-ink-muted" />
                  <Text class="text-[12px] text-ink-secondary">{t().agents.list.missingGroup(missingRows().length)}</Text>
                </View>
                <If when={missingShown()}>
                  <View
                    role="list"
                    accessibilityLabel={t().agents.list.missingGroup(missingRows().length)}
                    class="bg-pane border border-line rounded-(--radius-md) overflow-hidden"
                  >
                    <Each of={missingRows()} key={(row) => row.key}>
                      {(row) => line(row, false, row().key === missingRows()[0]?.key)}
                    </Each>
                  </View>
                </If>
              </If>
            </>
          }
        >
          {(row) => (
            <View testID={`agents-page-${row().key}`} class="flex-col gap-[14px]">
              <View class="flex-row items-center gap-3">
                <AgentLogo runner={row().runner} size={32} />
                <View class="flex-1 min-w-0 flex-col gap-[2px]">
                  <Text class="text-[14px] font-semibold text-ink">{row().label}</Text>
                  <Text class="text-[12px] text-ink-muted line-clamp-1">{row().summary}</Text>
                </View>
              </View>
              {detail(row)}
            </View>
          )}
        </If>
      </View>
    </If>
  );
}
