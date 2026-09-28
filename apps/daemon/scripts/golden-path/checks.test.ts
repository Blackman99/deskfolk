import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFileText, normalizeOutput, runChecks, scriptOf, verifyEnv, verifyResult } from "./checks";
import { parseTaskSet } from "./tasks";

describe("checks", () => {
  test("output compares without line-ending or trailing-blank differences, and nothing else", () => {
    expect(normalizeOutput("a\t1  \r\nb\t2\n\n")).toBe("a\t1\nb\t2");
    expect(normalizeOutput("a\t1\nb\t2")).toBe(normalizeOutput("a\t1\nb\t2\n"));
    expect(normalizeOutput("a 1")).not.toBe(normalizeOutput("a\t1"));
  });

  test("a content check wants every substring and match, and none of the forbidden ones", () => {
    const check = { path: "index.html", contains: ["29"], matches: ["<META[^>]*viewport"], not_matches: ["<script[^>]*\\ssrc="] };
    expect(checkFileText('<meta name="viewport"> 29 美元', check)).toEqual({ name: "index.html content", ok: true, detail: "ok" });
    const bad = checkFileText('<script src="https://cdn.example/x.js"></script>', check);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('missing "29"');
    expect(bad.detail).toContain("no match for /<META[^>]*viewport/");
    expect(bad.detail).toContain("must not match");
  });

  test("a verify result reports the exit code, a stdout difference and the stderr that explains it", () => {
    const step = { cwd: "tool", command: ["bun", "test"], expect_exit: 0, expect_stdout: "ok", timeout_sec: 5 };
    expect(verifyResult(step, { exit: 0, stdout: "ok\n", stderr: "", timedOut: false })).toEqual({ name: "(cd tool) bun test", ok: true, detail: "exit 0" });
    const failed = verifyResult(step, { exit: 1, stdout: "nope", stderr: "1 fail", timedOut: false });
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("exit 1, expected 0");
    expect(failed.detail).toContain("stdout differs");
    expect(failed.detail).toContain("1 fail");
    expect(verifyResult(step, { exit: null, stdout: "", stderr: "", timedOut: true }).detail).toBe("timed out after 5s");
  });

  test("the script a bun step runs is known, so its absence can fail the step", () => {
    expect(scriptOf(["bun", "tool/tally.ts", "x.csv"])).toBe("tool/tally.ts");
    expect(scriptOf(["bun", "test"])).toBeNull();
    expect(scriptOf(["bun", "--silent", "x.ts"])).toBeNull();
    expect(scriptOf(["node", "x.js"])).toBeNull();
  });

  test("Bot-written code under verify gets PATH and HOME, never the runner's keys", () => {
    const env = verifyEnv({ PATH: "/usr/bin", HOME: "/Users/me", REAL_BOT_EVAL_API_KEY: "sk-x", OPENAI_API_KEY: "sk-y" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/me", NO_COLOR: "1", CI: "1" });
  });

  describe("against a workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "golden-path-checks-"));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    test("deliverables, content and a command the runner runs itself", () => {
      mkdirSync(join(root, "tool"), { recursive: true });
      writeFileSync(join(root, "report.md"), "| a | b |\n");
      writeFileSync(join(root, "empty.md"), "");
      writeFileSync(join(root, "tool", "hello.ts"), "console.log(`hi ${process.argv[2]}`);\n");
      const task = parseTaskSet({
        version: 1,
        tasks: [
          {
            id: "t",
            title: "t",
            message: "做",
            goal: "g",
            acceptance: ["a"],
            deliverables: ["report.md", "empty.md", "missing.md"],
            checks: [{ path: "report.md", matches: ["^\\|.+\\|"] }],
            verify: [
              { cwd: "tool", command: ["bun", "hello.ts", "there"], expect_stdout: "hi there\n", timeout_sec: 30 },
              { cwd: "nowhere", command: ["bun", "x.ts"] },
              // Bun exits 1 on a missing script too; that must not pass for "exits 1 on a missing input".
              { command: ["bun", "tool/absent.ts", "no-such.csv"], expect_exit: 1 },
            ],
            setups: {
              manual: { group: "g", bots: [{ name: "A", duties: "d", boundaries: "b" }, { name: "B", duties: "d", boundaries: "b" }] },
              coordinator: { bot: { name: "C", duties: "d", boundaries: "b" }, message: "m" },
            },
          },
        ],
      }).tasks[0]!;
      const results = runChecks(task, root);
      expect(results.map((result) => [result.name, result.ok, result.detail])).toEqual([
        ["report.md delivered", true, "10 bytes"],
        ["empty.md delivered", false, "empty"],
        ["missing.md delivered", false, "missing"],
        ["report.md content", true, "ok"],
        ["(cd tool) bun hello.ts there", true, "exit 0"],
        ["(cd nowhere) bun x.ts", false, "no nowhere/ to run in"],
        ["bun tool/absent.ts no-such.csv", false, "tool/absent.ts is missing"],
      ]);
    });
  });
});
