import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { locateClaudeCode } from "./locate";
import { AGENT_SDK_CLAUDE_CODE_VERSION, claudeChildEnv, compareVersions, describeClaudeCode, parseAuthStatus, parseVersion } from "./status";
import { createClaudeCodeProbe } from "./probe";

const executable = (paths: string[]) => (path: string) => paths.includes(path);

test("the path set in Settings wins, and a wrong one says so instead of searching on", async () => {
  const found = await locateClaudeCode({ setting: "~/bin/claude", env: { PATH: "/usr/bin" }, home: "/Users/a", platform: "darwin",
    isExecutable: executable(["/Users/a/bin/claude", "/usr/local/bin/claude"]), which: () => null });
  expect(found.found).toEqual({ path: "/Users/a/bin/claude", source: "setting" });
  const wrong = await locateClaudeCode({ setting: "/nope/claude", env: {}, home: "/Users/a", platform: "darwin",
    isExecutable: executable(["/usr/local/bin/claude"]), which: () => null });
  expect(wrong.found).toBeNull();
  expect(wrong.error).toContain("/nope/claude");
});

test("then the daemon's PATH, then where installers put it, then the login shell", async () => {
  const onPath = await locateClaudeCode({ setting: null, env: { PATH: "/opt/x" }, home: "/Users/a", platform: "darwin",
    isExecutable: executable(["/opt/x/claude"]), which: (name, path) => (path === "/opt/x" ? `/opt/x/${name}` : null) });
  expect(onPath.found).toEqual({ path: "/opt/x/claude", source: "path" });
  const known = await locateClaudeCode({ setting: null, env: { PATH: "/usr/bin:/bin" }, home: "/Users/a", platform: "darwin",
    isExecutable: executable(["/Users/a/.local/bin/claude"]), which: () => null, loginShell: async () => null });
  expect(known.found).toEqual({ path: "/Users/a/.local/bin/claude", source: "known" });
  const shell = await locateClaudeCode({ setting: null, env: { PATH: "/usr/bin", SHELL: "/bin/zsh" }, home: "/Users/a", platform: "darwin",
    isExecutable: executable(["/Users/a/tools/claude"]), which: () => null, loginShell: async () => "/Users/a/tools/claude" });
  expect(shell.found).toEqual({ path: "/Users/a/tools/claude", source: "login_shell" });
  const none = await locateClaudeCode({ setting: null, env: {}, home: "/Users/a", platform: "darwin",
    isExecutable: () => false, which: () => null, loginShell: async () => null });
  expect(none.found).toBeNull();
});

test("on Windows: npm's claude.cmd on PATH counts, ~\\ is your home, the installers' places next, and no login shell", async () => {
  const noShell = async () => {
    throw new Error("Windows has no login shell to ask");
  };
  const onPath = await locateClaudeCode({ setting: null, env: { Path: "C:\\nvm\\v24" }, home: "C:\\Users\\me", platform: "win32",
    isExecutable: executable(["C:\\nvm\\v24\\claude.cmd"]), which: (name, path) => (name === "claude" && path === "C:\\nvm\\v24" ? "C:\\nvm\\v24\\claude.cmd" : null), loginShell: noShell });
  expect(onPath.found).toEqual({ path: "C:\\nvm\\v24\\claude.cmd", source: "path" });
  const set = await locateClaudeCode({ setting: "~\\tools\\claude.exe", env: {}, home: "C:\\Users\\me", platform: "win32",
    isExecutable: executable(["C:\\Users\\me\\tools\\claude.exe"]), which: () => null, loginShell: noShell });
  expect(set.found).toEqual({ path: "C:\\Users\\me\\tools\\claude.exe", source: "setting" });
  const known = await locateClaudeCode({ setting: null, env: { APPDATA: "D:\\Roaming" }, home: "C:\\Users\\me", platform: "win32",
    isExecutable: executable(["D:\\Roaming\\npm\\claude.cmd"]), which: () => null, loginShell: noShell });
  expect(known.found).toEqual({ path: "D:\\Roaming\\npm\\claude.cmd", source: "known" });
  const none = await locateClaudeCode({ setting: null, env: {}, home: "C:\\Users\\me", platform: "win32", isExecutable: () => false, which: () => null, loginShell: noShell });
  expect(none.found).toBeNull();
  expect(none.error).not.toContain("login shell");
});

