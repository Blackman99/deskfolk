import { expect, test } from "bun:test";
import type { TaskTraceNode } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { buttonByText, click, render } from "../test-render.ts";
import type { RouteLogRow } from "./route-log.ts";
import TraceRouteDetail from "./TraceRouteDetail.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const node = { turn_id: "t1", session_id: "s1" } as unknown as TaskTraceNode;

function row(over: Partial<RouteLogRow> = {}): RouteLogRow {
  return {
    turnId: "t1", botId: "b1", botName: "Writer", botKnown: true, triggerMessageId: "m1", model: "grk", providerName: null,
    thinkingLevel: "low", thinkingLabel: "低", signature: "general", signatureLabel: "通用", outcome: "completed", outcomeLabel: "完成",
    failReason: null, toolErrors: null, hops: null, feedback: [], reason: null, reasonLabel: "你钉的", markedModel: false, review: null,
    learning: null, createdAt: "2026-10-03T08:00:00.000Z", finishedAt: null, durationMs: null, ...over,
  };
}

function open(route: RouteLogRow, onMarkModel?: (marked: boolean) => Promise<void>) {
  return render(TraceRouteDetail, { node, route, t, providers: [], onJump: () => {}, onClose: () => {}, ...(onMarkModel ? { onMarkModel } : {}) });
}

test("the card says why the turn ran on its model, and marks it as the model's problem or takes that back", async () => {
  const marks: boolean[] = [];
  const view = open(row(), async (marked) => { marks.push(marked); });
  expect([...view.host.querySelectorAll(".trace-route-chip")].map((chip) => chip.textContent?.trim())).toContain("你钉的");
  click(buttonByText(view.host, t.routes.markModel));
  await sleep(0);
  expect(marks).toEqual([true]);
  const button = buttonByText(view.host, t.routes.markedModel);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  click(button);
  await sleep(0);
  expect(marks).toEqual([true, false]);
  expect(buttonByText(view.host, t.routes.markModel)).toBeTruthy();
  view.close();
});

test("no mark button below level 8, and a mark that failed says so", async () => {
  const below = open(row({ markedModel: null }), async () => {});
  expect(below.host.querySelector(".trace-route-mark-button")).toBeNull();
  below.close();
  const failing = open(row(), async () => { throw new Error("offline"); });
  click(buttonByText(failing.host, t.routes.markModel));
  await sleep(0);
  expect(failing.host.querySelector(".trace-route-mark-failed")?.textContent).toBe(t.routes.markModelFailed);
  expect(buttonByText(failing.host, t.routes.markModel).getAttribute("aria-pressed")).toBe("false");
  failing.close();
});
