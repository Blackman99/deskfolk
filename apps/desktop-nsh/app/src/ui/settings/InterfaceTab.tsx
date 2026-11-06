/**
 * Settings › Interface (`settings/InterfaceTab.svelte`, ADR 0106): the profile every window reads,
 * as a Bot or you change it. The one place that shows all of it, and the way back from any of it.
 * Its parts (behaviour, tokens, CSS, words, history and reports) are tabs on a wide window and a list
 * on a phone, so none sits below the others; the switch for the whole of it stays over them.
 *
 * The cards edit the same profile through `runtime`; applying it to the NSH app is a separate task,
 * so changing a token, a rule or a word here saves it and nothing in this app changes look yet.
 *
 * Props: `snapshot`; `locale`; `phone` (no workbench: the desktop-only rows are left out); `notices`
 * (what the dialog says over any page: pending credentials, a failed save, setup not done);
 * `controller` (called once with the page's two Svelte-exported methods: `sectionTitle()`, the open
 * part's name for the page head on a phone, null on the list and on a wide window; and
 * `backFromSection()`, Back on a phone from a part's page to the list, true when it did).
 * Narrow is `narrowWindow()` (680 wide or less; the Svelte page broke at 720).
 */
import { Scroll, signal, Text, View, type JSX, type ScrollRef } from "nsh";
import type { InterfaceBehaviour } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { escapeKeyLabel, interfaceController } from "../../m/interface/controller.svelte.ts";
import type { Snapshot } from "../../m/snapshot.ts";
import { editInterfaceOrToast } from "../../m/settings/interface-edit.ts";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { Switch } from "../Switch";
import { InterfaceBehaviourCard } from "./InterfaceBehaviourCard";
import { InterfaceCopyCard } from "./InterfaceCopyCard";
import { InterfaceCssCard } from "./InterfaceCssCard";
import { InterfaceHistoryCard } from "./InterfaceHistoryCard";
import { InterfaceReportsCard } from "./InterfaceReportsCard";
import { InterfaceTokensCard } from "./InterfaceTokensCard";
import { revisionWhen, revisionWho } from "./interface-history";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";
import { SettingsSectionList } from "./SettingsSectionList";
import { SettingsSectionTabs } from "./SettingsSectionTabs";

export type InterfaceSection = "behaviour" | "tokens" | "css" | "copy" | "history";
const SECTIONS: readonly InterfaceSection[] = ["behaviour", "tokens", "css", "copy", "history"];

export type InterfaceTabController = { sectionTitle(): string | null; backFromSection(): boolean };

/** The choices on the behaviour page set to something of yours. */
function behaviourChanged(behaviour: InterfaceBehaviour): number {
  return Object.values(behaviour).filter((value) => {
    if (value === null || value === undefined || value === false) return false;
    if (typeof value === "object") return Object.values(value).some((inner) => inner !== null && inner !== undefined);
    return true;
  }).length;
}

