import { expect, test } from "bun:test";
import type { Approval, SessionSummary, Turn } from "@real-bot/protocol";
import {
  botWorkStatus,
  sessionStatus,
  sidebarStatus,
  type StatusLabels,
} from "./session-status.ts";

const labels: StatusLabels = {
  running: "思考中",
  replying: "回复中",
  waitingApproval: "待审批",
  waitingAsk: "待回复",
  idle: "空闲",
};

function makeTurn(
  id: string,
  sessionId: string,
  status: Turn["status"],
  extra: Partial<Turn> = {},
): Turn {
  return {
    id,
    session_id: sessionId,
    bot_id: "b1",
    status,
    trigger_message_id: "m1",
    last_activity_at: "2026-04-16T10:00:00.000Z",
    created_at: "2026-04-16T10:00:00.000Z",
    updated_at: "2026-04-16T10:00:00.000Z",
    ...extra,
  };
}

function makeApproval(id: string, turnId: string, status: Approval["status"]): Approval {
  return {
    id,
    turn_id: turnId,
    message_id: null,
    status,
    kind_key: "outside-write",
    summary: "outside-write /tmp/x",
    target: "/tmp/x",
    created_at: "2026-04-16T10:00:00.000Z",
    resolved_at: null,
    requires_api_key: false,
  };
}

test("idle when no turns exist or turns are completed", () => {
  const turns = [makeTurn("t1", "s1", "completed"), makeTurn("t2", "s2", "running")];
  const approvals: Approval[] = [];
  const status = sessionStatus("s1", turns, approvals, labels);
  expect(status.kind).toBe("idle");
  expect(status.label).toBe("空闲");
  expect(status.isBusy).toBe(false);
});

test("running when live turn has running status", () => {
  const turns = [makeTurn("t1", "s1", "running")];
  const approvals: Approval[] = [];
  const status = sessionStatus("s1", turns, approvals, labels);
  expect(status.kind).toBe("running");
  expect(status.label).toBe("思考中");
  expect(status.isBusy).toBe(true);
});

test("waiting_ask when live turn has waiting_ask status", () => {
  const turns = [makeTurn("t1", "s1", "waiting_ask")];
  const approvals: Approval[] = [];
  const status = sessionStatus("s1", turns, approvals, labels);
  expect(status.kind).toBe("waiting_ask");
  expect(status.label).toBe("待回复");
  expect(status.isBusy).toBe(false);
});

test("waiting_approval when live turn has waiting_approval status", () => {
  const turns = [makeTurn("t1", "s1", "waiting_approval")];
  const approvals: Approval[] = [makeApproval("a1", "t1", "pending")];
  const status = sessionStatus("s1", turns, approvals, labels);
  expect(status.kind).toBe("waiting_approval");
  expect(status.label).toBe("待审批");
  expect(status.isBusy).toBe(false);
  expect(status.count).toBe(1);
});

test("waiting_approval overrides running status", () => {
  const turns = [
    makeTurn("t1", "s1", "running"),
    makeTurn("t2", "s1", "waiting_approval"),
  ];
  const approvals: Approval[] = [makeApproval("a1", "t2", "pending")];
  const status = sessionStatus("s1", turns, approvals, labels);
  expect(status.kind).toBe("waiting_approval");
  expect(status.count).toBe(1);
});

test("waiting_ask overrides running status", () => {
  const turns = [
    makeTurn("t1", "s1", "running"),
    makeTurn("t2", "s1", "waiting_ask"),
  ];
  const approvals: Approval[] = [];
  const status = sessionStatus("s1", turns, approvals, labels);
  expect(status.kind).toBe("waiting_ask");
});

test("a pending judgement is busy even before a turn exists", () => {
  const status = sessionStatus("s1", [], [], labels, [
    {
      id: "pj1",
      session_id: "s1",
      message_id: "m1",
      bot_id: "writer",
      created_at: "t",
    },
  ]);
  expect(status.kind).toBe("running");
  expect(status.label).toBe("思考中");
  expect(status.isBusy).toBe(true);
});

test("running with streamed text is replying, not thinking", () => {
  const turns = [makeTurn("t1", "s1", "running", { partial_text: "hello" })];
  const status = sessionStatus("s1", turns, [], labels);
  expect(status.kind).toBe("replying");
  expect(status.label).toBe("回复中");
  expect(status.isBusy).toBe(true);
});

test("bot work status is global across sessions", () => {
  const turns = [makeTurn("t1", "s-group", "running", { bot_id: "writer" })];
  const status = botWorkStatus("writer", turns, [], labels);
  expect(status.kind).toBe("running");
  expect(status.label).toBe("思考中");
  expect(botWorkStatus("reviewer", turns, [], labels).kind).toBe("idle");
});

test("bot work status prefers replying over thinking", () => {
  const turns = [
    makeTurn("t1", "s-a", "running", { bot_id: "writer" }),
    makeTurn("t2", "s-b", "running", { bot_id: "writer", partial_text: "draft" }),
  ];
  const status = botWorkStatus("writer", turns, [], labels);
  expect(status.kind).toBe("replying");
});

test("sidebar you↔bot row uses the current session's status, not the bot's global work", () => {
  const youBot: SessionSummary = {
    id: "s-you",
    kind: "direct",
    name: null,
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: "writer", joined_at: "t", left_at: null },
    ],
  };
  const group: SessionSummary = {
    id: "s-group",
    kind: "group",
    name: "Brief",
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: "writer", joined_at: "t", left_at: null },
      { member: "reviewer", joined_at: "t", left_at: null },
    ],
  };
  const turns = [makeTurn("t1", "s-group", "running", { bot_id: "writer", partial_text: "ok" })];
  expect(sidebarStatus(youBot, turns, [], labels).kind).toBe("idle");
  expect(sidebarStatus(youBot, turns, [], labels).label).toBe("空闲");
  expect(sessionStatus("s-you", turns, [], labels).kind).toBe("idle");
  expect(botWorkStatus("writer", turns, [], labels).kind).toBe("replying");
  expect(sidebarStatus(group, turns, [], labels).kind).toBe("replying");
});

test("sidebar you↔bot row shows running status when this session is active", () => {
  const youBot: SessionSummary = {
    id: "s-you",
    kind: "direct",
    name: null,
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: "writer", joined_at: "t", left_at: null },
    ],
  };
  const turns = [makeTurn("t1", "s-you", "running", { bot_id: "writer" })];
  expect(sidebarStatus(youBot, turns, [], labels).kind).toBe("running");
  expect(sidebarStatus(youBot, turns, [], labels).label).toBe("思考中");
});
