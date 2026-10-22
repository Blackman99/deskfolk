import type { ClaudeCodeCommand } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";

/**
 * A project session's slash commands (ADR 0098), for its composer's `/`: Claude Code's own and the
 * account's and directory's commands and skills, as the Mac asks them of it. Asked once a page per
 * session, the first time you type `/`; a list that could not be had is asked again the next time.
 */
export type ProjectCommandsState = ClaudeCodeCommand[] | "loading" | "failed";

const commands = $state<Record<string, ProjectCommandsState>>({});

/** Asks for a session's commands, unless they came already or are on their way. */
export function loadProjectCommands(api: Pick<MessengerApi, "projectCommands"> | null, sessionId: string): void {
  const state = commands[sessionId];
  if (!api || state === "loading" || Array.isArray(state)) return;
  commands[sessionId] = "loading";
  // A Mac from before the list answers 404: typed commands still go through.
  Promise.resolve()
    .then(() => api.projectCommands(sessionId))
    .then(
      (list) => {
        commands[sessionId] = Array.isArray(list?.commands) && list.commands.length ? list.commands : "failed";
      },
      () => {
        commands[sessionId] = "failed";
      },
    );
}

/** The session's commands once they came, or where the asking is; null before it is asked. */
export function projectCommandsOf(sessionId: string): ProjectCommandsState | null {
  return commands[sessionId] ?? null;
}

/**
 * The command you are typing: the word after a `/` that opens the line, while the caret is still in
 * it (lowercase, `""` for a bare `/`); null for any other line, or once the caret has moved past it.
 */
export function slashQuery(text: string, caret: number): string | null {
  const token = /^\/\S*/.exec(text)?.[0];
  if (!token || caret < 1 || caret > token.length) return null;
  return token.slice(1).toLowerCase();
}

/**
 * The commands a query names, best first: the ones a name of which starts with it (their own,
 * another they go by, or a plugin command's part after its `:`), then the ones with it elsewhere in
 * their name. A bare `/` names them all.
 */
export function matchCommands(list: ClaudeCodeCommand[], query: string): ClaudeCodeCommand[] {
  if (!query) return list;
  const starts = (command: ClaudeCodeCommand) =>
    [command.name, ...command.aliases, ...command.name.split(":").slice(1)].some((name) => name.toLowerCase().startsWith(query));
  const first = list.filter(starts);
  const rest = list.filter((command) => !starts(command) && command.name.toLowerCase().includes(query));
  return [...first, ...rest];
}

/**
 * The line once a command is picked: its first word becomes `/name`, what you wrote after it stays.
 * To run it at once nothing is added; to go on typing, a space follows, and `caret` sits after it.
 */
export function withCommand(text: string, name: string, run: boolean): { text: string; caret: number } {
  const rest = text.slice(/^\/\S*/.exec(text)?.[0].length ?? 0);
  const head = `/${name}`;
  if (run) return { text: head + rest, caret: head.length + rest.length };
  const after = rest.startsWith(" ") ? rest : ` ${rest.trimStart()}`;
  return { text: head + after, caret: head.length + 1 };
}
