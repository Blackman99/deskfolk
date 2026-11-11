/** The rows' lines from one index say what `latestPreview` says row by row. */
import { expect, test } from "nsh/test";
import type { Message, SessionSummary, Turn } from "@real-bot/protocol";
import { latestPreview } from "../../m/chat/transcript.ts";
import { sidebarStatus } from "../../m/sidebar/session-status.ts";
import { previewIndex, previewOf, statusMessages } from "./sidebar-previews";

const msg = (id: string, session: string, at: string, body: string, kind = "bot"): Message => ({ id, session_id: session, created_at: at, body, kind }) as unknown as Message;
const turn = (id: string, session: string, status: string, partial: string): Turn => ({ id, session_id: session, status, partial_text: partial }) as unknown as Turn;
const session = (id: string, last?: Message): SessionSummary => ({ id, last_message: last ?? null }) as unknown as SessionSummary;

test("the index says what latestPreview says for every conversation", () => {
  const messages = [
    msg("m1", "a", "2026-11-01T00:00:01Z", "first in a"),
    msg("m3", "a", "2026-11-01T00:00:03Z", "newest in a"),
    msg("m2", "a", "2026-11-01T00:00:02Z", "middle in a"),
    msg("m5", "b", "2026-11-01T00:00:05Z", "tie low id"),
    msg("m6", "b", "2026-11-01T00:00:05Z", "tie high id"),
    msg("m7", "c", "2026-11-01T00:00:07Z", "a hidden one", "system_event"),
    msg("m8", "d", "2026-11-01T00:00:08Z", "x".repeat(500)),
  ];
  const turns = [turn("t1", "a", "done", "old"), turn("t2", "d", "running", ""), turn("t3", "e", "running", "streaming now"), turn("t4", "e", "running", "second")];
  const sessions = [session("a"), session("b"), session("c", msg("lm", "c", "2026-11-01T00:00:09Z", "from the summary")), session("d"), session("e"), session("f")];
  const index = previewIndex(messages, turns);
  for (const s of sessions) {
    for (const limit of [80, 400]) expect(previewOf(index, s, limit)).toBe(latestPreview(messages, s.id, s, turns, limit));
  }
});

test("a row's status from the index is the status from every message", () => {
  const labels = new Proxy({}, { get: (_t, key) => String(key) }) as never;
  const messages = [
    msg("m1", "a", "2026-11-01T00:00:01Z", "fine"),
    msg("m2", "a", "2026-11-01T00:00:02Z", "Turn interrupted", "system"),
    msg("m3", "a", "2026-11-01T00:00:03Z", "renamed", "profile_change"),
    msg("m4", "b", "2026-11-01T00:00:04Z", "失败了", "system"),
    msg("m5", "b", "2026-11-01T00:00:05Z", "later reply"),
  ];
  const sessions = [session("a"), session("b"), session("c", msg("lm", "c", "2026-11-01T00:00:09Z", "x", "system"))];
  const index = previewIndex(messages, []);
  for (const s of sessions) expect(sidebarStatus(s, [], [], labels, [], statusMessages(index, s))).toEqual(sidebarStatus(s, [], [], labels, [], messages));
});
