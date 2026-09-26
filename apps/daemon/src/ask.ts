import {
  ASK_CUSTOM_MAX,
  ASK_DESCRIPTION_MAX,
  ASK_LABEL_MAX,
  ASK_OPTIONS_MAX,
  ASK_OPTIONS_MIN,
  type AskAnswer,
  type AskOption,
  type AskSpec,
  type Message,
} from "@real-bot/protocol";
import { HttpError } from "./errors";

function codePoints(text: string): number {
  return [...text].length;
}

function invalid(message: string): never {
  throw new HttpError(422, "invalid_args", message);
}

/**
 * The choices an `ask_user` call offers. No options is a plain question. A bare string is taken
 * as a label, since models write them that way as often as not; anything that would render as an
 * unclear choice (blank, duplicate, overlong) is sent back for the Bot to rewrite, not trimmed.
 */
export function parseAskSpec(options: unknown, multiSelect: unknown): AskSpec | null {
  if (options === undefined || options === null) return null;
  if (!Array.isArray(options)) invalid("options must be an array");
  if (options.length === 0) return null;
  if (options.length < ASK_OPTIONS_MIN || options.length > ASK_OPTIONS_MAX) {
    invalid(`options needs ${ASK_OPTIONS_MIN} to ${ASK_OPTIONS_MAX} items; leave it out for an open question`);
  }
  const seen = new Set<string>();
  const parsed: AskOption[] = options.map((item, index) => {
    const raw = typeof item === "string" ? { label: item } : item;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(`options[${index}] must be { label, description? }`);
    const { label, description } = raw as { label?: unknown; description?: unknown };
    if (typeof label !== "string" || !label.trim()) invalid(`options[${index}].label is required`);
    const text = label.trim();
    if (codePoints(text) > ASK_LABEL_MAX) invalid(`options[${index}].label is longer than ${ASK_LABEL_MAX} characters; move detail into description`);
    if (seen.has(text)) invalid(`options[${index}].label repeats "${text}"; labels must differ`);
    seen.add(text);
    if (description === undefined || description === null) return { label: text };
    if (typeof description !== "string") invalid(`options[${index}].description must be a string`);
    const note = description.trim();
    if (codePoints(note) > ASK_DESCRIPTION_MAX) invalid(`options[${index}].description is longer than ${ASK_DESCRIPTION_MAX} characters`);
    return note ? { label: text, description: note } : { label: text };
  });
  return { options: parsed, multi_select: multiSelect === true || multiSelect === "true" };
}

/**
 * Your answer to a question, checked against what it offered. Choices come back in the order the
 * question lists them; single-select takes one at most. Text of your own is always allowed, beside
 * the choices or instead of them, and an answer has to carry at least one of the two.
 */
export function parseAskAnswer(spec: AskSpec | null, selected: unknown, custom: unknown, answeredAt: string): AskAnswer {
  if (selected !== undefined && selected !== null && !Array.isArray(selected)) invalid("selected must be an array of labels");
  const picks = (selected ?? []) as unknown[];
  if (picks.some((label) => typeof label !== "string")) invalid("selected must be an array of labels");
  if (custom !== undefined && custom !== null && typeof custom !== "string") invalid("custom must be a string");
  const text = typeof custom === "string" ? custom.trim() : "";
  if (codePoints(text) > ASK_CUSTOM_MAX) invalid(`custom is longer than ${ASK_CUSTOM_MAX} characters`);
  const labels = spec?.options.map((option) => option.label) ?? [];
  const chosen = new Set(picks as string[]);
  for (const label of chosen) {
    if (!labels.includes(label)) invalid(`"${label}" is not one of this question's options`);
  }
  if (!spec?.multi_select && chosen.size > 1) invalid("this question takes one option");
  if (chosen.size === 0 && !text) invalid("pick an option or write an answer");
  return {
    selected: labels.filter((label) => chosen.has(label)),
    custom: text || null,
    answered_at: answeredAt,
  };
}

/** The answer as one line of text: what a Bot reads as `answer`, and what search looks through. */
export function askAnswerText(answer: AskAnswer): string {
  return [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join("\n");
}

/** The stored column, read back. A row that does not parse reads as no choices. */
export function readAskSpec(raw: string | null | undefined): AskSpec | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as AskSpec;
    return Array.isArray(value?.options) ? { options: value.options, multi_select: Boolean(value.multi_select) } : null;
  } catch {
    return null;
  }
}

export function readAskAnswer(raw: string | null | undefined): AskAnswer | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as AskAnswer;
    if (!Array.isArray(value?.selected) || typeof value.answered_at !== "string") return null;
    return { selected: value.selected, custom: typeof value.custom === "string" ? value.custom : null, answered_at: value.answered_at };
  } catch {
    return null;
  }
}

/**
 * A question as a transcript line: the question, the choices it offered, and what you answered.
 * Your answer lives on the question rather than as a line of yours, so this is where every later
 * reader — the Bots' transcript, the organizer — learns what you decided.
 */
export function askTranscriptText(message: Pick<Message, "body" | "ask" | "ask_answer">, body = message.body): string {
  const lines = [body];
  const spec = message.ask;
  if (spec && spec.options.length > 0) {
    const choices = spec.options
      .map((option) => (option.description ? `${option.label}（${option.description}）` : option.label))
      .join(" / ");
    lines.push(`${spec.multi_select ? "选项（可多选）" : "选项（单选）"}：${choices}`);
  }
  const answer = message.ask_answer;
  if (answer) {
    if (answer.selected.length > 0) lines.push(`用户选了：${answer.selected.join("、")}`);
    if (answer.custom) lines.push(`${answer.selected.length > 0 ? "用户补充" : "用户回答"}：${answer.custom}`);
  }
  return lines.join("\n");
}
