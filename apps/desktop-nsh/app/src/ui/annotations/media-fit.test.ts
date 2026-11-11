/** The video in the media annotator keeps its shape: across the pane, or smaller when the pane is short. */
import { expect, test } from "nsh/test";
import { videoBox } from "./media-fit";

test("a wide video in a tall pane takes the pane's width at its own shape", () => {
  expect(videoBox({ width: 1920, height: 1080 }, { width: 640, height: 900 }, 60, 6)).toEqual({ width: 640, height: 360 });
});

test("a tall video gives way to the timeline and the buttons, centred at its own shape", () => {
  // 900 high, 60 for what is below and 6 between: 834 for the picture.
  expect(videoBox({ width: 1080, height: 1920 }, { width: 640, height: 900 }, 60, 6)).toEqual({ width: 834 * (1080 / 1920), height: 834 });
});

test("never below the minimum: past it the pane scrolls", () => {
  expect(videoBox({ width: 1080, height: 1920 }, { width: 640, height: 120 }, 60, 6)).toEqual({ width: 96 * (1080 / 1920), height: 96 });
});

test("nothing to lay out by before the video has said its size", () => {
  expect(videoBox(null, { width: 640, height: 900 }, 60, 6)).toBeNull();
  expect(videoBox({ width: 0, height: 0 }, { width: 640, height: 900 }, 60, 6)).toBeNull();
  expect(videoBox({ width: 1920, height: 1080 }, { width: 0, height: 0 }, 60, 6)).toBeNull();
});
