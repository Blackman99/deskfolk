import { expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID, type Bot, type SessionSummary } from "@real-bot/protocol";
import { sessionPresence, sessionTitle } from "./session-title.ts";

const bots = new Map<string, Bot>([
  [
    "writer",
    {
      id: "writer",
      name: "Writer",
      duties: "",
      boundaries: "",
      model: null,
      archived_at: null,
      created_at: "t",
      updated_at: "t",
    },
  ],
  [
    "researcher",
    {
      id: "researcher",
      name: "Researcher",
      duties: "",
      boundaries: "",
      model: null,
      archived_at: null,
      created_at: "t",
      updated_at: "t",
    },
  ],
]);

test("group title is the stored name, never spliced members", () => {
  const s: SessionSummary = {
    id: "g",
    kind: "group",
    name: "Brief",
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: "writer", joined_at: "t", left_at: null },
      { member: "researcher", joined_at: "t", left_at: null },
    ],
  };
  expect(sessionTitle(s, bots)).toBe("Brief");
  expect(sessionPresence(s, bots, "你", "在场")).toBe("在场: 你, Writer, Researcher");
});

test("you↔Bot title is the Bot name", () => {
  const s: SessionSummary = {
    id: "d",
    kind: "direct",
    name: null,
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: "writer", joined_at: "t", left_at: null },
    ],
  };
  expect(sessionTitle(s, bots)).toBe("Writer");
});

test("you↔Bot title uses the deleted label when the roster row is gone, never the ULID", () => {
  const s: SessionSummary = {
    id: "d",
    kind: "direct",
    name: null,
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: "gone", joined_at: "t", left_at: null },
    ],
  };
  expect(sessionTitle(s, bots, { deleted: "已删除", archived: "已归档" })).toBe("已删除");
  expect(sessionPresence(s, bots, "你", "", { deleted: "已删除", archived: "已归档" })).toBe(
    "你 ↔ 已删除",
  );
});

test("archived you↔Bot keeps the live name; group presence marks archived bots", () => {
  const archived = new Map(bots);
  archived.set("writer", { ...bots.get("writer")!, archived_at: "t2" });
  const you: SessionSummary = {
    id: "d",
    kind: "direct",
    name: null,
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: "writer", joined_at: "t", left_at: null },
    ],
  };
  expect(sessionTitle(you, archived, { deleted: "已删除", archived: "已归档" })).toBe("Writer");
  const group: SessionSummary = {
    id: "g",
    kind: "group",
    name: "Brief",
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: "writer", joined_at: "t", left_at: null },
      { member: "researcher", joined_at: "t", left_at: null },
    ],
  };
  expect(sessionPresence(group, archived, "你", "在场", { deleted: "已删除", archived: "已归档" })).toBe(
    "在场: 你, Writer · 已归档, Researcher",
  );
});

test("Bot↔Bot title joins the two names", () => {
  const s: SessionSummary = {
    id: "bb",
    kind: "direct",
    name: null,
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "writer", joined_at: "t", left_at: null },
      { member: "researcher", joined_at: "t", left_at: null },
    ],
  };
  expect(sessionTitle(s, bots)).toBe("Writer ↔ Researcher");
  expect(sessionPresence(s, bots, "你", "可打开")).toBe("Writer, Researcher · 你 可打开");
});

test("the file drop is titled from the label, not from a missing Bot", () => {
  const s: SessionSummary = {
    id: FILE_DROP_SESSION_ID,
    kind: "direct",
    name: null,
    created_at: "t",
    updated_at: "t",
    participants: [{ member: "user", joined_at: "t", left_at: null }],
  };
  expect(sessionTitle(s, bots, { deleted: "已删除", archived: "已归档", fileDrop: "文件" })).toBe("文件");
  expect(sessionPresence(s, bots, "你", "", { deleted: "已删除", archived: "已归档", fileDrop: "文件" })).toBe("文件");
});
