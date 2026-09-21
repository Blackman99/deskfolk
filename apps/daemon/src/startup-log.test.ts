import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeError,
  logStartup,
  startupLogPath,
  STARTUP_LOG_MAX_BYTES,
} from "./startup-log";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "real-bot-startup-log-"));
}

describe("the startup log", () => {
  test("appends one timestamped line per call, whitespace collapsed", () => {
    const dir = scratch();
    try {
      logStartup(dir, "listening on http://127.0.0.1:17890");
      logStartup(dir, "failed to start:\n  no such column: task_id");
      const lines = readFileSync(startupLogPath(dir), "utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT.+ listening on http:\/\/127\.0\.0\.1:17890$/);
      expect(lines[1]).toEndWith("failed to start: no such column: task_id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates the data dir and keeps the file private", () => {
    const dir = join(scratch(), "not-yet");
    try {
      logStartup(dir, "listening");
      expect(statSync(startupLogPath(dir)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trims to the newest half at a line boundary once it outgrows the cap", () => {
    const dir = scratch();
    try {
      const path = startupLogPath(dir);
      writeFileSync(path, `${"x".repeat(80)}\n`.repeat(Math.ceil(STARTUP_LOG_MAX_BYTES / 81) + 40));
      expect(statSync(path).size).toBeGreaterThan(STARTUP_LOG_MAX_BYTES);

      logStartup(dir, "listening");
      const text = readFileSync(path, "utf8");
      expect(text.length).toBeLessThanOrEqual(STARTUP_LOG_MAX_BYTES);
      // No half line left at the top, and the newest line survived.
      expect(text.startsWith("x".repeat(80))).toBe(true);
      expect(text.trimEnd().endsWith("listening")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never throws, so logging cannot be why a start fails", () => {
    const dir = scratch();
    try {
      // A file where the data dir should be: every write below fails.
      const blocked = join(dir, "blocked");
      writeFileSync(blocked, "not a directory");
      expect(() => logStartup(blocked, "listening")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("describeError", () => {
  test("names the cause and a few frames, not a core dump", () => {
    const line = describeError(new Error("no such column: task_id"));
    expect(line).toStartWith("no such column: task_id");
    expect(line.split(" | ").length).toBeLessThanOrEqual(4);
  });

  test("survives something that is not an Error", () => {
    expect(describeError("boom")).toBe("boom");
  });
});
