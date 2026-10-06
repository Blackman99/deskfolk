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
import { PLACEHOLDER_MEANING, renderDefault, SLOTS, slotLocale, type SlotDef } from "./prompts/registry";
import { validatePromptText } from "./prompts/validate";
import { listPromptSummaries } from "./prompts/views";

export const PROMPT_EDIT_KIND = "prompt-edit";
const EDITS_MAX = 10;
const REASON_MAX = 500;
const SUMMARY_MAX = 3000;
const HUNK_LINE_MAX = 400;

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
export function promptEditSummary(slot: SlotDef, locale: Locale, edits: readonly Edit[] | null, reason: string, ui: Locale): string {
  const en = ui === "en";
  const language = locale === "en" ? "English" : en ? "Chinese" : "中文";
  const head = edits === null
    ? (en ? `Put a built-in prompt back on its default: ${slot.title.en} · ${language}` : `内置提示词恢复默认：${slot.title.zh} · ${language}`)
    : (en ? `Change a built-in prompt: ${slot.title.en} · ${language}` : `改内置提示词：${slot.title.zh} · ${language}`);
  const lines = [head, en ? `Reason: ${reason}` : `理由：${reason}`];
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

export function readPrompt(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const slot = requireSlot(args.id);
  const locale = pickLocale(ctx, slot, args.locale);
  const { text, defaultText } = currentText(ctx, slot, locale);
  const row = ctx.store.promptOverride(slot.id, locale);
  const ui = uiLocale(ctx);
  const recent = ctx.store.listPromptRevisions(slot.id, locale, 5).map((revision) => ({
    op: revision.op,
    by: revision.actor === "bot" ? (ctx.store.promptRevisionSource(revision).bot_name ?? "a Bot") : revision.actor,
    reason: revision.reason,
    at: revision.created_at,
  }));
  return {
    ok: true,
    data: {
      id: slot.id,
      locale,
      title: slot.title[ui],
      summary: slot.summary[ui],
      state: row ? (row.conflict_default !== null ? "conflict" : "edited") : "default",
      text,
      fixed_format: slot.format ? slot.format(locale, hostPromptEnv(ctx.store)) : null,
      placeholders: slot.placeholders.map((name) => ({ name: `{${name}}`, meaning: PLACEHOLDER_MEANING[name][ui], keep: name === "format" ? "exactly once" : "at least once" })),
      ...(args.with_default === true ? { default_text: defaultText } : {}),
      ...(row?.conflict_default ? { newer_default_not_merged: row.conflict_default } : {}),
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
