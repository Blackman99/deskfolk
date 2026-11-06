/**
 * One window as a bar on the desktop's usage tab: its name ("Fable · 7 天"; a long model name
 * wraps, the length stays whole), when it starts over, what is used, and a bar of it
 * (`UsageBar.svelte`).
 */
import { Text, View } from "nsh";
import type { UsageWindow } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { usageLevel, usageResetShort, usageResetText, usageSpan, usageUsed, usageUsedText } from "../../m/usage/usage.ts";
import { Icon } from "../Icon";
import { tip } from "../tip";

const FILL = { normal: "bg-ink-secondary", warn: "bg-warn", danger: "bg-danger" } as const;
const PERCENT = { normal: "text-ink", warn: "text-warn-text", danger: "text-danger-text" } as const;

export function UsageBar(props: { window: UsageWindow; locale: string; now: number }) {
  const level = () => usageLevel(props.window.percent);
  const reset = () => usageResetText(props.window.resets_at, props.now, copy(), props.locale);
  const resetShort = () => usageResetShort(props.window.resets_at, props.now, copy(), props.locale);
  return (
    <View testID={`usage-window-${props.window.model ?? props.window.minutes ?? ""}`} class="gap-[6px] min-w-0">
      <View class="flex-row items-baseline gap-[12px] min-w-0">
        <Text class="flex-1 min-w-0 text-[13px] font-semibold text-ink leading-[18px]">
          <If when={props.window.model}>{(model) => <Text testID="usage-gauge-model">{`${model()} `}</Text>}</If>
          <If when={props.window.model}>
            <Text class="font-normal text-ink-muted">{"· "}</Text>
          </If>
          <Text testID="usage-gauge-span">{usageSpan(props.window.minutes, copy())}</Text>
        </Text>
        <View tooltip={reset() ? tip(reset()!) : undefined} class="flex-row items-center gap-[4px] self-center">
          <If when={resetShort()}>
            {(short) => (
              <>
                <Icon name="rotate-ccw" size={12} />
                <Text class="text-[12px] text-ink-muted">{short()}</Text>
              </>
            )}
          </If>
        </View>
        <Text testID="usage-percent" class={`min-w-[54px] text-right text-[13px] font-semibold ${PERCENT[level()]}`}>
          {copy().usage.used(usageUsedText(props.window.percent))}
        </Text>
      </View>
      <View class="h-[6px] rounded-full bg-line overflow-hidden" accessible={false}>
        <View class={`h-full rounded-full ${FILL[level()]}`} style={{ width: `${usageUsed(props.window.percent)}%` }} />
      </View>
    </View>
  );
}
