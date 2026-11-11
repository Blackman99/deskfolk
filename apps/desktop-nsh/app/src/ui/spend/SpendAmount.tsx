/**
 * One row's money (`SpendAmount.svelte`). Reported and estimated stay two figures and are never
 * added: a row with only one shows only that one (an estimate says so), a row with both shows both,
 * each named.
 */
import { Text, View } from "nsh";
import { formatUsd } from "../../m/spend-format.ts";
import type { SpendCopy } from "../../m/spend/spend-copy.ts";
import { tip } from "../tip";

export function SpendAmount(props: {
  copy: SpendCopy;
  reported: number | null;
  estimated: number | null;
  /** Why a row has neither. */
  missing?: string;
  testID?: string;
}) {
  const both = () => props.reported != null && props.estimated != null;
  return (
    <View testID={props.testID} class="items-end gap-px min-w-0 max-w-full">
      <If when={props.reported != null}>
        <View class="flex-row flex-wrap justify-end items-baseline gap-x-1">
          <Text class="text-[13px] font-semibold text-ink">{formatUsd(props.reported!)}</Text>
          <If when={both()}>
            <Text class="text-[10.5px] font-medium text-ink-muted">{props.copy.reported}</Text>
          </If>
        </View>
      </If>
      <If when={props.estimated != null}>
        <View class="flex-row flex-wrap justify-end items-baseline gap-x-1">
          <Text class={`text-[13px] ${both() ? "font-medium text-ink-secondary" : "font-semibold text-ink"}`}>{formatUsd(props.estimated!)}</Text>
          <Text class="text-[10.5px] font-medium text-ink-muted">{props.copy.estimated}</Text>
        </View>
      </If>
      <If when={props.reported == null && props.estimated == null}>
        <Text class="text-[13px] text-ink-muted" tooltip={props.missing ? tip(props.missing) : undefined}>
          {props.copy.dash}
        </Text>
      </If>
    </View>
  );
}
