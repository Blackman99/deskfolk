/**
 * The overview's totals (`SpendSummary.svelte`): the money leading, the call and token figures as
 * tiles (the day's cap as one more tile, passed as `extra`), the token breakdown with its mix bar,
 * and a quiet coverage line that opens in place.
 */
import { signal, Text, token, View, type JSX } from "nsh";
import type { SpendTotals } from "@real-bot/protocol";
import type { SpendCopy } from "../../m/spend/spend-copy.ts";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";
import { SpendIcon } from "./SpendIcon";
import { SURFACE, mixColors, sharePercent } from "./spend-style";

type Side = { key: "reported" | "estimated"; label: string; ticks: number | null; calls: number };

export function SpendSummary(props: {
  copy: SpendCopy;
  locale: "zh" | "en";
  totals: SpendTotals;
  num: (value: number | null) => string;
  money: (ticks: number | null, estimated?: boolean) => string;
  /** One more tile at the end of the row: the day's cap. */
  extra?: JSX.Element;
  /** The ledger is narrower than 620 points (its container query); defaults to a phone-sized window. */
  narrow?: boolean;
}) {
  const narrow = () => props.narrow ?? narrowWindow();
  const copy = () => props.copy;
  const totals = () => props.totals;
  const open = signal(false);

  /**
   * The money leads. A side nothing was priced on takes no room: the coverage line under it says
   * how many calls each side covers. Both sides show side by side, never added.
   */
  const sides = (): Side[] =>
    (
      [
        { key: "reported", label: copy().reported, ticks: totals().reported_usd_ticks, calls: totals().reported_calls },
        { key: "estimated", label: copy().estimated, ticks: totals().estimated_usd_ticks, calls: totals().estimated_calls },
      ] as Side[]
    ).filter((side) => side.ticks != null);

  /** One side covering every call says nothing the call count does not. */
  const footOf = (side: Side): string | null => (sides().length > 1 || side.calls !== totals().calls ? copy().coveredCalls(side.calls) : null);

  /** Cached is inside input and reasoning inside output: the bar splits each in two, never adds them on. */
  const mix = () => {
    const input = totals().input_tokens ?? 0;
    const output = totals().output_tokens ?? 0;
    const cached = Math.min(input, totals().cached_tokens ?? 0);
    const reasoning = Math.min(output, totals().reasoning_tokens ?? 0);
    const whole = input + output;
    if (whole <= 0) return [];
    return [
      { key: "cached", label: copy().cached, value: cached },
      { key: "fresh", label: copy().freshInput, value: input - cached },
      { key: "output", label: copy().plainOutput, value: output - reasoning },
      { key: "reasoning", label: copy().reasoning, value: reasoning },
    ]
      .filter((part) => part.value > 0)
      .map((part) => ({ ...part, share: (part.value / whole) * 100 }));
  };

  const cacheHit = () => (totals().input_tokens && totals().cached_tokens ? Math.min(1, totals().cached_tokens! / totals().input_tokens!) : null);
  const full = (value: number | null) => value?.toLocaleString(props.locale);

  /** Input in the accent, output in purple; the inner part of each is its paler shade. */
  const mixColor = (key: string): string => {
    switch (key) {
      case "cached":
        return mixColors(String(token("brand")), String(token("pane")), 45);
      case "output":
        return String(token("purple"));
      case "reasoning":
        return mixColors(String(token("purple")), String(token("pane")), 45);
      default:
        return String(token("brand"));
    }
  };

  const tile = () => `${SURFACE} justify-end gap-1 ${narrow() ? "px-[14px] py-3" : "px-4 py-[14px] min-h-[92px]"}`;
  const tileStyle = () => ({ flexGrow: 1, flexShrink: 1, flexBasis: narrow() ? "40%" : 140, minWidth: 0 }) as const;
  const label = "text-[12px] font-medium text-ink-muted";
  const value = () => `font-bold text-ink ${narrow() ? "text-[20px]" : "text-[22px]"}`;

  return (
    <View testID="spend-summary" role="region" accessibilityLabel={copy().totals} class={narrow() ? "gap-3" : "gap-4"}>
      <View class={`flex-row flex-wrap ${narrow() ? "gap-[10px]" : "gap-3"}`}>
        <View
          testID="spend-money"
          class={tile()}
          style={{ flexGrow: 2, flexShrink: 1, flexBasis: narrow() ? "100%" : 240, minWidth: 0 }}
        >
          <If
            when={sides().length > 0}
            else={
              <View class="flex-row flex-wrap gap-x-7 gap-y-3 min-w-0">
                <View class="items-start gap-[2px] min-w-0">
                  <Text class={label}>{copy().totalTokens}</Text>
                  <Text class={`font-bold text-ink ${narrow() ? "text-[30px]" : "text-[34px]"}`} tooltip={full(totals().total_tokens) ? tip(full(totals().total_tokens)!) : undefined}>
                    {props.num(totals().total_tokens)}
                  </Text>
                  <Text class="text-[12px] text-ink-muted">{copy().estimateUnavailable}</Text>
                </View>
              </View>
            }
          >
            <View class={`flex-row flex-wrap min-w-0 ${narrow() ? "gap-x-7" : "gap-x-9"} gap-y-3`}>
              <Each of={sides()} key={(side) => side.key}>
                {(side) => (
                  <View testID={`spend-money-${side().key}`} class="items-start gap-[2px] min-w-0">
                    <View class="flex-row items-center gap-[6px]">
                      <View
                        class="w-[7px] h-[7px] rounded-full"
                        style={side().key === "estimated" ? { borderWidth: 1.5, borderColor: token("ink-muted") } : { backgroundColor: token("brand") }}
                      />
                      <Text class={label}>{side().label}</Text>
                    </View>
                    <Text
                      testID={`spend-money-${side().key}-amount`}
                      class={`font-bold text-ink ${sides().length > 1 ? (narrow() ? "text-[22px]" : "text-[26px]") : narrow() ? "text-[30px]" : "text-[34px]"}`}
                    >
                      {props.money(side().ticks)}
                    </Text>
                    <If when={footOf(side())}>{(foot) => <Text class="text-[12px] text-ink-muted">{foot()}</Text>}</If>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </View>

        <View testID="spend-calls" class={tile()} style={tileStyle()}>
          <Text class={label}>{copy().calls}</Text>
          <Text class={`${value()} line-clamp-1`}>{totals().calls.toLocaleString(props.locale)}</Text>
        </View>
        <If when={sides().length > 0}>
          <View testID="spend-tokens" class={tile()} style={tileStyle()}>
            <Text class={label}>{copy().totalTokens}</Text>
            <Text class={`${value()} line-clamp-1`} tooltip={full(totals().total_tokens) ? tip(full(totals().total_tokens)!) : undefined}>
              {props.num(totals().total_tokens)}
            </Text>
          </View>
        </If>
        <If when={cacheHit() != null}>
          <View testID="spend-cache-hit" class={tile()} style={tileStyle()}>
            <Text class={label}>{copy().cacheHit}</Text>
            <Text class={`${value()} line-clamp-1`}>{sharePercent(cacheHit()! * 100)}</Text>
            <Text class="text-[12px] text-ink-muted">{copy().cacheHitOf(props.num(totals().cached_tokens), props.num(totals().input_tokens))}</Text>
          </View>
        </If>
        <If when={props.extra}>
          <View style={{ flexGrow: 1.6, flexShrink: 1, flexBasis: narrow() ? "100%" : 240, minWidth: 0 }}>{props.extra}</View>
        </If>
      </View>

      <View class={SURFACE}>
        <View
          accessibilityLabel={copy().usageDetails}
          class={`flex-wrap pt-3 ${narrow() ? "px-4 gap-y-[6px]" : "px-5 flex-row gap-x-9 gap-y-2"}`}
        >
          <View class="flex-row flex-wrap items-baseline gap-x-2 gap-y-[2px] min-w-0">
            <Text class="text-[13px] text-ink-muted">{copy().input}</Text>
            <Text testID="spend-input-tokens" class="text-[13px] font-semibold text-ink" tooltip={full(totals().input_tokens) ? tip(full(totals().input_tokens)!) : undefined}>
              {props.num(totals().input_tokens)}
            </Text>
            <If when={totals().cached_tokens}>
              <Text class="text-[12px] text-ink-muted">{copy().cachedWithin(props.num(totals().cached_tokens))}</Text>
            </If>
          </View>
          <View class="flex-row flex-wrap items-baseline gap-x-2 gap-y-[2px] min-w-0">
            <Text class="text-[13px] text-ink-muted">{copy().output}</Text>
            <Text testID="spend-output-tokens" class="text-[13px] font-semibold text-ink" tooltip={full(totals().output_tokens) ? tip(full(totals().output_tokens)!) : undefined}>
              {props.num(totals().output_tokens)}
            </Text>
            <If when={totals().reasoning_tokens}>
              <Text class="text-[12px] text-ink-muted">{copy().reasoningWithin(props.num(totals().reasoning_tokens))}</Text>
            </If>
          </View>
        </View>

        <If when={mix().length > 0}>
          <View
            testID="spend-token-mix"
            role="image"
            accessibilityLabel={`${copy().tokenMix}: ${mix().map((part) => `${part.label} ${props.num(part.value)} ${sharePercent(part.share)}`).join(", ")}`}
            class={`gap-[10px] pt-3 pb-[14px] ${narrow() ? "px-4" : "px-5"}`}
          >
            <View accessible={false} class="flex-row gap-[2px] h-[12px] rounded-[4px] overflow-hidden bg-line-subtle">
              <Each of={mix()} key={(part) => part.key}>
                {(part) => (
                  <View
                    testID={`spend-mix-${part().key}`}
                    class="h-full min-w-[3px]"
                    style={{ width: `${part().share}%`, backgroundColor: mixColor(part().key) }}
                    tooltip={tip(`${part().label} ${props.num(part().value)} · ${sharePercent(part().share)}`)}
                  />
                )}
              </Each>
            </View>
            <View accessible={false} class="flex-row flex-wrap gap-x-[22px] gap-y-[6px]">
              <Each of={mix()} key={(part) => part.key}>
                {(part) => (
                  <View class="flex-row items-center gap-[6px]">
                    <View class="w-[8px] h-[8px] rounded-[2px]" style={{ backgroundColor: mixColor(part().key) }} />
                    <Text class="text-[12px] text-ink-muted">{part().label}</Text>
                    <Text class="text-[12px] font-semibold text-ink">{props.num(part().value)}</Text>
                    <Text class="text-[12px] text-ink-muted">{sharePercent(part().share)}</Text>
                  </View>
                )}
              </Each>
            </View>
          </View>
        </If>

        <View class="border-t border-line-subtle">
          <View
            testID="spend-coverage"
            role="button"
            accessibilityState={{ expanded: open() }}
            onPress={() => open.update((v) => !v)}
            class={`cursor-pointer select-none group flex-row items-start gap-2 py-[10px] ${narrow() ? "px-4" : "px-5"}`}
          >
            <View class="h-[18px] justify-center">
              <SpendIcon name="info" size={12} class="tint-ink-muted" />
            </View>
            <Text class="flex-1 min-w-0 text-[12px] leading-[18px] text-ink-muted group-hover:text-ink-secondary">
              <Text class="font-medium text-ink-secondary">{copy().coverage}</Text>
              <Text class="text-ink-muted">{" · "}</Text>
              {totals().missing_usage_calls ? copy().missingUsage(totals().missing_usage_calls) : copy().estimateCoverage(totals().reported_calls, totals().estimated_calls)}
            </Text>
            <View class={`h-[18px] justify-center ${open() ? "rotate-180" : ""}`}>
              <SpendIcon name="chevron" size={12} class="tint-ink-muted" />
            </View>
          </View>
          <If when={open()}>
            <View testID="spend-coverage-body" class={`gap-[2px] pb-3 ${narrow() ? "pl-[38px] pr-4" : "pl-[42px] pr-5"}`}>
              <Text class="text-[12px] leading-[19px] text-ink-secondary">{copy().estimatedHint}</Text>
              <Text class="text-[12px] leading-[19px] text-ink-secondary">{copy().estimateCoverage(totals().reported_calls, totals().estimated_calls)}</Text>
              <If when={totals().missing_calls}>
                <Text class="text-[12px] leading-[19px] text-ink-secondary">{`${copy().missingAmount(totals().missing_calls)} · ${copy().estimateUnknown}`}</Text>
              </If>
              <If when={totals().missing_usage_calls}>
                <Text class="text-[12px] leading-[19px] text-ink-secondary">{copy().missingUsage(totals().missing_usage_calls)}</Text>
              </If>
            </View>
          </If>
        </View>
      </View>
    </View>
  );
}
