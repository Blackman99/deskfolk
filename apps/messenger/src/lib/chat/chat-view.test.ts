import { describe, expect, test } from "bun:test";
import type { Message, Reaction, Turn } from "@real-bot/protocol";
import {
  buildMessageLookup,
  calculateBotDuration,
  canContinueInterrupt,
  formatDateDivider,
  formatDurationMs,
  formatFullTimestamp,
  formatLiveDuration,
  formatMessageTime,
  groupReactions,
  groupTranscript,
  isDifferentDay,
  isContinuableNote,
  isInterruptNote,
  isUnreachableNote,
  itemGroupInfo,
} from "./chat-view.ts";
import type { TranscriptItem } from "./transcript.ts";

describe("chat-view helpers", () => {
  test("formatDurationMs formats seconds and minutes correctly", () => {
    expect(formatDurationMs(500)).toBe("0.5s");
    expect(formatDurationMs(1850)).toBe("1.9s");
    expect(formatDurationMs(12000)).toBe("12.0s");
    expect(formatDurationMs(65000)).toBe("1m 5s");
    expect(formatDurationMs(-100)).toBe("0.0s");
  });

  test("calculateBotDuration computes duration from turn and trigger", () => {
    const trigger: Message = {
      id: "msg-user-1",
      session_id: "sess-1",
      turn_id: null,
      parent_id: null,
      kind: "user",
      author: "user",
      body: "Hello",
      source_turn_id: null,
      created_at: "2026-09-15T10:00:00.000Z",
      attachments: [],
      reactions: [],
    };

    const turn: Turn = {
      id: "turn-1",
      session_id: "sess-1",
      bot_id: "bot-1",
      status: "completed",
      trigger_message_id: "msg-user-1",
      last_activity_at: "2026-09-15T10:00:02.500Z",
      created_at: "2026-09-15T10:00:00.100Z",
      updated_at: "2026-09-15T10:00:02.500Z",
    };

    const botMsg: Message = {
      id: "msg-bot-1",
      session_id: "sess-1",
      turn_id: "turn-1",
      parent_id: null,
      kind: "bot",
      author: "bot-1",
      body: "Hi there!",
      source_turn_id: null,
      created_at: "2026-09-15T10:00:02.500Z",
      attachments: [],
      reactions: [],
    };

    const duration = calculateBotDuration(botMsg, [trigger, botMsg], [turn]);
    expect(duration).not.toBeNull();
    expect(duration?.ms).toBe(2500);
    expect(duration?.formatted).toBe("2.5s");

    // Non-bot message returns null
    expect(calculateBotDuration(trigger, [trigger], [turn])).toBeNull();
  });

  test("calculateBotDuration falls back to turn start when trigger message missing", () => {
    const turn: Turn = {
      id: "turn-2",
      session_id: "sess-1",
      bot_id: "bot-1",
      status: "completed",
      trigger_message_id: "non-existent",
      last_activity_at: "2026-09-15T10:00:03.200Z",
      created_at: "2026-09-15T10:00:01.000Z",
      updated_at: "2026-09-15T10:00:03.200Z",
    };

    const botMsg: Message = {
      id: "msg-bot-2",
      session_id: "sess-1",
      turn_id: "turn-2",
      parent_id: null,
      kind: "bot",
      author: "bot-1",
      body: "Response",
      source_turn_id: null,
      created_at: "2026-09-15T10:00:03.200Z",
      attachments: [],
      reactions: [],
    };

    const duration = calculateBotDuration(botMsg, [botMsg], [turn]);
    expect(duration).not.toBeNull();
    expect(duration?.ms).toBe(2200);
    expect(duration?.formatted).toBe("2.2s");
  });

  test("calculateBotDuration falls back to previous user message when turn missing", () => {
    const trigger: Message = {
      id: "msg-u-3",
      session_id: "sess-1",
      turn_id: null,
      parent_id: null,
      kind: "user",
      author: "user",
      body: "Question",
      source_turn_id: null,
      created_at: "2026-09-15T12:00:00.000Z",
      attachments: [],
      reactions: [],
    };

    const botMsg: Message = {
      id: "msg-b-3",
      session_id: "sess-1",
      turn_id: null,
      parent_id: null,
      kind: "bot",
      author: "bot-1",
      body: "Answer",
      source_turn_id: null,
      created_at: "2026-09-15T12:00:01.400Z",
      attachments: [],
      reactions: [],
    };

    const duration = calculateBotDuration(botMsg, [trigger, botMsg], []);
    expect(duration).not.toBeNull();
    expect(duration?.ms).toBe(1400);
    expect(duration?.formatted).toBe("1.4s");
  });

  test("formatLiveDuration calculates live elapsed time", () => {
    const now = 1757930403000;
    const start = new Date(now - 3400).toISOString();
    expect(formatLiveDuration(start, now)).toBe("3.4s");
  });

  test("formatMessageTime formats HH:mm", () => {
    const formatted = formatMessageTime("2026-09-15T14:05:00.000Z");
    expect(formatted).toMatch(/^\d{2}:\d{2}$/);
  });

  test("formatFullTimestamp formats full datetime", () => {
    const formatted = formatFullTimestamp("2026-09-15T14:05:09.000Z");
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("isDifferentDay detects calendar day transitions", () => {
    const day1 = "2026-09-15T10:00:00.000Z";
    const sameDay = "2026-09-15T18:00:00.000Z";
    const nextDay = "2026-09-16T02:00:00.000Z";

    expect(isDifferentDay(day1, sameDay)).toBe(false);
    expect(isDifferentDay(day1, nextDay)).toBe(true);
  });

  test("formatDateDivider formats today, yesterday, and localized date", () => {
    const ref = new Date("2026-09-15T12:00:00.000Z");
    const todayIso = "2026-09-15T08:00:00.000Z";
    const yesterdayIso = "2026-09-14T10:00:00.000Z";
    const pastIso = "2026-08-10T10:00:00.000Z";

    expect(formatDateDivider(todayIso, "zh", ref)).toBe("今天");
    expect(formatDateDivider(todayIso, "en", ref)).toBe("Today");

    expect(formatDateDivider(yesterdayIso, "zh", ref)).toBe("昨天");
    expect(formatDateDivider(yesterdayIso, "en", ref)).toBe("Yesterday");

    expect(formatDateDivider(pastIso, "zh", ref)).toBe("8月10日");
    expect(formatDateDivider(pastIso, "en", ref)).toBe("Aug 10");
  });

  test("groupReactions aggregates reaction counts and identifies user reaction", () => {
    const reactions: Reaction[] = [
      { message_id: "m1", actor: "user", emoji: "👍", created_at: "2026-09-15T10:00:00Z" },
      { message_id: "m1", actor: "bot-1", emoji: "👍", created_at: "2026-09-15T10:00:01Z" },
      { message_id: "m1", actor: "bot-2", emoji: "❤️", created_at: "2026-09-15T10:00:02Z" },
    ];

    const grouped = groupReactions(reactions, "user");
    expect(grouped.length).toBe(2);

    const thumbs = grouped.find((g) => g.emoji === "👍");
    expect(thumbs?.count).toBe(2);
    expect(thumbs?.userReacted).toBe(true);

    const heart = grouped.find((g) => g.emoji === "❤️");
    expect(heart?.count).toBe(1);
    expect(heart?.userReacted).toBe(false);

    expect(groupReactions([], "user")).toEqual([]);
    expect(groupReactions(null, "user")).toEqual([]);
  });

  describe("groupTranscript", () => {
    function fakeMsg(partial: Partial<Message> & Pick<Message, "id" | "kind" | "body" | "author" | "created_at">): TranscriptItem {
      return {
        type: "message",
        message: {
          session_id: "s1",
          turn_id: null,
          parent_id: null,
          source_turn_id: null,
          attachments: [],
          reactions: [],
          ...partial,
        },
      };
    }

    test("returns empty array for empty items", () => {
      expect(groupTranscript([])).toEqual([]);
    });

    test("merges consecutive bot messages from the same bot into one group with distinct items", () => {
      const items: TranscriptItem[] = [
        fakeMsg({ id: "m1", kind: "bot", author: "bot-1", body: "Hello part 1", created_at: "2026-09-15T13:54:00.000Z" }),
        fakeMsg({ id: "m2", kind: "bot", author: "bot-1", body: "Hello part 2", created_at: "2026-09-15T13:54:20.000Z" }),
      ];

      const groups = groupTranscript(items);
      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe("group-m1");
      expect(groups[0].kind).toBe("bot");
      expect(groups[0].author).toBe("bot-1");
      expect(groups[0].items).toHaveLength(2);
      expect(groups[0].items[0]).toBe(items[0]);
      expect(groups[0].items[1]).toBe(items[1]);
    });

    test("merges consecutive user messages from user into one group", () => {
      const items: TranscriptItem[] = [
        fakeMsg({ id: "u1", kind: "user", author: "user", body: "Prompt line 1", created_at: "2026-09-15T13:50:00.000Z" }),
        fakeMsg({ id: "u2", kind: "user", author: "user", body: "Prompt line 2", created_at: "2026-09-15T13:50:15.000Z" }),
      ];

      const groups = groupTranscript(items);
      expect(groups).toHaveLength(1);
      expect(groups[0].kind).toBe("user");
      expect(groups[0].author).toBe("user");
      expect(groups[0].items).toHaveLength(2);
    });

    test("keeps bot messages from different bots in separate groups", () => {
      const items: TranscriptItem[] = [
        fakeMsg({ id: "m1", kind: "bot", author: "bot-1", body: "From bot 1", created_at: "2026-09-15T13:54:00.000Z" }),
        fakeMsg({ id: "m2", kind: "bot", author: "bot-2", body: "From bot 2", created_at: "2026-09-15T13:54:10.000Z" }),
      ];

      const groups = groupTranscript(items);
      expect(groups).toHaveLength(2);
      expect(groups[0].author).toBe("bot-1");
      expect(groups[1].author).toBe("bot-2");
    });

    test("separates messages when alternating between user and bot", () => {
      const items: TranscriptItem[] = [
        fakeMsg({ id: "u1", kind: "user", author: "user", body: "Question", created_at: "2026-09-15T13:50:00.000Z" }),
        fakeMsg({ id: "m1", kind: "bot", author: "bot-1", body: "Answer", created_at: "2026-09-15T13:50:05.000Z" }),
        fakeMsg({ id: "u2", kind: "user", author: "user", body: "Follow up", created_at: "2026-09-15T13:50:20.000Z" }),
      ];

      const groups = groupTranscript(items);
      expect(groups).toHaveLength(3);
      expect(groups[0].kind).toBe("user");
      expect(groups[1].kind).toBe("bot");
      expect(groups[2].kind).toBe("user");
    });

    test("does not merge across different calendar days", () => {
      const items: TranscriptItem[] = [
        fakeMsg({ id: "m1", kind: "bot", author: "bot-1", body: "Day 1", created_at: "2026-09-14T23:59:00.000Z" }),
        fakeMsg({ id: "m2", kind: "bot", author: "bot-1", body: "Day 2", created_at: "2026-09-15T00:01:00.000Z" }),
      ];

      const groups = groupTranscript(items);
      expect(groups).toHaveLength(2);
      expect(groups[0].id).toBe("group-m1");
      expect(groups[1].id).toBe("group-m2");
    });

    test("does not merge when time gap exceeds maxTimeDiffMs", () => {
      const items: TranscriptItem[] = [
        fakeMsg({ id: "m1", kind: "bot", author: "bot-1", body: "Morning", created_at: "2026-09-15T09:00:00.000Z" }),
        fakeMsg({ id: "m2", kind: "bot", author: "bot-1", body: "Afternoon", created_at: "2026-09-15T14:00:00.000Z" }),
      ];

      const groups = groupTranscript(items, 10 * 60 * 1000);
      expect(groups).toHaveLength(2);
    });

    test("interrupt system notes keep the bot author so the row can show an avatar", () => {
      const items: TranscriptItem[] = [
        fakeMsg({
          id: "cut-1",
          kind: "system",
          author: "bot-1",
          body: "中断",
          created_at: "2026-09-15T13:54:01.000Z",
          turn_id: "turn-cut",
        }),
      ];
      const info = itemGroupInfo(items[0]);
      expect(info).toMatchObject({ kind: "system", author: "bot-1", mergeable: false });
      const groups = groupTranscript(items);
      expect(groups).toHaveLength(1);
      expect(groups[0].author).toBe("bot-1");
      expect(groups[0].kind).toBe("system");
    });

    test("keeps non-mergeable kinds (ask, approval, system) standalone", () => {
      const items: TranscriptItem[] = [
        fakeMsg({ id: "m1", kind: "bot", author: "bot-1", body: "I need to ask", created_at: "2026-09-15T13:54:00.000Z" }),
        fakeMsg({ id: "ask-1", kind: "ask", author: "bot-1", body: "Which file?", created_at: "2026-09-15T13:54:01.000Z" }),
        fakeMsg({ id: "m2", kind: "bot", author: "bot-1", body: "Continuing", created_at: "2026-09-15T13:54:05.000Z" }),
      ];

      const groups = groupTranscript(items);
      expect(groups).toHaveLength(3);
      expect(groups[0].kind).toBe("bot");
      expect(groups[1].kind).toBe("ask");
      expect(groups[2].kind).toBe("bot");
    });

    test("attaches a continue-from-interrupt thinking row to the 中断 note", () => {
      const items: TranscriptItem[] = [
        fakeMsg({
          id: "cut-1",
          kind: "system",
          author: "bot-1",
          body: "中断",
          created_at: "2026-09-15T13:54:01.000Z",
          turn_id: "turn-cut",
        }),
        {
          type: "replying",
          trigger_message_id: "cut-1",
          entries: [
            { bot_id: "bot-1", source: "turn", turn_id: "turn-next", created_at: "2026-09-15T13:54:02.000Z" },
          ],
        },
      ];
      const groups = groupTranscript(items);
      expect(groups).toHaveLength(1);
      expect(groups[0].kind).toBe("system");
      const msgItem = groups[0].items[0];
      expect(msgItem.type).toBe("message");
      if (msgItem.type === "message") {
        expect(msgItem.replying).toEqual([
          { bot_id: "bot-1", source: "turn", turn_id: "turn-next", created_at: "2026-09-15T13:54:02.000Z" },
        ]);
      }
    });

    test("attaches replying entries to their trigger message instead of creating a standalone block", () => {
      const items: TranscriptItem[] = [
        fakeMsg({ id: "u1", kind: "user", author: "user", body: "go", created_at: "2026-09-15T13:54:00.000Z" }),
        {
          type: "replying",
          trigger_message_id: "u1",
          entries: [
            { bot_id: "bot-1", source: "turn", turn_id: "turn-1", created_at: "2026-09-15T13:54:01.000Z" },
            { bot_id: "bot-2", source: "judgement", judgement_id: "pj1", created_at: "2026-09-15T13:54:01.000Z" },
          ],
        },
      ];
      const groups = groupTranscript(items);
      expect(groups).toHaveLength(1);
      expect(groups[0].kind).toBe("user");
      expect(groups[0].items).toHaveLength(1);
      const msgItem = groups[0].items[0];
      expect(msgItem.type).toBe("message");
      if (msgItem.type === "message") {
        expect(msgItem.replying).toEqual([
          { bot_id: "bot-1", source: "turn", turn_id: "turn-1", created_at: "2026-09-15T13:54:01.000Z" },
          { bot_id: "bot-2", source: "judgement", judgement_id: "pj1", created_at: "2026-09-15T13:54:01.000Z" },
        ]);
      }
    });

    test("keeps an orphan replying list standalone if trigger message is not found", () => {
      const items: TranscriptItem[] = [
        {
          type: "replying",
          trigger_message_id: "missing-trigger",
          entries: [
            { bot_id: "bot-1", source: "turn", turn_id: "turn-1", created_at: "2026-09-15T13:54:01.000Z" },
          ],
        },
      ];
      const groups = groupTranscript(items);
      expect(groups).toHaveLength(1);
      expect(groups[0].kind).toBe("replying");
      expect(groups[0].items).toHaveLength(1);
    });

    test("merges streaming turn into an ongoing bot group for the same bot", () => {
      const items: TranscriptItem[] = [
        fakeMsg({ id: "m1", kind: "bot", author: "bot-1", body: "Initial message", created_at: "2026-09-15T13:54:00.000Z" }),
        {
          type: "streaming",
          turn: {
            id: "turn-stream-1",
            session_id: "s1",
            bot_id: "bot-1",
            status: "running",
            trigger_message_id: "m0",
            last_activity_at: "2026-09-15T13:54:10.000Z",
            created_at: "2026-09-15T13:54:05.000Z",
            updated_at: "2026-09-15T13:54:10.000Z",
            partial_text: "Thinking...",
          },
        },
      ];

      const groups = groupTranscript(items);
      expect(groups).toHaveLength(1);
      expect(groups[0].items).toHaveLength(2);
      expect(groups[0].items[0].type).toBe("message");
      expect(groups[0].items[1].type).toBe("streaming");
    });
  });

  test("isInterruptNote matches only the locked 中断 body", () => {
    expect(isInterruptNote({ kind: "system", body: "中断" })).toBe(true);
    expect(isInterruptNote({ kind: "system", body: "这一轮没写完：端点拒绝了这次补全" })).toBe(false);
    expect(isInterruptNote({ kind: "system", body: "这一轮没写完：连不上端点" })).toBe(false);
    expect(isInterruptNote({ kind: "bot", body: "中断" })).toBe(false);
  });

  test("isUnreachableNote matches unreachable failure in zh and en", () => {
    expect(isUnreachableNote({ kind: "system", body: "这一轮没写完：连不上端点" })).toBe(true);
    expect(isUnreachableNote({ kind: "system", body: "This turn did not finish: Couldn't reach the endpoint" })).toBe(true);
    expect(isUnreachableNote({ kind: "system", body: "这一轮没写完：端点拒绝了这次补全" })).toBe(false);
    expect(isUnreachableNote({ kind: "system", body: "中断" })).toBe(false);
    expect(isUnreachableNote({ kind: "bot", body: "这一轮没写完：连不上端点" })).toBe(false);
  });

  test("isContinuableNote matches both interrupt and unreachable notes", () => {
    expect(isContinuableNote({ kind: "system", body: "中断" })).toBe(true);
    expect(isContinuableNote({ kind: "system", body: "这一轮没写完：连不上端点" })).toBe(true);
    expect(isContinuableNote({ kind: "system", body: "This turn did not finish: Couldn't reach the endpoint" })).toBe(true);
    expect(isContinuableNote({ kind: "system", body: "这一轮没写完：端点拒绝了这次补全" })).toBe(false);
  });

  test("canContinueInterrupt is on until a follow-up turn is recorded on the note", () => {
    const note = {
      id: "cut-1",
      kind: "system" as const,
      body: "中断",
      author: "bot-1",
      turn_id: "turn-cut",
      source_turn_id: null as string | null,
    };
    expect(canContinueInterrupt(note, [])).toBe(true);
    expect(canContinueInterrupt(note, [], { locked: true })).toBe(false);
    expect(canContinueInterrupt(note, [], { hasLiveTurnForBot: true })).toBe(false);
    expect(canContinueInterrupt({ ...note, source_turn_id: "turn-next" }, [])).toBe(false);
    expect(
      canContinueInterrupt(note, [
        {
          id: "turn-next",
          session_id: "s1",
          bot_id: "bot-1",
          status: "running",
          trigger_message_id: "cut-1",
          last_activity_at: "t2",
          created_at: "t2",
          updated_at: "t2",
        },
      ]),
    ).toBe(false);
  });

  test("canContinueInterrupt supports unreachable failures with completed turns", () => {
    const unreachable = {
      id: "fail-1",
      kind: "system" as const,
      body: "这一轮没写完：连不上端点",
      author: "bot-1",
      turn_id: "turn-fail",
      source_turn_id: null as string | null,
    };
    expect(canContinueInterrupt(unreachable, [])).toBe(true);
    expect(canContinueInterrupt(unreachable, [{
      id: "turn-fail",
      session_id: "s1",
      bot_id: "bot-1",
      status: "completed",
      trigger_message_id: "prev-1",
      last_activity_at: "t1",
      created_at: "t1",
      updated_at: "t1",
    }])).toBe(true);
    expect(canContinueInterrupt(unreachable, [], { locked: true })).toBe(false);
    expect(canContinueInterrupt(unreachable, [], { hasLiveTurnForBot: true })).toBe(false);
    expect(canContinueInterrupt({ ...unreachable, source_turn_id: "turn-resumed" }, [])).toBe(false);

    const nonContinuable = {
      id: "fail-2",
      kind: "system" as const,
      body: "这一轮没写完：端点拒绝了这次补全",
      author: "bot-1",
      turn_id: "turn-fail",
      source_turn_id: null as string | null,
    };
    expect(canContinueInterrupt(nonContinuable, [])).toBe(false);
  });
});

describe("buildMessageLookup", () => {
  const rows: Message[] = [
    { id: "b", session_id: "s1", kind: "bot", author: "bot-1", body: "", created_at: "t2" } as Message,
    { id: "a", session_id: "s1", kind: "user", author: "you", body: "", created_at: "t1" } as Message,
    { id: "c", session_id: "s2", kind: "user", author: "you", body: "", created_at: "t3" } as Message,
  ];

  test("indexes by id and by what came before it in the same session", () => {
    const lookup = buildMessageLookup(rows);
    expect(lookup.byId.get("a")?.created_at).toBe("t1");
    expect(lookup.previousInSession.get("b")?.id).toBe("a");
    // First in its session, and first across a different session: nothing before either.
    expect(lookup.previousInSession.get("a")).toBeUndefined();
    expect(lookup.previousInSession.get("c")).toBeUndefined();
  });

  test("the same message list is indexed once", () => {
    expect(buildMessageLookup(rows)).toBe(buildMessageLookup(rows));
    expect(buildMessageLookup([...rows])).not.toBe(buildMessageLookup(rows));
  });

  test("a bot reply with no turn is timed from the user message before it", () => {
    const asked = { ...rows[1]!, created_at: "2026-01-01T00:00:00.000Z" };
    const answered = { ...rows[0]!, created_at: "2026-01-01T00:00:03.000Z" };
    expect(calculateBotDuration(answered, [asked, answered], [])?.ms).toBe(3000);
  });
});
