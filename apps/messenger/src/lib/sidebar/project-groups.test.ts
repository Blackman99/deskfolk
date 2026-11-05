import { expect, test } from "bun:test";
import type { ClaudeCodeSessionListing } from "@real-bot/protocol";
import { aProjectSession, anAgentRun } from "../test-fixtures.ts";
import { classifySession, groupSessions } from "./session-groups.ts";
import { dirDisplay, groupProjectSessions, isAbsoluteDir, isLiveRun, listingSpansAccounts, liveRunSessionIds, pickerDirs, projectDirLabel } from "./project-groups.ts";

test("a directory is labelled by its last segment, either separator", () => {
  expect(projectDirLabel("/Users/a/proj")).toBe("proj");
  expect(projectDirLabel("/Users/a/proj/")).toBe("proj");
  expect(projectDirLabel("C:\\Users\\a\\proj")).toBe("proj");
  expect(projectDirLabel("/")).toBe("/");
});

test("project sessions group by directory, directories newest first by their first session, sessions by their latest activity", () => {
  const sessions = [
    aProjectSession({ id: "a1", project_dir: "/w/a", created_at: "2026-09-18T01:00:00.000Z", updated_at: "2026-09-19T01:00:00.000Z" }),
    aProjectSession({ id: "b1", project_dir: "/w/b", created_at: "2026-09-18T02:00:00.000Z", updated_at: "2026-09-19T03:00:00.000Z" }),
    aProjectSession({ id: "a2", project_dir: "/w/a", created_at: "2026-09-18T03:00:00.000Z", updated_at: "2026-09-19T02:00:00.000Z" }),
    aProjectSession({ id: "none", project_dir: null }),
  ];
  const groups = groupProjectSessions(sessions);
  expect(groups.map((g) => g.dir)).toEqual(["/w/b", "/w/a"]);
  expect(groups.map((g) => g.label)).toEqual(["b", "a"]);
  expect(groups[1]!.sessions.map((s) => s.id)).toEqual(["a2", "a1"]);
});

test("a new session, a new line or a read in one directory reorders only that directory's sessions", () => {
  const a1 = aProjectSession({ id: "a1", project_dir: "/w/a", created_at: "2026-09-18T01:00:00.000Z", updated_at: "2026-09-18T01:00:00.000Z" });
  const b1 = aProjectSession({ id: "b1", project_dir: "/w/b", created_at: "2026-09-18T02:00:00.000Z", updated_at: "2026-09-18T02:00:00.000Z" });
  expect(groupProjectSessions([a1, b1]).map((g) => g.dir)).toEqual(["/w/b", "/w/a"]);
  // A new session in the lower directory: it heads that directory, and the directory stays put.
  const a2 = aProjectSession({ id: "a2", project_dir: "/w/a", created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z" });
  const after = groupProjectSessions([a1, b1, a2]);
  expect(after.map((g) => g.dir)).toEqual(["/w/b", "/w/a"]);
  expect(after[1]!.sessions.map((s) => s.id)).toEqual(["a2", "a1"]);
  // A line or a read moves updated_at only.
  expect(groupProjectSessions([{ ...a1, updated_at: "2026-09-21T00:00:00.000Z" }, b1]).map((g) => g.dir)).toEqual(["/w/b", "/w/a"]);
  // A session in a folder never used before brings the folder in on top.
  const c1 = aProjectSession({ id: "c1", project_dir: "/w/c", created_at: "2026-09-22T00:00:00.000Z", updated_at: "2026-09-22T00:00:00.000Z" });
  expect(groupProjectSessions([a1, b1, a2, c1]).map((g) => g.dir)).toEqual(["/w/c", "/w/b", "/w/a"]);
});

test("a directory's place goes by all its sessions, so pinning or filtering out its oldest one does not move it", () => {
  const a1 = aProjectSession({ id: "a1", project_dir: "/w/a", created_at: "2026-09-18T01:00:00.000Z" });
  const a2 = aProjectSession({ id: "a2", project_dir: "/w/a", created_at: "2026-09-18T05:00:00.000Z" });
  const b1 = aProjectSession({ id: "b1", project_dir: "/w/b", created_at: "2026-09-18T02:00:00.000Z" });
  const all = [a1, a2, b1];
  expect(groupProjectSessions(all).map((g) => g.dir)).toEqual(["/w/b", "/w/a"]);
  // a1 pinned (or hidden by "working only"): /w/a lists only a2, and still keeps its place.
  expect(groupProjectSessions([a2, b1], all).map((g) => g.dir)).toEqual(["/w/b", "/w/a"]);
  // Without the whole list it would have read a2's time and jumped.
  expect(groupProjectSessions([a2, b1]).map((g) => g.dir)).toEqual(["/w/a", "/w/b"]);
});

test("a project session is its own group, up with the pins once pinned, and never in the Bot lists", () => {
  const project = aProjectSession();
  expect(classifySession(project)).toBe("project");
  expect(groupSessions([project]).project).toEqual([project]);
  const grouped = groupSessions([project], ["proj-1"]);
  expect(grouped.project).toEqual([]);
  expect(grouped.pinned).toEqual([project]);
  expect(grouped.bots).toEqual([]);
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

test("the sheet's directories: the terminal's and the app's, each once, newest first, with that directory's sessions", () => {
  const listing = (session_id: string, cwd: string | null, modified_at: string, config_dir: string | null = null): ClaudeCodeSessionListing => ({
    session_id, config_dir, title: "", cwd, git_branch: null, modified_at, size: 1,
  });
  const items = [
    listing("s1", "/w/a", "2026-09-19T05:00:00.000Z"),
    listing("s2", null, "2026-09-19T04:00:00.000Z"),
    listing("s3", "/w/b", "2026-09-19T03:00:00.000Z"),
    listing("s4", "/w/a", "2026-09-19T02:00:00.000Z"),
  ];
  // A directory used only in the app, and one newer in the app than in the terminal.
  const sessions = [
    aProjectSession({ id: "p1", project_dir: "/w/c", updated_at: "2026-09-19T01:00:00.000Z" }),
    aProjectSession({ id: "p2", project_dir: "/w/b", updated_at: "2026-09-19T06:00:00.000Z" }),
  ];
  const dirs = pickerDirs(items, sessions, "claude_code");
  expect(dirs.map((d) => d.dir)).toEqual(["/w/b", "/w/a", "/w/c"]);
  expect(dirs.map((d) => d.label)).toEqual(["b", "a", "c"]);
  expect(dirs.map((d) => d.listings.map((l) => l.session_id))).toEqual([["s3"], ["s1", "s4"], []]);
  expect(dirs[0]!.latest).toBe("2026-09-19T06:00:00.000Z");
  // Codex carries no terminal session on: the same folders, none listed under them.
  const codex = pickerDirs(items, [...sessions, aProjectSession({ id: "p3", project_dir: "/w/d", project_agent: "codex", updated_at: "2026-09-19T00:00:00.000Z" })], "codex");
  expect(codex.map((d) => d.dir)).toEqual(["/w/b", "/w/a", "/w/c", "/w/d"]);
  expect(codex.every((d) => d.listings.length === 0)).toBe(true);
  expect(listingSpansAccounts(items)).toBe(false);
  expect(listingSpansAccounts([...items, listing("s5", "/w/a", "t", "/Users/a/.claude-b")])).toBe(true);
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
