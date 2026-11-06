/**
 * Your own ACP agents (ADR 0079; `settings/CustomAgentsCard.svelte`): any command that speaks the
 * Agent Client Protocol on its standard input and output, named by you, run with the arguments you
 * give (one per line). Each change sends the whole list, existing entries by their ids; the daemon
 * answers with every agent's status again, and refuses (409) to drop one a Bot runs on.
 *
 * Props: `agents` (the list as the daemon keeps it); `api` (`CustomAgentsApi`; null does nothing);
 * `onChange(response)` (the daemon's new answer); `embedded` (opened from Settings › Agents' list:
 * no heading or frame).
 * Test ids: the Svelte `data-custom-*` as `custom-*`: `custom-agents`, `custom-empty`,
 * `custom-agent-<id>`, `custom-name-<id>`, `custom-command-<id>`, `custom-rename-<id>`,
 * `custom-remove-<id>`, `custom-rename-input`, `custom-rename-save`, `custom-rename-cancel`,
 * `custom-error` (the daemon's refusal), `custom-full`, `custom-add` (the form), its fields
 * `custom-name-input`, `custom-command-input`, `custom-args-input` and the button `custom-add-submit`.
 */
import { signal, View } from "nsh";
import type { AgentsStatusResponse, CustomAgent } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { agentFailure, CUSTOM_AGENTS_MAX, parseArgs, renamed, type AgentFailure } from "../../m/settings/agents.ts";
import { AgentLogo } from "./AgentLogo";
import { AccountBox, AgentError, AgentFrame, AgentInput, AgentNote, AgentTitle, Code, FactText, WrapRow } from "./agent-parts";
import { XsButton } from "./provider-fields";

export type CustomAgentsApi = {
  setCustomAgents: (agents: Array<Omit<CustomAgent, "id"> & { id?: string }>) => Promise<AgentsStatusResponse>;
};

export function CustomAgentsCard(props: {
  agents: CustomAgent[];
  api: CustomAgentsApi | null;
  onChange?: (response: AgentsStatusResponse) => void;
  embedded?: boolean;
}) {
  const t = () => copy().agents.custom;
  const busy = signal(false);
  const failure = signal<AgentFailure | null>(null);
  const nameDraft = signal("");
  const commandDraft = signal("");
  const argsDraft = signal("");
  /** The agent whose name is being changed, and the name typed so far. */
  const renaming = signal<{ id: string; name: string } | null>(null);

  const full = () => props.agents.length >= CUSTOM_AGENTS_MAX;
  const addable = () => nameDraft().trim() !== "" && commandDraft().trim() !== "";

  /** Sends the whole list; true when the daemon kept it. */
  async function save(list: Array<Omit<CustomAgent, "id"> & { id?: string }>): Promise<boolean> {
    const api = props.api;
    if (!api || busy()) return false;
    busy.set(true);
    failure.set(null);
    try {
      props.onChange?.(await api.setCustomAgents(list));
      return true;
    } catch (error) {
      failure.set(agentFailure(error));
      return false;
    } finally {
      busy.set(false);
    }
  }

  async function add(): Promise<void> {
    if (!addable()) return;
    const saved = await save([...props.agents, { name: nameDraft().trim(), command: commandDraft().trim(), args: parseArgs(argsDraft()) }]);
    if (!saved) return;
    nameDraft.set("");
    commandDraft.set("");
    argsDraft.set("");
  }

  async function rename(): Promise<void> {
    const current = renaming();
    if (!current || !current.name.trim()) return;
    const saved = await save(renamed(props.agents, current.id, current.name.trim()));
    if (saved) renaming.set(null);
  }

  return (
    <AgentFrame label={t().title} testID="custom-agents" embedded={props.embedded}>
      <If
        when={props.embedded}
        else={<AgentTitle runner="custom" title={t().title} tip={t().hint} tipLabel={t().help} />}
      >
        <AgentNote>{t().hint}</AgentNote>
      </If>
      <If when={props.agents.length === 0 && !props.embedded} else={
        <View class="flex-col gap-2">
          <Each of={props.agents} key={(agent) => agent.id}>
            {(agent) => (
              <AccountBox label={agent().name} testID={`custom-agent-${agent().id}`} gap={4}>
                <If
                  when={renaming()?.id === agent().id}
                  else={
                    <View class="flex-row items-center gap-2 min-w-0">
                      <AgentLogo runner="custom" size={16} />
                      <View testID={`custom-name-${agent().id}`} class="flex-1 min-w-0">
                        <FactText bold>{agent().name}</FactText>
                      </View>
                      <XsButton label={t().rename} testID={`custom-rename-${agent().id}`} disabled={busy()} onPress={() => renaming.set({ id: agent().id, name: agent().name })} />
                      <XsButton
                        label={t().remove}
                        testID={`custom-remove-${agent().id}`}
                        disabled={busy()}
                        onPress={() => void save(props.agents.filter((other) => other.id !== agent().id))}
                      />
                    </View>
                  }
                >
                  <View class="flex-row items-center gap-2 min-w-0">
                    <AgentLogo runner="custom" size={16} />
                    <AgentInput
                      testID="custom-rename-input"
                      class="flex-1"
                      value={renaming()?.name ?? ""}
                      placeholder={t().name}
                      disabled={busy()}
                      onChange={(name) => renaming.set({ id: agent().id, name })}
                      onSubmit={() => void rename()}
                    />
                    <XsButton label={t().save} testID="custom-rename-save" disabled={busy() || !(renaming()?.name ?? "").trim()} onPress={() => void rename()} />
                    <XsButton label={t().cancel} testID="custom-rename-cancel" disabled={busy()} onPress={() => renaming.set(null)} />
                  </View>
                </If>
                <View testID={`custom-command-${agent().id}`}>
                  <Code size={11} muted>{[agent().command, ...agent().args].join(" ")}</Code>
                </View>
              </AccountBox>
            )}
          </Each>
        </View>
      }>
        <AgentNote testID="custom-empty">{t().empty}</AgentNote>
      </If>
      <If when={failure()}>
        {(failed) => (
          <AgentError
            testID="custom-error"
            text={failed().kind === "in_use" ? t().inUse : failed().kind === "invalid" ? t().invalid : t().failed}
            detail={failed().detail}
          />
        )}
      </If>
      <If
        when={full()}
        else={
          <View testID="custom-add" class="flex-col gap-2 pt-[10px] border-t border-line">
            <AgentInput
              testID="custom-name-input"
              value={nameDraft()}
              placeholder={t().namePlaceholder}
              disabled={busy()}
              onChange={(value) => nameDraft.set(value)}
              onSubmit={() => void add()}
            />
            <AgentInput
              testID="custom-command-input"
              value={commandDraft()}
              placeholder={t().commandPlaceholder}
              disabled={busy()}
              onChange={(value) => commandDraft.set(value)}
              onSubmit={() => void add()}
            />
            <AgentInput
              testID="custom-args-input"
              multiline
              mono
              value={argsDraft()}
              placeholder={t().argsPlaceholder}
              disabled={busy()}
              onChange={(value) => argsDraft.set(value)}
            />
            <WrapRow>
              <View class="flex-1" />
              <XsButton label={t().add} testID="custom-add-submit" disabled={busy() || !addable()} onPress={() => void add()} />
            </WrapRow>
          </View>
        }
      >
        <AgentNote testID="custom-full">{t().full(CUSTOM_AGENTS_MAX)}</AgentNote>
      </If>
    </AgentFrame>
  );
}
