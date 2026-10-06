/**
 * The narrowed reflection's prompt (ADR 0051): the Bot that approved what you overturned, or whose
 * part got stuck at the capability ceiling, reads what happened to the ticket and answers with one
 * JSON object — a checklist item for itself, a check for the ticket, or nothing. No memory, no
 * detector code: the app turns the answer into a card, and only your 采用 makes it hold.
 */
import type { DueReflection } from "../store/reflection";
import { fill } from "./fill";

function reflectionText(locale: "zh" | "en"): string {
  if (locale === "en") {
    return [
      "You are looking back at one ticket of yours that went wrong, to keep it from happening again.",
      "Read what happened (the work log, the requirements in force, the review verdicts) and answer with exactly one JSON object, nothing else:",
      '- {"kind":"checklist","hook":"before_review"|"before_submit"|"before_generate","text":"…"}: one thing you will check yourself at that moment from now on, concrete and short (under 80 characters), about what actually went wrong here.',
      '- {"kind":"check","check_kind":"exists"|"contains"|"matches","item":"…","path":"…","pattern":"…"}: a check the app can run on the ticket\'s files itself — a path relative to the workspace, and a literal (contains) or a regex (matches). Only when it can be checked mechanically on a file.',
      '- {"kind":"none","reason":"…"}: when nothing general can be learned (a matter of taste, a one-off, the request changed).',
      "Prefer none to a vague item. Never propose to switch models, to try harder, or anything the user would have to do.",
    ].join("\n");
  }
  return [
    "你在回看自己出了问题的一张任务，目的是下次别再出同样的问题。",
    "读这件事的经过（工作日志、仍然有效的要求、审查结论），只回答一个 JSON 对象，不要别的：",
    '- {"kind":"checklist","hook":"before_review"|"before_submit"|"before_generate","text":"…"}：以后到这个时机你自己要检查的一件事，具体、简短（80 字以内），针对这次实际出错的地方。',
    '- {"kind":"check","check_kind":"exists"|"contains"|"matches","item":"…","path":"…","pattern":"…"}：应用能自己在任务文件上跑的检查——工作区相对路径，contains 用字面量、matches 用正则。只在能对某个文件机械检查时才提。',
    '- {"kind":"none","reason":"…"}：学不到可推广的东西时（口味问题、一次性的、要求变了）。',
    "宁可 none，也不要含糊的条目。不要提议换模型、更用心，或任何要用户去做的事。",
  ].join("\n");
}

/** The three answer shapes, one per line; the parser reads them, so they stay fixed (ADR 0064). */
function reflectionLines(locale: "zh" | "en"): { lines: string[]; from: number; to: number } {
  const lines = reflectionText(locale).split("\n");
  const from = lines.findIndex((line) => line.startsWith('- {"kind":"checklist"'));
  const to = lines.findIndex((line) => line.startsWith('- {"kind":"none"')) + 1;
  return { lines, from, to };
}

export function reflectionFormat(locale: "zh" | "en"): string {
  const { lines, from, to } = reflectionLines(locale);
  return lines.slice(from, to).join("\n");
}

/** The editable part of the reflection's prompt, with `{format}` where its answer shapes go. */
export function reflectionTemplate(locale: "zh" | "en"): string {
  const { lines, from, to } = reflectionLines(locale);
  return [...lines.slice(0, from), "{format}", ...lines.slice(to)].join("\n");
}

export function reflectionSystem(locale: "zh" | "en"): string {
  return fill(reflectionTemplate(locale), { format: reflectionFormat(locale) });
}

export function reflectionPayload(due: DueReflection): string {
  return JSON.stringify({
    what_happened: due.event === "review_miss" ? "you approved this ticket's hand-over and the user overturned it" : "this ticket's part got stuck at the capability ceiling",
    plan: due.planTitle,
    ticket: due.ticketTitle,
    ticket_dir: due.ticketDir,
    user_said: due.quote,
    requirements: due.requirements,
    review_verdicts: due.verdicts,
    work_log: due.log,
  });
}
