import { expect, test } from "bun:test";
import type { Message, Turn } from "@real-bot/protocol";
import {
  composeTranscript,
  isPendingAsk,
  latestPreview,
  stopTarget,
} from "./transcript.ts";

function msg(partial: Partial<Message> & Pick<Message, "id" | "kind" | "body">): Message {
  return {
    session_id: "s1",
    turn_id: null,
    parent_id: null,
    author: "user",
    source_turn_id: null,
    created_at: "t",
    attachments: [],
    reactions: [],
    ...partial,
  };
}

function turn(partial: Partial<Turn> & Pick<Turn, "id" | "status">): Turn {
  return {
    session_id: "s1",
    bot_id: "writer",
    trigger_message_id: "m1",
    last_activity_at: "t",
    created_at: "t",
    updated_at: "t",
    partial_text: null,
    ...partial,
  };
}

test("newest-first GET pages still render oldest first", () => {
  const items = composeTranscript(
    [
      msg({ id: "m2", kind: "bot", author: "writer", body: "later", created_at: "t2" }),
      msg({ id: "m1", kind: "user", body: "first", created_at: "t1" }),
    ],
    [],
    "s1",
  );
  expect(items.map((item) => (item.type === "message" ? item.message.id : item.turn.id))).toEqual([
    "m1",
    "m2",
  ]);
});

test("a running turn streams after its trigger and is not a message", () => {
  const items = composeTranscript(
    [msg({ id: "m1", kind: "user", body: "please write", created_at: "t1" })],
    [
      turn({
        id: "turn-1",
        status: "running",
        trigger_message_id: "m1",
        partial_text: "hel",
      }),
    ],
    "s1",
  );
  expect(items).toHaveLength(2);
  expect(items[0]).toEqual({
    type: "message",
    message: expect.objectContaining({ id: "m1" }),
  });
  expect(items[1]).toEqual({
    type: "streaming",
    turn: expect.objectContaining({ id: "turn-1", partial_text: "hel" }),
  });
});

test("a running turn with empty partial_text is a compact replying row, not a bubble", () => {
  const items = composeTranscript(
    [msg({ id: "m1", kind: "user", body: "go", created_at: "t1" })],
    [turn({ id: "turn-1", status: "running", trigger_message_id: "m1", partial_text: "" })],
    "s1",
  );
  expect(items).toHaveLength(2);
  expect(items[1]).toEqual({
    type: "replying",
    trigger_message_id: "m1",
    entries: [
      expect.objectContaining({
        bot_id: "writer",
        source: "turn",
        turn_id: "turn-1",
      }),
    ],
  });
});

test("several bots thinking on the same trigger collapse into one compact list", () => {
  const items = composeTranscript(
    [msg({ id: "m1", kind: "user", body: "please begin", created_at: "t1" })],
    [
      turn({
        id: "turn-a",
        bot_id: "eunice",
        status: "running",
        trigger_message_id: "m1",
        created_at: "t2",
        partial_text: "",
      }),
      turn({
        id: "turn-b",
        bot_id: "carrie",
        status: "running",
        trigger_message_id: "m1",
        created_at: "t3",
        partial_text: null,
      }),
    ],
    "s1",
  );
  expect(items.map((item) => item.type)).toEqual(["message", "replying"]);
  expect(items[1]).toMatchObject({
    type: "replying",
    trigger_message_id: "m1",
    entries: [{ bot_id: "eunice" }, { bot_id: "carrie" }],
  });
});

test("a pending judgement appears as compact replying as soon as thinking starts", () => {
  const items = composeTranscript(
    [msg({ id: "m1", kind: "user", body: "please begin", created_at: "t1" })],
    [],
    "s1",
    [
      {
        id: "pj1",
        session_id: "s1",
        message_id: "m1",
        bot_id: "researcher",
        created_at: "t2",
      },
    ],
  );
  expect(items[1]).toEqual({
    type: "replying",
    trigger_message_id: "m1",
    entries: [
      expect.objectContaining({
        bot_id: "researcher",
        source: "judgement",
        judgement_id: "pj1",
      }),
    ],
  });
});

