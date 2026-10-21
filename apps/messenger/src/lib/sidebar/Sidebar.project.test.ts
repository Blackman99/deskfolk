import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aProjectSession, anAgentRun, fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import Sidebar from "./Sidebar.svelte";

const t = copyFor("zh");

function open(selected: ReturnType<typeof aProjectSession> | null = null) {
  const runtime = fakeRuntime({
    bots: [aBot({ id: "bot-1" })],
    sessions: [
      aProjectSession({ id: "p1", name: "Fix login", project_dir: "/Users/a/proj", updated_at: "2026-09-19T02:00:00.000Z" }),
      aProjectSession({ id: "p2", name: null, project_dir: "/Users/a/proj", updated_at: "2026-09-19T01:00:00.000Z" }),
      aProjectSession({ id: "p3", name: "Other", project_dir: "/Users/a/other", updated_at: "2026-09-18T01:00:00.000Z" }),
    ],
    agentRuns: { p1: anAgentRun({ session_id: "p1" }) },
  });
  runtime.selectedId = selected?.id ?? null;
  const view = render(Sidebar, {
    runtime, t, selected, pinnedSessionIds: [], workspaceOpen: false, contextMenuSessionId: null,
    onOpenContextMenu: () => {}, onToggleWorkspace: () => {}, onOpenRoutines: () => {}, onOpenSpend: () => {},
    workbench: true, onNewTerminal: () => {}, onOpenSettings: () => {}, onCreateBot: () => {}, onCreateGroup: () => {},
    onOpenSearch: () => {},
  });
  return { ...view, runtime };
}

test("the Projects section lists one open row per agent and directory, labelled by its last segment with the agent's mark, its sessions newest first", () => {
  const { host, close } = open();
  const dirs = [...host.querySelectorAll("[data-project-dir]")];
  expect(dirs.map((d) => d.querySelector(".project-dir-name")?.textContent)).toEqual(["proj", "other"]);
  expect(dirs[0]?.querySelector(".project-dir-head")?.getAttribute("title")).toBe("Claude Code · /Users/a/proj");
  // Each directory row wears its agent's mark, not a folder.
  expect(dirs.map((d) => d.querySelector(".project-dir-head [data-agent-logo]")?.getAttribute("data-agent-logo"))).toEqual(["claude_code", "claude_code"]);
  const rows = [...dirs[0]!.querySelectorAll("[data-project-session]")];
  expect(rows.map((r) => r.querySelector(".name")?.textContent)).toEqual(["Fix login", t.project.untitled]);
  expect(rows[0]?.querySelector(".project-pulse")).not.toBeNull();
  expect(rows[1]?.querySelector(".project-pulse")).toBeNull();
  close();
});

test("folding a directory hides its sessions, and a row opens its session", () => {
  const { host, runtime, close } = open();
  click(host.querySelector("[data-project-dir] .project-dir-head"));
  const dirs = [...host.querySelectorAll("[data-project-dir]")];
  expect(dirs[0]!.querySelectorAll("[data-project-session]")).toHaveLength(0);
  const other = [...dirs[1]!.querySelectorAll("[data-project-session]")];
  expect(other.map((r) => r.querySelector(".name")?.textContent)).toEqual(["Other"]);
  click(other[0]);
  expect(runtime.calls.find((c) => c.name === "selectSession")?.args[0]).toBe("p3");
  close();
});

test("the section's + opens the project sheet", () => {
  const { host, runtime, close } = open();
  click(host.querySelector(`.ghead .add[title="${t.project.add}"]`));
  expect(runtime.calls.some((c) => c.name === "openCreateProject")).toBe(true);
  close();
});
