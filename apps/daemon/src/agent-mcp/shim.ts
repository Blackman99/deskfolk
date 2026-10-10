/**
 * `--agent-mcp`: an MCP server on stdin and stdout for an agent that only speaks stdio MCP (ADR
 * 0079), passing each JSON-RPC message on to the app's tools at `DESKFOLK_AGENT_MCP_URL` and each
 * answer back. Nothing of the daemon starts in this process; it ends when the agent closes stdin or
 * the segment's token is gone.
 */
import { AGENT_MCP_URL_ENV } from "./bridge";

export async function runAgentMcpShim(): Promise<void> {
  const url = process.env[AGENT_MCP_URL_ENV];
  if (!url) {
    process.stderr.write(`${AGENT_MCP_URL_ENV} is not set\n`);
    process.exit(2);
  }
  const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let buffer = "";
  const forward = async (line: string) => {
    let message: { id?: unknown; method?: string };
    try {
      message = JSON.parse(line) as { id?: unknown; method?: string };
    } catch {
      return;
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: line,
      });
      if (response.status === 404) {
        if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "this segment has ended" } });
        return;
      }
      const text = await response.text();
      if (!text.trim()) return;
      const answers = text.trim().startsWith("[") ? (JSON.parse(text) as unknown[]) : [JSON.parse(text) as unknown];
      for (const answer of answers) write(answer);
    } catch (error) {
      if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      // Calls may wait on you for a long time; each goes on its own, answers in whatever order they come.
      if (line) void forward(line);
    }
  });
  await new Promise<void>((resolve) => process.stdin.once("end", () => resolve()));
}
