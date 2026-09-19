import { expect, test } from "bun:test";
import {
  INITIAL_MENTION_STATE,
  applyMentionCandidate,
  detectMentionTrigger,
  handleMentionKeyDown,
  shouldIgnoreKeyUp,
  scrollTopToRevealRect,
  stepMentionHighlight,
  updateMentionTrigger,
} from "./mention-popup.ts";

test("detectMentionTrigger detects @ at start of input", () => {
  const trigger = detectMentionTrigger("@", 1);
  expect(trigger).toEqual({
    active: true,
    query: "",
    anchorIndex: 0,
  });
});

test("detectMentionTrigger detects @ with query at start of input", () => {
  const trigger = detectMentionTrigger("@writer", 7);
  expect(trigger).toEqual({
    active: true,
    query: "writer",
    anchorIndex: 0,
  });
});

test("detectMentionTrigger detects @ preceded by whitespace", () => {
  const trigger = detectMentionTrigger("hello @reviewer", 15);
  expect(trigger).toEqual({
    active: true,
    query: "reviewer",
    anchorIndex: 6,
  });
});

test("detectMentionTrigger detects query mid-typing", () => {
  // Cursor after 'r' in '@re'
  const trigger = detectMentionTrigger("hello @reviewer", 9);
  expect(trigger).toEqual({
    active: true,
    query: "re",
    anchorIndex: 6,
  });
});

test("detectMentionTrigger rejects email address without leading space", () => {
  const trigger = detectMentionTrigger("test@example.com", 16);
  expect(trigger.active).toBe(false);
});

test("detectMentionTrigger rejects when cursor is after a space following @mention", () => {
  const trigger = detectMentionTrigger("@writer ", 8);
  expect(trigger.active).toBe(false);
});

test("detectMentionTrigger rejects when cursor is before @", () => {
  const trigger = detectMentionTrigger("hello @writer", 5);
  expect(trigger.active).toBe(false);
});

test("detectMentionTrigger handles multiple @mentions and targets the active one", () => {
  const text = "hi @Alice and @Bob";
  const trigger = detectMentionTrigger(text, text.length);
  expect(trigger).toEqual({
    active: true,
    query: "Bob",
    anchorIndex: 14,
  });
});

test("stepMentionHighlight cycles forward on down arrow", () => {
  expect(stepMentionHighlight(0, 3, "down")).toBe(1);
  expect(stepMentionHighlight(1, 3, "down")).toBe(2);
  expect(stepMentionHighlight(2, 3, "down")).toBe(0);
});

test("stepMentionHighlight cycles backward on up arrow", () => {
  expect(stepMentionHighlight(0, 3, "up")).toBe(2);
  expect(stepMentionHighlight(2, 3, "up")).toBe(1);
  expect(stepMentionHighlight(1, 3, "up")).toBe(0);
});

test("stepMentionHighlight handles single or empty candidates", () => {
  expect(stepMentionHighlight(0, 1, "down")).toBe(0);
  expect(stepMentionHighlight(0, 1, "up")).toBe(0);
  expect(stepMentionHighlight(0, 0, "down")).toBe(0);
});

test("scrollTopToRevealRect keeps scroll when the item is fully visible", () => {
  expect(scrollTopToRevealRect(40, 100, 200, 120, 150)).toBe(40);
});

test("scrollTopToRevealRect scrolls up when the item is above the viewport", () => {
  expect(scrollTopToRevealRect(80, 100, 200, 70, 100)).toBe(50);
});

test("scrollTopToRevealRect scrolls down when the item is below the viewport", () => {
  expect(scrollTopToRevealRect(0, 100, 200, 220, 250)).toBe(50);
});

test("scrollTopToRevealRect does not scroll above the content start", () => {
  expect(scrollTopToRevealRect(10, 100, 200, 80, 110)).toBe(0);
});

test("applyMentionCandidate replaces query and preserves surrounding text", () => {
  const result = applyMentionCandidate("hello @w please check", 6, 8, "WriterBot");
  expect(result.nextDraft).toBe("hello @WriterBot  please check");
  expect(result.nextCursor).toBe(6 + "@WriterBot ".length);
});

