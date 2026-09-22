import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { buttonByText, click, fill, press, render } from "../test-render.ts";
import RouteLog from "./RouteLog.svelte";
import type { RouteLogRow } from "./route-log.ts";

const t = copyFor("zh");

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
    toolErrors: 1,
    hops: 3,
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
  triggerMessageId: "m2",
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

function open(rows: RouteLogRow[], extra: { showEndpoint?: boolean; loading?: boolean } = {}) {
  const jumped: string[] = [];
  let closed = 0;
  const view = render(RouteLog, {
    rows,
    sessionTitle: "视频组",
    loading: extra.loading ?? false,
    showEndpoint: extra.showEndpoint ?? true,
    t,
    onClose: () => (closed += 1),
    onJump: (id: string) => jumped.push(id),
  });
  return { ...view, jumped, closed: () => closed };
}

function rowBots(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".route-bot")].map((el) => el.textContent?.trim() ?? "");
}

function facetTriggers(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".route-facet-btn")].map((el) => el.textContent?.replace(/\s+/g, " ").trim() ?? "");
}

test("an empty log has no filter bar and says so", () => {
  const { host, close } = open([]);
  expect(host.querySelector(".route-filter-bar")).toBeNull();
  expect(host.textContent).toContain("还没有模型选择记录。");
  close();
});

test("the subtitle counts the session, and the filter bar is there once there are rows", () => {
  const { host, close } = open([writer, reviewer]);
  expect(host.textContent).toContain("视频组 · 2 轮");
  expect(host.querySelector(".route-filter-bar")).not.toBeNull();
  expect(host.querySelectorAll(".route-row")).toHaveLength(2);
  close();
});

test("search keeps only the rows that mention the query", () => {
  const { host, close } = open([writer, reviewer]);
  fill(host.querySelector(".route-search-input"), "Reviewer");
  expect(host.textContent).toContain("视频组 · 1 / 2 轮");
  expect(rowBots(host)).toEqual(["Reviewer"]);
  close();
});

test("the retired toggle keeps the review that left the picker, and the row shows its work", () => {
  const { host, close } = open([writer, reviewer]);
  expect(host.textContent).toContain("3 跳 · 1 次工具错误");
  click(host.querySelector(".route-toggle-chip.is-retired"));
  expect(rowBots(host)).toEqual(["Reviewer"]);
  expect(host.textContent).toContain("已退出：照做两次仍无改善");
  close();
});

test("the feedback toggle keeps only turns that have a model note", () => {
  const { host, close } = open([writer, reviewer]);
  click(host.querySelector(".route-toggle-chip.is-feedback"));
  expect(rowBots(host)).toEqual(["Reviewer"]);
  close();
});

test("a filter that matches nothing has its own empty state, and clearing brings the list back", () => {
  const { host, close } = open([writer, reviewer]);
  fill(host.querySelector(".route-search-input"), "没有这种轮次");
  expect(host.textContent).toContain("没有匹配的记录");
  expect(host.querySelectorAll(".route-row")).toHaveLength(0);
  click(buttonByText(host, "清空筛选"));
  expect(host.querySelectorAll(".route-row")).toHaveLength(2);
  expect(host.textContent).toContain("视频组 · 2 轮");
  close();
});

test("picking an outcome from the facet keeps only those turns", () => {
  const { host, close } = open([writer, reviewer]);
  click(host.querySelector(".route-facet-btn"));
  const failed = [...host.querySelectorAll(".route-facet-item")].find((el) =>
    el.textContent?.includes("补全失败"),
  );
  click(failed);
  expect(rowBots(host)).toEqual(["Reviewer"]);
  expect(host.querySelector(".route-facet-btn")?.textContent).toContain("结果: 补全失败");
  expect((host.querySelector(".route-facet") as HTMLDetailsElement).open).toBe(true);
  close();
});

test("Escape on an open facet closes the menu and leaves the overlay", () => {
  const { host, close, closed } = open([writer, reviewer]);
  const facet = host.querySelector(".route-facet") as HTMLDetailsElement;
  click(facet.querySelector(".route-facet-btn"));
  expect(facet.open).toBe(true);
  press(facet, "Escape");
  expect(facet.open).toBe(false);
  expect(closed()).toBe(0);
  close();
});

test("clicking a row still jumps to the triggering message", () => {
  const { host, close, jumped } = open([writer]);
  click(host.querySelector(".route-row-main"));
  expect(jumped).toEqual(["m1"]);
  close();
});

test("the endpoint facet only appears when more than one named endpoint is in the log", () => {
  const oneName = open([writer, row({ turnId: "t9", providerName: "OpenRouter" })]);
  expect(facetTriggers(oneName.host).some((label) => label.includes("端点"))).toBe(false);
  oneName.close();

  const twoNames = open([writer, reviewer]);
  expect(facetTriggers(twoNames.host).some((label) => label.includes("端点"))).toBe(true);
  twoNames.close();
});
