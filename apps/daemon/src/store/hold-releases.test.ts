/**
 * A stop is only "stop for now" (ADR 0071): your word to a Bot releases that Bot from a stop over
 * more than it, and the stop still holds the rest. Every held check — wakes, inbox items, appointments,
 * the database's own refusal of a turn — reads the release; once every Bot it covers is released, it
 * is lifted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Store } from ".";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store();
  stores.push(store);
  store.raiseEngineLevel(null);
  const writer = store.createBot({ name: "文案", duties: "写", boundaries: "none" }).bot;
  const designer = store.createBot({ name: "设计师", duties: "画", boundaries: "none" }).bot;
  const group = store.createGroup({ name: "海报组", members: [writer.id, designer.id] });
  const line = store.postMessage(group.id, { body: "写三句宣传语" });
  return { store, writer, designer, group, line };
}

describe("releasing a Bot from a stop", () => {
  test("a stop on everything stops holding the Bot you spoke to, and holds the other", () => {
    const { store, writer, designer, group } = fixture();
    const hold = store.createHold({ scope: "global", source: "user_button" });
    expect(store.holdsCovering({ botId: writer.id, sessionId: group.id })).toHaveLength(1);

    const said = store.postMessage(group.id, { body: "@文案 先写三句" });
    const after = store.releaseHold(hold.id, [writer.id], { by: "user_text", messageId: said.id });

    expect(after).toMatchObject({ lifted_at: null, effect: { released_bots: [writer.id] } });
    expect(store.holdsCovering({ botId: writer.id, sessionId: group.id })).toEqual([]);
    expect(store.holdsCovering({ botId: designer.id, sessionId: group.id }).map((row) => row.id)).toEqual([hold.id]);
    // The database's own refusal reads it too: a working turn of the released Bot opens, the other's does not.
    expect(store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: said.id }).status).toBe("running");
    expect(() => store.createTurn({ sessionId: group.id, botId: designer.id, triggerMessageId: said.id })).toThrow();
  });

  test("its appointments come back; the other Bot's stay set aside", () => {
    const { store, writer, designer, group, line } = fixture();
    const writing = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: line.id });
    const drawing = store.createTurn({ sessionId: group.id, botId: designer.id, triggerMessageId: line.id });
    const mine = store.scheduleCheckBack({ botId: writer.id, sessionId: group.id, turnId: writing.id, note: "看渲染", afterMinutes: 5 }).row;
    const theirs = store.scheduleCheckBack({ botId: designer.id, sessionId: group.id, turnId: drawing.id, note: "看渲染", afterMinutes: 5 }).row;
    store.setTurnStatus(writing.id, "completed");
    store.setTurnStatus(drawing.id, "completed");
    const hold = store.createHold({ scope: "session", scopeId: group.id, source: "user_button" });
    expect(store.getCheckBack(mine.id).suspended_at).not.toBeNull();

    store.releaseHold(hold.id, [writer.id], { by: "user_button" });

    expect(store.getCheckBack(mine.id).suspended_at).toBeNull();
    expect(store.getCheckBack(theirs.id).suspended_at).not.toBeNull();
  });

  test("once every Bot it covers is released it is lifted, and the plans it parked go back", () => {
    const { store, writer, designer, group, line } = fixture();
    const job = store.openTask({ sessionId: group.id, title: "海报" });
    const hold = store.createHold({ scope: "session", scopeId: group.id, source: "user_text", sourceMessageId: line.id });
    expect(store.getTask(job.id).status).toBe("parked");

    const said = store.postMessage(group.id, { body: "接着做" });
    store.releaseHold(hold.id, [writer.id], { by: "user_text", messageId: said.id });
    expect(store.getHold(hold.id).lifted_at).toBeNull();
    const lifted = store.releaseHold(hold.id, [designer.id], { by: "user_text", messageId: said.id });

    expect(lifted).toMatchObject({ lifted_by: "user_text", lifted_message_id: said.id });
    expect(store.getTask(job.id).status).toBe("active");
  });

  test("a stop on everything is never lifted by releases: Bots made later are under it too", () => {
    const { store, writer, designer } = fixture();
    const hold = store.createHold({ scope: "global", source: "user_button" });
    store.releaseHold(hold.id, [writer.id, designer.id], { by: "user_button" });
    expect(store.getHold(hold.id).lifted_at).toBeNull();
    const later = store.createBot({ name: "剪辑", duties: "剪", boundaries: "none" }).bot;
    expect(store.holdsCovering({ botId: later.id }).map((row) => row.id)).toEqual([hold.id]);
  });
});
