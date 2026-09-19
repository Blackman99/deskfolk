import { expect, test } from "bun:test";
import type { SessionSummary } from "@real-bot/protocol";
import { aBotDirect, aGroup, aMessage } from "../test-fixtures.ts";
import {
  BOT_DM_VISIBLE,
  botDmRecency,
  recentBotDms,
  resolveBotDmOrigin,
} from "./bot-dm-source.ts";

function byId(...sessions: SessionSummary[]): Map<string, SessionSummary> {
  return new Map(sessions.map((s) => [s.id, s]));
}

test("recency comes from the last message, falling back to when it was opened", () => {
  const spoken = aBotDirect({
    created_at: "2026-09-19T01:00:00.000Z",
    last_message: aMessage({ created_at: "2026-09-19T05:00:00.000Z" }),
  });
  expect(botDmRecency(spoken)).toBe("2026-09-19T05:00:00.000Z");

  const silent = aBotDirect({ created_at: "2026-09-19T01:00:00.000Z", last_message: null });
  expect(botDmRecency(silent)).toBe("2026-09-19T01:00:00.000Z");
});

/**
 * updated_at is also written by marking a session read, so sorting on it would float a direct
 * to the top of "recently active" just because you looked at it.
 */
test("reading a direct does not make it look recently active", () => {
  const read = aBotDirect({
    created_at: "2026-09-19T01:00:00.000Z",
    updated_at: "2026-09-19T09:00:00.000Z",
    last_message: aMessage({ created_at: "2026-09-19T02:00:00.000Z" }),
  });
  expect(botDmRecency(read)).toBe("2026-09-19T02:00:00.000Z");
});

test("the list is newest first and capped", () => {
  const sessions = ["01", "02", "03", "04", "05", "06", "07"].map((n) =>
    aBotDirect({
      id: `d-${n}`,
      last_message: aMessage({ created_at: `2026-09-19T${n}:00:00.000Z` }),
    }),
  );
  const shown = recentBotDms(sessions);
  expect(shown).toHaveLength(BOT_DM_VISIBLE);
  expect(shown[0].id).toBe("d-07");
  expect(shown.at(-1)?.id).toBe("d-03");
});

/** The one you are reading must not vanish from the sidebar while you read it. */
test("the open direct is kept even when it falls past the cap", () => {
  const sessions = ["01", "02", "03", "04", "05", "06", "07"].map((n) =>
    aBotDirect({
      id: `d-${n}`,
      last_message: aMessage({ created_at: `2026-09-19T${n}:00:00.000Z` }),
    }),
  );
  const shown = recentBotDms(sessions, { keepId: "d-01" });
  expect(shown).toHaveLength(BOT_DM_VISIBLE + 1);
  expect(shown.some((s) => s.id === "d-01")).toBe(true);
});

test("expanded shows everything", () => {
  const sessions = ["01", "02", "03", "04", "05", "06", "07"].map((n) => aBotDirect({ id: `d-${n}` }));
  expect(recentBotDms(sessions, { expanded: true })).toHaveLength(7);
});

test("a direct opened before sources were recorded has none", () => {
  const legacy = aBotDirect({ origin_session_id: null, origin_message_id: null });
  expect(resolveBotDmOrigin(legacy, byId(legacy))).toEqual({ kind: "none" });
});

test("a source that is not in the snapshot reads as gone", () => {
  const orphan = aBotDirect({ origin_session_id: "deleted" });
  expect(resolveBotDmOrigin(orphan, byId(orphan))).toEqual({ kind: "missing" });
});

test("a direct opened from a group points straight at it", () => {
  const group = aGroup({ id: "sess-1" });
  const direct = aBotDirect();
  const origin = resolveBotDmOrigin(direct, byId(group, direct));
  expect(origin.kind).toBe("session");
  if (origin.kind !== "session") return;
  expect(origin.session.id).toBe("sess-1");
  expect(origin.messageId).toBe("msg-1");
  expect(origin.depth).toBe(0);
  expect(origin.root).toBeNull();
});

/** The link points at the immediate source, and names the root separately. */
test("a chain through another direct reports the root without pointing at it", () => {
  const group = aGroup({ id: "sess-1" });
  const first = aBotDirect({ id: "d-1", origin_session_id: "sess-1", origin_message_id: "msg-1" });
  const second = aBotDirect({ id: "d-2", origin_session_id: "d-1", origin_message_id: "msg-2" });
  const origin = resolveBotDmOrigin(second, byId(group, first, second));
  expect(origin.kind).toBe("session");
  if (origin.kind !== "session") return;
  expect(origin.session.id).toBe("d-1");
  expect(origin.depth).toBe(1);
  expect(origin.root?.id).toBe("sess-1");
});

test("a chain that loops back on itself still terminates", () => {
  const a = aBotDirect({ id: "a", origin_session_id: "b", origin_message_id: "m" });
  const b = aBotDirect({ id: "b", origin_session_id: "a", origin_message_id: "m" });
  const origin = resolveBotDmOrigin(a, byId(a, b));
  expect(origin.kind).toBe("session");
  if (origin.kind !== "session") return;
  expect(origin.session.id).toBe("b");
  expect(origin.root).toBeNull();
});
