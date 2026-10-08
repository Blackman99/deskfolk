import { expect, test } from "bun:test";
import { Autosave } from "./autosave.svelte.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a save runs once typing has been quiet, and a later call restarts the wait", async () => {
  const autosave = new Autosave();
  let runs = 0;
  autosave.schedule(() => (runs += 1), 40);
  await sleep(25);
  autosave.schedule(() => (runs += 1), 40);
  await sleep(25);
  expect(runs).toBe(0);
  await sleep(40);
  expect(runs).toBe(1);
});

test("cancel says whether a save was waiting, and drops it", async () => {
  const autosave = new Autosave();
  expect(autosave.cancel()).toBe(false);
  let runs = 0;
  autosave.schedule(() => (runs += 1), 20);
  expect(autosave.cancel()).toBe(true);
  expect(autosave.cancel()).toBe(false);
  await sleep(40);
  expect(runs).toBe(0);
});

test("the default wait is 600 ms", async () => {
  const autosave = new Autosave();
  let runs = 0;
  autosave.schedule(() => (runs += 1));
  await sleep(500);
  expect(runs).toBe(0);
  await sleep(200);
  expect(runs).toBe(1);
});
