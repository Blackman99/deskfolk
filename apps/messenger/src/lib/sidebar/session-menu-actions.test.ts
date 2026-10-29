import { expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID, type SessionSummary } from "@real-bot/protocol";
import type { ShellDangerConfirm } from "../overlays/danger-confirm.svelte.ts";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import type { PaneContent } from "../workbench/pane-content.ts";
import { ShellSessionMenu } from "./session-menu-actions.svelte.ts";

function session(id: string, kind: SessionSummary["kind"], members: string[]): SessionSummary {
  return {
    id,
    kind,
    name: null,
    last_read_at: null,
    created_at: "t1",
    updated_at: "t1",
    participants: members.map((member) => ({ session_id: id, member, joined_at: "t1", left_at: null })),
  };
}

function menuOpening(): { menu: ShellSessionMenu; opened: PaneContent[] } {
  const opened: PaneContent[] = [];
  const runtime = { paneOpener: (content: PaneContent) => opened.push(content) } as unknown as MessengerRuntime;
  const menu = new ShellSessionMenu({
    runtime: () => runtime,
    botsById: () => new Map(),
    danger: () => ({}) as ShellDangerConfirm,
    togglePin: () => {},
    openProfile: () => {},
    openArtifact: () => {},
  });
  return { menu, opened };
}

/** A menu whose preview opens are written down, on the workbench or (no pane opener) off it. */
function menuPreviewing(workbench: boolean) {
  const steps: string[] = [];
  const previews: unknown[][] = [];
  const runtime = {
    paneOpener: workbench ? () => {} : null,
    selectedId: "d1",
    selectSession: async (id: string) => {
      steps.push(`select ${id}`);
    },
  } as unknown as MessengerRuntime;
  const menu = new ShellSessionMenu({
    runtime: () => runtime,
    botsById: () => new Map(),
    danger: () => ({}) as ShellDangerConfirm,
    togglePin: () => {},
    openProfile: () => {},
    openArtifact: (...args) => {
      steps.push("open");
      previews.push(args);
    },
  });
  return { menu, steps, previews };
}

test("the row's 地图 opens the task map of a Bot conversation, a group and a project session", () => {
  const { menu, opened } = menuOpening();
  menu.handleMenuShowMap(session("d1", "direct", ["you", "writer"]));
  menu.handleMenuShowMap(session("g1", "group", ["you", "writer", "reviewer"]));
  menu.handleMenuShowMap(session("p1", "project", ["you"]));
  expect(opened).toEqual([
    { kind: "map", sessionId: "d1" },
    { kind: "map", sessionId: "g1" },
    { kind: "map", sessionId: "p1" },
  ]);
});

test("the file drop has no task map", () => {
  const { menu, opened } = menuOpening();
  menu.handleMenuShowMap(session(FILE_DROP_SESSION_ID, "direct", ["you"]));
  expect(opened).toEqual([]);
});

test("a project session's directory opens in the preview as a folder, its own session's, so the tree is the project's", async () => {
  const { menu, steps, previews } = menuPreviewing(true);
  await menu.handleMenuOpenProjectDir({ ...session("p1", "project", ["you"]), project_dir: "/Users/a/proj" });
  // The workbench opens it in a tab of its own: the conversation on screen stays.
  expect(steps).toEqual(["open"]);
  expect(previews).toEqual([[
    "/Users/a/proj", undefined, null, false, null,
    [{ id: "virtual-project-/Users/a/proj", message_id: "", workspace_relpath: "/Users/a/proj", original_filename: "proj", created_at: "", is_dir: true }],
    "p1",
  ]]);
});

test("off the workbench the preview is the open conversation's, so the project session comes up first", async () => {
  const { menu, steps } = menuPreviewing(false);
  await menu.handleMenuOpenProjectDir({ ...session("p1", "project", ["you"]), project_dir: "/Users/a/proj" });
  expect(steps).toEqual(["select p1", "open"]);
});

test("a conversation with no project directory opens nothing", async () => {
  const { menu, steps } = menuPreviewing(false);
  await menu.handleMenuOpenProjectDir(session("d2", "direct", ["you", "writer"]));
  await menu.handleMenuOpenProjectDir({ ...session("p2", "project", ["you"]), project_dir: null });
  expect(steps).toEqual([]);
});
