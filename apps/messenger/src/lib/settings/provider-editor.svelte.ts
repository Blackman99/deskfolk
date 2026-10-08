/**
 * The endpoint editor behind the Models tab — its autosave, the model probe, the create-once
 * guard — lifted out of `SettingsModal.svelte`. The modal constructs it; the open editor itself
 * stays the shell's bindable `providerEditor`, read and written here through the getter and setter
 * the modal hands over, never copied, so the shell's Escape cascade still sees the flyout.
 */
import type { Copy } from "../copy.ts";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import type { Snapshot } from "../snapshot.ts";
import {
  applyProbedModels,
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
  private providerSaveTimer: ReturnType<typeof setTimeout> | null = null;
  providerSaving = $state(false);
  providerSavedTick = $state(0);
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
    this.providerSavedTick = 0;
    this.providerEditor = { ...editor, draft: synced, errors: {}, failed: false };
    this.scheduleProviderProbe(editor.target, synced, this.editorKeySet(editor.target));
    this.scheduleProviderSave();
  }

  private resetProviderProbe(): void {
    if (this.providerProbeTimer) clearTimeout(this.providerProbeTimer);
    this.providerProbeTimer = null;
    this.providerProbedSignature = null;
  }

  private scheduleProviderSave(delay = 600): void {
    if (this.providerSaveTimer) clearTimeout(this.providerSaveTimer);
    this.providerSaveTimer = setTimeout(() => {
      this.providerSaveTimer = null;
      if (this.providerEditor) void this.persistProviderEditor(this.providerEditor);
    }, delay);
  }

  private flushProviderEditor(editor: ProviderEditorState): void {
    if (this.providerSaveTimer) {
      clearTimeout(this.providerSaveTimer);
      this.providerSaveTimer = null;
    }
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
      this.providerSaving = true;
      this.setSaveFailed(false);
      this.patchProviderEditor("add", { failed: false, errors: {} });
      const plan = planCreateProvider(editor.draft, true);
      if (!plan.ok) {
        this.providerSaving = false;
        this.patchProviderEditor("add", { errors: plan.errors });
        this.drainPersistQueue();
        return;
      }
      const before = new Set(this.snapshot.providers.map((row) => row.id));
      const error = await this.runtime.createProvider(plan.body);
      this.providerSaving = false;
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
      this.providerSavedTick += 1;
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
    this.providerSaving = true;
    this.setSaveFailed(false);
    if (this.providerEditor?.target === id) this.patchProviderEditor(id, { failed: false, errors: {} });
    const error = await this.runtime.patchProvider(id, plan.patch);
    this.providerSaving = false;
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
    this.providerSavedTick += 1;
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

  private openProviderEditor(target: "add" | string, draft: ProviderDraft): void {
    this.resetProviderProbe();
    if (this.providerSaveTimer) {
      clearTimeout(this.providerSaveTimer);
      this.providerSaveTimer = null;
    }
    this.lastCreatedSignature = null;
    this.providerSavedTick = 0;
    this.providerDetailModel = null;
    this.providerEditor = {
      target,
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

  openAddProvider(): void {
    this.openProviderEditor("add", emptyProviderDraft());
  }

  openEditProvider(id: string): void {
    const provider = this.snapshot.providers.find((row) => row.id === id);
    if (!provider) return;
    const draft = draftFromProvider(provider);
    this.openProviderEditor(id, draft);
    // The stored URL + key count as already asked, so only changing one of them probes again.
    const signature = probeSignature(draft, provider.key_set);
    this.providerProbedSignature = signature;
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
    );
    // The editor may have closed or moved to another URL / key while the request was out.
    const open = this.providerEditor;
    if (this.runtime.client !== api || !this.runtime.settingsOpen || !open || open.target !== target || probeSignature(open.draft, keySet) !== requested) return;
    if (!res.ok) {
      this.providerEditor = {
        ...open,
        fetching: false,
        fetchError: `${this.t.settings.modelsFetchFailed} (${res.error})`,
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
