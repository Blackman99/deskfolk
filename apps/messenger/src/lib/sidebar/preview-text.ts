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
  text = maskSecrets(text);
  return text.length > limit ? text.slice(0, limit) : text;
}

/** Tokens whose shape alone says they are a credential: a provider's prefix, then a long tail. */
const PREFIXED_SECRET =
  /(?<![\w-])(?:sk-(?:ant-|proj-)?|pt-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza)[A-Za-z0-9_-]{16,}/g;
/** Any long token right after a word that names one: `API key: …`, `token=…`, `密钥：…`. */
const LABELLED_SECRET =
  /((?:api[ _-]?key|key|token|secret|password|passwd|密钥|令牌|密码)\s*[:：=]\s*)([A-Za-z0-9_\-.+/=]{16,})/gi;

/**
 * A key pasted into a chat is still in the chat, but the one-line preview is what the list, the
 * index and a search result show to anyone glancing at the screen — or at the phone it is
 * mirrored to. There it keeps its first four characters, enough to tell which key it was.
 */
export function maskSecrets(text: string): string {
  const mask = (token: string) => `${token.slice(0, 4)}••••`;
  return text
    .replace(PREFIXED_SECRET, (token) => mask(token))
    .replace(LABELLED_SECRET, (_all, label: string, token: string) => label + mask(token));
}
