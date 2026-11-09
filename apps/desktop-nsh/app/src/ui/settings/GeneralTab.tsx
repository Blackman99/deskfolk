/**
 * Settings › General (`settings/GeneralTab.svelte`): the workspace folder, the permission mode and
 * the preferences (theme, language, focus mode, launch at login, the independent runtime).
 *
 * Props: `locale`; `patchImmediate(patch)` (saves at once, resolves false when it did not land);
 * `workspaceReadOnly` (a hosted shell has no host to write to: the path is shown, not picked);
 * `fieldErrors`; `clearWorkspaceError`; `persistWorkspace(path)`; `independent`, `independentBusy`,
 * `independentReason(status)`, `requestIndependent(next)` (the independent-runtime switch, which asks
 * the caller to confirm rather than flip). `runtime` and `snapshot` are the window's own
 * (`runtime`, `runtime.snapshot`). Test ids: `workspace` (the picker), `theme-<system|light|dark>`,
 * `locale-<zh|en>`, `focus-mode-toggle`, `launch-at-login-toggle`, `independent-runtime-toggle`,
 * `independent-reason`, `workspace-badge`, `workspace-readonly-path`, `workspace-error`.
 */
import { Text, View, type JSX } from "nsh";
import { DEFAULT_PERMISSION_MODE } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { WORKSPACE_COPY } from "../../m/copy.ts";
import { themeManager } from "../../m/theme.ts";
import { focusMode } from "../../m/chat/focus-mode.svelte.ts";
import { setLaunchAtLogin, type IndependentStatus } from "../../m/settings/independent-runtime.ts";
import type { FieldErrorKind, SettingsFieldErrors } from "../../m/settings/wizard-save.ts";
import { Icon, type IconName } from "../Icon";
import { Switch } from "../Switch";
import { PermissionModeCard } from "./PermissionModeCard";
import { SettingsCard } from "./SettingsCard";
import { SettingsCardHeader } from "./SettingsCardHeader";
import { SettingsRow } from "./SettingsRow";
import { WorkspacePicker } from "./WorkspacePicker";
import { widthAtMost } from "../../platform/viewport";

type Patch = { locale?: "zh" | "en"; theme?: "system" | "light" | "dark"; launch_at_login?: boolean };

function HeaderIcon(props: { name: IconName }) {
  return (
    <View class="w-[30px] h-[30px] rounded-(--radius-md) bg-accent-tint items-center justify-center shrink-0">
      <Icon name={props.name} class="tint-brand" />
    </View>
  );
}

