/**
 * The spend ledger's parts: the header with its period picker, the overview's totals with the cap,
 * the trend and the categories, on a ledger the story feeds from a fake API (a week of days in
 * October 2026, in UTC), and the small parts (a row's money, a Bot's face) beside it.
 */
import { computed, signal, Scroll, Text, View } from "nsh";
import type { Bot, SpendCategory, SpendCategorySummary, SpendGroup, SpendLine, SpendSummary, SpendTotals } from "@real-bot/protocol";
import { SPEND_CATEGORY_OF } from "@real-bot/protocol";
import { runtime } from "../src/runtime";
import type { MessengerApi } from "../src/m/messenger-api.ts";
import { spendCopyFor } from "../src/m/spend/spend-copy.ts";
import { SpendLedger } from "../src/m/spend/spend-ledger.svelte.ts";
import { DEFAULT_SPEND_VIEW, spendWindow, type SpendDrill, type SpendRangePreset, type SpendViewState } from "../src/m/spend/spend-query.ts";
import { state } from "../src/lib/reactive";
import { formatTokens, formatUsd } from "../src/m/spend-format.ts";
import { Button } from "../src/ui/Button";
import { narrowWindow } from "../src/ui/Modal";
import { SpendAmount } from "../src/ui/spend/SpendAmount";
import { SpendBotFace } from "../src/ui/spend/SpendBotFace";
import { SpendCap } from "../src/ui/spend/SpendCap";
import { SpendCategories } from "../src/ui/spend/SpendCategories";
import { SpendHeader } from "../src/ui/spend/SpendHeader";
import { SpendSummary as Summary } from "../src/ui/spend/SpendSummary";

const NOW = new Date("2026-10-10T08:00:00.000Z");
const USD = 10_000_000_000;

const totals = (partial: Partial<SpendTotals> = {}): SpendTotals => ({
  calls: 0,
  input_tokens: null,
  cached_tokens: null,
  output_tokens: null,
  reasoning_tokens: null,
  total_tokens: null,
  reported_usd_ticks: null,
  estimated_usd_ticks: null,
  reported_calls: 0,
  estimated_calls: 0,
  missing_calls: 0,
  missing_usage_calls: 0,
  ...partial,
});

const line = (kind: SpendLine, partial: Partial<SpendTotals>) => ({ ...totals({ calls: 1, ...partial }), kind });
const category = (name: SpendCategory, kinds: ReturnType<typeof line>[]): SpendCategorySummary => {
  const sum = (key: "calls" | "total_tokens" | "reported_usd_ticks" | "estimated_usd_ticks") => kinds.reduce((n, k) => n + (k[key] ?? 0), 0);
  return {
    ...totals({
      calls: sum("calls"),
      total_tokens: sum("total_tokens"),
      reported_usd_ticks: sum("reported_usd_ticks") || null,
      estimated_usd_ticks: sum("estimated_usd_ticks") || null,
    }),
    category: name,
    kinds,
  };
};

const CATEGORIES: SpendCategorySummary[] = [
  category("turn", [line("turn", { calls: 31, total_tokens: 1_020_000, reported_usd_ticks: 4.2 * USD })]),
  category("judgement", [line("judgement", { calls: 9, total_tokens: 118_000, reported_usd_ticks: 0.31 * USD })]),
  category("decision", [line("route_pick", { calls: 12, total_tokens: 64_000, estimated_usd_ticks: 0.12 * USD }), line("organize", { calls: 3, total_tokens: 21_000, estimated_usd_ticks: 0.05 * USD })]),
  category("feedback", [line("route_review", { calls: 4, total_tokens: 30_000, estimated_usd_ticks: 0.06 * USD }), line("route_learn", { calls: 2, total_tokens: 12_000, estimated_usd_ticks: 0.02 * USD })]),
  category("other", [line("composer_suggest", { calls: 7, total_tokens: 9_000 })]),
];
// Kinds of the SPEND_CATEGORY_OF table keep the story honest about which line sits under which category.
for (const row of CATEGORIES) for (const kind of row.kinds) if (SPEND_CATEGORY_OF[kind.kind] !== row.category) throw new Error(`story: ${kind.kind}`);

const TOTALS = totals({
  calls: 68,
  input_tokens: 1_000_000,
  cached_tokens: 640_000,
  output_tokens: 274_000,
  reasoning_tokens: 52_000,
  total_tokens: 1_274_000,
  reported_usd_ticks: 4.51 * USD,
  estimated_usd_ticks: 0.25 * USD,
  reported_calls: 40,
  estimated_calls: 21,
  missing_calls: 7,
  missing_usage_calls: 3,
});

