/**
 * The daily trend (`SpendTrend.svelte`): a stacked bar per day (or per run of days, at most 28
 * bars) by category, tokens as one plot and money as two (reported and estimated, on one scale,
 * never summed). The messenger lays the bars out as DOM boxes; here each bar is a pressable view
 * holding a `Canvas` that draws its stack with the same geometry and colours, the estimated side
 * hatched. Pointing at or pressing a bar reads it out below. Width is the component's own box.
 */
import { Canvas, effect, signal, Text, token, View, type CanvasRenderingContext2D } from "nsh";
import type { SpendCategory, SpendGroup } from "@real-bot/protocol";
import { localeTag } from "../../m/locale-tag.ts";
import { formatTokens, formatUsd } from "../../m/spend-format.ts";
import { spendCopyFor } from "../../m/spend/spend-copy.ts";
import {
  SPEND_TREND_CATEGORIES,
  bucketSpendDays,
  spendTrendCategoryValue,
  spendTrendMax,
  type SpendTrendBucket,
  type SpendTrendField,
} from "../../m/spend/spend-trend.ts";
import { categoryColor } from "./spend-style";
import { settled } from "../workbench/drag-settle";

/** Chart words that the ledger copy does not already name. */
function chartWords(locale: "zh" | "en") {
  return locale === "en"
    ? { unknown: "Unknown", zero: "0", range: (from: string, to: string) => `${from} – ${to}`, plot: "Trend plot", missing: "Missing" }
    : { unknown: "未知", zero: "0", range: (from: string, to: string) => `${from} 至 ${to}`, plot: "趋势图", missing: "缺失" };
}

/** The usual box of a bar's stack: its widest, and the corner its top rounds by. */
const STACK_RADIUS = 2;

type Segment = { category: SpendCategory; height: number };

/**
 * One bar's stack, bottom up in the category order: each segment as high as its share of the plot's
 * scale, at least a point; the estimated side striped; a day with no figure a dot, a day at zero a dash.
 */
function drawStack(cx: CanvasRenderingContext2D, width: number, height: number, parts: Segment[], estimated: boolean, state: "missing" | "zero" | null): void {
  let bottom = height;
  for (const part of parts) {
    if (part.height <= 0) continue;
    const h = Math.max(1, (part.height / 100) * height);
    const top = bottom - h;
    cx.fillStyle = categoryColor(part.category);
    cx.fillRect(0, top, width, h);
    if (estimated) hatch(cx, 0, top, width, h);
    bottom = top;
  }
  if (state === "missing") {
    const r = 3;
    cx.fillStyle = String(token("pane"));
    cx.beginPath();
    cx.arc(width / 2, height - r, r + 2, 0, Math.PI * 2);
    cx.fill();
    cx.fillStyle = String(token("muted-light"));
    cx.beginPath();
    cx.arc(width / 2, height - r, r, 0, Math.PI * 2);
    cx.fill();
  } else if (state === "zero") {
    cx.fillStyle = String(token("ink-secondary"));
    cx.beginPath();
    cx.roundRect(width / 2 - 5, height - 2, 10, 2, 1);
    cx.fill();
  }
}

/** `repeating-linear-gradient(-45deg, transparent 2px, pane 45% 1px)`: "/" stripes a pixel wide every 3 points across, clipped to the rect by hand. */
function hatch(cx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  cx.strokeStyle = String(token("pane"));
  cx.globalAlpha = 0.45;
  cx.lineWidth = 1;
  cx.lineCap = "butt";
  const step = 3 * Math.SQRT2;
  // A "/" stripe is x + y = c; it meets the rect between these corners.
  for (let c = x + y + step / 2; c < x + w + y + h; c += step) {
    const xa = Math.min(x + w, c - y);
    const xb = Math.max(x, c - (y + h));
    if (xb >= xa) continue;
    cx.beginPath();
    cx.moveTo(xb, c - xb);
    cx.lineTo(xa, c - xa);
    cx.stroke();
  }
  cx.globalAlpha = 1;
}

