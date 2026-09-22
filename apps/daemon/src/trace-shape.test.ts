import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER } from "@real-bot/protocol";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

/**
 * What the board has to get right about a group: one line of yours wakes everyone who was named
 * or judged themselves in, and each of them can wake others. Read as a chain it says the wrong
 * thing — that the card above yours is the one that woke you.
 */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "trace-shape-")));
  const store = new Store({ endpointKey: memoryKeyStore(null) });
  return { store, root, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("one message waking two Bots gives them one parent, not a queue", async () => {
  const { store, close } = fixture();
  try {
    const writer = store.createBot({ name: "编剧", duties: "写", boundaries: "" });
    const reviewer = store.createBot({ name: "审片", duties: "审", boundaries: "" });
    const group = store.createGroup({ name: "组", members: [writer.bot.id, reviewer.bot.id] });

    const yours = store.postMessage(group.id, { body: "开工" });
    const one = store.createTurn({ sessionId: group.id, botId: writer.bot.id, triggerMessageId: yours.id });
    const two = store.createTurn({ sessionId: group.id, botId: reviewer.bot.id, triggerMessageId: yours.id });
    const taskId = one.task_id!;

    // The writer hands off: its message wakes the reviewer a second time.
    const handoff = store.insertMessage({ sessionId: group.id, turnId: one.id, kind: "bot", author: writer.bot.id, body: "@审片 看一下" });
    const three = store.createTurn({ sessionId: group.id, botId: reviewer.bot.id, triggerMessageId: handoff.id });

    const trace = store.taskTrace(taskId);
    const byId = new Map(trace.nodes.map((node) => [node.turn_id, node]));
    const youCard = trace.nodes.find((node) => node.actor === USER_MEMBER)!;
    // Both first turns hang off your card, not off each other.
    expect(byId.get(one.id)!.woken_by_turn_id).toBe(youCard.turn_id);
    expect(byId.get(two.id)!.woken_by_turn_id).toBe(youCard.turn_id);
    // And the handoff hangs off the turn that made it.
    expect(byId.get(three.id)!.woken_by_turn_id).toBe(one.id);
    expect(byId.get(three.id)!.actor).toBe(reviewer.bot.id);
    expect(trace.nodes.filter((node) => node.actor === USER_MEMBER)).toHaveLength(1);
  } finally {
    close();
  }
});

test("a turn whose waker is off the board names who sent it instead of reading as yours", () => {
  // Reachable from data, not from the runtime: a turn always inherits its waker's job, so this
  // is what a cleared history or a pre-jobs row looks like — the waking turn is simply not there.
  // The old reading turned that into a card saying **you** wrote the Bot's handoff.
  const { store, close } = fixture();
  try {
    const first = store.createBot({ name: "甲", duties: "", boundaries: "" });
    const second = store.createBot({ name: "乙", duties: "", boundaries: "" });
    const room = store.createGroup({ name: "组", members: [first.bot.id, second.bot.id] });

    const yours = store.postMessage(room.id, { body: "甲的活" });
    const theirTurn = store.createTurn({ sessionId: room.id, botId: first.bot.id, triggerMessageId: yours.id });
    const handoff = store.insertMessage({
      sessionId: room.id, turnId: theirTurn.id, kind: "bot", author: first.bot.id, body: "@乙 接手",
    });
    const woken = store.createTurn({ sessionId: room.id, botId: second.bot.id, triggerMessageId: handoff.id });
    const taskId = woken.task_id!;
    store.db.run(`DELETE FROM turns WHERE id = ?`, [theirTurn.id]);

    const trace = store.taskTrace(taskId);
    const node = trace.nodes.find((row) => row.turn_id === woken.id)!;
    expect(node.woken_by_turn_id).toBeNull();
    expect(node.woken_elsewhere).toEqual({ actor: first.bot.id, message_id: handoff.id });
    expect(node.actor).toBe(second.bot.id);
    // No invented card, and nothing claiming you said it.
    expect(trace.nodes.some((row) => row.actor === USER_MEMBER)).toBe(false);
  } finally {
    close();
  }
});

test("a card carries the files its own turn handed over", async () => {
  const { store, root, close } = fixture();
  try {
    await store.patchSettings({ workspace_path: root });
    const bot = store.createBot({ name: "甲", duties: "", boundaries: "" });
    const session = bot.direct_session.id;
    const yours = store.postMessage(session, { body: "做个表" });
    const turn = store.createTurn({ sessionId: session, botId: bot.bot.id, triggerMessageId: yours.id });
    const taskId = turn.task_id!;
    store.insertMessage({
      sessionId: session, turnId: turn.id, kind: "bot", author: bot.bot.id,
      body: "写好了 report.md", paths: ["report.md"],
    });

    const node = store.taskTrace(taskId).nodes.find((row) => row.turn_id === turn.id)!;
    expect(node.artifacts.map((file) => file.path)).toEqual(["report.md"]);
  } finally {
    close();
  }
});

test("turns from before jobs existed are grouped into one, and the picture is whole again", () => {
  // What every conversation older than the work-dir release looks like: turns with no job. The
  // trace then showed the few that had one and dropped the rest, and a turn whose waker was
  // missing read as yours.
  const { store, close } = fixture();
  try {
    const writer = store.createBot({ name: "编剧", duties: "", boundaries: "" });
    const reviewer = store.createBot({ name: "审片", duties: "", boundaries: "" });
    const group = store.createGroup({ name: "组", members: [writer.bot.id, reviewer.bot.id] });

    const yours = store.postMessage(group.id, { body: "开工" });
    const one = store.createTurn({ sessionId: group.id, botId: writer.bot.id, triggerMessageId: yours.id });
    const handoff = store.insertMessage({
      sessionId: group.id, turnId: one.id, kind: "bot", author: writer.bot.id, body: "@审片 看看",
    });
    const two = store.createTurn({ sessionId: group.id, botId: reviewer.bot.id, triggerMessageId: handoff.id });

    // Wind the rows back to what an older build wrote: no job on anything.
    store.db.run(`UPDATE turns SET task_id = NULL`);
    store.db.run(`UPDATE messages SET task_id = NULL`);
    store.db.run(`DELETE FROM tasks`);
    expect(store.sessionTasks(group.id)).toHaveLength(0);

    const { migrateSchema } = require("./store/migrate") as typeof import("./store/migrate");
    migrateSchema(store.db);

    const tasks = store.sessionTasks(group.id);
    expect(tasks).toHaveLength(1);
    const trace = store.taskTrace(tasks[0]!.id);
    const byId = new Map(trace.nodes.map((node) => [node.turn_id, node]));
    // Both turns are back, and the handoff is an edge rather than a second card of yours.
    expect(byId.has(one.id)).toBe(true);
    expect(byId.get(two.id)!.woken_by_turn_id).toBe(one.id);
    expect(trace.nodes.filter((node) => node.actor === USER_MEMBER)).toHaveLength(1);
    // Nothing new joins a job that is over.
    expect(tasks[0]!.closed_at).not.toBeNull();
  } finally {
    close();
  }
});
