import { describe, expect, test } from "bun:test";
import { PLAN_NUDGE_NOTE_MAX } from "../store/check-backs";
import {
  agoOf,
  PLAN_LEFT_REVIEW_MAX,
  planLeftNote,
  spanOf,
  STALLED_LEFT_ITEM_MAX,
  STALLED_LEFT_ITEMS,
  stalledPlanBody,
  statusQuestionBody,
  type OpenTicketLine,
} from "./transcript-copy";

describe("statusQuestionBody", () => {
  test("zh: a plan with someone working, open tickets, recent files and a failing check", () => {
    const body = statusQuestionBody("zh", {
      plan: { title: "剪出预告片", status: "active" },
      working: [
        {
          bot: "视频导演",
          ticket: { seq: 2, title: "剪辑初稿" },
          minutes: 12,
          lastStep: "bun run render.ts --scene=2",
          elsewhere: null,
        },
      ],
      tickets: [
        { seq: 1, title: "分镜脚本", status: "done", worker: "分镜师" },
        { seq: 2, title: "剪辑初稿", status: "doing", worker: "视频导演" },
        { seq: 3, title: "配乐", status: "todo", worker: null },
      ],
      artifacts: [
        { path: "work/剪出预告片-7f3k/02-剪辑初稿/draft.mp4", author: "视频导演", minutesAgo: 12 },
        { path: "work/剪出预告片-7f3k/01-分镜脚本/storyboard.pdf", author: "分镜师", minutesAgo: 340 },
      ],
      checks: { passed: 1, total: 2, failing: [{ item: "成片能在本机播放", detail: "文件不在" }] },
      idleMinutes: null,
      nudgedBot: null,
    });
    expect(body).toBe(
      [
        "这件事：剪出预告片（进行中）",
        "正在做",
        "- 视频导演 · 任务 02《剪辑初稿》 · 已经 12 分钟 · 最近一步：bun run render.ts --scene=2",
        "任务",
        "- 01《分镜脚本》已完成（分镜师）",
        "- 02《剪辑初稿》进行中（视频导演）",
        "- 03《配乐》待做（还没人接）",
        "最近交出",
        "- work/剪出预告片-7f3k/02-剪辑初稿/draft.mp4 — 视频导演（12 分钟前）",
        "- work/剪出预告片-7f3k/01-分镜脚本/storyboard.pdf — 分镜师（6 小时前）",
        "验收检查",
        "1/2 通过",
        "「成片能在本机播放」：文件不在",
      ].join("\n"),
    );
  });

  test("en mirrors the zh structure", () => {
    const body = statusQuestionBody("en", {
      plan: { title: "Cut the trailer", status: "active" },
      working: [
        {
          bot: "Director",
          ticket: { seq: 2, title: "First cut" },
          minutes: 12,
          lastStep: "bun run render.ts --scene=2",
          elsewhere: null,
        },
      ],
      tickets: [
        { seq: 1, title: "Storyboard", status: "done", worker: "Storyboard artist" },
        { seq: 2, title: "First cut", status: "doing", worker: "Director" },
        { seq: 3, title: "Score", status: "todo", worker: null },
      ],
      artifacts: [{ path: "work/cut-the-trailer-7f3k/02-first-cut/draft.mp4", author: "Director", minutesAgo: 12 }],
      checks: { passed: 1, total: 2, failing: [{ item: "the cut plays locally", detail: "file is missing" }] },
      idleMinutes: null,
      nudgedBot: null,
    });
    expect(body).toBe(
      [
        "Plan: Cut the trailer (active)",
        "Working now",
        '- Director · ticket 02 "First cut" · 12 min in · last step: bun run render.ts --scene=2',
        "Tickets",
        '- 01 "Storyboard" done (Storyboard artist)',
        '- 02 "First cut" in progress (Director)',
        '- 03 "Score" to do (nobody on it)',
        "Recently delivered",
        "- work/cut-the-trailer-7f3k/02-first-cut/draft.mp4 — Director (12 min ago)",
        "Acceptance checks",
        "1/2 passing",
        '"the cut plays locally": file is missing',
      ].join("\n"),
    );
  });

  test("nobody working: says so, names when it last moved, and no ticket/check sections when the plan has none", () => {
    const body = statusQuestionBody("zh", {
      plan: { title: "写周报", status: "active" },
      working: [],
      tickets: [],
      artifacts: [],
      checks: { passed: 0, total: 0, failing: [] },
      idleMinutes: 45,
      nudgedBot: null,
    });
    expect(body).toBe(["这件事：写周报（进行中）", "现在没有人在做。", "最近一次动静：45 分钟前。"].join("\n"));
  });

  test("a live turn in another session names it, and a turn with no ticket omits the ticket segment", () => {
    const body = statusQuestionBody("zh", {
      plan: { title: "写周报", status: "active" },
      working: [{ bot: "文案", ticket: null, minutes: 3, lastStep: null, elsewhere: "群「视频组」" }],
      tickets: [],
      artifacts: [],
      checks: { passed: 0, total: 0, failing: [] },
      idleMinutes: null,
      nudgedBot: null,
    });
    expect(body).toBe(
      ["这件事：写周报（进行中）", "正在做", "- 文案 · 已经 3 分钟 · 最近一步：还在想 · 在「群「视频组」」"].join("\n"),
    );
  });

  test("a booked nudge is named at the end", () => {
    const body = statusQuestionBody("zh", {
      plan: { title: "写周报", status: "active" },
      working: [],
      tickets: [{ seq: 1, title: "初稿", status: "todo", worker: null }],
      artifacts: [],
      checks: { passed: 0, total: 0, failing: [] },
      idleMinutes: 90,
      nudgedBot: "文案",
    });
    expect(body).toBe(
      [
        "这件事：写周报（进行中）",
        "现在没有人在做。",
        "最近一次动静：2 小时前。",
        "任务",
        "- 01《初稿》待做（还没人接）",
        "已叫 文案 接着做。",
      ].join("\n"),
    );
  });

  test("done and parked plans label themselves", () => {
    expect(
      statusQuestionBody("zh", {
        plan: { title: "写周报", status: "done" },
        working: [],
        tickets: [],
        artifacts: [],
        checks: { passed: 0, total: 0, failing: [] },
        idleMinutes: null,
        nudgedBot: null,
      }),
    ).toContain("（已完成）");
    expect(
      statusQuestionBody("en", {
        plan: { title: "Weekly report", status: "parked" },
        working: [],
        tickets: [],
        artifacts: [],
        checks: { passed: 0, total: 0, failing: [] },
        idleMinutes: null,
        nudgedBot: null,
      }),
    ).toContain("(parked)");
  });
});

