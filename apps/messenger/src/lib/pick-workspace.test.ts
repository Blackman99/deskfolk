import { expect, test } from "bun:test";
import type { TauriInternals } from "./tauri.ts";
import {
  parsePickedWorkspacePath,
  pickWorkspaceFolder,
  workspacePickerAvailable,
} from "./pick-workspace.ts";

function fakeInternals(
  handler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): TauriInternals & { calls: Array<{ cmd: string; args?: Record<string, unknown> }> } {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  return {
    calls,
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return handler(cmd, args);
    },
  };
}

test("parsePickedWorkspacePath keeps a non-empty path", () => {
  expect(parsePickedWorkspacePath("/Users/me/ws")).toBe("/Users/me/ws");
  expect(parsePickedWorkspacePath("  /tmp/ws  ")).toBe("/tmp/ws");
});

test("parsePickedWorkspacePath rejects empty or non-string values", () => {
  expect(parsePickedWorkspacePath("")).toBeNull();
  expect(parsePickedWorkspacePath("   ")).toBeNull();
  expect(parsePickedWorkspacePath(null)).toBeNull();
  expect(parsePickedWorkspacePath(undefined)).toBeNull();
});

test("pickWorkspaceFolder invokes the desktop command and returns the path", async () => {
  const internals = fakeInternals(async () => "/Users/me/workspace");
  await expect(pickWorkspaceFolder("~/old", "Choose folder", internals)).resolves.toBe(
    "/Users/me/workspace",
  );
  expect(internals.calls).toEqual([
    { cmd: "pick_workspace_folder", args: { current: "~/old", title: "Choose folder" } },
  ]);
});

test("pickWorkspaceFolder sends null current when the draft is blank", async () => {
  const internals = fakeInternals(async () => null);
  await expect(pickWorkspaceFolder("   ", "选择文件夹", internals)).resolves.toBeNull();
  expect(internals.calls).toEqual([
    { cmd: "pick_workspace_folder", args: { current: null, title: "选择文件夹" } },
  ]);
});

test("pickWorkspaceFolder returns null without tauri internals", async () => {
  await expect(pickWorkspaceFolder("/tmp", "Choose folder", undefined)).resolves.toBeNull();
  await expect(pickWorkspaceFolder("/tmp", "Choose folder", {})).resolves.toBeNull();
});

test("workspacePickerAvailable follows invoke presence", () => {
  expect(workspacePickerAvailable(undefined)).toBe(false);
  expect(workspacePickerAvailable({})).toBe(false);
  expect(workspacePickerAvailable(fakeInternals(async () => null))).toBe(true);
});
