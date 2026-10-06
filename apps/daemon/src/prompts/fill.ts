/**
 * The placeholders a built-in prompt's editable text may carry (ADR 0064): `{format}` marks where the
 * app's fixed output format goes, `{item}` / `{rules}` the plan data a judge prompt is about, and
 * `{workspace}` / `{cwd}` the paths a Claude Agent turn runs in. Nothing else in braces is one — the
 * JSON examples in a prompt stay text.
 */
export const PLACEHOLDERS = ["format", "item", "rules", "workspace", "cwd"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

const PLACEHOLDER_RE = /\{(format|item|rules|workspace|cwd)\}/g;

/**
 * Fills the placeholders in one pass: what goes in is never read again, so a plan rule that happens to
 * say `{format}` stays words, and `$&` in a value is not a replacement pattern. A placeholder with no
 * value is left as it is.
 */
export function fill(template: string, values: Partial<Record<Placeholder, string>>): string {
  return template.replace(PLACEHOLDER_RE, (whole, name: Placeholder) => values[name] ?? whole);
}

/** How many times each placeholder appears in a text, for validating an edit. */
export function placeholderCounts(text: string): Map<Placeholder, number> {
  const counts = new Map<Placeholder, number>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const name = match[1] as Placeholder;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}
