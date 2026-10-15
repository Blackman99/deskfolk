import { describe, expect, test } from "bun:test";
import { isPermissionMode, modeAllowing, permissionClassOf, permissionVerdict } from "./permissions.ts";

describe("permission modes (ADR 0092)", () => {
  test("each mode lets through, asks about or refuses a change and a change to the app's setup", () => {
    expect([permissionVerdict("read_only", "change"), permissionVerdict("read_only", "setup")]).toEqual(["refuse", "refuse"]);
    expect([permissionVerdict("ask_first", "change"), permissionVerdict("ask_first", "setup")]).toEqual(["ask", "ask"]);
    expect([permissionVerdict("auto", "change"), permissionVerdict("auto", "setup")]).toEqual(["allow", "ask"]);
    expect([permissionVerdict("allow_all", "change"), permissionVerdict("allow_all", "setup")]).toEqual(["allow", "allow"]);
  });

  test("a card's kind says which class it is, and which mode stops it asking", () => {
    for (const kind of ["mcp-add", "mcp-edit", "endpoint-add", "endpoint-edit", "prompt-edit"]) {
      expect(permissionClassOf(kind)).toBe("setup");
      expect(modeAllowing(kind)).toBe("allow_all");
    }
    for (const kind of ["file-write", "shell", "agent-permission", "outside-write", null]) {
      expect(permissionClassOf(kind)).toBe("change");
      expect(modeAllowing(kind)).toBe("auto");
    }
  });

  test("only the four names are modes", () => {
    expect(["read_only", "ask_first", "auto", "allow_all"].every(isPermissionMode)).toBe(true);
    expect([null, "", "bypass", "default", 1].some(isPermissionMode)).toBe(false);
  });
});