test("a join turn replaces the pending judgement for the same bot on that trigger", () => {
  const items = composeTranscript(
    [msg({ id: "m1", kind: "user", body: "please begin", created_at: "t1" })],
    [
      turn({
        id: "turn-1",
        bot_id: "researcher",
        status: "running",
        trigger_message_id: "m1",
        partial_text: "",
      }),
    ],
    "s1",
    [
      {
        id: "pj1",
        session_id: "s1",
        message_id: "m1",
        bot_id: "researcher",
        created_at: "t2",
      },
    ],
  );
  expect(items[1]?.type).toBe("replying");
  if (items[1]?.type !== "replying") throw new Error("expected compact list");
  expect(items[1].entries).toHaveLength(1);
  expect(items[1].entries[0]).toMatchObject({ bot_id: "researcher", source: "turn" });
});

test("a bot with streamed tokens leaves the compact list and occupies a streaming bubble", () => {
  const items = composeTranscript(
    [msg({ id: "m1", kind: "user", body: "please begin", created_at: "t1" })],
    [
      turn({
        id: "turn-a",
        bot_id: "eunice",
        status: "running",
        trigger_message_id: "m1",
        created_at: "t2",
        partial_text: "hel",
      }),
      turn({
        id: "turn-b",
        bot_id: "carrie",
        status: "running",
        trigger_message_id: "m1",
        created_at: "t3",
        partial_text: "",
      }),
    ],
    "s1",
  );
  expect(items.map((item) => item.type)).toEqual(["message", "streaming", "replying"]);
  expect(items[1]).toMatchObject({ type: "streaming", turn: { id: "turn-a" } });
  expect(items[2]).toMatchObject({
    type: "replying",
    entries: [{ bot_id: "carrie" }],
  });
});

test("completed turns do not leave a streaming bubble once the bot message exists", () => {
  const items = composeTranscript(
    [
      msg({ id: "m1", kind: "user", body: "please write", created_at: "t1" }),
      msg({
        id: "m2",
        kind: "bot",
        author: "writer",
        body: "hello from writer",
        turn_id: "turn-1",
        created_at: "t2",
      }),
    ],
    [turn({ id: "turn-1", status: "completed", partial_text: null })],
    "s1",
  );
  expect(items.map((item) => item.type)).toEqual(["message", "message"]);
  expect(items.some((item) => item.type === "streaming")).toBe(false);
});

test("failure is the system message, not a bot bubble and not leftover partial_text", () => {
  const items = composeTranscript(
    [
      msg({ id: "m1", kind: "user", body: "go", created_at: "t1" }),
      msg({
        id: "m2",
        kind: "system",
        author: "writer",
        body: "这一轮没写完：端点拒绝了这次补全",
        turn_id: "turn-1",
        created_at: "t2",
      }),
    ],
    [turn({ id: "turn-1", status: "completed", partial_text: null })],
    "s1",
  );
  expect(items).toHaveLength(2);
  expect(items[1]).toMatchObject({ type: "message", message: { kind: "system" } });
});

test("a pending approval stays a wide card message in the stream, not a streaming bubble", () => {
  const card = msg({
    id: "appr-1",
    kind: "approval",
    author: "writer",
    body: "outside-write /tmp/secret.md",
    turn_id: "turn-1",
    created_at: "t2",
  });
  const items = composeTranscript(
    [msg({ id: "m1", kind: "user", body: "write outside", created_at: "t1" }), card],
    [turn({ id: "turn-1", status: "waiting_approval", partial_text: null })],
    "s1",
  );
  expect(items).toHaveLength(2);
  expect(items[1]).toMatchObject({ type: "message", message: { kind: "approval", id: "appr-1" } });
  expect(items.some((item) => item.type === "streaming")).toBe(false);
});

