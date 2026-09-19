import type { McpServer } from "@real-bot/protocol";

type McpSummary = Pick<McpServer, "name" | "transport" | "command" | "url">;

export function mcpConnectionSummary(server: McpSummary): string {
  return server.transport === "http" ? (server.url ?? "") : server.command;
}

export function filterMcpServers<T extends McpSummary>(servers: readonly T[], query: string): T[] {
  const term = query.trim().toLowerCase();
  return servers.filter((server) =>
    !term || [server.name, server.transport, mcpConnectionSummary(server)]
      .some((value) => value.toLowerCase().includes(term)),
  );
}
