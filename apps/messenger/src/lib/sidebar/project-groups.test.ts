import { expect, test } from "bun:test";
import type { ClaudeCodeSessionListing } from "@real-bot/protocol";
import { aProjectSession, anAgentRun } from "../test-fixtures.ts";
import { classifySession, groupSessions } from "./session-groups.ts";
import { dirDisplay, groupProjectSessions, isAbsoluteDir, isLiveRun, liveRunSessionIds, projectDirLabel, recentProjectDirs } from "./project-groups.ts";

test("a directory is labelled by its last segment, either separator", () => {
  expect(projectDirLabel("/Users/a/proj")).toBe("proj");
  expect(projectDirLabel("/Users/a/proj/")).toBe("proj");
  expect(projectDirLabel("C:\\Users\\a\\proj")).toBe("proj");
  expect(projectDirLabel("/")).toBe("/");
});

test("project sessions group by directory, directories and sessions newest first", () => {
  const sessions = [
    aProjectSession({ id: "a1", project_dir: "/w/a", updated_at: "2026-09-19T01:00:00.000Z" }),
    aProjectSession({ id: "b1", project_dir: "/w/b", updated_at: "2026-09-19T03:00:00.000Z" }),
    aProjectSession({ id: "a2", project_dir: "/w/a", updated_at: "2026-09-19T02:00:00.000Z" }),
    aProjectSession({ id: "none", project_dir: null }),
  ];
  const groups = groupProjectSessions(sessions);
  expect(groups.map((g) => g.dir)).toEqual(["/w/b", "/w/a"]);
  expect(groups.map((g) => g.label)).toEqual(["b", "a"]);
  expect(groups[1]!.sessions.map((s) => s.id)).toEqual(["a2", "a1"]);
});

test("a project session is its own group, never pinned and never in the Bot lists", () => {
  const project = aProjectSession();
  expect(classifySession(project)).toBe("project");
  const grouped = groupSessions([project], ["proj-1"]);
  expect(grouped.project).toEqual([project]);
  expect(grouped.pinned).toEqual([]);
  expect(grouped.youBot).toEqual([]);
  expect(grouped.botBot).toEqual([]);
  expect(groupSessions([aProjectSession({ archived_at: "t" })]).project).toEqual([]);
});

test("a run is live while it works or waits on you", () => {
  expect(isLiveRun(anAgentRun({ status: "running" }))).toBe(true);
  expect(isLiveRun(anAgentRun({ status: "waiting_approval" }))).toBe(true);
  for (const status of ["completed", "failed", "stopped", "interrupted"] as const) {
    expect(isLiveRun(anAgentRun({ status }))).toBe(false);
  }
  expect(isLiveRun(null)).toBe(false);
  expect(liveRunSessionIds({ a: anAgentRun({ session_id: "a" }), b: anAgentRun({ session_id: "b", status: "completed" }) })).toEqual(["a"]);
});

test("recent directories are each session's cwd once, in order, capped", () => {
  const listing = (cwd: string | null): ClaudeCodeSessionListing => ({
    session_id: "s", config_dir: null, title: "", cwd, git_branch: null, modified_at: "t", size: 1,
  });
  const items = [listing("/w/a"), listing(null), listing("/w/b"), listing("/w/a"), listing("/w/c")];
  expect(recentProjectDirs(items)).toEqual(["/w/a", "/w/b", "/w/c"]);
  expect(recentProjectDirs(items, 2)).toEqual(["/w/a", "/w/b"]);
});

test("a typed directory must be absolute; home reads as a tilde", () => {
  expect(isAbsoluteDir(" /Users/a/proj ")).toBe(true);
  expect(isAbsoluteDir("C:\\proj")).toBe(true);
  expect(isAbsoluteDir("proj")).toBe(false);
  expect(isAbsoluteDir("~/proj")).toBe(false);
  expect(dirDisplay("/Users/a/proj")).toBe("~/proj");
  expect(dirDisplay(null)).toBe("");
  expect(dirDisplay("/private/tmp/claude-501/scratchpad/e2e/some/deep/proj")).toBe("…/deep/proj");
});
