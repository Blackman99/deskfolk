/**
 * The settings window (`settings/SettingsModal.svelte`): the navigation (`SettingsNav`) and the tab it
 * picks, each tab's page, the autosave state in the head, what the window says over any page (pending
 * credentials, a failed save, setup not done), the endpoint editor that slides over it, the
 * independent-runtime confirmation, and on a phone the drill-down: the list first, a tab one level
 * deeper, Back (or ✕) stepping out of the deepest thing open.
 *
 * It is `nsh/base`'s `Dialog` (the card is a row, the nav beside the page, so `Modal`'s head does not
 * fit): 880 by 640 on a desktop, the whole window on a phone (720 wide or less, where `SettingsNav` is
 * the first page). Escape, the scrim and ✕ close it unless the endpoint editor or a confirmation is up.
 *
 * What the Svelte took with `bind:` the shell owns and passes as a value and `on…Change`:
 * `mobileSettingsDetail`, `saveFailed`, `providerEditor`, `confirmingIndependent`. What it exported
 * for the shell's Back (`backWithinSettings`, `backFromProviderEditor`) goes out through
 * `onHandle(handle)`, called once. The tabs that hand back their section title and Back do it through
 * a controller or `createModelsState`; this reads them for its head and its Back.
 *
 * Props: `confirmingProvider` (the danger dialog is up for an endpoint); `patchImmediate(patch)`;
 * `openDeleteProviderConfirm(id)`; `closeSettings`; `workbench` (the desktop workbench is on: the
 * Behavior tab shows). Test ids: `settings-modal`, `settings-main-title`, `settings-mobile-back`,
 * `settings-close`, `settings-notices`, `pending-credentials`, `credential-retry`,
 * `credential-repair-<id>`, `credential-save-<id>`, `credential-cancel-<id>`, `settings-save-failed`,
 * `settings-wizard-banner`, and the nav's and tabs'.
 *
 * Differently from the Svelte: the phone's page change does not slide, and the credential repair
 * field is `Input`'s masked text.
 */
import type { Lesson, PromptSummary } from "@real-bot/protocol";
import { effect, Scroll, signal, Text, untracked, View, windowSize, type JSX } from "nsh";
import { Dialog, Input } from "nsh/base";
import { copy, runtime } from "../../runtime";
import type { CredentialOperation } from "../../m/api.ts";
import { IndependentRuntimeController } from "../../m/settings/independent-runtime.svelte.ts";
import { ProviderEditorController } from "../../m/settings/provider-editor.svelte.ts";
import type { ProviderEditorState } from "../../m/settings/provider-form.ts";
import { editedCount } from "../../m/settings/prompts-view.ts";
import { promptsTabItems } from "../../m/settings/routing-map.ts";
import { mapSettingsError, planWorkspaceSave, type SettingsFieldErrors } from "../../m/settings/wizard-save.ts";
import { parseHostRelay, type HostRelayField } from "../../m/remote/pairing-host.ts";
import { IconButton } from "../IconButton";
import { AboutTab } from "./AboutTab";
import { AgentsTab, type AgentsTabController } from "./AgentsTab";
import { AutosaveState } from "./AutosaveState";
import { BehaviorTab } from "./BehaviorTab";
import { GeneralTab } from "./GeneralTab";
import { IndependentConfirm } from "./IndependentConfirm";
import { InterfaceTab, type InterfaceTabController } from "./InterfaceTab";
import { LessonsSettings } from "./LessonsSettings";
import { McpSettings } from "./McpSettings";
import { ModelsTab } from "./ModelsTab";
import { createModelsState } from "./models-tab";
import { NotificationSettings } from "./NotificationSettings";
import { ProviderEditorFlyout } from "./ProviderEditorFlyout";
import { ProvidersTab } from "./ProvidersTab";
import { PromptsSettings, type PromptsSettingsApi } from "./PromptsSettings";
import { RemoteTab } from "./RemoteTab";
import { SettingsNav, type SettingsTab } from "./SettingsNav";
import { widthAtMost } from "../../platform/viewport";

/** What the shell calls on the window: its Back, and the endpoint editor's. */
export type SettingsModalHandle = {
  backFromProviderEditor: () => void;
  /** Steps out of the deepest thing open on a phone; true when it did, false when settings should close. */
  backWithinSettings: () => boolean;
};

