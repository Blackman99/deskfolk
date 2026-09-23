import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureZshIntegration, macSystemLocale, terminalEnv } from "./terminal-env";

test("only the whitelist passes through, never the rest of the daemon's own env", () => {
  const env = terminalEnv(
    { PATH: "/bin", HOME: "/Users/x", ANTHROPIC_API_KEY: "sk-secret", REAL_BOT_TOKEN: "topsecret" },
    { shell: "/bin/bash" },
  );
  expect(env.PATH).toBe("/bin");
  expect(env.HOME).toBe("/Users/x");
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.REAL_BOT_TOKEN).toBeUndefined();
  expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
});

test("PATH falls back when the source has none", () => {
  const env = terminalEnv({}, { shell: "/bin/zsh" });
  expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
});

test("USER and LOGNAME fall back to the given username, but only when absent", () => {
  const withoutUser = terminalEnv({}, { shell: "/bin/zsh", username: "dongsheng" });
  expect(withoutUser.USER).toBe("dongsheng");
  expect(withoutUser.LOGNAME).toBe("dongsheng");

  const withUser = terminalEnv({ USER: "someoneelse", LOGNAME: "someoneelse" }, { shell: "/bin/zsh", username: "dongsheng" });
  expect(withUser.USER).toBe("someoneelse");
  expect(withUser.LOGNAME).toBe("someoneelse");

  const neither = terminalEnv({}, { shell: "/bin/zsh" });
  expect(neither.USER).toBeUndefined();
  expect(neither.LOGNAME).toBeUndefined();
});

test("sets a real TERM and identifies itself, the way Terminal.app does", () => {
  const env = terminalEnv({}, { shell: "/bin/bash" });
  expect(env.SHELL).toBe("/bin/bash");
  expect(env.TERM).toBe("xterm-256color");
  expect(env.COLORTERM).toBe("truecolor");
  expect(env.TERM_PROGRAM).toBe("RealBot");
});

test("LANG/LC_ALL already in the source are left alone", () => {
  const lang = terminalEnv({ LANG: "fr_FR.UTF-8" }, { shell: "/bin/zsh", systemLocale: "zh_CN" });
  expect(lang.LANG).toBe("fr_FR.UTF-8");

  const lcAll = terminalEnv({ LC_ALL: "fr_FR.UTF-8" }, { shell: "/bin/zsh", systemLocale: "zh_CN" });
  expect(lcAll.LANG).toBeUndefined();
  expect(lcAll.LC_ALL).toBe("fr_FR.UTF-8");
});

test("LANG is derived from the system locale when neither is in the source", () => {
  const env = terminalEnv({}, { shell: "/bin/zsh", systemLocale: "zh_CN", localeAvailable: (name) => name === "zh_CN" });
  expect(env.LANG).toBe("zh_CN.UTF-8");
});

test("an unavailable locale falls back to en_US.UTF-8", () => {
  const env = terminalEnv({}, { shell: "/bin/zsh", systemLocale: "zh_CN", localeAvailable: () => false });
  expect(env.LANG).toBe("en_US.UTF-8");
});

test("no system locale at all falls back to en_US.UTF-8", () => {
  const env = terminalEnv({}, { shell: "/bin/zsh", systemLocale: null, localeAvailable: () => true });
  expect(env.LANG).toBe("en_US.UTF-8");
});

test("a currency/variant suffix is dropped before the locale is looked up", () => {
  let seen: string | undefined;
  terminalEnv({}, { shell: "/bin/zsh", systemLocale: "en_CN@currency=JPY", localeAvailable: (name) => { seen = name; return true; } });
  expect(seen).toBe("en_CN");
});

test("a script subtag between language and region is dropped", () => {
  let seen: string | undefined;
  terminalEnv({}, { shell: "/bin/zsh", systemLocale: "zh-Hans_CN", localeAvailable: (name) => { seen = name; return true; } });
  expect(seen).toBe("zh_CN");
});

test("zsh gets ZDOTDIR pointed at the integration dir, other shells do not", () => {
  const zsh = terminalEnv({}, { shell: "/bin/zsh", zshIntegrationDir: "/data/shell-integration/zsh" });
  expect(zsh.ZDOTDIR).toBe("/data/shell-integration/zsh");

  const bash = terminalEnv({}, { shell: "/bin/bash", zshIntegrationDir: "/data/shell-integration/zsh" });
  expect(bash.ZDOTDIR).toBeUndefined();

  const noDir = terminalEnv({}, { shell: "/bin/zsh", zshIntegrationDir: null });
  expect(noDir.ZDOTDIR).toBeUndefined();
});

test("the user's own ZDOTDIR is preserved under REAL_BOT_ZSH_ZDOTDIR only when they had one", () => {
  const hadOne = terminalEnv({ ZDOTDIR: "/Users/x/.config/zsh" }, { shell: "/bin/zsh", zshIntegrationDir: "/data/shell-integration/zsh" });
  expect(hadOne.REAL_BOT_ZSH_ZDOTDIR).toBe("/Users/x/.config/zsh");

  const hadNone = terminalEnv({}, { shell: "/bin/zsh", zshIntegrationDir: "/data/shell-integration/zsh" });
  expect(hadNone.REAL_BOT_ZSH_ZDOTDIR).toBeUndefined();
});

let scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "real-bot-zshenv-"));
  scratchDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs = [];
});

test("ensureZshIntegration writes .zshenv under <dataDir>/shell-integration/zsh and returns that dir", () => {
  const dataDir = scratch();
  const dir = ensureZshIntegration(dataDir);
  expect(dir).toBe(join(dataDir, "shell-integration", "zsh"));
  const content = readFileSync(join(dir!, ".zshenv"), "utf8");
  expect(content).toContain("Real Bot shell integration");
  expect(content).toContain("REAL_BOT_ZSH_ZDOTDIR");
  expect(content).toContain("add-zsh-hook precmd _real_bot_report_cwd");
});

test("ensureZshIntegration does not rewrite the file when the content has not changed", async () => {
  const dataDir = scratch();
  const dir = ensureZshIntegration(dataDir)!;
  const file = join(dir, ".zshenv");
  const before = statSync(file).mtimeMs;
  await Bun.sleep(10); // mtime has millisecond resolution; give a real rewrite room to show up
  ensureZshIntegration(dataDir);
  expect(statSync(file).mtimeMs).toBe(before);
});

test("ensureZshIntegration rewrites a file whose content has drifted", () => {
  const dataDir = scratch();
  const dir = ensureZshIntegration(dataDir)!;
  const file = join(dir, ".zshenv");
  writeFileSync(file, "# tampered\n");
  ensureZshIntegration(dataDir);
  expect(readFileSync(file, "utf8")).toContain("Real Bot shell integration");
});

test("ensureZshIntegration returns null rather than throwing when it cannot write", () => {
  const dataDir = scratch();
  const blocked = join(dataDir, "blocked");
  writeFileSync(blocked, "not a directory");
  // shell-integration/zsh cannot be created under a path component that is a plain file.
  expect(ensureZshIntegration(blocked)).toBeNull();
});

test("macSystemLocale is cached: repeated calls return the same value without re-spawning", () => {
  const original = Bun.spawnSync;
  let calls = 0;
  // @ts-expect-error -- swapping in a stub for one test
  Bun.spawnSync = (...args: Parameters<typeof Bun.spawnSync>) => {
    calls++;
    return original(...args);
  };
  try {
    const first = macSystemLocale();
    const second = macSystemLocale();
    expect(second).toBe(first);
    expect(calls).toBeLessThanOrEqual(1);
  } finally {
    Bun.spawnSync = original;
  }
});
