/**
 * The panel for a step of your own on Roles (ADR 0105): changing its moment keeps the rest
 * consistent, Save sends the engine's whole difference with the step added or replaced and no field
 * the API refuses, Delete takes out that one step, Try judges the draft on a sample, and the daemon's
 * refusal is shown as it said it.
 */
import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import {
  emptyPlaybookDiff,
  resolvePlaybook,
  type CustomStep,
  type CustomStepTry,
  type Playbook,
  type PlaybookDiff,
} from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { settle } from "../test-async.ts";
import { click, fill, render } from "../test-render.ts";
import CustomStepDetail from "./CustomStepDetail.svelte";
import { diffWithout, diffWithStep, pathLines, stepProblem, withMoment, withTool } from "./custom-step-form.ts";
import { blankStep, newCustomStepId, templateStep, templatesFor } from "./custom-step-templates.ts";

const t = copyFor("zh");
const c = t.playbooks.own;

const lint: CustomStep = {
  id: "u_lintlint01",
  name: "拦 .env",
  on: true,
  at: "before_effect",
  match: { tools: ["write_file", "shell"], paths: ["**/.env"] },
  run: { kind: "rule" },
  then: "refuse",
};
const tests: CustomStep = { id: "u_tests00002", name: "跑测试", on: true, at: "turn_end", run: { kind: "command", command: "pnpm test" }, then: "send_back" };

function engine(own: CustomStep[] = []): Playbook {
  const diff: PlaybookDiff = { ...emptyPlaybookDiff(), ...(own.length > 0 ? { custom_steps: own } : {}) };
  return {
    id: "general", builtin: true, base_id: "general", name: null, revision: 1, revision_id: "rev-1",
    diff, resolved: resolvePlaybook("general", diff), updated_at: null,
    custom_steps: own.map((step) => ({ ...step, running: true })),
  };
}

function open(step: CustomStep, over: { draft?: boolean; own?: CustomStep[]; api?: unknown; message?: string | null; save?: (diff: PlaybookDiff) => Promise<unknown> } = {}) {
  const saved: PlaybookDiff[] = [];
  const done: string[] = [];
  const view = render(CustomStepDetail, {
    step,
    draft: over.draft ?? false,
    running: true,
    playbook: engine(over.own ?? (over.draft ? [] : [step])),
    engineName: "通用",
    api: (over.api ?? null) as never,
    onsave: over.save ?? (async (diff: PlaybookDiff) => {
      saved.push(diff);
      return {};
    }),
    ondone: (what: string) => done.push(what),
    oncancel: () => done.push("cancelled"),
    saving: false,
    error: null,
    message: over.message ?? null,
    t,
  });
  return { view, saved, done, q: <E extends Element = HTMLElement>(sel: string) => view.host.querySelector<E>(sel) };
}

/** The Select whose trigger carries this name: open it, press the option with this label. */
function choose(host: HTMLElement, name: string, label: string): void {
  click(host.querySelector(`[role="combobox"][aria-label="${name}"]`));
  const option = [...host.querySelectorAll('[role="option"]')].find((one) => one.textContent?.includes(label));
  if (!option) throw new Error(`no option ${label}`);
  click(option);
}

test("another moment resets the 'no' it does not allow and drops the tools off a call", () => {
  const moved = withMoment(lint, "turn_end");
  expect(moved.then).toBe("send_back");
  expect(moved.match).toEqual({ paths: ["**/.env"] });
  expect(withMoment({ ...lint, match: { tools: ["shell"] } }, "handed_in").match).toBeUndefined();
  // A 'no' that the new moment allows stays; a command's time is held to the range.
  expect(withMoment({ ...lint, then: "note" }, "after_effect").then).toBe("note");
  const slow = withMoment({ ...tests, run: { kind: "command", command: "x", timeout_s: 500 } }, "before_effect");
  expect(slow.run).toEqual({ kind: "command", command: "x", timeout_s: 60 });
  expect(withTool(lint, "write_file", false).match?.tools).toEqual(["shell"]);
  expect(withTool({ ...lint, match: { tools: ["shell"] } }, "shell", false).match).toBeUndefined();
});

test("choosing another moment in the panel resets the 'no' and the tools boxes go; Save sends the step without tools", async () => {
  const { view, saved, q } = open(lint);
  expect(q('[data-custom-tool="write_file"]')).not.toBeNull();
  choose(view.host, c.moment, c.moments.turn_end);
  expect(q("[data-custom-tool]")).toBeNull();
  expect(q("[data-custom-then-hint]")?.textContent).toBe(c.thenHints.send_back);
  expect(q("[data-custom-before-note]")).toBeNull();
  click(q("[data-custom-save]"));
  await settle();
  expect(saved).toHaveLength(1);
  expect(saved[0]!.custom_steps).toEqual([{ ...lint, at: "turn_end", then: "send_back", match: { paths: ["**/.env"] } }]);
  view.close();
});

test("a draft is added at the end on Save, as the step stands, with nothing the API would refuse", async () => {
  const draft = blankStep("turn", c.blankName, "u_draft000001");
  const { view, saved, done, q } = open(draft, { draft: true, own: [tests] });
  fill(q("[data-custom-name]"), "  量一下  ");
  fill(q("[data-custom-command]"), "echo hi");
  fill(q("[data-custom-folder]"), "");
  fill(q("[data-custom-paths]"), "src/**/*.ts\n\n  docs/*.md  \n");
  click(q("[data-custom-save]"));
  await settle();
  expect(saved).toHaveLength(1);
  const sent = saved[0]!.custom_steps!;
  expect(sent).toHaveLength(2);
  // The others stay as they were, ahead of it; no `running`, no empty folder.
  expect(sent[0]).toEqual(tests);
  expect(sent[1]).toEqual({
    id: "u_draft000001", name: "量一下", on: false, at: "before_effect",
    match: { paths: ["src/**/*.ts", "docs/*.md"] }, run: { kind: "command", command: "echo hi" }, then: "refuse",
  });
  expect(done).toEqual(["saved"]);
  view.close();
});

