/**
 * A Bot's built-in prompt tools (ADR 0064). Listing and reading are free. An edit or a reset is a
 * proposal: it is checked against the text as it stands, shown on an approval card with what changes,
 * and applied only when you allow it — re-applied to the text as it stands then, so a prompt changed
 * while the card waited is not overwritten. It is never Always-allowed (`prompt-edit` is not in
 * ALLOWED_KIND_KEYS): every Bot reads these, so each change is yours to let through.
 */
import type { Locale } from "@real-bot/protocol";
import { runCollabTool, type ToolCtx, type ToolResult } from "./collab-tools";
import { HttpError } from "./errors";
import { hostPromptEnv, promptProblemsError, promptSlot, resetPromptText, savePromptText } from "./prompts/book";
import { OWN_FILE_TOOLS } from "./prompts/builtin-tools";
import { PLACEHOLDER_MEANING, renderDefault, SLOTS, slotLocale, type SlotDef } from "./prompts/registry";
import { validatePromptText } from "./prompts/validate";
import { listPromptSummaries } from "./prompts/views";
import { codePointCount } from "./text";

export const PROMPT_EDIT_KIND = "prompt-edit";
const EDITS_MAX = 10;
const REASON_MAX = 500;
const SUMMARY_MAX = 3000;
const HUNK_LINE_MAX = 400;
/**
 * Past this many code points a whole answer would come close to the 8000 a tool result keeps in
 * context (tool-results.ts); a prompt that long is answered with an outline and read by paragraph.
 */
const READ_BUDGET = 7000;
const PARTS_MAX = 5;

type Edit = { old?: string; new?: string; after?: string; add?: string };

function fail(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message }, emitted: [] };
}

function uiLocale(ctx: ToolCtx): Locale {
  return ctx.store.settingsCached().locale === "en" ? "en" : "zh";
}

/** The language asked for when the slot has it; else the app's language when it has that; else its only one. */
function pickLocale(ctx: ToolCtx, slot: SlotDef, asked: unknown): Locale {
  if (asked === "zh" || asked === "en") {
    if (!slot.locales.includes(asked)) throw new HttpError(422, "prompt_locale", `${slot.id} comes in ${slot.locales.join(", ")}`);
    return asked;
  }
  return slotLocale(slot, uiLocale(ctx));
}

function parseEdits(raw: unknown): Edit[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(422, "invalid_args", "edits must list at least one change");
  if (raw.length > EDITS_MAX) throw new HttpError(422, "edits_too_many", `at most ${EDITS_MAX} changes at once`);
  return raw.map((item, at) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HttpError(422, "invalid_args", `edit ${at + 1} is not an object`);
    const edit = item as Record<string, unknown>;
    for (const key of ["old", "new", "after", "add"]) {
      if (edit[key] !== undefined && typeof edit[key] !== "string") throw new HttpError(422, "invalid_args", `edit ${at + 1}: ${key} must be text`);
    }
    const shaped = typeof edit.old === "string" ? typeof edit.new === "string" && edit.after === undefined && edit.add === undefined
      : typeof edit.after === "string" ? typeof edit.add === "string" && edit.new === undefined
        : typeof edit.add === "string" && edit.new === undefined;
    if (!shaped) throw new HttpError(422, "invalid_args", `edit ${at + 1}: give old + new, after + add, or add alone`);
    return edit as Edit;
  });
}

function occurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) count += 1;
  return count;
}

/** The edits applied in order; a passage that is not there exactly once refuses the lot. */
export function applyPromptEdits(text: string, edits: readonly Edit[]): { ok: true; text: string } | { ok: false; code: string; message: string } {
  let out = text;
  for (const [at, edit] of edits.entries()) {
    const n = at + 1;
    const anchor = edit.old ?? edit.after;
    if (anchor !== undefined) {
      if (anchor === "") return { ok: false, code: "edit_empty", message: `edit ${n}: the passage to find is empty` };
      const count = occurrences(out, anchor);
      if (count === 0) return { ok: false, code: "edit_missing", message: `edit ${n}: that passage is not in the prompt; read_prompt it again` };
      if (count > 1) return { ok: false, code: "edit_repeated", message: `edit ${n}: that passage occurs ${count} times; quote more of it` };
      const index = out.indexOf(anchor);
      out = edit.old !== undefined
        ? out.slice(0, index) + edit.new! + out.slice(index + anchor.length)
        : out.slice(0, index + anchor.length) + edit.add! + out.slice(index + anchor.length);
    } else {
      if (!edit.add || edit.add.trim() === "") return { ok: false, code: "edit_empty", message: `edit ${n}: nothing to append` };
      out = `${out.replace(/\s+$/, "")}\n\n${edit.add}`;
    }
  }
  if (out === text) return { ok: false, code: "no_change", message: "these edits change nothing" };
  return { ok: true, text: out };
}

