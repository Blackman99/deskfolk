/**
 * Pure helpers of `ArtifactCodeEditor`: the text as the Editor holds it, and the messenger's
 * 1-based (Monaco) ranges as the Editor's 0-based ones.
 */
import type { EditorDecoration, EditorPosition, EditorRange as NshRange, EditorSelection } from "nsh/base";
import type { Annotation } from "@real-bot/protocol";
import { decorationClass, isEmptyRange, rangeForAnnotation, type EditorRange } from "../../m/annotations/text-range.ts";

/** The Editor folds `\r\n` and a lone `\r` to `\n`; a buffer is measured the same way. */
export function foldLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function toNshRange(range: EditorRange): NshRange {
  return {
    start: { line: range.startLineNumber - 1, column: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, column: range.endColumn - 1 },
  };
}

function before(a: EditorPosition, b: EditorPosition): boolean {
  return a.line < b.line || (a.line === b.line && a.column < b.column);
}

/** A selection as the messenger's range (1-based, start before end); null for a caret. */
export function selectionRange(selection: EditorSelection | undefined): EditorRange | null {
  if (!selection) return null;
  const [a, b] = before(selection.head, selection.anchor) ? [selection.head, selection.anchor] : [selection.anchor, selection.head];
  const range = { startLineNumber: a.line + 1, startColumn: a.column + 1, endLineNumber: b.line + 1, endColumn: b.column + 1 };
  return isEmptyRange(range) ? null : range;
}

export type DrawnAnnotation = { id: string; range: EditorRange };

/** Each annotation's range in the text, and the Editor decorations that draw them. */
export function annotationDecorations(rows: readonly Annotation[], text: string): { drawn: DrawnAnnotation[]; decorations: EditorDecoration[] } {
  const drawn: DrawnAnnotation[] = [];
  const decorations: EditorDecoration[] = [];
  for (const row of rows) {
    const range = rangeForAnnotation(row, text);
    if (!range) continue;
    drawn.push({ id: row.id, range });
    const cls = decorationClass(row);
    const resolved = cls.includes("rb-annot-resolved");
    decorations.push({
      range: toNshRange(range),
      class: `${resolved ? "bg-line-subtle" : "bg-accent-tint"}${cls.includes("is-stale") ? " underline" : ""}`,
      gutter: { placement: "before", class: resolved ? "bg-ink-muted" : "bg-brand" },
      overviewRuler: { class: resolved ? "bg-ink-muted" : "bg-brand" },
    });
  }
  return { drawn, decorations };
}

/** The annotation whose mark sits on a (1-based) line: where it starts. */
export function annotationStartingOn(drawn: readonly DrawnAnnotation[], line: number): string | null {
  return drawn.find((item) => item.range.startLineNumber === line)?.id ?? null;
}