export function InterfaceTab(props: {
  snapshot: Snapshot;
  locale: "zh" | "en";
  phone?: boolean;
  notices?: JSX.Element;
  controller?: (handle: InterfaceTabController) => void;
}) {
  const t = () => copy();
  const c = () => t().ui;
  const iface = () => props.snapshot.interface;
  const narrow = () => narrowWindow();

  const picked = signal<InterfaceSection>("behaviour");
  /** On a phone, a part's page is open over the list of them. */
  const opened = signal(false);
  const listing = () => narrow() && !opened();
  const confirmingReset = signal(false);
  let scroller: ScrollRef | undefined;

  const pausedWhy = () => {
    const by = interfaceController.pausedBy;
    if (by === "url") return c().pausedByUrl;
    if (by === "key") return c().pausedByKey.replace("{key}", escapeKeyLabel());
    if (by === "floor") {
      const floor = interfaceController.floorFailed[0]?.floor ?? "";
      return c().pausedByFloor.replace("{floor}", (c().floors as Record<string, string>)[floor] ?? floor);
    }
    return "";
  };

  const label = (of: InterfaceSection) => c().sections[of];
  const tokenCount = () => {
    const state = iface();
    return state ? Object.keys(state.profile.tokens.light).length + Object.keys(state.profile.tokens.dark).length : 0;
  };
  const wordCount = () => {
    const state = iface();
    return state ? Object.keys(state.profile.copy[props.locale] ?? {}).length : 0;
  };
  const count = (of: InterfaceSection) => (of === "tokens" ? tokenCount() : of === "copy" ? wordCount() : 0);
  const changed = (n: number) => c().summary.changed.replace("{n}", String(n));

  /** What a part holds, under its name on the phone's list. */
  function summary(of: InterfaceSection): string {
    const state = iface();
    if (!state) return "";
    if (of === "behaviour") {
      const n = behaviourChanged(state.profile.behaviour);
      return n === 0 ? c().summary.allDefault : changed(n);
    }
    if (of === "tokens") return tokenCount() === 0 ? c().tokens.empty : changed(tokenCount());
    if (of === "css") return state.profile.css.length === 0 ? c().css.empty : c().css.length.replace("{n}", String(state.profile.css.length));
    if (of === "copy") return wordCount() === 0 ? c().copyWords.empty : changed(wordCount());
    const latest = state.recent[0];
    if (!latest) return c().history.empty;
    return [revisionWho(latest, props.snapshot.bots, c().history), c().history.ops[latest.op], revisionWhen(latest.created_at, props.locale)].join(" · ");
  }

  function open(next: InterfaceSection): void {
    picked.set(next);
    opened.set(true);
    confirmingReset.set(false);
    scroller?.scrollTo({ y: 0, animated: false });
  }

  props.controller?.({
    sectionTitle: () => (narrow() && opened() ? label(picked()) : null),
    backFromSection: () => {
      if (!narrow() || !opened()) return false;
      opened.set(false);
      return true;
    },
  });

  async function resetAll(): Promise<void> {
    confirmingReset.set(false);
    await editInterfaceOrToast(runtime, { reset: ["tokens", "behaviour", "css", "copy"] });
  }

  const icon = (of: InterfaceSection, size: number, active = false) => (
    <Icon
      name={of === "behaviour" ? "pointer" : of === "tokens" ? "tag" : of === "css" ? "code" : of === "copy" ? "type" : "history"}
      size={size >= 18 ? 20 : 16}
      class={active ? "tint-brand" : "tint-ink-muted"}
    />
  );

  const paused = () => (
    <If when={interfaceController.pausedBy}>
      <View role="text" testID="interface-paused" class="flex-row items-center justify-between gap-3 px-[14px] py-[10px] rounded-(--radius-lg) border border-warn-line bg-warn-bg">
        <View class="flex-col gap-[2px] min-w-0 shrink">
          <Text class="text-[13px] font-bold text-warn-text">{c().pausedHere}</Text>
          <Text class="text-[13px] text-warn-text">{pausedWhy()}</Text>
        </View>
        <If when={interfaceController.pausedBy !== "url"}>
          <Button size="sm" variant="secondary" testID="interface-resume" onPress={() => interfaceController.resume()}>{c().resumeHere}</Button>
        </If>
      </View>
    </If>
  );

  const enabledSwitch = () => (
    <Switch
      testID="interface-enabled-toggle"
      label={c().enabled}
      checked={iface()?.profile.enabled ?? true}
      onChange={(enabled) => void editInterfaceOrToast(runtime, { enabled })}
    />
  );

  const intro = () => (
    <View class="flex-col gap-1">
      <Text class="text-[13px] leading-[1.5] text-ink-muted">{c().subtitle}</Text>
      <Text class="text-[13px] leading-[1.5] text-ink-muted">{c().askHint}</Text>
    </View>
  );

  return (
    <View testID="interface-tab" class="flex-col flex-1 min-h-0">
      <If when={iface()} else={<Scroll class="flex-1 px-6 py-5"><Text testID="interface-unavailable" class="text-[13px] leading-[1.5] text-ink-muted">{c().unavailable}</Text></Scroll>}>
        <If when={!narrow()}>
          {/* The switch for the whole of it, and why this window shows the default, stay over every part. */}
          <View class="flex-col shrink-0 gap-[10px] px-6 pt-3 pb-[10px] bg-pane">
            {paused()}
            <View class="flex-row items-center justify-between gap-4">
              <View class="flex-col gap-[2px] min-w-0 shrink grow">
                <Text testID="interface-enabled-label" class="text-[13px] font-medium leading-[1.3] text-ink">{c().enabled}</Text>
                <Text class="text-[12px] leading-[1.35] text-ink-muted">{c().enabledHint}</Text>
              </View>
              {enabledSwitch()}
            </View>
          </View>
          <SettingsSectionTabs
            id="interface"
            sections={SECTIONS}
            active={picked()}
            label={label}
            count={count}
            icon={icon}
            ariaLabel={c().tab}
            onPick={open}
          />
        </If>
        <Scroll ref={(node) => (scroller = node)} class={`flex-1 min-h-0 ${narrow() ? "px-4 pt-5 pb-7" : "px-6 py-5"}`} contentClass={`flex-col ${narrow() ? "gap-4" : "gap-[14px]"}`}>
          {props.notices}
          <If
            when={listing()}
            else={
              <View testID="interface-panel" class={`flex-col min-w-0 ${narrow() ? "gap-4" : "gap-[14px]"}`}>
                <If when={picked() === "behaviour"}>
                  <If when={!narrow()}>{intro()}</If>
                  <InterfaceBehaviourCard behaviour={iface()!.profile.behaviour} phone={props.phone ?? false} />
                </If>
                <If when={picked() === "tokens"}>
                  <InterfaceTokensCard tokens={iface()!.profile.tokens} />
                </If>
                <If when={picked() === "css"}>
                  <InterfaceCssCard iface={iface()!} locale={props.locale} />
                </If>
                <If when={picked() === "copy"}>
                  <InterfaceCopyCard words={iface()!.profile.copy} locale={props.locale} />
                </If>
                <If when={picked() === "history"}>
                  <InterfaceHistoryCard recent={iface()!.recent} bots={props.snapshot.bots} locale={props.locale} />
                  <InterfaceReportsCard revisionId={iface()!.revision_id} />
                  <View class="flex-col items-start gap-2">
                    <If
                      when={confirmingReset()}
                      else={<Button size="sm" variant="danger-soft" testID="interface-reset" onPress={() => confirmingReset.set(true)}>{c().resetAll}</Button>}
                    >
                      <Text class="text-[13px] leading-[1.5] text-ink-muted">{c().resetAllConfirm}</Text>
                      <View class="flex-row gap-2">
                        <Button size="sm" variant="danger" testID="interface-reset-confirm" onPress={() => void resetAll()}>{c().resetAll}</Button>
                        <Button size="sm" variant="ghost" testID="interface-reset-cancel" onPress={() => confirmingReset.set(false)}>{c().cancel}</Button>
                      </View>
                    </If>
                  </View>
                  <Text class="text-[12px] leading-[1.5] text-ink-muted">{c().escapeHint.replace("{key}", escapeKeyLabel())}</Text>
                </If>
              </View>
            }
          >
            {paused()}
            <SettingsCard testID="interface-enabled">
              <SettingsRow title={c().enabled} titleId="interface-enabled-label" desc={c().enabledHint} last>
                {enabledSwitch()}
              </SettingsRow>
            </SettingsCard>
            {intro()}
            <SettingsSectionList sections={SECTIONS} label={label} summary={summary} icon={(of, size) => icon(of, size)} ariaLabel={c().tab} onPick={open} />
          </If>
        </Scroll>
      </If>
    </View>
  );
}
