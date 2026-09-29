export type MentionCorrection = {
  /** What was typed after `@`, e.g. `分镜`. */
  token: string;
  /** The member it was taken to mean, e.g. `分镜师`. */
  name: string;
};

export type MentionSpanKind = "everyone" | "name" | "lenient" | "unresolved";

/** One `@` match in the body, in appearance order. Digit-only "at" tokens are not spans. */
export type MentionSpan = {
  start: number;
  end: number;
  kind: MentionSpanKind;
  /** Text after `@` that was consumed (roster name, typed token, or `everyone`). */
  token: string;
  /** Resolved roster name for `name` / `lenient`; otherwise null. */
  name: string | null;
};

export type MentionParse = {
  mentions: string[];
  everyone: boolean;
  /** `@token`s that matched no roster name and no lenient name, excluding those that contain a digit. */
  unresolved: string[];
  /** `@token`s that matched no roster name literally but exactly one lenient name. */
  corrected: MentionCorrection[];
  spans: MentionSpan[];
};

export type MentionOptions = {
  /**
   * Names a misspelt `@token` may still resolve to — normally the members present
   * in the session. A token resolves when it is a prefix or suffix of exactly one
   * of them (case-insensitive, at least two code points). Omit for literal-only.
   */
  lenient?: readonly string[];
};

/** Characters that end an `@token` besides whitespace. Covers ASCII and CJK punctuation. */
const TOKEN_DELIMITERS = new Set([
  ..."@,.;:!?()[]{}<>\"'`*/\\|",
  ..."，。、：；！？（）【】「」『』《》〈〉“”‘’…～／",
]);

/**
 * Longest roster-name match after `@`, plus the literal `@everyone`. A token that
 * matches no roster name literally resolves to a lenient name when it is an
 * unambiguous prefix or suffix of one of them; otherwise it is unresolved, unless
 * it contains a digit: `@37.79s`, `@f96` or `@14:30` reads as "at", not as a misspelt name.
 * An `@` inside a markdown link target is never a mention: the daemon links every path a Bot
 * cites, and older plan folders still carry the `@` of the request that opened them.
 */
export function parseMentions(
  body: string,
  rosterNames: readonly string[],
  options: MentionOptions = {},
): MentionParse {
  const names = [...new Set(rosterNames)].sort((a, b) => b.length - a.length);
  const lenient = [...new Set(options.lenient ?? [])];
  const mentions: string[] = [];
  const unresolved: string[] = [];
  const corrected: MentionCorrection[] = [];
  const spans: MentionSpan[] = [];
  let everyone = false;
  const targets = linkTargets(body);
  let t = 0;
  // Where the last `@` that read as a mention ended, so `@A/@B` names both.
  let lastEnd = -1;
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "@") {
      i += 1;
      continue;
    }
    while (t < targets.length && targets[t]![1] <= i) t += 1;
    if (t < targets.length && targets[t]![0] <= i) {
      i = targets[t]![1];
      continue;
    }
    const at = i;
    const joined = at - 1 === lastEnd;
    const rest = body.slice(i + 1);
    if (
      rest.startsWith("everyone") &&
      !startsName("everyone", rest, names) &&
      looksLikeMention(body, i, "everyone", joined)
    ) {
      everyone = true;
      const end = i + 1 + "everyone".length;
      spans.push({ start: at, end, kind: "everyone", token: "everyone", name: null });
      i = lastEnd = end;
      continue;
    }
    const hit = names.find((name) => rest.startsWith(name));
    if (hit && looksLikeMention(body, i, hit, joined)) {
      if (!mentions.includes(hit)) mentions.push(hit);
      const end = i + 1 + hit.length;
      spans.push({ start: at, end, kind: "name", token: hit, name: hit });
      i = lastEnd = end;
      continue;
    }
    const token = mentionToken(rest);
    if (token && looksLikeMention(body, i, token, joined)) {
      const name = lenientMatch(token, lenient);
      const end = i + 1 + token.length;
      if (name) {
        if (!mentions.includes(name)) mentions.push(name);
        if (!corrected.some((c) => c.token === token)) corrected.push({ token, name });
        spans.push({ start: at, end, kind: "lenient", token, name });
      } else if (!hasDigit(token)) {
        if (!unresolved.includes(token)) unresolved.push(token);
        spans.push({ start: at, end, kind: "unresolved", token, name: null });
      }
      i = lastEnd = end;
      continue;
    }
    i += 1 + token.length;
  }
  return { mentions, everyone, unresolved, corrected, spans };
}

