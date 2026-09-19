import { expect, test } from "bun:test";
import type { SessionSummary } from "@real-bot/protocol";
import { classifySession, groupSessions, presentBotIds, youBotPeer, youBotSession } from "./session-groups.ts";

function session(
  id: string,
  kind: SessionSummary["kind"],
  members: { member: string; left?: boolean }[],
): SessionSummary {
  return {
    id,
    kind,
    name: kind === "group" ? "Brief" : null,
    created_at: "t",
    updated_at: "t",
    participants: members.map((m) => ({
      member: m.member,
      joined_at: "t",
      left_at: m.left ? "later" : null,
    })),
  };
}

test("presentBotIds skips you and members who already left", () => {
  const s = session("g", "group", [
    { member: "user" },
    { member: "writer" },
    { member: "researcher" },
    { member: "reviewer", left: true },
  ]);
  expect(presentBotIds(s)).toEqual(["writer", "researcher"]);
});

test("groups stay groups even with two bots and you", () => {
  const s = session("g", "group", [{ member: "user" }, { member: "a" }, { member: "b" }]);
  expect(classifySession(s)).toBe("group");
});

test("direct with you is you↔Bot", () => {
  const s = session("d", "direct", [{ member: "user" }, { member: "writer" }]);
  expect(classifySession(s)).toBe("you-bot");
});

test("direct with two bots and no you is Bot↔Bot", () => {
  const s = session("bb", "direct", [{ member: "writer" }, { member: "researcher" }]);
  expect(classifySession(s)).toBe("bot-bot");
});

test("a left you does not count as you↔Bot", () => {
  const s = session("d", "direct", [{ member: "user", left: true }, { member: "a" }, { member: "b" }]);
  expect(classifySession(s)).toBe("bot-bot");
});

test("groupSessions keeps groups first in its buckets, and extracts pinned", () => {
  const g = session("g", "group", [{ member: "user" }, { member: "a" }, { member: "b" }]);
  const you = session("d", "direct", [{ member: "user" }, { member: "writer" }]);
  const them = session("bb", "direct", [{ member: "writer" }, { member: "researcher" }]);
  expect(groupSessions([them, you, g])).toEqual({ pinned: [], groups: [g], youBot: [you], botBot: [them] });
  expect(groupSessions([them, you, g], ["d"])).toEqual({
    pinned: [you],
    groups: [g],
    youBot: [],
    botBot: [them],
  });
});

test("groupSessions filters out sessions with deleted bots when aliveBotIds is provided", () => {
  const g = session("g", "group", [{ member: "user" }, { member: "a" }, { member: "b" }]);
  const you = session("d", "direct", [{ member: "user" }, { member: "writer" }]);
  const deadYou = session("d_dead", "direct", [{ member: "user" }, { member: "deleted_bot" }]);
  const alive = new Set(["writer", "a", "b"]);
  expect(groupSessions([g, you, deadYou], [], alive)).toEqual({
    pinned: [],
    groups: [g],
    youBot: [you],
    botBot: [],
  });
});

test("groupSessions filters out archived sessions from groups, youBot, botBot and pinned", () => {
  const g = session("g", "group", [{ member: "user" }, { member: "a" }, { member: "b" }]);
  const gArchived: SessionSummary = {
    ...session("g_archived", "group", [{ member: "user" }, { member: "a" }, { member: "b" }]),
    archived_at: "t2",
  };
  const you = session("d", "direct", [{ member: "user" }, { member: "writer" }]);
  const youArchivedBot = session("d_archived", "direct", [{ member: "user" }, { member: "old_bot" }]);
  const pinnedArchived: SessionSummary = {
    ...session("g_pinned_archived", "group", [{ member: "user" }, { member: "a" }, { member: "b" }]),
    archived_at: "t2",
  };
  const bots = new Map<string, any>([
    ["writer", { id: "writer", name: "Writer", archived_at: null }],
    ["old_bot", { id: "old_bot", name: "Old", archived_at: "t2" }],
  ]);

  const res = groupSessions(
    [g, gArchived, you, youArchivedBot, pinnedArchived],
    ["g_pinned_archived"],
    undefined,
    bots,
  );
  expect(res.groups).toEqual([g]);
  expect(res.youBot).toEqual([you]);
  expect(res.pinned).toEqual([]);
});

test("youBotPeer is the other member of a you↔Bot direct, never the user", () => {
  const you = session("d", "direct", [{ member: "user" }, { member: "writer" }]);
  expect(youBotPeer(you)).toBe("writer");
  expect(youBotPeer(session("g", "group", [{ member: "user" }, { member: "a" }, { member: "b" }]))).toBeNull();
  expect(
    youBotPeer(session("bb", "direct", [{ member: "writer" }, { member: "researcher" }])),
  ).toBeNull();
});

test("youBotSession finds the you↔that Bot direct", () => {
  const writer = session("d", "direct", [{ member: "user" }, { member: "writer" }]);
  const other = session("d2", "direct", [{ member: "user" }, { member: "reviewer" }]);
  expect(youBotSession([writer, other], "writer")?.id).toBe("d");
  expect(youBotSession([writer], "reviewer")).toBeUndefined();
});