test("a draft with nothing written is not sent: the first plain mistake is said", async () => {
  const { view, saved, q } = open(blankStep("turn", c.blankName, "u_draft000002"), { draft: true });
  click(q("[data-custom-save]"));
  await settle();
  expect(saved).toHaveLength(0);
  expect(q("[data-custom-error]")?.textContent).toBe(c.problems.command);
  // A rule with nothing to match is not sent either.
  expect(stepProblem({ ...lint, match: undefined })).toBe("rule_empty");
  expect(stepProblem({ ...lint, match: { paths: ["../x"] } })).toBe("path_bad");
  expect(stepProblem({ ...tests, run: { kind: "command", command: "x", timeout_s: 9999 } })).toBe("timeout");
  expect(stepProblem(lint)).toBeNull();
  view.close();
});

test("the daemon's refusal is shown as it said it", async () => {
  const { view, q } = open(tests, { message: "diff.custom_steps[0].run.command must be text", save: async () => null });
  click(q("[data-custom-save]"));
  await settle();
  expect(q("[data-custom-error]")?.textContent).toBe(c.rejected("diff.custom_steps[0].run.command must be text"));
  view.close();
});

test("Delete asks first, then takes out only that step", async () => {
  const { view, saved, done, q } = open(lint, { own: [lint, tests] });
  click(q("[data-custom-delete]"));
  await settle();
  expect(saved).toHaveLength(0);
  const confirm = view.host.ownerDocument.querySelector<HTMLElement>("dialog .deny");
  expect(confirm).not.toBeNull();
  click(confirm);
  await settle();
  expect(saved).toHaveLength(1);
  expect(saved[0]!.custom_steps).toEqual([tests]);
  expect(done).toEqual(["deleted"]);
  // The last one out takes the field with it.
  expect(diffWithout({ ...emptyPlaybookDiff(), custom_steps: [tests] }, [tests], tests.id).custom_steps).toBeUndefined();
  view.close();
});

test("a saved step's switch is saved at once; a draft's waits for Save", async () => {
  const a = open(tests);
  click(a.q(".switch-track"));
  await settle();
  expect(a.saved).toHaveLength(1);
  expect(a.saved[0]!.custom_steps).toEqual([{ ...tests, on: false }]);
  a.view.close();
  const b = open(blankStep("turn", c.blankName, "u_draft000003"), { draft: true });
  click(b.q(".switch-track"));
  await settle();
  expect(b.saved).toHaveLength(0);
  b.view.close();
});

test("Try sends the draft as it stands with the sample filled in, and shows what came back", async () => {
  const asked: unknown[][] = [];
  const answer: CustomStepTry = { outcome: "fail", reason: "exit 1", exit_code: 1, output: "FAIL tests/a.test.ts", sample: { reply: "done" } };
  const api = { tryCustomStep: async (...args: unknown[]) => (asked.push(args), answer) };
  const { view, q } = open(tests, { api });
  fill(q("[data-custom-sample-reply]"), "done");
  click(q("[data-custom-try]"));
  await settle();
  expect(asked).toHaveLength(1);
  expect(asked[0]).toEqual(["general", tests, { reply: "done" }]);
  expect(q("[data-custom-result]")?.getAttribute("data-custom-result")).toBe("fail");
  expect(q("[data-custom-result]")?.textContent).toContain(c.tryOutcome.fail);
  expect(q("[data-custom-result]")?.textContent).toContain(c.tryExit(1));
  expect(q("[data-custom-result-output]")?.textContent).toBe("FAIL tests/a.test.ts");
  expect(q("[data-custom-result-sample]")?.textContent).toContain('"reply": "done"');
  view.close();
  // Nothing filled in: no sample is sent.
  const bare: unknown[][] = [];
  const other = open(tests, { api: { tryCustomStep: async (...args: unknown[]) => (bare.push(args), answer) } });
  click(other.q("[data-custom-try]"));
  await settle();
  expect(bare[0]).toEqual(["general", tests, undefined]);
  other.view.close();
});

test("the templates start switched off, in the round they belong to, with ids the API takes", () => {
  expect(templatesFor("turn")).toEqual(["env", "lint", "tests", "rules"]);
  expect(templatesFor("handed_in")).toEqual(["video"]);
  expect(templatesFor("accepted")).toEqual([]);
  for (const id of ["env", "lint", "tests", "video", "rules"] as const) {
    const step = templateStep(id, "x", "words");
    expect(step.on).toBe(false);
    expect(step.id).toMatch(/^u_[A-Za-z0-9]{16}$/);
    // Every one but the model's passes the local check as it is; the model's needs your words.
    expect(stepProblem(step)).toBeNull();
  }
  expect(newCustomStepId()).not.toBe(newCustomStepId());
  expect(blankStep("accepted", "n").at).toBe("accepted");
  expect(blankStep("accepted", "n").then).toBe("tell");
  expect(pathLines(" a \n\n b")).toEqual(["a", "b"]);
  expect(diffWithStep(emptyPlaybookDiff(), [], tests).custom_steps).toEqual([tests]);
  flushSync();
});
