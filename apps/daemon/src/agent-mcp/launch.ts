/**
 * The command a stdio-only agent starts to reach the app's tools (ADR 0079): the daemon itself in
 * its `--agent-mcp` mode, as `data-query/runner.ts` starts `--query-data` — the compiled binary
 * with the flag, or Bun running `main.ts` in development. The URL and token come in the
 * environment the agent passes on, never on the command line.
 */
import { fileURLToPath } from "node:url";

export function agentMcpShim(): { command: string; args: string[] } {
  const main = fileURLToPath(new URL("../main.ts", import.meta.url));
  // Bun's compiled binaries load their sources from the `$bunfs` virtual root.
  const compiled = main.includes("$bunfs") || main.startsWith("/$bunfs") || /[\\/]~BUN[\\/]/.test(main);
  return compiled ? { command: process.execPath, args: ["--agent-mcp"] } : { command: process.execPath, args: [main, "--agent-mcp"] };
}
