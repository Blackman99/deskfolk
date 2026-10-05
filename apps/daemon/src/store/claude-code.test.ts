import { expect, test } from "bun:test";
import { memoryKeyStore } from "../secrets";
import { Store } from "./index";

test("the claude path you set is kept when it is absolute, in POSIX or Windows spelling, and refused otherwise", () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  for (const path of ["/Users/me/bin/claude", "~/bin/claude", "C:\\Users\\me\\.local\\bin\\claude.exe", "c:/tools/claude.cmd", "~\\bin\\claude.exe", "\\\\server\\share\\claude.exe"]) {
    expect(store.setClaudeCodePath(path)).toBe(path);
    expect(store.claudeCodePath()).toBe(path);
  }
  for (const path of ["claude", "bin/claude", "C:claude.exe", "\\claude.exe", "\\\\server"]) {
    expect(() => store.setClaudeCodePath(path)).toThrow("absolute");
  }
  expect(store.setClaudeCodePath("")).toBeNull();
  expect(store.claudeCodePath()).toBeNull();
  store.close();
});
