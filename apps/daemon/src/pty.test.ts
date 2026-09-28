import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_COLS, Pty, PtyUnavailable, SHUTDOWN_GRACE_MS, ptyHelperPath, shellCommand } from "./pty";
import { CwdTracker } from "./terminal-cwd";
import { ensureZshIntegration, terminalEnv } from "./terminal-env";

/**
 * These drive the real helper binary: a pty that only works in a mock is not evidence of
 * anything. `swift build --package-path apps/runtime-helper --product real-bot-pty` first.
 */
const helper = (() => {
  try { return ptyHelperPath(); } catch { return null; }
})();
const onWindows = process.platform === "win32";
/** The POSIX sessions below drive `/bin/sh`; Windows has its own set at the end of the file. */
const withHelper = helper && !onWindows ? test : test.skip;
/** The ConPTY helper: `cargo build --manifest-path apps/conpty-helper/Cargo.toml` first. */
const withConpty = helper && onWindows ? test : test.skip;

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "real-bot-pty-")));
}

/** A pty says nothing on a schedule: wait for output to arrive and then stop changing. */
async function settle(read: () => string, quietMs = 500, capMs = 15000): Promise<string> {
  const start = Date.now();
  const mark = read().length;
  while (Date.now() - start < capMs && read().length === mark) await Bun.sleep(50);
  let last = read().length;
  let lastAt = Date.now();
  while (Date.now() - start < capMs && Date.now() - lastAt < quietMs) {
    await Bun.sleep(50);
    if (read().length !== last) { last = read().length; lastAt = Date.now(); }
  }
  return read();
}

function open(cwd: string, command: string[], rows = 24, cols = DEFAULT_COLS) {
  const pty = new Pty({ cwd, rows, cols, command, helper: helper ?? undefined });
  let text = "";
  pty.onData((chunk) => { text += new TextDecoder().decode(chunk); });
  return { pty, read: () => text };
}

test("ptyHelperPath prefers an explicit override", () => {
  expect(ptyHelperPath({ REAL_BOT_PTY_HELPER: "/somewhere/real-bot-pty" })).toBe("/somewhere/real-bot-pty");
});

test("shellCommand starts a login shell and ignores a relative SHELL", () => {
  expect(shellCommand({ SHELL: "/bin/bash" }, "darwin")).toEqual(["/bin/bash", "-l"]);
  expect(shellCommand({ SHELL: "zsh" }, "darwin")).toEqual(["/bin/zsh", "-l"]);
});

test("ptyHelperPath on win32 looks for real-bot-pty.exe, override first", () => {
  expect(ptyHelperPath({ REAL_BOT_PTY_HELPER: "D:\\tools\\real-bot-pty.exe" }, "win32", () => false)).toBe(
    "D:\\tools\\real-bot-pty.exe",
  );
});

test("ptyHelperPath on win32 finds the packaged .exe next to the daemon", () => {
  const packaged = join(dirname(process.execPath), "real-bot-pty.exe");
  expect(ptyHelperPath({}, "win32", (path) => path === packaged)).toBe(packaged);
});

test("ptyHelperPath on win32 falls back to the cargo target dir in a source checkout", () => {
  const root = resolve(import.meta.dir, "../../..");
  const built = join(root, "apps/conpty-helper/target", "release", "real-bot-pty.exe");
  expect(ptyHelperPath({}, "win32", (path) => path === built)).toBe(built);
});

test("ptyHelperPath on win32 throws when nothing is found", () => {
  expect(() => ptyHelperPath({}, "win32", () => false)).toThrow(PtyUnavailable);
});

test("shellCommand on win32 prefers pwsh.exe on PATH, with -NoLogo only", () => {
  const which = (name: string) => (name === "pwsh.exe" ? "C:\\tools\\pwsh\\pwsh.exe" : null);
  expect(shellCommand({}, "win32", which)).toEqual(["C:\\tools\\pwsh\\pwsh.exe", "-NoLogo"]);
});

test("shellCommand on win32 falls back to the bundled Windows PowerShell", () => {
  expect(shellCommand({ SystemRoot: "C:\\Windows" }, "win32", () => null)).toEqual([
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "-NoLogo",
  ]);
});

test("a missing helper is reported, not guessed at", () => {
  expect(() => new Pty({ cwd: "/tmp", helper: "/nonexistent/real-bot-pty" })).toThrow(PtyUnavailable);
});

