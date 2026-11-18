import { expect, test } from "bun:test";
import type { PromptSummary } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import { editedCount, failuresOf, firstLocale, groupPrompts, markChanges, overallState, parsePromptCard, promptCardTarget, promptErrorText, stateChip } from "./prompts-view.ts";

const c = copyFor("zh").prompts;

function summary(id: string, group: PromptSummary["group"], states: Array<"default" | "edited" | "conflict">, locales: Array<"zh" | "en"> = ["zh", "en"]): PromptSummary {
  return {
    id, group,
    title: { zh: `标题 ${id}`, en: `Title ${id}` },
    summary: { zh: `说明 ${id}`, en: `About ${id}` },
    locales: locales.map((locale, at) => ({ locale, state: states[at] ?? "default", last_actor: states[at] === "default" ? null : "user", last_bot_id: null, updated_at: null, parse_failures: null })),
  };
}

test("prompts group with the tool descriptions last and a search matches ids, titles and summaries in either language", () => {
  const items = [summary("call.scribe", "call", ["default"], ["zh"]), summary("turn.system", "turn", ["edited"]), summary("tool.shell", "tool", [])];
  expect(groupPrompts(items, "").map((row) => row.group)).toEqual(["turn", "call", "tool"]);
  expect(groupPrompts(items, "Title call").map((row) => row.items.map((item) => item.id))).toEqual([["call.scribe"]]);
  expect(groupPrompts(items, "说明 tool.").flatMap((row) => row.items.map((item) => item.id))).toEqual(["tool.shell"]);
  expect(groupPrompts(items, "nothing")).toEqual([]);
});

test("only the edited ones, when asked, and a search narrows those further", () => {
  const items = [summary("turn.system", "turn", ["default", "edited"]), summary("turn.memory", "turn", ["default"]), summary("tool.shell", "tool", ["conflict"]), summary("call.scribe", "call", ["default"], ["zh"])];
  expect(groupPrompts(items, "", true).map((row) => row.items.map((item) => item.id))).toEqual([["turn.system"], ["tool.shell"]]);
  expect(groupPrompts(items, "shell", true).flatMap((row) => row.items.map((item) => item.id))).toEqual(["tool.shell"]);
  expect(groupPrompts(items, "memory", true)).toEqual([]);
});

test("unreadable answers count since your edit, else over the last 7 days, across languages", () => {
  const base = summary("call.seams_text", "call", ["edited", "default"]);
  base.locales[0]!.parse_failures = { since_edit: 2, last_7_days: 9 };
  base.locales[1]!.parse_failures = { since_edit: null, last_7_days: 1 };
  expect(failuresOf(base)).toBe(3);
  expect(failuresOf(summary("turn.system", "turn", ["default"]))).toBe(0);
});

test("a prompt's state is its worst language, and the tab counts edits and flags a conflict", () => {
  expect(overallState(summary("a", "turn", ["default", "edited"]))).toBe("edited");
  expect(overallState(summary("a", "turn", ["conflict", "edited"]))).toBe("conflict");
  expect(editedCount([summary("a", "turn", ["edited"]), summary("b", "turn", ["default"])])).toEqual({ edited: 1, conflict: false });
  expect(editedCount([summary("a", "turn", ["conflict"])])).toEqual({ edited: 1, conflict: true });
  expect(firstLocale(summary("x", "call", ["default"], ["zh"]), "en")).toBe("zh");
  expect(firstLocale(summary("x", "turn", ["default", "default"]), "en")).toBe("en");
});

test("a chip says who edited it", () => {
  const state = { locale: "zh" as const, state: "edited" as const, last_actor: "bot" as const, last_bot_id: "b", updated_at: null, parse_failures: null };
  expect(stateChip(state, "调优员", c)).toEqual({ tone: "edited", label: "已改 · 调优员改的" });
  expect(stateChip({ ...state, last_actor: "user" }, null, c).label).toBe("已改 · 你改的");
  expect(stateChip({ ...state, state: "conflict" }, null, c)).toEqual({ tone: "conflict", label: c.state.conflict });
});

test("a refused save is said in words from the daemon's code and detail", () => {
  expect(promptErrorText(new ApiError(422, "prompt_placeholder_missing", "prompt_placeholder_missing:{format}; prompt_too_long:9000"), c)).toBe("少了 {format}。");
  expect(promptErrorText(new ApiError(422, "prompt_brace", "prompt_brace"), c)).toBe(c.errors.prompt_brace);
  expect(promptErrorText(new ApiError(409, "changed_since", "this prompt changed after that change"), c)).toBe(c.errors.changed_since);
  expect(promptErrorText(new Error("boom"), c)).toBe(c.errors.other);
});

