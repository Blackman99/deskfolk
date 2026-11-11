import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GHOSTTY, ghosttyCache, lockedSysVersion } from "./ghostty";

const root = resolve(import.meta.dir, "..");

describe("what the `ghostty` feature builds with", () => {
  test("the Ghostty commit is the one the locked libghostty-vt-sys pins", () => {
    // A new libghostty-vt-sys pins another commit: GHOSTTY moves with it.
    expect(lockedSysVersion()).toBe(GHOSTTY.sys);
    expect(GHOSTTY.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("its sources and packages are cached under that commit", () => {
    const { source, packages } = ghosttyCache();
    expect(source).toContain(join("ghostty", GHOSTTY.commit, "source"));
    expect(packages).toContain(join("ghostty", GHOSTTY.commit, "zig", "p"));
  });

  test("the feature is off unless asked for, so builds without Zig still work", () => {
    const native = readFileSync(join(root, "app", "native", "Cargo.toml"), "utf8");
    expect(native).toMatch(/^libghostty-vt = \{ version = "=0\.2\.2", optional = true \}$/m);
    expect(native).toMatch(/^ghostty = \["dep:libghostty-vt"\]$/m);
    expect(native).not.toMatch(/^default = /m);
    const host = readFileSync(join(root, "host", "Cargo.toml"), "utf8");
    expect(host).toMatch(/^ghostty = \["deskfolk-app-native\/ghostty"\]$/m);
    expect(host).not.toMatch(/^default = /m);
  });
});
