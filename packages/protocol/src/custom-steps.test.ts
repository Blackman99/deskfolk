import { expect, test } from "bun:test";
import {
  CUSTOM_STEP_ATS,
  CUSTOM_STEP_THENS,
  CUSTOM_STEP_THENS_AT,
  CUSTOM_STEPS_MAX,
  customStepRuns,
  customStepTimeout,
  type CustomStep,
} from "./custom-steps.ts";
import {
  BUILTIN_PLAYBOOK_IDS,
  builtinPlaybook,
  compactPlaybookDiff,
  customStepViews,
  PLAYBOOK_DIFF_MAX,
  PLAYBOOK_STEP_IDS,
  resolvePlaybook,
  validatePlaybookDiff,
} from "./playbooks.ts";

const lint: CustomStep = {
  id: "u_lintafterwrite",
  name: "写完 TS 跑 lint",
  on: true,
  at: "after_effect",
  match: { tools: ["write_file"], paths: ["src/**/*.ts"] },
  run: { kind: "command", command: "pnpm -s eslint $DESKFOLK_PATHS" },
  then: "note",
};
const noEnv: CustomStep = { id: "u_noenvfile01", name: "不许动 .env", on: true, at: "before_effect", match: { paths: ["**/.env"] }, run: { kind: "rule" }, then: "refuse" };
const ffprobe: CustomStep = { id: "u_ffprobe0001", name: "量一下视频", on: true, at: "handed_in", match: { paths: ["**/*.mp4"] },
  run: { kind: "command", command: "ffprobe -v error \"$DESKFOLK_PATHS\"", timeout_s: 300 }, then: "gate" };

