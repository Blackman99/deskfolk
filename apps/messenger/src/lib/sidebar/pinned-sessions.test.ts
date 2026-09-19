import { expect, test } from "bun:test";
import {
  cleanPinnedIds,
  isSessionPinned,
  togglePinnedId,
} from "./pinned-sessions.ts";

test("togglePinnedId adds unpinned and removes pinned", () => {
  expect(togglePinnedId([], "s1")).toEqual(["s1"]);
  expect(togglePinnedId(["s1"], "s2")).toEqual(["s1", "s2"]);
  expect(togglePinnedId(["s1", "s2"], "s1")).toEqual(["s2"]);
});

test("isSessionPinned checks array and set", () => {
  expect(isSessionPinned(["s1", "s2"], "s1")).toBe(true);
  expect(isSessionPinned(["s1", "s2"], "s3")).toBe(false);
  expect(isSessionPinned(new Set(["s1"]), "s1")).toBe(true);
});

test("cleanPinnedIds removes sessions not in validSessionIds", () => {
  const valid = new Set(["s1", "s3"]);
  expect(cleanPinnedIds(["s1", "s2", "s3", "s4"], valid)).toEqual(["s1", "s3"]);
});
