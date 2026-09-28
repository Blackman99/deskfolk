import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptanceCheck } from "@real-bot/protocol";
import { checkEnv, describeCheck, evaluateCheck, normalizeOutput, scriptOf } from "./acceptance-eval";

function check(over: Partial<AcceptanceCheck>): AcceptanceCheck {
  return {
    id: "chk",
    task_id: "task",
    ticket_id: null,
    item: "x",
    kind: "exists",
    path: null,
    pattern: null,
    negate: false,
    command: null,
    cwd: null,
    expect_exit: null,
    expect_stdout: null,
    timeout_sec: null,
    source: "user",
    created_at: "now",
    updated_at: "now",
    defined_at: "now",
    first_passed_at: null,
    last_run: null,
    running: false,
    ...over,
  };
}

function workspace(): { root: string; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "acceptance-eval-"));
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

describe("normalizeOutput", () => {
  test("drops \\r, trailing blanks per line, and trailing blank lines", () => {
    expect(normalizeOutput("a  \r\nb\t\n\n\n")).toBe("a\nb");
  });
});

describe("scriptOf", () => {
  test("the file a bun/node/python3 run would execute", () => {
    expect(scriptOf("bun run.ts")).toBe("run.ts");
    expect(scriptOf("node script.js --flag")).toBe("script.js");
    expect(scriptOf("python3 main.py")).toBe("main.py");
  });
  test("null for a subcommand or another program", () => {
    expect(scriptOf("bun test")).toBeNull();
    expect(scriptOf("bun install")).toBeNull();
    expect(scriptOf("echo hi")).toBeNull();
    expect(scriptOf("bun -v")).toBeNull();
  });
});

describe("checkEnv", () => {
  test("env lacks a planted SECRET, SSH_AUTH_SOCK, and anything REAL_BOT_*", () => {
    const env = checkEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/x",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      SECRET_TOKEN: "sk-should-not-leak",
      REAL_BOT_ENDPOINT_KEY: "also-should-not-leak",
      RANDOM_OTHER: "nope",
    });
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.REAL_BOT_ENDPOINT_KEY).toBeUndefined();
    expect(env.RANDOM_OTHER).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/x");
    expect(env.CI).toBe("1");
    expect(env.NO_COLOR).toBe("1");
    expect(env.TERM).toBe("dumb");
  });

  test("PATH still falls back when the source has none", () => {
    expect(checkEnv({}).PATH).toBeString();
  });
});

describe("describeCheck", () => {
  test("zh and en for each kind, negate included", () => {
    expect(describeCheck(check({ kind: "exists", path: "report.md" }), "zh")).toBe("文件存在：report.md");
    expect(describeCheck(check({ kind: "exists", path: "report.md" }), "en")).toBe("File exists: report.md");
    expect(describeCheck(check({ kind: "contains", path: "a.md", pattern: "ok" }), "zh")).toContain("包含");
    expect(describeCheck(check({ kind: "contains", path: "a.md", pattern: "ok", negate: true }), "zh")).toContain("不包含");
    expect(describeCheck(check({ kind: "matches", path: "a.md", pattern: "^ok$" }), "en")).toBe('a.md matches /^ok$/');
    expect(describeCheck(check({ kind: "command", command: "bun test", cwd: "work/x" }), "en")).toBe("Command: bun test (in work/x)");
  });
});