function clip(line: string): string {
  return [...line].length > HUNK_LINE_MAX ? `${[...line].slice(0, HUNK_LINE_MAX).join("")}…` : line;
}

/**
 * What the approval card says: which prompt, why, and each change as `-` / `+` lines, so a bullet in
 * the prompt itself (`- 叫停：…`) is never mistaken for one. The card renders it (PromptEditCard).
 */
/** Who reads a prompt, said on its approval card so the reach of a change is plain before it is allowed. */
export function promptReach(slot: SlotDef, en: boolean): string {
  const turn: Record<string, [string, string]> = {
    "turn.system": ["所有 Bot 每一步都读", "every Bot, every step"],
    "turn.skills": ["有技能的 Bot 每一步都读", "every Bot that has skills, every step"],
    "turn.memory": ["有记忆的 Bot 每一步都读", "every Bot that has memories, every step"],
    "turn.mcp": ["接了 MCP 的 Bot 每一步都读", "every Bot with MCP servers, every step"],
    "agent.preface": ["由你的 Claude Code 跑的 Bot 每一步都读", "the Bots your Claude Code runs, every step"],
  };
  const [zh, english] = turn[slot.id]
    ?? (slot.group === "tool"
      ? (OWN_FILE_TOOLS.has(slot.id.slice("tool.".length))
        ? ["所有 Bot 每一步都带着（由你的 Claude Code 跑的 Bot 除外）", "every Bot, every step (not the Bots your Claude Code runs)"]
        : ["所有 Bot 每一步都带着", "every Bot, every step"])
      : ["应用自己的这一种调用，所有会话都用", "this one of the app's own calls, in every conversation"]);
  return en ? `Reach: ${english}` : `影响：${zh}`;
}

export function promptEditSummary(slot: SlotDef, locale: Locale, edits: readonly Edit[] | null, reason: string, ui: Locale): string {
  const en = ui === "en";
  const language = locale === "en" ? "English" : en ? "Chinese" : "中文";
  const head = edits === null
    ? (en ? `Put a built-in prompt back on its default: ${slot.title.en} · ${language}` : `内置提示词恢复默认：${slot.title.zh} · ${language}`)
    : (en ? `Change a built-in prompt: ${slot.title.en} · ${language}` : `改内置提示词：${slot.title.zh} · ${language}`);
  // One line each: the card reads the second line as the reason and finds the reach line by its prefix.
  const said = reason.replace(/\s*\n\s*/g, " ");
  const lines = [head, en ? `Reason: ${said}` : `理由：${said}`, promptReach(slot, en)];
  const hunks = (edits ?? []).map((edit, at) => {
    const n = at + 1;
    const out: string[] = [];
    if (edit.old !== undefined) {
      out.push(en ? `@@ Change ${n} · replace` : `@@ 第 ${n} 处 · 替换`);
      for (const line of edit.old.split("\n")) out.push(`- ${clip(line)}`);
      if (edit.new) for (const line of edit.new.split("\n")) out.push(`+ ${clip(line)}`);
    } else if (edit.after !== undefined) {
      const anchor = clip(edit.after.split("\n").at(-1)!.slice(-60));
      out.push(en ? `@@ Change ${n} · add after “${anchor}”` : `@@ 第 ${n} 处 · 在「${anchor}」之后加`);
      for (const line of edit.add!.split("\n")) out.push(`+ ${clip(line)}`);
    } else {
      out.push(en ? `@@ Change ${n} · append at the end` : `@@ 第 ${n} 处 · 末尾追加`);
      for (const line of edit.add!.split("\n")) out.push(`+ ${clip(line)}`);
    }
    return out.join("\n");
  });
  let text = lines.join("\n");
  for (const [at, hunk] of hunks.entries()) {
    const rest = hunks.length - at;
    const more = en ? `\n… ${rest} more change(s) not shown` : `\n…还有 ${rest} 处改动未显示`;
    if (text.length + hunk.length + 1 + more.length > SUMMARY_MAX) {
      text += more;
      break;
    }
    text += `\n${hunk}`;
  }
  return text;
}

function requireReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (!reason) throw new HttpError(422, "reason_required", "reason is required: why, and on what evidence");
  if ([...reason].length > REASON_MAX) throw new HttpError(422, "reason_required", `reason is at most ${REASON_MAX} characters`);
  return reason;
}

