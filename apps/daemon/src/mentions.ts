export type MentionCorrection = {
  /** What was typed after `@`, e.g. `分镜`. */
  token: string;
  /** The member it was taken to mean, e.g. `分镜师`. */
  name: string;
};

export type MentionParse = {
  mentions: string[];
  everyone: boolean;
  /** `@token`s that matched no roster name and no lenient name. */
  unresolved: string[];
  /** `@token`s that matched no roster name literally but exactly one lenient name. */
  corrected: MentionCorrection[];
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
 * unambiguous prefix or suffix of one of them; otherwise it is unresolved.
 */
export function parseMentions(
  body: string,
  rosterNames: string[],
  options: MentionOptions = {},
): MentionParse {
  const names = [...new Set(rosterNames)].sort((a, b) => b.length - a.length);
  const lenient = [...new Set(options.lenient ?? [])];
  const mentions: string[] = [];
  const unresolved: string[] = [];
  const corrected: MentionCorrection[] = [];
  let everyone = false;
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "@") {
      i += 1;
      continue;
    }
    const rest = body.slice(i + 1);
    if (rest.startsWith("everyone") && !startsName("everyone", rest, names)) {
      everyone = true;
      i += 1 + "everyone".length;
      continue;
    }
    const hit = names.find((name) => rest.startsWith(name));
    if (hit) {
      if (!mentions.includes(hit)) mentions.push(hit);
      i += 1 + hit.length;
      continue;
    }
    const token = mentionToken(rest);
    if (token && looksLikeMention(body, i, token)) {
      const name = lenientMatch(token, lenient);
      if (name) {
        if (!mentions.includes(name)) mentions.push(name);
        if (!corrected.some((c) => c.token === token)) corrected.push({ token, name });
      } else if (!unresolved.includes(token)) {
        unresolved.push(token);
      }
    }
    i += 1 + token.length;
  }
  return { mentions, everyone, unresolved, corrected };
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
  return hits.length === 1 ? hits[0] : null;
}

/**
 * `@` glued to an ASCII word (`user@host.com`) or opening an npm-style scope
 * (`@scope/pkg`) is not an attempt to mention anyone.
 */
export function looksLikeMention(body: string, at: number, token: string): boolean {
  const prev = at > 0 ? body[at - 1] : "";
  if (/[A-Za-z0-9_]/.test(prev)) return false;
  return body[at + 1 + token.length] !== "/";
}

function startsName(literal: string, rest: string, names: string[]): boolean {
  return names.some((name) => name !== literal && name.startsWith(literal) && rest.startsWith(name));
}
