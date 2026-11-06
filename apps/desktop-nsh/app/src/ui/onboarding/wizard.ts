/**
 * The first-run wizard's state and what its buttons do (the `<script>` of `Onboarding.svelte`): the
 * step, the way setup reaches a model (an endpoint, or Claude Code or another local agent), the
 * endpoint's form and its model list, the save, and the last step's hold. The views
 * (`Onboarding.tsx`, `StepBar.tsx`, `ProviderStep.tsx`, `AgentStep.tsx`, `ModelsStep.tsx`,
 * `StartStep.tsx`) only read it and call it.
 */
import { cleanup, computed, effect, signal, untracked } from "nsh";
import {
  BUILTIN_MODEL_ROLES,
  connectorById,
  connectorFor,
  isLocalEndpoint,
  type AgentsStatusResponse,
  type ApiFormat,
  type ClaudeCodeSessionListing,
  type ClaudeCodeStatus,
  type CreateProviderRequest,
  type ProbedModel,
} from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { claudeModelOptions, claudeModelsOf, loadClaudeModels } from "../../m/claude-models.svelte.ts";
import { groupModels, type PickerData } from "../../m/model-picker.ts";
import { agentPickerSources, claudePickerSource } from "../../m/model-picker-sources.ts";
import { endpointSource } from "../../m/model-source.ts";
import type { CreateBotDraft } from "../../m/panels/create-form.ts";
import { agentLabelOf, agentModelsOf, agentReady, agentStatusOf, parseRunnerValue, runnerValueOf } from "../../m/runner-choice.ts";
import { claudeAccountOptions, claudeReady } from "../../m/settings/claude-agent.ts";
import { asksForWorkspace, planOrder, searchPlans } from "../../m/settings/connector-detect.ts";
import {
  applyProbedModels,
  emptyProviderDraft,
  mapProviderError,
  planCreateProvider,
  type ProviderFieldErrors,
} from "../../m/settings/provider-form.ts";
import { mapSettingsError, parseModelLines, planWorkspaceSave, type FieldErrorKind, type SettingsFieldErrors } from "../../m/settings/wizard-save.ts";
import type { TeamStepApi } from "./TeamStep";
import { PRESETS, LOCAL_PRESETS, type Preset } from "./presets";

export type Step = 1 | 2 | 3 | 4;
export type FieldErrors = SettingsFieldErrors & ProviderFieldErrors;

export type WizardProps = {
  /** The wizard asking to stay up (see `Onboarding`'s `holding`). */
  onHoldingChange?: (holding: boolean) => void;
};

export function fieldCopy(kind: FieldErrorKind | undefined, empty: string, invalid: string): string {
  return kind === "empty" ? empty : kind === "invalid" ? invalid : "";
}

