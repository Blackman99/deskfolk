/**
 * The picker of one built-in call's model (ADR 0077; `settings/SideModelCard.svelte`): reading lines
 * (ADR 0055), organizing the board (ADR 0075) and the rest are all this card. Any model an endpoint
 * lists, or the default model; and, when `claude` is given, a Claude model run through your own Claude
 * Code (ADR 0061). The page that holds the card says what the call is for.
 *
 * Props: `kind` (which setting this is; the card's `testID` is `side-model-<kind>`); `providers`;
 * `chosen` (null follows the default); `defaultModel`; `patch(patch)` (resolves null when saved);
 * `toPatch(next)`; `title` (what the picker is called); `followDefault(model)`; `failed` (said when a
 * choice was not saved); `claude` (`{ status, note }`: offers the Claude models of your Claude Code);
 * `agents` (finds your other local agents); `claudeModels` (asks Claude Code for its model list);
 * `framed` (false drops the card's own chrome, for a picker that sits inside another card).
 * Test ids: `side-model-<kind>`, `side-model-picker`, `side-model-error`, `side-model-account`,
 * `side-model-claude-note`, `side-model-agent-note`.
 */
import { effect, signal, Text, untracked, View, windowSize } from "nsh";
import {
  isReaderAgentModel,
  isReaderClaudeModel,
  type AgentsStatusResponse,
  type BotRunner,
  type ClaudeCodeStatus,
  type Provider,
  type ReaderAgentModel,
  type ReaderModel,
  type SettingsPatch,
} from "@real-bot/protocol";
import { copy } from "../../runtime";
import { claudeModelOptions, claudeModelsOf, loadClaudeModels } from "../../m/claude-models.svelte.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { claudeAccountOptions, claudeReady } from "../../m/settings/claude-agent.ts";
import type { PickerData, PickerRow, PickerSource } from "../../m/model-picker.ts";
import { agentPickerSources, claudePickerSource, endpointPickerSources } from "../../m/model-picker-sources.ts";
import { agentSource } from "../../m/model-source.ts";
import { agentAccountOptions, agentAccountsOf, agentLabelOf, agentModelsOf, agentStatusOf } from "../../m/runner-choice.ts";
import { ModelPicker } from "../ModelPicker";
import { Select } from "../Select";
import { shadow } from "../styles";

const FOLLOW = "";
const key = (row: ReaderModel) =>
  JSON.stringify(
    isReaderAgentModel(row)
      ? { runner: row.runner, model: row.model, ...(row.custom_id ? { custom_id: row.custom_id } : {}) }
      : { provider_id: row.provider_id, model: row.model },
  );
const sameAgent = (row: ReaderAgentModel, runner: BotRunner, customId: string | null) => row.runner === runner && (row.custom_id ?? null) === customId;

