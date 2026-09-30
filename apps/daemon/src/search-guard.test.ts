import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { recursiveSearchGuard, searchGuardMessage, type SearchGuardHit } from "./search-guard";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "real-bot-search-guard-")));
}

const home = realpathSync(homedir());

// POSIX only, like the guard itself (`toolShell().kind === "sh"`, which win32 never returns).
describe.skipIf(process.platform === "win32")("recursiveSearchGuard", () => {
  test("a bare recursive grep of the home folder is refused", () => {
    const ws = tmp();
    const hit = recursiveSearchGuard(ws, `grep -rn "BEACON ZERO" ${home}/`, ws);
    expect(hit).toEqual({ tool: "grep", target: "home", root: home, via: "arg" });
    rmSync(ws, { recursive: true, force: true });
  });

  test("`cd ~ && grep -r .` resolves the same as a direct home path, and is refused the same way", () => {
    const ws = tmp();
    const hit = recursiveSearchGuard(ws, `cd ~ && grep -r "BEACON ZERO" .`, ws);
    expect(hit).toEqual({ tool: "grep", target: "home", root: home, via: "cwd" });
    rmSync(ws, { recursive: true, force: true });
  });

  test("`find ~` is refused", () => {
    const ws = tmp();
    const hit = recursiveSearchGuard(ws, `find ~ -name "*.md"`, ws);
    expect(hit).toEqual({ tool: "find", target: "home", root: home, via: "arg" });
    rmSync(ws, { recursive: true, force: true });
  });

  test("`rg` with an explicit home path is refused (rg recurses by default, no -r needed)", () => {
    const ws = tmp();
    const hit = recursiveSearchGuard(ws, `rg "BEACON ZERO" ${home}`, ws);
    expect(hit).toEqual({ tool: "rg", target: "home", root: home, via: "arg" });
    rmSync(ws, { recursive: true, force: true });
  });

  test("`$HOME` resolves the same as `~`, unlike today's gap where it counts as inside", () => {
    const ws = tmp();
    const hit = recursiveSearchGuard(ws, `grep -r x $HOME`, ws);
    expect(hit).toEqual({ tool: "grep", target: "home", root: home, via: "arg" });
    rmSync(ws, { recursive: true, force: true });
  });

  test("`${HOME}` (brace form) resolves the same as `$HOME`", () => {
    const ws = tmp();
    const hit = recursiveSearchGuard(ws, "grep -r x ${HOME}", ws);
    expect(hit).toEqual({ tool: "grep", target: "home", root: home, via: "arg" });
    rmSync(ws, { recursive: true, force: true });
  });

  test("a recursive search of `/` is refused as the device root, distinct from home", () => {
    const ws = tmp();
    const hit = recursiveSearchGuard(ws, `grep -r x /`, ws);
    expect(hit).toEqual({ tool: "grep", target: "device", root: "/", via: "arg" });
    rmSync(ws, { recursive: true, force: true });
  });

  test("scoped to the workspace, nothing is refused", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `grep -rn "BEACON ZERO" .`, ws)).toBeNull();
    expect(recursiveSearchGuard(ws, `find . -name "*.md"`, ws)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("a task directory under the workspace is scoped too, cd chains included", () => {
    const ws = tmp();
    const cwd = join(ws, "work", "shoot-7f3k");
    expect(recursiveSearchGuard(ws, `grep -r x .`, cwd)).toBeNull();
    expect(recursiveSearchGuard(ws, `cd .. && grep -r x .`, cwd)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("ls without -R is not a recursive search, and ls -r (reverse sort) is not confused with -R", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `ls ${home}`, ws)).toBeNull();
    expect(recursiveSearchGuard(ws, `ls -r ${home}`, ws)).toBeNull();
    expect(recursiveSearchGuard(ws, `ls -R ${home}`, ws)).toEqual({ tool: "ls", target: "home", root: home, via: "arg" });
    rmSync(ws, { recursive: true, force: true });
  });

  test("du and find always count as recursive, with no path defaulting to the current directory", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `cd ~ && du -sh`, ws)).toEqual({ tool: "du", target: "home", root: home, via: "cwd" });
    expect(recursiveSearchGuard(ws, `cd ~ && find -name "*.md"`, ws)).toEqual({
      tool: "find",
      target: "home",
      root: home,
      via: "cwd",
    });
    rmSync(ws, { recursive: true, force: true });
  });

  test("find's leading -H/-L/-P (how it follows symlinks) is not mistaken for the end of its path list", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `find -H ${home} -name "*.md"`, ws)).toEqual({
      tool: "find",
      target: "home",
      root: home,
      via: "arg",
    });
    expect(recursiveSearchGuard(ws, `find -L ${home}`, ws)).toEqual({ tool: "find", target: "home", root: home, via: "arg" });
    // Scoped to the workspace, the same leading flag is still harmless.
    expect(recursiveSearchGuard(ws, `find -P . -name "*.md"`, ws)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("macOS find's leading -E/-X/-d/-s/-x are not mistaken for the end of its path list either", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `find -E ${home} -name "*.md"`, ws)).toEqual({
      tool: "find",
      target: "home",
      root: home,
      via: "arg",
    });
    expect(recursiveSearchGuard(ws, `find -H -x ${home}`, ws)).toEqual({ tool: "find", target: "home", root: home, via: "arg" });
    rmSync(ws, { recursive: true, force: true });
  });

  test("a `timeout`, `time`, `nice`, `command` or `nohup` wrapper does not hide the tool underneath", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `timeout 30 grep -r x ${home}`, ws)).toEqual({
      tool: "grep",
      target: "home",
      root: home,
      via: "arg",
    });
    expect(recursiveSearchGuard(ws, `timeout -k 5 30 grep -r x ${home}`, ws)).toEqual({
      tool: "grep",
      target: "home",
      root: home,
      via: "arg",
    });
    expect(recursiveSearchGuard(ws, `time grep -r x ${home}`, ws)).toEqual({ tool: "grep", target: "home", root: home, via: "arg" });
    expect(recursiveSearchGuard(ws, `time -p grep -r x ${home}`, ws)).toEqual({ tool: "grep", target: "home", root: home, via: "arg" });
    expect(recursiveSearchGuard(ws, `nice -n 10 grep -r x ${home}`, ws)).toEqual({
      tool: "grep",
      target: "home",
      root: home,
      via: "arg",
    });
    expect(recursiveSearchGuard(ws, `command grep -r x ${home}`, ws)).toEqual({
      tool: "grep",
      target: "home",
      root: home,
      via: "arg",
    });
    expect(recursiveSearchGuard(ws, `nohup grep -r x ${home}`, ws)).toEqual({
      tool: "grep",
      target: "home",
      root: home,
      via: "arg",
    });
    // Scoped to the workspace, a wrapper changes nothing.
    expect(recursiveSearchGuard(ws, `timeout 30 grep -r x .`, ws)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("a `2>&1`-style duplicated file descriptor no longer makes the whole line unparseable", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `grep -r x ${home} 2>&1`, ws)).toEqual({
      tool: "grep",
      target: "home",
      root: home,
      via: "arg",
    });
    // Scoped to the workspace, still runs.
    expect(recursiveSearchGuard(ws, `grep -r x . 2>&1`, ws)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("`&>file` (stdout and stderr together) is a redirect, not a background job or a search root", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `grep -r x ${home} &>/dev/null`, ws)).toEqual({
      tool: "grep",
      target: "home",
      root: home,
      via: "arg",
    });
    rmSync(ws, { recursive: true, force: true });
  });

  test("a newline between commands is a separator too, the same as `;`", () => {
    const ws = tmp();
    const hit = recursiveSearchGuard(ws, `cd ~\ngrep -r x .`, ws);
    expect(hit).toEqual({ tool: "grep", target: "home", root: home, via: "cwd" });
    // Scoped to the workspace, no cd is needed for the guard to see past the newline either.
    expect(recursiveSearchGuard(ws, `echo hi\ngrep -r x .`, ws)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("a backslash-newline (a command wrapped over two lines) is a line continuation, not a separator", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `grep -rn x \\\n${home}/`, ws)).toEqual({
      tool: "grep",
      target: "home",
      root: home,
      via: "arg",
    });
    // Scoped to the workspace, the wrapped command still runs.
    expect(recursiveSearchGuard(ws, `grep -rn x \\\n.`, ws)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("a command this cannot parse is left alone, even one that would otherwise be refused", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `grep -r x ${home} | wc -l`, ws)).toBeNull();
    expect(recursiveSearchGuard(ws, `(cd ${home} && grep -r x .)`, ws)).toBeNull();
    expect(recursiveSearchGuard(ws, `echo $(grep -r x ${home})`, ws)).toBeNull();
    expect(recursiveSearchGuard(ws, "grep -r x `pwd`", ws)).toBeNull();
    expect(recursiveSearchGuard(ws, `eval "grep -r x ${home}"`, ws)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("a redirect target is not mistaken for a search root", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `grep -rn x . > ${home}/out.txt`, ws)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("cd - (the previous directory) cannot be resolved statically, so the command is left alone", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `cd - && grep -r x .`, ws)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("a glob over every entry directly under home or `/` is refused the same as the root itself", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `du -sh ${home}/*`, ws)).toEqual({ tool: "du", target: "home", root: home, via: "arg" });
    expect(recursiveSearchGuard(ws, `grep -r x /*`, ws)).toEqual({ tool: "grep", target: "device", root: "/", via: "arg" });
    // A glob over a real subfolder's entries is not the same thing.
    expect(recursiveSearchGuard(ws, `du -sh ${home}/Documents/*`, ws)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("an unquoted `#` starts a comment, so a trailing remark does not read as a search root", () => {
    const ws = tmp();
    expect(recursiveSearchGuard(ws, `grep -rn x . # not ~`, ws)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("a comment is dropped before the command is split: its quotes, parens and pipes do not make it unparseable", () => {
    const ws = tmp();
    const refused: SearchGuardHit = { tool: "grep", target: "home", root: home, via: "arg" };
    expect(recursiveSearchGuard(ws, `grep -rn x ~ # it's quick (really) | fast`, ws)).toEqual(refused);
    expect(recursiveSearchGuard(ws, `grep -rn x ~ ;# don't`, ws)).toEqual(refused);
    // A comment line of its own, then the search on the next line, cd included.
    expect(recursiveSearchGuard(ws, `# look everywhere (all of it)\ncd ~ && grep -r x .`, ws)).toEqual({ ...refused, via: "cwd" });
    // Scoped, the same comment changes nothing.
    expect(recursiveSearchGuard(ws, `grep -rn x . # it's quick (really) | fast`, ws)).toBeNull();
    // A `#` inside quotes or in the middle of a word is no comment.
    expect(recursiveSearchGuard(ws, `grep -r "a #b" ~`, ws)).toEqual(refused);
    expect(recursiveSearchGuard(ws, `grep -r 'it#s' ~`, ws)).toEqual(refused);
    expect(recursiveSearchGuard(ws, `grep -r x#y ~`, ws)).toEqual(refused);
    // Still unparseable when the pipe is outside the comment.
    expect(recursiveSearchGuard(ws, `grep -r x ~ | wc -l # count`, ws)).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });

  test("find -maxdepth and rg --max-depth of three levels or fewer are bounded, not a walk of the tree", () => {
    const ws = tmp();
    for (const command of [
      `find ~ -maxdepth 1 -name "*.md"`,
      `find ~ -maxdepth 3 -type d`,
      `find / -maxdepth 2 -name hosts`,
      `cd ~ && find . -maxdepth 2`,
      `rg --max-depth 2 x ~`,
      `rg --max-depth=3 x ~`,
      `rg --maxdepth 1 x ~`,
      `rg -d 2 x ~`,
      `rg -d1 x /`,
    ]) {
      expect({ command, hit: recursiveSearchGuard(ws, command, ws) }).toEqual({ command, hit: null });
    }
    // Deeper than that, or a depth that is not a number, is still the whole tree.
    expect(recursiveSearchGuard(ws, `find ~ -maxdepth 4 -name "*.md"`, ws)).toEqual({ tool: "find", target: "home", root: home, via: "arg" });
    expect(recursiveSearchGuard(ws, `find ~ -maxdepth $N`, ws)).toEqual({ tool: "find", target: "home", root: home, via: "arg" });
    expect(recursiveSearchGuard(ws, `rg --max-depth 10 x ~`, ws)).toEqual({ tool: "rg", target: "home", root: home, via: "arg" });
    expect(recursiveSearchGuard(ws, `rg --max-depth=5 x /`, ws)).toEqual({ tool: "rg", target: "device", root: "/", via: "arg" });
    // A depth only bounds the tools that take one: grep and du still walk everything.
    expect(recursiveSearchGuard(ws, `du -d 1 ~`, ws)).toEqual({ tool: "du", target: "home", root: home, via: "arg" });
    rmSync(ws, { recursive: true, force: true });
  });
});

// POSIX only, like the guard itself (`toolShell().kind === "sh"`, which win32 never returns).
describe.skipIf(process.platform === "win32")("searchGuardMessage", () => {
  test("names the tool and the folder for a home hit, and the disk for a device hit", () => {
    expect(searchGuardMessage({ tool: "grep", target: "home", root: home, via: "arg" })).toContain(home);
    expect(searchGuardMessage({ tool: "find", target: "device", root: "/", via: "arg" })).toContain("whole disk");
  });

  test("suggests dropping the cd when the root came from the working directory, and a subfolder when it was named directly", () => {
    const viaCwd = searchGuardMessage({ tool: "grep", target: "home", root: home, via: "cwd" });
    expect(viaCwd).toContain("drop the cd");
    const viaArg = searchGuardMessage({ tool: "grep", target: "home", root: home, via: "arg" });
    expect(viaArg).toContain("name a specific subfolder");
  });
});
