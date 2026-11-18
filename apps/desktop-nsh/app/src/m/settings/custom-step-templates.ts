/**
 * Where a step of your own starts (ADR 0105): five templates from how the app is used, and a blank
 * one. Each is a draft until saved, and starts switched off, so nothing bites before it is read.
 */
import { CUSTOM_STEP_ATS, CUSTOM_STEP_THENS_AT, type CustomStep, type CustomStepAt, type PlaybookHook } from "@real-bot/protocol";
import { hookOfMoment } from "./playbook-flow.ts";

export type CustomStepTemplateId = "env" | "lint" | "tests" | "video" | "rules";

export const CUSTOM_STEP_TEMPLATE_IDS: readonly CustomStepTemplateId[] = ["env", "lint", "tests", "video", "rules"];

/** The moment each template runs at, so the menu offers it only in that round. */
const TEMPLATE_AT: Record<CustomStepTemplateId, CustomStepAt> = {
  env: "before_effect",
  lint: "after_effect",
  tests: "turn_end",
  video: "handed_in",
  rules: "turn_end",
};

/** `u_` and 16 letters or digits. */
export function newCustomStepId(random: () => number = Math.random): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "u_";
  for (let i = 0; i < 16; i++) id += alphabet[Math.floor(random() * alphabet.length)];
  return id;
}

/** The templates that belong to a round. */
export function templatesFor(hook: PlaybookHook): CustomStepTemplateId[] {
  return CUSTOM_STEP_TEMPLATE_IDS.filter((id) => hookOfMoment(TEMPLATE_AT[id]) === hook);
}

/** The moment a blank step in a round starts at: the round's first. */
export function firstMoment(hook: PlaybookHook): CustomStepAt {
  return CUSTOM_STEP_ATS.find((at) => hookOfMoment(at) === hook) ?? "turn_end";
}

/** A template as a step, named and worded in the language given. `words` is what the template's name and model prompt are called. */
export function templateStep(id: CustomStepTemplateId, name: string, prompt: string, newId: string = newCustomStepId()): CustomStep {
  const base = { id: newId, name, on: false, at: TEMPLATE_AT[id] };
  switch (id) {
    case "env":
      return { ...base, match: { paths: ["**/.env"] }, run: { kind: "rule" }, then: "refuse" };
    case "lint":
      return { ...base, match: { tools: ["write_file"], paths: ["**/*.ts"] }, run: { kind: "command", command: "npx --no-install eslint $DESKFOLK_PATHS" }, then: "note" };
    case "tests":
      return { ...base, run: { kind: "command", command: "pnpm test", timeout_s: 600 }, then: "send_back" };
    case "video":
      return { ...base, match: { paths: ["**/*.mp4"] }, run: { kind: "command", command: 'for f in $DESKFOLK_PATHS; do ffprobe -v error "$f" || exit 1; done' }, then: "gate" };
    case "rules":
      return { ...base, run: { kind: "model", prompt }, then: "send_back" };
  }
}

/** A blank step: the round's first moment, judging by a command not yet written (it is not saved until it is). */
export function blankStep(hook: PlaybookHook, name: string, newId: string = newCustomStepId()): CustomStep {
  const at = firstMoment(hook);
  return { id: newId, name, on: false, at, run: { kind: "command", command: "" }, then: CUSTOM_STEP_THENS_AT[at][0]! };
}
