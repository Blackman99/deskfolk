/**
 * Settings › Behavior: where each kind of window opens on the workbench when it is not open yet
 * (`settings/OpenPlacementCard.svelte`). A row per kind, its choices under the four ways a window
 * can arrive. Kept on this machine, like the layout it shapes; a change applies to the next window
 * opened.
 *
 * Test ids: `open-placement-reset`, `open-placement-<kind>` (the row's name), `open-placement-select-<kind>`
 * (its Select), `open-placement-changed-<kind>` (the mark on a row that is not at its default).
 */
import { Text, View } from "nsh";
import { copy } from "../../runtime";
import { OPEN_KINDS, OPEN_PLACEMENT_GROUPS, isOpenPlacement, type OpenKind } from "../../m/workbench/open-placement.ts";
import { openPlacements } from "../../m/workbench/open-placement-store.svelte.ts";
import type { SelectOption } from "../../m/select-options.ts";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { Select } from "../Select";
import { SettingsCard } from "./SettingsCard";
import { SettingsCardHeader } from "./SettingsCardHeader";
import { SettingsRow } from "./SettingsRow";

export function OpenPlacementCard() {
  const t = () => copy().openPlacement;
  const options = (): SelectOption[] =>
    OPEN_PLACEMENT_GROUPS.flatMap(({ group, placements }) =>
      placements.map((placement) => ({ value: placement, label: t().placements[placement], group: t().groups[group] })),
    );
  function choose(kind: OpenKind, value: string): void {
    if (isOpenPlacement(value)) openPlacements.set(kind, value);
  }
  return (
    <SettingsCard testID="settings-card-open-placement">
      <SettingsCardHeader
        title={t().title}
        subtitle={t().subtitle}
        icon={
          <View class="w-[30px] h-[30px] rounded-(--radius-md) bg-accent-tint items-center justify-center shrink-0">
            <Icon name="layout" class="tint-brand" />
          </View>
        }
        end={
          <Button size="sm" testID="open-placement-reset" disabled={!openPlacements.changed} onPress={() => openPlacements.reset()}>
            {t().reset}
          </Button>
        }
      />
      <View class="flex-col border-t border-line-subtle mt-1">
        <Each of={OPEN_KINDS} key={(kind) => kind}>
          {(kind, index) => (
            <SettingsRow
              title={t().kinds[kind()].name}
              titleId={`open-placement-${kind()}`}
              desc={t().kinds[kind()].hint}
              last={index() === OPEN_KINDS.length - 1}
              titleAfter={
                <If when={!openPlacements.isDefault(kind())}>
                  <View testID={`open-placement-changed-${kind()}`} class="shrink-0 px-[6px] rounded-full bg-accent-tint">
                    <Text class="text-[11px] font-semibold leading-[15px] text-brand">{t().changed}</Text>
                  </View>
                </If>
              }
            >
              <Select
                testID={`open-placement-select-${kind()}`}
                value={openPlacements.get(kind())}
                options={options()}
                size="sm"
                ariaLabel={t().kinds[kind()].name}
                onChange={(value) => choose(kind(), value)}
              />
            </SettingsRow>
          )}
        </Each>
      </View>
      <Text class="text-[12px] leading-[1.45] text-ink-muted">{t().floatMemory}</Text>
      <Text class="text-[12px] leading-[1.45] text-ink-muted">{t().notListed}</Text>
    </SettingsCard>
  );
}
