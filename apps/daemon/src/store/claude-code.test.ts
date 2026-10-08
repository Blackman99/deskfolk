import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
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

test("the accounts you list are kept absolute, each once; a relative path or your whole home folder is refused", () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  expect(store.claudeCodeConfigDirs()).toEqual([]);
  const b = join(homedir(), ".claude-b");
  expect(store.setClaudeCodeConfigDirs(["~/.claude-b", `${b}/`, "/opt/claude-c/"])).toEqual([b, "/opt/claude-c"]);
  expect(store.claudeCodeConfigDirs()).toEqual([b, "/opt/claude-c"]);
  expect(() => store.setClaudeCodeConfigDirs([".claude-b"])).toThrow("absolute");
  expect(() => store.setClaudeCodeConfigDirs(["~"])).toThrow("home folder");
  expect(() => store.setClaudeCodeConfigDirs(["/"])).toThrow("home folder");
  expect(() => store.setClaudeCodeConfigDirs("~/.claude-b")).toThrow("list");
  expect(() => store.setClaudeCodeConfigDirs(Array.from({ length: 9 }, (_, i) => `/opt/c${i}`))).toThrow("at most");
  expect(store.claudeCodeConfigDirs()).toEqual([b, "/opt/claude-c"]);
  expect(store.setClaudeCodeConfigDirs([])).toEqual([]);
  store.close();
});

test("a Bot runs on a listed account only, only you move it, and its account stays listed while it does", () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  store.setClaudeCodeConfigDirs(["/opt/claude-b"]);
  const { bot } = store.createBot({ name: "zz-acct", duties: "d", boundaries: "b", runner: "claude_code" });
  expect(bot.agent_config_dir).toBeNull();
  expect(() => store.patchBot(bot.id, { agent_config_dir: "/opt/claude-x" })).toThrow("listed in Settings");
  expect(() => store.patchBot(bot.id, { agent_config_dir: "/opt/claude-b" }, bot.id)).toThrow("only the user");
  expect(store.patchBot(bot.id, { agent_config_dir: "/opt/claude-b/" }).agent_config_dir).toBe("/opt/claude-b");
  // The profile sent back whole, account included, is no change — from the Bot too.
  expect(store.patchBot(bot.id, { name: "zz-acct-2", agent_config_dir: "/opt/claude-b" }, bot.id).name).toBe("zz-acct-2");
  expect(() => store.setClaudeCodeConfigDirs([])).toThrow("zz-acct-2");
  expect(store.patchBot(bot.id, { agent_config_dir: null }).agent_config_dir).toBeNull();
  expect(store.setClaudeCodeConfigDirs([])).toEqual([]);
  // The list no longer has it: a new Bot cannot be put on it either.
  expect(() => store.createBot({ name: "zz-acct-3", duties: "d", boundaries: "b", runner: "claude_code", agent_config_dir: "/opt/claude-b" })).toThrow("listed in Settings");
  store.close();
});
