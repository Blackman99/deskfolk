import { expect, test } from "bun:test";
import { conversationWide, craftRequirement } from "./craft-words";

test("how the work is made is craft; a value choice or what stays the same across a series holds for the conversation but is no craft; one named part is neither", () => {
  for (const [category, words] of [
    [null, "每次过门都要有过渡镜头"],
    [null, "禁止多手与解剖异化"],
    [null, "不用冻帧补时长"],
    ["背景连贯", "前后要接得上"],
    [null, "画风要统一"],
    [null, "色调前后要一致"],
    [null, "统一的光影"],
    ["配音", "配音全片保持一致"],
    [null, "keep the colour grading consistent"],
    [null, "the lighting must stay consistent"],
  ] as const) {
    expect(craftRequirement(category, words)).toBe(true);
    expect(conversationWide(category, words)).toBe(true);
  }
  for (const [category, words] of [
    [null, "机械臂必须是左手"],
    ["角色设定", "主角一直穿红外套"],
    // A value choice: EP01 cold, EP02 warm. Each film's own taste, never one rule for every film.
    [null, "色调偏冷"],
    ["色调", "要暖一点"],
    [null, "光影要有电影感"],
    [null, "打光硬一点"],
    [null, "运镜要稳"],
    ["字幕样式", "黑底白字"],
    [null, "配音用男声"],
    [null, "音色低沉一些"],
    [null, "画风偏写实"],
    [null, "a warm colour grade"],
    [null, "the art style is anime"],
  ] as const) {
    expect(craftRequirement(category, words)).toBe(false);
    expect(conversationWide(category, words)).toBe(true);
  }
  for (const [category, words] of [
    ["背景连贯", "前三镜背景严重跳跃"],
    ["穿模", "C09 的脚不能穿地"],
    [null, "片尾加二维码"],
    [null, "标题别太长"],
    ["时长", "片长约 2 分钟"],
    [null, "shot 4 needs a transition"],
    // Words any job may use about itself, not about how pictures are made.
    ["一致性", "这次数据要和上个月一致"],
    [null, "报告的字体统一用宋体"],
    [null, "节奏快一点"],
    [null, "画质要高"],
    [null, "keep the style consistent with last quarter's report"],
    [null, "the pacing of the essay is too slow"],
  ] as const) {
    expect(craftRequirement(category, words)).toBe(false);
    expect(conversationWide(category, words)).toBe(false);
  }
});
