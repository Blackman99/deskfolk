import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nshCliPath, nshRev } from "./nsh-cli";

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
        expect(line.trim()).toMatch(/^nsh-[a-z-]+\.workspace = true$/);
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
});