test("the approval card's text reads back as its head, reason and changes", () => {
  const body = [
    "改内置提示词：系统指令 · 中文",
    "理由：上周三次交付没有附命令输出",
    "@@ 第 1 处 · 替换",
    "- 旧的一句",
    "- - 叫停：一条要点",
    "+ 新的一句",
    "@@ 第 2 处 · 末尾追加",
    "+ 补一段",
    "…还有 1 处改动未显示",
  ].join("\n");
  expect(parsePromptCard(body)).toEqual({
    head: "改内置提示词：系统指令 · 中文",
    reason: "理由：上周三次交付没有附命令输出",
    reach: null,
    hunks: [
      { title: "第 1 处 · 替换", lines: [{ kind: "del", text: "旧的一句" }, { kind: "del", text: "- 叫停：一条要点" }, { kind: "add", text: "新的一句" }] },
      { title: "第 2 处 · 末尾追加", lines: [{ kind: "add", text: "补一段" }] },
    ],
    more: "…还有 1 处改动未显示",
  });
});

test("a changed line marks only the part that changed, so a lone space shows", () => {
  const marks = (lines: Array<{ kind: "same" | "del" | "add" | "gap"; text: string }>) => markChanges(lines).map((line) => line.mark ?? null);
  // A space at the end, and one in the middle of a sentence.
  expect(marks([{ kind: "del", text: "守则。" }, { kind: "add", text: "守则。 " }])).toEqual([{ start: 3, end: 3 }, { start: 3, end: 4 }]);
  expect(marks([{ kind: "del", text: "你好 世界" }, { kind: "add", text: "你好世界" }])).toEqual([{ start: 2, end: 3 }, { start: 2, end: 2 }]);
  // Lines with nothing in common stay whole; a space on an empty line is still marked.
  expect(marks([{ kind: "del", text: "foo" }, { kind: "add", text: "bar" }])).toEqual([null, null]);
  expect(marks([{ kind: "del", text: "" }, { kind: "add", text: " " }])).toEqual([{ start: 0, end: 0 }, { start: 0, end: 1 }]);
  // Pairs go in order within a change, and a kept line or a gap starts the next change.
  expect(marks([
    { kind: "del", text: "a1" }, { kind: "del", text: "b1" }, { kind: "add", text: "a2" }, { kind: "add", text: "b2" },
    { kind: "gap", text: "" }, { kind: "add", text: "new" },
  ])).toEqual([{ start: 1, end: 2 }, { start: 1, end: 2 }, { start: 1, end: 2 }, { start: 1, end: 2 }, null, null]);
  // Never half a character: an emoji that changed is marked whole.
  const [before, after] = markChanges([{ kind: "del", text: "a😀b" }, { kind: "add", text: "a😃b" }]);
  expect(before!.text.slice(before!.mark!.start, before!.mark!.end)).toBe("😀");
  expect(after!.text.slice(after!.mark!.start, after!.mark!.end)).toBe("😃");
});

test("a card names its prompt as id:locale, and anything else names none", () => {
  expect(promptCardTarget("turn.system:zh")).toEqual({ id: "turn.system", locale: "zh" });
  expect(promptCardTarget("call.read_user_line:en")).toEqual({ id: "call.read_user_line", locale: "en" });
  expect(promptCardTarget("turn.system")).toBeNull();
  expect(promptCardTarget("turn.system:fr")).toBeNull();
  expect(promptCardTarget(":zh")).toBeNull();
  expect(promptCardTarget(null)).toBeNull();
});

test("the card's reach line is found by its prefix before the first change, in either language", () => {
  const zh = ["改内置提示词：系统指令 · 中文", "理由：交付没有附命令输出", "影响：所有 Bot 每一步都读", "@@ 第 1 处 · 末尾追加", "+ 补一段"].join("\n");
  expect(parsePromptCard(zh)).toMatchObject({ reason: "理由：交付没有附命令输出", reach: "影响：所有 Bot 每一步都读", hunks: [{ title: "第 1 处 · 末尾追加" }] });
  const en = ["Change a built-in prompt: System instructions · English", "Reason: no output", "Reach: every Bot, every step", "@@ Change 1 · append at the end", "+ Name the command."].join("\n");
  expect(parsePromptCard(en).reach).toBe("Reach: every Bot, every step");
  // A changed line that happens to start the same way is a change, not the reach.
  const inHunk = ["改内置提示词：系统指令 · 中文", "理由：x", "@@ 第 1 处 · 末尾追加", "+ 影响：不是范围"].join("\n");
  expect(parsePromptCard(inHunk).reach).toBeNull();
});
