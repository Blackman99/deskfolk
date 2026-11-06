/**
 * A Markdown file cut into its top-level blocks, each with the source lines it was written on
 * (`data-src-start` / `data-src-end` in the messenger). The lexer and its settings are the ones
 * `markdown-lines.ts` projects with, so the blocks are the blocks the reader sees.
 */
import { Marked } from "marked";
import { lexWithSourceLines, lineStarts, normalizeSource, sourceLinesOf } from "../../m/annotations/markdown-lines.ts";

export type MarkdownBlock = {
  /** The block's own source text (what one `MarkdownBody` renders). */
  raw: string;
  /** 1-based lines, both ends included. */
  start: number;
  end: number;
};

const lexer = new Marked({ gfm: true, breaks: true });

/** The blocks that show something: blank-line tokens (`space`) are skipped. */
export function markdownBlocks(source: string): MarkdownBlock[] {
  const text = normalizeSource(source);
  const starts = lineStarts(text);
  const lines = text.split("\n");
  const tokens = lexWithSourceLines(text, (src) => lexer.lexer(src));
  const blocks: MarkdownBlock[] = [];
  for (const token of tokens) {
    if (token.type === "space") continue;
    const at = sourceLinesOf(token);
    if (!at) continue;
    blocks.push({ raw: lines.slice(at.start - 1, at.end).join("\n"), start: at.start, end: Math.min(at.end, starts.length) });
  }
  return blocks;
}
