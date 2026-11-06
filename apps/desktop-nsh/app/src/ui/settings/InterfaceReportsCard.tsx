/**
 * What each kind of window found after applying the profile (`settings/InterfaceReportsCard.svelte`),
 * so a rule that matches nothing shows. Read now, and again two seconds after a new revision, once
 * the windows have had time to apply it and report. A row's `testID` is `report-<surface>`.
 *
 * Props: `revisionId` (the profile's current revision; a new one reloads).
 */
import { effect, signal, Text, View } from "nsh";
import type { InterfaceWindowReport } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { SettingsCard } from "./SettingsCard";

const SETTLE_MS = 2000;

export function InterfaceReportsCard(props: { revisionId: string | null }) {
  const t = () => copy();
  const c = () => t().ui.report;
  const reports = signal<InterfaceWindowReport[]>([]);

  effect(() => {
    void props.revisionId;
    const api = runtime.client;
    if (!api) return;
    let live = true;
    const load = () =>
      void api.getInterface().then(
        (state) => {
          if (live) reports.set(state.reports ?? []);
        },
        () => {},
      );
    load();
    const timer = setTimeout(load, SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  });

  const floorName = (floor: string) => (t().ui.floors as Record<string, string>)[floor] ?? floor;

  return (
    <SettingsCard testID="interface-reports">
      <Text role="header" class="text-[14px] font-semibold text-ink">{t().ui.sections.report}</Text>
      <If when={reports().length > 0} else={<Text testID="report-none" class="text-[13px] text-ink-muted">{c().none}</Text>}>
        <View class="flex-col">
          <Each of={reports()} key={(report) => report.surface}>
            {(report) => (
              <View testID={`report-${report().surface}`} class="flex-col gap-[3px] py-2 border-t border-line-subtle">
                <View class="flex-row items-baseline gap-2">
                  <Text class="text-[13px] font-bold text-ink">{c().surfaces[report().surface]}</Text>
                  <Text class={`text-[12px] ${report().applied ? "text-ok-text" : "text-warn-text"}`}>{report().applied ? c().applied : c().notApplied}</Text>
                </View>
                <If when={report().unmatched.length > 0}>
                  <View class="flex-col gap-px">
                    <Text class="text-[12px] text-ink-secondary">{c().unmatched}</Text>
                    <Text class="font-mono text-[12px] text-ink-secondary">{report().unmatched.join("  ")}</Text>
                  </View>
                </If>
                <If when={report().dropped > 0}>
                  <Text class="text-[12px] text-ink-secondary">{c().dropped.replace("{n}", String(report().dropped))}</Text>
                </If>
                <If when={report().bad_tokens.length > 0}>
                  <View class="flex-col gap-px">
                    <Text class="text-[12px] text-ink-secondary">{c().badTokens}</Text>
                    <Text class="font-mono text-[12px] text-ink-secondary">{report().bad_tokens.join("  ")}</Text>
                  </View>
                </If>
                <If when={report().floor_failed.length > 0}>
                  <Text class="text-[12px] text-ink-secondary">
                    {`${c().floor}${report().floor_failed.map((failure) => floorName(failure.floor)).join("、")}`}
                  </Text>
                </If>
              </View>
            )}
          </Each>
        </View>
      </If>
    </SettingsCard>
  );
}
