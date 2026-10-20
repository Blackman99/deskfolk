import { expect, test } from "bun:test";
import type { ClaudeCodeSessionListing } from "@real-bot/protocol";
import { importRequest, importSubtitle, newProjectRequest, tildePath } from "./import-claude-session.ts";

const session: ClaudeCodeSessionListing = {
  session_id: "s1",
  config_dir: "/Users/a/.claude",
  title: "  Fix the login redirect loop and then write a long paragraph about it afterwards  ",
  cwd: "/Users/a/proj",
  git_branch: "main",
  modified_at: new Date(2026, 8, 23, 9, 5).toISOString(),
  size: 10
};
const now = new Date(2026, 8, 23, 14, 30).getTime();

test("carrying a session on names the session and its account, no name", () => {
  expect(importRequest(session)).toEqual({ agent: "claude_code", import: { session_id: "s1", config_dir: "/Users/a/.claude" } });
  expect(importRequest({ ...session, config_dir: null }).import).toEqual({ session_id: "s1", config_dir: null });
});

test("a new session sends the trimmed directory", () => {
  expect(newProjectRequest("  /Users/a/proj ")).toEqual({ agent: "claude_code", dir: "/Users/a/proj" });
});

test("home shows as a tilde and the subtitle skips what is missing", () => {
  expect(tildePath("/Users/a/proj")).toBe("~/proj");
  expect(tildePath("/Users/a")).toBe("~");
  expect(tildePath("/opt/x")).toBe("/opt/x");
  expect(importSubtitle(session, now, "en")).toBe("~/proj · main · 09:05");
  expect(importSubtitle({ ...session, cwd: null, git_branch: null }, now, "en")).toBe("09:05");
});
