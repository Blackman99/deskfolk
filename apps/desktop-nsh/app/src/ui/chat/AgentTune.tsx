/**
 * An agent's account, model and thinking level in the composer's cascading picker (`TunePicker`):
 * the accounts, each account's models, each model's levels (`AgentTune.svelte`). A project
 * session's (ADR 0095). With no account to pick (Codex, ADR 0099, any agent but Claude) the picker
 * starts at the models. What it lists and does is `agentTuneTree`'s, which a Bot's picker
 * (`BotTune`) also puts under each local agent.
 */
import type { BotRunner, ClaudeCodeModel, PatchProjectSessionRequest } from "@real-bot/protocol";
import type { Choice } from "../../m/claude-models.svelte";
import type { MessengerApi } from "../../m/messenger-api";
import { runnerSource } from "../../m/model-source";
import type { AgentTune as Tune } from "../../m/chat/project-agent-tune";
import { copy } from "../../runtime";
import { agentTuneLabels, agentTuneTree, type AgentTuneSource } from "./agent-tune-tree";
import { TunePicker, type ShownTuneHandle } from "./TunePicker";

export function AgentTune(props: {
  /** Whose runs they are: its mark on the picker. */
  agent: BotRunner;
  /** Its name: the phone sheet's heading, and what "your settings" are of. */
  agentName: string;
  tune: Tune;
  /** The agent's own models when it is not Claude Code (as it lists them); left out, Claude Code's for the account. */
  models?: ClaudeCodeModel[];
  /** Your accounts, with a second one to pick; null leaves the account out. */
  accounts: Choice[] | null;
  /** A run is going: the account waits for it to end. */
  accountLocked: boolean;
  disabled: boolean;
  client: Pick<MessengerApi, "claudeCodeModels"> | null;
  onPick: (change: PatchProjectSessionRequest) => void;
  /** Called as the picker opens, to ask again for the accounts and models it lists. */
  onOpen?: () => void;
  /** The phone's: no closed picker, only its sheet, opened (and read) through `onHandle` from the composer's +. */
  bare?: boolean;
  onHandle?: (handle: ShownTuneHandle | null) => void;
  testID?: string;
}) {
  const source: AgentTuneSource = {
    get t() {
      return copy();
    },
    get agentName() {
      return props.agentName;
    },
    get tune() {
      return props.tune;
    },
    get models() {
      return props.models;
    },
    get accounts() {
      return props.accounts;
    },
    get accountLocked() {
      return props.accountLocked;
    },
    get client() {
      return props.client;
    },
    onPick: (change) => props.onPick(change),
  };
  const tree = agentTuneTree(source);
  const shown = () => agentTuneLabels(source);
  const mark = () => runnerSource(props.agent, props.agentName, copy());

  return (
    <TunePicker
      tree={tree}
      label={copy().project.tuneLabel}
      mark={mark()}
      value={shown().value}
      level={shown().level}
      aside={shown().aside}
      title={shown().title}
      sheetTitle={props.agentName}
      disabled={props.disabled}
      onOpen={props.onOpen}
      bare={props.bare}
      onHandle={props.onHandle ? (handle) => props.onHandle?.(handle && { open: handle.open, shown: () => ({ mark: mark(), ...shown() }) }) : undefined}
      testID={props.testID ?? "agent-tune"}
    />
  );
}