const DAYS: Array<[string, number[]]> = [
  ["2026-10-04", [120_000, 18_000, 6_000, 2_000, 1_000]],
  ["2026-10-05", [210_000, 22_000, 9_000, 4_000, 2_000]],
  ["2026-10-06", [90_000, 10_000, 4_000, 0, 1_000]],
  ["2026-10-07", [0, 0, 0, 0, 0]],
  ["2026-10-08", [300_000, 40_000, 20_000, 12_000, 3_000]],
  ["2026-10-09", [160_000, 18_000, 26_000, 14_000, 2_000]],
  ["2026-10-10", [140_000, 10_000, 20_000, 10_000, 0]],
];
const NAMES: SpendCategory[] = ["turn", "judgement", "decision", "feedback", "other"];

const dayGroup = (id: string, tokens: number[]): SpendGroup => {
  const categories = NAMES.map((name, i) =>
    tokens[i]! > 0
      ? { ...totals({ calls: 1, total_tokens: tokens[i]!, reported_usd_ticks: name === "turn" || name === "judgement" ? tokens[i]! * 3_000_000 : null, estimated_usd_ticks: name === "decision" || name === "feedback" ? tokens[i]! * 2_000_000 : null }), category: name, kinds: [] }
      : { ...totals({ calls: 0, total_tokens: 0, reported_usd_ticks: 0, estimated_usd_ticks: 0 }), category: name, kinds: [] },
  ) as SpendCategorySummary[];
  const sum = (key: "total_tokens" | "reported_usd_ticks" | "estimated_usd_ticks") => categories.reduce((n, c) => n + (c[key] ?? 0), 0);
  return {
    id,
    name: id,
    deleted: false,
    provider_id: null,
    provider_name: null,
    model: null,
    categories,
    ...totals({ calls: categories.filter((c) => c.calls > 0).length, total_tokens: sum("total_tokens"), reported_usd_ticks: sum("reported_usd_ticks"), estimated_usd_ticks: sum("estimated_usd_ticks") }),
  };
};

const summary = (groupBy: string | undefined): SpendSummary => ({
  totals: TOTALS,
  groups: groupBy === "day" ? DAYS.map(([id, tokens]) => dayGroup(id, tokens)) : [],
  categories: CATEGORIES,
});

const WRITER = { id: "bot-writer", name: "Writer", avatar: null } as unknown as Bot;


/**
 * The ledger's members the header and the cards read, over plain state. `SpendLedger` needs the
 * lazy `derived` of `src/lib/reactive.ts` (its derived fields read `#input` before the constructor
 * has set it); until that lands the story falls back to this, and uses the real one after.
 */
function storyLedger(api: MessengerApi, copy: () => ReturnType<typeof spendCopyFor>) {
  const view = state<SpendViewState>({ ...DEFAULT_SPEND_VIEW });
  const drill = state<SpendDrill>({});
  const expanded = state<Record<string, boolean>>({});
  const data = state<{ summary: SpendSummary | null; days: SpendGroup[]; loading: boolean }>({ summary: null, days: [], loading: true });
  const result = computed(() => spendWindow(view.get(), NOW, "UTC"));
  const load = () => {
    data.set({ ...data.get(), loading: true });
    void Promise.all([api.spendSummary({ group_by: "model" } as never), api.spendSummary({ group_by: "day" } as never)]).then(([sum, trend]) => data.set({ summary: sum, days: trend.groups, loading: false }));
  };
  load();
  const kindsOf = (name: string) => CATEGORIES.find((row) => row.category === name)!.kinds.map((k) => k.kind);
  return {
    get view() { return view.get(); },
    get drill() { return drill.get(); },
    set drill(value: SpendDrill) { drill.set(value); },
    get expanded() { return expanded.get(); },
    get summary() { return data.get().summary; },
    get days() { return data.get().days; },
    get loading() { return data.get().loading; },
    get rangeIssue() { const r = result(); return r.ok ? null : r.issue; },
    get askedWindow() { const r = result(); return r.ok ? { from: r.window.from, to: r.window.to } : {}; },
    get chips() {
      const out: Array<{ key: string; label: string; clear: () => void }> = [];
      const kind = drill.get().kind;
      if (kind && kind.length > 0) out.push({ key: "kind", label: kind.map((k) => copy().kind[k]).join(" · "), clear: () => drill.set({}) });
      return out;
    },
    setRange(range: SpendRangePreset) { view.get().range = range; if (range === "custom" && !view.get().customFrom) { view.get().customFrom = "2026-10-10"; view.get().customTo = "2026-10-10"; } },
    refresh() { load(); },
    toggleCategory(name: string) { expanded.set({ ...expanded.get(), [name]: !expanded.get()[name] }); },
    drillCategory(name: string) { drill.set({ ...drill.get(), kind: kindsOf(name) }); },
    drillKind(kind: SpendLine) { drill.set({ ...drill.get(), kind: [kind] }); },
  } as unknown as SpendLedger;
}

