/**
 * A Bot's model and thinking level, picked in its direct's composer as a project session's are
 * (`BotTune.svelte`, `bot-tune.ts`). They are the Bot's own, the ones its profile sets: a pick
 * holds wherever it works. On the app's own loop the picker goes endpoint, model, level; on a local
 * agent it is the agent's picker (`AgentTune`), with your Claude accounts when there is a second one.
 */
import { effect, untracked } from "nsh";
import { isBotRunner, type Bot, type PatchBotRequest } from "@real-bot/protocol";
import { loadClaudeModels } from "../../m/claude-models.svelte";
import { endpointSource } from "../../m/model-source";
import { agentLabelOf, agentStatusOf } from "../../m/runner-choice";
import { agentBotPatch, agentTuneModels, endpointTuneLabels, endpointTuneTree } from "../../m/chat/bot-tune";
import { accountChoices, agentsStatus, claudeStatus, loadAgentsStatus, loadClaudeStatus } from "../../m/chat/project-agent-options.svelte";
import { copy, runtime } from "../../runtime";
import { AgentTune } from "./AgentTune";
import { TunePicker } from "./TunePicker";

export function BotTune(props: { bot: Bot; disabled: boolean; onPick: (change: PatchBotRequest) => void }) {
  const runner = () => (props.bot.runner && isBotRunner(props.bot.runner) ? props.bot.runner : null);
  const customId = () => props.bot.agent_custom_id ?? null;
  const account = () => props.bot.agent_config_dir ?? "";

  // Asked once each a page; untracked, so what the asking writes does not ask again.
  effect(() => {
    const api = runtime.client;
    const on = runner();
    const dir = account() || null;
    untracked(() => {
      if (on === "claude_code") {
        loadClaudeStatus(api);
        loadClaudeModels(api, dir);
      } else if (on) {
        loadAgentsStatus(api);
      }
    });
  });

  const accountOptions = () => accountChoices(claudeStatus(), account(), copy().project.defaultAccount);
  /** Picked only with a second account to pick, and never from a daemon that has no accounts for a Bot. */
  const accountShown = () => runner() === "claude_code" && props.bot.agent_config_dir !== undefined && accountOptions().length > 1;
  const agentName = () => (runner() === "claude_code" ? copy().project.agentNames.claude_code : runner() ? agentLabelOf(runner()!, customId(), agentsStatus()) : "");
  /** Any agent but Claude: the models it lists, each with the levels it takes. */
  const agentModels = () => {
    const on = runner();
    return on && on !== "claude_code" ? agentTuneModels(agentStatusOf(agentsStatus(), on, customId()), on, props.bot.agent_model ?? "", copy().project.modelDefault) : undefined;
  };

  const tree = endpointTuneTree({
    get t() {
      return copy();
    },
    get bot() {
      return props.bot;
    },
    get providers() {
      return runtime.snapshot.providers;
    },
    onpick: (change) => props.onPick(change),
  });
  const shown = () => endpointTuneLabels(copy(), props.bot, runtime.snapshot.providers);

  return (
    <If
      when={runner()}
      else={
        <TunePicker
          tree={tree}
          label={copy().composer.tuneLabel}
          mark={shown().endpoint ? endpointSource(shown().endpoint!, copy()) : null}
          value={shown().value}
          level={shown().level}
          aside={shown().aside}
          title={shown().title}
          sheetTitle={props.bot.name}
          disabled={props.disabled}
          testID="bot-tune"
        />
      }
    >
      {(on) => (
        <AgentTune
          agent={on()}
          agentName={agentName()}
          tune={{ account: account(), model: props.bot.agent_model ?? "", effort: props.bot.agent_effort ?? "" }}
          models={agentModels()}
          accounts={accountShown() ? accountOptions() : null}
          accountLocked={false}
          disabled={props.disabled}
          client={runtime.client}
          onPick={(change) => props.onPick(agentBotPatch(change))}
          testID="bot-tune"
        />
      )}
    </If>
  );
}
