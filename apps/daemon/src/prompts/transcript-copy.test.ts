import { describe, expect, test } from "bun:test";
import { PLAN_NUDGE_NOTE_MAX } from "../store/check-backs";
import {
  PLAN_LEFT_REVIEW_MAX,
  planLeftNote,
  planNudgeNote,
  reportBackNote,
  STALLED_LEFT_ITEM_MAX,
  STALLED_LEFT_ITEMS,
  stalledPlanBody,
  type OpenTicketLine,
} from "./transcript-copy";

function awaiting(count: number, titleLength = 80): OpenTicketLine[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    title: `${i + 1}`.padEnd(titleLength, "稿"),
    status: "review",
    worker: "Writer",
  }));
}

describe("calling a Bot back to a plan with everything handed over", () => {
  test("says what to do first and lists the tickets awaiting review last, a few of them, with the rest counted", () => {
    const zh = planLeftNote("zh", { review: awaiting(8) });
    expect(zh).toStartWith("规划静下来一阵了：没有待做或进行中的任务，局面「进展」里却还记着没做完或卡住的。接下来：");
    expect(zh.indexOf("自己交的也不自己判")).toBeLessThan(zh.indexOf("待验收："));
    expect(zh).toContain(`06《6${"稿".repeat(79)}》（待验收，Writer）`);
    expect(zh).not.toContain("07《");
    expect(zh).toEndWith("；还有 2 个。");
    expect([...zh].length).toBeLessThanOrEqual(PLAN_NUDGE_NOTE_MAX);
    expect(PLAN_LEFT_REVIEW_MAX).toBe(6);

    const en = planLeftNote("en", { review: awaiting(8) });
    expect(en).toStartWith("The plan has been quiet for a while with nothing to do or in progress, yet Progress in your situation still lists work not done or held up.");
    expect(en.indexOf("nor your own")).toBeLessThan(en.indexOf("Awaiting review: "));
    expect(en).toContain(`06 "6${"稿".repeat(79)}" (awaiting review, Writer)`);
    expect(en).toEndWith("; 2 more.");
    expect([...en].length).toBeLessThanOrEqual(PLAN_NUDGE_NOTE_MAX);
  });

  test("with nothing awaiting review, the instruction stands alone", () => {
    expect(planLeftNote("zh", { review: [] })).toEndWith("哪样都做不了，就直说卡在哪、需要谁做什么。");
    expect(planLeftNote("en", { review: [] })).toEndWith("say plainly where it is stuck and what you need from whom.");
  });
});

describe("the line a plan that stopped leaves for you", () => {
  test("with tickets open, reads as before", () => {
    const open: OpenTicketLine[] = [
      { seq: 1, title: "初稿", status: "doing", worker: "Writer" },
      { seq: 2, title: "审稿", status: "todo", worker: null },
    ];
    expect(stalledPlanBody("zh", { open, left: [], called: "Writer" })).toBe(
      "这件事停下了，还有 2 个任务没收口：01《初稿》（进行中，Writer）；02《审稿》（待做，还没人接）。已经叫过Writer一次，之后没有新的交付。要继续就 @ 该接手的 Bot，或者在流程图里改任务状态。",
    );
    expect(stalledPlanBody("en", { open, left: [], called: "Writer" })).toBe(
      'This plan has stopped with 2 tickets still open: 01 "初稿" (in progress, Writer); 02 "审稿" (to do, nobody on it). Writer was called back once and nothing new was handed over since. To carry on, @ whoever should pick it up; or mark the tickets on the flow board.',
    );
  });

  test("with everything handed over, quotes a few of the plan's items not done, each clipped, and counts the rest", () => {
    const left = ["定稿仍只是一份草稿", `配图${"很".repeat(100)}长`, "  整体\n 验收未开 ", "第四条", "第五条"];
    const zh = stalledPlanBody("zh", { open: [], left, called: "Lead" });
    expect(zh).toBe(
      `这件事停下了：没有待做或进行中的任务，进展里还记着没做完或卡住的：定稿仍只是一份草稿；配图${"很".repeat(STALLED_LEFT_ITEM_MAX - 2)}…；整体 验收未开（还有 2 条）。已经叫过Lead一次，之后没有任务交出或收口。要继续就 @ 该接手的 Bot，或者在流程图里改要点和任务。`,
    );
    expect(STALLED_LEFT_ITEMS).toBe(3);
    const en = stalledPlanBody("en", { open: [], left: left.slice(0, 1), called: "Lead" });
    expect(en).toBe(
      "This plan has stopped: nothing is to do or in progress, yet its progress still lists work not done or held up: 定稿仍只是一份草稿. Lead was called back once and no ticket has been handed over or closed since. To carry on, @ whoever should pick it up; or edit the plan and its tickets on the flow board.",
    );
  });

  test("when the cap on call-backs stopped the next one, says how many went out since you last spoke", () => {
    const zh = stalledPlanBody("zh", { open: [], left: ["定稿还没做"], called: "Lead", capped: 5 });
    expect(zh).toContain("你上次在这件事里说话之后已经叫回 5 次，最近一次叫的是Lead，不再叫了。");
    expect(zh).not.toContain("已经叫过Lead一次");
    const en = stalledPlanBody("en", { open: [{ seq: 1, title: "初稿", status: "doing", worker: "Writer" }], left: [], called: "Writer", capped: 5 });
    expect(en).toContain("Bots have been called back 5 times since you last spoke in this plan, most recently Writer; there will be no more.");
  });
});

/**
 * ADR 0040 P1: reportBackNote, planNudgeNote and planLeftNote used to tell the Bot to carry on;
 * they were changed to state facts instead. This pins that down so a later edit cannot quietly
 * bring an instruction to carry on back into any of them.
 */
describe("wake notes never invite carrying on", () => {
  function assertNeutral(text: string, locale: "zh" | "en"): void {
    if (locale === "en") {
      expect(text.toLowerCase()).not.toContain("carry on");
    } else {
      for (const phrase of ["接着干", "接着推进", "接着做"]) expect(text).not.toContain(phrase);
    }
  }

  test("reportBackNote", () => {
    const spoke = { peer: "审片员", last: { mine: false, body: "剪完了" }, peerSpoke: true };
    const quiet = { peer: "审片员", last: null, peerSpoke: false };
    assertNeutral(reportBackNote("zh", spoke), "zh");
    assertNeutral(reportBackNote("zh", quiet), "zh");
    assertNeutral(reportBackNote("en", { ...spoke, peer: "Reviewer" }), "en");
    assertNeutral(reportBackNote("en", { ...quiet, peer: "Reviewer" }), "en");
  });

  test("planNudgeNote", () => {
    const open: OpenTicketLine[] = [{ seq: 1, title: "初稿", status: "doing", worker: "Writer" }];
    assertNeutral(planNudgeNote("zh", { open, mine: open[0]! }), "zh");
    assertNeutral(planNudgeNote("en", { open, mine: open[0]! }), "en");
  });

  test("planLeftNote", () => {
    assertNeutral(planLeftNote("zh", { review: awaiting(2) }), "zh");
    assertNeutral(planLeftNote("zh", { review: [] }), "zh");
    assertNeutral(planLeftNote("en", { review: awaiting(2) }), "en");
    assertNeutral(planLeftNote("en", { review: [] }), "en");
  });
});
