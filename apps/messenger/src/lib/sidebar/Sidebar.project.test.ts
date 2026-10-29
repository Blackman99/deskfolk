import { expect, test } from "bun:test";
import type { SessionSummary } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aMessage, aProjectSession, anAgentRun, fakeRuntime } from "../test-fixtures.ts";
import { click, fill, press, render } from "../test-render.ts";
import { settle } from "../test-async.ts";
import Sidebar from "./Sidebar.svelte";

const t = copyFor("zh");

function open(
  selected: ReturnType<typeof aProjectSession> | null = null,
  rename: { renamingSessionId?: string | null; onRenameSession?: (id: string, name: string | null) => Promise<boolean>; onOpenProjectDir?: (session: SessionSummary) => void } = {},
) {
  const runtime = fakeRuntime({
    bots: [aBot({ id: "bot-1" })],
    sessions: [
      aProjectSession({ id: "p1", name: "Fix login", project_dir: "/Users/a/proj", updated_at: "2026-09-19T02:00:00.000Z" }),
      aProjectSession({ id: "p2", name: null, project_dir: "/Users/a/proj", updated_at: "2026-09-19T01:00:00.000Z" }),
      aProjectSession({ id: "p3", name: "Other", project_dir: "/Users/a/other", updated_at: "2026-09-18T01:00:00.000Z" }),
    ],
    agentRuns: { p1: anAgentRun({ session_id: "p1" }) },
    messages: [aMessage({ id: "m-p2", session_id: "p2", body: "把登录页的报错修一下" })],
  });
  runtime.selectedId = selected?.id ?? null;
  const view = render(Sidebar, {
    runtime, t, selected, pinnedSessionIds: [], workspaceOpen: false, contextMenuSessionId: null,
    onOpenContextMenu: () => {}, onToggleWorkspace: () => {}, onOpenRoutines: () => {}, onOpenSpend: () => {},
    workbench: true, onNewTerminal: () => {}, onOpenSettings: () => {}, onCreateBot: () => {}, onCreateGroup: () => {},
    onOpenSearch: () => {},
    ...rename,
  });
  return { ...view, runtime };
}

test("the Projects section lists one open row per directory, labelled by its last segment, its sessions newest first, each with its agent's mark", () => {
  const { host, close } = open();
  const dirs = [...host.querySelectorAll("[data-project-dir]")];
  expect(dirs.map((d) => d.querySelector(".project-dir-name")?.textContent)).toEqual(["proj", "other"]);
  expect(dirs[0]?.querySelector(".project-dir-head")?.getAttribute("title")).toBe("/Users/a/proj");
  // A directory is a folder; each session under it wears its own agent's mark, since one directory
  // can hold sessions of different agents.
  expect(dirs[0]?.querySelector(".project-dir-head [data-agent-logo]")).toBeNull();
  expect(dirs[0]?.querySelector(".project-dir-head svg")).not.toBeNull();
  const rows = [...dirs[0]!.querySelectorAll("[data-project-session]")];
  expect(rows.map((r) => r.querySelector(".t")?.textContent)).toEqual(["Fix login", t.project.untitled]);
  expect(rows.map((r) => r.querySelector(".row-avatar [data-agent-logo]")?.getAttribute("data-agent-logo"))).toEqual(["claude_code", "claude_code"]);
  close();
});

test("a project session's row says what a Bot's does: the run at work in place of the last line, else that line", () => {
  const { host, close } = open();
  const rows = [...host.querySelectorAll('[data-project-dir="/Users/a/proj"] [data-project-session]')];
  // p1's run is going: its status speaks, on the second line and on the avatar, the way a Bot's turn does.
  expect(rows[0]?.querySelector(".row-status")?.className).toContain("is-running");
  expect(rows[0]?.querySelector(".row-status-text")?.textContent).toBe(t.sidebar.statusRunning);
  expect(rows[0]?.querySelector(".row-avatar .avatar-status-dot")?.className).toContain("is-running");
  // p2 is quiet: no status, its last line instead.
  expect(rows[1]?.querySelector(".row-status")?.className).toContain("is-idle");
  expect(rows[1]?.querySelector(".s")?.textContent).toBe("把登录页的报错修一下");
  // Nothing said yet reads as a Bot's empty conversation does.
  expect(host.querySelector('[data-project-dir="/Users/a/other"] [data-project-session] .s')?.textContent).toBe(t.sidebar.noMessages);
  close();
});

test("folding a directory hides its sessions, and a row opens its session", () => {
  const { host, runtime, close } = open();
  click(host.querySelector("[data-project-dir] .project-dir-head"));
  const dirs = [...host.querySelectorAll("[data-project-dir]")];
  expect(dirs[0]!.querySelectorAll("[data-project-session]")).toHaveLength(0);
  const other = [...dirs[1]!.querySelectorAll("[data-project-session]")];
  expect(other.map((r) => r.querySelector(".t")?.textContent)).toEqual(["Other"]);
  click(other[0]);
  expect(runtime.calls.find((c) => c.name === "selectSession")?.args[0]).toBe("p3");
  close();
});

