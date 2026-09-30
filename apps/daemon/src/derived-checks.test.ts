/**
 * Checks from your words (ADR 0040 P3): the range each number allows, when two agree, which of your
 * words state a number for the work (kept narrow: a miss costs no card, a misread costs a card),
 * which delivered file is the final deliverable, and how the checks are named.
 */
import { describe, expect, test } from "bun:test";
import {
  bindRuleOf,
  derivedCardBody,
  derivedStatements,
  editDraft,
  measureLabel,
  measureOf,
  partTicket,
  readingLabel,
  sameAsk,
  statedOfTheWork,
  unconfirmedNote,
  type QuoteForChecks,
} from "./derived-checks";
import { readDimensions } from "./quote-dimensions";

function quote(id: string, body: string, extra: Partial<QuoteForChecks> = {}): QuoteForChecks {
  return { id, body, via: "message", source: id, at: `2026-09-28T12:00:0${id.slice(1)}.000Z`, aboutPart: false, ...extra };
}

describe("the range a number allows (D15)", () => {
  test.each([
    ["片长约2分钟", { dimension: "duration", min: 108, max: 132 }],
    ["改成 3 分钟", { dimension: "duration", min: 162, max: 198 }],
    ["2 分钟以上", { dimension: "duration", min: 120, max: null }],
    ["不超过 90 秒", { dimension: "duration", min: null, max: 90 }],
    ["至少 1080p", { dimension: "resolution", min: 1080, max: null }],
    ["帧率约 30", { dimension: "fps", min: 27, max: 33 }],
    ["画幅 16:9", { dimension: "aspect", ratio: "16:9" }],
    ["做成竖屏", { dimension: "aspect", ratio: "portrait" }],
  ] as const)("%s", (text, measure) => {
    expect(measureOf(readDimensions(text)[0]!)).toEqual(measure);
  });

  test("two ranges ask the same only with the same number and bound (约 and a bare number alike)", () => {
    const of = (text: string) => measureOf(readDimensions(text)[0]!);
    expect(sameAsk(of("约 2 分钟"), of("2 分钟左右"))).toBe(true);
    expect(sameAsk(of("约 2 分钟"), of("片长 120 秒"))).toBe(true);
    expect(sameAsk(of("约 2 分钟"), of("片长 115 秒"))).toBe(false);
    expect(sameAsk(of("约 2 分钟"), of("片长改成 130 秒"))).toBe(false);
    expect(sameAsk(of("约 2 分钟"), of("约 90 秒"))).toBe(false);
    expect(sameAsk(of("约 2 分钟"), of("2 分钟以内"))).toBe(false);
    expect(sameAsk(of("2 分钟以内"), of("不超过 120 秒"))).toBe(true);
    expect(sameAsk(of("画幅 9:16"), of("比例 9:16"))).toBe(true);
    expect(sameAsk(of("画幅 9:16"), of("竖屏"))).toBe(false);
    expect(sameAsk(of("约 2 分钟"), of("帧率约 120"))).toBe(false);
  });
});