describe("evaluateCheck: exists", () => {
  test("pass on a non-empty file, fail on missing or empty", async () => {
    const ws = workspace();
    writeFileSync(join(ws.root, "a.md"), "hello");
    writeFileSync(join(ws.root, "empty.md"), "");
    expect((await evaluateCheck(ws.root, check({ kind: "exists", path: "a.md" }))).outcome).toBe("pass");
    expect((await evaluateCheck(ws.root, check({ kind: "exists", path: "missing.md" }))).outcome).toBe("fail");
    expect((await evaluateCheck(ws.root, check({ kind: "exists", path: "empty.md" }))).outcome).toBe("fail");
    ws.close();
  });

  test("no workspace is blocked", async () => {
    expect((await evaluateCheck(null, check({ kind: "exists", path: "a.md" }))).outcome).toBe("blocked");
  });

  test("a path outside the workspace is blocked, even reached through .. or a symlink", async () => {
    const ws = workspace();
    const result = await evaluateCheck(ws.root, check({ kind: "exists", path: "../../../etc/passwd" }));
    expect(result.outcome).toBe("blocked");
    ws.close();
  });
});

describe("evaluateCheck: contains / matches", () => {
  test("contains: needle present/absent, negate flips it", async () => {
    const ws = workspace();
    writeFileSync(join(ws.root, "a.md"), "the quick brown fox");
    expect((await evaluateCheck(ws.root, check({ kind: "contains", path: "a.md", pattern: "quick" }))).outcome).toBe("pass");
    expect((await evaluateCheck(ws.root, check({ kind: "contains", path: "a.md", pattern: "slow" }))).outcome).toBe("fail");
    expect((await evaluateCheck(ws.root, check({ kind: "contains", path: "a.md", pattern: "slow", negate: true }))).outcome).toBe("pass");
    expect((await evaluateCheck(ws.root, check({ kind: "contains", path: "a.md", pattern: "quick", negate: true }))).outcome).toBe("fail");
    ws.close();
  });

  test("matches: regex with mi flags, negate flips it", async () => {
    const ws = workspace();
    writeFileSync(join(ws.root, "a.md"), "Line one\nTOTAL: 42\nLine three");
    expect((await evaluateCheck(ws.root, check({ kind: "matches", path: "a.md", pattern: "^total: \\d+$" }))).outcome).toBe("pass");
    expect((await evaluateCheck(ws.root, check({ kind: "matches", path: "a.md", pattern: "^total: 99$" }))).outcome).toBe("fail");
    ws.close();
  });

  test("a file over 1 MB is an error, not a fail", async () => {
    const ws = workspace();
    writeFileSync(join(ws.root, "big.md"), "x".repeat(1_000_001));
    const result = await evaluateCheck(ws.root, check({ kind: "contains", path: "big.md", pattern: "x" }));
    expect(result.outcome).toBe("error");
    ws.close();
  }, 10_000);

  // A pattern JavaScriptCore genuinely cannot resolve quickly (verified empirically: this body
  // and pattern combination takes several seconds run to completion), run against a worker with a
  // 2 s timeout: the check reads as `error`, and this test itself only waits ~2 s, not the several
  // seconds the regex would otherwise take, because the worker is terminated instead of awaited.
  test("a slow regex times out in its worker and reads as error", async () => {
    const ws = workspace();
    writeFileSync(join(ws.root, "a.txt"), "a".repeat(22));
    const startedAt = Date.now();
    const result = await evaluateCheck(
      ws.root,
      check({ kind: "matches", path: "a.txt", pattern: "(.*)(.*)(.*)(.*)(.*)(.*)(.*)(.*)(.*)(.*)(.*)(.*)(.*)(.*)(.*)b" }),
    );
    expect(result.outcome).toBe("error");
    expect(result.detail).toContain("too long");
    // Comfortably under the several seconds an un-terminated worker would have taken.
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    ws.close();
  }, 10_000);

  test("a pattern that does not compile is an error", async () => {
    const ws = workspace();
    writeFileSync(join(ws.root, "a.md"), "x");
    const result = await evaluateCheck(ws.root, check({ kind: "matches", path: "a.md", pattern: "(" }));
    expect(result.outcome).toBe("error");
    ws.close();
  });
});

