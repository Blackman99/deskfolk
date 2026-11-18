/**
 * What runs a Bot, its model and thinking level, picked in its direct's composer (`BotTune.svelte`,
 * `bot-tune.ts`). They are the Bot's own, the ones its profile sets: a pick holds wherever it works.
 * The picker starts at what runs it, as the Bot panel's 运行方式 does (the app on your endpoints, or
 * one of your local agents); under the app it goes endpoint, model, level, under an agent the
 * agent's own picker (`agentTuneTree`), with your Claude accounts when there is a second one. A pick
 * under another runner moves the Bot onto it (`bot-tune-tree.ts`).
 */
import { effect, untracked } from "nsh";
import { isBotRunner, type Bot, type PatchBotRequest } from "@real-bot/protocol";
import { loadClaudeModels } from "../../m/claude-models.svelte";
import { agentsStatus, claudeStatus, loadAgentsStatus, loadClaudeStatus } from "../../m/chat/project-agent-options.svelte";
import { copy, runtime } from "../../runtime";
import { botTuneLabels, botTuneTree, type BotTuneSource } from "./bot-tune-tree";
import { TunePicker } from "./TunePicker";

export function BotTune(props: { bot: Bot; disabled: boolean; onPick: (change: PatchBotRequest) => void }) {
  const runner = () => (props.bot.runner && isBotRunner(props.bot.runner) ? props.bot.runner : null);
  const account = () => props.bot.agent_config_dir ?? "";

  /**
   * What the picker lists, asked for unless it was had a moment ago: the first column lists every
   * agent, and Claude's accounts sit under Claude Agent, whatever runs the Bot.
   */
  function askOptions(): void {
    const api = runtime.client;
    loadAgentsStatus(api);
    loadClaudeStatus(api);
    if (runner() === "claude_code") loadClaudeModels(api, account() || null);
  }
  // Asked as the composer shows and again as the picker opens; untracked, so what the asking
  // writes does not ask again.
  effect(() => {
    void runtime.client;
    void runner();
    void account();
    untracked(askOptions);
  });

  const source: BotTuneSource = {
    get t() {
      return copy();
    },
    get bot() {
      return props.bot;
    },
    get providers() {
      return runtime.snapshot.providers;
    },
    get agents() {
      return agentsStatus();
    },
    get claude() {
      return claudeStatus();
    },
    get client() {
      return runtime.client;
    },
    onpick: (change) => props.onPick(change),
  };
  const tree = botTuneTree(source);
  const shown = () => botTuneLabels(source);

  return (
    <TunePicker
      tree={tree}
      label={copy().composer.tuneLabel}
      mark={shown().mark}
      value={shown().value}
      level={shown().level}
      aside={shown().aside}
      title={shown().title}
      sheetTitle={props.bot.name}
      disabled={props.disabled}
      onOpen={() => untracked(askOptions)}
      testID="bot-tune"
    />
  );
}
