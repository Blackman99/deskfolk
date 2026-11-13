/**
 * The basics tab (`ProfileBasics.svelte`): avatar, name, duties, boundaries, permission mode, who
 * runs the Bot's turns (the app on an endpoint, Claude Code, another local agent), its model and
 * thinking level. The draft and its autosave belong to ProfilePane, which outlives a tab switch.
 *
 * `bind:profileDraft` is `profileDraft` + `onProfileDraftChange` (the change goes out whole, and
 * `onProfileInput` / `onProfilePick` follow it as in the Svelte component: typing, and a pick).
 */
import { Input } from "nsh/base";
import { Text, View, effect, untracked, type JSX } from "nsh";
import { AGENT_KINDS, DEFAULT_PERMISSION_MODE, PERMISSION_MODES, isAgentEffort, isPermissionMode, type AgentsStatusResponse, type ClaudeCodeStatus } from "@real-bot/protocol";
import { claudeModelsOf, effortChoices, loadClaudeModels } from "../../m/claude-models.svelte";
import { thinkingLevelLabel } from "../../m/copy";
import type { PickerData } from "../../m/model-picker";
import { agentModelPicker, applyModelPin, botNameErrorCopy, claudeModelPicker, pinnableThinkingLevels, type CreateBotFieldErrors } from "../../m/panels/create-form";
import type { ProfileFields } from "../../m/panels/roster-edit";
import {
  agentAccountOptions as otherAgentAccountOptions,
  agentAccountsOf,
  agentLabelOf,
  agentStatusOf,
  parseRunnerValue,
  runnerOptions,
  runnerValueOf,
} from "../../m/runner-choice";
import { claudeAccountLabel, claudeAccountOf, claudeAgentBlocker, claudeAgentPaysPerToken } from "../../m/settings/claude-agent";
import { copy, runtime } from "../../runtime";
import { AvatarEditor } from "../AvatarEditor";
import { ModelPicker } from "../ModelPicker";
import { Select } from "../Select";
import { FIELD, FIELD_ERROR, PANEL_CARD, PANEL_CARD_BODY, PANEL_CARD_HEAD, PANEL_CARD_TITLE, PANEL_SECTION } from "./panel-card";

/** A form row: its label, the control, the hints under it. */
function Group(props: { testID?: string; children: JSX.Element }) {
  return (
    <View testID={props.testID} class="flex-col gap-[5px] mt-3">
      {props.children}
    </View>
  );
}

const Label = (props: { children: string }) => <Text class="text-[12px] font-semibold text-ink-secondary">{props.children}</Text>;
const Hint = (props: { testID?: string; warn?: boolean; children: string }) => (
  <Text testID={props.testID} class={`text-[12px] leading-[1.4] ${props.warn ? "text-ink-secondary" : "text-ink-muted"}`}>{props.children}</Text>
);
const Err = (props: { testID?: string; children: string }) => (
  <Text role="alert" testID={props.testID} class={FIELD_ERROR}>{props.children}</Text>
);

