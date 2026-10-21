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
  });
  return { menu, opened };
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
