import { describe, expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID, USER_MEMBER, type SessionSummary } from "@real-bot/protocol";
import type { SessionStatusResult } from "../../m/sidebar/session-status";
import { collectLiveItems } from "./live-strip-model";

const IDLE: SessionStatusResult = { kind: "idle", label: "", isBusy: false };
const RUNNING: SessionStatusResult = { kind: "running", label: "思考中", isBusy: true };
const WAITING: SessionStatusResult = { kind: "waiting_approval", label: "待审批", isBusy: false, count: 1 };

function makeSession(patch: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    kind: "direct",
    name: patch.id,
    participants: [
      { member: USER_MEMBER, left_at: null },
      { member: `bot-${patch.id}`, left_at: null },
    ],
    updated_at: "2026-11-25T03:00:00.000Z",
    created_at: "2026-11-25T01:00:00.000Z",
    last_message: null,
    ...patch,
  } as unknown as SessionSummary;
}

describe("collectLiveItems", () => {
  test("prioritizes waiting > running > elsewhere > unread file drop and skips idle/read items", () => {
    const idleBot = makeSession({ id: "idle-bot" });
    const runningBot = makeSession({ id: "running-bot", updated_at: "2026-11-25T03:10:00.000Z" });
    const elsewhereBot = makeSession({ id: "elsewhere-bot", updated_at: "2026-11-25T03:20:00.000Z" });
    const waitingProject = makeSession({
      id: "waiting-proj",
      kind: "project",
      project_dir: "/code/trustin",
      participants: [],
      updated_at: "2026-11-25T03:05:00.000Z",
    });
    const idleProject = makeSession({
      id: "idle-proj",
      kind: "project",
      project_dir: "/code/real-bot",
      participants: [],
    });
    const fileDrop = makeSession({ id: FILE_DROP_SESSION_ID, participants: [{ member: USER_MEMBER, left_at: null }] });

    const items = collectLiveItems({
      bots: [idleBot, runningBot, elsewhereBot],
      projects: [waitingProject, idleProject],
      fileDrop,
      statusOf: (s) => (s.id === "running-bot" ? RUNNING : IDLE),
      projectStatusOf: (s) => (s.id === "waiting-proj" ? WAITING : IDLE),
      elsewhereOf: (s) => (s.id === "elsewhere-bot" ? "在和「视频导演」私聊 · 思考中" : null),
      unreadOf: (s) => (s.id === FILE_DROP_SESSION_ID ? 2 : s.id === "idle-bot" ? 5 : 0),
    });

    expect(items.map((x) => x.session.id)).toEqual(["waiting-proj", "running-bot", "elsewhere-bot", FILE_DROP_SESSION_ID]);
    expect(items[0]?.dirLabel).toBe("trustin");
    expect(items[3]?.kind).toBe("file-drop");
    expect(items[3]?.unread).toBe(2);
  });

  test("omits file drop when it has no unread messages", () => {
    const fileDrop = makeSession({ id: FILE_DROP_SESSION_ID, participants: [{ member: USER_MEMBER, left_at: null }] });
    const items = collectLiveItems({
      bots: [],
      projects: [],
      fileDrop,
      statusOf: () => IDLE,
      projectStatusOf: () => IDLE,
      elsewhereOf: () => null,
      unreadOf: () => 0,
    });
    expect(items).toEqual([]);
  });
});
