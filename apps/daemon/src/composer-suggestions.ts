/**
 * Parse the composer's next-draft suggestions. The model may wrap JSON in fences or prose; anything
 * that does not survive these checks is dropped so the bar stays empty rather than showing junk.
 */
import { parseMentions } from "./mentions";
import { extractJsonObject } from "./route-agent";
import {
  COMPOSER_SUGGEST_LABEL,
  COMPOSER_SUGGEST_MAX,
  COMPOSER_SUGGEST_PROMPT,
} from "./prompts/composer-suggestions";

export type ParsedComposerSuggestion = {
  id: string;
  label: string;
  prompt: string;
};

function cleanLine(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function suggestionId(prompt: string, index: number): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug.length > 0 ? `${index}-${slug}` : `s${index}`;
}

/**
 * Keep only drafts whose @tokens name present members (or everyone). Unknown @ is dropped so a
 * hallucinated name cannot wake nobody and leave a system note.
 */
export function parseComposerSuggestions(
  raw: string,
  rosterNames: readonly string[],
): ParsedComposerSuggestion[] {
  const parsed = extractJsonObject(raw);
  if (!parsed) return [];
  const rows = parsed.suggestions;
  if (!Array.isArray(rows)) return [];
  const names = [...rosterNames];
  const out: ParsedComposerSuggestion[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (out.length >= COMPOSER_SUGGEST_MAX) break;
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const obj = row as Record<string, unknown>;
    const prompt = cleanLine(obj.prompt, COMPOSER_SUGGEST_PROMPT);
    if (prompt.length < 2) continue;
    const mentions = parseMentions(prompt, names);
    if (mentions.unresolved.length > 0) continue;
    const label = cleanLine(obj.label, COMPOSER_SUGGEST_LABEL) || prompt.slice(0, COMPOSER_SUGGEST_LABEL);
    const key = prompt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: suggestionId(prompt, out.length), label, prompt });
  }
  return out;
}
