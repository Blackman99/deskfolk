export type FoldingLineModel = {
  getLanguageId(): string;
  getLineCount(): number;
  getLineContent(lineNumber: number): string;
  getOptions?: () => { tabSize: number };
};

export type FoldRange = { start: number; end: number };

const MARKUP = new Set(["html", "xml", "svelte", "vue", "jsx", "tsx"]);
const HASH_COMMENT = new Set([
  "python",
  "ruby",
  "yaml",
  "toml",
  "shellscript",
  "r",
  "perl",
  "elixir",
  "nim",
  "makefile",
  "nginx",
  "terraform",
  "ini",
  "properties",
  "graphql",
]);
const DASH_COMMENT = new Set(["sql", "haskell", "lua"]);
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

type Syntax = {
  lineComment?: string;
  blockComment?: readonly [string, string];
  quotes: readonly string[];
};

function syntaxFor(lang: string): Syntax {
  if (MARKUP.has(lang)) {
    return { blockComment: ["<!--", "-->"], quotes: ['"', "'"] };
  }
  if (HASH_COMMENT.has(lang)) {
    return { lineComment: "#", quotes: ['"', "'"] };
  }
  if (DASH_COMMENT.has(lang)) {
    return { lineComment: "--", blockComment: ["/*", "*/"], quotes: ['"', "'"] };
  }
  if (lang === "plaintext" || lang === "diff" || lang === "markdown") {
    return { quotes: ['"', "'"] };
  }
  return { lineComment: "//", blockComment: ["/*", "*/"], quotes: ['"', "'", "`"] };
}

function indentOf(line: string, tabSize: number): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += tabSize;
    else if (ch === "\r") continue;
    else return n;
  }
  return -1;
}

export function indentFolds(model: FoldingLineModel): FoldRange[] {
  const tabSize = model.getOptions?.().tabSize ?? 2;
  const lineCount = model.getLineCount();
  const indents: number[] = new Array(lineCount + 1);
  for (let i = 1; i <= lineCount; i++) {
    indents[i] = indentOf(model.getLineContent(i), tabSize);
  }
  const ranges: FoldRange[] = [];
  for (let i = 1; i <= lineCount; i++) {
    const indent = indents[i]!;
    if (indent < 0) continue;
    let end = i;
    let sawDeeper = false;
    for (let k = i + 1; k <= lineCount; k++) {
      const next = indents[k]!;
      if (next < 0) {
        end = k;
        continue;
      }
      if (next > indent) {
        sawDeeper = true;
        end = k;
        continue;
      }
      break;
    }
    while (end > i && indents[end]! < 0) end -= 1;
    if (sawDeeper && end > i) ranges.push({ start: i, end });
  }
  return ranges;
}

function startsWithAt(text: string, i: number, token: string): boolean {
  return text.startsWith(token, i);
}

export function bracketFolds(model: FoldingLineModel): FoldRange[] {
  const lang = model.getLanguageId();
  const syntax = syntaxFor(lang);
  const text = Array.from({ length: model.getLineCount() }, (_, i) => model.getLineContent(i + 1)).join("\n");
  const ranges: FoldRange[] = [];
  const stack: Array<{ ch: string; line: number }> = [];
  let i = 0;
  let line = 1;
  let mode: "code" | "line" | "block" | "string" = "code";
  let quote = "";
  const openOf: Record<string, string> = { "}": "{", "]": "[", ")": "(" };

  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\n") {
      line += 1;
      if (mode === "line") mode = "code";
      i += 1;
      continue;
    }
    if (mode === "line") {
      i += 1;
      continue;
    }
    if (mode === "block") {
      const end = syntax.blockComment![1];
      if (startsWithAt(text, i, end)) {
        i += end.length;
        mode = "code";
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === "string") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) mode = "code";
      i += 1;
      continue;
    }
    if (syntax.blockComment && startsWithAt(text, i, syntax.blockComment[0])) {
      i += syntax.blockComment[0].length;
      mode = "block";
      continue;
    }
    if (syntax.lineComment && startsWithAt(text, i, syntax.lineComment)) {
      mode = "line";
      i += syntax.lineComment.length;
      continue;
    }
    if (syntax.quotes.includes(ch)) {
      quote = ch;
      mode = "string";
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      stack.push({ ch, line });
      i += 1;
      continue;
    }
    const open = openOf[ch];
    if (open) {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s]!.ch === open) {
          const start = stack[s]!.line;
          stack.length = s;
          if (line > start) ranges.push({ start, end: line });
          break;
        }
      }
    }
    i += 1;
  }
  return ranges;
}

