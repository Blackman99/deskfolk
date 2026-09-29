import { describe, expect, test } from "bun:test";
import { lenientMatch, mentionToken, parseMentions } from "./mentions.ts";

describe("parseMentions", () => {
  test("longest roster name wins and everyone is literal", () => {
    const parsed = parseMentions("hi @WriterBot and @Writer and @everyone", ["Writer", "WriterBot"]);
    expect(parsed.mentions).toEqual(["WriterBot", "Writer"]);
    expect(parsed.everyone).toBe(true);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.corrected).toEqual([]);
    expect(parsed.spans.map((s) => s.kind)).toEqual(["name", "name", "everyone"]);
  });

  test("unknown names are unresolved and do not create a bot", () => {
    const parsed = parseMentions("@Nope hello", ["Writer"]);
    expect(parsed.mentions).toEqual([]);
    expect(parsed.unresolved).toEqual(["Nope"]);
    expect(parsed.everyone).toBe(false);
    expect(parsed.spans).toEqual([
      { start: 0, end: 5, kind: "unresolved", token: "Nope", name: null },
    ]);
  });

  test("an unresolved token stops at CJK punctuation instead of swallowing the sentence", () => {
    const parsed = parseMentions("@分镜，请按锁点出六场镜表。", ["导演"]);
    expect(parsed.unresolved).toEqual(["分镜"]);
  });

  test("a truncated name resolves to the only member it is a prefix of", () => {
    const roster = ["选题策划", "分镜师", "导演", "编剧", "审片", "制片"];
    const parsed = parseMentions("@分镜 请按锁点出六场镜表，交制片调度。", roster, { lenient: roster });
    expect(parsed.mentions).toEqual(["分镜师"]);
    expect(parsed.corrected).toEqual([{ token: "分镜", name: "分镜师" }]);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.spans[0]).toEqual({
      start: 0,
      end: 3,
      kind: "lenient",
      token: "分镜",
      name: "分镜师",
    });
  });

  test("a dropped qualifier resolves as a suffix, and case is ignored", () => {
    const roster = ["选题策划", "Researcher"];
    const parsed = parseMentions("@策划 和 @researcher 看一下", roster, { lenient: roster });
    expect(parsed.mentions).toEqual(["选题策划", "Researcher"]);
    expect(parsed.corrected).toEqual([
      { token: "策划", name: "选题策划" },
      { token: "researcher", name: "Researcher" },
    ]);
  });

  test("an ambiguous or single-character token stays unresolved", () => {
    const roster = ["分镜师", "分析师"];
    const parsed = parseMentions("@分 和 @师 请看 @分镜", roster, { lenient: roster });
    expect(parsed.mentions).toEqual(["分镜师"]);
    expect(parsed.unresolved).toEqual(["分", "师"]);
  });

  test("lenient matching only considers the lenient list, not the whole roster", () => {
    const parsed = parseMentions("@分镜 出图", ["分镜师", "导演"], { lenient: ["导演"] });
    expect(parsed.mentions).toEqual([]);
    expect(parsed.unresolved).toEqual(["分镜"]);
  });

  test("an @ before a number, frame or time reads as \"at\" and is neither a mention nor a miss", () => {
    const roster = ["制片", "审片", "导演"];
    const parsed = parseMentions(
      "全局峰值 **−1.0 dB @37.79s**，落掌 @f96、@t37，会议 @14:30，版本 @2026-09-18 发布，@审片 请复核",
      roster,
      { lenient: roster },
    );
    expect(parsed.mentions).toEqual(["审片"]);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.corrected).toEqual([]);
    expect(parsed.spans.every((s) => s.kind !== "unresolved")).toBe(true);
  });

  test("a digit-leading token still resolves leniently to the one member it abbreviates", () => {
    const roster = ["3D师", "导演"];
    const parsed = parseMentions("@3D 请出模型", roster, { lenient: roster });
    expect(parsed.mentions).toEqual(["3D师"]);
    expect(parsed.corrected).toEqual([{ token: "3D", name: "3D师" }]);
    expect(parsed.unresolved).toEqual([]);
  });

  test("a literal roster name still beats a lenient guess", () => {
    const parsed = parseMentions("@分镜师请出图", ["分镜师", "分镜"], { lenient: ["分镜师", "分镜"] });
    expect(parsed.mentions).toEqual(["分镜师"]);
    expect(parsed.corrected).toEqual([]);
  });
});

describe("mentionToken", () => {
  test("ends at whitespace, ASCII and CJK punctuation", () => {
    expect(mentionToken("Writer, hello")).toBe("Writer");
    expect(mentionToken("分镜。")).toBe("分镜");
    expect(mentionToken("分镜（请）")).toBe("分镜");
    expect(mentionToken("Writer-Bot done")).toBe("Writer-Bot");
    expect(mentionToken("")).toBe("");
  });
});

describe("lenientMatch", () => {
  test("requires a unique prefix or suffix of at least two code points", () => {
    expect(lenientMatch("分镜", ["分镜师", "导演"])).toBe("分镜师");
    expect(lenientMatch("镜师", ["分镜师", "导演"])).toBe("分镜师");
    expect(lenientMatch("师", ["分镜师"])).toBeNull();
    expect(lenientMatch("分", ["分镜师", "分析师"])).toBeNull();
    expect(lenientMatch("writer", ["Writer", "WriterBot"])).toBeNull();
    expect(lenientMatch("nope", ["Writer"])).toBeNull();
  });
});

