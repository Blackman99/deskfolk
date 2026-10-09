/**
 * The endpoint editor behind the Models tab — its autosave, the model probe, the create-once
 * guard — lifted out of `SettingsModal.svelte`. The modal constructs it; the open editor itself
 * stays the shell's bindable `providerEditor`, read and written here through the getter and setter
 * the modal hands over, never copied, so the shell's Escape cascade still sees the flyout.
 */
import { connectorById, type Connector, type ConnectorId } from "@real-bot/protocol";
import { Autosave } from "../autosave.svelte.ts";
import type { Copy } from "../copy.ts";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import type { Snapshot } from "../snapshot.ts";
import { asksForWorkspace, planOrder, searchPlans } from "./connector-detect.ts";
import {
  applyProbedModels,
  connectorDraft,
  connectorSignature,
  draftFromProvider,
  emptyProviderDraft,
  mapProviderError,
  planCreateProvider,
  planPatchProvider,
  probeFormat,
  probeSignature,
  withSyncedDefaultModel,
  type ProviderDraft,
  type ProviderEditorState,
} from "./provider-form.ts";

export type ProviderEditorDeps = {
  runtime: () => MessengerRuntime;
  snapshot: () => Snapshot;
  t: () => Copy;
  providerEditor: () => ProviderEditorState | null;
  setProviderEditor: (value: ProviderEditorState | null) => void;
  /** Shared with the shell's immediate settings patch helper. */
  setSaveFailed: (value: boolean) => void;
};

export class ProviderEditorController {
  private readonly getRuntime: () => MessengerRuntime;
  private readonly getSnapshot: () => Snapshot;
  private readonly getT: () => Copy;
  private readonly getProviderEditor: () => ProviderEditorState | null;
  private readonly setProviderEditor: (value: ProviderEditorState | null) => void;
  private readonly setSaveFailed: (value: boolean) => void;

  providerDetailModel = $state<string | null>(null);

  private providerProbeTimer: ReturnType<typeof setTimeout> | null = null;
  /** URL + key the open editor last asked the endpoint about; the same pair is not probed twice. */
  private providerProbedSignature: string | null = null;
  private connectorSearchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Key + workspace a connector form last searched its plans with (ADR 0072). */
  private connectorSearchedSignature: string | null = null;
  private readonly autosave = new Autosave();
  get providerSaving(): boolean {
    return this.autosave.saving;
  }
  get providerSavedTick(): number {
    return this.autosave.savedTick;
  }
  /** Latest editor draft, so a parent that nulls `providerEditor` still has something to flush. */
  private latestProviderEditor: ProviderEditorState | null = null;
  private persistQueue: ProviderEditorState[] = [];
  /** Create once per filled-in add draft; a close flush must not POST a second copy. */
  private lastCreatedSignature: string | null = null;

  constructor(deps: ProviderEditorDeps) {
    this.getRuntime = deps.runtime;
    this.getSnapshot = deps.snapshot;
    this.getT = deps.t;
    this.getProviderEditor = deps.providerEditor;
    this.setProviderEditor = deps.setProviderEditor;
    this.setSaveFailed = deps.setSaveFailed;

    // The flyout outlives no more than this component; a pending probe or draft must not fire after it goes.
    $effect(() => () => {
      this.resetProviderProbe();
      if (this.latestProviderEditor) this.flushProviderEditor(this.latestProviderEditor);
    });

    // Closing the editor, switching endpoints, or closing settings must send a pending draft first.
    $effect(() => {
      const editor = this.providerEditor;
      const pending = this.latestProviderEditor;
      if (pending && pending.target !== editor?.target) {
        this.flushProviderEditor(pending);
      }
      this.latestProviderEditor = editor;
    });

    /** An endpoint deleted or replaced from elsewhere takes its open editor with it. */
    $effect(() => {
      const openEditor = this.providerEditor;
      if (
        openEditor &&
        openEditor.target !== "add" &&
        !this.snapshot.providers.some((row) => row.id === openEditor.target)
      ) {
        this.closeProviderEditor();
      }
    });
  }

  private get runtime(): MessengerRuntime {
    return this.getRuntime();
  }

  private get snapshot(): Snapshot {
    return this.getSnapshot();
  }

  private get t(): Copy {
    return this.getT();
  }

  private get providerEditor(): ProviderEditorState | null {
    return this.getProviderEditor();
  }

  private set providerEditor(value: ProviderEditorState | null) {
    this.setProviderEditor(value);
  }

  /** A new endpoint has no key on file yet; an existing one's is whatever the snapshot says. */
  editorKeySet(target: "add" | string): boolean {
    if (target === "add") return false;
    return this.snapshot.providers.find((row) => row.id === target)?.key_set ?? false;
  }

