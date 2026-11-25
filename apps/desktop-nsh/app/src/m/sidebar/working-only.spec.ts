import { describe, expect, test } from "bun:test";
import { USER_MEMBER, type Approval, type PendingJudgement, type SessionSummary, type Turn } from "@real-bot/protocol";
import { workingOrUnreadIds } from "./working-only.ts";

function session(id: string, kind: SessionSummary["kind"], members: string[]): SessionSummary {
  return {
    id,
    kind,
    name: id,
    created_at: "2026-11-25T00:00:00.000Z",
    updated_at: "2026-11-25T00:00:00.000Z",
    participants: members.map((member) => ({ member, joined_at: "2026-11-25T00:00:00.000Z", left_at: null })),
  };
}

function turn(id: string, sessionId: string, botId: string, status: Turn["status"]): Turn {
  return {
    id,
    session_id: sessionId,
    bot_id: botId,
    status,
    trigger_message_id: "m1",
    last_activity_at: "2026-11-25T00:00:00.000Z",
    created_at: "2026-11-25T00:00:00.000Z",
    updated_at: "2026-11-25T00:00:00.000Z",
  };
}

describe("workingOrUnreadIds", () => {
  test("keeps a Bot's you↔Bot direct when that Bot is working in a hidden Bot↔Bot direct", () => {
    const reviewerDirect = session("s-reviewer", "direct", [USER_MEMBER, "reviewer"]);
    const directorDirect = session("s-director", "direct", [USER_MEMBER, "director"]);
    const botBot = session("s-bot-bot", "direct", ["reviewer", "director"]);
    const sessions = [reviewerDirect, directorDirect, botBot];

    const ids = workingOrUnreadIds(sessions, [turn("t1", "s-bot-bot", "reviewer", "running")], []);
    expect(ids.has("s-reviewer")).toBe(true);
    expect(ids.has("s-director")).toBe(false);
  });

  test("keeps a Bot's you↔Bot direct when a Bot↔Bot direct has a pending judgement or pending approval", () => {
    const reviewerDirect = session("s-reviewer", "direct", [USER_MEMBER, "reviewer"]);
    const directorDirect = session("s-director", "direct", [USER_MEMBER, "director"]);
    const botBot = session("s-bot-bot", "direct", ["reviewer", "director"]);
    const sessions = [reviewerDirect, directorDirect, botBot];

    const judgement = { id: "pj1", session_id: "s-bot-bot", message_id: "m1", bot_id: "director", created_at: "t" } as PendingJudgement;
    expect(workingOrUnreadIds(sessions, [], [], [judgement]).has("s-director")).toBe(true);

    const approval = { id: "a1", turn_id: "t-done", status: "pending" } as Approval;
    expect(workingOrUnreadIds(sessions, [turn("t-done", "s-bot-bot", "reviewer", "completed")], [approval]).has("s-reviewer")).toBe(true);
  });

  test("does not pull a Bot's quiet you↔Bot direct into the filter when it works in a visible group", () => {
    const reviewerDirect = session("s-reviewer", "direct", [USER_MEMBER, "reviewer"]);
    const group = session("s-group", "group", [USER_MEMBER, "reviewer", "director"]);
    const ids = workingOrUnreadIds([reviewerDirect, group], [turn("t1", "s-group", "reviewer", "running")], []);
    expect(ids.has("s-group")).toBe(true);
    expect(ids.has("s-reviewer")).toBe(false);
  });
});