function requireSlot(raw: unknown): SlotDef {
  if (typeof raw !== "string" || !raw) throw new HttpError(422, "invalid_args", "id is required");
  return promptSlot(raw);
}

/** What the prompt says now, the editable part: yours, or the default. */
function currentText(ctx: ToolCtx, slot: SlotDef, locale: Locale): { text: string; defaultText: string } {
  const defaultText = renderDefault(slot, locale, hostPromptEnv(ctx.store));
  return { text: ctx.store.promptOverride(slot.id, locale)?.text ?? defaultText, defaultText };
}

export function listPrompts(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const group = typeof args.group === "string" ? args.group : null;
  const ui = uiLocale(ctx);
  const all = listPromptSummaries(ctx.store);
  const shown = all.filter((item) => (group ? item.group === group : item.group !== "tool"));
  const rows = shown.map((item) => ({
    id: item.id,
    title: item.title[ui],
    summary: item.summary[ui],
    locales: item.locales.map((state) => ({
      locale: state.locale,
      state: state.state,
      ...(state.last_actor ? { last_change_by: state.last_actor === "bot" ? `bot:${state.last_bot_id}` : state.last_actor, at: state.updated_at } : {}),
      ...(state.parse_failures ? { unreadable_answers: state.parse_failures } : {}),
    })),
  }));
  const data: Record<string, unknown> = { prompts: rows };
  if (!group) {
    const tools = all.filter((item) => item.group === "tool");
    const edited = tools.filter((item) => item.locales.some((state) => state.state !== "default")).map((item) => item.id);
    data.tool_descriptions = { count: tools.length, edited, more: "list_prompts with group: \"tool\" lists them" };
  }
  return { ok: true, data, emitted: [] };
}

/** A prompt's paragraphs, split at blank lines and kept exactly as written, so any phrase in one is in the text. */
function paragraphsOf(text: string): string[] {
  return text.split(/\n[ \t]*\n/);
}

function askedParts(raw: unknown, count: number): number[] | null {
  if (raw === undefined) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0 || list.length > PARTS_MAX || !list.every((n) => Number.isInteger(n) && n >= 1 && n <= count)) {
    throw new HttpError(422, "invalid_args", `part is 1 to ${PARTS_MAX} paragraph numbers between 1 and ${count}`);
  }
  return [...new Set(list as number[])];
}

export function readPrompt(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const slot = requireSlot(args.id);
  const locale = pickLocale(ctx, slot, args.locale);
  const { text, defaultText } = currentText(ctx, slot, locale);
  const row = ctx.store.promptOverride(slot.id, locale);
  const ui = uiLocale(ctx);
  const state = row ? (row.conflict_default !== null ? "conflict" : "edited") : "default";
  const withDefault = args.with_default === true;
  const parts = paragraphsOf(text);
  const find = typeof args.find === "string" && args.find.trim() ? args.find : null;
  const asked = askedParts(args.part, parts.length);
  if (find !== null || asked !== null) {
    // Paragraphs by number, or every one holding the phrase; past the budget the rest are only named.
    const wanted = asked ?? parts.flatMap((part, i) => (part.includes(find!) ? [i + 1] : []));
    const shown: Array<{ part: number; text: string }> = [];
    const more: number[] = [];
    let size = 0;
    for (const n of wanted) {
      const chars = codePointCount(parts[n - 1]!);
      if (shown.length > 0 && size + chars > READ_BUDGET - 1000) more.push(n);
      else {
        shown.push({ part: n, text: parts[n - 1]! });
        size += chars;
      }
    }
    return {
      ok: true,
      data: {
        id: slot.id,
        locale,
        state,
        of: parts.length,
        parts: shown,
        ...(find !== null ? { matched: wanted } : {}),
        ...(more.length ? { more } : {}),
        ...(withDefault && find !== null ? { default_parts: paragraphsOf(defaultText).filter((part) => part.includes(find)) } : {}),
      },
      emitted: [],
    };
  }
  const recent = ctx.store.listPromptRevisions(slot.id, locale, 5).map((revision) => ({
    op: revision.op,
    by: revision.actor === "bot" ? (ctx.store.promptRevisionSource(revision).bot_name ?? "a Bot") : revision.actor,
    reason: revision.reason,
    at: revision.created_at,
  }));
  const fixed = {
    fixed_format: slot.format ? slot.format(locale, hostPromptEnv(ctx.store)) : null,
    placeholders: slot.placeholders.map((name) => ({ name: `{${name}}`, meaning: PLACEHOLDER_MEANING[name][ui], keep: name === "format" ? "exactly once" : "at least once" })),
  };
  const head = { id: slot.id, locale, title: slot.title[ui], summary: slot.summary[ui], state };
  const full = {
    ...head,
    text,
    ...fixed,
    ...(withDefault ? (state === "default" ? { default_same: true } : { default_text: defaultText }) : {}),
    ...(row?.conflict_default ? { newer_default_not_merged: row.conflict_default } : {}),
    recent_changes: recent,
  };
  if (codePointCount(JSON.stringify({ ok: true, data: full })) <= READ_BUDGET) return { ok: true, data: full, emitted: [] };
  // Too long for one answer: an outline to pick paragraphs from, and what differs from the defaults by number.
  const differing = (other: string) => {
    const kept = new Set(paragraphsOf(other));
    return parts.flatMap((part, i) => (kept.has(part) ? [] : [i + 1]));
  };
  return {
    ok: true,
    data: {
      ...head,
      parts: parts.length,
      outline: parts.map((part, i) => ({ part: i + 1, chars: codePointCount(part), starts: [...part.replace(/\s+/g, " ").trim()].slice(0, 40).join("") })),
      how: ui === "en"
        ? "Too long for one answer: read paragraphs with part (numbers from this outline, up to 5) or find (an exact phrase)."
        : "太长，一次给不完：用 part（这份目录的段号，最多 5 个）或 find（一段原文）按段读。",
      ...fixed,
      ...(withDefault ? (state === "default" ? { default_same: true } : { changed_from_default: differing(defaultText) }) : {}),
      ...(row?.conflict_default ? { changed_from_newer_default: differing(row.conflict_default) } : {}),
      recent_changes: recent,
    },
    emitted: [],
  };
}

