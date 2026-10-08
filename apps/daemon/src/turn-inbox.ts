/**
 * What a live turn hears while it works, and what it carries across a redirect.
 *
 * A Bot mid-task that another Bot names, or that its own check-back comes due for, used to have
 * its turn ended and a new one opened on that line — with an empty tool loop. On 2026-09-26 a
 * frontend engineer lost three runs that way (41 tool calls and 19 files in one of them) to
 * teammates' "the API is ready, @frontend" and never delivered. Now such a line goes into the
 * live turn's inbox and is read out at the start of its next hop, the way a person at a desk
 * hears a colleague without dropping what they are holding. Your own message still turns the Bot
 * around (a group has no Stop); what the old turn had done then comes along as the new turn's
 * first note, so it does not start from nothing.
 */
import type { Locale } from "@real-bot/protocol";
import type { ChatMessage } from "./completions";
import { takeCodePoints } from "./text";
import { toolTargetOf } from "./tool-activity";

/** One line a live turn has not read yet. */
export type HeardItem = {
  /** The speaker's display name; a check-back is the Bot's own note. */
  author: string;
  body: string;
  checkBack: boolean;
  /** The line's plan and ticket when they are not the hearing turn's (`〔规划「…」· 任务 03〕`). */
  tag?: string;
  /** Where it was said, when that is not the hearing turn's session. */
  where?: string;
};

/** How much of each heard line goes into the note; the whole line is in the transcript anyway. */
export const HEARD_BODY_MAX = 1500;
/** Files and tool calls a redirect carries over, newest last. */
export const CARRY_FILES_MAX = 20;
export const CARRY_CALLS_MAX = 6;
const SHELL_COMMAND_MAX = 120;

function clip(text: string, max: number): string {
  const cut = takeCodePoints(text.trim(), max);
  return cut.truncated ? `${cut.text}…` : cut.text;
}

/** One heard line: who said it and where, which plan and ticket it is about, and what it said. */
function heardLine(item: HeardItem, en: boolean): string {
  const tag = item.tag ?? "";
  const body = clip(item.body, HEARD_BODY_MAX);
  if (item.checkBack) return en ? `[Your check-back] ${tag}${body}` : `【你约的回看】${tag}${body}`;
  const where = item.where ? (en ? `, in ${item.where}` : `，在${item.where}里`) : "";
  return `【${item.author}${where}】${tag}${body}`;
}

/**
 * The user line the loop gets at the start of the hop after something was heard. It says the
 * turn goes on, and that an answer can wait for the turn's own hand-over: a reply sent now would
 * end the turn and drop the work in hand.
 */
/** One heard line as the note names it, with its inbox id when the row has one (`[U12 …]`). */
function heardEntry(item: HeardItem, en: boolean, label?: string): string {
  const line = heardLine(item, en);
  return label ? line.replace(/^【/, `[${label} `).replace("】", "] ") : line;
}

/**
 * The user line the loop gets at the start of the hop after something was heard, and between tool
 * calls when a line of yours arrived mid-hop. It names each line by its inbox id, and asks the Bot
 * to say what it did with each one in `end_turn`.
 */
export function heardNote(locale: Locale, items: readonly (HeardItem & { label?: string })[], opts: { cut?: boolean } = {}): string {
  const en = locale === "en";
  const lines = items.map((item) => heardEntry(item, en, item.label));
  const deal = en
    ? "Say what you did with each line of the user's, by its id, in end_turn's inbox: adopted, answered, declined (say why), or deferred."
    : "用户的话逐条处置：照改 / 已回答 / 不采纳并说明理由（写进 end_turn 的 inbox，带上每条的 id）。";
  // 直接插入 (ADR 0069): the step it was on was stopped for these, so say so — it just saw its call
  // refused "by the user", which is not a no to the work.
  if (en) {
    return [
      opts.cut
        ? `(App note) ${items.length} line${items.length === 1 ? "" : "s"} came in, and the user asked for them to be read now: the step you were on was stopped for that, not refused. A command that was running did not finish; run it again if you still need it.`
        : `(App note) ${items.length} line${items.length === 1 ? "" : "s"} came in. This turn was not interrupted.`,
      ...lines,
      deal,
    ].join("\n");
  }
  return [
    opts.cut
      ? `（应用提示）收件 ${items.length} 条，用户要你马上读：刚才那一步是为这个停下的，不是用户拒绝了它。正在跑的命令没跑完，还需要的话重跑。`
      : `（应用提示）收件 ${items.length} 条（这一段没有被打断）：`,
    ...lines,
    deal,
  ].join("\n");
}

/** `shell npm run build`, `write_file src/App.tsx`: the last few tool calls a loop made. */
export function recentToolCalls(loop: readonly ChatMessage[], limit = CARRY_CALLS_MAX): string[] {
  const out: string[] = [];
  for (let i = loop.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const entry = loop[i]!;
    if (entry.role !== "assistant" || !entry.tool_calls) continue;
    for (let j = entry.tool_calls.length - 1; j >= 0 && out.length < limit; j -= 1) {
      const call = entry.tool_calls[j]!;
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        args = {};
      }
      // A command is what says what a shell was doing; the watcher's target leaves it out.
      const command = call.name === "shell" && typeof args.command === "string" ? args.command.split("\n")[0]!.trim() : "";
      const target = command ? clip(command, SHELL_COMMAND_MAX) : toolTargetOf(call.name, args);
      out.push(target ? `${call.name} ${target}` : call.name);
    }
  }
  return out.reverse();
}

/**
 * The first note of a turn opened by redirecting another: what the old one had written, what it
 * was last doing and what it had not read yet. Null when it had done nothing worth carrying.
 */
export function redirectCarryNote(
  locale: Locale,
  input: {
    written: readonly string[];
    recent: readonly string[];
    unread: readonly HeardItem[];
    /** The old turn's plan and ticket when the new one is on another (`〔规划「…」· 任务 02〕`). */
    previous?: string;
  },
): string | null {
  const written = input.written.slice(-CARRY_FILES_MAX);
  if (written.length === 0 && input.recent.length === 0 && input.unread.length === 0) return null;
  const en = locale === "en";
  const parts: string[] = [];
  if (en) {
    parts.push("(App note) Your previous turn was redirected by the message above; what it had done is still there.");
    if (input.previous) parts.push(`It was working on ${input.previous}.`);
    if (written.length > 0) parts.push(`Files it wrote: ${written.join(", ")}`);
    if (input.recent.length > 0) parts.push(`Last things it did: ${input.recent.join("; ")}`);
    for (const item of input.unread) parts.push(`Not read yet — ${heardLine(item, true)}`);
    parts.push("Look at these before deciding whether to carry on or turn to the new message.");
  } else {
    parts.push("（应用提示）你上一轮被上面这条新消息改道了，它做过的东西都还在。");
    if (input.previous) parts.push(`它在做的是${input.previous}。`);
    if (written.length > 0) parts.push(`写过的文件：${written.join("、")}`);
    if (input.recent.length > 0) parts.push(`最后在做：${input.recent.join("；")}`);
    for (const item of input.unread) parts.push(`还没读到的——${heardLine(item, false)}`);
    parts.push("先看一眼这些，再决定是接着做，还是按新消息转向。");
  }
  return parts.join("\n");
}