test("a pending ask stays a message in the stream", () => {
  const ask = msg({
    id: "ask-1",
    kind: "ask",
    author: "writer",
    body: "which tone?",
    turn_id: "turn-1",
    created_at: "t2",
  });
  const waiting = turn({ id: "turn-1", status: "waiting_ask", partial_text: null });
  const items = composeTranscript(
    [msg({ id: "m1", kind: "user", body: "ask me", created_at: "t1" }), ask],
    [waiting],
    "s1",
  );
  expect(items[1]).toMatchObject({ type: "message", message: { kind: "ask", id: "ask-1" } });
  expect(isPendingAsk(ask, [waiting])).toBe(true);
  expect(isPendingAsk(ask, [turn({ id: "turn-1", status: "running" })])).toBe(false);
});

test("leftover profile_change rows stay out of the main stream and preview", () => {
  const items = composeTranscript(
    [
      msg({ id: "m1", kind: "user", body: "please update", created_at: "t1" }),
      msg({
        id: "p1",
        kind: "profile_change",
        author: "writer",
        body: "Writer\n\nwrite\n\nstay",
        created_at: "t2",
      }),
    ],
    [],
    "s1",
  );
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ type: "message", message: { id: "m1" } });
  expect(
    latestPreview(
      [
        msg({ id: "m1", kind: "user", body: "please update", created_at: "t1" }),
        msg({
          id: "p1",
          kind: "profile_change",
          author: "writer",
          body: "Writer\n\nwrite\n\nstay",
          created_at: "t2",
        }),
      ],
      "s1",
    ),
  ).toBe("please update");
});

test("thread replies stay out of the main stream", () => {
  const items = composeTranscript(
    [
      msg({ id: "m1", kind: "user", body: "main", created_at: "t1" }),
      msg({ id: "m2", kind: "user", body: "reply", parent_id: "m1", created_at: "t2" }),
    ],
    [],
    "s1",
  );
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ type: "message", message: { id: "m1" } });
});

test("session preview is the newest main-line body, even if the page arrived newest-first", () => {
  expect(
    latestPreview(
      [
        msg({ id: "m2", kind: "bot", author: "writer", body: "later", created_at: "t2" }),
        msg({ id: "m1", kind: "user", body: "first", created_at: "t1" }),
      ],
      "s1",
    ),
  ).toBe("later");
});

test("session preview falls back to session last_message when messages array is empty", () => {
  const lastMsg = msg({ id: "m1", kind: "user", body: "hello from summary", created_at: "t1" });
  const sessionSummary = {
    id: "s1",
    kind: "direct" as const,
    name: null,
    created_at: "t1",
    updated_at: "t1",
    participants: [],
    last_message: lastMsg,
  };
  expect(latestPreview([], "s1", sessionSummary)).toBe("hello from summary");
});

test("session preview prefers running partial_text when present", () => {
  const running = turn({
    id: "t1",
    session_id: "s1",
    status: "running",
    partial_text: "streaming chunk",
  });
  expect(latestPreview([], "s1", null, [running])).toBe("streaming chunk");
});

test("Stop with the window open hits the focused live turn, not a sibling", () => {
  const running = turn({
    id: "here",
    status: "running",
    last_activity_at: "t1",
  });
  const other = turn({
    id: "other",
    session_id: "s2",
    status: "running",
    last_activity_at: "t9",
  });
  expect(stopTarget([running, other], "s1", "here")).toBe("here");
  expect(stopTarget([running, other], "s1", "here", "direct")).toBe("here");
  expect(stopTarget([running, other], "s1", null)).toBe("here");
  expect(stopTarget([running], "s1", "gone")).toBe("here");
  expect(stopTarget([turn({ id: "dead", status: "completed" })], "s1", "dead")).toBeNull();
  expect(stopTarget([other], "s1", "other")).toBeNull();
  expect(stopTarget([running], "s1", "here", "group")).toBeNull();
});
