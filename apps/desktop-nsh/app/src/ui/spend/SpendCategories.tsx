/**
 * The overview's trend and category cards (`SpendCategories.svelte`): the daily trend with its
 * Tokens/Money switch, and every category's share of the tokens as one bar with a row each, a
 * category opening into its lines. Pressing a name drills the ledger into it.
 */
import { Text, View, windowSize } from "nsh";
import type { SpendSummary } from "@real-bot/protocol";
import type { SpendCopy } from "../../m/spend/spend-copy.ts";
import type { SpendLedger } from "../../m/spend/spend-ledger.svelte.ts";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";
import { Segmented } from "./Segmented";
import { SpendAmount } from "./SpendAmount";
import { SpendIcon } from "./SpendIcon";
import { SpendTrend } from "./SpendTrend";
import { SECTION_HEAD, SURFACE, categoryColor, sharePercent } from "./spend-style";

export function SpendCategories(props: {
  copy: SpendCopy;
  locale: "zh" | "en";
  timeZone: string;
  ledger: SpendLedger;
  categories: SpendSummary["categories"];
  num: (value: number | null) => string;
  /** The ledger is narrower than 620 points (its container query); defaults to a phone-sized window. */
  narrow?: boolean;
  /** The ledger is 1000 points or wider: the trend and the categories sit side by side. */
  wide?: boolean;
}) {
  const narrow = () => props.narrow ?? narrowWindow();
  const wide = () => props.wide ?? (!narrowWindow() && windowSize().width >= 1000);
  const copy = () => props.copy;

  /** A category or line nothing was called under takes no row. */
  const shown = () => props.categories.filter((row) => row.calls > 0).map((row) => ({ ...row, kinds: row.kinds.filter((kind) => kind.calls > 0) }));
  const whole = () => shown().reduce((sum, row) => sum + (row.total_tokens ?? 0), 0);
  const share = (value: number | null) => (value != null && whole() > 0 ? (value / whole()) * 100 : 0);
  const percent = (value: number | null) => sharePercent(share(value));
  const meta = (row: { calls: number; total_tokens: number | null }) => `${copy().recordedCalls(row.calls)} · ${copy().tokens(props.num(row.total_tokens))}`;
  const pad = () => (narrow() ? "px-[14px]" : "px-[18px]");

  const trendCard = (
    <View testID="spend-trend-card" role="region" accessibilityLabel={copy().trend} class={`${SURFACE} ${wide() ? "flex-[2]" : ""}`}>
      <View class={`${SECTION_HEAD} pb-[6px]`}>
        <Text role="header" class="text-[14px] font-semibold text-ink">
          {copy().trend}
        </Text>
        <Segmented
          testID="spend-metric"
          label={copy().trend}
          value={props.ledger.view.metric}
          onChange={(metric) => {
            props.ledger.view.metric = metric;
          }}
          items={[
            { value: "tokens", label: copy().metricTokens, testID: "spend-metric-tokens" },
            { value: "money", label: copy().metricMoney, testID: "spend-metric-money" },
          ]}
        />
      </View>
      <View class={narrow() ? "pt-1 px-[14px] pb-[14px]" : "pt-[6px] px-[18px] pb-[18px]"}>
        <SpendTrend days={props.ledger.days} metric={props.ledger.view.metric} locale={props.locale} range={props.ledger.askedWindow} timeZone={props.timeZone} />
      </View>
    </View>
  );

  const categoryCard = (
    <View testID="spend-category-card" role="region" accessibilityLabel={copy().categories} class={`${SURFACE} ${wide() ? "flex-1 min-w-[300px]" : ""}`}>
      <View class={SECTION_HEAD}>
        <Text role="header" class="text-[14px] font-semibold text-ink">
          {copy().categories}
        </Text>
        <Text class="text-[11px] text-ink-muted">{copy().barsByTokens}</Text>
      </View>
      <If when={whole() > 0}>
        <View testID="spend-share-bar" accessible={false} class={`flex-row gap-[2px] h-[10px] mb-1 rounded-[4px] overflow-hidden bg-line-subtle ${narrow() ? "mx-[14px]" : "mx-[18px]"}`}>
          <Each of={shown()} key={(row) => row.category}>
            {(row) => (
              <If when={share(row().total_tokens) > 0}>
                <View
                  testID={`spend-share-${row().category}`}
                  class="h-full min-w-[3px]"
                  style={{ width: `${share(row().total_tokens)}%`, backgroundColor: categoryColor(row().category) }}
                  tooltip={tip(`${copy().category[row().category]} ${percent(row().total_tokens)}`)}
                />
              </If>
            )}
          </Each>
        </View>
      </If>
      <View class={`pb-[10px] ${pad()}`}>
        <Each of={shown()} key={(row) => row.category}>
          {(row, index) => (
            <View testID={`spend-category-${row().category}`} class={`gap-[3px] pt-2 pb-[9px] ${index() > 0 ? "border-t border-line-subtle" : ""}`}>
              <View class="flex-row items-center gap-2 min-w-0">
                <View
                  testID={`spend-category-name-${row().category}`}
                  role="button"
                  disabled={props.ledger.loading}
                  onPress={() => props.ledger.drillCategory(row().category)}
                  class="cursor-pointer select-none disabled:cursor-default group flex-1 min-w-0 flex-row items-center gap-2 min-h-[24px]"
                >
                  <View class="w-[8px] h-[8px] rounded-[2px] shrink-0" style={{ backgroundColor: categoryColor(row().category) }} />
                  <Text class="shrink text-[13px] font-semibold text-ink line-clamp-1 group-hover:text-brand">{copy().category[row().category]}</Text>
                </View>
                <SpendAmount copy={copy()} reported={row().reported_usd_ticks} estimated={row().estimated_usd_ticks} missing={copy().estimateUnknown} />
                <If when={row().kinds.length > 1} else={<View class="w-[28px] shrink-0" />}>
                  <View
                    testID={`spend-category-toggle-${row().category}`}
                    role="button"
                    tooltip={tip(props.ledger.expanded[row().category] ? copy().collapse : copy().expand)}
                    accessibilityLabel={props.ledger.expanded[row().category] ? copy().collapse : copy().expand}
                    accessibilityState={{ expanded: !!props.ledger.expanded[row().category] }}
                    onPress={() => props.ledger.toggleCategory(row().category)}
                    class="cursor-pointer select-none w-[28px] h-[28px] items-center justify-center shrink-0 rounded-(--radius-sm) hover:bg-line-subtle"
                  >
                    <SpendIcon name="chevron" size={12} class={props.ledger.expanded[row().category] ? "rotate-180 tint-ink-muted" : "tint-ink-muted"} />
                  </View>
                </If>
              </View>
              <View class="flex-row justify-between gap-2 mr-9 pl-4">
                <Text class="text-[11.5px] text-ink-muted">{meta(row())}</Text>
                <If when={whole() > 0}>
                  <Text class="text-[11.5px] font-semibold text-ink-secondary">{percent(row().total_tokens)}</Text>
                </If>
              </View>
              <If when={props.ledger.expanded[row().category]}>
                <View testID={`spend-kinds-${row().category}`} class="mt-2 mr-9 ml-4 pl-[10px] border-l-2 border-line gap-[6px]">
                  <Each of={row().kinds} key={(kind) => kind.kind}>
                    {(kind) => (
                      <View class="gap-y-0">
                        <View class="flex-row items-center gap-[10px]">
                          <View
                            testID={`spend-kind-${kind().kind}`}
                            role="button"
                            disabled={props.ledger.loading}
                            onPress={() => props.ledger.drillKind(kind().kind)}
                            class="cursor-pointer select-none disabled:cursor-default group flex-1 min-w-0 min-h-[24px] justify-center px-1"
                          >
                            <Text class="text-[12px] font-medium text-brand group-hover:underline">{copy().kind[kind().kind]}</Text>
                          </View>
                          <SpendAmount copy={copy()} reported={kind().reported_usd_ticks} estimated={kind().estimated_usd_ticks} missing={copy().estimateUnknown} />
                        </View>
                        <Text class="text-[11px] text-ink-muted">{meta(kind())}</Text>
                      </View>
                    )}
                  </Each>
                </View>
              </If>
            </View>
          )}
        </Each>
      </View>
    </View>
  );

  return (
    <View testID="spend-analysis" class={`gap-4 ${wide() ? "flex-row items-stretch" : ""}`}>
      {trendCard}
      {categoryCard}
    </View>
  );
}
