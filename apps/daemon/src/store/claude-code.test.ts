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

test("the model that reads lines can be a Claude model on a listed account; the other choice's keys are cleared", async () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const cloud = await store.createProvider({ name: "Cloud", base_url: "https://api.example.com/v1", api_key: "sk", models: ["small"] });
  store.setClaudeCodeConfigDirs(["/opt/claude-b"]);
  const stored = (key: string) => store.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value;

  expect((await store.patchSettings({ reader_model: { runner: "claude_code", model: "haiku", config_dir: null } })).reader_model)
    .toEqual({ runner: "claude_code", model: "haiku", config_dir: null });
  expect((await store.patchSettings({ reader_model: { runner: "claude_code", model: "claude-haiku-4-5", config_dir: "/opt/claude-b/" } })).reader_model)
    .toEqual({ runner: "claude_code", model: "claude-haiku-4-5", config_dir: "/opt/claude-b" });
  // Kept as chosen, read back from settings with no endpoint to look up.
  expect((await store.settings()).reader_model).toEqual({ runner: "claude_code", model: "claude-haiku-4-5", config_dir: "/opt/claude-b" });
  expect(stored("reader_runner")).toBe("claude_code");
  expect(stored("reader_provider_id")).toBe("");
  // Lines are read on that account: it stays listed until reading moves off it.
  expect(() => store.setClaudeCodeConfigDirs([])).toThrow("lines are read on");

  // Not a Claude model name, an account that is not listed, a runner nobody has.
  await expect(store.patchSettings({ reader_model: { runner: "claude_code", model: "not a model", config_dir: null } })).rejects.toThrow("Claude model name");
  await expect(store.patchSettings({ reader_model: { runner: "claude_code", model: "haiku", config_dir: "/opt/claude-x" } })).rejects.toThrow("listed in Settings");
  await expect(store.patchSettings({ reader_model: { runner: "other", model: "haiku", config_dir: null } })).rejects.toThrow("Claude model name");
  expect((await store.settings()).reader_model).toEqual({ runner: "claude_code", model: "claude-haiku-4-5", config_dir: "/opt/claude-b" });

  // An endpoint's model clears the Claude keys, and null clears everything.
  expect((await store.patchSettings({ reader_model: { provider_id: cloud.id, model: "small" } })).reader_model).toEqual({ provider_id: cloud.id, model: "small" });
  expect(stored("reader_runner")).toBe("");
  expect(stored("reader_config_dir")).toBe("");
  await store.patchSettings({ reader_model: { runner: "claude_code", model: "sonnet", config_dir: null } });
  expect(stored("reader_provider_id")).toBe("");
  expect((await store.patchSettings({ reader_model: null })).reader_model).toBeNull();
  expect([stored("reader_model"), stored("reader_runner"), stored("reader_config_dir"), stored("reader_provider_id")]).toEqual(["", "", "", ""]);
  store.close();
});
