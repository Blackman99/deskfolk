/**
 * Numbers in your words (ADR 0040 P3): what the fixed rules read as a running time, a resolution,
 * an aspect ratio or a frame rate, and what they leave alone.
 */
import { describe, expect, test } from "bun:test";
import { readDimensions, sameDimensionValue } from "./quote-dimensions";

describe("running time", () => {
  test.each([
    ["片长约 2 分钟", 120, "about"],
    ["片长 2 分钟左右", 120, "about"],
    ["改成 3 分钟", 180, "exact"],
    ["两分钟以上", 120, "at_least"],
    ["超过 2 分钟", 120, "at_least"],
    ["不超过90秒", 90, "at_most"],
    ["控制在 1 分 30 秒以内", 90, "at_most"],
    ["一分半", 90, "exact"],
    ["两分半钟", 150, "exact"],
    ["1 小时 20 分钟", 4800, "exact"],
    ["半分钟", 30, "exact"],
    ["每段约 8.04 秒", 8.04, "about"],
    ["about 2 minutes", 120, "about"],
    ["at least 90s", 90, "at_least"],
    ["２分钟", 120, "exact"],
    ["一百二十秒", 120, "exact"],
    ["一个半小时", 5400, "exact"],
    ["两个半钟头", 9000, "exact"],
    ["一小时半", 5400, "exact"],
    ["半个小时", 1800, "exact"],
    ["改到 3 分钟", 180, "exact"],
    ["时长在 2 分钟左右", 120, "about"],
    ["最好在 90 秒以内", 90, "at_most"],
    ["从 3 分钟改成 2 分钟", 120, "exact"],
  ] as const)("%s", (text, seconds, bound) => {
    expect(readDimensions(text)).toEqual([{ dimension: "duration", seconds, bound }]);
  });

  test.each([
    ["不少于 2 分钟", 120, "at_least"],
    ["不能少于两分钟", 120, "at_least"],
    ["不要超过3分钟", 180, "at_most"],
    ["别超过 90 秒", 90, "at_most"],
    ["最多 90 秒", 90, "at_most"],
    ["不到 3 分钟", 180, "at_most"],
    ["大概 2 分钟", 120, "about"],
    ["not more than 3 minutes", 180, "at_most"],
    ["no longer than 2 min", 120, "at_most"],
    ["should not exceed 3 minutes", 180, "at_most"],
    ["no less than 90s", 90, "at_least"],
    ["not under 2 minutes", 120, "at_least"],
    ["under 3 minutes", 180, "at_most"],
    // 不过 is "but", not a bound.
    ["不过 3 分钟就够", 180, "exact"],
    // The bound holds across 要 / 得.
    ["至少要 2 分钟", 120, "at_least"],
    ["最多得 90 秒", 90, "at_most"],
  ] as const)("a no in front turns the bound over: %s", (text, seconds, bound) => {
    expect(readDimensions(text)).toEqual([{ dimension: "duration", seconds, bound }]);
  });

  test("a bare 分 or m is minutes before seconds or after a word for a running time, and nothing alone", () => {
    expect(readDimensions("2m30s")).toEqual([{ dimension: "duration", seconds: 150, bound: "exact" }]);
    expect(readDimensions("时长 3 分")).toEqual([{ dimension: "duration", seconds: 180, bound: "exact" }]);
    expect(readDimensions("duration 3m")).toEqual([{ dimension: "duration", seconds: 180, bound: "exact" }]);
    expect(readDimensions("片长约 2 分")).toEqual([{ dimension: "duration", seconds: 120, bound: "about" }]);
    for (const text of ["打 3 分", "十分重要", "5m 高的墙", "镜头推进 3m"]) expect(readDimensions(text), text).toEqual([]);
  });

  test("a number you said no to is no number", () => {
    expect(readDimensions("不是 3 分钟，是 2 分钟")).toEqual([{ dimension: "duration", seconds: 120, bound: "exact" }]);
    expect(readDimensions("不要 4K，1080p 就行")).toEqual([{ dimension: "resolution", lines: 1080, bound: "exact" }]);
    for (const text of ["别做成 16:9", "don't use 60fps", "not in 4K", "不要 3 分钟"]) expect(readDimensions(text), text).toEqual([]);
    // 能不能 / 要不要 ask; the 不能 / 不要 in them is no no.
    expect(readDimensions("能不能改成 90 秒")).toEqual([{ dimension: "duration", seconds: 90, bound: "exact" }]);
    expect(readDimensions("要不要 4K")).toEqual([{ dimension: "resolution", lines: 2160, bound: "exact" }]);
  });

  test("a line with two running times reads both; one with none reads nothing", () => {
    expect(readDimensions("C09 8 秒，总长 3 分钟").map((value) => value.dimension)).toEqual(["duration", "duration"]);
    for (const text of ["C09 的脚不能穿地", "十分重要", "打 3 分", "Shot 12 重做", "EP01 第 3 镜", "两分多钟"]) {
      expect(readDimensions(text)).toEqual([]);
    }
  });

  test("a moment or a stretch of the picture, a range, or a time to answer in is no length", () => {
    for (const text of [
      "C09 第 3 秒脚穿地",
      "12秒处穿帮",
      "第十秒",
      "12 秒左右的地方",
      "在 3 秒穿帮",
      "3 秒后切镜",
      "前 3 秒太暗",
      "播到 12 秒的时候",
      "3-5 分钟",
      "3~5分钟",
      "2 到 3 分钟",
      "两到三分钟",
      "一两分钟",
      "两三秒",
      "2 or 3 minutes",
      "请在 5 分钟内回复我",
    ]) {
      expect(readDimensions(text), text).toEqual([]);
    }
  });

  test("how long something else takes is no length of the work", () => {
    for (const text of [
      "给我 5 分钟",
      "等 5 分钟再看",
      "大概等 5 分钟再说",
      "渲染要 20 分钟",
      "渲染大概要 20 分钟",
      "每隔 10 分钟汇报一次",
      "3 分钟前我说过",
      "过了 3 分钟",
      "10 分钟一次",
      "大约 3 小时能渲染完",
      "最多 10 分钟就回来",
      "wait 5 minutes",
      "the render took about 3 hours",
      "I'll be back in about 10 minutes",
      "please reply within 5 minutes",
      // When it will be ready, and time spent away.
      "半小时左右能好吗",
      "预计 30 分钟左右出片",
      "大概 20 分钟能看到吗",
      "30 分钟左右交给我",
      "估计还要 10 分钟",
      "我开会大概 1 小时",
      "ETA about 30 minutes",
    ]) {
      expect(readDimensions(text), text).toEqual([]);
    }
    // The piece asked for, a bound written with 过, and 不过 ("but") still read.
    expect(readDimensions("给我 2 分钟左右的片子")).toEqual([{ dimension: "duration", seconds: 120, bound: "about" }]);
    expect(readDimensions("超过 2 分钟")).toEqual([{ dimension: "duration", seconds: 120, bound: "at_least" }]);
    expect(readDimensions("改成 3 分钟再出一版")).toEqual([{ dimension: "duration", seconds: 180, bound: "exact" }]);
  });

  test("a time budget or a place in the picture is no length; a length set by a word is one whatever follows it", () => {
    for (const text of ["做成 90s 港风", "改成 80s 复古风", "调成 90s 色调", "1 分钟左右切到产品", "前面 3 秒左右要抓人", "2 小时以内搞出来", "这个任务大概 3 小时左右"]) {
      expect(readDimensions(text), text).toEqual([]);
    }
    expect(readDimensions("剪成 90s")).toEqual([{ dimension: "duration", seconds: 90, bound: "exact" }]);
    for (const text of ["限你3分钟弄完", "限你 3 分钟之内弄完", "给你 10 分钟", "3 分钟之内弄完", "5 分钟内出结果", "logo 放在 3 秒", "字幕定在 5 秒", "片名压在 3 秒", "挪到 3 秒", "卡在 3 秒"]) {
      expect(readDimensions(text), text).toEqual([]);
    }
    expect(readDimensions("剪成 90 秒发给我")).toEqual([{ dimension: "duration", seconds: 90, bound: "exact" }]);
    expect(readDimensions("压在 90 秒以内")).toEqual([{ dimension: "duration", seconds: 90, bound: "at_most" }]);
    expect(readDimensions("压到 90 秒")).toEqual([{ dimension: "duration", seconds: 90, bound: "exact" }]);
    expect(readDimensions("时长定在 90 秒")).toEqual([{ dimension: "duration", seconds: 90, bound: "exact" }]);
    expect(readDimensions("时长限 2 分钟以内")).toEqual([{ dimension: "duration", seconds: 120, bound: "at_most" }]);
  });

  test("a no before a word for setting the work says no to the number; 最长 / 打底 and the like are bounds; scores are no minutes", () => {
    for (const text of ["不要剪成 90 秒", "千万别剪成 90 秒那种", "片长别压到 60 秒以下", "片长不要剪到 1 分钟以下", "打分：时长 8 分，画面 7 分", "时长 8 分，节奏 6 分"]) {
      expect(readDimensions(text), text).toEqual([]);
    }
    expect(readDimensions("能不能改成 90 秒")).toEqual([{ dimension: "duration", seconds: 90, bound: "exact" }]);
    expect(readDimensions("片长最长 90 秒")).toEqual([{ dimension: "duration", seconds: 90, bound: "at_most" }]);
    expect(readDimensions("片长上限 90 秒")).toEqual([{ dimension: "duration", seconds: 90, bound: "at_most" }]);
    expect(readDimensions("顶多 2 分钟")).toEqual([{ dimension: "duration", seconds: 120, bound: "at_most" }]);
    expect(readDimensions("max 90s")).toEqual([{ dimension: "duration", seconds: 90, bound: "at_most" }]);
    expect(readDimensions("最短 60 秒")).toEqual([{ dimension: "duration", seconds: 60, bound: "at_least" }]);
    expect(readDimensions("分辨率最低 1080p")).toEqual([{ dimension: "resolution", lines: 1080, bound: "at_least" }]);
    expect(readDimensions("分辨率 1080p 打底")).toEqual([{ dimension: "resolution", lines: 1080, bound: "at_least" }]);
  });

  test("k after a budget, a price or a bitrate is money or a rate, not a resolution", () => {
    for (const text of ["预算控制在 2k 以内", "报价压到 4k", "码率 8k"]) expect(readDimensions(text), text).toEqual([]);
    expect(readDimensions("出 4K")).toEqual([{ dimension: "resolution", lines: 2160, bound: "exact" }]);
  });

  test("a number is read whatever the line makes of it: which ones state something is for derived-checks.ts", () => {
    expect(readDimensions("上一版 107 秒太短了")).toEqual([{ dimension: "duration", seconds: 107, bound: "exact" }]);
    expect(readDimensions("60fps 太卡")).toEqual([{ dimension: "fps", fps: 60, bound: "exact" }]);
  });
});