test("what Claude Code says about itself is all the card shows; nothing of its credentials is read", async () => {
  const calls: string[][] = [];
  const status = await describeClaudeCode({
    setting: "/c/claude", env: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://proxy.example", CLAUDECODE: "1", REAL_BOT_X: "1" },
    isExecutable: () => true, which: () => null, now: () => new Date(0), systemProxy: async () => null,
    run: async (argv, env) => {
      calls.push(argv);
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.REAL_BOT_X).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
      if (argv[1] === "--version") return { code: 0, stdout: "2.1.200 (Claude Code)\n" };
      return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "a@b.c", orgId: "x" }) };
    },
  });
  expect(calls).toEqual([["/c/claude", "--version"], ["/c/claude", "auth", "status"]]);
  expect(status).toMatchObject({ path: "/c/claude", source: "setting", version: "2.1.200", outdated: true, logged_in: true,
    auth_method: "claude.ai", subscription_type: "max", email: "a@b.c", base_url_set: true, proxy: null, proxy_source: null, error: null });
});

test("with no proxy variables Claude Code is asked through the system proxy, as a turn runs it, and the card says which", async () => {
  const envs: Array<Record<string, string | undefined>> = [];
  const run = async (argv: string[], env: Record<string, string | undefined>) => {
    envs.push(env);
    return argv[1] === "--version" ? { code: 0, stdout: "2.1.289" } : { code: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}' };
  };
  const base = { setting: "/c/claude", isExecutable: () => true, which: () => null, now: () => new Date(0), run };
  const system = async () => "http://127.0.0.1:12334";
  const fromSystem = await describeClaudeCode({ ...base, env: { PATH: "/usr/bin" }, systemProxy: system });
  expect(fromSystem).toMatchObject({ proxy: "http://127.0.0.1:12334", proxy_source: "system" });
  expect(envs.map((env) => env.HTTPS_PROXY)).toEqual(["http://127.0.0.1:12334", "http://127.0.0.1:12334"]);
  envs.length = 0;
  const fromEnv = await describeClaudeCode({ ...base, env: { PATH: "/usr/bin", HTTPS_PROXY: "http://me:pw@10.0.0.2:8080" }, systemProxy: system });
  expect(fromEnv).toMatchObject({ proxy: "http://***@10.0.0.2:8080", proxy_source: "env" });
  expect(envs.map((env) => env.HTTPS_PROXY)).toEqual(["http://me:pw@10.0.0.2:8080", "http://me:pw@10.0.0.2:8080"]);
});

test("signed out reads as signed out; an unreadable answer leaves it unknown", () => {
  expect(parseAuthStatus('{"loggedIn": false, "authMethod": "none"}')).toEqual({ loggedIn: false, authMethod: "none", subscriptionType: null, email: null, configDirectory: null });
  expect(parseAuthStatus('{"loggedIn": true, "configDirectory": "/Users/a/.claude-b"}')).toMatchObject({ configDirectory: "/Users/a/.claude-b" });
  expect(parseAuthStatus("not json")).toBeNull();
  expect(parseVersion("2.1.289 (Claude Code)")).toBe("2.1.289");
  expect(compareVersions("2.1.90", "2.1.289")).toBeLessThan(0);
});

