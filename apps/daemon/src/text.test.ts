import { describe, expect, test } from "bun:test";
import { codePointCount, takeCodePoints } from "./text";

describe("code points", () => {
  test("a surrogate pair is one code point and is never split", () => {
    expect(codePointCount("a😀b")).toBe(3);
    expect(takeCodePoints("a😀b", 2)).toEqual({ text: "a😀", original: 3, truncated: true });
    expect(takeCodePoints("😀😀", 1).text).toBe("😀");
  });

  test("a lone surrogate counts as one, as spreading the string would", () => {
    const lone = "a\ud83db\ude00";
    expect(codePointCount(lone)).toBe([...lone].length);
    expect(takeCodePoints(lone, 2).text).toBe("a\ud83d");
    expect(takeCodePoints("x\ud83d", 5)).toEqual({ text: "x\ud83d", original: 2, truncated: false });
  });

  test("the limit is inclusive and zero keeps nothing", () => {
    expect(takeCodePoints("镜头", 2)).toEqual({ text: "镜头", original: 2, truncated: false });
    expect(takeCodePoints("镜头", 0)).toEqual({ text: "", original: 2, truncated: true });
    expect(takeCodePoints("", 0)).toEqual({ text: "", original: 0, truncated: false });
  });

  test("a string past the engine's array limit still clips", () => {
    // `[...text]` threw RangeError here, which crashed the turn whose shell printed it.
    const huge = "a".repeat(2 ** 28 + 1);
    expect(codePointCount(huge)).toBe(2 ** 28 + 1);
    expect(takeCodePoints(huge, 3)).toEqual({ text: "aaa", original: 2 ** 28 + 1, truncated: true });
  });
});
