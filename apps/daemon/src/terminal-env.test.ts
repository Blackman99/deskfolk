import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CwdTracker } from "./terminal-cwd";
import { BASH_CWD_FUNCTION, ensureZshIntegration, macSystemLocale, terminalEnv } from "./terminal-env";

test("only the whitelist passes through, never the rest of the daemon's own env", () => {
  const env = terminalEnv(
    { PATH: "/bin", HOME: "/Users/x", ANTHROPIC_API_KEY: "sk-secret", REAL_BOT_TOKEN: "topsecret" },
    { shell: "/bin/bash", platform: "darwin" },
  );
  expect(env.PATH).toBe("/bin");
  expect(env.HOME).toBe("/Users/x");
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.REAL_BOT_TOKEN).toBeUndefined();
  expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
});

test("PATH falls back when the source has none", () => {
  const env = terminalEnv({}, { shell: "/bin/zsh", platform: "darwin" });
  expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
});

test("USER and LOGNAME fall back to the given username, but only when absent", () => {
  const withoutUser = terminalEnv({}, { shell: "/bin/zsh", platform: "darwin", username: "dongsheng" });
  expect(withoutUser.USER).toBe("dongsheng");
  expect(withoutUser.LOGNAME).toBe("dongsheng");

  const withUser = terminalEnv({ USER: "someoneelse", LOGNAME: "someoneelse" }, { shell: "/bin/zsh", platform: "darwin", username: "dongsheng" });
  expect(withUser.USER).toBe("someoneelse");
  expect(withUser.LOGNAME).toBe("someoneelse");

  const neither = terminalEnv({}, { shell: "/bin/zsh", platform: "darwin" });
  expect(neither.USER).toBeUndefined();
  expect(neither.LOGNAME).toBeUndefined();
});

test("sets a real TERM and identifies itself, the way Terminal.app does", () => {
  const env = terminalEnv({}, { shell: "/bin/bash", platform: "darwin" });
  expect(env.SHELL).toBe("/bin/bash");
  expect(env.TERM).toBe("xterm-256color");
  expect(env.COLORTERM).toBe("truecolor");
  expect(env.TERM_PROGRAM).toBe("Deskfolk");
});

test("LANG/LC_ALL already in the source are left alone", () => {
  const lang = terminalEnv({ LANG: "fr_FR.UTF-8" }, { shell: "/bin/zsh", platform: "darwin", systemLocale: "zh_CN" });
  expect(lang.LANG).toBe("fr_FR.UTF-8");

  const lcAll = terminalEnv({ LC_ALL: "fr_FR.UTF-8" }, { shell: "/bin/zsh", platform: "darwin", systemLocale: "zh_CN" });
  expect(lcAll.LANG).toBeUndefined();
  expect(lcAll.LC_ALL).toBe("fr_FR.UTF-8");
});

test("LANG is derived from the system locale when neither is in the source", () => {
  const env = terminalEnv({}, { shell: "/bin/zsh", platform: "darwin", systemLocale: "zh_CN", localeAvailable: (name) => name === "zh_CN" });
  expect(env.LANG).toBe("zh_CN.UTF-8");
});

test("an unavailable locale falls back to en_US.UTF-8", () => {
  const env = terminalEnv({}, { shell: "/bin/zsh", platform: "darwin", systemLocale: "zh_CN", localeAvailable: () => false });
  expect(env.LANG).toBe("en_US.UTF-8");
});

test("no system locale at all falls back to en_US.UTF-8", () => {
  const env = terminalEnv({}, { shell: "/bin/zsh", platform: "darwin", systemLocale: null, localeAvailable: () => true });
  expect(env.LANG).toBe("en_US.UTF-8");
});

test("a currency/variant suffix is dropped before the locale is looked up", () => {
  let seen: string | undefined;
  terminalEnv({}, { shell: "/bin/zsh", platform: "darwin", systemLocale: "en_CN@currency=JPY", localeAvailable: (name) => { seen = name; return true; } });
  expect(seen).toBe("en_CN");
});

test("a script subtag between language and region is dropped", () => {
  let seen: string | undefined;
  terminalEnv({}, { shell: "/bin/zsh", platform: "darwin", systemLocale: "zh-Hans_CN", localeAvailable: (name) => { seen = name; return true; } });
  expect(seen).toBe("zh_CN");
});

