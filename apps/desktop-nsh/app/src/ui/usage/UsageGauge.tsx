/**
 * One window as a dial on the usage tab: a ring as full as what is used, the number inside it,
 * then the window's length, its model when it is a model's own, and when it starts over
 * (`UsageGauge.svelte`).
 */
import { Canvas, Text, token, View } from "nsh";
import type { UsageWindow } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { usageLevel, usageResetShort, usageResetText, usageSpan, usageUsed, usageUsedText } from "../../m/usage/usage.ts";
import { Icon } from "../Icon";
import { tip } from "../tip";
import { drawRing, levelColor } from "./ring";

const PERCENT = { normal: "text-ink", warn: "text-warn-text", danger: "text-danger-text" } as const;

export function UsageGauge(props: { window: UsageWindow; locale: string; now: number }) {
  const level = () => usageLevel(props.window.percent);
  const reset = () => usageResetText(props.window.resets_at, props.now, copy(), props.locale);
  const resetShort = () => usageResetShort(props.window.resets_at, props.now, copy(), props.locale);
  return (
    <View testID={`usage-window-${props.window.model ?? props.window.minutes ?? ""}`} class="items-center gap-[2px] min-w-0">
      <View class="w-[76px] h-[76px] items-center justify-center mb-[6px]">
        <Canvas
          accessible={false}
          style={{ position: "absolute", left: 0, top: 0, width: 76, height: 76 }}
          draw={(cx) =>
            drawRing(cx, {
              box: 76,
              view: 76,
              radius: 30,
              width: 6,
              used: usageUsed(props.window.percent),
              color: levelColor(level(), "ink-secondary"),
              track: token("line"),
            })
          }
        />
        <View class="items-center" accessible={false}>
          <Text testID="usage-percent" class={`text-[15px] font-semibold leading-[17px] ${PERCENT[level()]}`}>
            {usageUsedText(props.window.percent)}
          </Text>
          <Text class="text-[10px] leading-[11px] text-ink-muted">{copy().usage.usedLabel}</Text>
        </View>
      </View>
      <Text class="max-w-full text-[13px] font-semibold text-ink leading-[18px] text-center">
        <If when={props.window.model}>{(model) => <Text testID="usage-gauge-model">{`${model()} `}</Text>}</If>
        <If when={props.window.model}>
          <Text class="font-normal text-ink-muted">{"· "}</Text>
        </If>
        <Text testID="usage-gauge-span">{usageSpan(props.window.minutes, copy())}</Text>
      </Text>
      <If when={resetShort()}>
        {(short) => (
          <View tooltip={reset() ? tip(reset()!) : undefined} class="flex-row items-center justify-center gap-[3px] max-w-full">
            <Icon name="rotate-ccw" size={12} />
            <Text class="text-[11px] text-ink-muted line-clamp-1">{short()}</Text>
          </View>
        )}
      </If>
    </View>
  );
}
