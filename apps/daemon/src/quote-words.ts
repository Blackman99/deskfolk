/**
 * Your words as the ledger compares them (ADR 0040 P3): folded so that a quote of them matches
 * however its spaces, punctuation, width or case were copied. The scribe's items are checked
 * against your line with it (`store/scribe-patch.ts`), and every entry against the words it names
 * as its source (`store/requirements.ts`).
 */

type Folded = { folded: string; from: number[]; to: number[] };

/**
 * Text as the quote check compares it: each character full-width folded (NFKC) and lower-cased,
 * spaces, punctuation and symbols gone, and where in the text each folded unit came from.
 */
function fold(text: string): Folded {
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < text.length; ) {
    const width = text.codePointAt(i)! > 0xffff ? 2 : 1;
    const piece = text.slice(i, i + width).normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    for (let k = 0; k < piece.length; k++) {
      from.push(i);
      to.push(i + width);
    }
    folded += piece;
    i += width;
  }
  return { folded, from, to };
}

/** Your words as the quote check compares them (see {@link fold}). */
export function quoteWords(text: string): string {
  return fold(text).folded;
}

/**
 * Where `quote` sits in `body`, compared as {@link quoteWords}: the stretch of `body` itself from the
 * first character that matched to the last, so an entry keeps your words as you wrote them rather
 * than the scribe's copy of them. Null when they are not in it.
 */
export function findWords(quote: string, body: string): string | null {
  const words = quoteWords(quote);
  if (!words) return null;
  const text = fold(body);
  const at = text.folded.indexOf(words);
  if (at < 0) return null;
  return body.slice(text.from[at]!, text.to[at + words.length - 1]!);
}
