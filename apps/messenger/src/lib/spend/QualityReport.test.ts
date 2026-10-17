import { expect, test } from "bun:test";
import type { QualityReportRow } from "@real-bot/protocol";
import { render } from "../test-render.ts";
import { spendCopyFor } from "./spend-copy.ts";
import QualityReport from "./QualityReport.svelte";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const row = (over: Partial<QualityReportRow>): QualityReportRow => ({ bot_id: "b1", bot_name: "视频导演", model: "grk", plan_kind: "视频", hand_overs: 4, approved: 1,
  review_rejected: 2, user_rejected: 1, checks_failed: 0, complaints: 1, failure_shapes: 0, review_misses: 0, cost_usd: 3.2, cost_per_approved: 3.2, ...over });

test("the report groups its Bot × model × plan kind rows by Bot, opens one to its lines, and stays away when there is nothing to report", async () => {
  const copy = spendCopyFor("zh").quality;
  const view = render(QualityReport, { api: { qualityReport: async () => [row({}), row({ bot_id: "b2", bot_name: null, model: "gemini", hand_overs: 0, approved: 0, review_rejected: 0, user_rejected: 0, complaints: 0 }), row({ bot_id: "b3", bot_name: null, model: "m", hand_overs: 0, approved: 0, review_rejected: 0, user_rejected: 0, complaints: 2 })] }, locale: "zh" });
  await sleep(0);
  // A row with nothing in it is left out; a complaint about an older hand-over is not. One entry per Bot.
  const bots = [...view.host.querySelectorAll("[data-quality-bot]")];
  expect(bots.map((bot) => bot.getAttribute("data-quality-bot"))).toEqual(["b1", "b3"]);
  const stats = (bot: Element) => [...bot.querySelectorAll(".bot-line .stat")].map((cell) => cell.textContent?.trim());
  expect(bots[0]!.querySelector(".who")?.textContent).toBe("视频导演");
  expect(stats(bots[0]!)).toEqual(["4", "3", "1", "$3.20"]);
  expect(bots[0]!.querySelector(".meter-rate")?.textContent).toBe("25%");
  expect(bots[1]!.querySelector(".who")?.textContent).toBe(copy.deleted);
  // Nothing approved: no cost per approval, and no rate on no hand-overs.
  expect(stats(bots[1]!)).toEqual(["0", "0", "2", copy.none]);
  expect(view.host.querySelector("tbody")).toBeNull();
  (bots[0]!.querySelector(".bot-toggle") as HTMLButtonElement).click();
  await sleep(0);
  const cells = [...bots[0]!.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim()));
  expect(cells).toEqual([["grk", "视频", "4", "1", "2 · 1 · 0", "1", "0", "0", "$3.20"]]);
  expect([...view.host.querySelectorAll(".quality-kpis dd")].map((dd) => dd.textContent?.trim())).toEqual(["4", "25%1 / 4", "3", "3", "$6.40"]);
  expect(view.host.querySelector("h2")?.textContent).toBe(copy.title);
  view.close();
  const empty = render(QualityReport, { api: { qualityReport: async () => [] }, locale: "zh" });
  await sleep(0);
  expect(empty.host.querySelector("[data-quality-report]")).toBeNull();
  empty.close();
  const older = render(QualityReport, { api: {}, locale: "zh" });
  await sleep(0);
  expect(older.host.querySelector("[data-quality-report]")).toBeNull();
  older.close();
});