describe("resolution, aspect and rate", () => {
  test("resolution is the picture's short side, however it is written", () => {
    expect(readDimensions("出 1080p")).toEqual([{ dimension: "resolution", lines: 1080, bound: "exact" }]);
    expect(readDimensions("1920x1080")).toEqual([{ dimension: "resolution", lines: 1080, bound: "exact" }]);
    expect(readDimensions("竖版 1080×1920")).toEqual([{ dimension: "resolution", lines: 1080, bound: "exact" }]);
    expect(readDimensions("至少 4K")).toEqual([{ dimension: "resolution", lines: 2160, bound: "at_least" }]);
    expect(readDimensions("给我 2k 字的文案")).toEqual([]);
    expect(readDimensions("4k 块以内")).toEqual([]);
  });

  test("an aspect ratio is one a picture is made in, in lowest terms; a time or a copy is not", () => {
    expect(readDimensions("画幅 16:9")).toEqual([{ dimension: "aspect", ratio: "16:9" }]);
    expect(readDimensions("9：16 竖屏")).toEqual([{ dimension: "aspect", ratio: "9:16" }]);
    expect(readDimensions("2.35:1 宽银幕")).toEqual([{ dimension: "aspect", ratio: "2.35:1" }]);
    expect(readDimensions("比例 16比9")).toEqual([{ dimension: "aspect", ratio: "16:9" }]);
    // A ratio needs a word for the picture's shape near it, and never follows a score.
    for (const text of ["16比9", "片尾打上比分 2:1", "最后比分是 3比2", "比分 2:1，画幅不变"]) expect(readDimensions(text), text).toEqual([]);
    expect(readDimensions("10:53 说的")).toEqual([]);
    expect(readDimensions("1:1 还原原画")).toEqual([]);
  });

  test("竖屏 / 横屏 say which side is longer when no ratio says more; how you watched it does not", () => {
    expect(readDimensions("做成竖屏")).toEqual([{ dimension: "aspect", ratio: "portrait" }]);
    expect(readDimensions("横版就行")).toEqual([{ dimension: "aspect", ratio: "landscape" }]);
    expect(readDimensions("a portrait video")).toEqual([{ dimension: "aspect", ratio: "portrait" }]);
    expect(readDimensions("cut it in landscape")).toEqual([{ dimension: "aspect", ratio: "landscape" }]);
    expect(readDimensions("不要 16:9，要竖屏")).toEqual([{ dimension: "aspect", ratio: "portrait" }]);
    // The ratio or the frame size already says it.
    expect(readDimensions("横屏 16:9")).toEqual([{ dimension: "aspect", ratio: "16:9" }]);
    expect(readDimensions("竖屏 1080x1920")).toEqual([{ dimension: "resolution", lines: 1080, bound: "exact" }]);
    for (const text of ["手机竖屏看字太小", "竖屏的时候字幕被挡", "用横屏预览一下", "不要竖屏", "a portrait of her"]) expect(readDimensions(text), text).toEqual([]);
    // 横幅 / 竖幅 are as often a banner.
    for (const text of ["横幅标语改一下", "竖幅海报"]) expect(readDimensions(text), text).toEqual([]);
  });

  test("a frame rate by its unit, after 帧率, or as a common rate", () => {
    expect(readDimensions("24fps")).toEqual([{ dimension: "fps", fps: 24, bound: "exact" }]);
    expect(readDimensions("帧率改成 30")).toEqual([{ dimension: "fps", fps: 30, bound: "exact" }]);
    expect(readDimensions("帧率约 30")).toEqual([{ dimension: "fps", fps: 30, bound: "about" }]);
    expect(readDimensions("帧率至少 24")).toEqual([{ dimension: "fps", fps: 24, bound: "at_least" }]);
    expect(readDimensions("每秒 60 帧")).toEqual([{ dimension: "fps", fps: 60, bound: "exact" }]);
    expect(readDimensions("60 frames per second")).toEqual([{ dimension: "fps", fps: 60, bound: "exact" }]);
    // A bare N 帧 is a count of frames.
    for (const text of ["60 帧", "淡出 24 帧", "C09 多了 12 帧", "加 12 帧黑场"]) expect(readDimensions(text), text).toEqual([]);
    expect(readDimensions("截 37 帧画面")).toEqual([]);
    expect(readDimensions("第 24 帧穿帮")).toEqual([]);
    expect(readDimensions("4K 60fps")).toEqual([
      { dimension: "resolution", lines: 2160, bound: "exact" },
      { dimension: "fps", fps: 60, bound: "exact" },
    ]);
  });
});

test("two readings are the same only with the same number and bound", () => {
  const [about2] = readDimensions("约 2 分钟");
  const [again] = readDimensions("两分钟左右");
  const [over2] = readDimensions("2 分钟以上");
  expect(sameDimensionValue(about2!, again!)).toBe(true);
  expect(sameDimensionValue(about2!, over2!)).toBe(false);
});
