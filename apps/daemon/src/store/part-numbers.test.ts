import { expect, test } from "bun:test";
import { filenamePartNumbers, partNumbers } from "./part-numbers";

// Only the lead's part names (plan_items) and the one-render-per-shot guard read these; no line of
// yours and no delivered file is placed by them (ADR 0057).

test("shot numbers in words: Chinese tens and bounded ranges, without unrelated words or oversized matches", () => {
  expect(partNumbers("第 13 镜、第三镜、Shot 7–9、3–5、前十二镜")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  expect(partNumbers("abc02 C0007 Shot 1234 前999999镜")).toEqual([7]);
});

test("shot numbers in a name come from shot, C and 镜, digits or Chinese, and not from words that merely end in c", () => {
  expect(filenamePartNumbers("work/x/EP01_shot_07.mp4")).toEqual([7]);
  expect(filenamePartNumbers("C12_v2.mp4")).toEqual([12]);
  expect(filenamePartNumbers("镜头三.png")).toEqual([3]);
  expect(filenamePartNumbers("第十二镜.mp4")).toEqual([12]);
  expect(filenamePartNumbers("music01.mp3")).toEqual([]);
  expect(filenamePartNumbers("EP01_MASTER.mp4")).toEqual([]);
});