test("the environment keeps every way Claude Code signs in", () => {
  const env = claudeChildEnv({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x", CLAUDE_PID: "1", REAL_BOT_DATA_DIR: "/d", PATH: "/usr/bin" });
  expect(env).toEqual({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", PATH: "/usr/bin" });
});

test("every account is asked on its own: the daemon's environment as it is, ~/.claude with the variable unset, others with it set", async () => {
  const asked: Array<string | undefined> = [];
  const emails: Record<string, string> = { "": "pro@a.c", "/Users/a/.claude-b": "team@a.c" };
  const status = await describeClaudeCode({
    setting: "/c/claude", isExecutable: () => true, which: () => null, now: () => new Date(0), systemProxy: async () => null,
    // A daemon started from a shell that picked the second account.
    env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/Users/a/.claude-b" },
    configDirs: ["/Users/a/.claude", "/Users/a/.claude-b", "/Users/a/.claude-c", "/Users/a/.claude-typo"],
    accountHost: { home: "/Users/a", platform: "darwin" },
    dirExists: (dir) => dir !== "/Users/a/.claude-typo",
    run: async (argv, env) => {
      if (argv[1] === "--version") return { code: 0, stdout: "2.1.294" };
      asked.push(env.CLAUDE_CONFIG_DIR);
      const dir = env.CLAUDE_CONFIG_DIR ?? "/Users/a/.claude";
      if (dir === "/Users/a/.claude-c") return { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none", configDirectory: dir }) };
      return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: dir.endsWith("-b") ? "team" : "pro",
        email: emails[env.CLAUDE_CONFIG_DIR === "/Users/a/.claude-b" ? "/Users/a/.claude-b" : ""], configDirectory: dir }) };
    },
  });
  expect(asked).toEqual(["/Users/a/.claude-b", undefined, "/Users/a/.claude-b", "/Users/a/.claude-c"]);
  expect(status.accounts).toEqual([
    { config_dir: null, config_directory: "/Users/a/.claude-b", logged_in: true, auth_method: "claude.ai", subscription_type: "team", email: "team@a.c", error: null, login_command: "claude auth login" },
    { config_dir: "/Users/a/.claude", config_directory: "/Users/a/.claude", logged_in: true, auth_method: "claude.ai", subscription_type: "pro", email: "pro@a.c", error: null,
      login_command: "env -u CLAUDE_CONFIG_DIR claude auth login" },
    { config_dir: "/Users/a/.claude-b", config_directory: "/Users/a/.claude-b", logged_in: true, auth_method: "claude.ai", subscription_type: "team", email: "team@a.c", error: null,
      login_command: "CLAUDE_CONFIG_DIR=/Users/a/.claude-b claude auth login" },
    { config_dir: "/Users/a/.claude-c", config_directory: "/Users/a/.claude-c", logged_in: false, auth_method: "none", subscription_type: null, email: null, error: null,
      login_command: "CLAUDE_CONFIG_DIR=/Users/a/.claude-c claude auth login" },
    // Not there: signed out without asking, since claude would make the directory.
    { config_dir: "/Users/a/.claude-typo", config_directory: "/Users/a/.claude-typo", logged_in: false, auth_method: "none", subscription_type: null, email: null,
      error: "the directory does not exist yet", login_command: "CLAUDE_CONFIG_DIR=/Users/a/.claude-typo claude auth login" },
  ]);
  // The fields of old are the daemon's own environment's.
  expect(status).toMatchObject({ logged_in: true, subscription_type: "team", email: "team@a.c", error: null });
});

test("the SDK's Claude Code version is the one the installed package was built with", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")) as { claudeCodeVersion?: string };
  expect(pkg.claudeCodeVersion).toBe(AGENT_SDK_CLAUDE_CODE_VERSION);
});

test("the probe asks once at a time and keeps the answer for a while", async () => {
  let asked = 0;
  let clock = 0;
  const probe = createClaudeCodeProbe({
    setting: () => null,
    now: () => clock,
    describe: async () => {
      asked += 1;
      await Bun.sleep(5);
      return { path: "/c", source: "known", version: "1.0.0", sdk_version: "1.0.0", outdated: false, logged_in: true, auth_method: "claude.ai",
        subscription_type: "pro", email: null, base_url_set: false, proxy: null, proxy_source: null, checked_at: "", error: null };
    },
  });
  await Promise.all([probe.current(), probe.current(), probe.detect()]);
  expect(asked).toBe(1);
  clock = 30_000;
  await probe.current();
  expect(asked).toBe(1);
  clock = 61_000;
  await probe.current();
  expect(asked).toBe(2);
});