test("the section's + offers a new session of each agent in a folder, or a terminal session to import", async () => {
  const { host, runtime, close } = open();
  const add = host.querySelector<HTMLButtonElement>(`.ghead .add[title="${t.project.add}"]`);
  click(add);
  await settle();
  expect(add?.getAttribute("aria-expanded")).toBe("true");
  const items = [...document.querySelectorAll("[data-project-add-menu] [role=menuitem]")];
  expect(items.map((item) => item.textContent?.trim())).toEqual([`${t.project.newWith("Claude Code")}…`, `${t.project.newWith("Codex")}…`, t.project.importSession]);
  click(document.querySelector('[data-project-add-menu] [data-project-add="import"]'));
  await settle();
  expect(runtime.calls.filter((c) => c.name === "openCreateProject").map((c) => c.args)).toEqual([["import"]]);
  expect(document.querySelector("[data-project-add-menu]")).toBeNull();
  // Outside the desktop window there is no folder dialog: a new one goes through the sheet.
  click(add);
  await settle();
  click(document.querySelector('[data-project-add-menu] [data-project-add="new"]'));
  await settle();
  click(add);
  await settle();
  click(document.querySelector('[data-project-add-menu] [data-project-agent="codex"]'));
  await settle();
  // The sheet opens on the agent you chose.
  expect(runtime.calls.filter((c) => c.name === "openCreateProject").map((c) => c.args)).toEqual([["import"], ["new", "claude_code"], ["new", "codex"]]);
  close();
});

test("each directory row starts a new session of the agent you pick right there", async () => {
  const { host, runtime, close } = open();
  const add = host.querySelector('[data-project-dir="/Users/a/other"] [data-project-dir-add]');
  expect(add?.getAttribute("title")).toBe(t.project.newHere("other"));
  click(add);
  await settle();
  expect(add?.getAttribute("aria-expanded")).toBe("true");
  const menu = document.querySelector("[data-project-add-menu]");
  expect(menu?.getAttribute("aria-label")).toBe(t.project.newHere("other"));
  // The directory is already picked: no ellipsis, and nothing to import here; a terminal starts in it.
  expect([...(menu?.querySelectorAll("[role=menuitem]") ?? [])].map((item) => item.textContent?.trim())).toEqual([t.project.newWith("Claude Code"), t.project.newWith("Codex"), t.project.openTerminal]);
  click(menu?.querySelector('[data-project-agent="codex"]'));
  await settle();
  expect(runtime.calls.find((c) => c.name === "createProjectSession")?.args).toEqual([{ agent: "codex", dir: "/Users/a/other" }]);
  expect(document.querySelector("[data-project-add-menu]")).toBeNull();
  // It starts a session; it does not fold the directory.
  expect(host.querySelectorAll('[data-project-dir="/Users/a/other"] [data-project-session]')).toHaveLength(1);
  close();
});

test("a directory's + also opens the directory, by the session open in it or else its newest", async () => {
  const openedDirs: string[] = [];
  const { host, close } = open(null, { onOpenProjectDir: (session) => openedDirs.push(session.id) });
  const add = host.querySelector('[data-project-dir="/Users/a/proj"] [data-project-dir-add]');
  click(add);
  await settle();
  const menu = document.querySelector("[data-project-add-menu]");
  expect([...(menu?.querySelectorAll("[role=menuitem]") ?? [])].map((item) => item.textContent?.trim())).toEqual([t.project.newWith("Claude Code"), t.project.newWith("Codex"), t.project.openDir, t.project.openTerminal]);
  click(menu?.querySelector("[data-project-open-dir]"));
  await settle();
  expect(document.querySelector("[data-project-add-menu]")).toBeNull();
  close();
  // p2 is the older of the two in /Users/a/proj; open, it is the one the directory goes by.
  const p2 = aProjectSession({ id: "p2", name: null, project_dir: "/Users/a/proj", updated_at: "2026-09-19T01:00:00.000Z" });
  const again = open(p2, { onOpenProjectDir: (session) => openedDirs.push(session.id) });
  click(again.host.querySelector('[data-project-dir="/Users/a/proj"] [data-project-dir-add]'));
  await settle();
  click(document.querySelector("[data-project-add-menu] [data-project-open-dir]"));
  await settle();
  expect(openedDirs).toEqual(["p1", "p2"]);
  again.close();
});

