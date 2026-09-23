import { describe, expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID, type Bot, type SessionSummary } from "@real-bot/protocol";
import {
  computeContextMenuPosition,
  deriveSessionContextMenu,
} from "./session-context-menu.ts";

function direct(id: string, members: string[]): SessionSummary {
  return {
    id,
    kind: "direct",
    name: null,
    last_read_at: null,
    created_at: "t1",
    updated_at: "t1",
    participants: members.map((member) => ({
      session_id: id,
      member,
      joined_at: "t1",
      left_at: null,
    })),
  };
}

function group(id: string, name: string, members: string[]): SessionSummary {
  return {
    id,
    kind: "group",
    name,
    last_read_at: null,
    created_at: "t1",
    updated_at: "t1",
    participants: members.map((member) => ({
      session_id: id,
      member,
      joined_at: "t1",
      left_at: null,
    })),
  };
}

const botLive: Bot = {
  id: "writer",
  name: "Writer",
  duties: "write docs",
  boundaries: "stay in workspace",
  avatar: null,
  model: null,
  provider_id: null,
  archived_at: null,
  created_at: "t1",
  updated_at: "t1",
};

const botArchived: Bot = {
  ...botLive,
  id: "archived_bot",
  name: "ArchivedBot",
  archived_at: "t2",
};

const botsMap = new Map<string, Bot>([
  [botLive.id, botLive],
  [botArchived.id, botArchived],
]);

describe("deriveSessionContextMenu", () => {
  test("active group session allows pin, view info, clear history, delete group, and archive", () => {
    const s = group("g1", "Team", ["user", "writer"]);
    const res = deriveSessionContextMenu(s, false, botsMap);
    expect(res.sessionId).toBe("g1");
    expect(res.isPinned).toBe(false);
    expect(res.canViewInfo).toBe(true);
    expect(res.canClearHistory).toBe(true);
    expect(res.archive.enabled).toBe(true);
    expect(res.archive.isArchived).toBe(false);
    expect(res.archive.botId).toBeNull();
    expect(res.delete.enabled).toBe(true);
    expect(res.delete.kind).toBe("group");
    expect(res.delete.targetId).toBe("g1");
  });

  test("archived group session allows unarchive", () => {
    const s: SessionSummary = {
      ...group("g1", "Team", ["user", "writer"]),
      archived_at: "t2",
    };
    const res = deriveSessionContextMenu(s, false, botsMap);
    expect(res.archive.enabled).toBe(true);
    expect(res.archive.isArchived).toBe(true);
    expect(res.archive.botId).toBeNull();
  });

  test("pinned group reflects pinned state", () => {
    const s = group("g1", "Team", ["user", "writer"]);
    const res = deriveSessionContextMenu(s, true, botsMap);
    expect(res.isPinned).toBe(true);
  });

  test("you-bot with active bot allows archive (isArchived=false) and delete bot", () => {
    const s = direct("d1", ["user", "writer"]);
    const res = deriveSessionContextMenu(s, false, botsMap);
    expect(res.canViewInfo).toBe(true);
    expect(res.canClearHistory).toBe(true);
    expect(res.archive.enabled).toBe(true);
    expect(res.archive.isArchived).toBe(false);
    expect(res.archive.botId).toBe("writer");
    expect(res.delete.enabled).toBe(true);
    expect(res.delete.kind).toBe("bot");
    expect(res.delete.targetId).toBe("writer");
  });

  test("you-bot with archived bot allows unarchive (isArchived=true) and delete bot", () => {
    const s = direct("d2", ["user", "archived_bot"]);
    const res = deriveSessionContextMenu(s, true, botsMap);
    expect(res.isPinned).toBe(true);
    expect(res.archive.enabled).toBe(true);
    expect(res.archive.isArchived).toBe(true);
    expect(res.archive.botId).toBe("archived_bot");
    expect(res.delete.enabled).toBe(true);
    expect(res.delete.kind).toBe("bot");
    expect(res.delete.targetId).toBe("archived_bot");
  });

  test("you-bot with deleted bot disables archive and delete", () => {
    const s = direct("d3", ["user", "deleted_bot"]);
    const res = deriveSessionContextMenu(s, false, botsMap);
    expect(res.archive.enabled).toBe(false);
    expect(res.delete.enabled).toBe(false);
  });

  test("the file drop can be cleared and nothing else", () => {
    const s = direct(FILE_DROP_SESSION_ID, ["user"]);
    const res = deriveSessionContextMenu(s, false, botsMap);
    expect(res.canViewInfo).toBe(false);
    expect(res.canClearHistory).toBe(true);
    expect(res.archive.enabled).toBe(false);
    expect(res.delete.enabled).toBe(false);
  });

  test("bot-bot session disables archive and delete", () => {
    const s = direct("bb", ["writer", "archived_bot"]);
    const res = deriveSessionContextMenu(s, false, botsMap);
    expect(res.canViewInfo).toBe(true);
    expect(res.canClearHistory).toBe(true);
    expect(res.archive.enabled).toBe(false);
    expect(res.delete.enabled).toBe(false);
  });
});

describe("computeContextMenuPosition", () => {
  test("returns click coordinates when inside bounds", () => {
    const pos = computeContextMenuPosition(100, 200, 160, 220, 1000, 800);
    expect(pos).toEqual({ x: 100, y: 200 });
  });

  test("clamps x when overflowing right viewport edge", () => {
    const pos = computeContextMenuPosition(900, 200, 160, 220, 1000, 800, 8);
    expect(pos.x).toBe(1000 - 160 - 8);
    expect(pos.y).toBe(200);
  });

  test("clamps y when overflowing bottom viewport edge", () => {
    const pos = computeContextMenuPosition(100, 700, 160, 220, 1000, 800, 8);
    expect(pos.x).toBe(100);
    expect(pos.y).toBe(800 - 220 - 8);
  });
});