export function SpendTrend(props: {
  days: SpendGroup[];
  metric: "tokens" | "money";
  locale: "zh" | "en";
  /** Inclusive `from` and exclusive `to`, both UTC instants. Leading and trailing days stay on the axis. */
  range?: { from?: string; to?: string };
  /** IANA zone the range is named in. Defaults to UTC. */
  timeZone?: string;
}) {
  const copy = () => spendCopyFor(props.locale);
  const words = () => chartWords(props.locale);
  const width = signal(0);

  const buckets = () => bucketSpendDays(props.days, undefined, props.range, props.timeZone ?? "UTC");
  const scopeKey = () =>
    `${props.range?.from ?? ""}/${props.range?.to ?? ""}/${props.timeZone ?? "UTC"}|` + buckets().map((bucket) => `${bucket.id ?? ""}:${bucket.dayCount}`).join("|");
  /** A span that crosses a year boundary names the year, so Jan 1 of two years cannot look like one day. */
  const spansYears = () => {
    const years = new Set<string>();
    for (const bucket of buckets()) {
      if (bucket.from) years.add(bucket.from.slice(0, 4));
      if (bucket.to) years.add(bucket.to.slice(0, 4));
    }
    return years.size > 1;
  };

  /** Which bar each plot is showing. Money has two plots; they do not share a selection. */
  const selected = signal<Record<string, number | null>>({});
  /** The plot whose values the readout is repeating. */
  const readoutPlot = signal<string | null>(null);

  /** A new range, metric, or locale is a different chart. The old bar is not still selected. */
  effect(() => {
    void scopeKey();
    void props.metric;
    void props.locale;
    selected.set({});
    readoutPlot.set(null);
  });

  const tokenScale = () => spendTrendMax(buckets(), "total_tokens");
  /**
   * Money is two plots on one scale, never one sum. A side with no amount on any day in the range
   * is not drawn as an empty plot beside the other; with nothing on either side both stay.
   */
  const moneyPlots = () => {
    const reported = buckets().some((bucket) => bucket.reported_usd_ticks != null);
    const estimated = buckets().some((bucket) => bucket.estimated_usd_ticks != null);
    return { reported: reported || !estimated, estimated: estimated || !reported };
  };
  const moneyScale = () => Math.max(spendTrendMax(buckets(), "reported_usd_ticks"), spendTrendMax(buckets(), "estimated_usd_ticks"));

  const labelIndexes = (): number[] => {
    const last = buckets().length - 1;
    if (last < 0) return [];
    if (last === 0) return [0];
    const mid = Math.floor(last / 2);
    return mid === 0 || mid === last ? [0, last] : [0, mid, last];
  };

  function formatDay(id: string | null, withYear: boolean): string {
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(id)) return copy().dash;
    const [year, month, day] = id.split("-").map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day));
    return new Intl.DateTimeFormat(localeTag(props.locale), {
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" as const } : {}),
      timeZone: "UTC",
    }).format(date);
  }

  /**
   * A chart, or a bar, that crosses a year names the year on the axis, the readout, and the bar.
   * Both ends of one bar are named when they fall in different years.
   */
  function bucketLabel(bucket: SpendTrendBucket): string {
    const fromYear = bucket.from?.slice(0, 4);
    const toYear = bucket.to?.slice(0, 4);
    const crosses = fromYear != null && toYear != null && fromYear !== toYear;
    const years = spansYears() || crosses;
    if (bucket.dayCount > 1 && bucket.from && bucket.to && bucket.from !== bucket.to) {
      return words().range(formatDay(bucket.from, years), formatDay(bucket.to, years));
    }
    return formatDay(bucket.from ?? bucket.id, years);
  }

  function amount(field: SpendTrendField, value: number | null): string {
    if (value == null) return copy().dash;
    return field === "total_tokens" ? formatTokens(value) : formatUsd(value);
  }

  function categoryLine(bucket: SpendTrendBucket, category: SpendCategory, field: SpendTrendField): string {
    const text = amount(field, spendTrendCategoryValue(bucket, category, field));
    const name = copy().category[category];
    return field === "total_tokens" ? copy().dayTokens(bucketLabel(bucket), name, text) : copy().dayAmount(bucketLabel(bucket), name, text);
  }

  function plotLabel(bucket: SpendTrendBucket, field: SpendTrendField): string {
    const head = field === "reported_usd_ticks" ? copy().reportedStack : field === "estimated_usd_ticks" ? copy().estimatedStack : copy().metricTokens;
    const parts = SPEND_TREND_CATEGORIES.map((category) => categoryLine(bucket, category, field));
    return `${head} ${bucketLabel(bucket)} ${amount(field, bucket[field])}. ${parts.join(", ")}`;
  }

  function trimAxis(value: number): string {
    const text = value.toFixed(1);
    return text.endsWith(".0") ? text.slice(0, -2) : text;
  }

  function yMax(field: SpendTrendField): string {
    const scale = field === "total_tokens" ? tokenScale() : moneyScale();
    if (scale <= 0) return copy().dash;
    if (field === "total_tokens") return formatTokens(scale);
    const usd = scale / 10_000_000_000;
    if (usd === 0) return "$0";
    if (Math.abs(usd) >= 1000) return `$${trimAxis(usd / 1000)}k`;
    if (Math.abs(usd) >= 100) return `$${Math.round(usd)}`;
    if (Math.abs(usd) >= 1) return `$${trimAxis(usd)}`;
    return formatUsd(scale);
  }

  function segments(bucket: SpendTrendBucket, field: SpendTrendField, scale: number): Segment[] {
    return SPEND_TREND_CATEGORIES.map((category) => {
      const value = spendTrendCategoryValue(bucket, category, field);
      return { category, height: value != null && value > 0 && scale > 0 ? (value / scale) * 100 : 0 };
    });
  }

  const chosen = (plotKey: string): number | null => selected()[plotKey] ?? null;
  function select(plotKey: string, index: number): void {
    selected.set({ ...selected(), [plotKey]: index });
    readoutPlot.set(plotKey);
  }

  // The container's breakpoints (560 and 450 points), on the component's own box.
  const wide = settled(() => width() >= 560);
  const tight = settled(() => width() > 0 && width() <= 450);
  const plotHeight = () => (wide() ? 210 : tight() ? 150 : 180);

  const swatch = (category: SpendCategory) => <View class="w-[8px] h-[8px] rounded-[2px] shrink-0" style={{ backgroundColor: categoryColor(category) }} />;

  function plot(field: SpendTrendField, scale: () => number, title: string, plotKey: string, estimated = false) {
    return (
      <View testID={`spend-plot-${plotKey}`} role="group" accessibilityLabel={title || words().plot} class="min-w-0 gap-2">
        <If when={title}>
          <Text class="mb-1 text-[12px] font-medium text-ink-muted">{title}</Text>
        </If>
        <View class="flex-row items-stretch gap-2 min-w-0">
          <View accessible={false} class="items-end justify-between py-[2px] max-w-[52px] shrink-0" style={{ height: plotHeight() }}>
            <Text class="text-[11px] leading-[11px] text-ink-muted">{yMax(field)}</Text>
            <Text class="text-[11px] leading-[11px] text-ink-muted">{scale() > 0 ? words().zero : copy().dash}</Text>
          </View>
          <View class="flex-1 min-w-0">
            <View role="list" accessibilityLabel={title || words().plot} class="relative flex-row items-end border-b border-line" style={{ height: plotHeight(), gap: tight() ? 2 : 3 }}>
              <Canvas
                accessible={false}
                style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" }}
                draw={(cx, size) => {
                  // A hairline at the top of each quarter, as the messenger's background gradient.
                  cx.fillStyle = String(token("line-subtle"));
                  for (let i = 0; i < 4; i++) cx.fillRect(0, Math.round((size.height * i) / 4), size.width, 1);
                }}
              />
              <Each of={buckets()} key={(bucket, index) => plotKey + (bucket.id ?? "none") + index}>
                {(bucket, index) => {
                  const active = () => chosen(plotKey) === index();
                  const parts = () => segments(bucket(), field, scale());
                  const state = () => (bucket()[field] == null ? ("missing" as const) : bucket()[field] === 0 ? ("zero" as const) : null);
                  return (
                    <View
                      testID={`spend-bar-${plotKey}-${index()}`}
                      role="button"
                      accessibilityLabel={plotLabel(bucket(), field)}
                      accessibilityState={{ selected: active() }}
                      onPress={() => select(plotKey, index())}
                      onMouseEnter={() => select(plotKey, index())}
                      onFocus={() => select(plotKey, index())}
                      class={`cursor-pointer select-none flex-1 min-w-0 h-full items-center justify-end rounded-(--radius-sm) ${active() ? "bg-accent-tint" : "hover:bg-line-subtle"}`}
                    >
                      <Canvas
                        accessible={false}
                        style={{
                          width: "100%",
                          maxWidth: tight() ? 22 : 32,
                          height: "100%",
                          borderTopLeftRadius: STACK_RADIUS,
                          borderTopRightRadius: STACK_RADIUS,
                          overflow: "hidden",
                        }}
                        draw={(cx, size) => drawStack(cx, size.width, size.height, parts(), estimated, state())}
                      />
                    </View>
                  );
                }}
              </Each>
            </View>
            <View accessible={false} class="flex-row justify-between gap-1 min-w-0 pt-[6px]">
              <Each of={labelIndexes()} key={(i) => i}>
                {(i, position) => (
                  <Text
                    class={`flex-1 min-w-0 text-ink-muted line-clamp-1 ${tight() ? "text-[10px]" : "text-[11px]"} ${position() === 0 ? "text-left" : i() === buckets().length - 1 ? "text-right" : "text-center"}`}
                  >
                    {bucketLabel(buckets()[i()]!)}
                  </Text>
                )}
              </Each>
            </View>
          </View>
        </View>
      </View>
    );
  }

  /** One figure per category for the bar being read. */
  const readoutRows = (bucket: SpendTrendBucket, field: SpendTrendField) => (
    <View class="flex-row flex-wrap gap-x-5 gap-y-1">
      {SPEND_TREND_CATEGORIES.map((category) => {
        const value = spendTrendCategoryValue(bucket, category, field);
        return (
          <View class="flex-row items-center justify-between gap-3 min-w-0" style={{ flexGrow: 1, flexBasis: 150 }}>
            <View class="flex-row items-center gap-[6px] min-w-0">
              {swatch(category)}
              <Text class="shrink text-[12px] text-ink-secondary line-clamp-1">{copy().category[category]}</Text>
            </View>
            <Text class={`text-[12px] shrink-0 ${value == null ? "text-ink-muted" : "text-ink"}`}>
              {value == null ? `${copy().dash} ${words().unknown}` : field === "total_tokens" ? formatTokens(value) : formatUsd(value)}
            </Text>
          </View>
        );
      })}
    </View>
  );

  const readoutBucket = () => {
    const plotKey = readoutPlot();
    const index = plotKey ? chosen(plotKey) : null;
    return index != null ? (buckets()[index] ?? null) : null;
  };

  return (
    <View
      testID="spend-trend"
      role="region"
      accessibilityLabel={copy().trend}
      class="gap-4 min-w-0 max-w-full"
      onLayout={(e) => width.set(e.bounds.size.width)}
    >
      <If when={buckets().length > 0} else={<Text testID="spend-trend-empty" class="text-[13px] text-ink-muted">{copy().empty}</Text>}>
        <View testID="spend-trend-legend" class="flex-row flex-wrap gap-x-4 gap-y-2">
          {SPEND_TREND_CATEGORIES.map((category) => (
            <View class="flex-row items-center gap-[6px]">
              {swatch(category)}
              <Text class="text-[12px] text-ink-muted">{copy().category[category]}</Text>
            </View>
          ))}
        </View>

        <If
          when={props.metric === "money"}
          else={plot("total_tokens", tokenScale, "", "tokens")}
        >
          <View class={`min-w-0 gap-4 ${wide() && moneyPlots().reported && moneyPlots().estimated ? "flex-row items-start" : ""}`}>
            <If when={moneyPlots().reported}>
              <View class={wide() ? "flex-1 min-w-0" : "min-w-0"}>{plot("reported_usd_ticks", moneyScale, copy().reportedStack, "reported")}</View>
            </If>
            <If when={moneyPlots().estimated}>
              <View class={wide() ? "flex-1 min-w-0" : "min-w-0"}>{plot("estimated_usd_ticks", moneyScale, copy().estimatedStack, "estimated", true)}</View>
            </If>
          </View>
        </If>

        <If when={readoutBucket()}>
          {(bucket) => (
            <View testID="spend-readout" accessibilityLabel={bucketLabel(bucket())} class="gap-[6px] px-3 py-[10px] rounded-(--radius-sm) bg-line-subtle">
              <View class="flex-row items-center justify-between gap-2">
                <Text testID="spend-readout-date" class="text-[13px] font-semibold text-ink-secondary">
                  {bucketLabel(bucket())}
                </Text>
                <Text class="text-[11px] font-medium text-ink-muted">
                  {readoutPlot() === "tokens" ? copy().metricTokens : readoutPlot() === "estimated" ? copy().estimated : copy().reported}
                </Text>
              </View>
              {readoutRows(bucket(), readoutPlot() === "tokens" ? "total_tokens" : readoutPlot() === "estimated" ? "estimated_usd_ticks" : "reported_usd_ticks")}
            </View>
          )}
        </If>
      </If>
    </View>
  );
}
