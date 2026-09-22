import { expect, test } from "bun:test";
import type { RouteLogRow } from "./route-log.ts";
import {
  blamedRowCount,
  emptyRouteLogFilter,
  facetTriggerLabel,
  feedbackRowCount,
  filterRouteLogRows,
  routeLogFacets,
  routeLogFilterActive,
  toggleFilterValue,
  type RouteLogFilter,
} from "./route-log-filter.ts";

function row(over: Partial<RouteLogRow> = {}): RouteLogRow {
  return {
    turnId: "t1",
    botId: "b1",
    botName: "Writer",
    botKnown: true,
    triggerMessageId: "m1",
    model: "gpt-5",
    providerName: "OpenRouter",
    thinkingLevel: "medium",
    thinkingLabel: "中",
    signature: "coding",
    signatureLabel: "写代码",
    outcome: "completed",
    outcomeLabel: "完成",
    failReason: null,
    toolErrors: null,
    hops: null,
    feedback: [],
    reason: "要多步推理",
    learning: null,
    review: null,
    createdAt: "2026-09-18T01:00:00.000Z",
    finishedAt: "2026-09-18T01:00:12.000Z",
    durationMs: 12000,
    ...over,
  };
}

const writer = row();
const reviewer = row({
  turnId: "t2",
  botId: "b2",
  botName: "Reviewer",
  model: "grok-4.6",
  providerName: "Default",
  thinkingLevel: "high",
  thinkingLabel: "高",
  signature: "reasoning",
  signatureLabel: "推理",
  outcome: "failed",
  outcomeLabel: "补全失败",
  failReason: "连不上端点",
  reason: "短问题，挑了快的",
  feedback: [{ message_id: "m9", body: "太慢了，换个模型", created_at: "2026-09-18T01:05:00.000Z" }],
  review: {
    faultLabel: "模型的问题",
    directionLabel: "该更强",
    rounds: 3,
    reason: "反复改不对",
    blamedModel: true,
    effect: "followed",
    cleaner: false,
    retired: true,
  },
});
const live = row({
  turnId: "t3",
  botId: "b1",
  model: "gpt-5",
  outcome: "live",
  outcomeLabel: "进行中",
  finishedAt: null,
  durationMs: null,
  reason: null,
  providerName: null,
});

const ROWS = [reviewer, writer, live];

function filter(over: Partial<RouteLogFilter> = {}): RouteLogFilter {
  return { ...emptyRouteLogFilter(), ...over };
}

test("an empty filter leaves the list alone and is not active", () => {
  expect(routeLogFilterActive(emptyRouteLogFilter())).toBe(false);
  expect(filterRouteLogRows(ROWS, emptyRouteLogFilter()).map((r) => r.turnId)).toEqual([
    "t2",
    "t1",
    "t3",
  ]);
});

test("whitespace in the search box is not a filter", () => {
  expect(routeLogFilterActive(filter({ query: "  \n " }))).toBe(false);
});

test("search is case-insensitive and looks through names, reasons, reviews and notes", () => {
  expect(filterRouteLogRows(ROWS, filter({ query: "REVIEWER" })).map((r) => r.turnId)).toEqual([
    "t2",
  ]);
  expect(filterRouteLogRows(ROWS, filter({ query: "多步" })).map((r) => r.turnId)).toEqual(["t1"]);
  expect(filterRouteLogRows(ROWS, filter({ query: "太慢了" })).map((r) => r.turnId)).toEqual(["t2"]);
  expect(filterRouteLogRows(ROWS, filter({ query: "该更强" })).map((r) => r.turnId)).toEqual(["t2"]);
  expect(filterRouteLogRows(ROWS, filter({ query: "连不上" })).map((r) => r.turnId)).toEqual(["t2"]);
});

