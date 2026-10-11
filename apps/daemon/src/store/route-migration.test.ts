import { expect, test } from "bun:test";
import { Store } from ".";
import { migrateRouteTables } from "./route-migration";

test("a desk or read-only turn keeps no job across restarts; only a turn from before jobs is given one", () => {
  const store = new Store();
  try {
    store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', '8')");
    const { bot, direct_session: direct } = store.createBot({ name: "通识", duties: "answer", boundaries: "none" });
    const asked = store.postMessage(direct.id, { body: "Stepfun 是哪个公司的产品" });
    const desk = store.createTurn({ sessionId: direct.id, botId: bot.id, triggerMessageId: asked.id });
    expect(desk).toMatchObject({ mode: "desk", task_id: null });
    store.setTurnStatus(desk.id, "completed");
    const read = store.createTurn({ sessionId: direct.id, botId: bot.id, triggerMessageId: asked.id, mode: "readonly" });
    store.setTurnStatus(read.id, "completed");
    // A turn from before jobs existed: no job, no mode.
    const old = store.createTurn({ sessionId: direct.id, botId: bot.id, triggerMessageId: asked.id });
    store.setTurnStatus(old.id, "completed");
    store.db.run("UPDATE turns SET mode = NULL WHERE id = ?", [old.id]);

    // What every start runs.
    migrateRouteTables(store.db, []);
    expect(store.getTurn(desk.id).task_id).toBeNull();
    expect(store.getTurn(read.id).task_id).toBeNull();
    expect(store.getTurn(old.id).task_id).not.toBeNull();
    expect(store.db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
  } finally {
    store.close();
  }
});