function LevelChip(props: { testID: string; active: boolean; label: string; onPress: () => void }) {
  return (
    <View
      role="radio"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.active }}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none px-[11px] py-[5px] rounded-(--radius-sm) border ${props.active ? "bg-brand border-brand" : "bg-chip border-line hover:border-accent-border hover:bg-accent-tint"}`}
    >
      <Text class={`text-[12px] ${props.active ? "font-medium text-on-accent" : "text-ink-secondary"}`}>{props.label}</Text>
    </View>
  );
}

export function ProfileBasics(props: {
  profileDraft: ProfileFields;
  /** The Svelte `bind:profileDraft`: the change goes out whole. */
  onProfileDraftChange: (draft: ProfileFields) => void;
  profileErrors: CreateBotFieldErrors;
  profileSaving: boolean;
  profileFailed: boolean;
  profileSavedTick: number;
  /** The endpoints' models, with a pin no endpoint lists any more kept as a row of its own. */
  profileModelPicker: PickerData;
  unlistedPin: string | null;
  claudeStatus: ClaudeCodeStatus | null;
  claudeUnavailable: boolean;
  /** What the daemon finds of your other local agents (ADR 0079); null until asked, or away from the computer. */
  agents?: AgentsStatusResponse | null;
  agentsUnavailable?: boolean;
  onProfileInput: () => void;
  onProfilePick: () => void;
  /** Edge to edge, with no gutter round it (ProfilePane on a wider window). */
  flush?: boolean;
}) {
  const t = () => copy();
  const draft = () => props.profileDraft;
  const snapshot = () => runtime.snapshot;
  const set = (change: Partial<ProfileFields>) => props.onProfileDraftChange({ ...props.profileDraft, ...change });
  /** A change from a pick: the draft, then the autosave. */
  const pick = (change: Partial<ProfileFields>) => {
    set(change);
    props.onProfilePick();
  };
  /** A change from typing. */
  const type = (change: Partial<ProfileFields>) => {
    set(change);
    props.onProfileInput();
  };

  const thinkingOptions = () => pinnableThinkingLevels(draft().model, snapshot().providers);

  // Its own permission mode, or the app's (ADR 0092). Only you set it; a Bot never does.
  const appPermissionMode = () => snapshot().settings.permission_mode ?? DEFAULT_PERMISSION_MODE;
  const permissionChoices = () => [
    { value: "", label: t().permissions.follow(t().permissions.modes[appPermissionMode()]) },
    ...PERMISSION_MODES.map((mode) => ({ value: mode, label: t().permissions.modes[mode] })),
  ];
  const effectivePermission = () => (isPermissionMode(draft().permissionMode) ? (draft().permissionMode as keyof ReturnType<typeof t>["permissions"]["descriptions"]) : appPermissionMode());
  function onPermissionChange(value: string): void {
    if ((draft().permissionMode ?? "") === value) return;
    pick({ permissionMode: value });
  }

  const runnerChoices = () => runnerOptions(t(), props.agents ?? null, draft().runner ?? "");
  const runnerPick = () => parseRunnerValue(draft().runner);
  /** The local agent other than Claude this Bot runs on, when it does. */
  const agentRunner = () => (runnerPick().runner && runnerPick().runner !== "claude_code" ? runnerPick().runner : null);
  const agentKind = () => (agentRunner() ? AGENT_KINDS[agentRunner()!] : null);
  const agentStatus = () => (agentRunner() ? agentStatusOf(props.agents ?? null, agentRunner()!, runnerPick().customId) : null);
  const agentName = () => (agentRunner() ? agentLabelOf(agentRunner()!, runnerPick().customId, props.agents ?? null) : "");
  const agentEfforts = () => agentKind()?.efforts ?? [];
  const agentAccounts = () => agentAccountsOf(agentStatus());
  /** The account it runs on, when that is one listed; the daemon's own environment while none is picked. */
  const agentAccount = () => agentAccounts().find((account) => account.config_dir === (draft().agentConfigDir || null)) ?? null;
  const agentBlockerNow = (): "missing" | "signed_out" | null => {
    const status = agentStatus();
    if (!status) return null;
    if (!status.path) return "missing";
    const account = agentAccount();
    return (account ? account.logged_in : status.logged_in) === false ? "signed_out" : null;
  };
  const otherLoginCommand = () => agentAccount()?.login_command ?? agentStatus()?.login_command ?? null;
  const agentAuth = () => agentAccount()?.auth ?? agentStatus()?.auth ?? null;
  const agentOtherAccountOptions = () => otherAgentAccountOptions(agentStatus(), draft().agentConfigDir ?? "", t());

  /** Claude Code's own models for the account the Bot spends, asked for once Claude Agent is picked; the levels the picked one takes. */
  const claudeAccount = () => draft().agentConfigDir || null;
  effect(() => {
    const api = runtime.client;
    const dir = claudeAccount();
    if (draft().runner === "claude_code") untracked(() => loadClaudeModels(api, dir));
  });
  const claudeModels = () => claudeModelsOf(claudeAccount());
  const claudeModelData = () => claudeModelPicker(t(), draft().agentModel ?? "", claudeModels());
  /** A level set already that the model does not take stays a choice, so it reads and can be cleared. */
  const claudeEfforts = (): string[] => {
    const levels: string[] = [...effortChoices(claudeModels(), draft().agentModel ?? "")];
    const effort = draft().agentEffort ?? "";
    return effort && !levels.includes(effort) ? [...levels, effort] : levels;
  };

  /** The account this Bot's turns spend, as Claude Code reports it; the daemon's own while none is picked. */
  const agentSignIn = () => claudeAccountOf(props.claudeStatus, draft().agentConfigDir) ?? props.claudeStatus;
  /** What signs a listed account in, when that is the one picked. */
  const agentLoginCommand = () =>
    draft().agentConfigDir ? (props.claudeStatus?.accounts?.find((entry) => entry.config_dir === draft().agentConfigDir)?.login_command ?? null) : null;
  const agentAccountOptions = () => {
    const status = props.claudeStatus;
    const own = status && status.path ? claudeAccountOf(status, null) : null;
    const options = [{ value: "", label: own && own.logged_in !== false ? `${t().sidebar.botAgentAccountDefault} · ${claudeAccountLabel(own, t())}` : t().sidebar.botAgentAccountDefault }];
    for (const account of status?.accounts ?? []) {
      if (account.config_dir) options.push({ value: account.config_dir, label: `${claudeAccountLabel(account, t())} · ${account.config_dir}` });
    }
    // On the phone, or listed no more: the account it runs on is still a choice.
    const current = draft().agentConfigDir;
    if (current && !options.some((option) => option.value === current)) options.push({ value: current, label: current });
    return options;
  };

  const onAgentAccountChange = (value: string) => pick({ agentConfigDir: value });

  /**
   * Another agent names its models and accounts its own way, so moving the Bot clears them; an
   * effort stays only where the new agent takes it. The daemon would refuse a model of one agent
   * sent along with another.
   */
  function onRunnerChange(value: string): void {
    const next = parseRunnerValue(value);
    const before = parseRunnerValue(draft().runner);
    const change: Partial<ProfileFields> = { runner: runnerValueOf(next.runner, next.customId) };
    if (before.runner !== next.runner || before.customId !== next.customId) {
      change.agentModel = "";
      if (draft().agentConfigDir !== undefined) change.agentConfigDir = "";
      if (!next.runner || !isAgentEffort(next.runner, draft().agentEffort)) change.agentEffort = "";
    }
    pick(change);
  }

  function onAgentModelChange(value: string): void {
    const change: Partial<ProfileFields> = { agentModel: value };
    // A thinking level the new Claude model does not take goes back to the default with it.
    const effort = draft().agentEffort ?? "";
    if (draft().runner === "claude_code" && effort && !effortChoices(claudeModels(), value).some((level) => level === effort)) change.agentEffort = "";
    pick(change);
  }

  function pickAgentEffort(level: string): void {
    if (draft().agentEffort === level) return;
    pick({ agentEffort: level });
  }

  function onModelChange(value: string): void {
    const pinned = applyModelPin(value, draft().thinkingLevel, snapshot().providers);
    pick({ model: pinned.model, thinkingLevel: pinned.thinkingLevel });
  }

  function pickThinking(level: string): void {
    if (draft().thinkingLevel === level) return;
    pick({ thinkingLevel: level });
  }

  const effortPicker = (levels: readonly string[], hint: string): JSX.Element => (
    <Group testID="profile-agent-effort">
      <Label>{t().sidebar.botAgentEffort}</Label>
      <View role="radiogroup" accessibilityLabel={t().sidebar.botAgentEffort} class="flex-row flex-wrap gap-[6px]">
        {() =>
          ["", ...levels].map((level) => (
            <LevelChip
              testID={`profile-effort-${level || "default"}`}
              active={(draft().agentEffort ?? "") === level}
              label={level ? thinkingLevelLabel(t().sidebar.thinkingLevels, level) : t().sidebar.botAgentEffortDefault}
              onPress={() => pickAgentEffort(level)}
            />
          ))
        }
      </View>
      <Hint>{hint}</Hint>
      <If when={props.profileErrors.agentEffort}>
        <Err testID="profile-effort-error">{t().sidebar.botAgentEffortInvalid}</Err>
      </If>
    </Group>
  );

  /** What the Claude Agent runner reports under its picker. */
  const claudeRunnerHint = (): JSX.Element => {
    const status = props.claudeStatus;
    if (props.claudeUnavailable) return <Hint testID="profile-runner-hint">{t().sidebar.botRunnerClaudeUnavailable}</Hint>;
    if (!status) return <Hint testID="profile-runner-hint">{t().sidebar.botRunnerClaudeChecking}</Hint>;
    const blocker = claudeAgentBlocker(status, agentSignIn());
    if (blocker === "missing") return <Err testID="profile-runner-missing">{t().sidebar.botRunnerClaudeMissing}</Err>;
    if (blocker === "signed_out") {
      const command = agentLoginCommand();
      return <Err testID="profile-runner-signed-out">{command ? t().sidebar.botRunnerClaudeAccountSignedOut(command) : t().sidebar.botRunnerClaudeSignedOut}</Err>;
    }
    return (
      <Text testID="profile-runner-account" class={`text-[12px] leading-[1.4] ${claudeAgentPaysPerToken(agentSignIn()) ? "text-warn-text" : "text-ink-muted"}`}>
        {t().sidebar.botRunnerClaudeHint(claudeAccountLabel(agentSignIn() ?? status, t()))}
      </Text>
    );
  };

  /** What another local agent reports under the picker. */
  const otherRunnerHint = (): JSX.Element => {
    const name = agentName();
    const kind = agentKind()!;
    return (
      <>
        {props.profileErrors.agentCustomId ? (
          <Err testID="profile-runner-hint">{t().sidebar.botRunnerCustomInvalid}</Err>
        ) : props.agentsUnavailable ? (
          <Hint testID="profile-runner-hint">{t().sidebar.botRunnerAgentUnavailable(name)}</Hint>
        ) : !props.agents ? (
          <Hint testID="profile-runner-hint">{t().sidebar.botRunnerAgentChecking(name)}</Hint>
        ) : agentBlockerNow() === "missing" ? (
          <Err testID="profile-runner-missing">{t().sidebar.botRunnerAgentMissing(name, kind.command)}</Err>
        ) : agentBlockerNow() === "signed_out" ? (
          <Err testID="profile-runner-signed-out">{t().sidebar.botRunnerAgentSignedOut(name, otherLoginCommand())}</Err>
        ) : (
          <Hint testID="profile-runner-account">{t().sidebar.botRunnerAgentHint(name, agentAuth())}</Hint>
        )}
        {!kind.appTools ? <Hint testID="profile-runner-note">{t().sidebar.botRunnerNoAppTools(name)}</Hint> : null}
      </>
    );
  };

  return (
    <View testID="profile-basics" class={props.flush ? PANEL_SECTION : PANEL_CARD}>
      <View class={PANEL_CARD_HEAD}>
        <Text class={PANEL_CARD_TITLE}>{t().detail.botBasics}</Text>
        <Text testID="profile-save-state" role="text" class={`text-[12px] ${props.profileFailed ? "text-danger-text" : "text-ink-muted"}`}>
          {props.profileSaving
            ? t().sidebar.autoSaving
            : props.profileFailed
              ? t().sidebar.saveFailed
              : props.profileSavedTick > 0
                ? t().sidebar.autoSaved
                : t().sidebar.autoSaveHint}
        </Text>
      </View>
      <View class={PANEL_CARD_BODY}>
        <View class="pb-[14px] border-b border-line-subtle">
          <AvatarEditor name={draft().name} avatar={draft().avatar} onAvatarChange={(avatar) => set({ avatar })} onChange={props.onProfilePick} />
        </View>

        <Group>
          <Label>{t().sidebar.botName}</Label>
          <Input
            testID="profile-name"
            accessibilityLabel={t().sidebar.botName}
            value={draft().name}
            placeholder={t().sidebar.botName}
            onChange={(e) => type({ name: e.value })}
            class={FIELD}
          />
          <If when={props.profileErrors.name}>
            {(error) => <Err testID="profile-name-error">{botNameErrorCopy(error(), t().sidebar)}</Err>}
          </If>
        </Group>

        <Group>
          <Label>{t().sidebar.botDuties}</Label>
          <Input
            testID="profile-duties"
            accessibilityLabel={t().sidebar.botDuties}
            multiline
            value={draft().duties}
            placeholder={t().sidebar.botDuties}
            onChange={(e) => type({ duties: e.value })}
            class={`${FIELD} min-h-[140px] leading-[1.5]`}
          />
          <If when={props.profileErrors.duties}>
            <Err testID="profile-duties-error">{t().sidebar.dutiesEmpty}</Err>
          </If>
        </Group>

        <Group>
          <Label>{t().sidebar.botBoundaries}</Label>
          <Input
            testID="profile-boundaries"
            accessibilityLabel={t().sidebar.botBoundaries}
            multiline
            value={draft().boundaries}
            placeholder={t().sidebar.botBoundaries}
            onChange={(e) => type({ boundaries: e.value })}
            class={`${FIELD} min-h-[100px] leading-[1.5]`}
          />
          <If when={props.profileErrors.boundaries}>
            <Err testID="profile-boundaries-error">{t().sidebar.boundariesEmpty}</Err>
          </If>
        </Group>

        <If when={draft().permissionMode !== undefined}>
          <Group>
            <Label>{t().permissions.botLabel}</Label>
            <Select testID="profile-permission" ariaLabel={t().permissions.botLabel} value={draft().permissionMode} options={permissionChoices()} onChange={onPermissionChange} />
            <Hint testID="profile-permission-hint">
              {draft().permissionMode
                ? t().permissions.descriptions[effectivePermission()]
                : t().permissions.followHint(t().permissions.descriptions[effectivePermission()])}
            </Hint>
          </Group>
        </If>

        <Group>
          <Label>{t().sidebar.botRunner}</Label>
          <Select
            testID="profile-runner"
            ariaLabel={t().sidebar.botRunner}
            value={draft().runner ?? ""}
            options={runnerChoices()}
            error={!!props.profileErrors.agentCustomId}
            onChange={onRunnerChange}
          />
          <If
            when={draft().runner === "claude_code"}
            else={
              <If when={agentRunner() && agentKind()} else={<Hint testID="profile-runner-hint">{t().sidebar.botRunnerAppHint}</Hint>}>
                {otherRunnerHint()}
              </If>
            }
          >
            {claudeRunnerHint()}
          </If>
        </Group>

        <If
          when={draft().runner === "claude_code"}
          else={
            <If
              when={agentRunner() && agentKind()}
              else={
                <>
                  <Group>
                    <Label>{t().sidebar.botModel}</Label>
                    <ModelPicker
                      testID="profile-model"
                      value={draft().model}
                      data={props.profileModelPicker}
                      placeholder={t().sidebar.botModelDefault}
                      title={t().sidebar.botModel}
                      error={!!props.profileErrors.model}
                      onChange={onModelChange}
                    />
                    <If
                      when={props.profileErrors.model}
                      else={
                        <If when={props.unlistedPin && draft().model === props.unlistedPin} else={<If when={!draft().model}><Hint testID="profile-model-hint">{t().sidebar.botModelAutoHint}</Hint></If>}>
                          <Hint testID="profile-model-hint">{t().sidebar.botModelUnlistedHint}</Hint>
                        </If>
                      }
                    >
                      <Err testID="profile-model-error">{t().sidebar.botModelInvalid}</Err>
                    </If>
                  </Group>
                  <If when={draft().model}>
                    <Group testID="profile-thinking">
                      <Label>{t().sidebar.botThinking}</Label>
                      <View role="radiogroup" accessibilityLabel={t().sidebar.botThinking} class="flex-row flex-wrap gap-[6px]">
                        {() =>
                          thinkingOptions().map((level) => (
                            <LevelChip
                              testID={`profile-thinking-${level}`}
                              active={draft().thinkingLevel === level}
                              label={thinkingLevelLabel(t().sidebar.thinkingLevels, level)}
                              onPress={() => pickThinking(level)}
                            />
                          ))
                        }
                      </View>
                      <Hint>{t().sidebar.botThinkingHint}</Hint>
                      <If when={props.profileErrors.thinkingLevel}>
                        <Err testID="profile-thinking-error">{t().sidebar.botThinkingInvalid}</Err>
                      </If>
                    </Group>
                  </If>
                </>
              }
            >
              <If when={draft().agentConfigDir !== undefined && agentKind()?.configDirVar && agentAccounts().length > 0}>
                <Group testID="profile-agent-account-group">
                  <Label>{t().sidebar.botAgentAccountOf(agentName())}</Label>
                  <Select
                    testID="profile-agent-account"
                    ariaLabel={t().sidebar.botAgentAccountOf(agentName())}
                    value={draft().agentConfigDir}
                    options={agentOtherAccountOptions()}
                    error={!!props.profileErrors.agentConfigDir}
                    onChange={onAgentAccountChange}
                  />
                  <If when={props.profileErrors.agentConfigDir} else={<Hint>{t().sidebar.botAgentAccountHintOf(agentName())}</Hint>}>
                    <Err>{t().sidebar.botAgentAccountInvalid}</Err>
                  </If>
                </Group>
              </If>
              <Group testID="profile-agent-model-group">
                <Label>{t().sidebar.botAgentModelOf(agentName())}</Label>
                {/* The models the agent lists, or one typed into the search: an agent names its models its own way, and may take ones it never listed. */}
                <ModelPicker
                  testID="profile-agent-model"
                  value={draft().agentModel ?? ""}
                  data={agentModelPicker(props.agents ?? null, t(), agentRunner()!, runnerPick().customId, draft().agentModel ?? "")}
                  title={t().sidebar.botAgentModelOf(agentName())}
                  error={!!props.profileErrors.agentModel}
                  onChange={onAgentModelChange}
                />
                <If
                  when={props.profileErrors.agentModel}
                  else={<Hint>{t().sidebar.botAgentModelEmptyHint(agentName(), agentStatus()?.default_model ?? null)}</Hint>}
                >
                  <Err>{t().sidebar.botAgentModelInvalidOf(agentName())}</Err>
                </If>
              </Group>
              <If
                when={agentEfforts().length > 0}
                else={
                  <Group>
                    <Hint testID="profile-agent-no-effort">{t().sidebar.botAgentNoEffort(agentName())}</Hint>
                  </Group>
                }
              >
                {effortPicker(agentEfforts(), t().sidebar.botAgentEffortHintOf(agentName()))}
              </If>
            </If>
          }
        >
          <If when={draft().agentConfigDir !== undefined}>
            <Group testID="profile-agent-account-group">
              <Label>{t().sidebar.botAgentAccount}</Label>
              <Select
                testID="profile-agent-account"
                ariaLabel={t().sidebar.botAgentAccount}
                value={draft().agentConfigDir}
                options={agentAccountOptions()}
                error={!!props.profileErrors.agentConfigDir}
                onChange={onAgentAccountChange}
              />
              <If when={props.profileErrors.agentConfigDir} else={<Hint>{t().sidebar.botAgentAccountHint}</Hint>}>
                <Err>{t().sidebar.botAgentAccountInvalid}</Err>
              </If>
            </Group>
          </If>
          <Group testID="profile-agent-model-group">
            <Label>{t().sidebar.botAgentModel}</Label>
            <ModelPicker
              testID="profile-agent-model"
              value={draft().agentModel ?? ""}
              data={claudeModelData()}
              title={t().sidebar.botAgentModel}
              error={!!props.profileErrors.agentModel}
              onChange={onAgentModelChange}
            />
            <If when={props.profileErrors.agentModel}>
              <Err>{t().sidebar.botAgentModelInvalid}</Err>
            </If>
          </Group>
          {/* A model that takes no thinking level has none to pick, unless one is set already. */}
          <If when={claudeEfforts().length > 0}>{effortPicker(claudeEfforts(), t().sidebar.botAgentEffortHint)}</If>
        </If>
      </View>
    </View>
  );
}
