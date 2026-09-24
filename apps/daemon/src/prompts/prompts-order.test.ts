import { describe, expect, test } from "bun:test";
import { builtinTools } from "./index";

describe("builtinTools order", () => {
  test("tool order is pinned", () => {
    expect(builtinTools("zh").map((t) => t.function.name)).toEqual([
      "read_file",
      "write_file",
      "delete_file",
      "list_dir",
      "shell",
      "send_message",
      "create_bot",
      "list_bots",
      "update_profile",
      "list_sessions",
      "create_group",
      "create_direct",
      "add_member",
      "remove_member",
      "ask_user",
      "list_routines",
      "create_routine",
      "update_routine",
      "delete_routine",
      "list_skills",
      "read_skill",
      "create_skill",
      "update_skill",
      "delete_skill",
      "remember",
      "forget",
      "list_endpoints",
      "add_endpoint",
      "update_endpoint",
      "delete_endpoint",
      "list_mcp_servers",
      "add_mcp_server",
      "update_mcp_server",
      "delete_mcp_server",
      "list_annotations",
      "resolve_annotation",
    ]);
  });
});
