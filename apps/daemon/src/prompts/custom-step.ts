/**
 * The prompt a step of your own reads your words in (ADR 0105). The words are yours, per step, and
 * go in the request beside what happened; this is the frame around them, one for every such step,
 * editable as the app's other calls are, with its answer shape locked: the app reads `pass` and
 * `reason` and does the rest itself.
 */
import { extractJsonObject } from "../route-agent";
import { fill } from "./fill";

export function customStepTemplate(locale: "zh" | "en"): string {
  if (locale === "en") {
    return [
      "You hold one gate for the user. In this conversation's engine they hung a step of their own and wrote a rule for it; the request carries that rule and what just happened (a call a Bot is making or made, a turn's closing reply, or files handed in).",
      "Judge only whether what happened keeps the rule. Do not judge the rule, and do not do the Bot's work. When you see nothing that breaks it, it passes. When it does not pass, give the reason in one or two sentences the Bot can act on.",
      "{format}",
    ].join("\n");
  }
  return [
    "你替用户把一道关：用户在这个会话的引擎里挂了一个自己的环节，写了一条规矩。请求里有这条规矩，和刚发生的事（Bot 正要做或刚做完的一次调用、一轮的收尾回复，或交上来的文件）。",
    "只判断这件事守没守这条规矩，不评价规矩本身，也不替 Bot 干活。看不出违反就算过。不过时，理由写成一两句 Bot 照着能改的话。",
    "{format}",
  ].join("\n");
}

export function customStepFormat(locale: "zh" | "en"): string {
  return locale === "en"
    ? 'Answer with exactly one JSON object and nothing else: {"pass": true or false, "reason": "why it does not pass; an empty string when it does"}'
    : '只回答一个 JSON 对象，不要别的文字：{"pass": true 或 false, "reason": "不过的理由；过了就写空字符串"}';
}

export function customStepSystem(locale: "zh" | "en"): string {
  return fill(customStepTemplate(locale), { format: customStepFormat(locale) });
}

/** What the model is shown: your rule, and what happened, as one JSON object. */
export function customStepPayload(input: { rule: string; moment: string; happened: Record<string, unknown> }): string {
  return JSON.stringify({ rule: input.rule, moment: input.moment, ...input.happened });
}

/** The answer read: pass or not, and why; null when it is not one. */
export function parseCustomStepAnswer(raw: string): { pass: boolean; reason: string } | null {
  const value = extractJsonObject(raw);
  if (!value || typeof value.pass !== "boolean") return null;
  const reason = typeof value.reason === "string" ? value.reason.trim().slice(0, 600) : "";
  return { pass: value.pass, reason };
}
