import { expect, test } from "bun:test";
import { profileDraftDirty, reconcileProfileDraft } from "./roster-edit.ts";

const writer = { name: "Writer", duties: "write", boundaries: "stay", avatar: null, model: "" };

test("whitespace-only edits still count as dirty so a bot.upsert does not clobber them", () => {
  expect(profileDraftDirty({ ...writer, duties: "write " }, writer)).toBe(true);
  expect(profileDraftDirty({ ...writer, avatar: "https://example.com/new.png" }, writer)).toBe(true);
  expect(profileDraftDirty(writer, writer)).toBe(false);
});

test("bot.upsert refreshes the draft only when the fields match the last saved baseline", () => {
  const incoming = { name: "Writer", duties: "draft notes", boundaries: "stay", avatar: null, model: "" };
  expect(reconcileProfileDraft(writer, writer, incoming)).toEqual({
    draft: incoming,
    baseline: incoming,
  });
  const dirty = { name: "Writer", duties: "I am typing", boundaries: "stay", avatar: null, model: "" };
  expect(reconcileProfileDraft(dirty, writer, incoming)).toEqual({
    draft: dirty,
    baseline: writer,
  });
});
