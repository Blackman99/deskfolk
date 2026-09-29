import { describe, expect, test } from "bun:test";
import { agoOf, spanOf, statusQuestionBody } from "./transcript-copy";

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
