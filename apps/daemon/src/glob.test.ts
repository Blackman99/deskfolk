import { describe, expect, test } from "bun:test";
import { globToRegExp, isGlobPattern, splitGlobDir } from "./glob";

describe("isGlobPattern", () => {
  test("true for * or ?, false for a plain path", () => {
    expect(isGlobPattern("renders/*_MASTER.mp4")).toBe(true);
    expect(isGlobPattern("renders/ep0?.mp4")).toBe(true);
    expect(isGlobPattern("renders/ep01.mp4")).toBe(false);
  });
});

describe("globToRegExp", () => {
  test("* stays within one path segment, ? matches exactly one char, other characters are literal", () => {
    const pattern = globToRegExp("*_MASTER_V2.mp4");
    expect(pattern.test("ep01_MASTER_V2.mp4")).toBe(true);
    expect(pattern.test("a/b_MASTER_V2.mp4")).toBe(false); // * does not cross a "/"
    expect(pattern.test("ep01_MASTER_V2.mp4.bak")).toBe(false); // anchored at both ends
    expect(globToRegExp("ep0?.mp4").test("ep01.mp4")).toBe(true);
    expect(globToRegExp("ep0?.mp4").test("ep011.mp4")).toBe(false);
    expect(globToRegExp("a.b(c)[d]".replace(/[ab]/g, "$&")).test("a.b(c)[d]")).toBe(true);
  });
});

describe("splitGlobDir", () => {
  test("splits at the last / before the first wildcard; no wildcard is its own fixed path", () => {
    expect(splitGlobDir("renders/*_MASTER.mp4")).toEqual({ dir: "renders", filePattern: "*_MASTER.mp4" });
    expect(splitGlobDir("*_MASTER.mp4")).toEqual({ dir: ".", filePattern: "*_MASTER.mp4" });
    expect(splitGlobDir("a/b/*.mp4")).toEqual({ dir: "a/b", filePattern: "*.mp4" });
    expect(splitGlobDir("renders/ep01.mp4")).toEqual({ dir: "renders/ep01.mp4", filePattern: "" });
  });
});
