import { expect, test } from "bun:test";
import type { Message, SessionSummary } from "@real-bot/protocol";
import { collectUntilMessage, searchHitView, searchJump } from "./search-jump.ts";

const sessions: SessionSummary[] = [
  {
    id: "d-writer",
    kind: "direct",
    name: null,
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: "writer", joined_at: "t", left_at: null },
    ],
  },
];

const kindLabels = {
  bot: "Bot",
  session: "会话",
  message: "消息",
  routine: "日程",
  file: "文件",
};

test("a session hit opens that session", () => {
  expect(searchJump({ kind: "session", id: "g-brief" }, sessions)).toEqual({
    sessionId: "g-brief",
  });
});

test("a bot hit opens you↔that Bot", () => {
  expect(searchJump({ kind: "bot", id: "writer" }, sessions)).toEqual({
    sessionId: "d-writer",
  });
  expect(searchJump({ kind: "bot", id: "writer", session_id: "d-writer" }, sessions)).toEqual({
    sessionId: "d-writer",
  });
  expect(searchJump({ kind: "bot", id: "missing" }, sessions)).toBeNull();
});

test("a message hit opens that session and lands on the hit", () => {
  expect(
    searchJump({ kind: "message", id: "m1", session_id: "d-writer" }, sessions),
  ).toEqual({
    sessionId: "d-writer",
    messageId: "m1",
  });
});

test("a thread reply lands on the parent in the main transcript", () => {
  expect(
    searchJump(
      { kind: "message", id: "r1", session_id: "d-writer", parent_id: "m1" },
      sessions,
    ),
  ).toEqual({
    sessionId: "d-writer",
    messageId: "m1",
  });
});

test("message hits without a session, file hits, and routine hits do not pick a session", () => {
  expect(searchJump({ kind: "message", id: "m1" }, sessions)).toBeNull();
  expect(searchJump({ kind: "file", path: "brief.md" }, sessions)).toBeNull();
  expect(searchJump({ kind: "routine", id: "r1" }, sessions)).toBeNull();
});

test("search results show the session a message belongs to", () => {
  expect(
    searchHitView(
      {
        kind: "message",
        id: "m1",
        session_id: "d-writer",
        session_title: "Writer",
        snippet: "unique phrase in chat",
      },
      kindLabels,
    ),
  ).toEqual({
    kindLabel: "消息",
    sessionTitle: "Writer",
    snippet: "unique phrase in chat",
  });
});

test("session and bot hits still show a session title; files do not", () => {
  expect(
    searchHitView({ kind: "session", id: "g-brief", snippet: "Brief", session_title: "Brief" }, kindLabels)
      .sessionTitle,
  ).toBe("Brief");
  expect(
    searchHitView({ kind: "bot", id: "writer", snippet: "Writer", session_title: "Writer" }, kindLabels)
      .sessionTitle,
  ).toBe("Writer");
  expect(searchHitView({ kind: "file", path: "brief.md", snippet: "brief.md" }, kindLabels).sessionTitle).toBeNull();
});

function msg(id: string): Message {
  return {
    id,
    session_id: "s",
    turn_id: null,
    parent_id: null,
    kind: "user",
    author: "user",
    body: id,
    source_turn_id: null,
    created_at: "t",
    attachments: [],
    reactions: [],
  };
}

test("collectUntilMessage does not page when the hit is already loaded", async () => {
  let calls = 0;
  const result = await collectUntilMessage(
    [msg("m1")],
    "m1",
    async () => {
      calls += 1;
      return { items: [], next: null };
    },
    "c1",
  );
  expect(calls).toBe(0);
  expect(result.found).toBe(true);
  expect(result.next).toBe("c1");
});

test("collectUntilMessage walks older pages until the hit appears", async () => {
  const pages = new Map([
    ["c1", { items: [msg("m2")], next: "c2" }],
    ["c2", { items: [msg("m-hit")], next: "c3" }],
  ]);
  const result = await collectUntilMessage(
    [msg("m1")],
    "m-hit",
    async (cursor) => pages.get(cursor) ?? { items: [], next: null },
    "c1",
  );
  expect(result.found).toBe(true);
  expect(result.messages.map((row) => row.id)).toEqual(["m1", "m2", "m-hit"]);
  expect(result.next).toBe("c3");
});
