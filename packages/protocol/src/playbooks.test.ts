import { expect, test } from "bun:test";
import {
  BUILTIN_PLAYBOOK_IDS,
  builtinPlaybook,
  compactPlaybookDiff,
  PLAYBOOK_STEP_IDS,
  PLAYBOOK_STEPS,
  playbookDefaults,
  playbookStep,
  resolvePlaybook,
  stepsRequiring,
  stoppedBy,
  validatePlaybookDiff,
} from "./playbooks.ts";

test("every step is in the catalogue once, each number's default inside its range, and every built-in valid", () => {
  expect(PLAYBOOK_STEPS.map((step) => step.id)).toEqual([...PLAYBOOK_STEP_IDS]);
  for (const step of PLAYBOOK_STEPS) {
    for (const param of step.params) expect(param.default >= param.min && param.default <= param.max).toBe(true);
  }
  for (const id of BUILTIN_PLAYBOOK_IDS) {
    const resolved = builtinPlaybook(id);
    // A locked step runs whatever an engine says, for as long as what it stands on does.
    for (const step of PLAYBOOK_STEPS) if (!step.switchable) expect(resolved[step.id].on).toBe(!step.requires?.some((id) => !resolved[id].on));
  }
});

test("the built-ins that work in jobs run what they ran before the jobs step existed", () => {
  // Every step on but the ones each one has always turned off, numbers and all (ADR 0085's table).
  const on = (off: string[]) => Object.fromEntries(PLAYBOOK_STEPS.map((step) => [step.id, !off.includes(step.id)]));
  const ons = (id: "general" | "video" | "coding") => Object.fromEntries(PLAYBOOK_STEPS.map((step) => [step.id, builtinPlaybook(id)[step.id].on]));
  expect(ons("general")).toEqual(on(["scribe", "reflection"]));
  expect(ons("video")).toEqual(on(["escalation"]));
  expect(ons("coding")).toEqual(on(["scribe"]));
  expect(builtinPlaybook("video").settle.params.quiet_s).toBe(60);
  expect(builtinPlaybook("video").ceiling.params.attempts).toBe(5);
});

test("plain works in no jobs: what stands on them stops with them, and a stop still reads", () => {
  const plain = builtinPlaybook("plain");
  expect(plain.jobs.on).toBe(false);
  expect(plain.pacing.on).toBe(false);
  expect(stepsRequiring("jobs").every((id) => !plain[id].on)).toBe(true);
  for (const id of ["scribe", "closing", "settle", "pickup", "checks", "escalation", "ceiling", "retrospective", "reflection"] as const) {
    expect(stepsRequiring("jobs")).toContain(id);
    expect(stoppedBy(id, plain)).toBe("jobs");
  }
  // What it keeps: reading your line for a stop, who takes a group line, a Bot's own check-backs, and the floor.
  for (const id of ["intake", "reader", "judgement", "check_backs", "compaction", "composer"] as const) expect(plain[id].on).toBe(true);
  expect(stoppedBy("reader", plain)).toBeNull();
});

test("what a step requires stands on nothing else, so one pass settles it", () => {
  for (const step of PLAYBOOK_STEPS) {
    for (const id of step.requires ?? []) expect(playbookStep(id).requires ?? []).toEqual([]);
  }
});

test("an engine built on plain that turns jobs back on gets the steps under them as they are set", () => {
  const back = resolvePlaybook("plain", validatePlaybookDiff({ steps: { jobs: { on: true }, scribe: { on: false } } }, "plain"));
  expect(back.jobs.on).toBe(true);
  expect(back.scribe.on).toBe(false);
  expect(back.settle.on).toBe(true);
  expect(back.checks.on).toBe(true);
});

test("the reader may be off only while jobs are off, and never takes the jobs with it", () => {
  expect(() => validatePlaybookDiff({ steps: { reader: { on: false } } }, "general")).toThrow("reader can only be off while jobs is off");
  // Off where it may be, and on again as soon as jobs run, even from a stored diff.
  const noWords = validatePlaybookDiff({ steps: { reader: { on: false } } }, "plain");
  expect(resolvePlaybook("plain", noWords).reader.on).toBe(false);
  expect(() => validatePlaybookDiff({ steps: { reader: { on: false }, jobs: { on: true } } }, "plain")).toThrow("reader can only be off while jobs is off");
  expect(resolvePlaybook("plain", { v: 1, steps: { reader: { on: false }, jobs: { on: true } } }).reader.on).toBe(true);
  expect(resolvePlaybook("general", { v: 1, steps: { reader: { on: false } } }).jobs.on).toBe(true);
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
