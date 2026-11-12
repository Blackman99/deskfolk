/**
 * What a project session's command takes after its name, offered under the `/` list as the list
 * offers commands (ADR 0098). Claude Code writes the choices a command's first argument has into its
 * argument hint: `[fable|opus|sonnet|off]` for /advisor, `[on|off]` for /fast, `[low|medium|high|xhigh|max]`
 * ahead of the rest of /code-review's. Those choices are offered once the command's name is in and the
 * caret is in its first argument; a hint that names none (`<file>`, `[instructions]`) offers nothing,
 * and neither does an argument no choice starts with: what you type then is sent as it stands.
 */
import type { ClaudeCodeCommand } from "@real-bot/protocol";

/** A choice as hints write it: a word, a flag, or a `name:part`. Placeholders (`<tokens>`) and phrases are not. */
const CHOICE = /^-{0,2}[A-Za-z0-9][\w.:-]*$/;

/**
 * The words a command's first argument can be, read from its hint: the alternatives of its first
 * group (`[a|b|c]`, or a bare `a | b`), each by its first word (`disable [<server>|all]` gives
 * `disable`). Empty when the group has no alternatives (`[name]`, `<file>`, `key=value`).
 */
export function argumentOptions(hint: string): string[] {
  const text = hint.trim();
  let group = text;
  if (text.startsWith("[")) {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "[") depth++;
      else if (text[i] === "]" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) return [];
    group = text.slice(1, end);
  }
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < group.length; i++) {
    const c = group[i]!;
    if (c === "[" || c === "<" || c === "(") depth++;
    else if (c === "]" || c === ">" || c === ")") depth--;
    else if (c === "|" && depth === 0) {
      parts.push(group.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(group.slice(start));
  if (parts.length < 2) return [];
  const words = parts.map((part) => part.trim().split(/\s+/)[0] ?? "").filter((word) => CHOICE.test(word));
  return [...new Set(words)];
}

/** The first argument being typed: the command it belongs to, what is typed of it, and where it sits in the line. */
export type ArgumentQuery = { command: ClaudeCodeCommand; options: string[]; query: string; from: number; to: number };

/**
 * The argument you are typing: a line `/name …` whose command is known (by its name or another it
 * goes by) and offers choices, with the caret in the word after the name. Null otherwise, and while
 * the caret is still in the name (the command list's turn).
 */
export function argumentQuery(text: string, caret: number, commands: readonly ClaudeCodeCommand[]): ArgumentQuery | null {
  const found = /^\/(\S+)( +)(\S*)/.exec(text);
  if (!found) return null;
  const name = found[1]!.toLowerCase();
  const from = 1 + found[1]!.length + found[2]!.length;
  const to = from + found[3]!.length;
  if (caret < from || caret > to) return null;
  const command = commands.find((row) => row.name.toLowerCase() === name || row.aliases.some((alias) => alias.toLowerCase() === name));
  if (!command) return null;
  const options = argumentOptions(command.argument_hint);
  if (!options.length) return null;
  return { command, options, query: found[3]!, from, to };
}

/**
 * The choices that fit what is typed, in the hint's order: those that start with it. None when the
 * typed word already is the one choice that fits, so the line is sent as it stands.
 */
export function matchArguments(found: ArgumentQuery): string[] {
  const query = found.query.toLowerCase();
  const fits = found.options.filter((option) => option.toLowerCase().startsWith(query));
  return fits.length === 1 && fits[0]!.toLowerCase() === query ? [] : fits;
}

/** The line once a choice is picked: it takes the typed word's place; the caret goes after it. */
export function withArgument(text: string, found: ArgumentQuery, value: string): { text: string; caret: number } {
  return { text: text.slice(0, found.from) + value + text.slice(found.to), caret: found.from + value.length };
}

/** Whether picking this command should go on to its choices rather than send it bare. */
export function takesChoices(command: ClaudeCodeCommand): boolean {
  return argumentOptions(command.argument_hint).length > 0;
}
