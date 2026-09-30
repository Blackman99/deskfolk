/**
 * What a history or group confirm sends when it runs: clearing or deleting keeps what you said there
 * (ADR 0040) unless you ticked the box to erase it too, and the box is read when you confirm.
 */
import { expect, test } from "bun:test";
import { aDirect, aGroup, fakeRuntime } from "../test-fixtures.ts";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import { ShellDangerConfirm } from "./danger-confirm.svelte.ts";

function shell() {
  const runtime = fakeRuntime({ sessions: [aDirect({ id: "d1" }), aGroup({ id: "g1" })] });
  const danger = new ShellDangerConfirm({
    runtime: () => runtime as unknown as MessengerRuntime,
    selected: () => null,
    sessionsById: () => new Map([["d1", { kind: "direct" }], ["g1", { kind: "group" }]]),
    groupDetail: () => ({ sessionId: null, name: "", nameError: undefined, failed: false, pullPick: "" }),
    setProfileFailed: () => {},
    setSaveFailed: () => {},
    closeNestedProfile: () => {},
  });
  return { runtime, danger };
}

test("clearing a history keeps your words unless the box was ticked before confirming", async () => {
  const { runtime, danger } = shell();
  danger.openClearHistoryConfirm("d1", "menu");
  expect(danger.dangerConfirm?.eraseQuotes).toBe(false);
  await danger.confirmDanger();

  danger.openClearHistoryConfirm("d1", "menu");
  danger.setDangerOption(true);
  danger.setDangerOption(false);
  danger.setDangerOption(true);
  await danger.confirmDanger();

  expect(runtime.calls.filter((call) => call.name === "clearSessionHistory").map((call) => call.args)).toEqual([
    ["d1", { eraseQuotes: false }],
    ["d1", { eraseQuotes: true }],
  ]);
});

test("deleting a group sends the box as ticked, and a fresh confirm starts unticked", async () => {
  const { runtime, danger } = shell();
  danger.openDeleteGroupConfirm("g1", "menu");
  danger.setDangerOption(true);
  await danger.confirmDanger();
  danger.openDeleteGroupConfirm("g1", "menu");
  expect(danger.dangerConfirm?.eraseQuotes).toBe(false);

  expect(runtime.calls.filter((call) => call.name === "deleteSession").map((call) => call.args)).toEqual([["g1", { eraseQuotes: true }]]);
});