export function tagFolds(model: FoldingLineModel): FoldRange[] {
  const ranges: FoldRange[] = [];
  const stack: Array<{ name: string; line: number }> = [];
  const tagRe = /<\/?([A-Za-z][\w:-]*)\b[^>]*>/g;
  for (let line = 1; line <= model.getLineCount(); line++) {
    const content = model.getLineContent(line);
    tagRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(content))) {
      const raw = match[0];
      const name = match[1]!.toLowerCase();
      if (raw.startsWith("</")) {
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s]!.name === name) {
            const start = stack[s]!.line;
            stack.length = s;
            if (line > start) ranges.push({ start, end: line });
            break;
          }
        }
        continue;
      }
      if (raw.endsWith("/>") || VOID_TAGS.has(name)) continue;
      stack.push({ name, line });
    }
  }
  return ranges;
}

export function headingFolds(model: FoldingLineModel): FoldRange[] {
  const heads: Array<{ line: number; level: number }> = [];
  for (let line = 1; line <= model.getLineCount(); line++) {
    const match = /^(#{1,6})\s+\S/.exec(model.getLineContent(line));
    if (match) heads.push({ line, level: match[1]!.length });
  }
  const ranges: FoldRange[] = [];
  const last = model.getLineCount();
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i]!.line;
    const level = heads[i]!.level;
    let end = last;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j]!.level <= level) {
        end = heads[j]!.line - 1;
        break;
      }
    }
    while (end > start && model.getLineContent(end).trim() === "") end -= 1;
    if (end > start) ranges.push({ start, end });
  }
  return ranges;
}

export function fenceFolds(model: FoldingLineModel): FoldRange[] {
  const ranges: FoldRange[] = [];
  let open: { line: number; marker: string } | null = null;
  for (let line = 1; line <= model.getLineCount(); line++) {
    const match = /^(```+|~~~+)/.exec(model.getLineContent(line));
    if (!match) continue;
    const marker = match[1]![0]!;
    if (!open) {
      open = { line, marker };
      continue;
    }
    if (open.marker === marker) {
      if (line > open.line) ranges.push({ start: open.line, end: line });
      open = null;
    }
  }
  return ranges;
}

export function regionFolds(model: FoldingLineModel): FoldRange[] {
  const startRe = /^\s*(?:\/\/|#|<!--|\/\*)\s*#?region\b/;
  const endRe = /^\s*(?:\/\/|#|<!--|\/\*)\s*#?endregion\b/;
  const stack: number[] = [];
  const ranges: FoldRange[] = [];
  for (let line = 1; line <= model.getLineCount(); line++) {
    const content = model.getLineContent(line);
    if (startRe.test(content)) {
      stack.push(line);
      continue;
    }
    if (endRe.test(content) && stack.length > 0) {
      const start = stack.pop()!;
      if (line > start) ranges.push({ start, end: line });
    }
  }
  return ranges;
}

function dedupe(ranges: FoldRange[]): FoldRange[] {
  const seen = new Set<string>();
  const out: FoldRange[] = [];
  for (const range of ranges) {
    if (range.end <= range.start) continue;
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(range);
  }
  return out;
}

export function computeMatchingFolds(model: FoldingLineModel): FoldRange[] {
  const lang = model.getLanguageId();
  const ranges: FoldRange[] = [
    ...indentFolds(model),
    ...bracketFolds(model),
    ...regionFolds(model),
  ];
  if (MARKUP.has(lang)) ranges.push(...tagFolds(model));
  if (lang === "markdown") {
    ranges.push(...headingFolds(model));
    ranges.push(...fenceFolds(model));
  }
  return dedupe(ranges);
}

let foldingRegistered = false;

export function registerMatchingFolding(
  monaco: Pick<typeof import("monaco-editor/esm/vs/editor/editor.api")["languages"], "registerFoldingRangeProvider">,
): void {
  if (foldingRegistered) return;
  foldingRegistered = true;
  monaco.registerFoldingRangeProvider("*", {
    provideFoldingRanges(model) {
      return computeMatchingFolds(model).map((range) => ({
        start: range.start,
        end: range.end,
        kind: undefined,
      }));
    },
  });
}
