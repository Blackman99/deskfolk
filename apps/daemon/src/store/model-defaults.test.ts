import { afterEach, expect, test } from "bun:test";
import { Store } from ".";
import { ENGINE_LEVELS } from "./schema-gate";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(ENGINE_LEVELS.routing)]);
  const reviewer = store.createBot({ name: "审片员", duties: "审片", boundaries: "none" });
  return { store, reviewer: reviewer.bot, dm: reviewer.direct_session.id };
}

/** `n` turns of `botId` that ran on `model` at `thinking`, `daysAgo` days back. */
function ran(store: Store, botId: string, session: string, model: string, thinking: string, n: number, daysAgo = 1) {
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60_000).toISOString();
  for (let i = 0; i < n; i += 1) {
    const trigger = store.insertMessage({ sessionId: session, kind: "system", author: botId, body: "工作" });
    const turn = store.createTurn({ sessionId: session, botId, triggerMessageId: trigger.id });
    store.setTurnStatus(turn.id, "completed");
    store.db.run(`INSERT INTO turn_route_decisions (turn_id, session_id, bot_id, trigger_message_id, provider_id, model, thinking_level, signature, created_at)
      VALUES (?, ?, ?, ?, 'p-1', ?, ?, 'general', ?)`, [turn.id, session, botId, trigger.id, model, thinking, at]);
  }
}

const listed = [{ providerId: "p-1", model: "gemini" }, { providerId: "p-1", model: "grok" }];

test("a Bot's default is what it ran on most in the last week, among models still listed, at the thinking level it ran that on most", () => {
  const f = fixture();
  ran(f.store, f.reviewer.id, f.dm, "gemini", "high", 5);
  ran(f.store, f.reviewer.id, f.dm, "gemini", "max", 3);
  ran(f.store, f.reviewer.id, f.dm, "grok", "none", 4);
  // Renamed since, and too old: neither counts.
  ran(f.store, f.reviewer.id, f.dm, "grk", "high", 20);
  ran(f.store, f.reviewer.id, f.dm, "grok", "none", 20, 9);
  const fallback = f.store.ensureBotDefault(f.reviewer.id, listed);
  expect(fallback).toEqual({ providerId: "p-1", model: "gemini", thinkingLevel: "high", source: "inferred", turns: 8 });
  const cards = f.store.db.query<{ id: string }, []>("SELECT id FROM messages WHERE json_extract(control, '$.kind') = 'model_default'").all();
  expect(cards).toHaveLength(1);
  const card = f.store.getMessage(cards[0]!.id);
  expect(card.session_id).toBe(f.dm);
  expect(card.body).toContain("gemini");
  expect(card.control).toMatchObject({ bot_id: f.reviewer.id, model: "gemini", thinking_level: "high", offer: ["confirm", "decline"] });
  // Asked once: the next turn uses it without asking again.
  f.store.ensureBotDefault(f.reviewer.id, listed);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM messages WHERE json_extract(control, '$.kind') = 'model_default'").get()).toEqual({ n: 1 });

  f.store.answerModelDefaultCard(card.id, "confirm");
  expect(f.store.botDefault(f.reviewer.id)).toMatchObject({ model: "gemini", source: "confirmed" });
  expect(() => f.store.answerModelDefaultCard(card.id, "decline")).toThrow();
});

test("declining drops the default for good; a Bot with nothing listed to go on gets none", () => {
  const f = fixture();
  ran(f.store, f.reviewer.id, f.dm, "grok", "low", 2);
  f.store.ensureBotDefault(f.reviewer.id, listed);
  const card = f.store.db.query<{ id: string }, []>("SELECT id FROM messages WHERE json_extract(control, '$.kind') = 'model_default'").get()!;
  f.store.answerModelDefaultCard(card.id, "decline");
  expect(f.store.ensureBotDefault(f.reviewer.id, listed)).toMatchObject({ model: null, source: "declined" });
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM messages WHERE json_extract(control, '$.kind') = 'model_default'").get()).toEqual({ n: 1 });

  const writer = f.store.createBot({ name: "编剧", duties: "写", boundaries: "none" }).bot;
  expect(f.store.ensureBotDefault(writer.id, listed)).toMatchObject({ model: null, source: null });
});

test("turns on a model you set on their ticket do not make it the Bot's default", () => {
  const f = fixture();
  ran(f.store, f.reviewer.id, f.dm, "gemini", "high", 3);
  ran(f.store, f.reviewer.id, f.dm, "grok", "none", 6);
  f.store.db.run("UPDATE turn_route_decisions SET reason_code = 'ticket_override' WHERE model = 'grok'");
  expect(f.store.ensureBotDefault(f.reviewer.id, listed)).toMatchObject({ model: "gemini", turns: 3 });
});
