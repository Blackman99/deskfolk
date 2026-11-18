/**
 * Pure helpers of `ArtifactCodeEditor`: the text as the Editor holds it, and the messenger's
 * 1-based (Monaco) ranges as the Editor's 0-based ones.
 */
import type { EditorDecoration, EditorEdit, EditorPosition, EditorRange as NshRange, EditorSelection } from "nsh/base";
import type { Annotation } from "@real-bot/protocol";
import { decorationClass, isEmptyRange, rangeForAnnotation, type EditorRange } from "../../m/annotations/text-range.ts";

/**
 * The Editor folds `\r\n` and a lone `\r` to `\n`; a buffer is measured the same way. A text with
 * no `\r` is returned as it is: the regex pass costs QuickJS most of a second on a 100 MB log, and
 * the editor folds its text several times over.
 */
export function foldLineEndings(text: string): string {
  return text.indexOf("\r") < 0 ? text : text.replace(/\r\n?/g, "\n");
}

/** How much is compared at a time: a native comparison of pieces, not a JS loop over every character of a large file. */
const PIECE = 4096;

const highSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** How many UTF-16 units `a` and `b` share at the start, never ending inside a surrogate pair. */
function sharedStart(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let at = 0;
  while (at + PIECE <= limit && a.substring(at, at + PIECE) === b.substring(at, at + PIECE)) at += PIECE;
  while (at < limit && a.charCodeAt(at) === b.charCodeAt(at)) at++;
  return at > 0 && at < a.length && highSurrogate(a.charCodeAt(at - 1)) ? at - 1 : at;
}

/** How many UTF-16 units `a` and `b` share at the end, at most `limit`, never starting inside a surrogate pair. */
function sharedEnd(a: string, b: string, limit: number): number {
  let at = 0;
  while (at + PIECE <= limit && a.substring(a.length - at - PIECE, a.length - at) === b.substring(b.length - at - PIECE, b.length - at)) at += PIECE;
  while (at < limit && a.charCodeAt(a.length - 1 - at) === b.charCodeAt(b.length - 1 - at)) at++;
  return at > 0 && at < a.length && lowSurrogate(a.charCodeAt(a.length - at)) ? at - 1 : at;
}

/** The Editor's positions of two offsets of `text` (`from` ≤ `to`), in one pass over its lines. */
function positionsOf(text: string, from: number, to: number): [EditorPosition, EditorPosition] {
  let line = 0;
  let lineStart = 0;
  const at = (offset: number): EditorPosition => {
    for (let next = text.indexOf("\n", lineStart); next >= 0 && next < offset; next = text.indexOf("\n", lineStart)) {
      line++;
      lineStart = next + 1;
    }
    return { line, column: offset - lineStart };
  };
  const start = at(from);
  return [start, at(to)];
}

/**
 * `after` as one edit of `before` (both with their line endings folded): the span between what the
 * two share at the start and at the end, in `before`'s lines and UTF-16 columns, and what goes in
 * its place; null when they are the same. A file read again goes in as this, so the Editor keeps
 * where it is scrolled to, and the caret outside what changed.
 */
export function changedSpan(before: string, after: string): EditorEdit | null {
  if (before === after) return null;
  const start = sharedStart(before, after);
  const end = sharedEnd(before, after, Math.min(before.length, after.length) - start);
  const [from, to] = positionsOf(before, start, before.length - end);
  return { range: { start: from, end: to }, text: after.slice(start, after.length - end) };
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
