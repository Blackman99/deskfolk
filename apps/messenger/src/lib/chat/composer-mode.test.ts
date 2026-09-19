import { expect, test } from "bun:test";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import { composerAction, composerLocked, composerMode } from "./composer-mode.ts";

const writer: Bot = {
  id: "writer",
  name: "Writer",
  duties: "",
  boundaries: "",
  model: null,
  archived_at: null,
  created_at: "t",
  updated_at: "t",
};

function direct(peer: string): SessionSummary {
  return {
    id: "d",
    kind: "direct",
    name: null,
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: peer, joined_at: "t", left_at: null },
    ],
  };
}

const ready = {
  connected: true,
  hasSession: true,
  locked: false,
  hasLiveTurn: false,
  pendingJudgement: false,
  busy: false,
  hasContent: true,
  sessionKind: "direct" as const,
};

test("the composer offers only send when idle and stop while a turn is live", () => {
  expect(composerAction(ready)).toEqual({ kind: "send", disabled: false });
  expect(composerAction({ ...ready, hasContent: false })).toEqual({ kind: "send", disabled: true });
  for (const hasContent of [true, false]) {
    expect(composerAction({ ...ready, hasLiveTurn: true, hasContent })).toEqual({
      kind: "stop", disabled: false,
    });
  }
});

test("a group composer never offers stop and can send while work is live", () => {
  const group = { ...ready, sessionKind: "group" as const };
  expect(composerAction(group)).toEqual({ kind: "send", disabled: false });
  expect(composerAction({ ...group, hasLiveTurn: true })).toEqual({ kind: "send", disabled: false });
  expect(composerAction({ ...group, hasLiveTurn: true, pendingJudgement: true })).toEqual({
    kind: "send", disabled: false,
  });
  expect(composerAction({ ...group, hasLiveTurn: true, hasContent: false })).toEqual({
    kind: "send", disabled: true,
  });
  expect(composerAction({ ...group, hasLiveTurn: true, busy: true })).toEqual({
    kind: "send", disabled: true,
  });
  expect(composerAction({ ...group, hasLiveTurn: true, connected: false })).toEqual({
    kind: "send", disabled: true,
  });
});

test("send stays disabled during submission, judgement, disconnection and read-only states", () => {
  for (const state of [
    { busy: true },
    { pendingJudgement: true },
    { connected: false },
    { locked: true },
    { hasSession: false },
  ]) {
    expect(composerAction({ ...ready, ...state })).toEqual({ kind: "send", disabled: true });
  }
});

test("stop remains available during submission and in a locked session with live work", () => {
  expect(composerAction({ ...ready, hasLiveTurn: true, busy: true, locked: true })).toEqual({
    kind: "stop", disabled: false,
  });
  expect(composerAction({ ...ready, hasLiveTurn: true, connected: false })).toEqual({
    kind: "stop", disabled: true,
  });
});

test("another session's live work cannot turn a sessionless composer into stop", () => {
  expect(composerAction({ ...ready, hasSession: false, hasLiveTurn: true })).toEqual({
    kind: "send", disabled: true,
  });
});

test("completion or stopping restores send for the preserved draft", () => {
  const state = { ...ready, hasLiveTurn: true };
  expect(composerAction(state).kind).toBe("stop");
  state.hasLiveTurn = false;
  expect(composerAction(state)).toEqual({ kind: "send", disabled: false });
});

test("no live turn is idle regardless of the fork switch", () => {
  expect(composerMode(false, false)).toBe("idle");
  expect(composerMode(false, true)).toBe("idle");
});

test("a live turn redirects unless the fork switch is on", () => {
  expect(composerMode(true, false)).toBe("redirect");
  expect(composerMode(true, true)).toBe("fork");
});

test("the you↔Bot composer locks only when that Bot is gone from the snapshot", () => {
  const bots = new Map<string, Bot>([["writer", writer]]);
  expect(composerLocked(direct("writer"), bots)).toBe(false);
  expect(composerLocked(direct("writer"), new Map([["writer", { ...writer, archived_at: "t2" }]]))).toBe(
    false,
  );
  expect(composerLocked(direct("gone"), bots)).toBe(true);
  expect(composerLocked(null, bots)).toBe(false);
  const group: SessionSummary = {
    id: "g",
    kind: "group",
    name: "Brief",
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: "writer", joined_at: "t", left_at: null },
      { member: "researcher", joined_at: "t", left_at: null },
    ],
  };
  expect(composerLocked(group, bots)).toBe(false);
  expect(composerLocked({ ...group, archived_at: "t2" }, bots)).toBe(true);
});