test("zsh gets ZDOTDIR pointed at the integration dir, other shells do not", () => {
  const zsh = terminalEnv({}, { shell: "/bin/zsh", platform: "darwin", zshIntegrationDir: "/data/shell-integration/zsh" });
  expect(zsh.ZDOTDIR).toBe("/data/shell-integration/zsh");

  const bash = terminalEnv({}, { shell: "/bin/bash", platform: "darwin", zshIntegrationDir: "/data/shell-integration/zsh" });
  expect(bash.ZDOTDIR).toBeUndefined();

  const noDir = terminalEnv({}, { shell: "/bin/zsh", platform: "darwin", zshIntegrationDir: null });
  expect(noDir.ZDOTDIR).toBeUndefined();
});

test("the user's own ZDOTDIR is preserved under REAL_BOT_ZSH_ZDOTDIR only when they had one", () => {
  const hadOne = terminalEnv({ ZDOTDIR: "/Users/x/.config/zsh" }, { shell: "/bin/zsh", platform: "darwin", zshIntegrationDir: "/data/shell-integration/zsh" });
  expect(hadOne.REAL_BOT_ZSH_ZDOTDIR).toBe("/Users/x/.config/zsh");

  const hadNone = terminalEnv({}, { shell: "/bin/zsh", platform: "darwin", zshIntegrationDir: "/data/shell-integration/zsh" });
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
  expect(content).toContain("Deskfolk shell integration");
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
  expect(readFileSync(file, "utf8")).toContain("Deskfolk shell integration");
});

test("ensureZshIntegration returns null rather than throwing when it cannot write", () => {
  const dataDir = scratch();
  const blocked = join(dataDir, "blocked");
  writeFileSync(blocked, "not a directory");
  // shell-integration/zsh cannot be created under a path component that is a plain file.
  expect(ensureZshIntegration(blocked)).toBeNull();
});

