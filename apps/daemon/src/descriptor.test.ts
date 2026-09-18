import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { descriptorPath, mintLocalToken, pidAlive, readDescriptor, writeDescriptor } from "./descriptor";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("local-api.json", () => {
  test("writes 0700 directory and 0600 file with pid/port/token/started_at", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-"));
    dirs.push(dir);
    const token = mintLocalToken();
    writeDescriptor(dir, {
      pid: 42,
      port: 17890,
      token,
      started_at: "2026-09-14T00:00:00.000Z",
    });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const file = descriptorPath(dir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      pid: 42,
      port: 17890,
      token,
      started_at: "2026-09-14T00:00:00.000Z",
    });
    expect(token.length).toBeGreaterThanOrEqual(64);
  });

  test("readDescriptor returns the written file and rejects garbage", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-"));
    dirs.push(dir);
    expect(readDescriptor(dir)).toBeNull();
    writeDescriptor(dir, {
      pid: 42,
      port: 17890,
      token: mintLocalToken(),
      started_at: "2026-09-14T00:00:00.000Z",
    });
    expect(readDescriptor(dir)?.pid).toBe(42);
  });

  test("pidAlive sees this process and not a dead pid", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
  });
});