describe("which of your words state a number for the work", () => {
  const stated = (text: string) => statedOfTheWork(text.normalize("NFKC")).map((span) => span.value);

  test.each([
    // A running time with a bound, set by a word right before it, or named by what it measures.
    ["片长约2分钟", [{ dimension: "duration", seconds: 120, bound: "about" }]],
    ["90 秒以内", [{ dimension: "duration", seconds: 90, bound: "at_most" }]],
    ["不少于 2 分钟", [{ dimension: "duration", seconds: 120, bound: "at_least" }]],
    ["改成 3 分钟", [{ dimension: "duration", seconds: 180, bound: "exact" }]],
    ["片长 3 分钟", [{ dimension: "duration", seconds: 180, bound: "exact" }]],
    ["剪成 90 秒发给我", [{ dimension: "duration", seconds: 90, bound: "exact" }]],
    ["控制在 2 分钟以内", [{ dimension: "duration", seconds: 120, bound: "at_most" }]],
    ["时长定在 90 秒", [{ dimension: "duration", seconds: 90, bound: "exact" }]],
    ["make it 2 minutes", [{ dimension: "duration", seconds: 120, bound: "exact" }]],
    ["about 2 minutes, don't make it too dark", [{ dimension: "duration", seconds: 120, bound: "about" }]],
    // A resolution, a ratio, 竖屏 or a frame rate is said as it stands.
    ["导出 4K", [{ dimension: "resolution", lines: 2160, bound: "exact" }]],
    ["1080p 就行", [{ dimension: "resolution", lines: 1080, bound: "exact" }]],
    ["不要 16:9，要竖屏", [{ dimension: "aspect", ratio: "portrait" }]],
    ["60fps", [{ dimension: "fps", fps: 60, bound: "exact" }]],
    // A brief.
    ["做个片子，约 90 秒，竖屏", [{ dimension: "duration", seconds: 90, bound: "about" }, { dimension: "aspect", ratio: "portrait" }]],
    ["9:16 竖屏，60 秒左右", [{ dimension: "duration", seconds: 60, bound: "about" }, { dimension: "aspect", ratio: "9:16" }]],
    ["做一集 EP01，片长约 2 分钟，镜头之间不能跳变", [{ dimension: "duration", seconds: 120, bound: "about" }]],
    ["另外，片长改成 90 秒", [{ dimension: "duration", seconds: 90, bound: "exact" }]],
    ["字幕也要改，片长改成 90 秒", [{ dimension: "duration", seconds: 90, bound: "exact" }]],
    ["片长也要约 2 分钟", [{ dimension: "duration", seconds: 120, bound: "about" }]],
    ["also, make it 90 seconds", [{ dimension: "duration", seconds: 90, bound: "exact" }]],
    // A clause about the footage or a reference counts only a number set by a word.
    ["做一集 EP01 动画成片，约 2 分钟，参考片 5 分钟", [{ dimension: "duration", seconds: 120, bound: "about" }]],
    ["素材 20 分钟，剪成 90 秒", [{ dimension: "duration", seconds: 90, bound: "exact" }]],
    ["把素材剪成 90 秒左右", [{ dimension: "duration", seconds: 90, bound: "about" }]],
  ] as const)("%s", (text, values) => {
    expect(stated(text)).toEqual([...values]);
  });

  test("a line about a cut already made, or complaining, states nothing, even with a word for changing it", () => {
    for (const text of [
      "上一版 107 秒太短了",
      "107 秒不行",
      "只有 107 秒",
      "才 90 秒",
      "现在大概 107 秒",
      "这版大约 2 分钟",
      "大约 107 秒，画面太暗",
      "the current cut is 107 seconds",
      "it's only 107 seconds",
      "it was about 107 seconds",
      "60 帧太卡",
      "竖屏的效果不好",
      "你剪成 107 秒了，太短",
      "你剪成 107 秒，太短",
      "你剪到 90 秒太短了",
      "上一版剪成 107 秒，太短",
      "这版剪成 107 秒，太短",
      "怎么剪成 107 秒了",
      "差不多 2 分钟了",
      "上一版用 30 帧，太卡了",
      "用 60 帧太卡了",
      "导出 1080p 太糊了",
      "导出 4K 太慢了",
      "上一版导出 4K，文件太大",
      "你做成竖屏了，不对",
      "you cut it to 107 seconds, too short",
      "rendered at 4K was too slow",
      "exported at 30 fps looks choppy",
      // Missed on purpose: a change beside a complaint, or about 这版, is said again plainly or confirmed on the board.
      "太长了，改成 2 分钟",
      "这版太长了，缩短点，90 秒以内就行",
      "这版改成 90 秒",
    ]) {
      expect(stated(text), text).toEqual([]);
    }
  });

  test("a question, a wondering, another version, a time budget or a placement states nothing", () => {
    for (const text of [
      "为什么只剪到 107 秒？",
      "why did you cut it to 107 seconds?",
      "能不能改成 90 秒？",
      "改成 90 秒可以吗",
      "片长是 2 分钟吗？",
      "总长 3 分钟？太长",
      "半小时左右能好吗",
      "改成 60 帧会不会更好",
      "如果改成 90 秒呢",
      "要是 2 分钟以内就好了",
      "can you make it 90 seconds",
      "would it be better at 60 fps",
      "横屏的也做一版",
      "横屏的也做一版，30 秒左右",
      "再做一个 30 秒的片子",
      "a landscape version too",
      "限你3分钟弄完",
      "给你 10 分钟",
      "5 分钟内出结果",
      "预计 30 分钟左右出片",
      "logo 放在 3 秒",
      "字幕定在 5 秒",
      "第 3 秒脚穿地",
    ]) {
      expect(stated(text), text).toEqual([]);
    }
  });

  test("the number changed from, one of two choices, a rough cut, a still, another version or a song states nothing", () => {
    for (const text of [
      "帧率 24 改成 60",
      "分辨率从 4K 降到 1080",
      "画幅 16:9 改成竖屏",
      "帧率 24 或 30",
      "粗剪先控制在 5 分钟左右",
      "完整版控制在 5 分钟以内",
      "壁纸做成 9:16 竖屏",
      "手机界面做成竖屏",
      "横屏版片长约 2 分钟",
      "用那首歌，时长 3 分 20 秒",
      "C09 这个镜头，时长 8 秒",
      "把这段剪成 20 秒",
    ]) {
      expect(stated(text), text).toEqual([]);
    }
    // What it is changed to still reads.
    expect(stated("画幅别用 16:9 了，改成竖屏")).toEqual([{ dimension: "aspect", ratio: "portrait" }]);
  });

  test("a bare running time, the footage, a reference or a picture states nothing", () => {
    for (const text of [
      "视频 107 秒",
      "90 秒",
      "给我 2 分钟的片子",
      "4K 素材太大",
      "我需要 4K 的素材",
      "帮我剪个视频，素材 20 分钟",
      "做个片子，参考上次那个 3 分钟的",
      "来一个宣传片，参考那个 3 分钟的",
      "我要一张照片，1080p",
      "封面做成 16:9",
      "配乐 3 分钟左右",
    ]) {
      expect(stated(text), text).toEqual([]);
    }
  });
});

