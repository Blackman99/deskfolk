import { beforeEach, describe, expect, test } from "bun:test";
import { loadFoldedDirs, loadFoldedSections, saveFoldedDirs, saveFoldedSections } from "./sidebar-fold-state.ts";

describe("sidebar-fold-state", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("defaults to empty (everything open)", () => {
    expect(loadFoldedDirs()).toEqual({});
    expect(loadFoldedSections()).toEqual({});
  });

  test("persists only folded directories and clears storage when all reopen", () => {
    saveFoldedDirs({ "/a/b": true, "/c/d": false });
    expect(loadFoldedDirs()).toEqual({ "/a/b": true });
    saveFoldedDirs({ "/a/b": false });
    expect(loadFoldedDirs()).toEqual({});
  });

  test("persists folded sections and ignores unknown keys", () => {
    saveFoldedSections({ bots: true, projects: false });
    expect(loadFoldedSections()).toEqual({ bots: true });
    localStorage.setItem("real-bot-sidebar-folded-sections", JSON.stringify(["projects", "bogus"]));
    expect(loadFoldedSections()).toEqual({ projects: true });
  });

  test("handles malformed storage safely", () => {
    localStorage.setItem("real-bot-sidebar-folded-dirs", "{not-json");
    expect(loadFoldedDirs()).toEqual({});
  });
});