describe("evaluateCheck: command", () => {
  test("a plain command passes and reports its output", async () => {
    const ws = workspace();
    const result = await evaluateCheck(ws.root, check({ kind: "command", command: "echo hi" }));
    expect(result).toMatchObject({ outcome: "pass", exitCode: 0, output: "hi" });
    ws.close();
  });

  test("a nonzero exit fails, expect_exit can be set to expect it", async () => {
    const ws = workspace();
    const fail = await evaluateCheck(ws.root, check({ kind: "command", command: "exit 3" }));
    expect(fail).toMatchObject({ outcome: "fail", exitCode: 3 });
    const expected = await evaluateCheck(ws.root, check({ kind: "command", command: "exit 3", expect_exit: 3 }));
    expect(expected.outcome).toBe("pass");
    ws.close();
  });

  test("expect_stdout must match exactly (normalized)", async () => {
    const ws = workspace();
    const ok = await evaluateCheck(ws.root, check({ kind: "command", command: "echo hi", expect_stdout: "hi" }));
    expect(ok.outcome).toBe("pass");
    const bad = await evaluateCheck(ws.root, check({ kind: "command", command: "echo hi", expect_stdout: "bye" }));
    expect(bad.outcome).toBe("fail");
    ws.close();
  });

  test("bun <missing script> fails cleanly, without running the shell", async () => {
    const ws = workspace();
    const result = await evaluateCheck(ws.root, check({ kind: "command", command: "bun missing.ts" }));
    expect(result.outcome).toBe("fail");
    expect(result.detail).toContain("missing.ts is missing");
    ws.close();
  });

  test("a missing cwd fails", async () => {
    const ws = workspace();
    const result = await evaluateCheck(ws.root, check({ kind: "command", command: "true", cwd: "no/such/dir" }));
    expect(result.outcome).toBe("fail");
    expect(result.detail).toBe("missing cwd");
    ws.close();
  });

  test("a command that reaches outside the workspace is blocked", async () => {
    const ws = workspace();
    const result = await evaluateCheck(ws.root, check({ kind: "command", command: "cat /etc/passwd" }));
    expect(result.outcome).toBe("blocked");
    ws.close();
  });

  test("runs in the given cwd, workspace-relative", async () => {
    const ws = workspace();
    mkdirSync(join(ws.root, "sub"));
    writeFileSync(join(ws.root, "sub", "here.txt"), "");
    const result = await evaluateCheck(ws.root, check({ kind: "command", command: "ls here.txt", cwd: "sub" }));
    expect(result.outcome).toBe("pass");
    ws.close();
  });

  test("times out and kills the whole process group, not just the shell", async () => {
    const ws = workspace();
    const marker = join(ws.root, "marker");
    // The shell backgrounds a grandchild that sleeps well past the timeout; a plain SIGTERM to the
    // shell alone would leave it running to write the marker file.
    const command = `( sleep 5; touch "${marker}" ) & sleep 5`;
    const startedAt = Date.now();
    const result = await evaluateCheck(ws.root, check({ kind: "command", command, timeout_sec: 1 }));
    expect(result.outcome).toBe("fail");
    expect(result.detail).toContain("timed out");
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(marker)).toBe(false);
    ws.close();
  }, 10_000);

  test("an abort signal kills the command as an error", async () => {
    const ws = workspace();
    const controller = new AbortController();
    const pending = evaluateCheck(ws.root, check({ kind: "command", command: "sleep 5" }), { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.outcome).toBe("error");
    ws.close();
  }, 10_000);

  test("output is tailed to the last stretch when it runs long", async () => {
    const ws = workspace();
    const result = await evaluateCheck(ws.root, check({ kind: "command", command: "for i in $(seq 1 4000); do echo line-$i; done" }));
    expect(result.outcome).toBe("pass");
    expect(result.output!.length).toBeLessThanOrEqual(2000);
    expect(result.output!.endsWith("line-4000")).toBe(true);
    expect(result.output!.startsWith("…")).toBe(true);
    ws.close();
  }, 10_000);
});
