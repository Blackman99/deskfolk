/**
 * A working Bot's inbox (ADR 0040 P4a): a line said while a turn works is a row, read at that
 * turn's next step, and ends as what the Bot said it did with it — or unacked when it said nothing.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from ".";

function fixture() {
  const store = new Store();
  store.raiseEngineLevel(null);
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const direct = director.direct_session;
  const opener = store.insertMessage({ sessionId: direct.id, kind: "user", author: "user", body: "先出 EP01" });
  const turn = store.createTurn({ sessionId: direct.id, botId: director.bot.id, triggerMessageId: opener.id });
  return { store, bot: director.bot, direct, turn };
}

function queue(store: Store, turn: { id: string; bot_id: string; session_id: string }, body: string, over: { kind?: "change" | "question"; source?: "user" | "peer_note" } = {}) {
  const message = store.insertMessage({ sessionId: turn.session_id, kind: over.source === "peer_note" ? "bot" : "user", author: "user", body });
  return store.queueInboxItem({
    botId: turn.bot_id,
    sessionId: turn.session_id,
    turnId: turn.id,
    taskId: null,
    ticketId: null,
    messageId: message.id,
    author: "user",
    body,
    source: over.source ?? "user",
    kind: over.kind ?? "change",
    priority: over.source === "peer_note" ? 3 : 1,
  });
}

describe("inbox items", () => {
  test("a queued line is delivered at a hop, and a line the turn never answered for is unacked", () => {
    const { store, turn } = fixture();
    const item = queue(store, turn, "前三镜背景别跳");
    expect(item.state).toBe("queued");
    expect(store.getMessage(item.message_id!).delivery).toMatchObject({ state: "queued", hop: null });

    const { delivered } = store.deliverInboxItems([item.seq], turn.id, 2);
    expect(delivered.map((row) => row.state)).toEqual(["delivered"]);
    expect(store.getMessage(item.message_id!).delivery).toMatchObject({ state: "delivered", hop: 2 });

    store.releaseTurnInbox(turn.id);
    expect(store.getInboxItem(item.seq)!.state).toBe("unacked");
  });

  test("end_turn records what the Bot did with each line it read, and refuses one it did not", () => {
    const { store, turn } = fixture();
    const read = queue(store, turn, "片长控制在两分钟");
    const other = queue(store, turn, "标题再短一点");
    store.deliverInboxItems([read.seq], turn.id, 1);
    const { recorded, notRecorded } = store.disposeInboxItems(turn.id, [
      { id: `U${read.seq}`, disposition: "adopted" },
      { id: `U${other.seq}`, disposition: "declined", note: "还没读到" },
      { id: "U999", disposition: "answered" },
    ]);
    expect(recorded).toEqual([`U${read.seq}`]);
    expect(notRecorded.map((row) => row.id)).toEqual([`U${other.seq}`, "U999"]);
    expect(store.getInboxItem(read.seq)!.state).toBe("adopted");
    // A line it never read is still the next turn's, not this one's to answer for.
    expect(store.getInboxItem(other.seq)!.state).toBe("queued");
  });

  test("a stop holds a line waiting for the next turn, and lifting it puts the line back", () => {
    const { store, bot, direct, turn } = fixture();
    store.setTurnStatus(turn.id, "completed");
    const item = queue(store, turn, "背景再连贯一点");
    const hold = store.createHold({ scope: "bot", scopeId: bot.id, action: "pause", source: "user_button" });
    expect(store.getInboxItem(item.seq)!.state).toBe("held");
    store.liftHold(hold.id, { by: "user_button" });
    expect(store.getInboxItem(item.seq)!.state).toBe("queued");

    const next = store.createTurn({ sessionId: direct.id, botId: bot.id, triggerMessageId: store.insertMessage({ sessionId: direct.id, kind: "user", author: "user", body: "继续" }).id });
    expect(store.adoptWaitingInbox({ botId: bot.id, sessionId: direct.id, turnId: next.id }).map((row) => row.seq)).toEqual([item.seq]);
    expect(store.queuedForTurn(next.id).map((row) => row.seq)).toEqual([item.seq]);
  });

  test("a boot marks lines a dead turn read and never answered for as unacked", () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-boot-"));
    const filename = join(dir, "state.sqlite");
    const first = new Store({ filename });
    first.raiseEngineLevel(null);
    const bot = first.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
    const opener = first.insertMessage({ sessionId: bot.direct_session.id, kind: "user", author: "user", body: "开工" });
    const turn = first.createTurn({ sessionId: bot.direct_session.id, botId: bot.bot.id, triggerMessageId: opener.id });
    const item = queue(first, turn, "片长两分钟");
    first.deliverInboxItems([item.seq], turn.id, 1);
    first.close();

    const second = new Store({ filename });
    second.recoverInterruptedTurns();
    expect(second.getInboxItem(item.seq)!.state).toBe("unacked");
    second.close();
  });

  test("clearing a conversation keeps the words of a line still waiting", () => {
    const { store, direct, turn } = fixture();
    const item = queue(store, turn, "前三镜背景严重跳跃");
    store.clearSessionMessages(direct.id, { eraseQuotes: false });
    const kept = store.getInboxItem(item.seq)!;
    expect(kept.body_snapshot).toBe("前三镜背景严重跳跃");
    expect(kept.message_id).toBeNull();
    expect(kept.state).toBe("queued");
  });
});
