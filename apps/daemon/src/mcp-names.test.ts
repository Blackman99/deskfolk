import { describe, expect, test } from "bun:test";
import { mapMcpTools, mcpPrefixedName, sanitizeMcpToken, uniquifyMcpName } from "./mcp-names";

describe("MCP model-side names", () => {
  test("prefix is mcp_server_tool and illegal characters fold to compressed underscores", () => {
    expect(sanitizeMcpToken("probe")).toBe("probe");
    expect(sanitizeMcpToken("a-b")).toBe("a_b");
    expect(sanitizeMcpToken("a--b!!c")).toBe("a_b_c");
    expect(mcpPrefixedName("time-server", "get-time")).toBe("mcp_time_server_get_time");
  });

  test("collisions with a taken name or another mapped tool add _2 then _3", () => {
    const taken = new Set(["mcp_alpha_echo"]);
    expect(uniquifyMcpName("mcp_alpha_echo", taken)).toBe("mcp_alpha_echo_2");
    taken.add("mcp_alpha_echo_2");
    expect(uniquifyMcpName("mcp_alpha_echo", taken)).toBe("mcp_alpha_echo_3");
  });

  test("two servers whose folded names collide get a suffix on the later one", () => {
    const mapped = mapMcpTools(
      [
        {
          id: "1",
          name: "a-b",
          tools: [{ name: "c", description: "one", inputSchema: { type: "object" } }],
        },
        {
          id: "2",
          name: "a",
          tools: [{ name: "b_c", description: "two", inputSchema: { type: "object" } }],
        },
      ],
      new Set(["send_message"]),
    );
    expect(mapped.map((t) => t.modelName)).toEqual(["mcp_a_b_c", "mcp_a_b_c_2"]);
    expect(mapped[0]?.toolName).toBe("c");
    expect(mapped[1]?.toolName).toBe("b_c");
  });

  test("a collision with a builtin name also suffixes", () => {
    const mapped = mapMcpTools(
      [
        {
          id: "1",
          name: "x",
          tools: [{ name: "send_message", inputSchema: { type: "object" } }],
        },
      ],
      new Set(["mcp_x_send_message"]),
    );
    expect(mapped[0]?.modelName).toBe("mcp_x_send_message_2");
  });

  test("missing inputSchema becomes a bare object schema", () => {
    const mapped = mapMcpTools(
      [{ id: "1", name: "probe", tools: [{ name: "echo" }] }],
      new Set(),
    );
    expect(mapped[0]?.inputSchema).toEqual({ type: "object" });
    expect(mapped[0]?.description).toBe("");
  });
});
