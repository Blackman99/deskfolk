import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { keepOnlyCli, nshCliPath, nshRev } from "./nsh-cli";

const root = resolve(import.meta.dir, "..");

describe("the NSH the shell and the CLI come from", () => {
  test("every nsh crate is taken from one commit of NSH's repository", () => {
    const rev = nshRev();
    expect(rev).toMatch(/^[0-9a-f]{40}$/);
    const manifest = readFileSync(join(root, "Cargo.toml"), "utf8");
    const lines = manifest.split("\n").filter((l) => /^nsh-[a-z-]+\s*=/.test(l.trim()));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain('git = "https://github.com/longbridge/nsh"');
      expect(line).toContain(`rev = "${rev}"`);
    }
  });

  test("the crates' manifests ask for nsh through the workspace, never a version of their own", () => {
    for (const crate of ["host", "app/native", "native/terminal", "native/pdf"]) {
      const manifest = readFileSync(join(root, crate, "Cargo.toml"), "utf8");
      for (const line of manifest.split("\n").filter((l) => /^nsh-[a-z-]+\s*[=.]/.test(l.trim()))) {
        // Features of their own are theirs to ask for (app/native: `term`); the source never is.
        expect(line.trim()).toMatch(/^nsh-[a-z-]+(\.workspace = true| = \{ workspace = true, features = \[[^\]]*\] \})$/);
      }
    }
  });

  test("Cargo.lock resolves every nsh crate to that commit, and only to it", () => {
    const rev = nshRev();
    const lock = readFileSync(join(root, "Cargo.lock"), "utf8");
    const sources = new Set<string>();
    for (const block of lock.split("[[package]]")) {
      const name = block.match(/name = "(nsh-[a-z-]+)"/)?.[1];
      if (!name) continue;
      sources.add(block.match(/source = "([^"]+)"/)?.[1] ?? "(none)");
    }
    expect([...sources]).toEqual([`git+https://github.com/longbridge/nsh?rev=${rev}#${rev}`]);
  });

  test("the CLI is looked for in the cache under that commit", () => {
    expect(nshCliPath("abc123")).toContain(join("abc123", "source", "target", "release"));
  });

  test("after the build, the checkout's target keeps the CLI alone", () => {
    const source = mkdtempSync(join(tmpdir(), "nsh-cli-"));
    try {
      const target = join(source, "target");
      for (const dir of ["release/deps", "release/build/x", "release/.fingerprint", "release/incremental", "debug"]) {
        mkdirSync(join(target, dir), { recursive: true });
      }
      for (const name of ["nsh", "nsh.exe", "nsh.pdb", "nsh.d", ".cargo-lock", "deps/libnsh_core-0123.rlib"]) {
        writeFileSync(join(target, "release", name), "x");
      }
      writeFileSync(join(target, "CACHEDIR.TAG"), "x");
      writeFileSync(join(source, "Cargo.toml"), "x");
      keepOnlyCli(source);
      expect(readdirSync(target)).toEqual(["release"]);
      expect(readdirSync(join(target, "release")).sort()).toEqual(["nsh", "nsh.exe", "nsh.pdb"]);
      expect(readdirSync(source).sort()).toEqual(["Cargo.toml", "target"]);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});