function refusal(diff: unknown): string {
  try {
    validatePlaybookDiff(diff, "general");
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("not refused");
}

test("every moment allows only what a no can do there, and every no is allowed somewhere", () => {
  expect(Object.keys(CUSTOM_STEP_THENS_AT)).toEqual([...CUSTOM_STEP_ATS]);
  const used = new Set(Object.values(CUSTOM_STEP_THENS_AT).flat());
  expect([...CUSTOM_STEP_THENS].every((then) => used.has(then))).toBe(true);
  // Around a call a command holds the Bot's next step: short. A turn's end may run a test suite.
  expect(customStepTimeout("before_effect")).toEqual({ min: 1, max: 60, default: 10 });
  expect(customStepTimeout("turn_end")).toEqual({ min: 1, max: 600, default: 120 });
});

test("steps of your own are kept whole, in one order, and saving the same steps twice reads the same", () => {
  const shuffled = {
    v: 1,
    steps: {},
    custom_steps: [
      { then: "note", run: { command: "  pnpm -s eslint $DESKFOLK_PATHS ", kind: "command" }, match: { paths: ["src/**/*.ts"], tools: ["write_file"] }, at: "after_effect", on: true, name: " 写完 TS 跑 lint ", id: "u_lintafterwrite" },
      noEnv,
    ],
  };
  const once = validatePlaybookDiff(shuffled, "general");
  expect(once.custom_steps).toEqual([lint, noEnv]);
  expect(JSON.stringify(validatePlaybookDiff(once, "general"))).toBe(JSON.stringify(once));
  // A timeout at its default is not kept, and a cwd of "." is the root it would be anyway.
  const tidy = validatePlaybookDiff({ steps: {}, custom_steps: [{ ...lint, run: { kind: "command", command: "x", cwd: ".", timeout_s: 10 } }] }, "general");
  expect(tidy.custom_steps![0]!.run).toEqual({ kind: "command", command: "x" });
  // No steps of your own is no field at all, so an engine with none diffs as it did before them.
  expect(validatePlaybookDiff({ steps: {}, custom_steps: [] }, "general")).toEqual({ v: 1, steps: {} });
  expect(compactPlaybookDiff("general", { v: 1, steps: {}, custom_steps: [] })).toEqual({ v: 1, steps: {} });
});

test("a step is refused when its no does not fit its moment, a rule has nothing to match, or a field is out of range", () => {
  expect(refusal({ steps: {}, custom_steps: [{ ...lint, then: "refuse" }] })).toContain("then must be one of note at after_effect");
  expect(refusal({ steps: {}, custom_steps: [{ ...noEnv, match: undefined }] })).toContain("a rule needs something to match");
  expect(refusal({ steps: {}, custom_steps: [{ ...ffprobe, match: { tools: ["shell"] } }] })).toContain("match.tools only applies before or after a call");
  expect(refusal({ steps: {}, custom_steps: [{ ...lint, id: "lint" }] })).toContain(".id must be u_");
  expect(refusal({ steps: {}, custom_steps: [lint, lint] })).toContain("used twice");
  expect(refusal({ steps: {}, custom_steps: [{ ...lint, name: "x".repeat(41) }] })).toContain("at most 40");
  expect(refusal({ steps: {}, custom_steps: [{ ...lint, run: { kind: "command", command: "x", timeout_s: 61 } }] })).toContain("from 1 to 60");
  expect(refusal({ steps: {}, custom_steps: [{ ...lint, run: { kind: "command", command: "x", cwd: "../elsewhere" } }] })).toContain("inside the workspace");
  expect(refusal({ steps: {}, custom_steps: [{ ...lint, match: { paths: ["/etc/*"] } }] })).toContain("inside the workspace");
  expect(refusal({ steps: {}, custom_steps: [{ ...lint, run: { kind: "model", prompt: "x".repeat(4001) } }] })).toContain("at most 4000");
  expect(refusal({ steps: {}, custom_steps: [{ ...lint, run: { kind: "rule", command: "x" } }] })).toContain("a rule runs nothing");
  expect(refusal({ steps: {}, custom_steps: [{ ...lint, extra: 1 }] })).toContain("unknown field extra");
  const many = Array.from({ length: CUSTOM_STEPS_MAX + 1 }, (_, index) => ({ ...lint, id: `u_step${String(index).padStart(6, "0")}` }));
  expect(refusal({ steps: {}, custom_steps: many })).toContain(`at most ${CUSTOM_STEPS_MAX}`);
});

test("a whole engine's changes have a ceiling the phone's route shares", () => {
  const long = (char: string) => char.repeat(50_000);
  // Two System sections at their longest and every step at its longest still fit.
  const steps = Array.from({ length: CUSTOM_STEPS_MAX }, (_, index) => ({ ...lint, id: `u_step${String(index).padStart(6, "0")}`,
    name: "n".repeat(40), run: { kind: "model", prompt: "p".repeat(4000) } }));
  const diff = validatePlaybookDiff({ steps: {}, system: { zh: long("中"), en: long("e") }, custom_steps: steps }, "general");
  expect(JSON.stringify(diff).length).toBeLessThanOrEqual(PLAYBOOK_DIFF_MAX);
});

test("a step about hand-overs does not run where there are no jobs, and keeps what you set", () => {
  const diff = validatePlaybookDiff({ steps: {}, custom_steps: [noEnv, ffprobe] }, "plain");
  const views = customStepViews(diff, resolvePlaybook("plain", diff));
  expect(views.map((view) => [view.id, view.running])).toEqual([["u_noenvfile01", true], ["u_ffprobe0001", false]]);
  expect(views[1]!.run).toEqual(ffprobe.run);
  expect(customStepRuns({ ...noEnv, on: false }, true)).toBe(false);
  // The steps an engine of the app's runs are what they were: steps of your own add, they replace nothing.
  for (const id of BUILTIN_PLAYBOOK_IDS) {
    const withSteps = resolvePlaybook(id, { v: 1, steps: {}, custom_steps: [noEnv] });
    for (const step of PLAYBOOK_STEP_IDS) expect(withSteps[step]).toEqual(builtinPlaybook(id)[step]);
  }
});
