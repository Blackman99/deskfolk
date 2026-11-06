/**
 * The settings dialog's navigation (`settings/SettingsNav.svelte`): a 220-wide sidebar on a wide
 * window, the dialog's whole first page on a phone (a grouped list; a row opens that tab one level
 * deeper, and ✕ closes the dialog).
 *
 * Props, as `SettingsModal` passes them (`t` and `snapshot` are the window's own: `copy()`,
 * `runtime.snapshot`): `activeSettingsTab`; `openSettingsTab(tab)`; `generalHasError`;
 * `modelsHasError`; `promptCounts`; `lessonsTabVisible`; `remoteTabVisible`; `behaviorTabVisible`
 * (only with the desktop workbench); `interfaceTabVisible` (the daemon keeps an interface profile,
 * ADR 0106); `closeSettings`. Test ids: `settings-nav`, `settings-tab-<tab>` (the Svelte
 * `data-settings-tab`), `settings-tab-<tab>-count`, `settings-tab-<tab>-error`, `settings-tab-about-dot`,
 * `settings-wizard-badge`, `settings-root-close` (phone only).
 *
 * Not carried over: the slide of the sidebar over the dialog on a phone (the dialog's page
 * transition), and the safe-area padding (NSH's window already keeps clear of it).
 */
import { Scroll, Text, View, windowSize } from "nsh";
import { copy, runtime } from "../../runtime";
import { updateChecker } from "../../m/update-checker.svelte.ts";
import { Icon } from "../Icon";
import { tip } from "../tip";
import { navTabs, type NavTab, type SettingsTab } from "./settings-nav";

export type { SettingsTab };

