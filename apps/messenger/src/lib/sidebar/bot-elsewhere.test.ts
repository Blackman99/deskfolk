import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aDirect, aGroup, aTurn } from "../test-fixtures.ts";
import { botWorkPlaces, directElsewhere, elsewhereLine } from "./bot-elsewhere.ts";

const t = copyFor("zh");
const labels = {
  running: t.sidebar.statusRunning,
  replying: t.sidebar.statusReplying,
  waitingApproval: t.sidebar.statusWaitingApproval,
  waitingAsk: t.sidebar.statusWaitingAsk,
  failed: t.sidebar.statusFailed,
  interrupted: t.sidebar.statusInterrupted,
  idle: t.sidebar.statusIdle,
};
const roster = { deleted: t.top.deleted, archived: t.top.archived };
const bots = new Map([aBot({ id: "bot-1", name: "视频导演" }), aBot({ id: "bot-2", name: "审核员" })].map((b) => [b.id, b] as const));
const direct = aDirect({ id: "direct-1" });
const group = aGroup({ id: "sess-1", name: "视频组" });
const botDirect = aBotDirect({ id: "botbot-1" });
const sessions = [direct, group, botDirect];

test("a Bot at work only in a Bot↔Bot direct is said to be there, by both names", () => {
  const turns = [aTurn({ id: "t1", session_id: "botbot-1", partial_text: "写着呢" })];
  const snapshot = { sessions, turns, approvals: [], pendingJudgements: [] };
  expect(directElsewhere(direct, false, snapshot, bots, labels, roster, t.sidebar.elsewhere)).toBe("在和「审核员」私聊 · 回复中");
});

test("a group is marked as one, and a place waiting on you comes before the longest running", () => {
  const turns = [
    aTurn({ id: "t1", session_id: "botbot-1", created_at: "2026-09-19T01:00:00.000Z" }),
    aTurn({ id: "t2", session_id: "sess-1", status: "waiting_ask", created_at: "2026-09-19T02:00:00.000Z" }),
  ];
  const places = botWorkPlaces("bot-1", "direct-1", sessions, turns, [], labels);
  expect(places.map((p) => p.session.id)).toEqual(["sess-1", "botbot-1"]);
  expect(elsewhereLine(places.slice(0, 1), false, bots, roster, t.sidebar.elsewhere)).toBe("在群「视频组」 · 待回复");
  expect(elsewhereLine(places, false, bots, roster, t.sidebar.elsewhere)).toBe("在 2 处工作");
  expect(elsewhereLine(places, true, bots, roster, t.sidebar.elsewhere)).toBe("另在 2 处工作");
});

test("the conversation on screen, another Bot's turns and finished turns are no place", () => {
  const turns = [
    aTurn({ id: "t1", session_id: "direct-1" }),
    aTurn({ id: "t2", session_id: "sess-1", bot_id: "bot-2" }),
    aTurn({ id: "t3", session_id: "botbot-1", status: "completed" }),
  ];
  expect(botWorkPlaces("bot-1", "direct-1", sessions, turns, [], labels)).toEqual([]);
  expect(directElsewhere(group, false, { sessions, turns, approvals: [], pendingJudgements: [] }, bots, labels, roster, t.sidebar.elsewhere)).toBeNull();
});
