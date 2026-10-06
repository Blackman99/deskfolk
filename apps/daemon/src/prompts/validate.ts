/**
 * What an edited built-in prompt must still be (ADR 0064), checked the same way for your edits in
 * settings, a Bot's proposal and a newer default merged into yours: not empty, not much longer than
 * the default, every placeholder the code fills still there (`{format}` exactly once), no
 * placeholder the code does not fill, and for the two calls whose answer is read from the first
 * brace, no brace once filled.
 */
import type { Locale } from "@real-bot/protocol";
import { fill, placeholderCounts, PLACEHOLDERS } from "./fill";
import type { SlotDef } from "./registry";

export type PromptProblem = { code: string; detail?: string };

/** The longest text a slot takes, in code points: twice its default or the default plus 2000, capped. */
export function promptMaxChars(defaultText: string): number {
  const length = [...defaultText].length;
  return Math.min(50_000, Math.max(length * 2, length + 2000));
}

/** Line ends as `\n`; a control character other than a line end or a tab is refused. */
export function normalizePromptText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

const BARE_TOKEN = /\{([a-z_]+)\}/g;

export function validatePromptText(slot: SlotDef, locale: Locale, text: string, defaultText: string): { ok: true; text: string } | { ok: false; problems: PromptProblem[] } {
  const problems: PromptProblem[] = [];
  if (!slot.locales.includes(locale)) problems.push({ code: "prompt_locale", detail: slot.locales.join(",") });
  const normalized = normalizePromptText(text);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) problems.push({ code: "prompt_control_chars" });
  if (normalized.trim() === "") problems.push({ code: "prompt_empty" });
  const max = promptMaxChars(defaultText);
  if ([...normalized].length > max) problems.push({ code: "prompt_too_long", detail: String(max) });
  const counts = placeholderCounts(normalized);
  for (const name of slot.placeholders) {
    const n = counts.get(name) ?? 0;
    if (n === 0) problems.push({ code: "prompt_placeholder_missing", detail: `{${name}}` });
    else if (name === "format" && n > 1) problems.push({ code: "prompt_placeholder_repeated", detail: "{format}" });
  }
  for (const match of normalized.matchAll(BARE_TOKEN)) {
    const name = match[1]!;
    const known = (PLACEHOLDERS as readonly string[]).includes(name);
    if (!known || !(slot.placeholders as readonly string[]).includes(name)) {
      if (!problems.some((p) => p.code === "prompt_placeholder_unknown" && p.detail === `{${name}}`)) {
        problems.push({ code: "prompt_placeholder_unknown", detail: `{${name}}` });
      }
    }
  }
  if (slot.noBrace && slot.format) {
    const filled = fill(normalized, { format: slot.format(locale, { level: 0, shell: "sh" }) });
    if (filled.includes("{")) problems.push({ code: "prompt_brace" });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, text: normalized };
}
