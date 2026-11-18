import { expect, test } from "bun:test";
import { grokActionKey, grokActionOf, isOwnTool } from "./grok-calls";

test("an MCP tool reached through use_tool, or named by the hook with its input wrapped, is that tool, unread", () => {
  const viaUse = grokActionOf("use_tool", { tool_name: "notes__save", tool_input: { path: "/etc/x", text: "hi" } }, "/p");
  const viaHook = grokActionOf("notes__save", { tool_name: "notes__save", tool_input: { path: "/etc/x", text: "hi" } }, "/p");
  for (const action of [viaUse, viaHook]) expect(action).toEqual({ appName: "other", vendorTool: "mcp__notes__save", paths: [], cwd: "/p" });
  // Looking a tool up changes nothing.
  expect(isOwnTool("search_tool")).toBe(true);
  expect(isOwnTool("use_tool")).toBe(false);
});

test("an approval given late covers that tool and that input only", () => {
  const input = (text: string) => ({ tool_name: "notes__save", tool_input: { text } });
  const save = grokActionKey(grokActionOf("notes__save", input("a"), "/p"), input("a"));
  expect(grokActionKey(grokActionOf("use_tool", input("a"), "/p"), input("a"))).toBe(save);
  expect(grokActionKey(grokActionOf("notes__save", input("b"), "/p"), input("b"))).not.toBe(save);
  const other = { tool_name: "notes__delete", tool_input: { text: "a" } };
  expect(grokActionKey(grokActionOf("notes__delete", other, "/p"), other)).not.toBe(save);
  // Commands and files by what they name, whatever else the input carries.
  expect(grokActionKey(grokActionOf("run_terminal_command", { command: "make", description: "x" }, "/p"), {}))
    .toBe(grokActionKey(grokActionOf("run_terminal_command", { command: "make", description: "y" }, "/p"), {}));
});