  /** Write into the open editor, but only while it is still that one — awaits can outlive it. */
  private patchProviderEditor(target: "add" | string, patch: Partial<ProviderEditorState>): void {
    const editor = this.providerEditor;
    if (!editor || editor.target !== target) return;
    this.providerEditor = { ...editor, ...patch };
  }

  setProviderDraft(draft: ProviderDraft): void {
    const editor = this.providerEditor;
    if (!editor) return;
    const synced = withSyncedDefaultModel(draft);
    this.autosave.savedTick = 0;
    this.providerEditor = { ...editor, draft: synced, errors: {}, failed: false };
    const keySet = this.editorKeySet(editor.target);
    if (synced.connector) this.scheduleConnectorSearch(editor.target, synced, keySet);
    else this.scheduleProviderProbe(editor.target, synced, keySet);
    this.scheduleProviderSave();
  }

  private resetProviderProbe(): void {
    if (this.providerProbeTimer) clearTimeout(this.providerProbeTimer);
    this.providerProbeTimer = null;
    this.providerProbedSignature = null;
    if (this.connectorSearchTimer) clearTimeout(this.connectorSearchTimer);
    this.connectorSearchTimer = null;
    this.connectorSearchedSignature = null;
  }

  private scheduleProviderSave(delay = 600): void {
    this.autosave.schedule(() => {
      if (this.providerEditor) void this.persistProviderEditor(this.providerEditor);
    }, delay);
  }

  private flushProviderEditor(editor: ProviderEditorState): void {
    this.autosave.cancel();
    void this.persistProviderEditor(editor);
  }

  private createSignature(editor: ProviderEditorState): string {
    const plan = planCreateProvider(editor.draft, true);
    if (!plan.ok) return "";
    return JSON.stringify(plan.body);
  }

  async persistProviderEditor(editor: ProviderEditorState): Promise<void> {
    if (this.providerSaving) {
      this.persistQueue = [editor];
      return;
    }
    if (editor.target === "add") {
      const signature = this.createSignature(editor);
      if (!signature) return;
      if (signature === this.lastCreatedSignature) return;
      this.autosave.saving = true;
      this.setSaveFailed(false);
      this.patchProviderEditor("add", { failed: false, errors: {} });
      const plan = planCreateProvider(editor.draft, true);
      if (!plan.ok) {
        this.autosave.saving = false;
        this.patchProviderEditor("add", { errors: plan.errors });
        this.drainPersistQueue();
        return;
      }
      const before = new Set(this.snapshot.providers.map((row) => row.id));
      const error = await this.runtime.createProvider(plan.body);
      this.autosave.saving = false;
      if (error) {
        const mapped = mapProviderError(error.message);
        if ("top" in mapped) {
          if (this.providerEditor?.target === "add") this.patchProviderEditor("add", { failed: true });
          else this.setSaveFailed(true);
        } else if (this.providerEditor?.target === "add") {
          this.patchProviderEditor("add", { errors: mapped });
        }
        this.drainPersistQueue();
        return;
      }
      this.lastCreatedSignature = signature;
      this.autosave.savedTick += 1;
      this.persistQueue = [];
      const created = this.snapshot.providers.find((row) => !before.has(row.id));
      if (created && this.providerEditor?.target === "add") {
        this.providerEditor = {
          ...this.providerEditor,
          target: created.id,
          view: "models",
          draft: { ...this.providerEditor.draft, apiKey: "" },
          errors: {},
          failed: false,
        };
        void this.persistProviderEditor(this.providerEditor);
        return;
      }
      this.drainPersistQueue();
      return;
    }
    const id = editor.target;
    const provider = this.snapshot.providers.find((row) => row.id === id);
    if (!provider) return;
    const plan = planPatchProvider(provider, editor.draft);
    if (!plan.ok) {
      if (this.providerEditor?.target === id) this.patchProviderEditor(id, { errors: plan.errors, failed: false });
      else this.setSaveFailed(true);
      return;
    }
    if (Object.keys(plan.patch).length === 0) return;
    this.autosave.saving = true;
    this.setSaveFailed(false);
    if (this.providerEditor?.target === id) this.patchProviderEditor(id, { failed: false, errors: {} });
    const error = await this.runtime.patchProvider(id, plan.patch);
    this.autosave.saving = false;
    if (error) {
      const mapped = mapProviderError(error.message);
      if ("top" in mapped) {
        if (this.providerEditor?.target === id) this.patchProviderEditor(id, { failed: true });
        else this.setSaveFailed(true);
      } else if (this.providerEditor?.target === id) {
        this.patchProviderEditor(id, { errors: mapped });
      }
      this.drainPersistQueue();
      return;
    }
    this.autosave.savedTick += 1;
    this.drainPersistQueue();
  }

  private drainPersistQueue(): void {
    const next = this.persistQueue.shift();
    if (next) void this.persistProviderEditor(next);
  }

