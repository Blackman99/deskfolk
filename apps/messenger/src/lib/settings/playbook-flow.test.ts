import { expect, test } from "bun:test";
import { builtinPlaybook, PLAYBOOK_STEP_IDS } from "@real-bot/protocol";
import { layPlaybookFlow, PLAYBOOK_ORDER, PLAYBOOK_ROUNDS, stepDiffers, stepOfRole, stepRole, STEP_W } from "./playbook-flow.ts";

test("every step is in one round, under the thing that sets it off, and ↑ ↓ walk the turn before its steps", () => {
  expect(PLAYBOOK_ROUNDS.flatMap((round) => round.steps).sort()).toEqual([...PLAYBOOK_STEP_IDS].sort());
  expect(PLAYBOOK_ROUNDS.map((round) => round.hook)).toEqual(["line", "group", "turn", "handed_in", "accepted", "overturned", "compose"]);
  expect(PLAYBOOK_ORDER.indexOf("turn")).toBeLessThan(PLAYBOOK_ORDER.indexOf("pacing"));
  expect(stepRole("settle")).toBe("organizer");
  expect(stepRole("intake")).toBeNull();
  expect(stepOfRole("judge")).toBe("checks");
});

test("wide, a round's steps fan out in a row under its root; narrow, they hang down a spine — nothing overlaps either way", () => {
  for (const width of [1100, 390]) {
    const layout = layPlaybookFlow(width);
    const boxes = layout.cards;
    for (const [i, a] of boxes.entries()) {
      expect(a.x + a.w).toBeLessThanOrEqual(layout.width);
      for (const b of boxes.slice(i + 1)) {
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    }
    // Every step is joined to its round's root.
    expect(layout.edges).toHaveLength(PLAYBOOK_STEP_IDS.length);
  }
  const wide = layPlaybookFlow(1400);
  const turnSteps = wide.cards.filter((card) => card.hook === "turn" && card.kind === "step");
  expect(new Set(turnSteps.map((card) => card.y)).size).toBe(1);
  const narrow = layPlaybookFlow(390);
  const hung = narrow.cards.filter((card) => card.hook === "turn" && card.kind === "step");
  expect(new Set(hung.map((card) => card.x)).size).toBe(1);
  expect(hung[0]!.w).toBeGreaterThanOrEqual(STEP_W);
  // The turn's root is the Bot's turn itself, to be picked; the others are labels.
  expect(narrow.cards.find((card) => card.hook === "turn" && card.kind === "root")).toMatchObject({ id: "turn", node: "turn" });
  expect(narrow.cards.find((card) => card.hook === "line" && card.kind === "root")).toMatchObject({ node: null });
});

test("a step differs from its built-in by its switch or any of its numbers", () => {
  const builtin = builtinPlaybook("video");
  expect(stepDiffers("settle", builtin, builtin)).toBe(false);
  expect(stepDiffers("settle", { ...builtin, settle: { on: true, params: { quiet_s: 90 } } }, builtin)).toBe(true);
  expect(stepDiffers("scribe", { ...builtin, scribe: { ...builtin.scribe, on: false } }, builtin)).toBe(true);
});