export function SettingsNav(props: {
  activeSettingsTab: SettingsTab;
  openSettingsTab: (tab: SettingsTab) => void;
  generalHasError: boolean;
  modelsHasError: boolean;
  promptCounts: { edited: number; conflict: boolean };
  lessonsTabVisible: boolean;
  remoteTabVisible: boolean;
  behaviorTabVisible: boolean;
  interfaceTabVisible?: boolean;
  closeSettings: () => void;
}) {
  const t = () => copy();
  const snapshot = () => runtime.snapshot;
  const phone = () => windowSize().width <= 720;
  const tabs = () =>
    navTabs(t(), {
      providers: snapshot().providers.length,
      mcpServers: snapshot().mcpServers.length,
      generalHasError: props.generalHasError,
      modelsHasError: props.modelsHasError,
      promptCounts: props.promptCounts,
      lessonsTabVisible: props.lessonsTabVisible,
      remoteTabVisible: props.remoteTabVisible,
      behaviorTabVisible: props.behaviorTabVisible,
      interfaceTabVisible: props.interfaceTabVisible ?? false,
      updateVisible: updateChecker.updateVisible,
    });

  function Badge(props: { tab: () => NavTab; active: boolean }) {
    const id = () => `settings-tab-${props.tab().id}`;
    return (
      <>
        <If when={props.tab().badge?.kind === "error"}>
          <View testID={`${id()}-error`} accessibilityLabel="error" class="w-[15px] h-[15px] ml-auto shrink-0 rounded-full bg-danger items-center justify-center">
            <Text class="text-[10px] font-bold leading-[11px] text-on-danger">!</Text>
          </View>
        </If>
        <If when={props.tab().badge?.kind === "dot"}>
          <View testID={`${id()}-dot`} accessibilityLabel={t().sidebar.updateAvailable} class="w-2 h-2 ml-auto shrink-0 rounded-full bg-brand" />
        </If>
        <If when={props.tab().badge?.kind === "count"}>
          <View
            testID={`${id()}-count`}
            class={`ml-auto shrink-0 min-w-[18px] px-[6px] py-[1px] rounded-full items-center ${countWarn(props.tab()) ? "bg-warn-bg" : props.active && !phone() ? "bg-pane" : "bg-chip"}`}
          >
            <Text class={`text-[11px] font-semibold leading-4 ${countWarn(props.tab()) ? "text-warn-text" : props.active && !phone() ? "text-brand" : "text-ink-secondary"}`}>
              {String(countValue(props.tab()))}
            </Text>
          </View>
        </If>
      </>
    );
  }
  const countWarn = (tab: NavTab) => (tab.badge?.kind === "count" ? tab.badge.warn === true : false);
  const countValue = (tab: NavTab) => (tab.badge?.kind === "count" ? tab.badge.value : 0);

  const row = (tab: () => NavTab, index: () => number) => {
    const active = () => props.activeSettingsTab === tab().id;
    const lit = () => active() && !phone();
    const hover = () => (tab().id === "about" && updateChecker.updateVisible ? `${t().settings.tabAbout} · ${t().sidebar.updateAvailable}` : null);
    return (
      <View
        role="button"
        testID={`settings-tab-${tab().id}`}
        accessibilityLabel={tab().label}
        accessibilityState={{ selected: active() }}
        tooltip={hover() ? tip(hover()!) : undefined}
        onPress={() => props.openSettingsTab(tab().id)}
        class={`group relative flex-row items-center w-full ${
          phone()
            ? `gap-[10px] min-h-[54px] px-[14px] bg-pane active:bg-row-hover ${index() === 0 ? "rounded-t-(--radius-lg)" : ""} ${index() === tabs().length - 1 ? "rounded-b-(--radius-lg)" : ""}`
            : `gap-[10px] px-3 py-[9px] border border-transparent rounded-(--radius-md) ${lit() ? "bg-accent-tint" : "hover:bg-row-hover"}`
        }`}
      >
        <If when={phone() && index() > 0}>
          <View class="absolute left-11 right-0 top-0 h-px bg-line" />
        </If>
        <Icon name={tab().icon} size={phone() ? 20 : 16} class={lit() ? "tint-brand" : "tint-ink-secondary group-hover:tint-ink"} />
        <Text
          class={`shrink grow basis-0 line-clamp-1 ${phone() ? "text-[15px] font-medium text-ink" : `text-[14px] ${lit() ? "font-semibold text-brand" : "font-medium text-ink-secondary group-hover:text-ink"}`}`}
        >
          {tab().label}
        </Text>
        <Badge tab={tab} active={active()} />
        <If when={phone()}>
          <Icon name="chevron-right" size={16} class="tint-ink-muted" />
        </If>
      </View>
    );
  };

  return (
    <View testID="settings-nav" role="navigation" accessibilityLabel={t().settings.title} class={`flex-col bg-sidebar-bg ${phone() ? "w-full flex-1 min-h-0" : "w-[220px] shrink-0 border-r border-line"}`}>
      <View class={`flex-row items-center justify-between gap-2 h-14 shrink-0 border-b border-line ${phone() ? "pl-[18px] pr-3 bg-pane" : "px-[18px]"}`}>
        <View class="flex-row items-center gap-[9px] min-w-0">
          <If when={!phone()}>
            <Icon name="settings" size={20} class="tint-ink-muted" />
          </If>
          <Text role="header" class={`font-bold text-ink whitespace-nowrap ${phone() ? "text-[18px]" : "text-[16px]"}`}>
            {t().settings.title}
          </Text>
        </View>
        <View class="flex-row items-center gap-2">
          <If when={!snapshot().settings.wizard_complete}>
            <View testID="settings-wizard-badge" class="shrink-0 px-2 py-[2px] rounded-full bg-warn-bg border border-warn-line">
              <Text class="text-[11px] font-medium text-warn-text">{t().settings.wizardIncomplete}</Text>
            </View>
          </If>
          <If when={phone()}>
            <View
              role="button"
              testID="settings-root-close"
              accessibilityLabel={t().common.close}
              tooltip={tip(t().common.close)}
              onPress={() => props.closeSettings()}
              class="w-9 h-9 items-center justify-center rounded-(--radius-md) active:bg-row-hover"
            >
              <Text class="text-[16px] text-ink-muted">✕</Text>
            </View>
          </If>
        </View>
      </View>
      <Scroll class="flex-1 min-h-0">
        <View class={`flex-col ${phone() ? "px-3 pt-5 pb-8" : "gap-1 px-[10px] py-3"}`}>
          <Each of={tabs()} key={(tab) => tab.id}>
            {(tab, index) => row(tab, index)}
          </Each>
        </View>
      </Scroll>
    </View>
  );
}
