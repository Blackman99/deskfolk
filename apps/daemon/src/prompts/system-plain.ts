import type { EngineToolKind, Locale } from "@real-bot/protocol";
import type { ToolShellKind } from "../platform";
import { systemText } from "./system";

/**
 * The System section for a conversation whose engine works in no jobs (ADR 0103): the one every
 * other Bot reads, with what only holds in a job taken out or said for this case. Built from that
 * text rather than copied, so what the two share stays one text, and starting from level 0, which
 * names no delegation, hand-over or end contract. `system-plain.test.ts` holds every edit to the
 * words it edits, so a change to the shared text cannot quietly leave a job's rule in here.
 */
export type PlainSystemEdits = {
  /** A whole paragraph, found by how it starts, said for this case; a paragraph's own rule goes with it. */
  paragraphs: ReadonlyArray<readonly [startsWith: string, replacement: string]>;
  /** A clause inside a paragraph that otherwise holds here too. */
  clauses: ReadonlyArray<readonly [from: string, to: string]>;
};

export const PLAIN_SYSTEM_EDITS: Record<Locale, PlainSystemEdits> = {
  zh: {
    paragraphs: [
      ["壳默认在本轮的任务目录里", "壳默认在工作区根：`shell` 省略 `cwd` 就在那里跑，`read_file` / `write_file` / `delete_file` / `list_dir` 的路径也相对工作区根。用户点名了路径就写到那里；没点名时给这件活挑个子目录，不要把文件散在根上，也不要写到 `/tmp` 这类工作区外的目录：工作区是所有 Bot 的产出集中放的地方。"],
      ["你干活时有人找你", "你干活时有人找你，会在回路里出现一行「（应用提示）收件 N 条」：读了照着调整手上的活。"],
      ["交接出去、或在等一个不由你掌控的结果时", "在等一个不由你掌控的结果时，用 check_back 约自己稍后在本会话回看：写清多少分钟后、回看时要核对什么、没动静该怎么办。到点你会被一条「回看：…」的系统行叫醒。一个会话里同时只有一次待回看，再约就是替换；不要为了等而每几分钟约一次。你开的 Bot↔Bot 私聊静下来后，应用也会用一条回看在开它的那个会话把你叫回来：先在那里交代私聊的结果，再接着推进。"],
      ["局面块里的「规划」是应用整理出来的这件事", "要求里没说清、且猜错会白做的（交付形态、范围、给谁看），用 ask_user 问一个问题，把可能的答案列成选项、推荐的放第一个；能给合理默认值的，把假设写在第一条消息里然后继续做，不要闷头猜，也不要事事都问。"],
    ],
    clauses: [
      ["路径相对工作区根，而 shell 不传 cwd 时在本轮工作目录里跑——要用命令或脚本读它就给 shell 传 `cwd: \".\"`。", "路径相对工作区根。"],
      ["send_message 会结束本轮，不调工具的回复也一样：", "你给用户的回复，就是最后一步不调用任何工具时写的文字：写完就发出，并结束本段。和工具调用写在同一步的文字（写在 end_turn 旁边的也一样）只在你干活时显示，不会发出。send_message 只发进度，不结束本段。对这两者："],
      ["；应用会拿实际跑过的命令核对你的收尾。", "。"],
      ["；用户的要求留在需求台账，不写进提示词。", "。"],
      ["别人的行在【名字】后面带着〔规划「…」· 任务 NN〕或〔任务 NN〕时，那一行说的是另一件事或另一个任务，不是这一轮要做的；不带就是这一轮这件事的。这种标注是应用加的，不要写进你自己的消息。", ""],
    ],
  },
  en: {
    paragraphs: [
      ["The shell defaults to this turn's ticket dir", "The shell starts at the workspace root: a `shell` without `cwd` runs there, and `read_file` / `write_file` / `delete_file` / `list_dir` paths are relative to it too. When the user names a path, write exactly there; otherwise give the work a subfolder of its own rather than scattering files at the root, and not `/tmp` or anywhere else outside the workspace: the workspace is where every Bot's work is kept together."],
      ["When someone speaks to you while you work", "When someone speaks to you while you work, a line \"(App note) N lines came in\" appears in the loop: read them and adjust the work in hand."],
      ["After a handoff, or while waiting for a result you do not control", "While waiting for a result you do not control, use check_back to book yourself a later look in this session: say how many minutes, what to verify then, and what to do if nothing has moved. When it is due, a system line \"Check-back: …\" wakes you. One pending check-back per session; booking another replaces it. Do not book one every few minutes just to wait. When a Bot↔Bot direct you opened goes quiet, the app wakes you with a check-back in the session you opened it from: report there how it came out, then carry on."],
      ["\"Plan\" in the situation block is the app's reading of this job", "When a request leaves open something a wrong guess would waste the work on (the deliverable's form, its scope, its audience), ask_user one question with the likely answers as options, the recommended one first; if a sensible default exists, state the assumption in your first message and keep going. Neither guess blindly nor ask about everything."],
    ],
    clauses: [
      ["relative to the workspace root, while a shell without `cwd` runs in this turn's work dir — pass `cwd: \".\"` when a command or script has to resolve that path.", "relative to the workspace root."],
      ["send_message ends this turn, and so does a reply without tool calls:", "Your reply to the user is the text of your last step, the one that calls no tool: it goes out when you write it, and ends the segment. Text written in the same step as tool calls (beside end_turn too) is only shown while you work and is never sent. send_message posts progress without ending the segment. For both:"],
      ["; the app holds your closing against the commands actually run.", "."],
      ["; the user's requirements stay in the requirements ledger, never in a prompt.", "."],
      ["When someone else's line carries 〔plan \"…\" · ticket NN〕 or 〔ticket NN〕 after the name, it is about another job or another ticket, not what this turn is for; a line without one belongs to this job. The app adds these tags; never write them into your own messages. ", ""],
    ],
  },
};

