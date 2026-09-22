/**
 * A chat list shows what was said, not how it was written: one line of plain text, with the
 * markdown taken off. A row that reads `# 🤖 今日 AI 行业重点` or ``已推到 `main` `` is showing
 * its own syntax, which is noise at 13px in a 250px column.
 */
export function plainPreview(raw: string, limit = 90): string {
  let text = raw;
  // Fenced blocks say nothing useful in one line; name them by their language if they have one.
  text = text.replace(/```(\w+)?[\s\S]*?(```|$)/g, (_all, lang: string | undefined) => (lang ? `[${lang}]` : "[code]"));
  text = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_all, alt: string) => alt || "[image]")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, (_all, label: string) => label)
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s{0,3}([-*_])\s*(\1\s*){2,}$/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(?<![\w*])\*(?!\s)([^*\n]+)\*/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? text.slice(0, limit) : text;
}
