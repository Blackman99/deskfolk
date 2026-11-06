/**
 * A Bot's settings (`ProfilePane.svelte`): the basics, its skills, routines, memory and actions, one
 * tab at a time under a tab strip. On a phone it is two screens, as the settings page is: the
 * sections as a list, and one section on top of it (`mobileDetail`, which the shell holds so its
 * Back unwinds the section before it closes the drawer).
 *
 * The Svelte pane is keyed on the Bot by the shell, so a fresh mount is the reset: the drafts are
 * read from `bot` once. The exported `backFromEditor()` and `backFromDetail()` are `onHandle` here,
 * called once when the pane is built; `bind:mobileDetail` and `bind:profileFailed` are the value
 * plus `onMobileDetailChange` and `onProfileFailedChange`.
 */
import { Scroll, Text, View, cleanup, computed, effect, signal, untracked } from "nsh";
import type { AgentsStatusResponse, Bot, ClaudeCodeStatus, Skill } from "@real-bot/protocol";
import { Autosave } from "../../m/autosave.svelte";
import { findPicked, type PickerData } from "../../m/model-picker";
import { endpointSource } from "../../m/model-source";
import type { DangerAction } from "../../m/overlays/danger-confirm";
import {
  emptySkillDraft,
  endpointModelPicker,
  formatSkillUses,
  mapCreateBotError,
  mapSkillError,
  pickerValues,
  planCreateBot,
  planSkill,
  reconcileSkillDraft,
  skillDraftDirty,
  type CreateBotFieldErrors,
  type SkillDraft,
  type SkillFieldErrors,
} from "../../m/panels/create-form";
import { profileDraftDirty, profileNeedsSave, reconcileProfileDraft, type ProfileFields } from "../../m/panels/roster-edit";
import { runnerValueOf } from "../../m/runner-choice";
import { modelSelectValue } from "../../m/settings/provider-form";
import { copy, runtime } from "../../runtime";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { BotActionsCard } from "./BotActionsCard";
import { BotTabNav, type BotTab } from "./BotTabNav";
import { MemoryCard, type MemoryCardApi } from "./MemoryCard";
import { ProfileBasics } from "./ProfileBasics";
import { RoutineCard, type RoutineCardApi } from "./RoutineCard";
import { SettingsSubject } from "./SettingsSubject";
import { SharedSkillsCard } from "./SharedSkillsCard";
import { SkillEditor } from "./SkillEditor";
import { SkillsCard } from "./SkillsCard";
import { PANEL_COUNTER } from "./panel-card";

export type { BotTab };

/** What the shell calls on the pane (the Svelte component's exported methods). */
export type ProfilePaneApi = {
  /** A skill sheet, routine page or memory page is closed first; says whether one was. */
  backFromEditor: () => boolean;
  /** On a phone, from a section back to the list; says whether it was open. */
  backFromDetail: () => boolean;
};

function botModelValue(row: Bot): string {
  if (!row.model) return "";
  if (row.provider_id) return modelSelectValue(row.provider_id, row.model);
  const match = runtime.snapshot.providers.find((p) => p.models.includes(row.model!));
  return match ? modelSelectValue(match.id, row.model) : row.model;
}

function profileOf(row: Bot): ProfileFields {
  return {
    name: row.name,
    duties: row.duties,
    boundaries: row.boundaries,
    avatar: row.avatar ?? "",
    model: botModelValue(row),
    thinkingLevel: row.thinking_level ?? "",
    runner: runnerValueOf(row.runner, row.agent_custom_id),
    agentModel: row.agent_model ?? "",
    agentEffort: row.agent_effort ?? "",
    // Left out of the save for a daemon that has no accounts, which would refuse the field.
    agentConfigDir: row.agent_config_dir === undefined ? undefined : (row.agent_config_dir ?? ""),
    // Likewise for a daemon from before permission modes (ADR 0092).
    permissionMode: row.permission_mode === undefined ? undefined : (row.permission_mode ?? ""),
  };
}