withHelper("the session runs in the requested cwd at the requested size", async () => {
  const cwd = scratch();
  const { pty, read } = open(cwd, ["/bin/sh", "-c", "pwd; tput cols; tput lines"], 30, 100);
  const text = await settle(read);
  expect(text).toContain(cwd);
  expect(text).toMatch(/\b100\b/);
  expect(text).toMatch(/\b30\b/);
  expect(await pty.exited).toBe(0);
  rmSync(cwd, { recursive: true, force: true });
});

withHelper("it is a real terminal, and a resize reaches the program", async () => {
  const cwd = scratch();
  const { pty, read } = open(cwd, ["/bin/sh", "-c", "test -t 0 && echo IS_TTY; read _; tput cols"]);
  await settle(read);
  expect(read()).toContain("IS_TTY");
  pty.resize(24, 132);
  pty.write(new TextEncoder().encode("\n"));
  expect(await settle(read)).toMatch(/\b132\b/);
  await pty.exited;
  rmSync(cwd, { recursive: true, force: true });
});

withHelper("an interrupt reaches the foreground job and the shell survives it", async () => {
  const cwd = scratch();
  const { pty, read } = open(cwd, ["/bin/sh", "-i"]);
  await settle(read);
  pty.write(new TextEncoder().encode("sleep 30\n"));
  await settle(read);
  // A bare 0x03: with a controlling terminal the line discipline does the rest.
  pty.write(new TextEncoder().encode("\x03"));
  await settle(read);
  pty.write(new TextEncoder().encode("echo EXIT_$?\n"));
  expect(await settle(read)).toContain("EXIT_130");
  pty.kill();
  rmSync(cwd, { recursive: true, force: true });
});

withHelper("signal() stops a session that is not listening to its keyboard", async () => {
  const cwd = scratch();
  const { pty, read } = open(cwd, ["/bin/sh", "-c", "trap '' INT; echo READY; sleep 30"]);
  await settle(read);
  expect(read()).toContain("READY");
  pty.signal("SIGKILL");
  expect(await pty.exited).not.toBe(0);
  rmSync(cwd, { recursive: true, force: true });
});

withHelper("the child's exit code comes back", async () => {
  const cwd = scratch();
  const { pty } = open(cwd, ["/bin/sh", "-c", "exit 7"]);
  expect(await pty.exited).toBe(7);
  rmSync(cwd, { recursive: true, force: true });
});

withHelper("closing hangs the session up instead of leaving it running", async () => {
  const cwd = scratch();
  const { pty, read } = open(cwd, ["/bin/sh", "-c", "echo READY; sleep 30"]);
  await settle(read);
  pty.close();
  expect(await pty.exited).not.toBe(0);
  rmSync(cwd, { recursive: true, force: true });
});

withHelper("closing a session takes the shell with it, not just the helper", async () => {
  const cwd = scratch();
  // A shell that ignores hangups: the exact case that used to leave a process behind, because
  // killing the helper orphans a child that is its own session leader.
  const { pty, read } = open(cwd, ["/bin/sh", "-c", "trap '' HUP; echo READY; sleep 60"]);
  await settle(read);
  expect(read()).toContain("READY");
  const descendants = () => Bun.spawnSync(["/bin/ps", "-eo", "ppid,pid"]).stdout.toString()
    .split("\n").filter((line) => line.trim().startsWith(`${pty.pid} `)).length;
  expect(descendants()).toBeGreaterThan(0);
  pty.kill();
  await pty.exited;
  await Bun.sleep(200);
  expect(descendants()).toBe(0);
  rmSync(cwd, { recursive: true, force: true });
});

/**
 * A real zsh, with Deskfolk's own environment and shell integration: the user's `.zshenv` and
 * `.zshrc` still run, `ZDOTDIR` ends up back where it started, and `cd` is reported as OSC 7 in a
 * form {@link CwdTracker} can decode back to the real path — including a directory name with a
 * space and CJK text in it, which is exactly the case percent-encoding exists for.
 */
