/** `cd <dir> &&` (or `;`): where it ran, which every command of a turn starts with. */
const CD_PREFIX = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&]+)\s*(?:&&|;)\s*/;

/**
 * The command as its row shows it: without the leading `cd` that only says where it ran, its
 * lines folded into one. A Bot's `python3 -c "…"` used to show as just `python3 -c "`, and every
 * Claude Agent command as the same clipped workspace path.
 */
export function commandLine(command: string): string {
  let line = command.trim();
  for (let match = CD_PREFIX.exec(line); match; match = CD_PREFIX.exec(line)) {
    line = line.slice(match[0].length).trimStart();
  }
  return (line || command).replace(/\s+/g, " ").trim();
}

/** The program and the rest, so the row can set the program apart. */
export function splitProgram(line: string): { program: string; rest: string } {
  const at = line.search(/\s/);
  return at < 0 ? { program: line, rest: "" } : { program: line.slice(0, at), rest: line.slice(at) };
}
