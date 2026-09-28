/**
 * Which files the judge reads, and in what form. The task's own deliverables come first, then
 * whatever the job cited, minus the app's own files (plan mirrors, spilled tool results, scratch).
 * An HTML page is read without its `<style>` and `<script>` bodies (the tags stay, so an external
 * `src` still shows): the judge gets a few thousand
 * characters, and a landing page spends them on CSS before the first heading.
 */

/** The daemon's own files under a work dir: never the team's delivery. */
export function isAppFile(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((part) => part === "tool-results" || part === "scratch" || part === "node_modules" || part === ".git")) return true;
  const name = parts.at(-1) ?? "";
  return parts[0] === "work" && (name === "map.md" || name === "ticket.md");
}

export function judgedFiles(input: {
  deliverables: readonly string[];
  cited: readonly string[];
  exists: (path: string) => boolean;
  limit: number;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of [...input.deliverables, ...input.cited]) {
    if (seen.has(path) || isAppFile(path) || !input.exists(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= input.limit) break;
  }
  return out;
}

export function htmlForJudge(html: string): string {
  return html
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style\s*>)/gi, "$1…$2")
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, "$1…$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n");
}