test("win32 passes through what node/PowerShell need beyond the POSIX whitelist", () => {
  const env = terminalEnv(
    {
      PATH: "C:\\bin",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      ANTHROPIC_API_KEY: "sk-secret",
    },
    { shell: "pwsh.exe", platform: "win32" },
  );
  expect(env.PATH).toBe("C:\\bin");
  expect(env.SystemRoot).toBe("C:\\Windows");
  expect(env.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
  expect(env.APPDATA).toBe("C:\\Users\\me\\AppData\\Roaming");
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
});

test("win32 never injects the POSIX default PATH when PATH is genuinely missing", () => {
  const env = terminalEnv({}, { shell: "pwsh.exe", platform: "win32" });
  expect(env.PATH).toBeUndefined();
});

test("win32 env var names match case-insensitively (a fake env spelled 'Path')", () => {
  const env = terminalEnv({ Path: "C:\\bin", systemroot: "C:\\Windows" }, { shell: "pwsh.exe", platform: "win32" });
  expect(env.PATH).toBe("C:\\bin");
  expect(env.SystemRoot).toBe("C:\\Windows");
});

test("darwin/linux are unaffected by the win32 passthrough list", () => {
  const env = terminalEnv({ SystemRoot: "C:\\Windows", PATH: "/bin" }, { shell: "/bin/zsh", platform: "darwin" });
  expect(env.SystemRoot).toBeUndefined();
  expect(env.PATH).toBe("/bin");
});

test("linux passes the desktop session's variables through, macOS does not", () => {
  const source = { PATH: "/bin", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", XDG_RUNTIME_DIR: "/run/user/1000", XDG_DATA_HOME: "/home/x/.local/share", ANTHROPIC_API_KEY: "sk-secret" };
  const linux = terminalEnv(source, { shell: "/bin/bash", platform: "linux" });
  expect(linux.DISPLAY).toBe(":0");
  expect(linux.WAYLAND_DISPLAY).toBe("wayland-0");
  expect(linux.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
  expect(linux.XDG_RUNTIME_DIR).toBe("/run/user/1000");
  expect(linux.XDG_DATA_HOME).toBe("/home/x/.local/share");
  expect(linux.ANTHROPIC_API_KEY).toBeUndefined();
  const mac = terminalEnv(source, { shell: "/bin/zsh", platform: "darwin" });
  expect(mac.DISPLAY).toBeUndefined();
  expect(mac.XDG_RUNTIME_DIR).toBeUndefined();
});

test("linux gets C.UTF-8 when neither LANG nor LC_ALL is set, and keeps what it was given", () => {
  expect(terminalEnv({}, { shell: "/bin/bash", platform: "linux", systemLocale: "zh_CN", localeAvailable: () => true }).LANG).toBe("C.UTF-8");
  expect(terminalEnv({ LANG: "zh_CN.UTF-8" }, { shell: "/bin/bash", platform: "linux" }).LANG).toBe("zh_CN.UTF-8");
  expect(terminalEnv({ LC_ALL: "de_DE.UTF-8" }, { shell: "/bin/bash", platform: "linux" }).LANG).toBeUndefined();
});

test("bash on linux gets the cwd hook as an exported function, keeping an inherited PROMPT_COMMAND", () => {
  const env = terminalEnv({}, { shell: "/bin/bash", platform: "linux" });
  expect(env["BASH_FUNC__real_bot_report_cwd%%"]).toBe(BASH_CWD_FUNCTION);
  expect(env.PROMPT_COMMAND).toBe("_real_bot_report_cwd");
  const inherited = terminalEnv({ PROMPT_COMMAND: "history -a" }, { shell: "/usr/bin/bash", platform: "linux" });
  expect(inherited.PROMPT_COMMAND).toBe("_real_bot_report_cwd; history -a");
});

test("the bash hook is for bash on linux only", () => {
  const zsh = terminalEnv({}, { shell: "/usr/bin/zsh", platform: "linux" });
  expect(zsh.PROMPT_COMMAND).toBeUndefined();
  expect(Object.keys(zsh).some((key) => key.startsWith("BASH_FUNC_"))).toBe(false);
  const macBash = terminalEnv({}, { shell: "/bin/bash", platform: "darwin" });
  expect(macBash.PROMPT_COMMAND).toBeUndefined();
  expect(Object.keys(macBash).some((key) => key.startsWith("BASH_FUNC_"))).toBe(false);
});

/** A bash new enough to import `BASH_FUNC_<name>%%` (4.4+): Linux's own, or Homebrew's on a Mac. */
function modernBash(): string | null {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"]) {
    if (!existsSync(candidate)) continue;
    const version = Bun.spawnSync([candidate, "-c", "echo ${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"]).stdout.toString().trim();
    const [major = 0, minor = 0] = version.split(".").map(Number);
    if (major > 4 || (major === 4 && minor >= 4)) return candidate;
  }
  return null;
}

const bash = modernBash();

test.skipIf(!bash)("a real bash reports a folder with spaces and CJK in it, and keeps its own locale", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rb-bash-cwd-")));
  try {
    const folder = join(root, "two words", "目录 x");
    mkdirSync(folder, { recursive: true });
    const env = terminalEnv({ PATH: "/usr/bin:/bin", HOME: root, LANG: "en_US.UTF-8" }, { shell: bash!, platform: "linux" });
    const run = Bun.spawnSync([bash!, "--norc", "-i"], {
      cwd: folder, env, stdin: new TextEncoder().encode("x=中文; echo len=${#x}\nexit\n"),
    });
    const out = run.stdout;
    expect(new CwdTracker({ platform: "linux" }).feed(out)).toBe(folder);
    expect(out.toString()).toContain("len=2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!bash)("a startup file that assigns PROMPT_COMMAND outright drops the hook, and nothing breaks", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rb-bash-cwd-")));
  try {
    const rc = join(root, "rc");
    writeFileSync(rc, "PROMPT_COMMAND='printf rc-ran'\n");
    const env = terminalEnv({ PATH: "/usr/bin:/bin", HOME: root }, { shell: bash!, platform: "linux" });
    const run = Bun.spawnSync([bash!, "--rcfile", rc, "-i"], { cwd: root, env, stdin: new TextEncoder().encode("echo after\nexit\n") });
    expect(new CwdTracker({ platform: "linux" }).feed(run.stdout)).toBeNull();
    expect(run.stdout.toString()).toContain("rc-ran");
    expect(run.stdout.toString()).toContain("after");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("win32 gets no injected LANG: its locale lives in the user's settings, not the env", () => {
  const env = terminalEnv({}, { shell: "pwsh.exe", platform: "win32", systemLocale: "zh_CN", localeAvailable: () => true });
  expect(env.LANG).toBeUndefined();
  expect(terminalEnv({ LANG: "zh_CN.UTF-8" }, { shell: "pwsh.exe", platform: "win32" }).LANG).toBe("zh_CN.UTF-8");
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
