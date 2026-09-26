import { describe, expect, test } from "bun:test";
import { askAnswerText, askTranscriptText, parseAskAnswer, parseAskSpec, readAskAnswer, readAskSpec } from "./ask";

const AT = "2026-09-25T08:00:00.000Z";

describe("parseAskSpec", () => {
  test("no options is a plain question", () => {
    expect(parseAskSpec(undefined, undefined)).toBeNull();
    expect(parseAskSpec(null, true)).toBeNull();
    expect(parseAskSpec([], true)).toBeNull();
  });

  test("bare strings are labels; labels and descriptions are trimmed; blank descriptions drop", () => {
    expect(parseAskSpec(["  A ", { label: "B", description: "  why B " }, { label: "C", description: " " }], undefined)).toEqual({
      options: [{ label: "A" }, { label: "B", description: "why B" }, { label: "C" }],
      multi_select: false,
    });
  });

  test("multi_select is on only when asked for", () => {
    expect(parseAskSpec(["A", "B"], true)?.multi_select).toBe(true);
    expect(parseAskSpec(["A", "B"], "true")?.multi_select).toBe(true);
    expect(parseAskSpec(["A", "B"], "yes")?.multi_select).toBe(false);
  });

  test("unclear choices go back to the Bot", () => {
    expect(() => parseAskSpec("A, B", false)).toThrow("options must be an array");
    expect(() => parseAskSpec(["only"], false)).toThrow("2 to 8");
    expect(() => parseAskSpec(Array.from({ length: 9 }, (_, i) => `o${i}`), false)).toThrow("2 to 8");
    expect(() => parseAskSpec(["A", " A"], false)).toThrow("repeats");
    expect(() => parseAskSpec(["A", ""], false)).toThrow("label is required");
    expect(() => parseAskSpec(["A", { description: "no label" }], false)).toThrow("label is required");
    expect(() => parseAskSpec(["A", "字".repeat(81)], false)).toThrow("longer than 80");
    expect(() => parseAskSpec(["A", { label: "B", description: "x".repeat(201) }], false)).toThrow("longer than 200");
  });
});

describe("parseAskAnswer", () => {
  const single = { options: [{ label: "A" }, { label: "B" }, { label: "C" }], multi_select: false };
  const multi = { ...single, multi_select: true };

  test("choices come back in the question's order, text trimmed", () => {
    expect(parseAskAnswer(multi, ["C", "A"], "  note  ", AT)).toEqual({ selected: ["A", "C"], custom: "note", answered_at: AT });
  });

  test("text of your own stands alone, with or without choices on offer", () => {
    expect(parseAskAnswer(single, [], "neither", AT)).toEqual({ selected: [], custom: "neither", answered_at: AT });
    expect(parseAskAnswer(null, undefined, "free text", AT)).toEqual({ selected: [], custom: "free text", answered_at: AT });
  });

  test("single-select takes one; unknown labels and empty answers are refused", () => {
    expect(parseAskAnswer(single, ["B"], null, AT)).toEqual({ selected: ["B"], custom: null, answered_at: AT });
    expect(() => parseAskAnswer(single, ["A", "B"], null, AT)).toThrow("takes one option");
    expect(() => parseAskAnswer(single, ["D"], null, AT)).toThrow("not one of");
    expect(() => parseAskAnswer(null, ["A"], null, AT)).toThrow("not one of");
    expect(() => parseAskAnswer(single, [], "   ", AT)).toThrow("pick an option or write an answer");
    expect(() => parseAskAnswer(single, "A", null, AT)).toThrow("array of labels");
    expect(() => parseAskAnswer(single, [], 3, AT)).toThrow("custom must be a string");
  });
});

describe("rendering", () => {
  test("the answer text is the choices, then your own words", () => {
    expect(askAnswerText({ selected: ["A", "B"], custom: "and C", answered_at: AT })).toBe("A\nB\nand C");
    expect(askAnswerText({ selected: [], custom: "just this", answered_at: AT })).toBe("just this");
  });

  test("a transcript line spells out choices and answer; an open question keeps its old shape", () => {
    expect(askTranscriptText({
      body: "Which?",
      ask: { options: [{ label: "A" }, { label: "B", description: "slower" }], multi_select: false },
      ask_answer: { selected: ["B"], custom: null, answered_at: AT },
    })).toBe("Which?\n选项（单选）：A / B（slower）\n用户选了：B");
    expect(askTranscriptText({ body: "Name?", ask: null, ask_answer: { selected: [], custom: "Deskfolk", answered_at: AT } }))
      .toBe("Name?\n用户回答：Deskfolk");
    expect(askTranscriptText({ body: "Still open?", ask: null, ask_answer: null })).toBe("Still open?");
  });

  test("stored columns that do not parse read as nothing", () => {
    expect(readAskSpec("{")).toBeNull();
    expect(readAskSpec(JSON.stringify({ options: "A" }))).toBeNull();
    expect(readAskAnswer(JSON.stringify({ selected: [], custom: 5, answered_at: AT }))).toEqual({ selected: [], custom: null, answered_at: AT });
    expect(readAskAnswer(JSON.stringify({ custom: "x" }))).toBeNull();
  });
});