describe("non-mention @ usage", () => {
  test("emails and npm scopes are neither resolved nor flagged", () => {
    const roster = ["分镜师", "导演", "Researcher"];
    const parsed = parseMentions(
      "写信到 user@host.com 或 email@Researcher.com，装 @sveltejs/kit，然后 @分镜 出图",
      roster,
      { lenient: roster },
    );
    expect(parsed.mentions).toEqual(["分镜师"]);
    expect(parsed.corrected).toEqual([{ token: "分镜", name: "分镜师" }]);
    expect(parsed.unresolved).toEqual([]);
  });

  test("a CJK character before @ still counts as a mention", () => {
    const roster = ["分镜师"];
    expect(parseMentions("请@分镜师出图", roster).mentions).toEqual(["分镜师"]);
    expect(parseMentions("请@分镜 出图", roster, { lenient: roster }).mentions).toEqual(["分镜师"]);
    expect(parseMentions("请@分镜出图", roster, { lenient: roster }).unresolved).toEqual(["分镜出图"]);
  });

  test("an @ in a cited path, link target or URL wakes nobody", () => {
    const roster = ["审稿员", "设计师", "开发工程师", "项目协调人"];
    // Folders were named after the request that opened them, so older ones carry its `@`.
    const plan = "work/2026-09-23-@审稿员-继续-e3wm";
    const body = [
      "@设计师 请接 [需求说明](docs/specs/ASSIGNMENT.md)。",
      `抽帧：[t000.jpg](${plan}/scratch/e1check/t000.jpg)`,
      `附件：${plan}/04-整理需求/scratch/verify/v2_000.jpg`,
      "目录 2026-09-23-@审稿员-继续-e3wm 和 `work/@项目协调人-继续-e3wm/map.md`",
      "[x](@审稿员.md)、https://example.com/@项目协调人、work/@张三-abcd/x.png",
      "[x](work/请@审稿员看-e3wm/x.md)",
      // The daemon links a path it cites with the path as its own label, the `@` included.
      "[work/请@审稿员看-e3wm/x.md](work/请@审稿员看-e3wm/x.md)",
      "[./work/请@审稿员看-e3wm/y.md](work/请@审稿员看-e3wm/y.md)",
    ].join("\n");
    const parsed = parseMentions(body, roster, { lenient: roster });
    expect(parsed.mentions).toEqual(["设计师"]);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.spans).toHaveLength(1);
  });

  test("a link label that says something other than its target is still read", () => {
    const roster = ["开发工程师"];
    expect(parseMentions("[@开发工程师](work/x.md) 请看", roster).mentions).toEqual(["开发工程师"]);
    expect(parseMentions("[看这里 @开发工程师](work/x.md)", roster).mentions).toEqual(["开发工程师"]);
  });

  test("an angle-bracket link target is skipped up to its `>)`, and not past it", () => {
    const roster = ["A", "B"];
    expect(parseMentions("[a](<d @A>)", roster).mentions).toEqual([]);
    expect(parseMentions("[a](<d> @A)", roster).mentions).toEqual(["A"]);
    // Two on one line: the cached `>` stop of the first must not end the second.
    expect(parseMentions("[a](<x y>) [b](<p @A>) @B", roster).mentions).toEqual(["B"]);
    // A `)` inside the angle brackets does not end the target.
    expect(parseMentions("[a](<x) @A>) @B", roster).mentions).toEqual(["B"]);
  });

  test("a mention right after Chinese text, brackets, quotes or punctuation still counts", () => {
    const roster = ["设计师", "开发工程师"];
    const bodies = [
      "请@开发工程师出图",
      "（@开发工程师）",
      "「@开发工程师」",
      "**@开发工程师**",
      "见 [板](production/TASKBOARD.md)@开发工程师",
      "把work/abc/x.png发给@开发工程师",
      "——@开发工程师",
      // Not a link: a link target has no space in it.
      "[P0](@开发工程师 负责)",
    ];
    expect(bodies.map((body) => parseMentions(body, roster).mentions)).toEqual(
      bodies.map(() => ["开发工程师"]),
    );
  });

  test("names joined by a slash are all named, but a slash inside a path joins nothing", () => {
    const roster = ["设计师", "开发工程师"];
    expect(parseMentions("@设计师/@开发工程师 一起看", roster).mentions).toEqual([
      "设计师",
      "开发工程师",
    ]);
    expect(parseMentions("@Researcher/@Writer", ["Researcher", "Writer"]).mentions).toEqual([
      "Researcher",
      "Writer",
    ]);
    expect(parseMentions("work/@设计师/@开发工程师/x.md", roster).mentions).toEqual([]);
    expect(parseMentions("美术/@开发工程师", roster).mentions).toEqual([]);
    expect(parseMentions("@foo/@bar 看", roster).unresolved).toEqual(["foo", "bar"]);
    const everyone = parseMentions("@everyone/@开发工程师", roster);
    expect(everyone.everyone).toBe(true);
    expect(everyone.mentions).toEqual(["开发工程师"]);
    const scope = parseMentions("装 @sveltejs/kit", roster, { lenient: roster });
    expect(scope.mentions).toEqual([]);
    expect(scope.unresolved).toEqual([]);
  });

  test("a long slash-joined run or a body full of `](` is read in one pass", () => {
    expect(parseMentions(`${"@a/".repeat(20000)}@a`, ["a"]).mentions).toEqual(["a"]);
    expect(parseMentions(`${"](<".repeat(100000)}@a`, ["a"]).mentions).toEqual(["a"]);
  });
});
