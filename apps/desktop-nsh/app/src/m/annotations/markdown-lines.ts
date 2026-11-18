/**
 * Markdown 渲染态划词（#25）的行号映射，纯函数、不碰 DOM。marked 不给位置，这里拿词法记号的 `raw` 回源文里对位：
 * - `assignSourceLines`：给每个块（段落、标题、列表与列表项、引用、表格、代码块、HTML 块）记下它在源文里的
 *   起止行（1 起，含尾行）；`markdown.ts` 的 `sourceLines` 模式据此写出 `data-src-start` / `data-src-end`。
 * - `projectVisible`：把源文投影成渲染后看得见的字——去掉 `**`、反引号、`[…](url)`、列表符号、标题的 `#`、
 *   表格竖线、引用的 `>`、代码围栏——每个字记着它在源文里的偏移，划词时据此找回源文的行列。marked 偶尔交回
 *   改写过的 `raw`（引用里的懒续行）：先按「只差空白和 `>`」对位，再不行就按行号取源文那几行。
 * 开头的 YAML front matter 当成一块 yaml 代码，行号照常往下数。
 */
import { Marked, type Token, type Tokens, type TokensList } from "marked";

/** A block's place in the source: 1-based lines, both ends included. */
export type SourceLines = { start: number; end: number };

export const SRC_START_ATTR = "data-src-start";
export const SRC_END_ATTR = "data-src-end";

/** The same lexer settings the chat renderer uses, so the blocks here are the blocks on screen. */
const lexer = new Marked({ gfm: true, breaks: true });

const LINES = new WeakMap<object, SourceLines>();

/** The lines `assignSourceLines` gave a token (a block, a list item, or a front matter block). */
export function sourceLinesOf(token: object): SourceLines | undefined {
  return LINES.get(token);
}

function newlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
  return count;
}

/**
 * Walk block tokens in order and give each its source lines: the lines its first and last written
 * characters are on. Each token is found in `text`, what it was lexed from, and `loc` takes an
 * offset there to one in the document whose lines start at `starts` — for the children of a quote
 * or a list item, through that block's own dedented text, matched to the source line by line
 * (`linesLoc`). Counting the newlines in `raw` would do in plain cases, but marked lexes a quote a
 * chunk at a time: the break joining two chunks is in no token's `raw`, and a list re-read with
 * the quote's lazy lines can come back with a blank line the source does not have. A token that
 * cannot be placed that way counts on from the ones before it, starting at `firstLine`.
 */
export function assignSourceLines(tokens: readonly Token[], text: string, loc: Loc, starts: readonly number[], firstLine: number): void {
  let cursor = 0;
  let line = firstLine;
  for (const token of tokens) {
    let raw = token.raw ?? "";
    let here: Loc = NOWHERE;
    const found = /\S/.test(raw) ? locate(text, raw, cursor, false) : null;
    if (found) {
      raw = found.raw;
      here = shift(loc, found.at);
      cursor = found.at + raw.length;
    }
    const first = raw.search(/\S/);
    if (first < 0) {
      line += newlines(raw);
      continue;
    }
    let last = raw.length - 1;
    while (last > first && WHITESPACE.test(raw[last]!)) last -= 1;
    const a = here(first);
    const b = here(last);
    const lead = newlines(raw.slice(0, first));
    const lines =
      a >= 0 && b >= a
        ? { start: lineAt(starts, a), end: lineAt(starts, b) }
        : { start: line + lead, end: line + lead + newlines(raw.slice(first, last + 1)) };
    LINES.set(token, lines);
    // The line `raw` starts on; its children and whatever follows count on from there.
    const top = lines.start - lead;
    line = top + newlines(raw);
    if (token.type === "list") {
      assignSourceLines((token as Tokens.List).items, raw, here, starts, top);
    } else if (token.type === "list_item" || token.type === "blockquote") {
      const block = token as Tokens.ListItem | Tokens.Blockquote;
      if (typeof block.text === "string") assignSourceLines(block.tokens ?? [], block.text, linesLoc(raw, block.text, here), starts, top);
    }
  }
}

/** Leading YAML front matter: the fence lines, what is between them, and how many lines it takes. */
export type FrontMatter = { raw: string; yaml: string; yamlStart: number; lines: number };

