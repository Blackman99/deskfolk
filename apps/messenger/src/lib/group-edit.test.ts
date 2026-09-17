import { expect, test } from "bun:test";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import {
  canRemoveGroupBot,
  mapGroupEditError,
  planGroupName,
  presentBotIds,
  pullInCandidates,
} from "./group-edit.ts";

const writer: Bot = {
  id: "writer",
  name: "Writer",
  duties: "write",
  boundaries: "stay",
  model: null,
  archived_at: null,
  created_at: "t",
  updated_at: "t",
};
const researcher: Bot = { ...writer, id: "researcher", name: "Researcher" };
const reviewer: Bot = { ...writer, id: "reviewer", name: "Reviewer" };
const archived: Bot = { ...writer, id: "old", name: "Old", archived_at: "t2" };

const brief: SessionSummary = {
  id: "g",
  kind: "group",
  name: "Brief",
  created_at: "t",
  updated_at: "t",
  participants: [
    { member: "user", joined_at: "t", left_at: null },
    { member: "writer", joined_at: "t", left_at: null },
    { member: "researcher", joined_at: "t", left_at: null },
    { member: "reviewer", joined_at: "t", left_at: "later" },
  ],
};

test("whitespace group name does not produce a PATCH", () => {
  expect(planGroupName("   ")).toEqual({ ok: false, error: "empty" });
  expect(planGroupName(" Brief ")).toEqual({ ok: true, name: "Brief" });
});

test("present bots ignore you and members who already left", () => {
  expect(presentBotIds(brief)).toEqual(["writer", "researcher"]);
});

test("pull-in candidates are undeleted, unarchived, and not currently present, including former members", () => {
  expect(pullInCandidates([writer, researcher, reviewer, archived], brief).map((b) => b.id)).toEqual([
    "reviewer",
  ]);
});

test("remove is allowed only while more than two bots are present", () => {
  expect(canRemoveGroupBot(brief)).toBe(false);
  const three: SessionSummary = {
    ...brief,
    participants: [
      ...brief.participants.filter((p) => p.member !== "reviewer"),
      { member: "reviewer", joined_at: "t", left_at: null },
    ],
  };
  expect(canRemoveGroupBot(three)).toBe(true);
});

test("maps empty group-name 422 onto the locked empty kind", () => {
  expect(mapGroupEditError("name is required")).toEqual({ name: "empty" });
  expect(mapGroupEditError("a group needs at least two bots")).toEqual({ top: true });
});