describe("what your words state, line by line", () => {
  test("each line stating one number for a dimension is kept, oldest first; a line giving two is passed over", () => {
    const statements = derivedStatements([
      quote("q1", "片长约2分钟，画幅 16:9"),
      quote("q2", "片长 2 分钟左右"),
      quote("q3", "片长 3 分钟，其实 4 分钟以内也行"),
      quote("q4", "改成 9:16 竖屏"),
      quote("q5", "片长约 2 分钟，两分钟左右也行"),
      quote("q6", "约 2 分钟"),
    ]);
    expect(statements.get("duration")?.map((statement) => [statement.quoteId, statement.target, statement.measure])).toEqual([
      ["q1", true, { dimension: "duration", min: 108, max: 132 }],
      ["q2", true, { dimension: "duration", min: 108, max: 132 }],
      // Two readings of the same number are one statement.
      ["q5", true, { dimension: "duration", min: 108, max: 132 }],
      // No word for what it measures, none setting the work to it: a card at most.
      ["q6", false, { dimension: "duration", min: 108, max: 132 }],
    ]);
    expect(statements.get("aspect")?.map((statement) => [statement.quoteId, statement.target])).toEqual([["q1", true], ["q4", true]]);
    expect(statements.has("fps")).toBe(false);
  });

  test("a number about one part, another version, an annotation or a part's ticket counts for no dimension", () => {
    const statements = derivedStatements([
      quote("q1", "片长约2分钟"),
      quote("q2", "C09 改成 8 秒"),
      quote("q3", "每个镜头 10 秒左右"),
      quote("q4", "改成 5 秒", { aboutPart: true }),
      quote("q5", "这里缩到 3 秒", { via: "annotation" }),
      quote("q6", "片头 5 秒以内"),
      quote("q7", "shot 3 should be about 6 seconds"),
      quote("q8", "这一段分辨率要 1080p", { via: "annotation" }),
      quote("q9", "C09 做成 60fps 慢动作"),
      quote("q10", "竖版的也要，画幅 9:16"),
      quote("q11", "抖音版控制在 30 秒左右"),
      quote("q12", "logo 按 1:1 比例缩放"),
      quote("q13", "字幕改成 2 秒一句"),
    ]);
    expect([...statements.keys()]).toEqual(["duration"]);
    expect(statements.get("duration")?.map((statement) => statement.quoteId)).toEqual(["q1"]);
  });

  test("a part named after the running time, or said no to, leaves it the whole work's", () => {
    const duration = (body: string) => derivedStatements([quote("q1", body)]).get("duration")?.[0]?.reading;
    expect(duration("片长约 2 分钟，镜头之间不能跳变")).toEqual({ dimension: "duration", seconds: 120, bound: "about" });
    expect(duration("不要额外加片头，片长约 2 分钟")).toEqual({ dimension: "duration", seconds: 120, bound: "about" });
    expect(duration("总长 2 分钟，片头 5 秒")).toEqual({ dimension: "duration", seconds: 120, bound: "exact" });
    expect(duration("C09，改成 8 秒")).toBeUndefined();
  });

  test("a ticket names a part by its shot, unless it is the master", () => {
    expect(partTicket("C09 脚穿地")).toBe(true);
    expect(partTicket("镜头 3 重做")).toBe(true);
    expect(partTicket("06 母带")).toBe(false);
    expect(partTicket("C01–C12 final cut")).toBe(false);
    expect(partTicket("配音")).toBe(false);
  });
});