export function editPrompt(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const slot = requireSlot(args.id);
  const locale = pickLocale(ctx, slot, args.locale);
  const reason = requireReason(args.reason);
  const edits = parseEdits(args.edits);
  // Read now: once you allow the card this runs again, on the prompt as it is by then.
  const { text, defaultText } = currentText(ctx, slot, locale);
  const applied = applyPromptEdits(text, edits);
  if (!applied.ok) {
    return ctx.approved
      ? fail("conflict", "the prompt changed while the card waited and these edits no longer fit; read_prompt it again")
      : fail(applied.code, applied.message);
  }
  const checked = validatePromptText(slot, locale, applied.text, defaultText);
  if (!checked.ok) throw promptProblemsError(checked.problems);
  if (!ctx.approved) {
    return {
      ok: false,
      waitApproval: {
        kind_key: PROMPT_EDIT_KIND,
        target: `${slot.id}:${locale}`,
        summary: promptEditSummary(slot, locale, edits, reason, uiLocale(ctx)),
        run: (opts) => runCollabTool({ ...ctx, approved: true, approvalId: opts?.approval_id ?? null, approvalMessageId: opts?.message_id ?? null }, "edit_prompt", args),
      },
      emitted: [],
    };
  }
  const revision = savePromptText(ctx.store, {
    id: slot.id, locale, text: checked.text, actor: "bot", botId: ctx.botId, turnId: ctx.turnId,
    approvalId: ctx.approvalId ?? null, messageId: ctx.approvalMessageId ?? null, reason,
  });
  const row = ctx.store.promptOverride(slot.id, locale);
  return { ok: true, data: { id: slot.id, locale, revision_id: revision?.id ?? null, state: row ? "edited" : "default" }, emitted: [] };
}

export function resetPrompt(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const slot = requireSlot(args.id);
  const locale = pickLocale(ctx, slot, args.locale);
  const reason = requireReason(args.reason);
  if (!ctx.store.promptOverride(slot.id, locale)) return fail("no_change", "it is already the default");
  if (!ctx.approved) {
    return {
      ok: false,
      waitApproval: {
        kind_key: PROMPT_EDIT_KIND,
        target: `${slot.id}:${locale}`,
        summary: promptEditSummary(slot, locale, null, reason, uiLocale(ctx)),
        run: (opts) => runCollabTool({ ...ctx, approved: true, approvalId: opts?.approval_id ?? null, approvalMessageId: opts?.message_id ?? null }, "reset_prompt", args),
      },
      emitted: [],
    };
  }
  const revision = resetPromptText(ctx.store, {
    id: slot.id, locale, actor: "bot", botId: ctx.botId, turnId: ctx.turnId,
    approvalId: ctx.approvalId ?? null, messageId: ctx.approvalMessageId ?? null, reason,
  });
  return { ok: true, data: { id: slot.id, locale, revision_id: revision?.id ?? null, state: "default" }, emitted: [] };
}

/** Every slot id, for a test that the tools and the registry agree. */
export const PROMPT_IDS: readonly string[] = SLOTS.map((slot) => slot.id);