export default function SpendA() {
  const copy = () => spendCopyFor(runtime.snapshot.settings.locale === "en" ? "en" : "zh");
  const locale = () => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");
  const none = signal(false);
  const section = signal<"overview" | "details">("overview");
  const capUsd = signal<number | null>(null);
  const refuse = signal(false);
  const saved = signal<string[]>([]);
  const closes = signal(0);

  const memory = new Map<string, string>();
  const api = {
    kind: "local" as const,
    spendSummary: async (query: { group_by?: string }) => (none() ? { totals: totals(), groups: [], categories: [] } : summary(query.group_by)),
    spendPage: async () => ({ items: [], next: null }),
  } as unknown as MessengerApi;
  const ledger = (() => {
    try {
      return new SpendLedger({
        api: () => api,
        revision: () => 0,
        timeZone: () => "UTC",
        storage: () => ({ getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value) }),
        now: () => () => NOW,
        copy,
      });
    } catch {
      return storyLedger(api, copy);
    }
  })();

  const num = (value: number | null) => (value == null ? copy().dash : formatTokens(value));
  const money = (ticks: number | null, estimated = false) => (ticks == null ? copy().dash : estimated ? `${formatUsd(ticks)} ${copy().estimated}` : formatUsd(ticks));

  const cap = (
    <SpendCap
      copy={copy()}
      capUsd={capUsd()}
      onSetCap={async (usd) => {
        saved.update((list) => [...list, String(usd)]);
        if (refuse()) return { status: 422 };
        capUsd.set(usd);
        return undefined;
      }}
    />
  );

  return (
    <View class="flex-1 bg-sidebar-bg">
      <SpendHeader
        copy={copy()}
        ledger={ledger}
        api={api}
        section={section()}
        switchSection={(next) => section.set(next)}
        onClose={narrowWindow() ? () => closes.update((n) => n + 1) : undefined}
        backLabel="Back"
      />
      <Scroll class="flex-1 min-h-0" contentClass="gap-4 px-6 pt-5 pb-7">
        <If
          when={ledger.summary && ledger.summary.totals.calls > 0}
          else={
            <>
              {cap}
              <Text testID="spend-no-figures" class="text-[13px] text-ink-muted">
                {ledger.summary ? copy().empty : copy().loading}
              </Text>
            </>
          }
        >
          <Summary copy={copy()} locale={locale()} totals={ledger.summary!.totals} num={num} money={money} extra={cap} />
          <SpendCategories copy={copy()} locale={locale()} timeZone="UTC" ledger={ledger} categories={ledger.summary!.categories} num={num} />
        </If>

        <View class="flex-row flex-wrap items-center gap-6 p-4 border border-line rounded-(--radius-md)">
          <SpendAmount testID="amount-reported" copy={copy()} reported={4.51 * USD} estimated={null} />
          <SpendAmount testID="amount-estimated" copy={copy()} reported={null} estimated={0.25 * USD} />
          <SpendAmount testID="amount-both" copy={copy()} reported={4.51 * USD} estimated={0.25 * USD} />
          <SpendAmount testID="amount-none" copy={copy()} reported={null} estimated={null} missing={copy().estimateUnknown} />
          <SpendBotFace testID="face-bot" id={WRITER.id} bot={WRITER} />
          <SpendBotFace testID="face-gone" id="bot-gone" name="Retired" />
          <SpendBotFace testID="face-none" id={null} />
        </View>
      </Scroll>

      <View class="flex-row flex-wrap gap-2 px-6 py-2 border-t border-line items-center">
        <Button testID="story-none" size="sm" variant="secondary" onPress={() => none.set(!none())}>
          no figures
        </Button>
        <Button testID="story-refuse" size="sm" variant="secondary" onPress={() => refuse.set(!refuse())}>
          refuse cap
        </Button>
        <Button
          testID="story-bad-range"
          size="sm"
          variant="secondary"
          onPress={() => {
            ledger.setRange("custom");
            ledger.view.customFrom = "2026-10-09";
            ledger.view.customTo = "2026-10-01";
          }}
        >
          bad range
        </Button>
        <Button testID="story-details" size="sm" variant="secondary" onPress={() => section.set("details")}>
          details
        </Button>
        <Text testID="story-state" class="text-[10px] text-ink-muted">
          {JSON.stringify({ section: section(), cap: capUsd(), saved: saved(), closes: closes(), range: ledger.view.range, from: ledger.view.customFrom, to: ledger.view.customTo, metric: ledger.view.metric, drill: ledger.drill })}
        </Text>
      </View>
    </View>
  );
}
