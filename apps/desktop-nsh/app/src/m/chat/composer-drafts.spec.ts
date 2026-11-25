import { afterEach, expect, test } from "bun:test";
import {
  clearComposerDrafts,
  COMPOSER_DRAFT_PREFIX,
  draftStorageKey,
  forgetComposerDraft,
  loadComposerDraft,
  pruneComposerDrafts,
  saveComposerDraft,
} from "./composer-drafts.ts";

afterEach(() => {
  clearComposerDrafts();
});

test("saveComposerDraft and loadComposerDraft keep text verbatim per conversation", () => {
  saveComposerDraft("sess-a", "  第一行\n@Writer 第二行 ");
  saveComposerDraft("sess-b", "另一段草稿");

  expect(loadComposerDraft("sess-a")).toBe("  第一行\n@Writer 第二行 ");
  expect(loadComposerDraft("sess-b")).toBe("另一段草稿");
  expect(loadComposerDraft("sess-missing")).toBe("");
});

test("saving an empty string removes the stored entry", () => {
  saveComposerDraft("sess-a", "半句话");
  expect(localStorage.getItem(draftStorageKey("sess-a"))).toBe("半句话");

  saveComposerDraft("sess-a", "");
  expect(localStorage.getItem(draftStorageKey("sess-a"))).toBeNull();
  expect(loadComposerDraft("sess-a")).toBe("");
});

test("forgetComposerDraft drops only that conversation's draft", () => {
  saveComposerDraft("sess-a", "A");
  saveComposerDraft("sess-b", "B");

  forgetComposerDraft("sess-a");
  expect(loadComposerDraft("sess-a")).toBe("");
  expect(loadComposerDraft("sess-b")).toBe("B");
});

test("pruneComposerDrafts drops drafts for removed conversations and leaves other storage keys alone", () => {
  localStorage.setItem("other-app-key", "keep-me");
  saveComposerDraft("live-1", "保留 1");
  saveComposerDraft("gone-1", "删掉 1");
  saveComposerDraft("live-2", "保留 2");
  saveComposerDraft("gone-2", "删掉 2");

  pruneComposerDrafts(new Set(["live-1", "live-2"]));

  expect(loadComposerDraft("live-1")).toBe("保留 1");
  expect(loadComposerDraft("live-2")).toBe("保留 2");
  expect(loadComposerDraft("gone-1")).toBe("");
  expect(loadComposerDraft("gone-2")).toBe("");
  expect(localStorage.getItem("other-app-key")).toBe("keep-me");
  localStorage.removeItem("other-app-key");
});

test("empty sessionId is ignored safely", () => {
  saveComposerDraft("", "ignored");
  expect(localStorage.getItem(`${COMPOSER_DRAFT_PREFIX}`)).toBeNull();
  expect(loadComposerDraft("")).toBe("");
});
