/**
 * 文本 / 代码行区间的适配器（选区 ↔ 锚点 ↔ 装饰），不引 Monaco 本身，只按它的行列约定：行和列都从 1 起，
 * 结束列不含。谁装饰、谁滚动是 `ArtifactCodeEditor` 的事。
 */
import { relocateTextRange, textRangeFromSelection, type Annotation, type TextRangeAnchor } from "@real-bot/protocol";

export type EditorRange = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

export function isEmptyRange(range: EditorRange): boolean {
  return range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn;
}

/** A selection in the editor becomes an anchor: the quote and its affixes come out of the text. */
export function anchorFromSelection(text: string, range: EditorRange): TextRangeAnchor {
  return textRangeFromSelection(text, {
    start_line: range.startLineNumber,
    start_col: range.startColumn,
    end_line: range.endLineNumber,
    end_col: range.endColumn,
  });
}

/** The whole of one line, for a tap on its number where a touch selection is not to be trusted. */
export function wholeLineRange(text: string, line: number): EditorRange {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const at = Math.min(Math.max(1, line), Math.max(1, lines.length));
  return { startLineNumber: at, startColumn: 1, endLineNumber: at, endColumn: (lines[at - 1]?.length ?? 0) + 1 };
}

/**
 * Where an annotation is drawn: the relocated range when the daemon found the quote elsewhere,
 * else the stored one. Null for a kind this editor does not draw, or a quote the file lost.
 */
export function rangeForAnnotation(row: Annotation, text?: string | null): EditorRange | null {
  if (row.anchor_kind !== "text_range") return null;
  const anchor = row.anchor as TextRangeAnchor;
  if (row.stale?.kind === "moved") {
    return { startLineNumber: row.stale.start_line, startColumn: row.stale.start_col, endLineNumber: row.stale.end_line, endColumn: row.stale.end_col };
  }
  if (row.stale?.kind === "changed") {
    // The daemon read the file as it is on disk; the editor may hold a newer buffer.
    const moved = typeof text === "string" ? relocateTextRange(anchor, text) : null;
    if (!moved) return null;
    return { startLineNumber: moved.start_line, startColumn: moved.start_col, endLineNumber: moved.end_line, endColumn: moved.end_col };
  }
  if (row.stale?.kind === "missing") return null;
  return { startLineNumber: anchor.start_line, startColumn: anchor.start_col, endLineNumber: anchor.end_line, endColumn: anchor.end_col };
}

/** The class an annotation's inline decoration and gutter marker carry: its status, and whether it is stale. */
export function decorationClass(row: Annotation): string {
  const status = row.status === "draft" ? "draft" : row.status === "resolved" ? "resolved" : "open";
  return `rb-annot rb-annot-${status}${row.stale ? " is-stale" : ""}`;
}