test("applyMentionCandidate handles mention at start of draft", () => {
  const result = applyMentionCandidate("@", 0, 1, "everyone");
  expect(result.nextDraft).toBe("@everyone ");
  expect(result.nextCursor).toBe("@everyone ".length);
});

test("updateMentionTrigger opens popup and initializes highlight to 0", () => {
  const state = updateMentionTrigger(INITIAL_MENTION_STATE, "@", 1, 3);
  expect(state).toEqual({
    show: true,
    query: "",
    anchorIndex: 0,
    highlightIndex: 0,
    dismissed: false,
  });
});

test("updateMentionTrigger preserves highlightIndex when query and anchor do not change", () => {
  // Simulate state where user stepped highlight to 1
  const activeState = {
    show: true,
    query: "",
    anchorIndex: 0,
    highlightIndex: 1,
    dismissed: false,
  };
  // Calling updateMentionTrigger with the same text and cursor must NOT reset highlight to 0
  const nextState = updateMentionTrigger(activeState, "@", 1, 3);
  expect(nextState.highlightIndex).toBe(1);
  expect(nextState.show).toBe(true);
});

test("updateMentionTrigger resets highlightIndex to 0 when query changes", () => {
  const activeState = {
    show: true,
    query: "",
    anchorIndex: 0,
    highlightIndex: 2,
    dismissed: false,
  };
  // User types 'w' -> '@w'
  const nextState = updateMentionTrigger(activeState, "@w", 2, 2);
  expect(nextState.highlightIndex).toBe(0);
  expect(nextState.query).toBe("w");
  expect(nextState.show).toBe(true);
});

test("handleMentionKeyDown on ArrowDown advances highlight and marks handled", () => {
  const activeState = {
    show: true,
    query: "",
    anchorIndex: 0,
    highlightIndex: 0,
    dismissed: false,
  };
  const { state: nextState, handled } = handleMentionKeyDown(activeState, "ArrowDown", 3);
  expect(handled).toBe(true);
  expect(nextState.highlightIndex).toBe(1);

  // Re-checking trigger after arrow key does NOT jump back to 0
  const afterCheck = updateMentionTrigger(nextState, "@", 1, 3);
  expect(afterCheck.highlightIndex).toBe(1);
});

test("handleMentionKeyDown on Escape closes popup and marks dismissed", () => {
  const activeState = {
    show: true,
    query: "",
    anchorIndex: 0,
    highlightIndex: 1,
    dismissed: false,
  };
  const { state: nextState, handled } = handleMentionKeyDown(activeState, "Escape", 3);
  expect(handled).toBe(true);
  expect(nextState.show).toBe(false);
  expect(nextState.dismissed).toBe(true);

  // Calling updateMentionTrigger (e.g. on keyup or cursor click) must NOT reopen popup
  const afterKeyup = updateMentionTrigger(nextState, "@", 1, 3);
  expect(afterKeyup.show).toBe(false);
  expect(afterKeyup.dismissed).toBe(true);
});

test("updateMentionTrigger re-opens dismissed popup when user resumes typing", () => {
  const dismissedState = {
    show: false,
    query: "",
    anchorIndex: 0,
    highlightIndex: 0,
    dismissed: true,
  };
  // User resumes typing: '@' -> '@b'
  const afterTyping = updateMentionTrigger(dismissedState, "@b", 2, 2);
  expect(afterTyping.show).toBe(true);
  expect(afterTyping.dismissed).toBe(false);
  expect(afterTyping.query).toBe("b");
  expect(afterTyping.highlightIndex).toBe(0);
});

test("shouldIgnoreKeyUp ignores ArrowDown, ArrowUp, Escape, Enter, Tab", () => {
  expect(shouldIgnoreKeyUp("ArrowDown")).toBe(true);
  expect(shouldIgnoreKeyUp("ArrowUp")).toBe(true);
  expect(shouldIgnoreKeyUp("Escape")).toBe(true);
  expect(shouldIgnoreKeyUp("Enter")).toBe(true);
  expect(shouldIgnoreKeyUp("Tab")).toBe(true);
  expect(shouldIgnoreKeyUp("ArrowLeft")).toBe(false);
  expect(shouldIgnoreKeyUp("a")).toBe(false);
});
