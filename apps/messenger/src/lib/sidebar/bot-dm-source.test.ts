import { expect, test } from "bun:test";
import type { SessionSummary } from "@real-bot/protocol";
import { aBotDirect, aGroup } from "../test-fixtures.ts";
import { resolveBotDmOrigin } from "./bot-dm-source.ts";

function byId(...sessions: SessionSummary[]): Map<string, SessionSummary> {
  return new Map(sessions.map((s) => [s.id, s]));
}

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
