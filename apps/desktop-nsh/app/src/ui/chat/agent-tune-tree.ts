/**
 * What an agent's cascading picker lists and does (`AgentTune`): the accounts, each account's
 * models, each model's levels. Out of the component so a Bot's picker (`bot-tune-tree.ts`) can put
 * the same levels under each local agent in its first column. Every input is read when the picker
 * asks, so pass getters for what changes.
 */
import type { ClaudeCodeModel, PatchProjectSessionRequest } from "@real-bot/protocol";
import { claudeModelsOf, loadClaudeModels, modelChoices, modelRowOf, type Choice } from "../../m/claude-models.svelte";
import type { MessengerApi } from "../../m/messenger-api";
import { effortOn, effortRows, effortsShown, modelRows, tunePatch, type AgentTune as Tune } from "../../m/chat/project-agent-tune";
import type { TuneFocus, TuneLevel, TuneRow, TuneTree } from "../../m/chat/tune-picker";
import type { Copy } from "../../m/copy";

export type AgentTuneSource = {
  readonly t: Copy;
  /** The agent's name: what "your settings" are of. */
  readonly agentName: string;
  /** What the conversation runs on now; all '' for the agent's own settings. */
  readonly tune: Tune;
  /** The agent's own models when it is not Claude Code (as it lists them); left out, Claude Code's for the account. */
  readonly models?: ClaudeCodeModel[];
  /** Your accounts, with a second one to pick; null leaves the account out. */
  readonly accounts: Choice[] | null;
  /** A run is going: the account waits for it to end. */
  readonly accountLocked: boolean;
  readonly client: Pick<MessengerApi, "claudeCodeModels"> | null;
  onPick(change: PatchProjectSessionRequest): void;
};

export function agentTuneTree(source: AgentTuneSource): TuneTree {
  const p = () => source.t.project;
  /** Each column's width, so the field can keep room for every column that may open beside the first. */
  const account = (): TuneLevel => ({ key: "account", heading: p().accountLabel, width: 264, note: source.accountLocked ? p().accountBusy : null });
  const model = (): TuneLevel => ({ key: "model", heading: p().modelLabel, width: 290, details: true });
  const effort = (): TuneLevel => ({ key: "effort", heading: p().effortLabel, width: 140, leaf: true });

  /** The models an account lists. */
  const listOf = (acct: string | undefined) => source.models ?? claudeModelsOf(acct || null);
  /** The level the session keeps on a model: its own on its own model, else its own only if that model takes it. */
  const keptOn = (list: ClaudeCodeModel[] | null, modelId: string) => (modelId === source.tune.model ? source.tune.effort : effortOn(list, modelId, source.tune.effort));

  const modelRowsAt = (focus: TuneFocus): TuneRow[] => modelRows(listOf(focus.account), source.tune.model, p().modelDefault, p().modelDefaultHint(source.agentName));

  /** Whether a model has levels beside it: one that takes none has none, unless the session keeps one. */
  function takesLevels(focus: TuneFocus, modelId: string): boolean {
    const list = listOf(focus.account);
    return effortsShown(list, modelId, keptOn(list, modelId));
  }

  return {
    start: () => ({ account: source.tune.account, model: source.tune.model, effort: source.tune.effort }),
    levels: (focus) => [source.accounts ? account() : null, model(), takesLevels(focus, focus.model ?? "") ? effort() : null].filter((level): level is TuneLevel => level !== null),
    // Another account's models may take levels, so with accounts the levels count too.
    room: (focus) =>
      [source.accounts ? account() : null, model(), source.accounts || modelRowsAt(focus).some((row) => takesLevels(focus, row.value)) ? effort() : null].filter(
        (level): level is TuneLevel => level !== null,
      ),
    rows: (level, focus) => {
      if (level === "account") return (source.accounts ?? []).map((row): TuneRow => ({ ...row, disabled: source.accountLocked && row.value !== source.tune.account }));
      if (level === "model") return modelRowsAt(focus);
      const list = listOf(focus.account);
      const modelId = focus.model ?? "";
      return effortRows(list, modelId, keptOn(list, modelId), p().effortDefault, source.t.sidebar.thinkingLevels);
    },
    checked: (level, focus) => (level === "account" ? source.tune.account : level === "model" ? source.tune.model : keptOn(listOf(focus.account), focus.model ?? "")),
    // Every account has its models; a model the levels it takes.
    opensMore: (level, value, focus) => level === "account" || (level === "model" && takesLevels(focus, value)),
    focusAt: (level, value, focus) => {
      if (level === "account") {
        if (value === focus.account) return focus;
        loadClaudeModels(source.client, value || null);
        return { account: value, model: source.tune.model, effort: source.tune.effort };
      }
      if (level === "model") return { ...focus, model: value, effort: keptOn(listOf(focus.account), value) };
      return value === focus.effort ? focus : { ...focus, effort: value };
    },
    commit: (level, focus) => {
      const acct = focus.account ?? "";
      const picked = level === "account" ? { account: acct } : level === "model" ? { account: acct, model: focus.model ?? "" } : { account: acct, model: focus.model ?? "", effort: focus.effort ?? "" };
      const change = tunePatch(source.tune, picked, listOf(acct));
      if (change) source.onPick(change);
    },
  };
}

/** What the closed picker says: the model and its level; the account after them, quieter, cut first. */
export function agentTuneLabels(source: Pick<AgentTuneSource, "t" | "agentName" | "tune" | "models" | "accounts">): {
  value: string;
  level: string | null;
  aside: string | null;
  title: string;
} {
  const p = source.t.project;
  const list = source.models ?? claudeModelsOf(source.tune.account || null);
  const modelLabel = modelChoices(list, source.tune.model, p.modelDefault).find((row) => row.value === source.tune.model)?.label ?? source.tune.model;
  const modelNote = modelRowOf(list, source.tune.model)?.description || (source.tune.model ? undefined : p.modelDefaultHint(source.agentName));
  const effortShown = effortsShown(list, source.tune.model, source.tune.effort);
  const effortLabel = source.tune.effort
    ? (source.t.sidebar.thinkingLevels[source.tune.effort as keyof Copy["sidebar"]["thinkingLevels"]] ?? source.tune.effort)
    : p.effortDefault;
  const accountLabel = source.accounts?.find((row) => row.value === source.tune.account)?.label ?? null;
  return {
    value: modelLabel,
    level: effortShown ? effortLabel : null,
    aside: accountLabel,
    title: [accountLabel, modelNote ? `${modelLabel} · ${modelNote}` : modelLabel, effortShown ? effortLabel : null].filter(Boolean).join("\n"),
  };
}
