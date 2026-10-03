import { afterEach, expect, test } from "bun:test";
import { Store } from ".";
import { ENGINE_LEVELS } from "./schema-gate";
import { MODEL_LADDER_MAX } from "./model-ladder";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(level: number = ENGINE_LEVELS.routing) {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(level)]);
  for (const [id, models] of [["p-1", ["a", "b", "c"]], ["p-2", ["d"]]] as const) {
    store.db.run(`INSERT INTO providers (id, name, base_url, models, available_models, default_model, created_at, updated_at)
      VALUES (?, ?, 'http://x', ?, '[]', ?, '2026-01-01', '2026-01-01')`, [id, id, JSON.stringify(models), models[0]]);
  }
  return store;
}

test("the ladder keeps your order, listed models only, each once; empty takes it away", () => {
  const store = fixture();
  const rungs = [{ provider_id: "p-2", model: "d" }, { provider_id: "p-1", model: "a" }];
  expect(store.setModelLadder(rungs)).toEqual(rungs);
  expect(store.modelLadder()).toEqual(rungs);
  expect(() => store.setModelLadder([{ provider_id: "p-1", model: "d" }])).toThrow("no endpoint lists d there");
  expect(() => store.setModelLadder([{ provider_id: "p-1", model: "a" }, { provider_id: "p-1", model: "a" }])).toThrow("twice");
  expect(() => store.setModelLadder([{ provider_id: "p-1" }])).toThrow("{provider_id, model}");
  expect(() => store.setModelLadder("a")).toThrow("a list");
  expect(() => store.setModelLadder(Array.from({ length: MODEL_LADDER_MAX + 1 }, () => ({ provider_id: "p-1", model: "a" })))).toThrow(`at most ${MODEL_LADDER_MAX}`);
  expect(store.modelLadder()).toEqual(rungs);
  expect(store.setModelLadder([])).toEqual([]);
  expect(store.modelLadder()).toEqual([]);
});

test("below level 7 there is no ladder to read or set", () => {
  const store = fixture();
  store.setModelLadder([{ provider_id: "p-1", model: "a" }]);
  store.db.run("UPDATE settings SET value = ? WHERE key = 'engine_level'", [String(ENGINE_LEVELS.jobs)]);
  expect(store.modelLadder()).toEqual([]);
  expect(() => store.setModelLadder([])).toThrow("engine level 7");
});

test("a rung goes when its endpoint stops listing its model or is deleted; the rest keep their order", async () => {
  const store = fixture();
  store.setModelLadder([{ provider_id: "p-1", model: "a" }, { provider_id: "p-2", model: "d" }, { provider_id: "p-1", model: "b" }, { provider_id: "p-1", model: "c" }]);
  store.patchProviderSync("p-1", { models: ["a", "c"] });
  expect(store.modelLadder()).toEqual([{ provider_id: "p-1", model: "a" }, { provider_id: "p-2", model: "d" }, { provider_id: "p-1", model: "c" }]);
  await store.deleteProvider("p-2");
  expect(store.modelLadder()).toEqual([{ provider_id: "p-1", model: "a" }, { provider_id: "p-1", model: "c" }]);
});
