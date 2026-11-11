/**
 * A Markdown file cut into its top-level blocks, each with the source lines it was written on
 * (`data-src-start` / `data-src-end` in the messenger). The lexer and its settings are the ones
 * `markdown-lines.ts` projects with, so the blocks are the blocks the reader sees.
 */
import { Markdown } from "deskfolk/native";
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

/** The native splitter (`markdownBlocks` in `app/native/src/markdown`), when this build's host has it. */
type NativeBlocks = (source: string) => Promise<string>;
const nativeBlocks = (Markdown as unknown as { markdownBlocks?: NativeBlocks }).markdownBlocks;

/**
 * The blocks, read off the engine thread: `markdown-rs` (the parser `TextView` renders with) on a
 * blocking thread. `marked` in QuickJS is superlinear (20 000 characters 83 ms, 60 000 over 2 s, a
 * 480 000-character report 44 s with the window held). A host built before the native splitter
 * gets `markdownBlocks` as it was.
 */
export async function markdownBlocksOffThread(source: string): Promise<MarkdownBlock[]> {
  if (typeof nativeBlocks !== "function") return markdownBlocks(source);
  const text = normalizeSource(source);
  const lines = text.split("\n");
  const ranges = JSON.parse(await nativeBlocks(text)) as Array<[number, number]>;
  return ranges.map(([start, end]) => ({ raw: lines.slice(start - 1, end).join("\n"), start, end: Math.min(end, lines.length) }));
}
