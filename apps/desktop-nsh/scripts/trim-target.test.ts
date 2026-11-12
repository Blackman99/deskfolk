import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sizeOf, trimTarget } from "./trim-target";

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
