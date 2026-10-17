import { expect, test } from "bun:test";
import {
  BUILTIN_PLAYBOOK_IDS,
  builtinPlaybook,
  compactPlaybookDiff,
  PLAYBOOK_STEP_IDS,
  PLAYBOOK_STEPS,
  playbookDefaults,
  resolvePlaybook,
  validatePlaybookDiff,
} from "./playbooks.ts";

test("every step is in the catalogue once, each number's default inside its range, and every built-in valid", () => {
  expect(PLAYBOOK_STEPS.map((step) => step.id)).toEqual([...PLAYBOOK_STEP_IDS]);
  for (const step of PLAYBOOK_STEPS) {
    for (const param of step.params) expect(param.default >= param.min && param.default <= param.max).toBe(true);
  }
  for (const id of BUILTIN_PLAYBOOK_IDS) {
    const resolved = builtinPlaybook(id);
    // A locked step always runs, whatever an engine says.
    for (const step of PLAYBOOK_STEPS) if (!step.switchable) expect(resolved[step.id].on).toBe(true);
  }
});

test("your changes go over the built-in, and only what differs from it is kept", () => {
  const diff = validatePlaybookDiff({ v: 1, steps: { settle: { params: { quiet_s: 300 } }, scribe: { on: false } } }, "general");
  const resolved = resolvePlaybook("general", diff);
  expect(resolved.settle.params.quiet_s).toBe(300);
  expect(resolved.scribe.on).toBe(false);
  expect(resolved.reader).toEqual(playbookDefaults().reader);
  const builtin = builtinPlaybook("general");
  expect(compactPlaybookDiff("general", { v: 1, steps: { settle: { params: { quiet_s: builtin.settle.params.quiet_s! } }, scribe: { on: builtin.scribe.on } } }))
    .toEqual({ v: 1, steps: {} });
  // An `on` the step cannot take is never read, even in a stored diff.
  expect(resolvePlaybook("general", { v: 1, steps: { reader: { on: false } } }).reader.on).toBe(true);
  // Nor a number the step no longer has: the hop limit, retired 2026-10-17, stays stored in diffs saved before.
  expect(resolvePlaybook("general", { v: 1, steps: { pacing: { params: { hop_limit: 400, check_in_hops: 60 } } } }).pacing.params).toEqual({ check_in_hops: 60 });
});

test("a diff is refused when it names what is not there or a number out of range", () => {
  expect(() => validatePlaybookDiff(null, "general")).toThrow("diff must be an object");
  expect(() => validatePlaybookDiff({ v: 2, steps: {} }, "general")).toThrow("diff.v must be 1");
  expect(() => validatePlaybookDiff({ steps: { composer: { on: false } } }, "general")).toThrow("cannot be switched off");
  expect(() => validatePlaybookDiff({ steps: { ceiling: { params: { streak: 2.5 } } } }, "general")).toThrow("whole number");
  expect(() => validatePlaybookDiff({ steps: { ceiling: { mood: 1 } } }, "general")).toThrow("unknown field mood");
});
