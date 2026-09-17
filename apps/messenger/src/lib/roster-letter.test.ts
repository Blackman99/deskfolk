import { expect, test } from "bun:test";
import { rosterLetter } from "./roster-letter.ts";

test("takes the first code point, keeping case", () => {
  expect(rosterLetter("Writer")).toBe("W");
  expect(rosterLetter("researcher")).toBe("r");
});

test("takes the first CJK character", () => {
  expect(rosterLetter("写手")).toBe("写");
});

test("empty or whitespace is a placeholder", () => {
  expect(rosterLetter("")).toBe("?");
  expect(rosterLetter("  ")).toBe("?");
});