/** What the System section says of a hand-over nobody reviews, and what it says where the engine does not wait on the user's word for it (ADR 0103). */
export const NO_WAIT_EDITS: Record<Locale, readonly [from: string, to: string]> = {
  zh: ["没人审、也没有用户的检查撑着的交付等用户的话：他认可或接着往下说就算通过，挑出毛病就退回。", "没人审的交付，门禁过了就直接通过；用户挑出毛病就退回。"],
  en: ["What nobody reviews and no check of the user's backs waits on the user's word: a nod, or going on from it, approves it; a fault they find sends it back.", "What nobody reviews is approved once its gates pass; a fault the user finds sends it back."],
};

/**
 * The paragraphs that tell a Bot about a group of tools, gone where its engine leaves that group out
 * (ADR 0103). The groups not listed have none of their own.
 */
export const TOOL_KIND_PARAGRAPHS: Partial<Record<EngineToolKind, Record<Locale, string>>> = {
  setup: { zh: "名册级端点和 MCP 所有 Bot 共用。", en: "Roster-level endpoints and MCP are shared by every Bot." },
  prompts: { zh: "每个 Bot 怎么工作写在内置提示词里", en: "How every Bot works is written in the built-in prompts" },
};

export function withoutToolKinds(text: string, off: readonly EngineToolKind[], locale: Locale): string {
  const starts = off.flatMap((kind) => TOOL_KIND_PARAGRAPHS[kind]?.[locale] ?? []);
  return starts.length === 0 ? text : text.split("\n\n").filter((paragraph) => !starts.some((start) => paragraph.startsWith(start))).join("\n\n");
}

/** What a Bot in a conversation with no jobs reads as its System section. */
export function plainSystemText(locale: Locale, shell: ToolShellKind): string {
  const { paragraphs, clauses } = PLAIN_SYSTEM_EDITS[locale];
  const text = systemText(locale, shell, 0)
    .split("\n\n")
    .map((paragraph) => paragraphs.find(([start]) => paragraph.startsWith(start))?.[1] ?? paragraph)
    .join("\n\n");
  return clauses.reduce((edited, [from, to]) => edited.replace(from, to), text);
}
