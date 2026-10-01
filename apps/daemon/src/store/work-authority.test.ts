import { afterEach, expect, test } from "bun:test";
import { Store } from ".";
import { mayAct } from "../engine/control";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store(); stores.push(store); store.raiseEngineLevel(null);
  const made = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const line = store.postMessage(made.direct_session.id, { body: "Write a report" });
  const plan = store.openTask({ sessionId: line.session_id, title: "Report" });
  const turn = store.createTurn({ sessionId: line.session_id, botId: made.bot.id, triggerMessageId: line.id, taskId: plan.id });
  return { store, made, turn };
}

test("archiving a Bot atomically closes its work and revokes the active segment's effect authority", () => {
  const { store, made, turn } = fixture();
  expect(mayAct(store, turn.id)).toBe(true);
  store.archiveBot(made.bot.id);
  expect(mayAct(store, turn.id)).toBe(false);
  expect(store.getTurn(turn.id).status).toBe("interrupted");
  expect(store.getTurn(turn.id).end_reason).toBe("bot_archived");
});