test("outcome picks are OR inside the facet, AND with every other facet", () => {
  const failedOrLive = filterRouteLogRows(
    ROWS,
    filter({ outcomes: ["failed", "live"] }),
  ).map((r) => r.turnId);
  expect(failedOrLive).toEqual(["t2", "t3"]);

  const failedWriter = filterRouteLogRows(
    ROWS,
    filter({ outcomes: ["failed"], botIds: ["b1"] }),
  );
  expect(failedWriter).toEqual([]);
});

test("bot, model and kind each constrain the list", () => {
  expect(filterRouteLogRows(ROWS, filter({ botIds: ["b2"] })).map((r) => r.turnId)).toEqual(["t2"]);
  expect(filterRouteLogRows(ROWS, filter({ models: ["gpt-5"] })).map((r) => r.turnId)).toEqual([
    "t1",
    "t3",
  ]);
  expect(filterRouteLogRows(ROWS, filter({ signatures: ["reasoning"] })).map((r) => r.turnId)).toEqual(
    ["t2"],
  );
});

test("an endpoint pick drops rows that never recorded one", () => {
  expect(filterRouteLogRows(ROWS, filter({ providers: ["OpenRouter"] })).map((r) => r.turnId)).toEqual(
    ["t1"],
  );
});

test("the feedback and blamed-model flags keep only those rows", () => {
  expect(filterRouteLogRows(ROWS, filter({ hasFeedback: true })).map((r) => r.turnId)).toEqual([
    "t2",
  ]);
  expect(filterRouteLogRows(ROWS, filter({ blamedModel: true })).map((r) => r.turnId)).toEqual([
    "t2",
  ]);
  const spared = row({
    turnId: "t4",
    review: {
      faultLabel: "需求没说清",
      directionLabel: null,
      rounds: 1,
      reason: "点名写错了",
      blamedModel: false,
      effect: null,
      cleaner: false,
      retired: false,
    },
  });
  expect(filterRouteLogRows([spared], filter({ blamedModel: true }))).toEqual([]);
  expect(filterRouteLogRows(ROWS, filter({ retired: true })).map((r) => r.turnId)).toEqual(["t2"]);
});

test("facet counts come from the whole session, in a stable order", () => {
  const facets = routeLogFacets(ROWS);
  expect(facets.outcomes.map((o) => [o.value, o.count])).toEqual([
    ["live", 1],
    ["completed", 1],
    ["failed", 1],
  ]);
  expect(facets.bots.map((o) => [o.label, o.count])).toEqual([
    ["Reviewer", 1],
    ["Writer", 2],
  ]);
  expect(facets.models.map((o) => o.value)).toEqual(["gpt-5", "grok-4.6"]);
  expect(facets.signatures.map((o) => o.value)).toEqual(["coding", "reasoning"]);
  expect(facets.providers.map((o) => o.value)).toEqual(["Default", "OpenRouter"]);
  expect(feedbackRowCount(ROWS)).toBe(1);
  expect(blamedRowCount(ROWS)).toBe(1);
});

test("an unknown message kind still appears, after the named ones", () => {
  const facets = routeLogFacets([row({ signature: "poetry", signatureLabel: "poetry" })]);
  expect(facets.signatures.map((o) => o.value)).toEqual(["poetry"]);
});

test("toggling a value on and off is how a facet chip works", () => {
  expect(toggleFilterValue(["failed"], "live")).toEqual(["failed", "live"]);
  expect(toggleFilterValue(["failed", "live"], "failed")).toEqual(["live"]);
});

test("the facet trigger names one pick and counts several", () => {
  const options = [
    { value: "failed", label: "补全失败", count: 1 },
    { value: "live", label: "进行中", count: 2 },
  ];
  expect(facetTriggerLabel([], options, "结果")).toBe("结果");
  expect(facetTriggerLabel(["failed"], options, "结果")).toBe("结果: 补全失败");
  expect(facetTriggerLabel(["failed", "live"], options, "结果")).toBe("结果 · 2");
});
