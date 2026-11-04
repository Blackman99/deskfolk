import { expect, test } from "bun:test";
import { builtinPlaybook, PLAYBOOK_STEP_IDS } from "@real-bot/protocol";
import { hookOfMoment, layPlaybookFlow, PLAYBOOK_ORDER, PLAYBOOK_ROUNDS, playbookOrder, stepDiffers, stepLocked, stepOfRole, stepRole, STEP_W } from "./playbook-flow.ts";

test("every step is in one round, under the thing that sets it off, and ↑ ↓ walk the turn before its steps", () => {
  expect(PLAYBOOK_ROUNDS.flatMap((round) => round.steps).sort()).toEqual([...PLAYBOOK_STEP_IDS].sort());
  expect(PLAYBOOK_ROUNDS.map((round) => round.hook)).toEqual(["line", "group", "turn", "handed_in", "accepted", "overturned", "compose"]);
  expect(PLAYBOOK_ORDER.indexOf("turn")).toBeLessThan(PLAYBOOK_ORDER.indexOf("pacing"));
  expect(stepRole("settle")).toBe("organizer");
  expect(stepRole("intake")).toBeNull();
  expect(stepOfRole("judge")).toBe("checks");
});

test("a step that only follows the jobs has not been changed; a locked one has no switch only while it runs", () => {
  const general = builtinPlaybook("general");
  const plain = builtinPlaybook("plain");
  expect(stepDiffers("jobs", plain, general)).toBe(true);
  expect(stepDiffers("settle", plain, general)).toBe(false);
  expect(stepDiffers("checks", plain, general)).toBe(false);
  expect(stepDiffers("wait_word", plain, general)).toBe(false);
  expect(stepLocked("checks", general)).toBe(true);
  expect(stepLocked("checks", plain)).toBe(false);
  expect(stepLocked("reader", general)).toBe(true);
  expect(stepLocked("reader", plain)).toBe(false);
  expect(stepLocked("jobs", general)).toBe(false);
  expect(stepLocked("compaction", plain)).toBe(true);
});

test("wide, a round's steps fan out in a row under its root; narrow, they hang down a spine — nothing overlaps either way", () => {
  for (const width of [1100, 390, 228]) {
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
  // As narrow as the list's place beside a wide window, the map still fits without scrolling across.
  expect(layPlaybookFlow(228).width).toBe(228);
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

const mine = (id: string, at: "before_effect" | "after_effect" | "turn_end" | "handed_in" | "accepted" | "overturned") => ({ id: `u_${id}`, at });

test("a step of your own hangs in the round of its moment after the built-in steps; each of those rounds ends in an add card only when addable", () => {
  expect(hookOfMoment("before_effect")).toBe("turn");
  expect(hookOfMoment("after_effect")).toBe("turn");
  expect(hookOfMoment("turn_end")).toBe("turn");
  expect(hookOfMoment("handed_in")).toBe("handed_in");
  const own = [mine("aaaaaaaa", "turn_end"), mine("bbbbbbbb", "handed_in"), mine("cccccccc", "before_effect"), mine("dddddddd", "overturned")];
  for (const width of [1400, 390]) {
    const layout = layPlaybookFlow(width, own, false);
    expect(layout.cards.some((card) => card.kind === "add")).toBe(false);
    const ids = (hook: string) => layout.cards.filter((card) => card.hook === hook && card.kind === "step").map((card) => card.id);
    const turnBuiltin = PLAYBOOK_ROUNDS.find((round) => round.hook === "turn")!.steps;
    // Built-in first, then its own in the order given.
    expect(ids("turn")).toEqual([...turnBuiltin, "u_aaaaaaaa", "u_cccccccc"]);
    expect(ids("handed_in").at(-1)).toBe("u_bbbbbbbb");
    expect(ids("overturned").at(-1)).toBe("u_dddddddd");
    expect(ids("accepted").some((id) => id.startsWith("u_"))).toBe(false);
    // Joined to its root like any step.
    expect(layout.edges).toHaveLength(PLAYBOOK_STEP_IDS.length + own.length);
  }
  const added = layPlaybookFlow(1400, own, true);
  const adds = added.cards.filter((card) => card.kind === "add");
  expect(adds.map((card) => card.id)).toEqual(["add:turn", "add:handed_in", "add:accepted", "add:overturned"]);
  expect(adds.every((card) => card.node === null)).toBe(true);
  // An add card has no edge of its own, and is the last card of its round.
  expect(added.edges).toHaveLength(PLAYBOOK_STEP_IDS.length + own.length);
  for (const add of adds) {
    const round = added.cards.filter((card) => card.hook === add.hook && card.kind !== "root");
    expect(round.at(-1)!.id).toBe(add.id);
  }
});

test("longer rows still fan out where they fit and hang down a spine where they do not, nothing overlapping", () => {
  const own = Array.from({ length: 6 }, (_, i) => mine(`turn${i}xxxx`, "turn_end"));
  for (const width of [2400, 1100, 390, 228]) {
    const layout = layPlaybookFlow(width, own, true);
    for (const [i, a] of layout.cards.entries()) {
      expect(a.x + a.w).toBeLessThanOrEqual(layout.width);
      for (const b of layout.cards.slice(i + 1)) {
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    }
  }
  const wide = layPlaybookFlow(3000, own, true);
  expect(new Set(wide.cards.filter((card) => card.hook === "turn" && card.kind !== "root").map((card) => card.y)).size).toBe(1);
  const narrow = layPlaybookFlow(390, own, true);
  expect(new Set(narrow.cards.filter((card) => card.hook === "turn" && card.kind !== "root").map((card) => card.x)).size).toBe(1);
});

test("↑ and ↓ walk the steps of your own after their round's built-in ones", () => {
  const order = playbookOrder([mine("aaaaaaaa", "after_effect"), mine("bbbbbbbb", "accepted")]);
  expect(playbookOrder()).toEqual([...PLAYBOOK_ORDER]);
  const lastTurn = PLAYBOOK_ROUNDS.find((round) => round.hook === "turn")!.steps.at(-1)!;
  expect(order.indexOf("u_aaaaaaaa" as never)).toBe(order.indexOf(lastTurn) + 1);
  const lastAccepted = PLAYBOOK_ROUNDS.find((round) => round.hook === "accepted")!.steps.at(-1)!;
  expect(order.indexOf("u_bbbbbbbb" as never)).toBe(order.indexOf(lastAccepted) + 1);
  // The call a step of your own makes belongs to no built-in step; its node is not a built-in's.
  expect(stepOfRole("custom_step")).toBeNull();
  expect(stepRole("u_aaaaaaaa")).toBeNull();
});
