import { expect, test } from "bun:test";
import { filterMcpServers, mcpConnectionSummary } from "./mcp-list.ts";

const servers = [
  { id: "files", name: "文件系统", transport: "stdio" as const, command: "npx", url: null },
  { id: "github", name: "GitHub", transport: "http" as const, command: "", url: "https://tools.example/mcp" },
  { id: "clock", name: "Clock", transport: "stdio" as const, command: "/usr/local/bin/bun", url: null },
];

test("empty queries keep every server and preserve list order", () => {
  expect(filterMcpServers(servers, " \n ")).toEqual(servers);
  expect(filterMcpServers([], "github")).toEqual([]);
});

test("search matches names, transports and connection summaries without case sensitivity", () => {
  expect(filterMcpServers(servers, " GITHUB ")).toEqual([servers[1]!]);
  expect(filterMcpServers(servers, "文件")).toEqual([servers[0]!]);
  expect(filterMcpServers(servers, "STDIO")).toEqual([servers[0]!, servers[2]!]);
  expect(filterMcpServers(servers, "TOOLS.EXAMPLE")).toEqual([servers[1]!]);
  expect(filterMcpServers(servers, "/bin/bun")).toEqual([servers[2]!]);
  expect(filterMcpServers(servers, "missing")).toEqual([]);
});

test("summary and search exclude args, headers, and authorization", () => {
  const stdio = { ...servers[0]!, args: ["private-argument"] };
  const http = { ...servers[1]!, headers: [{ name: "X-Secret", value: "private-header" }], auth: "private-auth" };
  expect(mcpConnectionSummary(stdio)).toBe("npx");
  expect(mcpConnectionSummary(http)).toBe("https://tools.example/mcp");
  expect(filterMcpServers([stdio, http], "private")).toEqual([]);
});

test("HTTP summaries tolerate missing URLs", () => {
  expect(mcpConnectionSummary({ ...servers[1]!, url: null })).toBe("");
});