  /** Asks the endpoint for its models once the URL and key are usable, a moment after typing stops. */
  private scheduleProviderProbe(target: "add" | string, draft: ProviderDraft, keySet: boolean): void {
    const signature = probeSignature(draft, keySet);
    if (this.providerProbeTimer) clearTimeout(this.providerProbeTimer);
    this.providerProbeTimer = null;
    if (!signature || signature === this.providerProbedSignature) return;
    this.providerProbeTimer = setTimeout(() => {
      this.providerProbeTimer = null;
      if (this.providerEditor?.target !== target) return;
      this.providerProbedSignature = signature;
      void this.fetchProviderModels();
    }, 700);
  }

  /**
   * A connector form searches its plans again when the key or workspace changes; a plan picked by
   * hand changes only the address, so that one plan is asked, as any endpoint is.
   */
  private scheduleConnectorSearch(target: "add" | string, draft: ProviderDraft, keySet: boolean): void {
    const signature = connectorSignature(draft, keySet);
    if (this.connectorSearchTimer) clearTimeout(this.connectorSearchTimer);
    this.connectorSearchTimer = null;
    if (!signature || signature === this.connectorSearchedSignature) {
      this.scheduleProviderProbe(target, draft, keySet);
      return;
    }
    if (this.providerProbeTimer) clearTimeout(this.providerProbeTimer);
    this.providerProbeTimer = null;
    this.connectorSearchTimer = setTimeout(() => {
      this.connectorSearchTimer = null;
      if (this.providerEditor?.target !== target) return;
      void this.searchConnectorPlans();
    }, 700);
  }

  /**
   * Tries the key on each of the connector's plans (ADR 0072) and moves the endpoint to the first
   * that takes it, with that plan's models. A new endpoint has no address until then, so the
   * autosave creates nothing for a key no plan takes.
   */
  async searchConnectorPlans(): Promise<void> {
    const editor = this.providerEditor;
    const connector = editor?.draft.connector ? connectorById(editor.draft.connector) : null;
    if (!editor || !connector) return;
    const { target, draft } = editor;
    const keySet = this.editorKeySet(target);
    const requested = connectorSignature(draft, keySet);
    if (!requested) return;
    this.connectorSearchedSignature = requested;
    this.patchProviderEditor(target, { fetching: true, fetchError: null });
    const api = this.runtime.client;
    const workspaceId = draft.workspaceId.trim() || null;
    const outcome = await searchPlans(
      planOrder(connector, draft.baseUrl),
      (plan) => this.runtime.probeModels(plan.baseUrl, draft.apiKey, target === "add" ? undefined : target, connector.apiFormat, workspaceId),
      () => {
        const open = this.providerEditor;
        return this.runtime.client === api && this.runtime.settingsOpen && open?.target === target && connectorSignature(open.draft, keySet) === requested;
      },
    );
    const open = this.providerEditor;
    if (outcome.kind === "stale" || !open) return;
    if (outcome.kind === "found") {
      const found = applyProbedModels({ ...open.draft, baseUrl: outcome.plan.baseUrl }, outcome.result);
      // The plan just answered for this address and key; the plain probe need not ask again.
      this.providerProbedSignature = probeSignature(found, keySet);
      this.providerEditor = { ...open, fetching: false, fetchError: null, draft: found, errors: {} };
      this.scheduleProviderSave();
      return;
    }
    const fetchError =
      outcome.kind === "refused"
        ? this.connectorRefusal(connector)
        : this.connectorFailure(connector, outcome.error, undefined) ?? `${this.t.settings.modelsFetchFailed} (${outcome.error})`;
    this.providerEditor = { ...open, fetching: false, fetchError };
  }

  /** Every plan of the connector refused the key (401). */
  private connectorRefusal(connector: Connector): string {
    const name = this.t.connectors.name[connector.id];
    if (connector.plans.length > 1) {
      const plans = connector.plans.map((plan) => this.t.connectors.plan[`${connector.id}:${plan.id}` as keyof Copy["connectors"]["plan"]] ?? plan.id);
      return this.t.connectors.keyRefused(name, plans.join(this.t.connectors.listSeparator));
    }
    // A workspace id saved over the key is refused as an invalid key (2026-10-09).
    return connector.workspace
      ? `${this.t.connectors.keyRefusedSingle(name)} ${this.t.connectors.keyMayBeWorkspace}`
      : this.t.connectors.keyRefusedSingle(name);
  }

  /** What a connector's refusal means in its own words, or null to show the vendor's message. */
  private connectorFailure(connector: Connector, error: string, status: number | undefined): string | null {
    if (status === 401) return this.connectorRefusal(connector);
    if (connector.workspace && asksForWorkspace(error)) return this.t.connectors.workspaceNeeded;
    return null;
  }

