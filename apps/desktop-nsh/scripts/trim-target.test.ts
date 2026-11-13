import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sizeOf, trimNshCache, trimTarget } from "./trim-target";

const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];

function target(): string {
  const dir = mkdtempSync(join(tmpdir(), "trim-target-"));
  dirs.push(dir);
  return join(dir, "target");
}

function file(path: string, bytes: number, ageDays = 0): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
  const at = new Date(Date.now() - ageDays * DAY);
  utimesSync(path, at, at);
}

/** Sets a directory's mtime, as rustc's last write into it would have. */
function age(path: string, days: number): void {
  const at = new Date(Date.now() - days * DAY);
  utimesSync(path, at, at);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("trimTarget", () => {
  test("removes incremental caches older than the age, keeps fresh ones and the artifacts", () => {
    const t = target();
    file(join(t, "debug", "incremental", "old-abc", "s", "a.bin"), 100, 5);
    file(join(t, "debug", "incremental", "fresh-def", "s", "a.bin"), 100, 0);
    file(join(t, "debug", "deps", "libx-0123456789abcdef.rlib"), 100, 30);
    age(join(t, "debug", "incremental", "old-abc"), 5);
    const size = trimTarget(t, { capBytes: 0, incrementalAgeMs: 2 * DAY, log: () => {} });
    expect(existsSync(join(t, "debug", "incremental", "old-abc"))).toBe(false);
    expect(existsSync(join(t, "debug", "incremental", "fresh-def"))).toBe(true);
    expect(existsSync(join(t, "debug", "deps", "libx-0123456789abcdef.rlib"))).toBe(true);
    expect(size).toBe(200);
  });

  test("over the cap, incremental goes first", () => {
    const t = target();
    file(join(t, "debug", "incremental", "x", "a.bin"), 600);
    file(join(t, "debug", "deps", "a.rlib"), 300);
    expect(trimTarget(t, { capBytes: 500, incrementalAgeMs: 2 * DAY, log: () => {} })).toBe(300);
    expect(existsSync(join(t, "debug", "incremental"))).toBe(false);
    expect(existsSync(join(t, "debug", "deps", "a.rlib"))).toBe(true);
  });

  test("still over the cap, the whole directory goes", () => {
    const t = target();
    file(join(t, "debug", "incremental", "x", "a.bin"), 100);
    file(join(t, "debug", "deps", "a.rlib"), 900);
    expect(trimTarget(t, { capBytes: 500, incrementalAgeMs: 2 * DAY, log: () => {} })).toBe(0);
    expect(existsSync(t)).toBe(false);
  });

  test("a dry run removes nothing", () => {
    const t = target();
    file(join(t, "debug", "incremental", "old", "a.bin"), 100, 5);
    file(join(t, "debug", "deps", "a.rlib"), 900);
    age(join(t, "debug", "incremental", "old"), 5);
    trimTarget(t, { capBytes: 500, incrementalAgeMs: 2 * DAY, dryRun: true, log: () => {} });
    expect(sizeOf(t)).toBe(1000);
  });
});

describe("trimNshCache", () => {
  const KEEP = "a".repeat(40);
  const OLD = "b".repeat(40);
  const RECENT = "c".repeat(40);

  /** A cache with this checkout's commit, one unused for 30 days, one used yesterday, Ghostty's. */
  function cache(): string {
    const root = join(target(), "..", "cache");
    for (const [rev, days] of [[KEEP, 30], [OLD, 30], [RECENT, 1]] as const) {
      file(join(root, rev, "source", "target", "release", "nsh"), 100);
      file(join(root, rev, "last-used"), 0, days);
    }
    file(join(root, "ghostty", "0123abc", "src.tar"), 100);
    age(join(root, "ghostty"), 30);
    return root;
  }

  test("removes the commits other than this checkout's that nothing used lately", () => {
    const root = cache();
    trimNshCache(root, { keep: KEEP, unusedMs: 7 * DAY, log: () => {} });
    expect(existsSync(join(root, KEEP))).toBe(true);
    expect(existsSync(join(root, OLD))).toBe(false);
    expect(existsSync(join(root, OLD + ".removing"))).toBe(false);
    expect(existsSync(join(root, RECENT))).toBe(true);
    expect(existsSync(join(root, "ghostty"))).toBe(true);
  });

  test("a commit without a stamp goes by its directory's age", () => {
    const root = cache();
    rmSync(join(root, OLD, "last-used"));
    age(join(root, OLD), 30);
    trimNshCache(root, { keep: KEEP, unusedMs: 7 * DAY, log: () => {} });
    expect(existsSync(join(root, OLD))).toBe(false);
  });

  test("finishes what an earlier removal left", () => {
    const root = cache();
    file(join(root, OLD + ".removing", "source", "half.rs"), 100);
    trimNshCache(root, { keep: KEEP, unusedMs: 365 * DAY, log: () => {} });
    expect(existsSync(join(root, OLD + ".removing"))).toBe(false);
    expect(existsSync(join(root, OLD))).toBe(true);
  });

  test("a dry run removes nothing", () => {
    const root = cache();
    const lines: string[] = [];
    trimNshCache(root, { keep: KEEP, unusedMs: 7 * DAY, dryRun: true, log: (line) => lines.push(line) });
    expect(existsSync(join(root, OLD))).toBe(true);
    expect(lines.join("\n")).toContain(OLD.slice(0, 12));
  });
});