/** The text after `@` up to whitespace or punctuation, so `@分镜，请出图` yields `分镜`. */
export function mentionToken(rest: string): string {
  let end = 0;
  for (const ch of rest) {
    if (/\s/.test(ch) || TOKEN_DELIMITERS.has(ch)) break;
    end += ch.length;
  }
  return rest.slice(0, end);
}

/**
 * The single lenient name the token is a prefix or suffix of, ignoring case.
 * Tokens shorter than two code points never match; ambiguity yields null.
 */
export function lenientMatch(token: string, names: readonly string[]): string | null {
  if ([...token].length < 2) return null;
  const needle = token.toLowerCase();
  const hits = names.filter((name) => {
    const hay = name.toLowerCase();
    return hay.startsWith(needle) || hay.endsWith(needle);
  });
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * `@` glued to an ASCII word or a hyphen (`user@host.com`, a dated folder such as
 * `work/2026-09-23-@审稿员-继续-e3wm`), starting a path segment or part of a URL
 * (`work/@审稿员-继续-e3wm/…`, `https://x.com/@name`), or opening an npm-style scope
 * (`@scope/pkg`) is not an attempt to mention anyone. Folders were named after the request that
 * opened them, so older ones still carry its `@`. A slash right after a mention joins two
 * names instead (`@A/@B`); `joined` says the slash follows one.
 */
export function looksLikeMention(body: string, at: number, token: string, joined = false): boolean {
  const prev = at > 0 ? body[at - 1] : "";
  if (/[A-Za-z0-9_-]/.test(prev)) return false;
  if (prev === "\\" || (prev === "/" && !joined)) return false;
  const end = at + 1 + token.length;
  return body[end] !== "/" || body[end + 1] === "@";
}

/** Where a markdown link target has to stop: `)` or whitespace, or `>` or a newline inside `<…>`. */
const TARGET_STOP = /[)\s]/g;
const ANGLE_TARGET_STOP = /[>\n]/g;

/**
 * `[start, end)` of each markdown link target, in order: `](path)` or `](<path>)`, the shapes the
 * messenger masks. Every `](` before a stop ends at that same stop, so the stop is found once and
 * reused, and a body full of `](` is still read in one pass.
 */
function linkTargets(body: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let stop = -1;
  let angleStop = -1;
  let open = body.indexOf("](");
  while (open !== -1) {
    const start = open + 2;
    let end = -1;
    if (body[start] === "<") {
      if (angleStop <= start) angleStop = stopFrom(ANGLE_TARGET_STOP, body, start + 1);
      if (body[angleStop] === ">" && body[angleStop + 1] === ")") end = angleStop + 1;
    }
    if (end === -1) {
      if (stop < start) stop = stopFrom(TARGET_STOP, body, start);
      if (body[stop] === ")") end = stop;
    }
    if (end !== -1) {
      const label = repeatedLabel(body, open, body.slice(start, end).replace(/^<([^]*)>$/, "$1"));
      if (label !== -1) out.push([label, open]);
      out.push([start, end]);
    }
    open = body.indexOf("](", end === -1 ? open + 1 : end + 1);
  }
  return out;
}

/**
 * Where the label of a link that repeats its own target starts, or -1. The daemon links a path it
 * cites as `[path](path)` (or `[./path](path)` from a backticked one), so an old folder's `@` sits in
 * the label too. A label that says something else (`[@X](path)`) is still read.
 */
function repeatedLabel(body: string, open: number, target: string): number {
  if (!target) return -1;
  for (const label of [target, `./${target}`]) {
    const from = open - label.length;
    if (from > 0 && body[from - 1] === "[" && body.startsWith(label, from)) return from;
  }
  return -1;
}

function stopFrom(stops: RegExp, body: string, from: number): number {
  stops.lastIndex = from;
  return stops.exec(body)?.index ?? body.length;
}

/**
 * A token with a digit in it (`-1.0 dB @37.79s`, `@f96`, `@t37`, `@14:30`, `@2026-09-18`)
 * reads as "at" a point or offset, so it is never reported as a mention that matched
 * nobody. It may still resolve leniently when it abbreviates exactly one member (`@3D` for `3D师`).
 */
export function hasDigit(token: string): boolean {
  return /\p{Nd}/u.test(token);
}

function startsName(literal: string, rest: string, names: string[]): boolean {
  return names.some((name) => name !== literal && name.startsWith(literal) && rest.startsWith(name));
}
