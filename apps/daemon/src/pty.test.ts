import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COLS, Pty, PtyUnavailable, ptyHelperPath, shellCommand } from "./pty";
import { CwdTracker } from "./terminal-cwd";
import { ensureZshIntegration, terminalEnv } from "./terminal-env";

/**
 * These drive the real helper binary: a pty that only works in a mock is not evidence of
 * anything. `swift build --package-path apps/runtime-helper --product real-bot-pty` first.
 */
const helper = (() => {
  try { return ptyHelperPath(); } catch { return null; }
})();
const withHelper = helper ? test : test.skip;

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
  expect(shellCommand({ SHELL: "/bin/bash" })).toEqual(["/bin/bash", "-l"]);
  expect(shellCommand({ SHELL: "zsh" })).toEqual(["/bin/zsh", "-l"]);
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
