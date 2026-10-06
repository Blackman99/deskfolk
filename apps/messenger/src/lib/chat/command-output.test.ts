import { expect, test } from "bun:test";
import { commandLine, outputLang, splitProgram, viewedFile } from "./command-output.ts";

test("the leading cd every command starts with goes, and a script's lines fold into one", () => {
  expect(commandLine('cd "/Users/me/real-bot-workspace/work/2026-10-05-x" && cat scratch/a.py')).toBe("cat scratch/a.py");
  expect(commandLine("cd /tmp; cd sub && ls -la")).toBe("ls -la");
  expect(commandLine('python3 -c "\nimport json\nprint(1)\n"')).toBe('python3 -c " import json print(1) "');
  // A bare cd is still something it ran.
  expect(commandLine("cd /tmp")).toBe("cd /tmp");
});

test("the program is set apart from its arguments", () => {
  expect(splitProgram("python3 -c x")).toEqual({ program: "python3", rest: " -c x" });
  expect(splitProgram("ls")).toEqual({ program: "ls", rest: "" });
});

test("a viewing command names the file it prints, through a cd and before a pipe", () => {
  expect(viewedFile('cd "/w" && cat work/简报/scratch/generate_poster.py')).toBe("work/简报/scratch/generate_poster.py");
  expect(viewedFile("cat marks.py | grep render")).toBe("marks.py");
  expect(viewedFile("sed -n '1,80p' src/app.ts")).toBe("src/app.ts");
  expect(viewedFile("head -n 20 \"notes/a b.md\"")).toBe("notes/a b.md");
  expect(viewedFile("grep -n x a.py")).toBeNull();
  expect(viewedFile("cat")).toBeNull();
});

test("output is read by what printed it, then by its look, and as a log otherwise", () => {
  expect(outputLang("cat scratch/marks.py", "def f():\n    return 1\n")).toBe("python");
  expect(outputLang("ls", "\x1b[32mPASS\x1b[0m a.test.ts")).toBe("ansi");
  expect(outputLang('python3 -c "…"', '{"ok": true, "n": 3}')).toBe("json");
  expect(outputLang("jq -c . a.jsonl", '{"a":1}\n{"a":2}\n')).toBe("json");
  expect(outputLang("git diff", "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n")).toBe("diff");
  expect(outputLang("python3 render.py", "saved 3 frames to out/\n")).toBe("log");
  // A viewed file nobody can name falls back on the look of what it printed.
  expect(outputLang("cat notes.txt", "[1, 2]")).toBe("json");
});
