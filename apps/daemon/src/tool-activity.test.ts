import { expect, test } from "bun:test";
import { TARGET_MAX, toolTargetOf } from "./tool-activity";

test("a file tool is about its path, a roster tool about its name, a memory about its subject", () => {
  expect(toolTargetOf("read_file", { path: "src/app.ts" })).toBe("src/app.ts");
  expect(toolTargetOf("create_direct", { name: "Writer" })).toBe("Writer");
  expect(toolTargetOf("remember", { subject: "交付格式", body: "PDF 给老板" })).toBe("交付格式");
  expect(toolTargetOf("create_routine", { title: "早报", instruction: "…" })).toBe("早报");
});

test("a body is never the target", () => {
  expect(toolTargetOf("write_file", { content: "secret draft" })).toBeUndefined();
  expect(toolTargetOf("send_message", { body: "hello" })).toBeUndefined();
  expect(toolTargetOf("create_skill", { description: "when", body: "how" })).toBeUndefined();
  expect(toolTargetOf("mcp_github_create_issue", { title: "Bug" })).toBeUndefined();
});

test("only the first line, trimmed; an empty or non-string value names nothing", () => {
  expect(toolTargetOf("create_group", { name: "  设计评审\n第二行" })).toBe("设计评审");
  expect(toolTargetOf("read_file", { path: "   " })).toBeUndefined();
  expect(toolTargetOf("read_file", { path: 42 })).toBeUndefined();
  expect(toolTargetOf("list_dir", {})).toBeUndefined();
});

test("a long path keeps its end, a long name its start", () => {
  const path = `${"deep/".repeat(60)}report.md`;
  const clippedPath = toolTargetOf("read_file", { path })!;
  expect(clippedPath.length).toBe(TARGET_MAX);
  expect(clippedPath.startsWith("…")).toBe(true);
  expect(clippedPath.endsWith("report.md")).toBe(true);

  const name = "x".repeat(TARGET_MAX + 20);
  const clippedName = toolTargetOf("create_bot", { name })!;
  expect(clippedName.length).toBe(TARGET_MAX);
  expect(clippedName.endsWith("…")).toBe(true);
});