describe("the final deliverable", () => {
  test("a video named as the master or the final cut, else one under deliverables/", () => {
    expect(bindRuleOf("plans/ep01/06-master/EP01_MASTER.mp4")).toEqual({ glob: "*MASTER*", rank: 0 });
    expect(bindRuleOf("out/ep01_final_v2.mov")).toEqual({ glob: "*final*", rank: 1 });
    expect(bindRuleOf("EP01_母带.mp4")).toEqual({ glob: "*MASTER*", rank: 0 });
    expect(bindRuleOf("deliverables/ep01.mp4")).toEqual({ glob: "deliverables/**", rank: 2 });
    // Whole words only, and never a name that also names a part.
    for (const path of ["deliverables/shot03.mp4", "shots/C09_final.mp4", "shots/master_shot_03.mp4", "EP01_s03_MASTER.mp4", "scene2_final.mov", "EP01finale.mp4", "remastered.mp4", "C09_镜头_final.mp4"]) {
      expect(bindRuleOf(path), path).toBeNull();
    }
    expect(bindRuleOf("assets/render/EP01_cut.mp4")).toBeNull();
    expect(bindRuleOf("deliverables/EP01_MASTER.png")).toBeNull();
    expect(bindRuleOf("notes/final.md")).toBeNull();
  });
});

describe("how the checks read", () => {
  test("what you said, and what it asks", () => {
    const [about] = readDimensions("约 2 分钟");
    expect(readingLabel(about!, "zh")).toBe("时长约 2 分钟");
    expect(readingLabel(about!, "en")).toBe("Running time about 2 min");
    expect(measureLabel(measureOf(about!), "zh")).toBe("时长 108–132 秒");
    expect(measureLabel(measureOf(about!), "en")).toBe("Running time 108–132 s");
    expect(measureLabel({ dimension: "resolution", min: 1080, max: null }, "zh")).toBe("短边 至少 1080 像素");
    expect(measureLabel({ dimension: "aspect", ratio: "portrait" }, "en")).toBe("Portrait (taller than wide)");
  });

  test("the app's lines: an offer holds nothing back and says how often you said it; a replacement leaves the gate in force", () => {
    const measure = { dimension: "duration", min: 108, max: 132 } as const;
    const proposed = derivedCardBody("zh", "proposed", [measure]);
    expect(proposed).toContain("按你的话加检查：时长 108–132 秒");
    expect(proposed).toContain("你确认之后才拦东西");
    expect(derivedCardBody("zh", "proposed", [measure], { times: 2 })).toStartWith("你已经说了 2 次。按你的话加检查");
    expect(derivedCardBody("en", "proposed", [measure], { times: 3 })).toStartWith("You have said it 3 times.");
    const replacing = derivedCardBody("zh", "proposed", [{ dimension: "duration", min: 162, max: 198 }], { replaces: [measure] });
    expect(replacing).toContain("生效中是时长 108–132 秒，你刚说的是时长 162–198 秒");
    expect(replacing).toContain("生效中的那条照旧");
    expect(derivedCardBody("zh", "proposed", [measure], { demoted: true })).toContain("改回待确认");
    expect(derivedCardBody("en", "bound", [measure], { path: "EP01_MASTER.mp4" })).toContain("delivered EP01_MASTER.mp4");
    expect(derivedCardBody("en", "proposed", [measure])).toContain("It holds nothing back until you confirm it");
    // What the Bots read of an offer: what the cut measured, and that it waits for the user.
    expect(unconfirmedNote({ item: "时长约 2 分钟", path: "EP01_MASTER.mp4", last_run: { outcome: "fail", detail: "107.00 秒，要时长 108–132 秒" } }, "zh")).toBe(
      "未确认的检查：107.00 秒，用户说的是时长约 2 分钟（待用户确认）",
    );
    expect(unconfirmedNote({ item: "时长约 2 分钟", path: null, last_run: null }, "zh")).toContain("还没有交付可量");
    // 改 starts a line of yours that the reader counts.
    expect(statedOfTheWork(`${editDraft("duration", "zh")}3 分钟`)).toHaveLength(1);
    expect(statedOfTheWork(`${editDraft("duration", "en")}3 minutes`)).toHaveLength(1);
    expect(statedOfTheWork(`${editDraft("aspect", "zh")}16:9`)).toHaveLength(1);
  });
});
