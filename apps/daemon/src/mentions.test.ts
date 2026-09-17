import { describe, expect, test } from "bun:test";
import { lenientMatch, mentionToken, parseMentions } from "./mentions";

describe("parseMentions", () => {
  test("longest roster name wins and everyone is literal", () => {
    const parsed = parseMentions("hi @WriterBot and @Writer and @everyone", ["Writer", "WriterBot"]);
    expect(parsed.mentions).toEqual(["WriterBot", "Writer"]);
    expect(parsed.everyone).toBe(true);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.corrected).toEqual([]);
  });

  test("unknown names are unresolved and do not create a bot", () => {
    const parsed = parseMentions("@Nope hello", ["Writer"]);
    expect(parsed.mentions).toEqual([]);
    expect(parsed.unresolved).toEqual(["Nope"]);
    expect(parsed.everyone).toBe(false);
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
    const roster = ["分镜师", "导演"];
    const parsed = parseMentions(
      "写信到 user@host.com，装 @sveltejs/kit，然后 @分镜 出图",
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
});