export function createWizard(props: WizardProps) {
  const t = () => copy();
  const workspaceReadOnly = () => runtime.hosted || runtime.remote;

  const step = signal<Step>(1);
  /** Nobody on the roster yet: saving setup leads on to the first Bot instead of into the app. */
  const rosterEmpty = () => runtime.snapshot.bots.every((bot) => bot.archived_at);
  /** Setup is saved and behind the user; its steps no longer open. */
  const setupSaved = () => step() === 4;
  const showBotStep = () => rosterEmpty() || setupSaved();
  effect(() => {
    if (workspaceReadOnly() && step() === 1) step.set(2);
  });

  /** How setup reaches a model (ADR 0078): an endpoint, or the Claude Code on this computer alone. */
  const connectMode = signal<"endpoint" | "claude">("endpoint");
  const claudeStatus = signal<ClaudeCodeStatus | null>(null);
  const claudeModel = signal("sonnet");
  /** A listed account's config directory; `""` the daemon's own environment. */
  const claudeConfigDir = signal("");
  /** Which local agent setup runs on (ADR 0078, ADR 0079): Claude Code, or `codex`, `custom:<id>`, … */
  const agentPick = signal("claude_code");
  const otherAgents = signal<AgentsStatusResponse | null>(null);
  const agentModel = signal("");
  const picked = () => parseRunnerValue(agentPick());
  const pickedOther = () => (picked().runner && picked().runner !== "claude_code" ? picked().runner : null);
  const pickedStatus = () => {
    const other = pickedOther();
    return other ? agentStatusOf(otherAgents(), other, picked().customId) : null;
  };
  const pickedLabel = () => {
    const other = pickedOther();
    return other ? agentLabelOf(other, picked().customId, otherAgents()) : "Claude Code";
  };
  const pickedModels = () => agentModelsOf(pickedStatus());
  /** The agents beside Claude Code that setup can run on: found and not signed out. */
  const readyAgents = () => (otherAgents()?.items ?? []).filter((status) => agentReady(status));
  const claudeOk = () => (pickedOther() ? agentReady(pickedStatus()) : claudeReady(claudeStatus()));

  effect(() => {
    if (connectMode() !== "claude" || otherAgents()) return;
    const client = runtime.client as { agents?: () => Promise<AgentsStatusResponse> } | null;
    if (!client?.agents) return;
    void client.agents().then((list) => otherAgents.set(list), () => undefined);
  });
  effect(() => {
    // A model to start from: the one the agent runs on by default, else the first it lists.
    const status = pickedStatus();
    if (!status || agentModel()) return;
    agentModel.set(status.default_model ?? status.models[0]?.id ?? "");
  });
  /** Claude Code's models for the account picked, asked for once that way is chosen. */
  effect(() => {
    const api = runtime.client;
    const dir = claudeConfigDir() || null;
    if (connectMode() === "claude") untracked(() => loadClaudeModels(api, dir));
  });
  const claudeModelData = (): PickerData => ({
    specials: [],
    sources: [claudePickerSource(t(), (model) => model, claudeModelOptions(claudeModelsOf(claudeConfigDir() || null)))],
  });
  /** The picked agent's models, one source: what it lists, else its default, and a name typed as it spells it. */
  const agentModelData = (): PickerData => {
    const other = pickedOther();
    const status = pickedStatus();
    if (!other || !status) return { specials: [], sources: [] };
    const offered = { items: [{ ...status, models: pickedModels() }], custom_agents: otherAgents()?.custom_agents ?? [] };
    return {
      specials: [],
      sources: agentPickerSources(offered, t(), (_runner, model) => model, { only: { runner: other, customId: picked().customId }, typed: true }),
    };
  };
  const claudeAccounts = () => claudeAccountOptions(claudeStatus(), claudeConfigDir(), t());

  const fieldErrors = signal<FieldErrors>({});
  const saveFailed = signal(false);
  const providerName = signal("Default");
  const apiFormat = signal<ApiFormat>("openai");
  /** Anthropic's `wrkspc_…` for a key not scoped to one workspace (ADR 0072); empty for none. */
  const anthropicWorkspace = signal("");
  const activePreset = signal("");
  const fetchingModels = signal(false);
  const fetchError = signal<string | null>(null);
  /** What the endpoint actually returned; saved with the endpoint so Settings can show it again. */
  const probedModels = signal<string[]>([]);
  const probedCatalog = signal<ProbedModel[]>([]);
  /** The models to tick: what the endpoint listed, what a preset knows, and what you added. */
  const availableDiscoveredModels = signal<string[]>([]);
  const modelFilterQuery = signal("");
  const showManualModelEdit = signal(false);
  const customModelInput = signal("");

  const clearError = (...keys: (keyof FieldErrors)[]) => {
    const next = { ...fieldErrors() };
    for (const key of keys) delete next[key];
    fieldErrors.set(next);
  };

  const workspacePlan = () => planWorkspaceSave(runtime.workspacePath);
  const connectionPlan = () =>
    planCreateProvider(
      {
        ...emptyProviderDraft(),
        name: providerName(),
        baseUrl: runtime.endpointUrl,
        apiFormat: apiFormat(),
        workspaceId: anthropicWorkspace(),
        apiKey: runtime.endpointKey.trim(),
      },
      true,
    );
  const selectedModels = () => parseModelLines(runtime.endpointModelsText);
  /** The default model's picker: the models chosen above, one source, marked with the endpoint being set up. */
  const defaultModelData = (): PickerData => ({
    specials: [],
    sources: [
      {
        key: "endpoint",
        label: providerName().trim() || t().settings.defaultModel,
        mark: endpointSource({ base_url: runtime.endpointUrl, api_format: apiFormat() }, t()),
        groups: groupModels(selectedModels().map((model) => ({ value: model, label: model }))),
      },
    ],
  });
  const defaultModel = () => runtime.endpointDefaultModel.trim();
  const modelErrors = computed(() => {
    const errors: ProviderFieldErrors = {};
    const selected = selectedModels();
    if (selected.length === 0) errors.models = "empty";
    if (!defaultModel()) errors.defaultModel = "empty";
    else if (selected.length > 0 && !selected.includes(defaultModel())) errors.defaultModel = "invalid";
    return errors;
  });
  const canCompleteSetup = () =>
    (workspaceReadOnly() || workspacePlan().ok) &&
    (connectMode() === "claude"
      ? claudeOk() && (!pickedOther() || agentModel().trim().length > 0)
      : connectionPlan().ok && !modelErrors().models && !modelErrors().defaultModel);
  const allKnownModels = () => Array.from(new Set([...selectedModels(), ...availableDiscoveredModels()]));
  const filteredModels = () => {
    const query = modelFilterQuery().trim().toLowerCase();
    return query ? allKnownModels().filter((model) => model.toLowerCase().includes(query)) : allKnownModels();
  };
  /** A model server on this computer or network: no key needed, and the list can be read without one. */
  const keyless = () => isLocalEndpoint(runtime.endpointUrl);

  function applyPreset(preset: Preset): void {
    activePreset.set(preset.id);
    if (preset.format) apiFormat.set(preset.format);
    if (preset.id !== "custom") {
      const connector = connectorById(preset.id);
      providerName.set(connector ? t().connectors.name[connector.id] : preset.name);
      runtime.endpointUrl = preset.url;
      availableDiscoveredModels.set(Array.from(new Set([...preset.models, ...availableDiscoveredModels()])));
      runtime.endpointModelsText = preset.models.join("\n");
      runtime.endpointDefaultModel = preset.defaultModel;
      if (LOCAL_PRESETS.has(preset.id)) runtime.endpointKey = "";
    } else {
      providerName.set(t().onboarding.presetCustom);
    }
    clearError("name", "endpoint", "models", "defaultModel");
    if (runtime.endpointUrl && (runtime.endpointKey || isLocalEndpoint(runtime.endpointUrl))) void fetchModels();
  }

  let autoFetchTimer: ReturnType<typeof setTimeout> | null = null;
  cleanup(() => autoFetchTimer && clearTimeout(autoFetchTimer));
  function onEndpointOrKeyInput(): void {
    clearError("endpoint", "endpointKey");
    if (autoFetchTimer) clearTimeout(autoFetchTimer);
    if (runtime.endpointUrl.trim().startsWith("http") && (runtime.endpointKey.trim() || isLocalEndpoint(runtime.endpointUrl))) {
      autoFetchTimer = setTimeout(() => void fetchModels(), 700);
    }
  }

  async function fetchModels(): Promise<void> {
    const baseUrl = runtime.endpointUrl.trim();
    const apiKey = runtime.endpointKey.trim();
    if (!baseUrl) {
      fetchError.set(t().settings.endpointEmpty);
      return;
    }
    fetchingModels.set(true);
    fetchError.set(null);
    const workspaceId = anthropicWorkspace().trim() || null;
    const connector = connectorById(activePreset());
    let res: Awaited<ReturnType<typeof runtime.probeModels>>;
    if (connector && connector.plans.length > 1 && connectorFor(baseUrl, apiFormat())?.connector.id === connector.id) {
      // A connector preset's key is tried on each of its plans (ADR 0072); the one taking it is kept.
      const outcome = await searchPlans(
        planOrder(connector, baseUrl),
        (plan) => runtime.probeModels(plan.baseUrl, apiKey, undefined, connector.apiFormat),
        () => runtime.endpointKey.trim() === apiKey && activePreset() === connector.id,
      );
      if (outcome.kind === "stale") {
        fetchingModels.set(false);
        return;
      }
      if (outcome.kind === "found") runtime.endpointUrl = outcome.plan.baseUrl;
      res = outcome.kind === "found" ? outcome.result : outcome.kind === "refused" ? { ok: false, error: "", status: 401 } : { ok: false, error: outcome.error };
      if (outcome.kind === "refused") {
        fetchingModels.set(false);
        fetchError.set(
          t().connectors.keyRefused(
            t().connectors.name[connector.id],
            connector.plans.map((plan) => t().connectors.plan[`${connector.id}:${plan.id}` as keyof ReturnType<typeof t>["connectors"]["plan"]] ?? plan.id).join(t().connectors.listSeparator),
          ),
        );
        return;
      }
    } else {
      res = await runtime.probeModels(baseUrl, apiKey, undefined, apiFormat() === "anthropic" ? apiFormat() : undefined, workspaceId);
    }
    fetchingModels.set(false);
    if (!res.ok) {
      fetchError.set(
        connectorFor(baseUrl, apiFormat())?.connector.workspace && asksForWorkspace(res.error)
          ? t().connectors.workspaceNeeded
          : `${t().settings.modelsFetchFailed} (${res.error})`,
      );
      return;
    }
    if (res.models.length > 0) {
      probedModels.set(res.models);
      probedCatalog.set(res.catalog ?? []);
      availableDiscoveredModels.set(res.models);
      const matching = parseModelLines(runtime.endpointModelsText).filter((model) => res.models.includes(model));
      const nextSelected = matching.length > 0 ? matching : res.models.slice(0, 3);
      runtime.endpointModelsText = nextSelected.join("\n");
      if (!nextSelected.includes(runtime.endpointDefaultModel)) runtime.endpointDefaultModel = nextSelected[0] ?? "";
    }
  }

  function advanceFromStep1(): void {
    const plan = workspacePlan();
    if (!plan.ok) {
      fieldErrors.set({ ...fieldErrors(), workspace: plan.error });
      return;
    }
    clearError("workspace");
    step.set(2);
  }

  function validateConnection(): boolean {
    const plan = connectionPlan();
    const errs = { ...fieldErrors() };
    delete errs.name;
    delete errs.endpoint;
    delete errs.endpointKey;
    delete errs.anthropicWorkspace;
    fieldErrors.set(plan.ok ? errs : { ...errs, ...plan.errors });
    return plan.ok;
  }

  function advanceFromStep2(): void {
    if (connectMode() === "claude") {
      if (claudeOk()) step.set(3);
      return;
    }
    if (!validateConnection()) return;
    step.set(3);
    if (availableDiscoveredModels().length <= 6 && runtime.endpointUrl && (runtime.endpointKey || keyless())) void fetchModels();
  }

  function goToStep(target: 1 | 2 | 3): void {
    if (setupSaved()) return;
    if (workspaceReadOnly() && target === 1) target = 2;
    if (target <= step()) {
      step.set(target);
      return;
    }
    // Forward tabs must take the same validation path as the Next buttons.
    if (!workspaceReadOnly()) {
      step.set(1);
      advanceFromStep1();
      if (fieldErrors().workspace) return;
    }
    if (target === 3) advanceFromStep2();
  }

  function clearResolvedModelErrors(): void {
    const models = selectedModels();
    const errs = { ...fieldErrors() };
    if (models.length > 0) delete errs.models;
    if (models.includes(runtime.endpointDefaultModel.trim())) delete errs.defaultModel;
    fieldErrors.set(errs);
  }

  function toggleModelSelection(model: string): void {
    const current = selectedModels();
    const next = current.includes(model) ? current.filter((m) => m !== model) : [...current, model];
    runtime.endpointModelsText = next.join("\n");
    if (!next.includes(runtime.endpointDefaultModel)) runtime.endpointDefaultModel = next[0] ?? "";
    clearResolvedModelErrors();
  }

  function selectAllModels(): void {
    const shown = filteredModels();
    runtime.endpointModelsText = shown.join("\n");
    if (!shown.includes(runtime.endpointDefaultModel)) runtime.endpointDefaultModel = shown[0] ?? "";
    clearResolvedModelErrors();
  }

  function deselectAllModels(): void {
    runtime.endpointModelsText = "";
    runtime.endpointDefaultModel = "";
  }

  function addCustomModel(): void {
    const name = customModelInput().trim();
    if (!name) return;
    if (!availableDiscoveredModels().includes(name)) availableDiscoveredModels.set([name, ...availableDiscoveredModels()]);
    toggleModelSelection(name);
    customModelInput.set("");
  }

  /** What every Bot made at the end runs on: on Claude Code alone, or another agent, its runner (ADR 0078, 0079). */
  const teamBase = signal<Partial<CreateBotDraft>>({});
  const team = { api: null as TeamStepApi | null };
  const teamCount = signal(0);
  const teamReady = signal(false);
  const teamBusy = signal(false);

  /**
   * Your Claude Code sessions from a terminal (ADR 0095), asked for once while the roster is empty:
   * with any, the last step offers carrying one on as a project session instead of making Bots.
   */
  const terminalSessions = signal<ClaudeCodeSessionListing[]>([]);
  let terminalAsked = false;
  effect(() => {
    const client = runtime.client as { claudeCodeSessions?: (limit?: number) => Promise<ClaudeCodeSessionListing[]> } | null;
    if (terminalAsked || !client?.claudeCodeSessions || !rosterEmpty()) return;
    terminalAsked = true;
    // Enough of them that a directory from last week still shows, as in the import sheet.
    void client.claudeCodeSessions(120).then((items) => terminalSessions.set(items), () => undefined);
  });
  const carryOffered = () => terminalSessions().length > 0;
  const startWay = signal<"team" | "carry">("team");

  const hold = (value: boolean) => props.onHoldingChange?.(value);

  /** The last step (ADR 0085): a way of working and the first Bots. No model: they run on the default model just chosen. */
  function enterBotStep(): void {
    const other = pickedOther();
    teamBase.set(
      connectMode() === "claude"
        ? other
          ? { runner: runnerValueOf(other, picked().customId) as CreateBotDraft["runner"] }
          : { runner: "claude_code", agentConfigDir: claudeConfigDir() }
        : {},
    );
    step.set(4);
  }

  async function handleComplete(): Promise<void> {
    saveFailed.set(false);
    fieldErrors.set({});
    const workspace = runtime.workspacePath.trim();
    if (!workspaceReadOnly() && !workspacePlan().ok) {
      const plan = workspacePlan();
      fieldErrors.set({ workspace: plan.ok ? undefined : plan.error });
      step.set(1);
      return;
    }
    if (connectMode() === "claude") {
      await completeOnClaude(workspace);
      return;
    }
    if (!validateConnection()) {
      step.set(2);
      return;
    }
    // Unlike the settings editor, finishing onboarding needs a usable model selection.
    fieldErrors.set({ ...fieldErrors(), ...modelErrors() });
    if (modelErrors().models || modelErrors().defaultModel) return;
    const providerPlan = planCreateProvider(
      applyProbedModels(
        {
          ...emptyProviderDraft(),
          name: providerName(),
          baseUrl: runtime.endpointUrl,
          apiFormat: apiFormat(),
          workspaceId: anthropicWorkspace(),
          apiKey: runtime.endpointKey,
          models: selectedModels(),
          availableModels: probedModels(),
          defaultModel: defaultModel(),
        },
        { models: probedModels(), catalog: probedCatalog() },
      ),
      !runtime.snapshot.settings.wizard_complete,
    );
    if (!providerPlan.ok) {
      fieldErrors.set(providerPlan.errors);
      if (providerPlan.errors.endpoint || providerPlan.errors.endpointKey || providerPlan.errors.name) step.set(2);
      else if (providerPlan.errors.models || providerPlan.errors.defaultModel) step.set(3);
      return;
    }
    // Either save below can complete setup, and the wizard comes down with it unless held.
    const holding = rosterEmpty();
    hold(holding);
    if (!(await saveSetup(workspace, providerPlan.body))) {
      hold(false);
      return;
    }
    if (holding) enterBotStep();
  }

  /** Set up on Claude Code alone: the workspace, then every built-in call on the Claude model and account chosen (ADR 0078). */
  async function completeOnClaude(workspace: string): Promise<void> {
    if (!claudeOk()) {
      step.set(2);
      return;
    }
    const other = pickedOther();
    const choice = other
      ? { runner: other, model: agentModel().trim(), config_dir: null, ...(picked().customId ? { custom_id: picked().customId } : {}) }
      : { runner: "claude_code" as const, model: claudeModel(), config_dir: claudeConfigDir() || null };
    if (!choice.model) {
      step.set(3);
      return;
    }
    const holding = rosterEmpty();
    hold(holding);
    if (!(await saveWorkspace(workspace))) {
      hold(false);
      return;
    }
    const error = await runtime.patchSettings({ builtin_models: Object.fromEntries(BUILTIN_MODEL_ROLES.map((role) => [role, choice])) });
    if (error) {
      hold(false);
      saveFailed.set(true);
      return;
    }
    if (holding) enterBotStep();
  }

  /** False, with the reason on screen, when the workspace is refused; a phone has none to save. */
  async function saveWorkspace(workspace: string): Promise<boolean> {
    if (workspaceReadOnly()) return true;
    const workspaceError = await runtime.patchSettings({ workspace_path: workspace });
    if (!workspaceError) return true;
    const mapped = mapSettingsError(workspaceError.message);
    if ("workspace" in mapped) {
      fieldErrors.set({ workspace: mapped.workspace });
      step.set(1);
      return false;
    }
    saveFailed.set(true);
    return false;
  }

  /** Writes the workspace and the endpoint; false, with the reason on screen, when either is refused. */
  async function saveSetup(workspace: string, provider: CreateProviderRequest): Promise<boolean> {
    if (!(await saveWorkspace(workspace))) return false;
    const existing = runtime.snapshot.providers[0];
    const providerError = existing
      ? await runtime.patchProvider(existing.id, {
          name: provider.name,
          base_url: provider.base_url,
          ...(apiFormat() !== (existing.api_format ?? "openai") ? { api_format: apiFormat() } : {}),
          ...(provider.workspace_id ? { workspace_id: provider.workspace_id } : {}),
          api_key: provider.api_key,
          models: provider.models,
          available_models: provider.available_models,
          default_model: provider.default_model,
        })
      : await runtime.createProvider(provider);
    if (!providerError) return true;
    const mapped = mapProviderError(providerError.message);
    if ("top" in mapped) {
      saveFailed.set(true);
      return false;
    }
    fieldErrors.set(mapped);
    step.set(mapped.endpoint || mapped.endpointKey ? 2 : 3);
    return false;
  }

  return {
    t, step, rosterEmpty, setupSaved, showBotStep, workspaceReadOnly,
    connectMode, claudeStatus, claudeModel, claudeConfigDir, agentPick, otherAgents, agentModel,
    picked, pickedOther, pickedStatus, pickedLabel, readyAgents, claudeOk,
    claudeModelData, agentModelData, claudeAccounts,
    fieldErrors, saveFailed, providerName, apiFormat, anthropicWorkspace, activePreset, fetchingModels, fetchError,
    availableDiscoveredModels, modelFilterQuery, showManualModelEdit, customModelInput,
    clearError, workspacePlan, connectionPlan, selectedModels, defaultModelData, canCompleteSetup,
    allKnownModels, filteredModels, keyless,
    applyPreset, onEndpointOrKeyInput, fetchModels, advanceFromStep1, advanceFromStep2, goToStep,
    clearResolvedModelErrors, toggleModelSelection, selectAllModels, deselectAllModels, addCustomModel,
    teamBase, team, teamCount, teamReady, teamBusy, terminalSessions, carryOffered, startWay, hold, handleComplete,
  };
}

export type Wizard = ReturnType<typeof createWizard>;
