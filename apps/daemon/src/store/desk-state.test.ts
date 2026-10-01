import { afterEach, expect, test } from "bun:test";
import { Store } from "./index";
import { runCollabTool } from "../collab-tools";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store();
  stores.push(store);
  store.raiseEngineLevel(null);
  const { bot, direct_session: session } = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const line = store.postMessage(session.id, { body: "Write the report" });
  const turn = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: line.id });
  return { store, bot, session, line, turn };
}

test("filing state reads its rejection budget and records an attention outcome with its notice", () => {
  const { store, turn } = fixture();
  expect(store.filingBudget(turn.id)).toBe(0);
  store.noteFilingBounce(turn.id);
  store.noteFilingBounce(turn.id);
  expect(store.filingBudget(turn.id)).toBe(2);
  const notice = store.markNeedsAttention(turn.id, "en");
  expect(notice.body).toBe("This line needs a job selected before work can proceed.");
  expect(store.getTurn(turn.id).end_reason).toBe("needs_attention");
  expect(store.getTurn(turn.id).work_item_id).not.toBeNull();
});

test("Continue recovers the original user request across two interruption notes without creating new quotes", () => {
  const { store, line, turn } = fixture();
  const firstNote = store.interruptTurnRecord(turn.id)!.note;
  const second = store.claimInterruptContinue(firstNote.id);
  const secondNote = store.interruptTurnRecord(second.id)!.note;
  const third = store.claimInterruptContinue(secondNote.id);
  expect(store.originalUserRequest(turn.id)?.id).toBe(line.id);
  expect(store.originalUserRequest(third.id)?.id).toBe(line.id);
  const system = store.insertMessage({ sessionId: line.session_id, kind: "system", author: line.author, body: "A reminder" });
  store.setTurnStatus(third.id, "completed");
  const reminder = store.createTurn({ sessionId: line.session_id, botId: turn.bot_id, triggerMessageId: system.id });
  expect(store.originalUserRequest(reminder.id)).toBeNull();
});

test("attention state rolls back when its visible notice fails", () => {
  const { store, turn } = fixture();
  const events: string[] = [];
  store.onCommit((event) => events.push(event.event));
  store.db.run(`CREATE TEMP TRIGGER refuse_attention_notice BEFORE INSERT ON messages
    WHEN NEW.kind = 'system' BEGIN SELECT RAISE(ABORT, 'notice refused'); END`);
  expect(() => store.markNeedsAttention(turn.id, "en")).toThrow("notice refused");
  expect(store.getTurn(turn.id).end_reason).toBeNull();
  expect(events).toEqual([]);
});

test("directory use changes only a bound working segment", async () => {
  const { store, bot, session, line, turn } = fixture();
  store.markWorkDirectoryUsed(turn.id);
  const plan = store.openTask({ sessionId: session.id, title: "Report" });
  store.setTurnStatus(turn.id, "completed");
  const bound = store.createTurn({ sessionId: session.id, botId: bot.id, triggerMessageId: line.id, taskId: plan.id });
  store.markWorkDirectoryUsed(bound.id);
  store.markWorkDirectoryUsed(bound.id);
  const result = await runCollabTool({ store, botId: bot.id, sessionId: session.id, turnId: bound.id, parentId: null },
    "work_on", { plan: { new: { title: "Website", quote_message_id: line.id } } });
  expect(result).toMatchObject({ ok: false, error: { code: "work_dir_fixed" } });
  expect(store.getTurn(bound.id).task_id).toBe(plan.id);
});
