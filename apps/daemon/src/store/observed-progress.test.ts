import { afterEach, expect, test } from "bun:test";
import { Store } from ".";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test("an actual observed ticket stage change is progress, so the following quiet segment is only the first quiet ending", () => {
  const store = new Store(); stores.push(store); store.raiseEngineLevel(null);
  const made = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const plan = store.openTask({ sessionId: made.direct_session.id, title: "Report" });
  const ticket = store.createTicket({ taskId: plan.id, title: "Draft", worker: made.bot.id });
  const first = store.postMessage(made.direct_session.id, { body: "Write" });
  const turn = store.createTurn({ sessionId: first.session_id, botId: made.bot.id, triggerMessageId: first.id, taskId: plan.id, ticketId: ticket.id });
  store.observeTicketWork({ ticketId: ticket.id, botId: made.bot.id, turnId: turn.id, seen: "working" });
  const productive = store.finishWork({ turnId: turn.id, reason: "nothing_new" });
  expect(productive.noProgressCount).toBe(0);
  store.setTurnStatus(turn.id, "completed");
  const later = store.postMessage(first.session_id, { body: "Check" });
  const next = store.createTurn({ sessionId: later.session_id, botId: made.bot.id, triggerMessageId: later.id, taskId: plan.id, ticketId: ticket.id });
  const quiet = store.finishWork({ turnId: next.id, reason: "nothing_new" });
  expect(quiet.state).toBe("idle");
  expect(quiet.noProgressCount).toBe(1);
});