export function ProfilePane(props: {
  /** Keyed on by the shell, so switching Bots remounts this pane rather than reconciling. */
  bot: Bot;
  selectedKind: string | null;
  /** The shell's delete writes this too, so it stays there. */
  profileFailed: boolean;
  onProfileFailedChange: (failed: boolean) => void;
  /** Phone only: a section is open on top of the list. The shell owns it so Back can unwind it. */
  mobileDetail?: boolean;
  onMobileDetailChange?: (open: boolean) => void;
  initialTab?: BotTab;
  openDangerConfirm: (kind: "skill" | "memory", run: DangerAction) => void;
  clearDanger: (kind: "skill" | "memory") => void;
  onDeleteBot: () => void;
  onClearHistory: () => void;
  onHandle?: (api: ProfilePaneApi) => void;
}) {
  const t = () => copy();
  /** The Bot's id never changes (the shell keys the pane on it); `props.bot` is the live row. */
  const botId = props.bot.id;
  const snapshot = () => runtime.snapshot;
  const setFailed = (failed: boolean) => props.onProfileFailedChange(failed);
  const setMobileDetail = (open: boolean) => props.onMobileDetailChange?.(open);

  const listedModels = computed(() => endpointModelPicker(snapshot().providers, t()));
  /**
   * A pin no endpoint lists any more: from engine level 7 it outlives the list (ADR 0048), the turn
   * runs on the endpoint's default meanwhile. Offered as it is and marked, so the rest of the profile
   * still saves and the pin is not lost by touching it.
   */
  const unlistedPin = computed(() => {
    const value = botModelValue(props.bot);
    return value && !findPicked(listedModels(), value) ? value : null;
  });
  const profileModelPicker = computed((): PickerData => {
    const pin = unlistedPin();
    const model = props.bot.model;
    if (!pin || !model) return listedModels();
    const endpoint = snapshot().providers.find((provider) => provider.id === props.bot.provider_id);
    const row = { value: pin, label: model, hint: t().sidebar.botModelUnlisted, ...(endpoint ? { detail: endpoint.name, mark: endpointSource(endpoint, t()) } : {}) };
    return { ...listedModels(), specials: [...listedModels().specials, row] };
  });
  const modelValues = () => pickerValues(profileModelPicker());
  const profileSkills = computed((): readonly Skill[] => snapshot().skills.filter((skill) => skill.bot_id === botId));
  const profileMemories = computed(() => snapshot().memories.filter((m) => m.bot_id === botId));
  const routineCount = computed(() => snapshot().routines.filter((row) => row.bot_id === botId).length);

  const profileDraft = signal<ProfileFields>(profileOf(props.bot));
  const profileBaseline = signal<ProfileFields>(profileOf(props.bot));
  const profileErrors = signal<CreateBotFieldErrors>({});
  /** `saving`, and `savedTick`, bumped on every accepted save so the header can say 「已自动保存」. */
  const autosave = new Autosave();
  let profileSaveQueued = false;
  /** Cleared on unmount: a save that fails after the pane is gone must not flag the next one. */
  let mounted = true;

  const skillEditor = signal<"add" | string | null>(null);
  const skillDraft = signal<SkillDraft>(emptySkillDraft());
  const skillBaseline = signal<SkillDraft>(emptySkillDraft());
  const skillErrors = signal<SkillFieldErrors>({});
  const skillFailed = signal(false);
  const skillBusy = signal(false);

  /** What the daemon finds of your own Claude Code (ADR 0061); null until asked, or away from the computer. */
  const claudeStatus = signal<ClaudeCodeStatus | null>(null);
  const claudeChecking = signal(false);
  const claudeUnavailable = signal(false);

  async function checkClaudeCode(): Promise<void> {
    const client = runtime.client;
    if (!client || claudeChecking()) return;
    claudeChecking.set(true);
    try {
      claudeStatus.set(await client.claudeCode());
      claudeUnavailable.set(false);
    } catch {
      claudeUnavailable.set(true);
    } finally {
      claudeChecking.set(false);
    }
  }

  // Asked once the Bot runs on Claude Code, or when you pick it: never for a Bot that does not.
  effect(() => {
    if (profileDraft().runner === "claude_code" && !claudeStatus() && !claudeUnavailable()) void untracked(() => checkClaudeCode());
  });

  /** What the daemon finds of your other local agents (ADR 0079): the runner picker lists them, so it is asked once, on opening. */
  const agents = signal<AgentsStatusResponse | null>(null);
  const agentsUnavailable = signal(false);

  async function checkAgents(): Promise<void> {
    const client = runtime.client;
    if (!client) return;
    try {
      agents.set(await client.agents());
      agentsUnavailable.set(false);
    } catch {
      // The phone, or a daemon older than local agents: only the app's loop and Claude are offered.
      agentsUnavailable.set(true);
    }
  }
  void checkAgents();

  // Closing the drawer or switching Bots unmounts this pane; a pending autosave goes out first.
  cleanup(() => {
    flushProfileSave();
    mounted = false;
  });

  /** Server-side edits (a Bot changing its own profile) land in the draft unless you are editing. */
  effect(() => {
    const live = snapshot().bots.find((row) => row.id === botId);
    if (!live) {
      runtime.closeProfile();
      return;
    }
    const next = reconcileProfileDraft(profileDraft(), profileBaseline(), profileOf(live));
    if (profileDraftDirty(profileDraft(), next.draft)) profileDraft.set(next.draft);
    if (profileDraftDirty(profileBaseline(), next.baseline)) profileBaseline.set(next.baseline);
    const editing = skillEditor();
    if (editing && editing !== "add") {
      const liveSkill = snapshot().skills.find((skill) => skill.id === editing);
      if (!liveSkill || liveSkill.bot_id !== live.id) {
        closeSkillEditor();
      } else {
        const incomingSkill = {
          name: liveSkill.name,
          description: liveSkill.description,
          body: liveSkill.body,
          uses: formatSkillUses(liveSkill.uses),
          enabled: liveSkill.enabled,
        };
        const nextSkill = reconcileSkillDraft(skillDraft(), skillBaseline(), incomingSkill);
        if (skillDraftDirty(skillDraft(), nextSkill.draft)) skillDraft.set(nextSkill.draft);
        if (skillDraftDirty(skillBaseline(), nextSkill.baseline)) skillBaseline.set(nextSkill.baseline);
      }
    }
  });

  function closeSkillEditor(): void {
    skillEditor.set(null);
    skillDraft.set(emptySkillDraft());
    skillBaseline.set(emptySkillDraft());
    skillErrors.set({});
    skillFailed.set(false);
    skillBusy.set(false);
    props.clearDanger("skill");
  }

  function openAddSkill(): void {
    skillEditor.set("add");
    skillDraft.set(emptySkillDraft());
    skillBaseline.set(emptySkillDraft());
    skillErrors.set({});
    skillFailed.set(false);
  }

  function openEditSkill(id: string): void {
    const skill = snapshot().skills.find((row) => row.id === id);
    if (!skill) return;
    skillEditor.set(id);
    const draft = { name: skill.name, description: skill.description, body: skill.body, uses: formatSkillUses(skill.uses), enabled: skill.enabled };
    skillDraft.set(draft);
    skillBaseline.set({ ...draft });
    skillErrors.set({});
    skillFailed.set(false);
  }

  async function saveSkill(): Promise<void> {
    const editing = skillEditor();
    if (!editing) return;
    skillFailed.set(false);
    skillErrors.set({});
    const plan = planSkill(skillDraft());
    if (!plan.ok) {
      skillErrors.set(plan.errors);
      return;
    }
    skillBusy.set(true);
    const error = editing === "add" ? await runtime.createSkill({ bot_id: botId, ...plan.body }) : await runtime.patchSkill(editing, plan.body);
    skillBusy.set(false);
    if (!error) {
      closeSkillEditor();
      return;
    }
    const mapped = mapSkillError(error.status, error.message);
    if ("top" in mapped) skillFailed.set(true);
    else skillErrors.set(mapped);
  }

  async function toggleSkillEnabled(id: string, enabled: boolean): Promise<void> {
    skillFailed.set(false);
    const error = await runtime.patchSkill(id, { enabled });
    if (error) skillFailed.set(true);
  }

  function openDeleteSkillConfirm(id: string): void {
    props.openDangerConfirm("skill", (isCurrent) => deleteSkillRow(id, isCurrent));
  }

  async function deleteSkillRow(skillId: string, isCurrent: () => boolean): Promise<void> {
    skillFailed.set(false);
    const error = await runtime.deleteSkill(skillId);
    if (!isCurrent()) return;
    if (error) {
      skillFailed.set(true);
      return;
    }
    if (skillEditor() === skillId) closeSkillEditor();
    props.clearDanger("skill");
  }

  function onProfileInput(): void {
    profileErrors.set({});
    setFailed(false);
    scheduleProfileSave();
  }

  /** Picks (model, thinking level, avatar) are deliberate, so they save almost at once. */
  function onProfilePick(): void {
    profileErrors.set({});
    setFailed(false);
    scheduleProfileSave(120);
  }

  function scheduleProfileSave(delay = 600): void {
    autosave.schedule(() => void saveProfile(), delay);
  }

  /** Sends a pending autosave now: on close, on switching Bots, or when the panel goes away. */
  function flushProfileSave(): void {
    if (!autosave.cancel()) return;
    void saveProfile();
  }

  async function saveProfile(): Promise<void> {
    if (autosave.saving) {
      profileSaveQueued = true;
      return;
    }
    const sent: ProfileFields = { ...untracked(profileDraft) };
    if (!profileNeedsSave(sent, untracked(profileBaseline))) return;
    const plan = planCreateBot(sent, untracked(modelValues));
    if (!plan.ok) {
      profileErrors.set(plan.errors);
      return;
    }
    autosave.saving = true;
    setFailed(false);
    profileErrors.set({});
    const error = await runtime.patchBot(botId, plan.body);
    autosave.saving = false;
    if (!error) {
      profileBaseline.set(sent);
      autosave.savedTick += 1;
    } else if (mounted) {
      const mapped = mapCreateBotError(error.status, error.message);
      if ("top" in mapped) setFailed(true);
      else profileErrors.set(mapped);
    }
    if (profileSaveQueued) {
      profileSaveQueued = false;
      void saveProfile();
    }
  }

  async function archiveProfile(): Promise<void> {
    setFailed(false);
    const error = await runtime.archiveBot(botId);
    if (error) setFailed(true);
  }

  async function restoreProfile(): Promise<void> {
    setFailed(false);
    const error = await runtime.restoreBot(botId);
    if (error) setFailed(true);
  }

  const activeTab = signal<BotTab>(props.initialTab ?? "basics");

  // A routine opened from search carries its own tab; the card only reads the
  // pending id once it is mounted.
  effect(() => {
    if (runtime.profileRoutineId)
      untracked(() => {
        activeTab.set("routines");
        if (narrowWindow()) setMobileDetail(true);
      });
  });

  const basicsHasError = () => {
    const e = profileErrors();
    return Boolean(e.name || e.duties || e.boundaries || e.model || e.thinkingLevel || e.agentModel || e.agentEffort || e.agentConfigDir || e.agentCustomId);
  };

  function switchTab(tab: BotTab): void {
    // On a phone the row is how you enter the section, so tapping the current one still opens it.
    if (narrowWindow()) setMobileDetail(true);
    if (activeTab() === tab) return;
    flushProfileSave();
    activeTab.set(tab);
  }

  /**
   * A skill sheet, routine page, or memory page sits on top of this section. Back closes that before it
   * leaves the section. A save in flight stays put.
   */
  const routineCard = signal<RoutineCardApi | null>(null);
  let memoryCard: MemoryCardApi | null = null;
  function backFromEditor(): boolean {
    if (skillEditor()) {
      if (!skillBusy()) closeSkillEditor();
      return true;
    }
    if (routineCard()?.backFromEditor()) return true;
    if (memoryCard?.backFromEditor()) return true;
    return false;
  }

  /** The shell's Back button and the browser's both come through here first. */
  function backFromDetail(): boolean {
    if (!props.mobileDetail) return false;
    flushProfileSave();
    setMobileDetail(false);
    return true;
  }
  props.onHandle?.({ backFromEditor, backFromDetail });

  const tabLabel = (tab: BotTab) =>
    tab === "basics"
      ? t().detail.botTabBasics
      : tab === "skills"
        ? t().detail.botTabSkills
        : tab === "routines"
          ? t().detail.botTabRoutines
          : tab === "memory"
            ? t().detail.botTabMemory
            : t().detail.botTabActions;

  const phone = () => narrowWindow();
  const showList = () => !phone() || !props.mobileDetail;
  const showDetail = () => !phone() || props.mobileDetail === true;
  const nav = () => (
    <BotTabNav
      activeTab={activeTab()}
      basicsHasError={basicsHasError()}
      profileSkills={profileSkills()}
      routineCount={routineCount()}
      profileMemories={profileMemories()}
      switchTab={switchTab}
    />
  );

  return (
    <View testID="profile-pane" class="flex-1 min-h-0 overflow-hidden">
      <If when={showList()}>
        <If
          when={phone()}
          else={<View testID="bot-nav" class="shrink-0 bg-sidebar-bg border-b border-line">{nav()}</View>}
        >
          <Scroll testID="bot-nav" class="flex-1 bg-sidebar-bg">
            <View class="px-3 pt-[14px] pb-6">{nav()}</View>
          </Scroll>
        </If>
      </If>

      <If when={showDetail()}>
        <View testID="bot-detail" class="flex-1 min-h-0 bg-bg">
          {/* Phone only: the section's own header. Wider windows keep the tab strip. */}
          <If when={phone()}>
            <View testID="bot-detail-head" class="flex-row items-center gap-1 shrink-0 min-h-[56px] pl-1 pr-3 bg-pane border-b border-line">
              <View
                role="button"
                testID="bot-detail-back"
                accessibilityLabel={t().detail.backToSections}
                onPress={() => backFromDetail()}
                class="w-[44px] h-[44px] items-center justify-center rounded-(--radius-md) shrink-0 active:bg-row-hover"
              >
                <Icon name="chevron-left" size={20} class="tint-brand" />
              </View>
              <View class="flex-1 min-w-0 gap-[1px]">
                <View class="flex-row items-center min-w-0">
                  <Text role="header" testID="bot-detail-title" class="text-[16px] font-semibold text-ink">{tabLabel(activeTab())}</Text>
                  <If when={activeTab() === "skills" || activeTab() === "routines" || activeTab() === "memory"}>
                    <View class={`${PANEL_COUNTER} ml-1 shrink-0`}>
                      <Text class="text-[11px] font-semibold text-ink-secondary">
                        {String(activeTab() === "skills" ? profileSkills().length : activeTab() === "routines" ? routineCount() : profileMemories().length)}
                      </Text>
                    </View>
                  </If>
                </View>
                <SettingsSubject variant="line" bot={props.bot} />
              </View>
              <If when={activeTab() === "skills"}>
                <View role="button" testID="bot-detail-action" onPress={openAddSkill} class="flex-row items-center gap-1 shrink-0 h-[40px] px-[10px] rounded-(--radius-md) active:bg-row-hover">
                  <Icon name="plus" class="tint-brand" />
                  <Text class="text-[15px] font-semibold text-brand">{t().sidebar.skillAdd}</Text>
                </View>
              </If>
              <If when={activeTab() === "routines"}>
                <View
                  role="button"
                  testID="bot-detail-action"
                  accessibilityState={{ disabled: !routineCard()?.canAdd() }}
                  onPress={() => {
                    if (routineCard()?.canAdd()) routineCard()?.addRoutine();
                  }}
                  class={`flex-row items-center gap-1 shrink-0 h-[40px] px-[10px] rounded-(--radius-md) active:bg-row-hover ${routineCard()?.canAdd() ? "" : "opacity-[0.45]"}`}
                >
                  <Icon name="plus" class="tint-brand" />
                  <Text class="text-[15px] font-semibold text-brand">{t().routines.add}</Text>
                </View>
              </If>
            </View>
          </If>

          <Scroll class="flex-1 min-h-0">
            <View class={`flex-col gap-8 ${phone() ? "pt-4 px-3 pb-7" : "pt-8 px-9 pb-12"}`}>
              <If when={props.profileFailed}>
                <View role="alert" testID="profile-failed" class="flex-row items-center gap-2 px-[14px] py-[10px] rounded-(--radius-md) bg-danger-bg border border-danger-line">
                  <Icon name="alert-circle" class="tint-danger-text" />
                  <Text class="text-[13px] font-medium text-danger-text">{t().sidebar.saveFailed}</Text>
                </View>
              </If>

              <If when={activeTab() === "basics"}>
                <ProfileBasics
                  profileDraft={profileDraft()}
                  onProfileDraftChange={(next) => profileDraft.set(next)}
                  profileErrors={profileErrors()}
                  profileSaving={autosave.saving}
                  profileFailed={props.profileFailed}
                  profileSavedTick={autosave.savedTick}
                  profileModelPicker={profileModelPicker()}
                  unlistedPin={unlistedPin()}
                  claudeStatus={claudeStatus()}
                  claudeUnavailable={claudeUnavailable()}
                  agents={agents()}
                  agentsUnavailable={agentsUnavailable()}
                  onProfileInput={onProfileInput}
                  onProfilePick={onProfilePick}
                />
              </If>
              <If when={activeTab() === "skills"}>
                <SkillsCard
                  profileSkills={profileSkills()}
                  skillEditor={skillEditor()}
                  skillFailed={skillFailed()}
                  openAddSkill={openAddSkill}
                  openEditSkill={openEditSkill}
                  toggleSkillEnabled={toggleSkillEnabled}
                  openDeleteSkillConfirm={openDeleteSkillConfirm}
                />
                <SharedSkillsCard api={runtime.client} botId={botId} skills={profileSkills()} />
              </If>
              <If when={activeTab() === "routines"}>
                <RoutineCard bot={props.bot} onApi={(api) => routineCard.set(api)} />
              </If>
              <If when={activeTab() === "memory"}>
                <MemoryCard bot={props.bot} openDangerConfirm={props.openDangerConfirm} clearDanger={props.clearDanger} onApi={(api) => (memoryCard = api)} />
              </If>
              <If when={activeTab() === "actions"}>
                <BotActionsCard
                  bot={props.bot}
                  selectedKind={props.selectedKind}
                  archiveProfile={archiveProfile}
                  restoreProfile={restoreProfile}
                  onDeleteBot={props.onDeleteBot}
                  onClearHistory={props.onClearHistory}
                />
              </If>
            </View>
          </Scroll>
        </View>
      </If>

      <SkillEditor
        bot={props.bot}
        skillEditor={skillEditor()}
        skillDraft={skillDraft()}
        onDraftChange={(next) => skillDraft.set(next)}
        skillErrors={skillErrors()}
        skillFailed={skillFailed()}
        skillBusy={skillBusy()}
        closeSkillEditor={closeSkillEditor}
        saveSkill={saveSkill}
        openDeleteSkillConfirm={openDeleteSkillConfirm}
      />
    </View>
  );
}