withHelper("zsh keeps the user's own dotfiles and reports its cwd via Deskfolk's integration", async () => {
  const home = scratch();
  const dataDir = scratch();
  writeFileSync(join(home, ".zshenv"), 'export M1="one"\n');
  writeFileSync(join(home, ".zshrc"), 'export M2="two"\n');
  const target = join(home, "a b 中");
  mkdirSync(target);

  const zshIntegrationDir = ensureZshIntegration(dataDir);
  if (zshIntegrationDir === null) throw new Error("could not write the zsh integration fixture");
  const env = terminalEnv(
    { HOME: home, PATH: process.env.PATH },
    { shell: "/bin/zsh", zshIntegrationDir, username: "x" },
  );
  expect(env.ZDOTDIR).toBe(zshIntegrationDir);

  const pty = new Pty({ cwd: home, command: ["/bin/zsh", "-l"], env, helper: helper ?? undefined });
  const chunks: Uint8Array[] = [];
  let text = "";
  pty.onData((chunk) => { chunks.push(chunk); text += new TextDecoder().decode(chunk); });
  const read = () => text;

  await settle(read);
  pty.write(new TextEncoder().encode(`cd "${target}"; echo "M1=$M1 M2=$M2 Z=$ZDOTDIR"\r`));
  const out = await settle(read);

  expect(out).toContain("M1=one M2=two");
  // ZDOTDIR was restored (here, unset — the fixture HOME had none of its own) before the user's
  // own dotfiles ran, so it is not the integration dir by the time the prompt echoes it back.
  expect(out).not.toContain(`Z=${zshIntegrationDir}`);
  // OSC 7 for the target dir: `a b 中` percent-encoded byte by byte.
  expect(out).toContain("a%20b%20%E4%B8%AD");

  const tracker = new CwdTracker();
  let decoded: string | null = null;
  for (const chunk of chunks) decoded = tracker.feed(chunk) ?? decoded;
  expect(decoded).toBe(target);

  pty.kill();
  await pty.exited;
  rmSync(home, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const typed = (text: string) => new TextEncoder().encode(text);

withConpty("ConPTY: the session runs in the requested cwd and the exit code comes back", async () => {
  const cwd = scratch();
  // Wide, so ConPTY does not wrap a long temp path across two lines.
  const { pty, read } = open(cwd, ["cmd.exe", "/d", "/c", "cd & exit 7"], 24, 300);
  expect(await pty.exited).toBe(7);
  expect((await settle(read, 200, 3000)).toLowerCase()).toContain(cwd.split("\\").pop()!.toLowerCase());
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

/** Waits for `pattern` in what the session has said since `from`; fails with the tail if it never shows. */
async function until(read: () => string, pattern: RegExp, from = 0, capMs = 30_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    const seen = read().slice(from);
    if (pattern.test(seen)) return seen;
    await Bun.sleep(100);
  }
  throw new Error(`never saw ${pattern} in ${JSON.stringify(read().slice(from).slice(-600))}`);
}

withConpty("ConPTY: Ctrl-C stops the foreground program and the shell survives it", async () => {
  const cwd = scratch();
  const prompt = new RegExp(`${cwd.split("\\").pop()}>`, "i");
  const { pty, read } = open(cwd, ["cmd.exe", "/d", "/k"], 24, 200);
  await until(read, prompt);
  pty.write(typed("ping -t 127.0.0.1\r"));
  const pinging = read().length;
  await until(read, /Reply from|127\.0\.0\.1.*TTL/i, pinging);
  const interrupted = read().length;
  pty.write(typed("\x03"));
  // ping answers Ctrl+C with its statistics and cmd draws the prompt again.
  await until(read, prompt, interrupted);
  // Read by cmd, not swallowed by a ping still running: the expanded %ERRORLEVEL% proves it.
  pty.write(typed("echo ALIVE_%ERRORLEVEL%\r"));
  await until(read, /ALIVE_\d/, interrupted);
  pty.kill();
  await pty.exited;
  rmSync(cwd, { recursive: true, force: true });
}, 120_000);

withConpty("ConPTY: a resize reaches the program", async () => {
  const cwd = scratch();
  const { pty, read } = open(cwd, ["powershell.exe", "-NoLogo", "-NoProfile"], 24, 100);
  // A cold Windows PowerShell can take many seconds to draw its first prompt.
  await until(read, /PS [^\r\n]*>/, 0, 90_000);
  pty.resize(30, 123);
  await Bun.sleep(500);
  const asked = read().length;
  pty.write(typed("'W=' + $Host.UI.RawUI.WindowSize.Width\r"));
  await until(read, /W=123/, asked);
  pty.kill();
  await pty.exited;
  rmSync(cwd, { recursive: true, force: true });
}, 180_000);

withConpty("ConPTY: kill() takes the session down without waiting for the escalation", async () => {
  const cwd = scratch();
  const { pty } = open(cwd, ["cmd.exe", "/d", "/c", "ping -n 60 127.0.0.1 > NUL"]);
  await Bun.sleep(1000);
  const started = Date.now();
  pty.kill();
  await pty.exited;
  expect(Date.now() - started).toBeLessThan(SHUTDOWN_GRACE_MS);
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);
