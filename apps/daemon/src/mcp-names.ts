import type { ChatTool } from "./prompts";

export type McpListedTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpServerTools = {
  id: string;
  name: string;
  tools: McpListedTool[];
};

export type MappedMcpTool = {
  serverId: string;
  serverName: string;
  toolName: string;
  modelName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export function sanitizeMcpToken(value: string): string {
  const folded = value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/_+/g, "_");
  return folded.replace(/^_+|_+$/g, "");
}

export function mcpPrefixedName(serverName: string, toolName: string): string {
  const server = sanitizeMcpToken(serverName) || "server";
  const tool = sanitizeMcpToken(toolName) || "tool";
  return `mcp_${server}_${tool}`;
}

export function uniquifyMcpName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

function asObjectSchema(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const schema = input as Record<string, unknown>;
    if (schema.type === "object" || schema.type === undefined) return schema;
  }
  return { type: "object" };
}

export function mapMcpTools(servers: McpServerTools[], takenNames: Set<string>): MappedMcpTool[] {
  const taken = new Set(takenNames);
  const mapped: MappedMcpTool[] = [];
  for (const server of servers) {
    for (const tool of server.tools) {
      const modelName = uniquifyMcpName(mcpPrefixedName(server.name, tool.name), taken);
      taken.add(modelName);
      mapped.push({
        serverId: server.id,
        serverName: server.name,
        toolName: tool.name,
        modelName,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: asObjectSchema(tool.inputSchema),
      });
    }
  }
  return mapped;
}

export function mappedMcpChatTools(mapped: MappedMcpTool[]): ChatTool[] {
  return mapped.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.modelName,
      description: tool.description,
      parameters: {
        type: "object",
        ...(tool.inputSchema.type === "object" ? tool.inputSchema : { type: "object" }),
        properties:
          tool.inputSchema.properties && typeof tool.inputSchema.properties === "object"
            ? (tool.inputSchema.properties as Record<string, unknown>)
            : {},
        ...(Array.isArray(tool.inputSchema.required)
          ? { required: tool.inputSchema.required as string[] }
          : {}),
      },
    },
  }));
}
