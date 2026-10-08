/**
 * The built-in prompt `call.compact` (ADR 0068): what the turn's own model is told when it condenses
 * the older part of a long turn's loop into a summary. The answer is read as plain text and handed
 * back to the Bot inside a fixed note (compaction.ts), so there is no answer format to lock: the
 * whole text is yours to edit (ADR 0064).
 */
import type { Locale } from "@real-bot/protocol";

export const COMPACT_TEMPLATE: Record<Locale, string> = {
  zh: [
    "你在替一个正在干活的 Bot 压缩它这一轮的工作记录。它的上下文快装不下了：下面这段记录（它说的话、调用的工具、工具返回的结果、中途收到的提示和消息）会被你写的摘要替换，之后它只看得到摘要，看不到原文。",
    "",
    "写一份让它能无缝接着做的摘要，分这几段：",
    "1. 目标：这一轮要做成什么，按起因和中途收到的话。",
    "2. 已完成：做完的事和得出的结论。起因要收集或核对的东西（比如每个文件里的某一项），读到几项就照原样逐项记下几项，一项不漏。之后还要用的文件路径、命令、数字、ID、网址、报错原文，也照原样写出来。",
    "3. 文件：建过、改过、删过哪些文件，每个一句话说改了什么。",
    "4. 走不通的路：试过但失败的做法和原因，免得再试一遍。",
    "5. 别人的话：用户或其他成员在这一轮中途说的话，照原文写。",
    "6. 现状：现在做到哪一步，下一步打算做什么。",
    "",
    "记录里有「之前压缩的摘要」时，把它的内容并进来，不要丢。只写记录里有的，不要编，不要评价。用要点，不寒暄，不超过 1500 字。",
  ].join("\n"),
  en: [
    "You are condensing the work record of a Bot that is in the middle of a turn. Its context is nearly full: the record below (what it said, the tools it called, what they returned, the notes and messages it received along the way) will be replaced by your summary, and from then on it sees only the summary, never the original.",
    "",
    "Write a summary it can carry on from without a gap, in these parts:",
    "1. Goal: what this turn is meant to achieve, from what started it and what was said along the way.",
    "2. Done: what has been done and what was found. Whatever the turn was asked to collect or check (one item from each file, say), write down every item found so far, exactly, leaving none out. Write out exactly any file paths, commands, numbers, IDs, URLs and error text it will still need, too.",
    "3. Files: every file created, changed or deleted, with one line on what changed.",
    "4. Dead ends: approaches that were tried and failed, and why, so they are not tried again.",
    "5. What others said: anything the user or another member said during this turn, word for word.",
    "6. Where it stands: how far the work has got and what it means to do next.",
    "",
    "If the record holds an earlier summary, fold its content in; do not drop it. Write only what the record shows: do not invent or judge. Use bullet points, no pleasantries, at most about 1,000 words.",
  ].join("\n"),
};
