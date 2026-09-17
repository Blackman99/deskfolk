export type MentionParse = {
  mentions: string[];
  everyone: boolean;
  unresolved: string[];
};

/** Longest roster-name match after `@`, plus the literal `@everyone`. */
export function parseMentions(body: string, rosterNames: string[]): MentionParse {
  const names = [...new Set(rosterNames)].sort((a, b) => b.length - a.length);
  const mentions: string[] = [];
  const unresolved: string[] = [];
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
    const token = unresolvedToken(rest);
    if (token && !unresolved.includes(token)) unresolved.push(token);
    i += 1 + (token?.length ?? 0);
  }
  return { mentions, everyone, unresolved };
}

function startsName(literal: string, rest: string, names: string[]): boolean {
  return names.some((name) => name !== literal && name.startsWith(literal) && rest.startsWith(name));
}

function unresolvedToken(rest: string): string {
  const match = rest.match(/^[^\s@]+/);
  return match?.[0] ?? "";
}