const FRONT_MATTER = /^---[ \t]*\n(?:([\s\S]*?)\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/;
const YAML_KEY = /^[^\s#:][^:\n]*:(?:[ \t]|$)/m;

/**
 * `---` at the very top, a closing `---` (or `...`), and something between that reads as YAML
 * keys — otherwise it is a rule and a heading, and Markdown renders it that way.
 */
export function splitFrontMatter(text: string): FrontMatter | null {
  const match = FRONT_MATTER.exec(text);
  if (!match) return null;
  const yaml = match[1] ?? "";
  if (yaml && !YAML_KEY.test(yaml)) return null;
  const raw = match[0];
  return { raw, yaml, yamlStart: raw.indexOf("\n") + 1, lines: newlines(raw.replace(/\n$/, "")) + 1 };
}

/** The front matter as a fenced yaml block, already carrying its lines (1 to the closing fence). */
export function frontMatterToken(front: FrontMatter): Tokens.Code {
  const token: Tokens.Code = { type: "code", raw: front.raw, lang: "yaml", text: front.yaml };
  LINES.set(token, { start: 1, end: front.lines });
  return token;
}

/**
 * Lex a whole document with block lines: front matter first as its own block, the rest counted on
 * after it. `lex` is the caller's lexer so the tokens are the ones it is about to render.
 */
export function lexWithSourceLines(text: string, lex: (src: string) => TokensList): TokensList {
  const front = splitFrontMatter(text);
  const bodyAt = front ? front.raw.length : 0;
  const body = text.slice(bodyAt);
  const tokens = lex(body);
  assignSourceLines(tokens, body, (offset) => bodyAt + offset, lineStarts(text), front ? front.lines + 1 : 1);
  if (front) tokens.unshift(frontMatterToken(front));
  return tokens;
}

/** Normalize the way `textRangeFromSelection` does, so offsets here are its offsets. */
export function normalizeSource(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

/** Where each line starts in a normalized text. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** The 1-based line an offset falls on. */
export function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * The source as the reader sees it: only the characters that end up as text on screen, without
 * whitespace (renderers disagree on that, the words do not), each with the source span it came
 * from — one character, or a whole `&amp;` / `\*`.
 */
export type VisibleProjection = {
  /** The normalized source (`\r\n` → `\n`) every offset refers to. */
  source: string;
  chars: string;
  from: number[];
  to: number[];
};

const WHITESPACE = /\s/;

class Emitter {
  chars: string[] = [];
  from: number[] = [];
  to: number[] = [];
  private last = -1;

  push(ch: string, from: number, to: number): void {
    // An offset that goes backwards means a locator guessed wrong; dropping the character keeps
    // the projection in reading order, which is what lookups rely on.
    if (from < 0 || from < this.last || WHITESPACE.test(ch)) return;
    this.chars.push(ch);
    this.from.push(from);
    this.to.push(Math.max(to, from + 1));
    this.last = from;
  }
}

/** Offset in some derived text → offset in the source, or −1 when it cannot be told. */
export type Loc = (offset: number) => number;

const NOWHERE: Loc = () => -1;

const shift =
  (loc: Loc, by: number): Loc =>
  (offset) =>
    loc(offset + by);

/** How far past the expected line an inner line is looked for, when the lexer added blank lines. */
const LINE_DRIFT = 8;

/** A line with nothing on screen: blank, or only the `>`s of a quote. */
const MARKER_ONLY = /^[\s>]*$/;

/**
 * Text that was cut from another one line by line — a list item without its marker and indent, a
 * quote without its `>`, a heading without its `#`s — keeps each line as a tail (or at least a
 * piece) of an outer line, in order: normally the one with the same number, but a lazy line in a
 * quote can come out of the lexer after a blank line the source does not have, so a line that is
 * not where it should be is looked for a few lines further on.
 */
function linesLoc(outer: string, inner: string, loc: Loc): Loc {
  if (outer.startsWith(inner)) return loc;
  const outerLines = outer.split("\n");
  const innerLines = inner.split("\n");
  const outerStarts = lineStarts(outer);
  const innerStarts = lineStarts(inner);
  const spread: Array<Int32Array | null> = [];
  let next = 0;
  const base = innerLines.map((line) => {
    spread.push(null);
    if (!line.trim()) {
      // Nothing to show on it; step over its partner only when that one is empty too.
      if (next < outerLines.length && MARKER_ONLY.test(outerLines[next]!)) next += 1;
      return -1;
    }
    for (let k = next; k < Math.min(outerLines.length, next + LINE_DRIFT); k += 1) {
      const o = outerLines[k]!;
      let at = o.endsWith(line) ? o.length - line.length : o.indexOf(line);
      if (at < 0) {
        // A tab the lexer spread into spaces (after a nested marker, say): the words still end
        // the line, the gaps between them do not match. Pair the words character by character.
        const columns = tailColumns(o, line);
        if (!columns) continue;
        spread[spread.length - 1] = columns.map((col) => (col < 0 ? -1 : outerStarts[k]! + col));
      } else {
        at += outerStarts[k]!;
      }
      next = k + 1;
      return at;
    }
    return -1;
  });
  return (offset) => {
    const k = lineAt(innerStarts, offset) - 1;
    const col = offset - innerStarts[k]!;
    const columns = spread[k];
    if (columns) {
      const at = columns[col] ?? -1;
      return at < 0 ? -1 : loc(at);
    }
    const b = base[k] ?? -1;
    return b < 0 ? -1 : loc(b + col);
  };
}

/**
 * Each non-blank character of `line` → its column in `outer`, when the words of `line` end
 * `outer` with only the whitespace between them differing; null when they do not.
 */
function tailColumns(outer: string, line: string): Int32Array | null {
  const columns = new Int32Array(line.length).fill(-1);
  let k = outer.length - 1;
  let found = false;
  for (let i = line.length - 1; i >= 0; i -= 1) {
    const ch = line[i]!;
    if (WHITESPACE.test(ch)) continue;
    while (k >= 0 && WHITESPACE.test(outer[k]!)) k -= 1;
    if (k < 0 || outer[k] !== ch) return null;
    columns[i] = k;
    k -= 1;
    found = true;
  }
  return found ? columns : null;
}

/**
 * Where a token's `raw` sits in `text`, at or after `cursor`, and the text it covers there:
 * normally right at the cursor and exactly `raw`. The lexer does not always hand back what it
 * read, though — a list that ends a quote can come back with its trailing spaces moved past the
 * line break, a line break the source does not have, or a lazy line's `>` gone — so the same
 * words with different whitespace and quote markers at the cursor count too, before looking
 * further on. Blank tokens are never looked for further on: jumping to some later blank line
 * would skip everything in between.
 */
function locate(text: string, raw: string, cursor: number, search = true): { at: number; raw: string } | null {
  if (text.startsWith(raw, cursor)) return { at: cursor, raw };
  if (!/\S/.test(raw)) return null;
  const end = looseEnd(text, raw, cursor);
  if (end >= 0) {
    // Start on the line of the first word, so the lines of what is returned are the token's lines.
    let first = cursor;
    while (first < end && WHITESPACE.test(text[first]!)) first += 1;
    const at = Math.max(cursor, text.lastIndexOf("\n", first - 1) + 1);
    return { at, raw: text.slice(at, end) };
  }
  const at = search ? text.indexOf(raw, cursor) : -1;
  return at < 0 ? null : { at, raw };
}

/** Whether only blanks and quote markers come before `pos` on its line. */
function atLineHead(text: string, pos: number): boolean {
  let p = pos - 1;
  while (p >= 0 && (text[p] === " " || text[p] === "\t" || text[p] === ">")) p -= 1;
  return p < 0 || text[p] === "\n";
}

/**
 * Where `raw` ends in `text` if it starts at `from` with only whitespace and the `>`s at the
 * start of a line differing; −1 if it does not.
 */
function looseEnd(text: string, raw: string, from: number): number {
  let i = from;
  for (let k = 0; k < raw.length; ) {
    const ch = raw[k]!;
    if (WHITESPACE.test(ch)) {
      k += 1;
      continue;
    }
    while (i < text.length && WHITESPACE.test(text[i]!)) i += 1;
    if (text[i] === ch) {
      i += 1;
      k += 1;
    } else if (ch === ">" && atLineHead(raw, k)) {
      k += 1;
    } else if (text[i] === ">" && atLineHead(text, i)) {
      i += 1;
    } else {
      return -1;
    }
  }
  // The whitespace after the last word, as much of it as `raw` had.
  let trailing = raw.length - raw.trimEnd().length;
  while (trailing > 0 && i < text.length && WHITESPACE.test(text[i]!)) {
    i += 1;
    trailing -= 1;
  }
  return i;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
};

let entityDecoder: HTMLTextAreaElement | null = null;

function decodeEntity(body: string): string | null {
  if (body.startsWith("#")) {
    const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    if (!Number.isFinite(code)) return null;
    // What HTML shows for a code point it cannot take: NUL, a lone surrogate, past Unicode.
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
    // The C1 controls HTML reads as windows-1252 are left to the browser below.
    if (code < 0x80 || code > 0x9f || typeof document === "undefined") return String.fromCodePoint(code);
  } else {
    const known = NAMED_ENTITIES[body];
    if (known !== undefined) return known;
  }
  // The rarer names: let the browser say what it would show, where there is one.
  if (typeof document === "undefined") return null;
  entityDecoder ??= document.createElement("textarea");
  entityDecoder.innerHTML = `&${body};`;
  const decoded = entityDecoder.value;
  return decoded && decoded !== `&${body};` ? decoded : null;
}

const ENTITY = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;

/** Plain text as the browser shows it: entities decoded, every other character as is. */
function emitPlain(raw: string, loc: Loc, out: Emitter): void {
  for (let i = 0; i < raw.length; ) {
    if (raw.charCodeAt(i) === 38) {
      ENTITY.lastIndex = i;
      const match = ENTITY.exec(raw);
      const decoded = match ? decodeEntity(match[1]!) : null;
      if (match && decoded !== null) {
        const from = loc(i);
        const to = loc(i + match[0].length - 1) + 1;
        for (let k = 0; k < decoded.length; k += 1) out.push(decoded[k]!, from, to);
        i += match[0].length;
        continue;
      }
    }
    const from = loc(i);
    out.push(raw[i]!, from, from + 1);
    i += 1;
  }
}

/** Code is shown exactly as written: no entities, no escapes. */
function emitVerbatim(text: string, loc: Loc, out: Emitter): void {
  for (let i = 0; i < text.length; i += 1) {
    const from = loc(i);
    out.push(text[i]!, from, from + 1);
  }
}

const DROPPED_HTML = /<(script|style|textarea|option|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const HTML_TAG = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|<![^>]*>|<\?[\s\S]*?\?>/g;

/** Raw HTML keeps only the text between its tags once sanitized. */
function emitHtml(raw: string, loc: Loc, out: Emitter): void {
  // Keep the length, so offsets still line up, but read the whole dropped element as one tag.
  const masked = raw.replace(DROPPED_HTML, (m) => `<x${" ".repeat(Math.max(0, m.length - 3))}>`);
  let last = 0;
  for (const match of masked.matchAll(HTML_TAG)) {
    const at = match.index ?? 0;
    if (at > last) emitPlain(raw.slice(last, at), shift(loc, last), out);
    last = at + match[0].length;
  }
  if (last < raw.length) emitPlain(raw.slice(last), shift(loc, last), out);
}

type InlineToken = Token & { text?: string; tokens?: Token[] };

function emitInline(tokens: readonly Token[], text: string, loc: Loc, out: Emitter): void {
  let cursor = 0;
  for (const token of tokens as readonly InlineToken[]) {
    if (!token.raw) continue;
    const found = locate(text, token.raw, cursor);
    if (!found) continue;
    const { at, raw } = found;
    cursor = at + raw.length;
    const here = shift(loc, at);
    switch (token.type) {
      case "text":
        if (token.tokens && typeof token.text === "string") emitInline(token.tokens, token.text, linesLoc(raw, token.text, here), out);
        else emitPlain(raw, here, out);
        break;
      case "escape": {
        const from = here(0);
        const to = here(raw.length - 1) + 1;
        for (let k = 1; k < raw.length; k += 1) out.push(raw[k]!, from, to);
        break;
      }
      case "codespan": {
        let lead = 0;
        while (raw[lead] === "`") lead += 1;
        let trail = 0;
        while (trail < raw.length - lead && raw[raw.length - 1 - trail] === "`") trail += 1;
        emitVerbatim(raw.slice(lead, raw.length - trail), shift(here, lead), out);
        break;
      }
      case "strong":
      case "em":
      case "del":
      case "link": {
        const inner = token.text;
        if (!token.tokens || typeof inner !== "string") break;
        let offset: number;
        if (token.type === "link") {
          offset = (raw[0] === "[" || raw[0] === "<") && raw.startsWith(inner, 1) ? 1 : raw.startsWith(inner) ? 0 : raw.indexOf(inner);
        } else {
          const guess = (raw.length - inner.length) >> 1;
          offset = raw.startsWith(inner, guess) ? guess : raw.indexOf(inner);
        }
        if (offset >= 0) emitInline(token.tokens, inner, shift(here, offset), out);
        break;
      }
      // Images are dropped by the sanitizer, tags leave no text, a break is an element.
      default:
        break;
    }
  }
}

function emitTableRow(cells: readonly Tokens.TableCell[], line: string | undefined, loc: Loc, out: Emitter): void {
  if (line === undefined) return;
  let cursor = 0;
  for (const cell of cells) {
    if (!cell.text) continue;
    let cellLoc: Loc | null = null;
    let at = line.indexOf(cell.text, cursor);
    if (at >= 0) {
      cellLoc = shift(loc, at);
      cursor = at + cell.text.length;
    } else if (cell.text.includes("|")) {
      // marked unescapes `\|` in a cell; count the backslashes back in.
      const escaped = cell.text.replace(/\|/g, "\\|");
      at = line.indexOf(escaped, cursor);
      if (at >= 0) {
        const base = at;
        const text = cell.text;
        cellLoc = (offset) => {
          let pipes = 0;
          for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === "|") pipes += 1;
          // A pipe itself sits after its backslash.
          return loc(base + offset + pipes + (text[offset] === "|" ? 1 : 0));
        };
        cursor = at + escaped.length;
      }
    }
    if (cellLoc) emitInline(cell.tokens, cell.text, cellLoc, out);
  }
}

type BlockToken = Token & { text?: string; tokens?: Token[]; items?: Token[] };

/** The whole normalized source and where its lines start, for a token found by its lines. */
type Doc = { text: string; starts: number[] };

/**
 * A token whose `raw` the lexer rewrote past recognition (a list re-read with the lazy lines of
 * the quote around it) is still on the lines `assignSourceLines` gave it: take those lines of the
 * source as written, and match its text against them.
 */
function byLines(doc: Doc, token: Token): { raw: string; loc: Loc } | null {
  const lines = sourceLinesOf(token);
  const from = lines ? doc.starts[lines.start - 1] : undefined;
  if (!lines || from === undefined) return null;
  const next = doc.starts[lines.end];
  const to = next === undefined ? doc.text.length : next - 1;
  return { raw: doc.text.slice(from, to), loc: (offset) => from + offset };
}

function emitBlocks(tokens: readonly Token[], text: string, loc: Loc, out: Emitter, doc: Doc): void {
  let cursor = 0;
  for (const token of tokens as readonly BlockToken[]) {
    if (!token.raw) continue;
    // From here on `raw` is the source as written, which is what the lines are matched against.
    let raw: string;
    let here: Loc;
    const found = locate(text, token.raw, cursor);
    if (found) {
      raw = found.raw;
      cursor = found.at + raw.length;
      here = shift(loc, found.at);
    } else {
      const lined = /\S/.test(token.raw) ? byLines(doc, token) : null;
      if (!lined) continue;
      ({ raw, loc: here } = lined);
    }
    switch (token.type) {
      case "paragraph":
      case "heading":
      case "text":
        if (token.tokens && typeof token.text === "string") emitInline(token.tokens, token.text, linesLoc(raw, token.text, here), out);
        else if (typeof token.text === "string") emitPlain(token.text, linesLoc(raw, token.text, here), out);
        break;
      case "code": {
        const code = token as Tokens.Code;
        const fenced = code.codeBlockStyle !== "indented";
        const firstBreak = raw.indexOf("\n");
        if (fenced && firstBreak < 0) break;
        const bodyAt = fenced ? firstBreak + 1 : 0;
        emitVerbatim(code.text, linesLoc(raw.slice(bodyAt), code.text, shift(here, bodyAt)), out);
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        const lines = raw.split("\n");
        const starts = lineStarts(raw);
        emitTableRow(table.header, lines[0], shift(here, starts[0]!), out);
        table.rows.forEach((cells, r) => {
          const k = 2 + r;
          if (starts[k] !== undefined) emitTableRow(cells, lines[k], shift(here, starts[k]!), out);
        });
        break;
      }
      case "blockquote":
      case "list_item":
        if (token.tokens && typeof token.text === "string") emitBlocks(token.tokens, token.text, linesLoc(raw, token.text, here), out, doc);
        break;
      case "list":
        emitBlocks(token.items ?? [], raw, here, out, doc);
        break;
      case "html": {
        // Its text is its raw as the lexer read it; matched line by line, a quote's `>`s stay out.
        const html = typeof token.text === "string" ? token.text : token.raw;
        emitHtml(html, linesLoc(raw, html, here), out);
        break;
      }
      // space, hr, def, checkbox: nothing to read.
      default:
        break;
    }
  }
}

/** The visible characters of a Markdown source, each tied back to where it was written. */
export function projectVisible(source: string): VisibleProjection {
  const text = normalizeSource(source);
  const out = new Emitter();
  const front = splitFrontMatter(text);
  let bodyAt = 0;
  if (front) {
    emitVerbatim(front.yaml, (offset) => front.yamlStart + offset, out);
    bodyAt = front.raw.length;
  }
  const body = text.slice(bodyAt);
  const tokens = lexer.lexer(body);
  const starts = lineStarts(text);
  assignSourceLines(tokens, body, (offset) => bodyAt + offset, starts, front ? front.lines + 1 : 1);
  emitBlocks(tokens, body, (offset) => bodyAt + offset, out, { text, starts });
  return { source: text, chars: out.chars.join(""), from: out.from, to: out.to };
}