export function SideModelCard(props: {
  kind: string;
  providers: readonly Provider[];
  chosen: ReaderModel | null;
  defaultModel: string | null;
  patch: (patch: SettingsPatch) => Promise<unknown | null>;
  toPatch: (next: ReaderModel | null) => SettingsPatch;
  title: string;
  followDefault: (model: string | null) => string;
  failed: string;
  claude?: { status: (() => Promise<ClaudeCodeStatus>) | null; note: string } | null;
  agents?: (() => Promise<AgentsStatusResponse>) | null;
  claudeModels?: Pick<MessengerApi, "claudeCodeModels"> | null;
  framed?: boolean;
}) {
  const busy = signal(false);
  const failed = signal(false);
  const claudeStatus = signal<ClaudeCodeStatus | null>(null);
  const agentsFound = signal<AgentsStatusResponse | null>(null);
  /** The account a Claude model is picked on: the one already chosen, else the computer's default (''). */
  const pickedAccount = signal("");
  const framed = () => props.framed !== false;
  const phone = () => windowSize().width <= 720;

  void props.claude?.status?.().then(
    (status) => claudeStatus.set(status),
    () => claudeStatus.set(null),
  );
  if (props.agents) {
    const find = props.agents;
    // Called inside the try: a client that has no such call (an older Mac, a fake) fails as an answer does.
    void (async () => {
      try {
        agentsFound.set(await find());
      } catch {
        agentsFound.set(null);
      }
    })();
  }
  effect(() => {
    const chosen = props.chosen;
    if (isReaderAgentModel(chosen)) pickedAccount.set(chosen.config_dir ?? "");
  });

  /** The Claude models Claude Code lists for this computer's account, the fastest first: a reading holds up your line. */
  const claudeOptions = () => {
    const listed = claudeModelOptions(claudeModelsOf(null));
    const options = [...listed.filter((model) => model.value === "haiku"), ...listed.filter((model) => model.value !== "haiku")];
    const chosen = props.chosen;
    return isReaderClaudeModel(chosen) && !options.some((model) => model.value === chosen.model) ? [...options, { value: chosen.model, label: chosen.model }] : options;
  };
  /** The agent whose model is chosen, whichever it is; Claude's is told apart where only it behaves differently. */
  const chosenAgent = () => (isReaderAgentModel(props.chosen) ? props.chosen : null);
  const claudeChosen = () => (isReaderClaudeModel(props.chosen) ? props.chosen : null);
  /** Offered once Claude Code is there and signed in, and kept while one of its models is what reads. */
  const claudeOffered = () => (props.claude ?? null) !== null && (claudeReady(claudeStatus()) || claudeChosen() !== null);
  effect(() => {
    const source = props.claudeModels ?? null;
    if (claudeOffered()) untracked(() => loadClaudeModels(source, null));
  });
  /** What the agents list, with the one chosen kept even when it is no longer listed. */
  const agentsOffered = (): AgentsStatusResponse | null => {
    const found = agentsFound();
    if (!found) return null;
    const agent = chosenAgent();
    const other = agent && agent.runner !== "claude_code" ? agent : null;
    return {
      ...found,
      items: found.items.map((status) => {
        const models = agentModelsOf(status);
        const isChosen = other !== null && sameAgent(other, status.runner, status.custom_id ?? null);
        return isChosen && !models.some((model) => model.id === other.model) ? { ...status, models: [...models, { id: other.model, name: other.model, efforts: [] }] } : { ...status, models };
      }),
    };
  };
  /** The account picker's choices on the chosen agent, and how many accounts it has. */
  const chosenAccounts = () => {
    const agent = chosenAgent();
    if (!agent) return { count: 0, options: [] as Array<{ value: string; label: string }> };
    if (agent.runner === "claude_code") {
      return { count: claudeStatus()?.accounts?.length ?? 0, options: claudeAccountOptions(claudeStatus(), pickedAccount(), copy()) };
    }
    const status = agentStatusOf(agentsFound(), agent.runner, agent.custom_id ?? null);
    return { count: agentAccountsOf(status).length, options: agentAccountOptions(status, pickedAccount(), copy()) };
  };
  const chosenLabel = () => {
    const agent = chosenAgent();
    return agent && agent.runner !== "claude_code" ? agentLabelOf(agent.runner, agent.custom_id ?? null, agentsFound()) : "";
  };

  /**
   * What the picker offers: the follow-default row on top, then each endpoint, Claude Code once it is
   * there and signed in, and each other agent found and signed in. The model chosen stays shown when
   * nothing lists it (the phone cannot ask the agents; an endpoint dropped a model).
   */
  const data = (): PickerData => {
    const t = copy();
    const chosen = props.chosen;
    const specials: PickerRow[] = [{ value: FOLLOW, label: props.followDefault(props.defaultModel) }];
    const sources: PickerSource[] = [
      ...endpointPickerSources(props.providers, t, (provider_id, model) => key({ provider_id, model })),
      ...(claudeOffered() ? [claudePickerSource(t, (model) => key({ runner: "claude_code", model, config_dir: null }), claudeOptions())] : []),
      ...agentPickerSources(agentsOffered(), t, (runner, model, custom_id) => key({ runner, model, config_dir: null, custom_id }), { typed: true }),
    ];
    if (chosen) {
      const value = key(chosen);
      const listed = sources.some((source) => source.groups.some((group) => group.rows.some((row) => row.value === value)));
      const agent = chosenAgent();
      const other = agent && agent.runner !== "claude_code" ? agent : null;
      if (!listed && other) {
        // An agent that was not found or is signed out, or that the phone cannot ask: a source of its own with the one model.
        const customId = other.custom_id ?? null;
        const label = agentLabelOf(other.runner, customId, agentsFound());
        sources.push({ key: `agent:${other.runner}${customId ? `:${customId}` : ""}`, label, mark: agentSource(other.runner, label), groups: [{ key: "", label: null, rows: [{ value, id: other.model, label: other.model }] }] });
      } else if (!listed) {
        specials.push({ value, id: chosen.model, label: chosen.model });
      }
    }
    return { specials, sources };
  };

  async function save(next: ReaderModel | null): Promise<void> {
    if (busy()) return;
    busy.set(true);
    failed.set(false);
    try {
      const error = await props.patch(props.toPatch(next));
      failed.set(error !== null);
    } finally {
      busy.set(false);
    }
  }

  function choose(value: string): Promise<void> {
    if (value === FOLLOW) return save(null);
    const row = JSON.parse(value) as { provider_id?: string; runner?: BotRunner; model: string; custom_id?: string };
    if (row.runner) {
      const customId = row.custom_id ?? null;
      // The account carries over to another model of the same agent; a different agent starts on this computer's default.
      const agent = chosenAgent();
      const account = agent && sameAgent(agent, row.runner, customId) ? pickedAccount() : "";
      return save({ runner: row.runner, model: row.model, config_dir: account || null, ...(customId ? { custom_id: customId } : {}) });
    }
    return save({ provider_id: row.provider_id!, model: row.model });
  }

  function chooseAccount(value: string): Promise<void> {
    pickedAccount.set(value);
    const agent = chosenAgent();
    return agent ? save({ ...agent, config_dir: value || null }) : Promise.resolve();
  }

  const noteClass = "text-[12px] leading-[1.45] text-ink-muted";
  return (
    <View
      testID={`side-model-${props.kind}`}
      role="region"
      accessibilityLabel={props.title}
      class={`flex-col gap-[10px] min-w-0 ${framed() ? `bg-pane border border-line rounded-(--radius-md) ${phone() ? "p-3" : "px-[14px] py-3"}` : ""}`}
      style={{ boxShadow: framed() && !phone() ? shadow("xs") : undefined }}
    >
      <If when={failed()}>
        <Text role="alert" testID="side-model-error" class="text-[12px] text-danger-text">
          {props.failed}
        </Text>
      </If>
      <View class={phone() ? "" : "max-w-[320px]"}>
        <ModelPicker
          testID="side-model-picker"
          value={props.chosen ? key(props.chosen) : FOLLOW}
          data={data()}
          size="sm"
          title={props.title}
          ariaLabel={props.title}
          disabled={busy()}
          onChange={(value) => void choose(value)}
        />
      </View>
      {/* Only where an agent's model is chosen: nine rows of the same account picker say nothing. */}
      <If when={chosenAgent()}>
        {() => {
          const accountLabel = () => (claudeChosen() ? copy().sidebar.botAgentAccount : copy().sidebar.botAgentAccountOf(chosenLabel()));
          return (
            <>
              <If when={chosenAccounts().count > 1}>
                <View testID="side-model-account" class={`flex-col gap-1 ${phone() ? "" : "max-w-[320px]"}`}>
                  <Text class={noteClass}>{accountLabel()}</Text>
                  <Select value={pickedAccount()} options={chosenAccounts().options} size="sm" ariaLabel={accountLabel()} disabled={busy()} onChange={(value) => void chooseAccount(value)} />
                </View>
              </If>
              <If
                when={claudeChosen()}
                else={
                  <Text testID="side-model-agent-note" class={noteClass}>
                    {copy().builtinModels.agentNote(chosenLabel())}
                  </Text>
                }
              >
                <Text testID="side-model-claude-note" class={noteClass}>
                  {props.claude?.note}
                </Text>
              </If>
            </>
          );
        }}
      </If>
    </View>
  );
}
