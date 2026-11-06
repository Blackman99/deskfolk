/**
 * An agent's account, model and thinking level in the composer's cascading picker (`TunePicker`):
 * the accounts, each account's models, each model's levels (`AgentTune.svelte`). A project session's
 * (ADR 0095), and a Bot's on a local agent in its direct (`BotTune`). With no account to pick (Codex,
 * ADR 0099, any agent but Claude) the picker starts at the models.
 */
import type { BotRunner, ClaudeCodeModel, PatchProjectSessionRequest } from "@real-bot/protocol";
import { claudeModelsOf, loadClaudeModels, modelChoices, modelRowOf, type Choice } from "../../m/claude-models.svelte";
import type { MessengerApi } from "../../m/messenger-api";
import { runnerSource } from "../../m/model-source";
import { effortOn, effortRows, effortsShown, modelRows, tunePatch, type AgentTune as Tune } from "../../m/chat/project-agent-tune";
import type { TuneFocus, TuneLevel, TuneRow, TuneTree } from "../../m/chat/tune-picker";
import { copy } from "../../runtime";
import { TunePicker } from "./TunePicker";

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
  testID?: string;
}) {
  const p = () => copy().project;
  /** Each column's width, so the field can keep room for every column that may open beside the first. */
  const account = (): TuneLevel => ({ key: "account", heading: p().accountLabel, width: 264, note: props.accountLocked ? p().accountBusy : null });
  const model = (): TuneLevel => ({ key: "model", heading: p().modelLabel, width: 290, details: true });
  const effort = (): TuneLevel => ({ key: "effort", heading: p().effortLabel, width: 140, leaf: true });

  /** The models an account lists. */
  const listOf = (acct: string | undefined) => props.models ?? claudeModelsOf(acct || null);
  /** The level the session keeps on a model: its own on its own model, else its own only if that model takes it. */
  const keptOn = (list: ClaudeCodeModel[] | null, modelId: string) => (modelId === props.tune.model ? props.tune.effort : effortOn(list, modelId, props.tune.effort));

  const modelRowsAt = (focus: TuneFocus): TuneRow[] => modelRows(listOf(focus.account), props.tune.model, p().modelDefault, p().modelDefaultHint(props.agentName));

  /** Whether a model has levels beside it: one that takes none has none, unless the session keeps one. */
  function takesLevels(focus: TuneFocus, modelId: string): boolean {
    const list = listOf(focus.account);
    return effortsShown(list, modelId, keptOn(list, modelId));
  }

  const tree: TuneTree = {
    start: () => ({ account: props.tune.account, model: props.tune.model, effort: props.tune.effort }),
    levels: (focus) => [props.accounts ? account() : null, model(), takesLevels(focus, focus.model ?? "") ? effort() : null].filter((level): level is TuneLevel => level !== null),
    // Another account's models may take levels, so with accounts the levels count too.
    room: (focus) =>
      [props.accounts ? account() : null, model(), props.accounts || modelRowsAt(focus).some((row) => takesLevels(focus, row.value)) ? effort() : null].filter(
        (level): level is TuneLevel => level !== null,
      ),
    rows: (level, focus) => {
      if (level === "account") return (props.accounts ?? []).map((row): TuneRow => ({ ...row, disabled: props.accountLocked && row.value !== props.tune.account }));
      if (level === "model") return modelRowsAt(focus);
      const list = listOf(focus.account);
      const modelId = focus.model ?? "";
      return effortRows(list, modelId, keptOn(list, modelId), p().effortDefault, copy().sidebar.thinkingLevels);
    },
    checked: (level, focus) => (level === "account" ? props.tune.account : level === "model" ? props.tune.model : keptOn(listOf(focus.account), focus.model ?? "")),
    // Every account has its models; a model the levels it takes.
    opensMore: (level, value, focus) => level === "account" || (level === "model" && takesLevels(focus, value)),
    focusAt: (level, value, focus) => {
      if (level === "account") {
        if (value === focus.account) return focus;
        loadClaudeModels(props.client, value || null);
        return { account: value, model: props.tune.model, effort: props.tune.effort };
      }
      if (level === "model") return { ...focus, model: value, effort: keptOn(listOf(focus.account), value) };
      return value === focus.effort ? focus : { ...focus, effort: value };
    },
    commit: (level, focus) => {
      const acct = focus.account ?? "";
      const picked = level === "account" ? { account: acct } : level === "model" ? { account: acct, model: focus.model ?? "" } : { account: acct, model: focus.model ?? "", effort: focus.effort ?? "" };
      const change = tunePatch(props.tune, picked, listOf(acct));
      if (change) props.onPick(change);
    },
  };

  // What the closed picker says: the model and its level; the account after them, quieter, cut first.
  const nowList = () => listOf(props.tune.account);
  const modelLabel = () => modelChoices(nowList(), props.tune.model, p().modelDefault).find((row) => row.value === props.tune.model)?.label ?? props.tune.model;
  const modelNote = () => modelRowOf(nowList(), props.tune.model)?.description || (props.tune.model ? undefined : p().modelDefaultHint(props.agentName));
  const effortShown = () => effortsShown(nowList(), props.tune.model, props.tune.effort);
  const effortLabel = () =>
    props.tune.effort ? (copy().sidebar.thinkingLevels[props.tune.effort as keyof ReturnType<typeof copy>["sidebar"]["thinkingLevels"]] ?? props.tune.effort) : p().effortDefault;
  const accountLabel = () => props.accounts?.find((row) => row.value === props.tune.account)?.label ?? null;
  const triggerTitle = () => [accountLabel(), modelNote() ? `${modelLabel()} · ${modelNote()}` : modelLabel(), effortShown() ? effortLabel() : null].filter(Boolean).join("\n");

  return (
    <TunePicker
      tree={tree}
      label={p().tuneLabel}
      mark={runnerSource(props.agent, props.agentName, copy())}
      value={modelLabel()}
      level={effortShown() ? effortLabel() : null}
      aside={accountLabel()}
      title={triggerTitle()}
      sheetTitle={props.agentName}
      disabled={props.disabled}
      testID={props.testID ?? "agent-tune"}
    />
  );
}
