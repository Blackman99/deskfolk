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
  // Nothing to decide: no card asks you about it, and no notification waits on you.
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM messages WHERE json_extract(control, '$.kind') = 'model_default'").get()).toEqual({ n: 0 });
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM notifications WHERE semantic_key LIKE 'model_default:%'").get()).toEqual({ n: 0 });
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM work_events WHERE kind = 'model.default_inferred' AND bot_id = ?").get(f.reviewer.id)).toEqual({ n: 1 });
  // Inferred once: the next turn uses it as it is.
  expect(f.store.ensureBotDefault(f.reviewer.id, listed)).toEqual(fallback);
});

/** A default-model card from before they stopped being put up (2026-10-04), with its notification. */
function oldCard(f: ReturnType<typeof fixture>, model: string, thinking: "low" | "high"): string {
  const card = f.store.insertMessage({ sessionId: f.dm, kind: "system", author: "user", hiddenFromBots: true, body: `审片员 之后默认用 ${model}`,
    control: { kind: "model_default", bot_id: f.reviewer.id, provider_id: "p-1", model, thinking_level: thinking, offer: ["confirm", "decline"] } });
  f.store.createNotification({ semantic_key: `model_default:${card.id}`, kind: "ask", session_id: f.dm, message_id: card.id, action_state: "open" });
  return card.id;
}

test("a card already out still takes its buttons, once each", () => {
  const f = fixture();
  ran(f.store, f.reviewer.id, f.dm, "gemini", "high", 2);
  f.store.ensureBotDefault(f.reviewer.id, listed);
  const card = oldCard(f, "gemini", "high");
  f.store.answerModelDefaultCard(card, "confirm");
  expect(f.store.botDefault(f.reviewer.id)).toMatchObject({ model: "gemini", source: "confirmed" });
  expect(f.store.db.query("SELECT action_state FROM notifications WHERE semantic_key = ?").get(`model_default:${card}`)).toEqual({ action_state: "resolved" });
  expect(() => f.store.answerModelDefaultCard(card, "decline")).toThrow();
});

test("declining drops the default for good; a Bot with nothing listed to go on gets none", () => {
  const f = fixture();
  ran(f.store, f.reviewer.id, f.dm, "grok", "low", 2);
  f.store.ensureBotDefault(f.reviewer.id, listed);
  f.store.answerModelDefaultCard(oldCard(f, "grok", "low"), "decline");
  expect(f.store.ensureBotDefault(f.reviewer.id, listed)).toMatchObject({ model: null, source: "declined" });

  const writer = f.store.createBot({ name: "编剧", duties: "写", boundaries: "none" }).bot;
  expect(f.store.ensureBotDefault(writer.id, listed)).toMatchObject({ model: null, source: null });
});

test("turns on a model you set on their ticket, or one a failing job climbed the ladder to, do not make it the Bot's default", () => {
  for (const [reason, base] of [["ticket_override", null], ["escalation_model", "default"], ["escalation", "ticket_override"]]) {
    const f = fixture();
    ran(f.store, f.reviewer.id, f.dm, "gemini", "high", 3);
    ran(f.store, f.reviewer.id, f.dm, "grok", "none", 6);
    f.store.db.run("UPDATE turn_route_decisions SET reason_code = ?, base_reason_code = ? WHERE model = 'grok'", [reason, base]);
    expect(f.store.ensureBotDefault(f.reviewer.id, listed)).toMatchObject({ model: "gemini", turns: 3 });
  }
});