/** One pill of a segmented control: on a narrow window the pills share the control's width. */
function Segment(props: { testID: string; active: boolean; label: string; icon?: IconName; stretch: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.active }}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none group flex-row items-center justify-center gap-[6px] px-[11px] py-[5px] rounded-(--radius-sm) ${props.stretch ? "grow basis-0" : ""} ${
        props.active ? "bg-pane" : "hover:bg-line-subtle"
      }`}
    >
      <If when={props.icon}>{(name) => <Icon name={name()} class={props.active ? "tint-brand" : "tint-ink-muted group-hover:tint-ink"} />}</If>
      <Text class={`text-[12px] whitespace-nowrap ${props.active ? "font-semibold text-brand" : "font-medium text-ink-muted group-hover:text-ink"}`}>{props.label}</Text>
    </View>
  );
}

export function GeneralTab(props: {
  locale: "zh" | "en";
  patchImmediate: (patch: Patch) => Promise<boolean>;
  workspaceReadOnly: boolean;
  fieldErrors: SettingsFieldErrors;
  clearWorkspaceError: () => void;
  persistWorkspace: (path: string) => Promise<void>;
  independent: IndependentStatus;
  independentBusy: boolean;
  independentReason: (status: IndependentStatus) => string;
  requestIndependent: (next: boolean) => void;
}) {
  const t = () => copy();
  const snapshot = () => runtime.snapshot;
  const stretch = () => widthAtMost(540);
  const workspaceRemoteBrowse = () => Boolean(runtime.remote);

  function fieldCopy(kind: FieldErrorKind | undefined, empty: string, invalid: string): string {
    if (kind === "empty") return empty;
    if (kind === "invalid") return invalid;
    return "";
  }

  async function onLaunchAtLogin(checked: boolean): Promise<void> {
    if (!(await props.patchImmediate({ launch_at_login: checked }))) return;
    await setLaunchAtLogin(checked);
  }

  const control = (children: JSX.Element) => (
    <View class={`flex-row items-center gap-[2px] p-[3px] bg-chip border border-chip-line rounded-(--radius-md) ${stretch() ? "w-full" : ""}`}>{children}</View>
  );
  const pickTheme = (theme: "system" | "light" | "dark") => {
    themeManager.setTheme(theme);
    void props.patchImmediate({ theme });
  };

  return (
    <View testID="settings-general" class={`flex-col ${widthAtMost(720) ? "gap-3" : "gap-[14px]"}`}>
      <SettingsCard testID="settings-card-workspace">
        <SettingsCardHeader
          title={t().settings.sectionWorkspace}
          subtitle={t().settings.workspaceSubtitle}
          icon={<HeaderIcon name="folder" />}
          end={
            <If
              when={runtime.workspacePath}
              else={
                <View testID="workspace-badge" class="shrink-0 px-2 py-[2px] rounded-full bg-warn-bg border border-warn-line">
                  <Text class="text-[11px] font-semibold text-warn-text whitespace-nowrap">{t().settings.workspaceUnsetNotice}</Text>
                </View>
              }
            >
              <View testID="workspace-badge" class="shrink-0 px-2 py-[2px] rounded-full bg-ok-bg border border-ok-line">
                <Text class="text-[11px] font-semibold text-ok-text whitespace-nowrap">{t().settings.workspaceConfigured}</Text>
              </View>
            </If>
          }
        />

        <View class="flex-col gap-5 mt-2">
          <If
            when={props.workspaceReadOnly}
            else={
              <WorkspacePicker
                id="workspace"
                path={runtime.workspacePath}
                chooseLabel={t().settings.workspaceChoose}
                changeLabel={t().settings.workspaceChange}
                emptyLabel={t().settings.workspaceUnsetValue}
                unavailableLabel={t().settings.workspacePickerUnavailable}
                dialogTitle={t().settings.workspaceChoose}
                remote={workspaceRemoteBrowse()}
                api={runtime.client as never}
                browseHint={t().settings.workspaceBrowseRemote}
                permissionHint={t().settings.workspaceAuthorizeMac}
                truncatedHint={t().stream.workspaceTruncated}
                confirmHint={t().settings.workspaceConfirmRoot}
                upLabel={t().settings.workspaceUp}
                useLabel={t().settings.workspaceUseFolder}
                cancelLabel={t().sidebar.cancel}
                onChange={(next: string) => {
                  runtime.workspacePath = next;
                  props.clearWorkspaceError();
                  void props.persistWorkspace(next);
                }}
              />
            }
          >
            <View class="flex-col gap-2">
              <Text testID="workspace-readonly-path" class="font-mono text-[13px] text-ink px-3 py-2 bg-input-bg border border-line rounded-(--radius-md)">
                {runtime.workspacePath.trim() || t().settings.workspaceUnsetValue}
              </Text>
              <Text class="text-[12px] leading-[1.45] text-ink-muted">{t().settings.workspaceHostOnly}</Text>
            </View>
          </If>

          <If when={props.fieldErrors.workspace}>
            <View role="alert" testID="workspace-error" class="flex-row items-center gap-2 px-3 py-2 rounded-(--radius-md) bg-warn-bg border border-warn-line">
              <Icon name="alert-circle" class="tint-warn" />
              <Text class="shrink text-[12px] font-medium text-warn-text">
                {fieldCopy(props.fieldErrors.workspace, t().settings.workspaceEmpty, t().settings.workspaceInvalid)}
              </Text>
            </View>
          </If>

          <View class="flex-row items-start gap-2 pt-[2px]">
            <Icon name="shield" class="tint-ink-muted mt-1" />
            <View class="flex-col gap-[3px] min-w-0 shrink grow">
              <Text class="text-[12px] font-semibold text-ink-secondary">{t().settings.workspaceRole}</Text>
              <Text class="text-[12px] leading-[1.45] text-ink-muted">{WORKSPACE_COPY[props.locale]}</Text>
            </View>
          </View>
        </View>
      </SettingsCard>

      <PermissionModeCard
        mode={snapshot().settings.permission_mode ?? DEFAULT_PERMISSION_MODE}
        bots={snapshot().bots}
        onChoose={async (mode) => (await runtime.patchSettings({ permission_mode: mode })) === null}
      />

      <SettingsCard testID="settings-card-preferences">
        <SettingsCardHeader title={t().settings.sectionPreferences} subtitle={t().settings.preferencesSubtitle} icon={<HeaderIcon name="sliders" />} />

        <View class="flex-col border-t border-line-subtle mt-1">
          <SettingsRow title={t().settings.theme} titleId="theme-setting-label" desc={t().settings.themeDesc}>
            {control(
              <>
                <Segment testID="theme-system" active={snapshot().settings.theme === "system"} label={t().settings.themeSystem} icon="monitor" stretch={stretch()} onPress={() => pickTheme("system")} />
                <Segment testID="theme-light" active={snapshot().settings.theme === "light"} label={t().settings.themeLight} icon="sun" stretch={stretch()} onPress={() => pickTheme("light")} />
                <Segment testID="theme-dark" active={snapshot().settings.theme === "dark"} label={t().settings.themeDark} icon="moon" stretch={stretch()} onPress={() => pickTheme("dark")} />
              </>,
            )}
          </SettingsRow>

          <SettingsRow title={t().settings.language} titleId="lang-setting-label" desc={t().settings.languageDesc}>
            {control(
              <>
                <Segment testID="locale-zh" active={props.locale === "zh"} label={t().settings.localeZh} stretch={stretch()} onPress={() => void props.patchImmediate({ locale: "zh" })} />
                <Segment testID="locale-en" active={props.locale === "en"} label={t().settings.localeEn} stretch={stretch()} onPress={() => void props.patchImmediate({ locale: "en" })} />
              </>,
            )}
          </SettingsRow>

          <SettingsRow title={t().settings.focusMode} titleId="focus-mode-label" desc={t().settings.focusModeDesc}>
            <Switch testID="focus-mode-toggle" label={t().settings.focusMode} checked={focusMode.on} onChange={(checked) => focusMode.set(checked)} />
          </SettingsRow>

          <SettingsRow title={t().settings.launch} titleId="launch-setting-label" desc={t().settings.launchDesc}>
            <Switch testID="launch-at-login-toggle" label={t().settings.launch} checked={snapshot().settings.launch_at_login} onChange={(checked) => void onLaunchAtLogin(checked)} />
          </SettingsRow>

          <SettingsRow
            last
            title={t().settings.independentRuntime}
            titleId="independent-runtime-label"
            desc={t().settings.independentRuntimeDesc}
            notes={
              <If when={!props.independent.available || props.independent.error}>
                <Text testID="independent-reason" class="text-[12px] leading-[1.35] text-ink-muted">
                  {props.independentReason(props.independent)}
                </Text>
              </If>
            }
          >
            <Switch
              testID="independent-runtime-toggle"
              label={t().settings.independentRuntime}
              checked={props.independent.enabled}
              disabled={!props.independent.available || props.independentBusy}
              onChange={(next) => props.requestIndependent(next)}
            />
          </SettingsRow>
        </View>
      </SettingsCard>
    </View>
  );
}