test("spans read as minutes, then hours, then days", () => {
  expect(spanOf(12, "zh")).toBe("12 分钟");
  expect(spanOf(89, "zh")).toBe("89 分钟");
  expect(spanOf(340, "zh")).toBe("6 小时");
  expect(spanOf(60 * 50, "zh")).toBe("2 天");
  expect(spanOf(340, "en")).toBe("6 h");
});

test("under a minute ago reads as just now", () => {
  expect(agoOf(0, "zh")).toBe("刚刚");
  expect(agoOf(0.4, "en")).toBe("just now");
  expect(agoOf(12, "zh")).toBe("12 分钟前");
  expect(agoOf(340, "en")).toBe("6 h ago");
});

test("waiting on you comes first, and check-backs say when", () => {
  const body = statusQuestionBody("zh", {
    plan: { title: "渠道调研", status: "active" },
    working: [],
    tickets: [],
    artifacts: [],
    checks: { passed: 0, total: 0, failing: [] },
    idleMinutes: 5,
    nudgedBot: null,
    waiting: [
      { bot: "研究员", kind: "approval", text: "读取 ~/Downloads/报价.pdf", elsewhere: null },
      { bot: "撰稿", kind: "ask", text: "目标读者是投资人还是用户？", elsewhere: "群「调研组」" },
    ],
    checkBacks: [{ bot: "审稿", inMinutes: 0, note: "看初稿" }],
  });
  expect(body.split("\n").slice(0, 4)).toEqual([
    "这件事：渠道调研（进行中）",
    "等你处理",
    "- 研究员 · 批准：读取 ~/Downloads/报价.pdf",
    "- 撰稿 · 回答：目标读者是投资人还是用户？ · 在「群「调研组」」",
  ]);
  expect(body).not.toContain("现在没有人在做");
  expect(body).toContain("- 审稿 · 马上 · 看初稿");
  const en = statusQuestionBody("en", {
    plan: { title: "Channels", status: "active" }, working: [], tickets: [], artifacts: [],
    checks: { passed: 0, total: 0, failing: [] }, idleMinutes: 5, nudgedBot: null,
    waiting: [{ bot: "Researcher", kind: "approval", text: "read ~/Downloads/quote.pdf", elsewhere: null }],
    checkBacks: [{ bot: "Editor", inMinutes: 125, note: "check the draft" }],
  });
  expect(en).toContain("Waiting on you\n- Researcher · approve: read ~/Downloads/quote.pdf");
  expect(en).toContain("- Editor · in 2 h · check the draft");
});

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
    expect(zh).toStartWith("规划静下来一阵了：没有待做或进行中的任务，局面「进展」里却还记着没做完或卡住的。接着推进：");
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
