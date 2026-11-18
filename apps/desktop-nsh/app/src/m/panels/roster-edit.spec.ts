import { expect, test } from "bun:test";
import {
  profileContentEqual,
  profileDraftDirty,
  profileNeedsSave,
  reconcileProfileDraft,
} from "./roster-edit.ts";

const writer = {
  name: "Writer",
  duties: "write",
  boundaries: "stay",
  avatar: null,
  model: "",
  thinkingLevel: "",
};

test("whitespace-only edits still count as dirty so a bot.upsert does not clobber them", () => {
  expect(profileDraftDirty({ ...writer, duties: "write " }, writer)).toBe(true);
  expect(profileDraftDirty({ ...writer, avatar: "https://example.com/new.png" }, writer)).toBe(true);
  expect(profileDraftDirty({ ...writer, thinkingLevel: "high" }, writer)).toBe(true);
  expect(profileDraftDirty(writer, writer)).toBe(false);
});

test("bot.upsert refreshes the draft only when the fields match the last saved baseline", () => {
  const incoming = { ...writer, duties: "draft notes" };
  expect(reconcileProfileDraft(writer, writer, incoming)).toEqual({
    draft: incoming,
    baseline: incoming,
  });
  const dirty = { ...writer, duties: "I am typing" };
  expect(reconcileProfileDraft(dirty, writer, incoming)).toEqual({
    draft: dirty,
    baseline: writer,
  });
});

test("an upsert that echoes our own autosave keeps the text as typed, trailing space included", () => {
  const typed = { ...writer, duties: "draft notes " };
  const echoed = { ...writer, duties: "draft notes" };
  expect(reconcileProfileDraft(typed, typed, echoed)).toEqual({ draft: typed, baseline: typed });
});

test("autosave sends only when the trimmed content differs from the baseline", () => {
  expect(profileNeedsSave({ ...writer, duties: "write " }, writer)).toBe(false);
  expect(profileNeedsSave({ ...writer, duties: "write more" }, writer)).toBe(true);
  expect(profileNeedsSave({ ...writer, thinkingLevel: "low" }, writer)).toBe(true);
  expect(profileContentEqual({ ...writer, avatar: "" }, { ...writer, avatar: null })).toBe(true);
});