  private openProviderEditor(target: "add" | string, draft: ProviderDraft, picking = false): void {
    this.resetProviderProbe();
    this.autosave.cancel();
    this.lastCreatedSignature = null;
    this.autosave.savedTick = 0;
    this.providerDetailModel = null;
    this.providerEditor = {
      target,
      ...(picking ? { picking: true } : {}),
      view: "connection",
      draft,
      errors: {},
      failed: false,
      fetching: false,
      fetchError: null,
    };
  }

  /** Opens the enable list for an endpoint that already exists. A new one has nothing to list yet. */
  openProviderModels(id: string): void {
    this.openEditProvider(id);
    if (this.providerEditor?.target === id) this.providerEditor = { ...this.providerEditor, view: "models" };
  }

  /** Adding starts on the connector tiles (ADR 0072); the form follows the pick. */
  openAddProvider(): void {
    this.openProviderEditor("add", emptyProviderDraft(), true);
  }

  pickConnector(id: ConnectorId | null): void {
    const editor = this.providerEditor;
    if (editor?.target !== "add") return;
    this.openProviderEditor("add", id ? connectorDraft(id, this.t.connectors.name[id]) : emptyProviderDraft());
  }

  /** Back from a new endpoint's form, before it was created, is back to the tiles; true when it was. */
  backToConnectorPicker(): boolean {
    const editor = this.providerEditor;
    if (editor?.target !== "add" || editor.picking) return false;
    this.openProviderEditor("add", emptyProviderDraft(), true);
    return true;
  }

  openEditProvider(id: string): void {
    const provider = this.snapshot.providers.find((row) => row.id === id);
    if (!provider) return;
    const draft = draftFromProvider(provider);
    this.openProviderEditor(id, draft);
    // The stored URL + key count as already asked, so only changing one of them probes again.
    const signature = probeSignature(draft, provider.key_set);
    this.providerProbedSignature = signature;
    this.connectorSearchedSignature = connectorSignature(draft, provider.key_set);
    // Endpoints saved before the list was kept have nothing to show yet; ask once on open.
    if (provider.available_models.length === 0 && signature) void this.fetchProviderModels();
  }

  closeProviderEditor(): void {
    this.resetProviderProbe();
    this.providerDetailModel = null;
    this.providerEditor = null;
  }

  async fetchProviderModels(): Promise<void> {
    const editor = this.providerEditor;
    if (!editor) return;
    const { target } = editor;
    const baseUrl = editor.draft.baseUrl.trim();
    if (!baseUrl) {
      this.patchProviderEditor(target, { fetchError: this.t.settings.endpointEmpty });
      return;
    }
    const keySet = this.editorKeySet(target);
    const requested = probeSignature(editor.draft, keySet);
    this.patchProviderEditor(target, { fetching: true, fetchError: null });
    const api = this.runtime.client;
    const saved = target === "add" ? undefined : this.snapshot.providers.find((row) => row.id === target)?.api_format;
    const res = await this.runtime.probeModels(
      baseUrl,
      editor.draft.apiKey,
      target === "add" ? undefined : target,
      probeFormat(editor.draft, saved),
      editor.draft.workspaceId.trim() || null,
    );
    // The editor may have closed or moved to another URL / key while the request was out.
    const open = this.providerEditor;
    if (this.runtime.client !== api || !this.runtime.settingsOpen || !open || open.target !== target || probeSignature(open.draft, keySet) !== requested) return;
    if (!res.ok) {
      const connector = open.draft.connector ? connectorById(open.draft.connector) : null;
      this.providerEditor = {
        ...open,
        fetching: false,
        fetchError: (connector && this.connectorFailure(connector, res.error, res.status)) ?? `${this.t.settings.modelsFetchFailed} (${res.error})`,
      };
      return;
    }
    this.providerEditor = {
      ...open,
      fetching: false,
      draft: applyProbedModels(open.draft, res),
      errors: {},
    };
    this.scheduleProviderSave();
  }

  /**
   * The default model is one click on the list, not a field inside the editor. The patch is the
   * model name alone, so a half-typed connection draft cannot ride along.
   */
  async setProviderDefaultModel(id: string, model: string): Promise<void> {
    const provider = this.snapshot.providers.find((row) => row.id === id);
    if (!provider || provider.default_model === model || !provider.models.includes(model)) return;
    this.setSaveFailed(false);
    const api = this.runtime.client;
    const error = await this.runtime.patchProvider(id, { default_model: model });
    if (this.runtime.client !== api || !this.runtime.settingsOpen) return;
    if (error) {
      this.setSaveFailed(true);
      return;
    }
    const open = this.providerEditor;
    if (open?.target === id) {
      this.providerEditor = { ...open, draft: { ...open.draft, defaultModel: model }, errors: {}, failed: false };
    }
  }
}
