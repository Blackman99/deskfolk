/**
 * A stop is only "stop for now" (ADR 0071), and your word to a Bot ends it whole, however many Bots it
 * was over (ADR 0081): its appointments come back, the plans it parked go back. A release written by
 * an older build (`effect.released_bots`) is still read by every held check until the stop is lifted.
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

describe("your word past a stop over more Bots", () => {
  test("a stop on everything is lifted whole by your word to one Bot", () => {
    const { store, writer, designer, group } = fixture();
    const hold = store.createHold({ scope: "global", source: "user_button" });
    expect(store.holdsCovering({ botId: writer.id, sessionId: group.id })).toHaveLength(1);

    const said = store.postMessage(group.id, { body: "@文案 先写三句" });
    const [after] = store.goOnForYourWord({ botId: writer.id, sessionId: group.id }, { by: "user_text", messageId: said.id });

    expect(after).toMatchObject({ id: hold.id, lifted_by: "user_text", lifted_message_id: said.id });
    expect(store.holdsCovering({ botId: writer.id, sessionId: group.id })).toEqual([]);
    expect(store.holdsCovering({ botId: designer.id, sessionId: group.id })).toEqual([]);
    expect(store.createTurn({ sessionId: group.id, botId: designer.id, triggerMessageId: said.id }).status).toBe("running");
  });

  test("every Bot's appointments come back, and the plans it parked go back", () => {
    const { store, writer, designer, group, line } = fixture();
    const job = store.openTask({ sessionId: group.id, title: "海报" });
    const writing = store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: line.id });
    const drawing = store.createTurn({ sessionId: group.id, botId: designer.id, triggerMessageId: line.id });
    const mine = store.scheduleCheckBack({ botId: writer.id, sessionId: group.id, turnId: writing.id, note: "看渲染", afterMinutes: 5 }).row;
    const theirs = store.scheduleCheckBack({ botId: designer.id, sessionId: group.id, turnId: drawing.id, note: "看渲染", afterMinutes: 5 }).row;
    store.setTurnStatus(writing.id, "completed");
    store.setTurnStatus(drawing.id, "completed");
    store.createHold({ scope: "session", scopeId: group.id, source: "user_button" });
    expect(store.getCheckBack(theirs.id).suspended_at).not.toBeNull();
    expect(store.getTask(job.id).status).toBe("parked");

    store.goOnForYourWord({ botId: writer.id, sessionId: group.id }, { by: "user_button" });

    expect(store.getCheckBack(mine.id).suspended_at).toBeNull();
    expect(store.getCheckBack(theirs.id).suspended_at).toBeNull();
    expect(store.getTask(job.id).status).toBe("active");
  });

  test("a release an older build wrote still lets that Bot through until the stop is lifted", () => {
    const { store, writer, designer, group, line } = fixture();
    const hold = store.createHold({ scope: "global", source: "user_button" });
    store.addHoldEffect(hold.id, { released_bots: [writer.id] });

    expect(store.holdsCovering({ botId: writer.id, sessionId: group.id })).toEqual([]);
    expect(store.holdsCovering({ botId: designer.id, sessionId: group.id }).map((row) => row.id)).toEqual([hold.id]);
    expect(store.createTurn({ sessionId: group.id, botId: writer.id, triggerMessageId: line.id }).status).toBe("running");
    expect(() => store.createTurn({ sessionId: group.id, botId: designer.id, triggerMessageId: line.id })).toThrow();
  });
});