test("a right-click on a directory row opens the same menu where the pointer is", async () => {
  const openedDirs: string[] = [];
  const { host, runtime, close } = open(null, { onOpenProjectDir: (session) => openedDirs.push(session.id) });
  const row = host.querySelector('[data-project-dir="/Users/a/other"] .project-dir-row');
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
  row?.dispatchEvent(event);
  await settle();
  expect(event.defaultPrevented).toBe(true);
  const menu = document.querySelector<HTMLElement>("[data-project-add-menu]");
  expect(menu?.getAttribute("aria-label")).toBe(t.project.newHere("other"));
  expect(menu?.style.left).toBe("40px");
  expect(menu?.style.top).toBe("60px");
  // The + it did not come from does not read as open.
  expect(host.querySelector('[data-project-dir="/Users/a/other"] [data-project-dir-add]')?.getAttribute("aria-expanded")).toBe("false");
  expect([...(menu?.querySelectorAll("[role=menuitem]") ?? [])].map((item) => item.textContent?.trim())).toEqual([t.project.newWith("Claude Code"), t.project.newWith("Codex"), t.project.openDir, t.project.openTerminal]);
  click(menu?.querySelector("[data-project-open-dir]"));
  await settle();
  expect(openedDirs).toEqual(["p3"]);
  // A new session from it starts right in that directory, as the + does.
  row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  await settle();
  click(document.querySelector('[data-project-add-menu] [data-project-agent="claude_code"]'));
  await settle();
  expect(runtime.calls.find((c) => c.name === "createProjectSession")?.args).toEqual([{ agent: "claude_code", dir: "/Users/a/other" }]);
  close();
});

test("a directory's menu opens a terminal in that directory, with no session to go by", async () => {
  const { host, runtime, close } = open(null, { onOpenProjectDir: () => {} });
  host.querySelector('[data-project-dir="/Users/a/other"] .project-dir-row')?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  await settle();
  const item = document.querySelector("[data-project-add-menu] [data-project-open-terminal]");
  // It sits with Open project folder, below the new-session items' divider.
  expect(item?.previousElementSibling?.hasAttribute("data-project-open-dir")).toBe(true);
  click(item);
  await settle();
  expect(document.querySelector("[data-project-add-menu]")).toBeNull();
  expect(runtime.calls.filter((c) => c.name === "openTerminalAt").map((c) => c.args)).toEqual([["/Users/a/other"]]);
  expect(runtime.calls.some((c) => c.name === "selectSession")).toBe(false);
  close();
});

test("a row being renamed is a name field: Enter saves the new name, Escape and a blank one leave it", async () => {
  const names: Array<[string, string | null]> = [];
  const { host, close } = open(null, { renamingSessionId: "p1", onRenameSession: async (id, name) => { names.push([id, name]); return true; } });
  await settle();
  const field = host.querySelector<HTMLInputElement>("[data-renaming] input");
  expect(field?.value).toBe("Fix login");
  expect(document.activeElement).toBe(field);
  fill(field, "  登录修复  ");
  press(field, "Enter");
  await settle();
  // Its blur after Enter is not a second save.
  field?.dispatchEvent(new FocusEvent("blur"));
  await settle();
  expect(names).toEqual([["p1", "登录修复"]]);
  close();

  const left: Array<[string, string | null]> = [];
  const again = open(null, { renamingSessionId: "p1", onRenameSession: async (id, name) => { left.push([id, name]); return true; } });
  await settle();
  const escape = again.host.querySelector<HTMLInputElement>("[data-renaming] input");
  fill(escape, "别存这个");
  press(escape, "Escape");
  escape?.dispatchEvent(new FocusEvent("blur"));
  await settle();
  expect(left).toEqual([["p1", null]]);
  again.close();

  const blank: Array<[string, string | null]> = [];
  const third = open(null, { renamingSessionId: "p2", onRenameSession: async (id, name) => { blank.push([id, name]); return true; } });
  await settle();
  const unnamed = third.host.querySelector<HTMLInputElement>("[data-renaming] input");
  // An unnamed session starts empty, its stand-in name only as the placeholder.
  expect([unnamed?.value, unnamed?.placeholder]).toEqual(["", t.project.untitled]);
  press(unnamed, "Enter");
  await settle();
  expect(blank).toEqual([["p2", null]]);
  third.close();
});

test("a name that did not go through keeps the field open and says so", async () => {
  const { host, close } = open(null, { renamingSessionId: "p1", onRenameSession: async () => false });
  await settle();
  const field = host.querySelector<HTMLInputElement>("[data-renaming] input");
  fill(field, "新名字");
  press(field, "Enter");
  await settle();
  expect(host.querySelector("[data-renaming] input")?.getAttribute("aria-invalid")).toBe("true");
  expect(host.querySelector("[data-renaming] input")?.getAttribute("title")).toBe(t.project.renameFailed);
  close();
});