type Patch = { locale?: "zh" | "en"; theme?: "system" | "light" | "dark"; launch_at_login?: boolean };

/** The phone breakpoint `SettingsNav` and the Svelte window share. */
const phone = () => widthAtMost(720);

export function SettingsModal(props: {
  mobileSettingsDetail?: boolean;
  onMobileSettingsDetailChange?: (value: boolean) => void;
  /** Shared with the shell's immediate settings patch helper. */
  saveFailed: boolean;
  onSaveFailedChange: (value: boolean) => void;
  /** The shell owns this too, so its Escape cascade can see the flyout stacked on the window. */
  providerEditor: ProviderEditorState | null;
  onProviderEditorChange: (value: ProviderEditorState | null) => void;
  /** The danger dialog is up for an endpoint, so neither backdrop should close. */
  confirmingProvider: boolean;
  confirmingIndependent: boolean;
  onConfirmingIndependentChange: (value: boolean) => void;
  patchImmediate: (patch: Patch) => Promise<boolean>;
  openDeleteProviderConfirm: (id: string) => void;
  closeSettings: () => void;
  workbench?: boolean;
  onHandle?: (handle: SettingsModalHandle) => void;
}) {
  const t = () => copy();
  const snapshot = () => runtime.snapshot;
  const locale = (): "zh" | "en" => (snapshot().settings.locale === "en" ? "en" : "zh");
  const mobileDetail = () => props.mobileSettingsDetail === true;
  const setMobileDetail = (value: boolean) => props.onMobileSettingsDetailChange?.(value);

  const relativeTimeNow = signal(Date.now());
  effect(() => {
    if (!runtime.settingsOpen) return;
    relativeTimeNow.set(Date.now());
    const timer = setInterval(() => relativeTimeNow.set(Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  // The device list is fetched, not part of the snapshot, so something has to ask for it.
  effect(() => {
    const listable = runtime.settingsOpen && !runtime.remote && runtime.remoteStatus?.state === "online";
    if (!listable) return;
    untracked(() => void runtime.refreshHostDevices());
  });

  const credentialOps = () => snapshot().credentialOperations;
  const repairValues = signal<Record<string, string>>({});
  let hadPending = false;
  effect(() => {
    const open = runtime.settingsOpen;
    const pending = runtime.pendingMutation;
    const ops = credentialOps();
    untracked(() => {
      if (pending) hadPending = true;
      else if (hadPending) {
        hadPending = false;
        providerEditorController.closeProviderEditor();
      }
      if (!open) repairValues.set({});
      else {
        const active = new Set(ops.filter((op) => op.can_repair).map((op) => op.id));
        const kept = Object.fromEntries(Object.entries(repairValues()).filter(([id]) => active.has(id)));
        if (Object.keys(kept).length !== Object.keys(repairValues()).length) repairValues.set(kept);
      }
    });
  });

  async function resolveCredential(op: CredentialOperation, action: "repair" | "cancel"): Promise<void> {
    const api = runtime.client;
    if (await runtime.resolveCredentialOperation(op.id, action, repairValues()[op.id])) {
      if (runtime.client !== api || !runtime.settingsOpen) return;
      const { [op.id]: _done, ...rest } = repairValues();
      repairValues.set(rest);
    }
  }

  const interfaceHandle = signal<InterfaceTabController | null>(null);
  const agentsHandle = signal<AgentsTabController | null>(null);
  const promptsHandle = signal<PromptsSettingsApi | null>(null);
  let mcpBack: () => boolean = () => false;
  const modelsState = createModelsState((of) => (of === "endpoints" ? t().settings.modelsSectionEndpoints : t().speech.title));

  // Lessons the app learned (ADR 0050, engine level 8): the tab is there once there is one.
  const lessons = signal<Lesson[]>([]);
  effect(() => {
    const api = runtime.client;
    const connected = runtime.connection === "connected";
    if (!runtime.settingsOpen || !api || !connected) return;
    void api.listLessons().then(
      (items) => {
        if (runtime.client === api) lessons.set(items);
      },
      () => {},
    );
  });
  const lessonsTabVisible = () => lessons().length > 0;

  // Built-in prompts (ADR 0064): read when settings open and again whenever one changes anywhere.
  const promptItems = signal<PromptSummary[]>([]);
  const promptsFailed = signal(false);
  effect(() => {
    const api = runtime.client;
    void runtime.promptsRevision;
    const connected = runtime.connection === "connected";
    if (!runtime.settingsOpen || !api || !connected) return;
    void api.listPrompts().then(
      (items) => {
        if (runtime.client !== api) return;
        promptItems.set(items);
        promptsFailed.set(false);
      },
      () => {
        if (runtime.client === api) promptsFailed.set(true);
      },
    );
  });
  // The app's own calls' prompts are on Roles with their models (ADR 0082); Prompts counts the rest.
  const promptCounts = () => editedCount(promptsTabItems(promptItems()));

  const activeTab = signal<SettingsTab>("general");
  const providerEditor = () => props.providerEditor;

  const independentRuntime = new IndependentRuntimeController({
    runtime: () => runtime,
    t: () => t(),
    setConfirmingIndependent: (value) => props.onConfirmingIndependentChange(value),
  });
  const providerEditorController = new ProviderEditorController({
    runtime: () => runtime,
    snapshot: () => snapshot(),
    t: () => t(),
    providerEditor: () => props.providerEditor,
    setProviderEditor: (value) => props.onProviderEditorChange(value),
    setSaveFailed: (value) => props.onSaveFailedChange(value),
  });

  /** Back out of a model's page, then the form back to the connector tiles, then the editor. */
  function backFromProviderEditor(): void {
    if (providerEditorController.providerDetailModel) {
      providerEditorController.providerDetailModel = null;
      return;
    }
    if (providerEditorController.backToConnectorPicker()) return;
    providerEditorController.closeProviderEditor();
  }

  function backWithinSettings(): boolean {
    if (!runtime.settingsOpen || !phone()) return false;
    if (props.confirmingProvider || props.confirmingIndependent) return true;
    if (providerEditor()) {
      backFromProviderEditor();
      return true;
    }
    const tab = activeTab();
    if (tab === "mcp" && mcpBack()) return true;
    if (tab === "prompts" && (promptsHandle()?.backFromEditor() || promptsHandle()?.backFromSection())) return true;
    if (tab === "models" && modelsState.backFromSection()) return true;
    if (tab === "interface" && interfaceHandle()?.backFromSection()) return true;
    if (tab === "agents" && agentsHandle()?.backFromSection()) return true;
    if (!mobileDetail()) return false;
    setMobileDetail(false);
    return true;
  }
  props.onHandle?.({ backFromProviderEditor, backWithinSettings });

  /**
   * What ✕ closes: the screen it sits on, not everything under it. Deep in a section or an editor it
   * steps out one level, exactly as Back does; on the root list — and on a window wide enough to have
   * no inner pages — there is nothing above settings, so it closes them.
   */
  function closeCurrentPage(): void {
    if (backWithinSettings()) return;
    props.closeSettings();
  }

  effect(() => {
    if (!runtime.settingsOpen) setMobileDetail(false);
  });

  /** Roles is a page of its own (ADR 0083): Prompts' link to it leaves Settings for it. */
  function openRoles(): void {
    props.closeSettings();
    runtime.openRoles();
  }

  function openSettingsTab(tab: SettingsTab): void {
    activeTab.set(tab);
    setMobileDetail(phone());
  }

  // Asked to open at the prompts (a card's 「在设置里看」): the tab shows, and it opens the prompt itself.
  // One of the app's own calls' prompts is on Roles, with that call (ADR 0082); until the list has
  // loaded it is not known whose a prompt is, so the call prompts wait for it.
  effect(() => {
    const target = runtime.promptsTarget;
    const items = promptItems();
    const failed = promptsFailed();
    if (!runtime.settingsOpen || !target) return;
    const id = target.prompt?.id;
    if (id?.startsWith("call.") && items.length === 0 && !failed) return;
    const role = id ? (items.find((item) => item.id === id)?.role ?? null) : null;
    untracked(() => {
      if (role) {
        // The call's own page opens the prompt, at its history, from the target left in place.
        props.closeSettings();
        runtime.openRoles(role);
        return;
      }
      openSettingsTab("prompts");
      if (!target.prompt) runtime.promptsTarget = null;
    });
  });

  function tabLabel(tab: SettingsTab): string {
    const s = t().settings;
    const labels: Record<SettingsTab, string> = {
      general: s.tabGeneral,
      behavior: s.tabBehavior,
      interface: t().ui.tab,
      models: s.tabModels,
      agents: s.tabAgents,
      mcp: s.tabMcp,
      prompts: s.tabPrompts,
      notifications: s.tabNotifications,
      lessons: s.tabLessons,
      remote: s.tabRemote,
      about: s.tabAbout,
    };
    return labels[tab];
  }
  /** On a phone, a section of Models, an agent or a group of Prompts opened from its list names the page. */
  const mainTitle = () => {
    const tab = activeTab();
    const section =
      tab === "models" ? modelsState.sectionTitle() : tab === "interface" ? interfaceHandle()?.sectionTitle() : tab === "agents" ? agentsHandle()?.sectionTitle() : tab === "prompts" ? promptsHandle()?.sectionTitle() : null;
    return section ?? tabLabel(tab);
  };

  const fieldErrors = signal<SettingsFieldErrors>({});
  const generalHasError = () => Boolean(fieldErrors().workspace);
  const modelsHasError = () => {
    const editor = providerEditor();
    return Boolean(
      editor && (editor.errors.name || editor.errors.endpoint || editor.errors.endpointKey || editor.errors.models || editor.errors.pricing || editor.errors.contextWindow || editor.errors.defaultModel),
    );
  };

  const workspaceSaving = signal(false);
  const pairingCopied = signal(false);
  const emptyRelay = { origin: "", relayId: "", bootstrap: "" };
  const relayForm = signal({ ...emptyRelay });
  const relayInvalid = signal<HostRelayField | null>(null);

  async function connectRelay(): Promise<void> {
    const parsed = parseHostRelay(relayForm());
    if ("invalid" in parsed) {
      relayInvalid.set(parsed.invalid);
      return;
    }
    relayInvalid.set(null);
    if (await runtime.connectHost(parsed.relay)) relayForm.set({ ...emptyRelay });
  }

  /** A runtime that says nothing about remote access gets no tab for it, rather than an empty page. */
  const remoteTabVisible = () => Boolean(runtime.remote || runtime.remoteStatus);
  effect(() => {
    if (activeTab() === "remote" && !remoteTabVisible()) activeTab.set("general");
  });
  /** Behavior is the workbench's for now: a narrow window or a phone has no panes to place things in. */
  const behaviorTabVisible = () => props.workbench === true;
  effect(() => {
    if (activeTab() === "behavior" && !behaviorTabVisible()) activeTab.set("general");
  });
  /** The interface profile (ADR 0106) is the daemon's; one that predates it has nothing to show. */
  const interfaceTabVisible = () => snapshot().interface !== null;
  effect(() => {
    if (activeTab() === "interface" && !interfaceTabVisible()) activeTab.set("general");
  });
  const workspaceSavedTick = signal(0);

  const settingsSaving = () => workspaceSaving() || (providerEditorController.providerSaving && !providerEditor());
  const settingsSavedTick = () => workspaceSavedTick() + (providerEditor() ? 0 : providerEditorController.providerSavedTick);

  async function setDefaultProvider(id: string): Promise<void> {
    props.onSaveFailedChange(false);
    const api = runtime.client;
    const error = await runtime.patchSettings({ default_provider_id: id });
    if (runtime.client === api && runtime.settingsOpen && error) props.onSaveFailedChange(true);
  }

  const workspaceReadOnly = () => runtime.hosted && !runtime.remote;

  async function persistWorkspace(path: string): Promise<void> {
    props.onSaveFailedChange(false);
    fieldErrors.set({});
    // A hosted shell has no host to write to, and a remote root change needs the Mac's own
    // confirmation rather than this PATCH.
    if (workspaceReadOnly() || runtime.remote) return;
    const plan = planWorkspaceSave(path);
    if (!plan.ok) {
      fieldErrors.set({ workspace: plan.error });
      activeTab.set("general");
      return;
    }
    if (plan.workspace_path === (snapshot().settings.workspace_path ?? "")) return;
    const api = runtime.client;
    workspaceSaving.set(true);
    const error = await runtime.patchSettings({ workspace_path: plan.workspace_path });
    workspaceSaving.set(false);
    // A transport swap mid-write belongs to the old session, not this window.
    if (runtime.client !== api || !runtime.settingsOpen) return;
    if (!error) {
      workspaceSavedTick.set(workspaceSavedTick() + 1);
      return;
    }
    const mapped = mapSettingsError(error.message);
    if ("workspace" in mapped) {
      fieldErrors.set({ workspace: mapped.workspace });
      activeTab.set("general");
    } else {
      props.onSaveFailedChange(true);
    }
  }

  const en = () => locale() === "en";
  const pendingCredentials = (): JSX.Element => (
    <View testID="pending-credentials" class="flex-col gap-2">
      <If when={runtime.pendingMutation}>
        <View class="flex-col gap-2">
          <Text role="text" class="text-[12px] text-ink">
            {en() ? "Credential/request result pending. Retry only when ready; no automatic replay." : "凭据或请求结果待确认。准备好后手动重试，不会自动重放。"}
          </Text>
          <View role="button" testID="credential-retry" onPress={() => void runtime.retryPendingMutation()} class="self-start px-3 py-[6px] border border-line rounded-(--radius-sm)">
            <Text class="text-[12px] text-ink">{en() ? "Retry original request" : "重试原请求"}</Text>
          </View>
        </View>
      </If>
      <Each of={credentialOps().slice()} key={(op) => op.id}>
        {(op) => (
          <View class="flex-col gap-2">
            <Text class="text-[12px] text-ink">{`${en() ? "Unfinished credential" : "未完成的凭据"} · ${op().kind} · ${op().entity_id}`}</Text>
            <If
              when={op().can_repair}
              else={<Text class="text-[12px] text-ink-muted">{en() ? "Deletion is pending. Only clearing the credential is available." : "凭据待删除，只能完成清除。"}</Text>}
            >
              <Input
                testID={`credential-repair-${op().id}`}
                masked
                autoComplete="off"
                accessibilityLabel={en() ? "Repair credential" : "修复凭据"}
                value={repairValues()[op().id] ?? ""}
                onChange={(e) => repairValues.set({ ...repairValues(), [op().id]: e.value })}
                class="px-[10px] py-[6px] text-[13px] text-ink bg-input-bg border border-line rounded-(--radius-sm)"
              />
              <View
                role="button"
                testID={`credential-save-${op().id}`}
                disabled={!repairValues()[op().id]}
                onPress={() => void resolveCredential(op(), "repair")}
                class="self-start px-3 py-[6px] border border-line rounded-(--radius-sm) disabled:opacity-[0.45]"
              >
                <Text class="text-[12px] text-ink">{en() ? "Save credential only" : "仅保存凭据"}</Text>
              </View>
            </If>
            <View role="button" testID={`credential-cancel-${op().id}`} onPress={() => void resolveCredential(op(), "cancel")} class="self-start px-3 py-[6px] border border-line rounded-(--radius-sm)">
              <Text class="text-[12px] text-ink">{en() ? "Cancel and clear credential" : "取消并清除凭据"}</Text>
            </View>
          </View>
        )}
      </Each>
    </View>
  );

  /** What the window says over any page; built fresh where it is shown, since a view sits in one place. */
  const settingsNotices = (): JSX.Element => (
    <>
      <If when={!providerEditor() && (runtime.pendingMutation || credentialOps().length > 0)}>
        <View role="region" accessibilityLabel="Pending credentials">
          {pendingCredentials()}
        </View>
      </If>
      <If when={props.saveFailed}>
        <Text testID="settings-save-failed" class="text-[12px] text-danger-text">
          {t().settings.saveFailed}
        </Text>
      </If>
      <If when={!snapshot().settings.wizard_complete}>
        <View testID="settings-wizard-banner" class="flex-col gap-[2px] px-[14px] py-[10px] bg-warn-bg border border-warn-line rounded-(--radius-md)">
          <Text class="text-[12px] leading-[1.45] text-warn-text">{t().settings.wizardHint}</Text>
          <Text class="text-[12px] leading-[1.45] text-warn-text">{t().settings.wizardIncomplete}</Text>
        </View>
      </If>
    </>
  );

  /** A tab that scrolls as one page: the notices over it, then the tab. */
  const page = (children: () => JSX.Element) => (
    <Scroll class="flex-1 min-h-0">
      <View class={`flex-col gap-[14px] ${phone() ? "px-3 pt-4 pb-7" : "px-6 py-5"}`}>
        {settingsNotices()}
        {children()}
      </View>
    </Scroll>
  );

  const body = () => (
    <View class="flex-1 min-h-0 flex-col">
      <If when={activeTab() === "general"}>
        {page(() => (
          <GeneralTab
            locale={locale()}
            patchImmediate={props.patchImmediate}
            workspaceReadOnly={workspaceReadOnly()}
            fieldErrors={fieldErrors()}
            clearWorkspaceError={() => {
              if (fieldErrors().workspace) fieldErrors.set({ ...fieldErrors(), workspace: undefined });
            }}
            persistWorkspace={persistWorkspace}
            independent={independentRuntime.independent}
            independentBusy={independentRuntime.independentBusy}
            independentReason={(status) => independentRuntime.independentReason(status)}
            requestIndependent={(next) => independentRuntime.requestIndependent(next)}
          />
        ))}
      </If>
      <If when={activeTab() === "behavior" && behaviorTabVisible()}>{page(() => <BehaviorTab />)}</If>
      <If when={activeTab() === "interface" && interfaceTabVisible()}>
        <InterfaceTab snapshot={snapshot()} locale={locale()} phone={!props.workbench} notices={settingsNotices()} controller={(handle) => interfaceHandle.set(handle)} />
      </If>
      <If when={activeTab() === "models"}>
        <ModelsTab
          state={modelsState}
          notices={settingsNotices()}
          endpoints={
            <ProvidersTab
              providerSaving={providerEditorController.providerSaving}
              openAddProvider={() => providerEditorController.openAddProvider()}
              openEditProvider={(id) => providerEditorController.openEditProvider(id)}
              openProviderModels={(id) => providerEditorController.openProviderModels(id)}
              openDeleteProviderConfirm={props.openDeleteProviderConfirm}
              setDefaultProvider={setDefaultProvider}
              setProviderDefaultModel={(id, model) => providerEditorController.setProviderDefaultModel(id, model)}
            />
          }
        />
      </If>
      {/* Agents that run a Bot's turns themselves (ADR 0061, ADR 0079): one line each, opened one at a time. */}
      <If when={activeTab() === "agents"}>
        {page(() => (
          <AgentsTab api={runtime.client} bots={snapshot().bots} controller={(handle) => agentsHandle.set(handle)} />
        ))}
      </If>
      <If when={activeTab() === "mcp"}>
        <View testID="settings-mcp" class={`flex-1 min-h-0 flex-col gap-[14px] ${phone() ? "px-3 pt-[14px] pb-5" : "px-6 py-[18px]"}`}>
          {settingsNotices()}
          <McpSettings closeSettings={props.closeSettings} registerBack={(back) => (mcpBack = back)} />
        </View>
      </If>
      <If when={activeTab() === "prompts"}>
        <PromptsSettings
          items={promptItems()}
          loadFailed={promptsFailed()}
          closeSettings={props.closeSettings}
          openRouting={openRoles}
          notices={settingsNotices()}
          onReady={(api) => promptsHandle.set(api)}
        />
      </If>
      <If when={activeTab() === "notifications"}>{page(() => <NotificationSettings />)}</If>
      <If when={activeTab() === "lessons" && lessonsTabVisible()}>
        {page(() => (
          <LessonsSettings lessons={lessons()} onPatch={(id, patch) => runtime.client!.patchLesson(id, patch)} />
        ))}
      </If>
      <If when={activeTab() === "remote" && remoteTabVisible()}>
        {page(() => (
          <RemoteTab
            locale={locale()}
            relativeTimeNow={relativeTimeNow()}
            pairingCopied={pairingCopied()}
            onPairingCopiedChange={(copied) => pairingCopied.set(copied)}
            relayForm={relayForm()}
            onRelayFormChange={(form) => relayForm.set(form)}
            relayInvalid={relayInvalid()}
            connectRelay={connectRelay}
          />
        ))}
      </If>
      <If when={activeTab() === "about"}>{page(() => <AboutTab locale={locale()} />)}</If>
    </View>
  );

  const main = () => (
    <View testID="settings-main" role="region" accessibilityLabel={mainTitle()} class="flex-1 min-w-0 min-h-0 flex-col bg-pane">
      <View class={`flex-row items-center justify-between shrink-0 border-b border-line bg-pane ${phone() ? "h-14 pl-2 pr-3 gap-1" : "h-14 px-6 gap-3"}`}>
        <If when={phone()}>
          <IconButton icon="chevron-left" size="lg" label={en() ? "Back to settings" : "返回设置"} testID="settings-mobile-back" onPress={() => void backWithinSettings()} />
        </If>
        <View class={`flex-1 min-w-0 flex-row items-center ${phone() ? "justify-center" : "justify-between gap-5"}`}>
          <Text role="header" testID="settings-main-title" class={`text-ink line-clamp-1 ${phone() ? "text-[16px] font-semibold" : "text-[16px] font-semibold"}`}>
            {mainTitle()}
          </Text>
          <If when={!phone()}>
            <AutosaveState saving={settingsSaving()} failed={props.saveFailed} saved={settingsSavedTick() > 0} />
          </If>
        </View>
        <IconButton icon="x" size={phone() ? "lg" : "sm"} label={t().common.close} testID="settings-close" onPress={closeCurrentPage} />
      </View>
      {body()}
    </View>
  );

  const nav = () => (
    <SettingsNav
      activeSettingsTab={activeTab()}
      openSettingsTab={openSettingsTab}
      generalHasError={generalHasError()}
      modelsHasError={modelsHasError()}
      promptCounts={promptCounts()}
      lessonsTabVisible={lessonsTabVisible()}
      remoteTabVisible={remoteTabVisible()}
      behaviorTabVisible={behaviorTabVisible()}
      interfaceTabVisible={interfaceTabVisible()}
      closeSettings={props.closeSettings}
    />
  );

  /** Neither backdrop closes while the endpoint editor or a confirmation is up over the window. */
  const closable = () => !providerEditor() && !props.confirmingProvider && !props.confirmingIndependent;
  const width = () => (phone() ? windowSize().width : Math.min(880, Math.round(windowSize().width * 0.94)));
  const height = () => (phone() ? windowSize().height : Math.min(640, Math.round(windowSize().height * 0.88)));

  return (
    <>
      <If when={runtime.settingsOpen}>
        <Dialog
          open
          animation="fade"
          closeOnEscape={closable()}
          closeOnBackdropPress={closable()}
          onCancel={() => {
            if (closable()) props.closeSettings();
          }}
          onOpenChange={(e) => {
            if (!e.open && closable()) props.closeSettings();
          }}
          backdropClass={phone() ? "bg-pane" : "bg-modal-backdrop"}
          class={`m-auto bg-pane overflow-hidden ${phone() ? "" : "rounded-(--radius-xl) border border-line"}`}
          style={{
            width: width(),
            height: height(),
            boxShadow: phone() ? undefined : "0 24px 56px -12px rgba(18, 28, 32, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.05)",
          }}
        >
          <View testID="settings-modal" role="group" accessibilityLabel={t().settings.title} class="flex-1 min-h-0 flex-row">
            <If when={phone()} else={<>{nav()}{main()}</>}>
              <If when={mobileDetail()} else={nav()}>
                {main()}
              </If>
            </If>
          </View>
        </Dialog>
      </If>
      <ProviderEditorFlyout
        providerEditor={providerEditor()}
        providerDetailModel={providerEditorController.providerDetailModel}
        onProviderDetailModelChange={(model) => (providerEditorController.providerDetailModel = model)}
        providerSaving={providerEditorController.providerSaving}
        providerSavedTick={providerEditorController.providerSavedTick}
        pendingCredentials={pendingCredentials()}
        backFromProviderEditor={backFromProviderEditor}
        closeProviderEditor={() => providerEditorController.closeProviderEditor()}
        editorKeySet={(target) => providerEditorController.editorKeySet(target)}
        setProviderDraft={(draft) => providerEditorController.setProviderDraft(draft)}
        pickConnector={(id) => providerEditorController.pickConnector(id)}
        fetchProviderModels={() => providerEditorController.fetchProviderModels()}
        persistProviderEditor={(editor) => providerEditorController.persistProviderEditor(editor)}
        measure={(target, model) => runtime.speedTest(target, model)}
      />
      <IndependentConfirm
        independent={independentRuntime.independent}
        independentConfirm={independentRuntime.independentConfirm}
        independentReason={(status) => independentRuntime.independentReason(status)}
        confirmIndependent={() => independentRuntime.confirmIndependent()}
        waitIndependent={() => independentRuntime.waitIndependent()}
        forceIndependent={() => independentRuntime.forceIndependent()}
        cancelIndependent={() => independentRuntime.cancelIndependent()}
      />
    </>
  );
}
