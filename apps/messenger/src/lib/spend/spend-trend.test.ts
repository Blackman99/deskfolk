import { expect, test } from "bun:test";
import type { SpendCategory, SpendGroup, SpendKind, SpendTotals } from "@real-bot/protocol";
import { SPEND_CATEGORY_OF } from "@real-bot/protocol";
import { flushSync } from "svelte";
import { press, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { spendCopyFor } from "./spend-copy.ts";
import { bucketSpendDays, SPEND_TREND_MAX_BARS, spendTrendMax } from "./spend-trend.ts";
import SpendTrend from "./SpendTrend.svelte";

const copy = spendCopyFor("zh");

function totals(partial: Partial<SpendTotals> = {}): SpendTotals {
  return {
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
  };
}

function category(kind: SpendKind, partial: Partial<SpendTotals> = {}): SpendGroup["categories"][number] {
  const row = totals(partial);
  return { ...row, category: SPEND_CATEGORY_OF[kind], kinds: [{ ...row, kind }] };
}

function day(id: string, partial: Partial<SpendGroup> = {}): SpendGroup {
  return {
    id,
    name: id,
    deleted: false,
    provider_id: null,
    provider_name: null,
    model: null,
    categories: [],
    ...totals(),
    ...partial,
  };
}

function dated(index: number): string {
  const date = new Date(Date.UTC(2025, 0, 1 + index));
  return date.toISOString().slice(0, 10);
}

test("a year of days becomes uniform calendar intervals and keeps nulls off the total", () => {
  const days = Array.from({ length: 365 }, (_, index) => {
    const tokens = index % 5 === 0 ? null : index;
    return day(dated(index), {
      calls: 1,
      total_tokens: tokens,
      reported_usd_ticks: index % 2 === 0 ? null : index * 1_000_000,
      estimated_usd_ticks: index === 0 ? 0 : null,
      categories: [category("turn", { calls: 1, total_tokens: tokens, reported_usd_ticks: index % 2 === 0 ? null : index * 1_000_000 })],
    });
  });
  const buckets = bucketSpendDays(days);
  // ceil(365 / 28) is 14, so the year is 26 full intervals plus a 1-day remainder.
  expect(buckets).toHaveLength(27);
  expect(buckets.length).toBeLessThanOrEqual(SPEND_TREND_MAX_BARS);
  const lengths = buckets.map((bucket) => bucket.dayCount);
  expect(lengths.slice(0, -1).every((length) => length === 14)).toBe(true);
  expect(lengths[lengths.length - 1]).toBe(1);
  expect(lengths.reduce((total, length) => total + length, 0)).toBe(365);
  expect(buckets[0]?.from).toBe("2025-01-01");
  expect(buckets[0]?.to).toBe("2025-01-14");
  expect(buckets[buckets.length - 1]?.from).toBe(dated(364));
  expect(buckets[buckets.length - 1]?.to).toBe(dated(364));
  const known = days.reduce((total, row) => total + (row.total_tokens ?? 0), 0);
  const summed = buckets.reduce((total, row) => total + (row.total_tokens ?? 0), 0);
  expect(summed).toBe(known);
  expect(buckets[0]?.estimated_usd_ticks).toBe(0);
  // The next interval has calls, and none of them estimated a cost, so the field stays unknown.
  expect(buckets[1]?.estimated_usd_ticks).toBeNull();
  expect(buckets[0]?.categories.find((row) => row.category === "turn")?.total_tokens).toBe(
    days.slice(0, 14).reduce((total, row) => total + (row.total_tokens ?? 0), 0),
  );
  expect(buckets[0]?.categories.find((row) => row.category === "judgement")?.total_tokens).toBeNull();
});

test("thirty identical days stay flat, and a sparse half year does not drop the quiet days", () => {
  const flat = Array.from({ length: 30 }, (_, index) => day(dated(index), { calls: 1, total_tokens: 100 }));
  const even = bucketSpendDays(flat, 28);
  expect(even).toHaveLength(15);
  expect(even.slice(0, -1).every((bucket) => bucket.dayCount === 2 && bucket.total_tokens === 200)).toBe(true);
  expect(even[14]?.dayCount).toBe(2);
  expect(even[14]?.total_tokens).toBe(200);
  expect(even.every((bucket) => bucket.dayCount === even[0]?.dayCount)).toBe(true);
  expect(even.map((bucket) => bucket.total_tokens)).not.toEqual([200, 200, ...Array.from({ length: 26 }, () => 100)]);

  const sparse = bucketSpendDays(
    [
      day("2026-01-01", { calls: 1, total_tokens: 10 }),
      day("2026-06-30", { calls: 1, total_tokens: 20 }),
      day("2026-07-01", { calls: 1, total_tokens: 30 }),
    ],
    3,
  );
  expect(sparse).toHaveLength(3);
  expect(sparse.map((bucket) => bucket.dayCount)).toEqual([61, 61, 60]);
  expect(sparse.map((bucket) => [bucket.from, bucket.to])).toEqual([
    ["2026-01-01", "2026-03-02"],
    ["2026-03-03", "2026-05-02"],
    ["2026-05-03", "2026-07-01"],
  ]);
  // Jun 30 is day 180, inside the last 60-day interval, so the quiet middle stays zero.
  expect(sparse.map((bucket) => bucket.total_tokens)).toEqual([10, 0, 50]);
  expect(sparse.map((bucket) => bucket.calls)).toEqual([1, 0, 2]);
});

test("a selected range keeps its leading and trailing days, and an unknown call is not a missing day", () => {
  const rows = [day("2026-01-03", { calls: 1, total_tokens: null, reported_usd_ticks: null, estimated_usd_ticks: null })];
  const buckets = bucketSpendDays(rows, 28, { from: "2026-01-01T00:00:00.000Z", to: "2026-01-06T00:00:00.000Z" }, "UTC");
  expect(buckets.map((bucket) => bucket.from)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);
  expect(buckets.every((bucket) => bucket.dayCount === 1)).toBe(true);
  expect(buckets[0]?.calls).toBe(0);
  expect(buckets[0]?.total_tokens).toBe(0);
  expect(buckets[0]?.reported_usd_ticks).toBe(0);
  expect(buckets[2]?.calls).toBe(1);
  expect(buckets[2]?.total_tokens).toBeNull();
  expect(buckets[4]?.total_tokens).toBe(0);
  // .999 is still the exclusive end, not a new day.
  const closed = bucketSpendDays(rows, 28, { from: "2026-01-01T00:00:00.000Z", to: "2026-01-05T23:59:59.999Z" }, "UTC");
  expect(closed.map((bucket) => bucket.from)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);
});

test("the same calendar day in two years stays two days, including across the new year", () => {
  const buckets = bucketSpendDays(
    [day("2025-01-01", { calls: 1, total_tokens: 5 }), day("2026-01-01", { calls: 1, total_tokens: 7 })],
    28,
  );
  expect(buckets).toHaveLength(27);
  expect(buckets[0]?.from).toBe("2025-01-01");
  expect(buckets[0]?.total_tokens).toBe(5);
  expect(buckets[buckets.length - 1]?.to).toBe("2026-01-01");
  expect(buckets[buckets.length - 1]?.total_tokens).toBe(7);
  expect(buckets.reduce((total, bucket) => total + bucket.dayCount, 0)).toBe(366);
  const crossing = bucketSpendDays(
    [day("2025-12-31", { calls: 1, total_tokens: 1 }), day("2026-01-02", { calls: 1, total_tokens: 2 })],
    2,
  );
  expect(crossing.map((bucket) => [bucket.from, bucket.to, bucket.dayCount, bucket.total_tokens])).toEqual([
    ["2025-12-31", "2026-01-01", 2, 1],
    ["2026-01-02", "2026-01-02", 1, 2],
  ]);
  expect(crossing[1]?.calls).toBe(1);
});

test("unsorted days are ordered, an empty list stays empty, and a dense month is not grouped", () => {
  const loose = [day("2026-09-24", { total_tokens: 2 }), day("2026-09-01", { total_tokens: 8 }), day("not-a-day", { total_tokens: null })];
  const buckets = bucketSpendDays(loose, 2);
  expect(buckets[0]?.id).toBe("2026-09-01/2026-09-12");
  expect(buckets[0]?.dayCount).toBe(12);
  expect(buckets[0]?.total_tokens).toBe(8);
  expect(buckets[1]?.id).toBe("2026-09-13/2026-09-24");
  expect(buckets[1]?.total_tokens).toBe(2);
  expect(buckets[2]?.id).toBe("not-a-day");
  expect(buckets[2]?.total_tokens).toBeNull();
  expect(bucketSpendDays([])).toEqual([]);
  const month = Array.from({ length: 28 }, (_, index) => day(dated(index), { total_tokens: 1, calls: 1 }));
  const dense = bucketSpendDays(month);
  expect(dense).toHaveLength(28);
  expect(dense.every((bucket) => bucket.dayCount === 1)).toBe(true);
  expect(spendTrendMax(dense, "total_tokens")).toBe(1);
  expect(spendTrendMax([{ ...dense[0]!, total_tokens: null }], "total_tokens")).toBe(0);
});

test("reported and estimated of one range stay apart", () => {
  const rows = [
    day("2026-01-01", {
      calls: 2,
      reported_usd_ticks: 10,
      estimated_usd_ticks: null,
      categories: [category("turn", { calls: 1, reported_usd_ticks: 10 }), category("route_pick", { calls: 1, estimated_usd_ticks: null })],
    }),
    day("2026-01-02", {
      calls: 1,
      reported_usd_ticks: null,
      estimated_usd_ticks: 4,
      categories: [category("route_pick", { calls: 1, estimated_usd_ticks: 4 })],
    }),
  ];
  const [bucket] = bucketSpendDays(rows, 1);
  expect(bucket?.reported_usd_ticks).toBe(10);
  expect(bucket?.estimated_usd_ticks).toBe(4);
  expect(bucket?.categories.find((row) => row.category === "decision")?.estimated_usd_ticks).toBe(4);
  expect(bucket?.categories.find((row) => row.category === "decision")?.reported_usd_ticks).toBeNull();
  const categories: SpendCategory[] = bucket?.categories.map((row) => row.category) ?? [];
  expect(categories).toEqual(["turn", "judgement", "decision", "feedback", "other"]);
});

function mount(props: {
  days: SpendGroup[];
  metric?: "tokens" | "money";
  locale?: "zh" | "en";
  range?: { from?: string; to?: string };
  timeZone?: string;
}) {
  const state = reactive({
    days: props.days,
    metric: props.metric ?? "tokens",
    locale: props.locale ?? "zh",
    range: props.range,
    timeZone: props.timeZone,
  });
  const view = render(SpendTrend, state);
  return { ...view, state };
}

test("an empty trend says so and draws no bars", () => {
  const { host, close } = mount({ days: [] });
  try {
    expect(host.textContent).toContain(copy.empty);
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
  } finally {
    close();
  }
});

test("a year fits without a horizontal scrollbar and labels the first, middle, and last range", () => {
  const days = Array.from({ length: 365 }, (_, index) =>
    day(dated(index), {
      calls: 1,
      total_tokens: index === 10 ? 0 : (index + 1) * 10,
      categories: [category(index % 2 === 0 ? "turn" : "judgement", { calls: 1, total_tokens: index === 10 ? 0 : (index + 1) * 10 })],
    }),
  );
  const { host, close } = mount({ days, locale: "zh" });
  try {
    host.style.width = "320px";
    flushSync();
    const bars = host.querySelectorAll('[role="option"]');
    expect(bars).toHaveLength(27);
    expect(bars.length).toBeLessThanOrEqual(SPEND_TREND_MAX_BARS);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    const shown = [...host.querySelectorAll(".axis-label")].map((node) => node.textContent?.trim());
    expect(shown).toHaveLength(3);
    expect(shown[0]).toContain("至");
    expect(shown[1]).toContain("至");
    expect(shown[2]).not.toContain("至");
    expect(bars[0]?.getAttribute("tabindex")).toBe("0");
    expect(bars[1]?.getAttribute("tabindex")).toBe("-1");
    expect(bars[0]?.getAttribute("aria-label")).toContain(copy.category.turn);
  } finally {
    close();
  }
});

test("hover and arrow keys reveal the bucket, and a new scope clears it", () => {
  const days = [
    day("2026-09-01", {
      calls: 1,
      total_tokens: 1200,
      categories: [category("turn", { calls: 1, total_tokens: 1000 }), category("judgement", { calls: 1, total_tokens: null })],
    }),
    day("2026-09-02", {
      calls: 1,
      total_tokens: 0,
      categories: [category("turn", { calls: 1, total_tokens: 0 })],
    }),
    day("2026-09-03", {
      calls: 1,
      total_tokens: null,
      categories: [category("turn", { calls: 1, total_tokens: null })],
    }),
  ];
  const { host, state, close } = mount({ days, locale: "en" });
  try {
    const bars = () => [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(host.querySelector("[data-readout]")).toBeNull();
    bars()[1]?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    flushSync();
    const readout = host.querySelector("[data-readout]");
    expect(readout?.textContent).toContain("Sep 2");
    expect(readout?.textContent).toContain("0");
    expect(readout?.textContent).toContain(spendCopyFor("en").dash);
    expect(bars()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(bars()[1]?.getAttribute("tabindex")).toBe("0");
    press(bars()[1], "ArrowRight");
    expect(host.querySelector("[data-readout]")?.textContent).toContain("Sep 3");
    expect(document.activeElement).toBe(bars()[2]);
    expect(bars()[2]?.querySelector(".missing")).toBeTruthy();
    expect(bars()[1]?.querySelector(".zero")).toBeTruthy();
    state.days = [day("2026-10-01", { calls: 1, total_tokens: 5, categories: [category("turn", { calls: 1, total_tokens: 5 })] })];
    flushSync();
    expect(host.querySelector("[data-readout]")).toBeNull();
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
  } finally {
    close();
  }
});

test("money draws two labeled plots on one scale and never adds them", () => {
  const days = [
    day("2026-09-01", {
      calls: 2,
      reported_usd_ticks: 20_000_000_000,
      estimated_usd_ticks: 5_000_000_000,
      categories: [
        category("turn", { calls: 1, reported_usd_ticks: 20_000_000_000 }),
        category("route_pick", { calls: 1, estimated_usd_ticks: 5_000_000_000 }),
      ],
    }),
    day("2026-09-02", {
      calls: 1,
      reported_usd_ticks: null,
      estimated_usd_ticks: 0,
      categories: [category("turn", { calls: 1, reported_usd_ticks: null, estimated_usd_ticks: 0 })],
    }),
  ];
  const { host, close } = mount({ days, metric: "money", locale: "zh" });
  try {
    host.style.width = "280px";
    flushSync();
    const plots = host.querySelectorAll("[data-plot]");
    expect(plots).toHaveLength(2);
    expect(plots[0]?.getAttribute("aria-label")).toBe(copy.reportedStack);
    expect(plots[1]?.getAttribute("aria-label")).toBe(copy.estimatedStack);
    expect(host.textContent).not.toContain("$2.50");
    const reported = plots[0]?.querySelectorAll<HTMLElement>(".seg") ?? [];
    const estimated = plots[1]?.querySelectorAll<HTMLElement>(".seg") ?? [];
    const reportedHeight = Number.parseFloat(reported[0]?.style.height ?? "0");
    const estimatedHeight = Number.parseFloat(estimated[0]?.style.height ?? "0");
    expect(reportedHeight).toBeCloseTo(100, 5);
    expect(estimatedHeight).toBeCloseTo(25, 5);
    plots[1]?.querySelector<HTMLElement>('[role="option"]')?.click();
    flushSync();
    const readout = host.querySelector("[data-readout]");
    expect(readout?.getAttribute("data-readout")).toBe("estimated");
    expect(readout?.textContent).toContain(copy.estimated);
    expect(readout?.textContent).toContain("$0.50");
    expect(readout?.textContent).not.toContain("$2.00");
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
  } finally {
    close();
  }
});

test("a range that crosses a year names the year on the axis, the readout, and the bar", () => {
  const { host, close } = mount({
    days: [day("2025-12-31", { calls: 1, total_tokens: 4, categories: [category("turn", { calls: 1, total_tokens: 4 })] })],
    locale: "en",
    range: { from: "2025-12-31T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
    timeZone: "UTC",
  });
  try {
    const bars = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(bars).toHaveLength(2);
    expect(bars[0]?.getAttribute("aria-label")).toContain("2025");
    expect(bars[1]?.getAttribute("aria-label")).toContain("2026");
    const shown = [...host.querySelectorAll(".axis-label")].map((node) => node.textContent ?? "");
    expect(shown.some((label) => label.includes("2025"))).toBe(true);
    expect(shown.some((label) => label.includes("2026"))).toBe(true);
    bars[1]?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    flushSync();
    expect(host.querySelector("[data-readout]")?.textContent).toContain("2026");
  } finally {
    close();
  }
});


test("quiet days cannot turn unknown call usage into a reported zero", () => {
  const rows = [day("2026-01-03", { calls: 1, total_tokens: null })];
  const bucket = bucketSpendDays(rows, 1, { from: "2026-01-01T00:00:00.000Z", to: "2026-01-06T00:00:00.000Z" }, "UTC")[0]!;
  expect(bucket.calls).toBe(1);
  expect(bucket.total_tokens).toBeNull();
  expect(bucket.reported_usd_ticks).toBeNull();
  const inactive = bucketSpendDays([], 1, { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" }, "UTC")[0]!;
  expect(inactive.total_tokens).toBe(0);
  expect(inactive.categories.every((row) => row.total_tokens === 0)).toBe(true);
});

test("an exclusive bound inside a day retains that day's interval", () => {
  const buckets = bucketSpendDays([], 28, { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T12:00:00.000Z" }, "UTC");
  expect(buckets.map((row) => row.from)).toEqual(["2026-01-01", "2026-01-02"]);
});
