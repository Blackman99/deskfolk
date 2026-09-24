import { expect, test } from "bun:test";
import type { SpendDetail, SpendGroup, SpendKind, SpendSummary, SpendTotals } from "@real-bot/protocol";
import { SPEND_CATEGORY_OF } from "@real-bot/protocol";
import { flushSync } from "svelte";
import { click, fill, press, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { spendCopyFor } from "./spend-copy.ts";
import SpendView from "./SpendView.svelte";

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

function category(kind: SpendKind, partial: Partial<SpendTotals>): SpendSummary["categories"][number] {
  return { ...totals({ calls: 1, ...partial }), category: SPEND_CATEGORY_OF[kind], kinds: [{ ...totals({ calls: 1, ...partial }), kind }] };
}

function group(partial: Partial<SpendGroup> & Pick<SpendGroup, "id">): SpendGroup {
  return {
    name: partial.id,
    deleted: false,
    provider_id: null,
    provider_name: null,
    model: null,
    categories: [],
    ...totals({ calls: 1, total_tokens: 100 }),
    ...partial,
  };
}

const modelGroup = group({
  id: "model-1",
  name: "opus",
  provider_id: "prov-1",
  provider_name: "Anthropic",
  model: "opus",
  calls: 4,
  input_tokens: 1000,
  output_tokens: 250,
  total_tokens: 1250,
  reported_usd_ticks: 20_000_000_000,
  estimated_usd_ticks: 5_000_000_000,
});

const nullModel = group({
  id: null,
  name: null,
  model: null,
  calls: 1,
  total_tokens: null,
  reported_usd_ticks: null,
  estimated_usd_ticks: null,
  missing_calls: 1,
  missing_usage_calls: 1,
});

const deletedSession = group({ id: "sess-gone", name: "Old notes", deleted: true, total_tokens: 80 });
const deletedBot = group({ id: "bot-gone", name: "Retired", deleted: true, total_tokens: 40 });
const unassigned = group({ id: null, name: null, total_tokens: 10 });

function summaryFor(dimension: string, rows: SpendGroup[]): SpendSummary {
  const categories = [
    category("turn", { total_tokens: 1000, reported_usd_ticks: 20_000_000_000 }),
    category("judgement", { total_tokens: 100 }),
    category("route_pick", { total_tokens: 50, estimated_usd_ticks: 5_000_000_000 }),
    category("route_review", { total_tokens: 30 }),
    category("composer_suggest", { total_tokens: 20 }),
  ];
  // Feedback is two kinds under one category, so the row can expand.
  const feedback = categories.find((row) => row.category === "feedback")!;
  feedback.kinds = [
    { ...totals({ calls: 1, total_tokens: 20 }), kind: "route_review" },
    { ...totals({ calls: 1, total_tokens: 10 }), kind: "route_learn" },
  ];
  return {
    totals: totals({
      calls: 6,
      input_tokens: 1000,
      cached_tokens: null,
      output_tokens: 250,
      total_tokens: 1200,
      reported_usd_ticks: 20_000_000_000,
      estimated_usd_ticks: 5_000_000_000,
      reported_calls: 2,
      estimated_calls: 1,
      missing_calls: 1,
      missing_usage_calls: 1,
    }),
    groups: dimension === "day"
      ? [
          group({ id: "2026-09-23", total_tokens: 400, categories: categories as SpendGroup["categories"] }),
          group({ id: "2026-09-24", total_tokens: 800, reported_usd_ticks: 20_000_000_000, estimated_usd_ticks: 5_000_000_000, categories: categories as SpendGroup["categories"] }),
        ]
      : rows,
    categories,
  };
}

function detail(partial: Partial<SpendDetail> = {}): SpendDetail {
  return {
    id: "row-1",
    session_id: "sess-1",
    session_name: "Notes",
    bot_id: "bot-1",
    bot_name: "Writer",
    turn_id: "turn-1",
    judgement_id: null,
    kind: "turn",
    chain_id: null,
    provider_id: "prov-1",
    provider_name: "Anthropic",
    model: "opus",
    thinking_level: null,
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    cached_tokens: null,
    reasoning_tokens: null,
    cost_usd_ticks: 10_000_000_000,
    estimated_cost_usd_ticks: null,
    missing_reason: null,
    created_at: "2026-09-24T01:00:00.000Z",
    trigger_message_id: "msg-1",
    session_deleted: false,
    bot_deleted: false,
    ...partial,
  };
}

type Call = {
  path: string;
  query: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  settled: boolean;
};

function fakeApi() {
  const calls: Call[] = [];
  const api = {
    kind: "local" as const,
    spendSummary(query: { group_by?: string }) {
      return new Promise((resolve, reject) => {
        calls.push({ path: `summary:${query.group_by ?? ""}`, query, resolve, reject, settled: false });
      });
    },
    spendPage(query: { cursor?: string }) {
      return new Promise((resolve, reject) => {
        calls.push({ path: query.cursor ? `page:${query.cursor}` : "page", query, resolve, reject, settled: false });
      });
    },
  };
  return { api, calls };
}

function answer(calls: Call[], dimension = "model", rows = [modelGroup, nullModel], next: string | null = "cursor-2") {
  const pending = calls.filter((call) => !call.settled);
  for (const call of pending) call.settled = true;
  for (const call of pending) {
    if (call.path === `summary:${dimension}`) call.resolve(summaryFor(dimension, rows));
    else if (call.path === "summary:day") call.resolve(summaryFor("day", []));
    else if (call.path === "page") {
      call.resolve({
        items: [detail(), detail({ id: "row-2", kind: "route_pick", cost_usd_ticks: null, estimated_cost_usd_ticks: 2_000_000_000, trigger_message_id: null, model: null, bot_id: null, bot_name: null })],
        next,
      });
    }
  }
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
  if (!found) throw new Error(`no button ${text}`);
  return found as HTMLButtonElement;
}

/** The range control is a native select. `fill` only dispatches `input`, which this control ignores. */
function chooseRange(host: HTMLElement, range: string): void {
  const select = host.querySelector(`select[aria-label="${copy.period}"]`) as HTMLSelectElement;
  select.value = range;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
}

function openDetails(host: HTMLElement): void {
  click(host.querySelector('[role="tab"][aria-selected="false"]'));
}

function coverageOf(host: HTMLElement): HTMLDetailsElement {
  const found = host.querySelector("details.coverage");
  if (!found) throw new Error("no coverage disclosure");
  return found as HTMLDetailsElement;
}

const storage = () => {
  const memory = new Map<string, string>();
  return {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
  };
};

async function mount(dimension: SpendGroup[] = [modelGroup, nullModel]) {
  const { api, calls } = fakeApi();
  const opened: string[] = [];
  const view = render(SpendView, {
    api: api as never,
    locale: "zh",
    timeZone: "Asia/Shanghai",
    storage: storage(),
    revision: 0,
    onOpenSession: (id: string) => opened.push(`session:${id}`),
    onOpenTrigger: (sessionId: string, messageId: string) => opened.push(`trigger:${sessionId}:${messageId}`),
  });
  await new Promise((resolve) => setTimeout(resolve, 450));
  answer(calls, "model", dimension);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { ...view, calls, opened, api };
}

test("the view loads the last 7 days and keeps reported and estimated apart", async () => {
  const { host, calls, close } = await mount();
  try {
    const period = host.querySelector(`select[aria-label="${copy.period}"]`) as HTMLSelectElement;
    expect(period.value).toBe("last7");
    expect(period.selectedOptions[0]?.textContent).toBe(copy.ranges.last7);
    expect(host.textContent).toContain("$2.00");
    expect(host.textContent).toContain("$0.50");
    expect(host.textContent).toContain(copy.estimated);
    const coverage = coverageOf(host);
    expect(coverage.open).toBe(false);
    expect(coverage.querySelector("summary")?.textContent).toContain(copy.coverage);
    expect(coverage.querySelector(".coverage-summary")?.textContent).toContain(copy.missingUsage(1));
    coverage.open = true;
    flushSync();
    expect(coverage.textContent).toContain(copy.estimatedHint);
    expect(coverage.textContent).toContain(copy.missingUsage(1));
    expect(host.textContent).toContain(copy.dash);
    expect(host.textContent).toContain(copy.unrecordedModel);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(copy.overview);
    expect(host.querySelector(".detail-table")).toBeNull();
    expect(calls.some((call) => call.path === "summary:model")).toBe(true);
    expect(calls.some((call) => call.path === "summary:day")).toBe(true);
  } finally {
    close();
  }
});

test("a failed load offers a retry, and an empty range says so", async () => {
  const failed = fakeApi();
  const first = render(SpendView, { api: failed.api as never, locale: "zh", timeZone: "UTC", storage: storage() });
  await new Promise((resolve) => setTimeout(resolve, 450));
  for (const call of failed.calls) {
    call.settled = true;
    call.reject(new Error("down"));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(first.host.textContent).toContain(copy.error);
  const retry = [...first.host.querySelectorAll("button")].find((button) => button.textContent === copy.retry);
  expect(retry).toBeTruthy();
  click(retry);
  await new Promise((resolve) => setTimeout(resolve, 450));
  answer(failed.calls);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(first.host.textContent).toContain("$2.00");
  expect(first.host.textContent).not.toContain(copy.error);
  first.close();

  const again = fakeApi();
  const empty = render(SpendView, { api: again.api as never, locale: "zh", timeZone: "UTC", storage: storage() });
  await new Promise((resolve) => setTimeout(resolve, 450));
  const emptySummary = { totals: totals(), groups: [], categories: [] };
  for (const call of again.calls) {
    call.settled = true;
    if (call.path.startsWith("summary")) call.resolve(emptySummary);
    else call.resolve({ items: [], next: null });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(empty.host.textContent).toContain(copy.empty);
  empty.close();
});

test("sorting, a category expand, and a two-deep drill each narrow the next request", async () => {
  const { host, calls, close } = await mount();
  try {
    const before = calls.length;
    click([...host.querySelectorAll("th .sort")].find((button) => button.textContent?.startsWith(copy.calls)));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(calls.length).toBe(before);

    const expand = host.querySelector(`button[aria-label="${copy.expand}"]`) as HTMLButtonElement;
    expect(expand.textContent?.trim()).toBe("");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    click(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain(copy.kind.route_review);
    expect(host.textContent).toContain(copy.kind.route_learn);
    click(button(host, copy.kind.route_learn));
    await new Promise((resolve) => setTimeout(resolve, 450));
    const narrowed = calls.filter((call) => !call.settled);
    expect(narrowed.some((call) => Array.isArray(call.query.kind) && (call.query.kind as string[]).join() === "route_learn")).toBe(true);
    answer(calls);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).toContain(copy.kind.route_review);
    expect(host.textContent).toContain(copy.kind.route_learn);

    click(button(host, "Anthropic · opus"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    answer(calls);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).toContain(copy.unrecordedModel === "未记录模型" ? "opus" : "opus");

    click(button(host, copy.dimensions.bot));
    await new Promise((resolve) => setTimeout(resolve, 450));
    answer(calls, "bot", [deletedBot, unassigned]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).toContain(copy.deleted);
    expect(host.textContent).toContain(copy.unassignedBot);
    click(button(host, "Retired"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    const stacked = calls.filter((call) => !call.settled);
    expect(stacked.some((call) => call.query.bot_id === "bot-gone" && call.query.model === "opus")).toBe(true);
  } finally {
    close();
  }
});

test("clearing one chip leaves the other, and a deleted session has no way in", async () => {
  const { host, calls, opened, close } = await mount([deletedSession]);
  try {
    click([...host.querySelectorAll("button")].find((button) => button.textContent === copy.dimensions.session));
    await new Promise((resolve) => setTimeout(resolve, 450));
    answer(calls, "session", [deletedSession]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).toContain(copy.deleted);
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === copy.openSession)).toBe(false);
    click([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Old notes")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const chip = [...host.querySelectorAll(".chip")][0];
    expect(chip?.textContent).toContain("Old notes");
    click(chip);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.querySelector(".chip")).toBeNull();
    expect(opened).toEqual([]);
  } finally {
    close();
  }
});

test("a detail row opens its trigger, and more pages append", async () => {
  const { host, calls, opened, close } = await mount();
  try {
    expect(host.querySelector(".detail-table")).toBeNull();
    expect(host.querySelector('time[datetime]')).toBeNull();
    openDetails(host);
    const stamp = host.querySelector('time[datetime="2026-09-24T01:00:00.000Z"]');
    expect(stamp?.textContent).not.toContain("2026-09-24T01:00:00.000Z");
    expect(stamp?.textContent).toMatch(/\d/);
    const row = stamp?.closest("tr");
    expect(row?.querySelector("button")?.textContent).toContain(copy.openTrigger);
    click(row?.querySelector("button"));
    expect(opened).toEqual(["trigger:sess-1:msg-1"]);
    const before = host.querySelectorAll(".detail-table tbody tr").length;
    click([...host.querySelectorAll("button")].find((button) => button.textContent === copy.loadMore));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const more = calls.find((call) => call.path === "page:cursor-2");
    more?.resolve({ items: [detail({ id: "row-3", created_at: "2026-09-23T01:00:00.000Z" })], next: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.querySelectorAll(".detail-table tbody tr").length).toBeGreaterThan(before);
    expect(host.querySelector('time[datetime="2026-09-23T01:00:00.000Z"]')).not.toBeNull();
    expect(host.textContent).not.toContain(copy.loadMore);
  } finally {
    close();
  }
});

test("a spend revision reloads, and a custom range is what gets asked for", async () => {
  const props = reactive({ revision: 0 });
  const { api, calls } = fakeApi();
  const { host, close } = render(SpendView, {
    api: api as never,
    locale: "zh",
    timeZone: "UTC",
    storage: storage(),
    get revision() {
      return props.revision;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 450));
  answer(calls);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const first = calls.length;
  flushSync(() => {
    props.revision = 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(calls.length).toBeGreaterThan(first);

  chooseRange(host, "custom");
  const from = host.querySelectorAll('input[type="date"]')[0];
  const to = host.querySelectorAll('input[type="date"]')[1];
  fill(from, "2026-09-01");
  fill(to, "2026-09-03");
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(calls.length).toBeGreaterThan(first + 3);
  close();
});

test("a bot chip keeps its name after the dimension switches to model", async () => {
  const { host, calls, close } = await mount();
  try {
    click(button(host, copy.dimensions.bot));
    await new Promise((resolve) => setTimeout(resolve, 450));
    answer(calls, "bot", [deletedBot, unassigned]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    click(button(host, "Retired"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.querySelector(".chip")?.textContent).toContain("Retired");
    click(button(host, copy.dimensions.model));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const chip = host.querySelector(".chip");
    expect(chip?.textContent).toContain("Retired");
    expect(chip?.textContent).not.toContain("bot-gone");
    await new Promise((resolve) => setTimeout(resolve, 450));
    answer(calls, "model", [modelGroup]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    click(button(host, "Anthropic · opus"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const labels = [...host.querySelectorAll(".chip")].map((node) => node.textContent ?? "");
    expect(labels.some((label) => label.includes("Retired"))).toBe(true);
    expect(labels.some((label) => label.includes("Anthropic · opus"))).toBe(true);
    expect(labels.some((label) => label.includes("bot-gone") || label.includes("model-1"))).toBe(false);
  } finally {
    close();
  }
});

test("a filter change drops the request already in flight, and a late page cannot append", async () => {
  const { host, calls, close } = await mount();
  try {
    const stale = calls.filter((call) => call.path.startsWith("summary") || call.path === "page");
    click(button(host, copy.dimensions.bot));
    expect(host.textContent).toContain("Anthropic · opus");
    expect([...host.querySelectorAll("tbody button.group-name")].some((button) => !button.hasAttribute("disabled") && button.textContent?.includes("Anthropic · opus"))).toBe(false);
    chooseRange(host, "today");
    expect(stale.every((call) => {
      call.settled = true;
      return true;
    })).toBe(true);
    for (const call of stale) {
      if (call.path.startsWith("summary")) call.resolve(summaryFor(call.path.slice("summary:".length), [group({ id: "stale", name: "Stale row", total_tokens: 1 })]));
      else call.resolve({ items: [detail({ id: "stale-row", session_name: "Stale detail" })], next: "stale-cursor" });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).not.toContain("Stale row");
    expect(host.textContent).not.toContain("Stale detail");
    await new Promise((resolve) => setTimeout(resolve, 450));
    const fresh = calls.filter((call) => !call.settled);
    for (const call of fresh) {
      call.settled = true;
      if (call.path.startsWith("summary")) call.resolve(summaryFor(call.path.slice("summary:".length), [deletedBot]));
      else call.resolve({ items: [detail({ id: "bot-row", session_name: "Retired detail" })], next: "cursor-2" });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).toContain("Retired");
    expect([...host.querySelectorAll("tbody button")].some((button) => button.textContent?.includes("Retired"))).toBe(true);

    openDetails(host);
    const more = [...host.querySelectorAll("button")].find((button) => button.textContent === copy.loadMore);
    click(more);
    const page = calls.find((call) => call.path === "page:cursor-2" && !call.settled);
    chooseRange(host, "last7");
    page!.settled = true;
    page!.resolve({ items: [detail({ id: "late-page", session_name: "Late page" })], next: "later" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).not.toContain("Late page");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === copy.loadMore && button.textContent?.includes("later"))).toBe(false);
  } finally {
    close();
  }
});

test("closing the view ignores a reload that comes back afterwards", async () => {
  const { api, calls } = fakeApi();
  const view = render(SpendView, { api: api as never, locale: "zh", timeZone: "UTC", storage: storage() });
  await new Promise((resolve) => setTimeout(resolve, 450));
  const pending = calls.filter((call) => !call.settled);
  view.close();
  for (const call of pending) {
    call.settled = true;
    if (call.path.startsWith("summary")) call.resolve(summaryFor("model", [group({ id: "after", name: "After close" })]));
    else call.resolve({ items: [detail({ id: "after", session_name: "After close" })], next: null });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(view.host.isConnected).toBe(false);
});

test("an estimate shows its explanation and coverage, and a missing one says why", async () => {
  const { host, close } = await mount();
  try {
    const coverage = coverageOf(host);
    expect(coverage.open).toBe(false);
    expect(coverage.querySelector("summary")?.textContent).toContain(copy.coverage);
    expect(coverage.open).toBe(false);
    coverage.open = true;
    flushSync();
    expect(coverage.textContent).toContain(copy.estimatedHint);
    expect(coverage.textContent).toContain(copy.estimateCoverage(2, 1));
    const estimated = [...host.querySelectorAll(".money-summary strong")].find((node) => node.textContent?.includes("$0.50"));
    expect(estimated?.parentElement?.textContent).toContain(copy.estimated);
    expect(estimated?.parentElement?.textContent).toContain(copy.coveredCalls(1));
    const reported = [...host.querySelectorAll(".money-summary strong")].find((node) => node.textContent?.includes("$2.00"));
    expect(reported?.parentElement?.textContent).toContain(copy.reported);
    expect(reported?.parentElement?.textContent).toContain(copy.coveredCalls(2));

    const unconfigured = fakeApi();
    const bare = render(SpendView, { api: unconfigured.api as never, locale: "zh", timeZone: "UTC", storage: storage() });
    await new Promise((resolve) => setTimeout(resolve, 450));
    const priced = summaryFor("model", [modelGroup]);
    priced.totals = totals({ calls: 2, missing_calls: 2, missing_usage_calls: 0, estimated_usd_ticks: null, reported_usd_ticks: null });
    priced.categories = [];
    for (const call of unconfigured.calls) {
      call.settled = true;
      if (call.path.startsWith("summary")) call.resolve({ ...priced, groups: call.path === "summary:day" ? [] : [] });
      else call.resolve({ items: [detail({ id: "gap", cost_usd_ticks: null, estimated_cost_usd_ticks: null, input_tokens: 4, output_tokens: 1 })], next: null });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bare.host.textContent).toContain(copy.estimateUnknown);
    expect(bare.host.textContent).not.toContain(copy.estimateUnconfigured);
    openDetails(bare.host);
    const gap = [...bare.host.querySelectorAll(".detail-table td")].find((cell) => cell.textContent?.trim() === copy.dash && cell.title);
    expect(gap?.getAttribute("title")).toBe(copy.estimateUnconfigured);
    bare.close();

    const incomplete = fakeApi();
    const short = render(SpendView, { api: incomplete.api as never, locale: "zh", timeZone: "UTC", storage: storage() });
    await new Promise((resolve) => setTimeout(resolve, 450));
    const usage = summaryFor("model", []);
    usage.totals = totals({ calls: 1, missing_calls: 1, missing_usage_calls: 1 });
    usage.categories = [category("turn", { calls: 1, total_tokens: null, missing_calls: 1, missing_usage_calls: 1 })];
    usage.groups = [];
    for (const call of incomplete.calls) {
      call.settled = true;
      if (call.path.startsWith("summary")) call.resolve(usage);
      else call.resolve({ items: [detail({ id: "none", cost_usd_ticks: null, input_tokens: null, output_tokens: null, total_tokens: null })], next: null });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(short.host.textContent).toContain(copy.estimateUnknown);
    expect(short.host.textContent).not.toContain(copy.estimateIncompleteUsage);
    expect(short.host.querySelector(".coverage-summary")?.textContent).toContain(copy.missingUsage(1));
    short.close();
  } finally {
    close();
  }
});

test("the trend is its own component, and switching to money does not add the two amounts", async () => {
  const { host, close } = await mount();
  try {
    expect(host.querySelector("[data-spend-trend]")).not.toBeNull();
    expect(host.querySelector(".money")).toBeNull();
    expect(host.textContent).not.toContain("$2.50");
    click(button(host, copy.metricMoney));
    expect(host.querySelector("[data-spend-trend] .money")).not.toBeNull();
    expect(host.textContent).not.toContain("$2.50");
  } finally {
    close();
  }
});

test("a deleted detail row keeps its snapshot and does not open the session", async () => {
  const { api, calls } = fakeApi();
  const opened: string[] = [];
  const { host, close } = render(SpendView, {
    api: api as never,
    locale: "zh",
    timeZone: "UTC",
    storage: storage(),
    onOpenTrigger: (sessionId: string, messageId: string) => opened.push(`${sessionId}:${messageId}`),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 450));
    const pending = calls.filter((call) => !call.settled);
    for (const call of pending) call.settled = true;
    for (const call of pending) {
      if (call.path.startsWith("summary")) call.resolve(summaryFor("model", [modelGroup]));
      else {
        call.resolve({
          items: [detail({ session_deleted: true, session_name: "Gone notes", trigger_message_id: "msg-gone" })],
          next: null,
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    openDetails(host);
    expect(host.textContent).toContain("Gone notes");
    expect(host.textContent).toContain(copy.deleted);
    const stamp = host.querySelector('time[datetime="2026-09-24T01:00:00.000Z"]');
    expect(stamp?.textContent).not.toContain("2026-09-24T01:00:00.000Z");
    expect(stamp?.closest("tr")?.querySelector("button")).toBeNull();
    expect(opened).toEqual([]);
  } finally {
    close();
  }
});

test("changing the filter while more is loading drops that page and re-enables more for the new one", async () => {
  const { host, calls, close } = await mount();
  try {
    openDetails(host);
    const more = [...host.querySelectorAll("button")].find((button) => button.textContent === copy.loadMore);
    click(more);
    expect(more && (more as HTMLButtonElement).disabled).toBe(true);
    const late = calls.find((call) => call.path === "page:cursor-2" && !call.settled);
    chooseRange(host, "today");
    expect(host.textContent).not.toContain(copy.loadMore);
    late!.settled = true;
    late!.resolve({ items: [detail({ id: "late-more", session_name: "Late more" })], next: "still-more" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).not.toContain("Late more");
    await new Promise((resolve) => setTimeout(resolve, 450));
    answer(calls, "model", [modelGroup]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const again = [...host.querySelectorAll("button")].find((button) => button.textContent === copy.loadMore) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
  } finally {
    close();
  }
});

test("a blank or reversed custom range stays on the last result and does not ask again", async () => {
  const { host, calls, close } = await mount();
  try {
    chooseRange(host, "custom");
    await new Promise((resolve) => setTimeout(resolve, 450));
    const asked = calls.length;
    const from = host.querySelector('input[aria-label="从"]') as HTMLInputElement;
    const to = host.querySelector('input[aria-label="到"]') as HTMLInputElement;
    fill(from, "");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(copy.rangeBlank);
    expect(host.textContent).toContain("$2.00");
    expect(calls.length).toBe(asked);

    fill(from, "2026-09-20");
    fill(to, "2026-09-18");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(copy.rangeReversed);
    expect(calls.length).toBe(asked);
    expect(host.textContent).toContain("$2.00");

    fill(to, "2026-09-22");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(calls.length).toBeGreaterThan(asked);
    const latest = calls.filter((call) => !call.settled);
    expect(latest.every((call) => typeof call.query.from === "string" && typeof call.query.to === "string")).toBe(true);
  } finally {
    close();
  }
});

test("an impossible custom day is rejected instead of querying every row", async () => {
  const memory = new Map<string, string>([["deskfolk.spend.view", JSON.stringify({
    range: "custom",
    customFrom: "2026-02-31",
    customTo: "2026-03-02",
    dimension: "model",
    metric: "tokens",
    sort: "total",
    dir: "desc",
  })]]);
  const kept = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
  };
  const { api, calls } = fakeApi();
  const { host, close } = render(SpendView, { api: api as never, locale: "zh", timeZone: "UTC", storage: kept });
  try {
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(copy.rangeInvalid);
    expect(calls).toHaveLength(0);
    expect(host.textContent).not.toContain("$2.00");
  } finally {
    close();
  }
});

test("partial usage is not described as a missing rate, and a known gap still is", async () => {
  const partial = fakeApi();
  const view = render(SpendView, { api: partial.api as never, locale: "zh", timeZone: "UTC", storage: storage() });
  try {
    await new Promise((resolve) => setTimeout(resolve, 450));
    const priced = summaryFor("model", [modelGroup]);
    priced.totals = totals({
      calls: 2,
      input_tokens: 40,
      cached_tokens: 10,
      output_tokens: null,
      total_tokens: 40,
      missing_calls: 2,
      missing_usage_calls: 0,
      estimated_usd_ticks: null,
      reported_usd_ticks: null,
    });
    priced.categories = [category("turn", { calls: 2, input_tokens: 40, output_tokens: null, missing_calls: 2, missing_usage_calls: 0 })];
    priced.groups = [];
    for (const call of partial.calls) {
      call.settled = true;
      if (call.path.startsWith("summary")) call.resolve(priced);
      else {
        call.resolve({
          items: [detail({ id: "partial", cost_usd_ticks: null, estimated_cost_usd_ticks: null, input_tokens: 40, cached_tokens: 10, output_tokens: null })],
          next: null,
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.host.textContent).toContain(copy.estimateUnknown);
    expect(view.host.textContent).not.toContain(copy.estimateUnconfigured);
    expect(view.host.textContent).not.toContain(copy.estimateIncompleteUsage);
    openDetails(view.host);
    const cell = [...view.host.querySelectorAll(".detail-table td")].find((node) => node.getAttribute("title"));
    expect(cell?.getAttribute("title")).toBe(copy.estimateIncompleteUsage);
    expect(view.host.textContent).not.toMatch(/\$\d+\.\d+.*\$\d+\.\d+/);
  } finally {
    view.close();
  }
});

test("today rolls at the next local midnight instead of keeping the day it opened on", async () => {
  // 23:30 EDT on the fall-back day. The next local midnight is an hour of UTC later than usual.
  let clock = new Date("2026-11-01T03:30:00.000Z");
  const { api, calls } = fakeApi();
  const view = render(SpendView, {
    api: api as never,
    locale: "zh",
    timeZone: "America/New_York",
    storage: storage(),
    now: () => clock,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 450));
    const opened = calls.filter((call) => !call.settled);
    expect(opened[0]?.query.from).toBe("2026-10-25T04:00:00.000Z");
    expect(opened[0]?.query.to).toBe("2026-11-01T04:00:00.000Z");
    for (const call of opened) {
      call.settled = true;
      if (call.path.startsWith("summary")) call.resolve(summaryFor(call.path.slice("summary:".length), [modelGroup]));
      else call.resolve({ items: [detail()], next: null });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = calls.length;
    clock = new Date("2026-11-01T04:00:00.000Z");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.length).toBe(before);
    clock = new Date("2026-11-01T04:30:01.000Z");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const rolled = calls.filter((call) => !call.settled);
    expect(rolled.length).toBeGreaterThan(0);
    // 00:30 EDT, an hour before the clocks fall back. The window still ends at 04:00Z.
    expect(rolled[0]?.query.from).toBe("2026-10-26T04:00:00.000Z");
    expect(rolled[0]?.query.to).toBe("2026-11-02T05:00:00.000Z");
  } finally {
    view.close();
  }
});

test("a manual refresh drops a page that comes back afterwards", async () => {
  const { host, calls, close } = await mount();
  try {
    openDetails(host);
    const more = [...host.querySelectorAll("button")].find((button) => button.textContent === copy.loadMore);
    click(more);
    const late = calls.find((call) => call.path === "page:cursor-2" && !call.settled);
    const before = calls.length;
    click(host.querySelector(`button[aria-label="${copy.refresh}"]`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBeGreaterThan(before);
    expect(host.textContent).not.toContain(copy.loadMore);
    late!.settled = true;
    late!.resolve({ items: [detail({ id: "late-refresh", session_name: "Late refresh" })], next: "still" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).not.toContain("Late refresh");
    const fresh = calls.filter((call) => !call.settled);
    for (const call of fresh) {
      call.settled = true;
      if (call.path.startsWith("summary")) call.resolve(summaryFor("model", [modelGroup]));
      else call.resolve({ items: [detail({ id: "refreshed", session_name: "Refreshed detail" })], next: null });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).toContain("Refreshed detail");
    expect(host.textContent).not.toContain("Late refresh");
  } finally {
    close();
  }
});

test("typing an impossible custom day is ignored and does not ask again", async () => {
  const { host, calls, close } = await mount();
  try {
    chooseRange(host, "custom");
    await new Promise((resolve) => setTimeout(resolve, 450));
    answer(calls);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const asked = calls.length;
    const from = host.querySelector('input[aria-label="从"]') as HTMLInputElement;
    from.value = "2026-02-31";
    from.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect((host.querySelector('input[aria-label="从"]') as HTMLInputElement).value).toBe("");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(copy.rangeBlank);
    expect(calls.length).toBe(asked);
    expect(host.textContent).toContain("$2.00");
  } finally {
    close();
  }
});

test("switching tabs keeps the filters and the loaded page, and does not ask again", async () => {
  const { host, calls, close } = await mount();
  try {
    openDetails(host);
    click([...host.querySelectorAll("button")].find((button) => button.textContent === copy.loadMore));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const more = calls.find((call) => call.path === "page:cursor-2");
    more?.resolve({ items: [detail({ id: "row-3", session_name: "Kept page", created_at: "2026-09-23T01:00:00.000Z" })], next: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    click(button(host, copy.overview));
    click(button(host, copy.dimensions.bot));
    await new Promise((resolve) => setTimeout(resolve, 450));
    answer(calls, "bot", [deletedBot]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    click(button(host, "Retired"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    const drilled = calls.filter((call) => !call.settled);
    expect(drilled.some((call) => call.query.bot_id === "bot-gone")).toBe(true);
    for (const call of drilled) {
      call.settled = true;
      if (call.path.startsWith("summary")) call.resolve(summaryFor(call.path.slice("summary:".length), [deletedBot]));
      else call.resolve({ items: [detail({ id: "kept", session_name: "Kept page", bot_id: "bot-gone", bot_name: "Retired" })], next: "kept-cursor" });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const asked = calls.length;
    click(button(host, copy.details));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(calls.length).toBe(asked);
    expect(host.querySelector(".chip")?.textContent).toContain("Retired");
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(copy.details);
    expect(host.querySelector(".detail-table")?.textContent).toContain("Kept page");
    expect(host.querySelector(".dimension-table")).toBeNull();
    click(button(host, copy.overview));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(calls.length).toBe(asked);
    expect(host.querySelector(".chip")?.textContent).toContain("Retired");
    expect(host.querySelector(`.dimension-tabs [aria-pressed="true"]`)?.textContent).toBe(copy.dimensions.bot);
    expect(host.querySelector(".detail-table")).toBeNull();
  } finally {
    close();
  }
});

test("arrow keys move between the overview and the call details", async () => {
  const { host, close } = await mount();
  try {
    const overview = button(host, copy.overview);
    const details = button(host, copy.details);
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(overview.tabIndex).toBe(0);
    expect(details.getAttribute("aria-selected")).toBe("false");
    expect(details.tabIndex).toBe(-1);
    expect(overview.parentElement?.getAttribute("role")).toBe("tablist");
    press(overview, "ArrowRight");
    expect(details.getAttribute("aria-selected")).toBe("true");
    expect(details.tabIndex).toBe(0);
    expect(overview.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(details);
    expect(host.querySelector(".detail-table")).not.toBeNull();
    press(details, "ArrowLeft");
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(overview);
    expect(host.querySelector(".detail-table")).toBeNull();
    press(overview, "End");
    expect(details.getAttribute("aria-selected")).toBe("true");
    press(details, "Home");
    expect(overview.getAttribute("aria-selected")).toBe("true");
  } finally {
    close();
  }
});

test("replacing the client reloads, and no client clears what was on screen", async () => {
  const props = reactive({ api: null as ReturnType<typeof fakeApi>["api"] | null });
  const first = fakeApi();
  props.api = first.api;
  const view = render(SpendView, {
    get api() {
      return props.api as never;
    },
    locale: "zh",
    timeZone: "UTC",
    storage: storage(),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 450));
    answer(first.calls);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.host.textContent).toContain("$2.00");
    const before = first.calls.length;
    const replacement = fakeApi();
    flushSync(() => {
      props.api = replacement.api;
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(first.calls.length).toBe(before);
    expect(replacement.calls.length).toBeGreaterThan(0);
    answer(replacement.calls, "model", [group({ id: "next", name: "Next client", total_tokens: 3, reported_usd_ticks: 30_000_000_000 })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.host.textContent).toContain("Next client");
    expect(view.host.textContent).not.toContain("Anthropic · opus");

    flushSync(() => {
      props.api = null;
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(view.host.textContent).not.toContain("Next client");
    expect(view.host.textContent).not.toContain("$3.00");
    expect(view.host.textContent).toContain(copy.loading);
    expect((view.host.querySelector(`button[aria-label="${copy.refresh}"]`) as HTMLButtonElement).disabled).toBe(true);
  } finally {
    view.close();
  }
});

test("the first paint says it is loading, before anything has come back", () => {
  const { api } = fakeApi();
  const { host, close } = render(SpendView, { api: api as never, locale: "zh", timeZone: "UTC", storage: storage() });
  try {
    expect(host.textContent).toContain(copy.loading);
    expect(host.textContent).not.toContain(copy.empty);
  } finally {
    close();
  }
});
