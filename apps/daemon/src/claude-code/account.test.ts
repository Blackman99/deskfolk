import { expect, test } from "bun:test";
import { loginCommand, normalizeConfigDir, tildeDir, tooWideForConfigDir, withConfigDir } from "./account";

const mac = { home: "/Users/a", platform: "darwin" as const };
const win = { home: "C:\\Users\\a", platform: "win32" as const };

test("a config directory is kept absolute, ~ expanded, without a trailing slash; anything relative is refused", () => {
  expect(normalizeConfigDir("~/.claude-b", mac)).toBe("/Users/a/.claude-b");
  expect(normalizeConfigDir(" /Users/a/.claude/ ", mac)).toBe("/Users/a/.claude");
  expect(normalizeConfigDir("/Users/a/x/../.claude-b", mac)).toBe("/Users/a/.claude-b");
  expect(normalizeConfigDir("~", mac)).toBe("/Users/a");
  for (const raw of ["", ".claude-b", "~user/.claude", "C:\\x"]) expect(normalizeConfigDir(raw, mac)).toBeNull();
  expect(normalizeConfigDir("~\\.claude-b", win)).toBe("C:\\Users\\a\\.claude-b");
  expect(normalizeConfigDir("c:/Users/a/.claude-b/", win)).toBe("c:\\Users\\a\\.claude-b");
  expect(normalizeConfigDir("\\\\server\\share\\claude", win)).toBe("\\\\server\\share\\claude");
  for (const raw of ["\\claude", "C:claude", "/c/Users/a/.claude-b"]) expect(normalizeConfigDir(raw, win)).toBeNull();
});

test("the root, your home folder and anything above it cannot be an account's directory", () => {
  for (const dir of ["/", "/Users", "/Users/a"]) expect(tooWideForConfigDir(dir, mac)).toBe(true);
  expect(tooWideForConfigDir("/Users/a/.claude-b", mac)).toBe(false);
  expect(tooWideForConfigDir("/opt/claude", mac)).toBe(false);
  for (const dir of ["C:\\", "c:\\users", "C:\\Users\\A"]) expect(tooWideForConfigDir(dir, win)).toBe(true);
  expect(tooWideForConfigDir("C:\\Users\\a\\.claude-b", win)).toBe(false);
});

test("no directory keeps the variable, the default one unsets it, any other sets it", () => {
  const env = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/Users/a/.claude-b" };
  expect(withConfigDir(env, undefined, mac)).toEqual(env);
  expect(withConfigDir(env, null, mac)).toEqual(env);
  // Named, ~/.claude would make Claude Code look for another keychain item and read as signed out.
  const own = withConfigDir(env, "/Users/a/.claude", mac);
  expect(own).toEqual({ PATH: "/usr/bin" });
  expect("CLAUDE_CONFIG_DIR" in own).toBe(false);
  expect(withConfigDir({ PATH: "/usr/bin" }, "/Users/a/.claude-b", mac)).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/Users/a/.claude-b" });
  // Windows reads the name in any case, and the default directory in any case too.
  expect(withConfigDir({ Claude_Config_Dir: "D:\\x", Path: "C:\\bin" }, "c:\\users\\a\\.CLAUDE", win)).toEqual({ Path: "C:\\bin" });
  expect(withConfigDir({ Claude_Config_Dir: "D:\\x" }, "D:\\claude-b", win)).toEqual({ CLAUDE_CONFIG_DIR: "D:\\claude-b" });
});

test("a directory under your home folder is shown with ~", () => {
  expect(tildeDir("/Users/a/.claude-b", mac)).toBe("~/.claude-b");
  expect(tildeDir("/opt/claude", mac)).toBe("/opt/claude");
  expect(tildeDir("C:\\Users\\a\\.claude-b", win)).toBe("~\\.claude-b");
});

test("the sign-in command sets the variable for a listed directory, and unsets it for ~/.claude itself", () => {
  expect(loginCommand(null, mac)).toBe("claude auth login");
  expect(loginCommand("/Users/a/.claude", mac)).toBe("env -u CLAUDE_CONFIG_DIR claude auth login");
  expect(loginCommand("/Users/a/.claude-b", mac)).toBe("CLAUDE_CONFIG_DIR=/Users/a/.claude-b claude auth login");
  expect(loginCommand("/Users/a/My Claude's", mac)).toBe("CLAUDE_CONFIG_DIR='/Users/a/My Claude'\\''s' claude auth login");
  expect(loginCommand("D:\\claude-b", win)).toBe("$env:CLAUDE_CONFIG_DIR = 'D:\\claude-b'; claude auth login");
  expect(loginCommand("C:\\Users\\a\\.claude", win)).toContain("Remove-Item Env:CLAUDE_CONFIG_DIR");
});
