import { expect, test } from "bun:test";
import { Store } from "./store";
import { memoryKeyStore } from "./secrets";
import { createLocalApi } from "./local-api";
import { runCollabTool } from "./collab-tools";

const pricing = { input: 2, output: 8, cached_input: 0.5 };

test("provider API reads, validates and clears billing prices independently from routing price", async () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const api = createLocalApi({ store, token: "fixture", schedule: false });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch, websocket: api.websocket });
  const request = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}/v1${path}`, {
    method, headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const create = await request("POST", "/providers", { name: "Fixture", base_url: "https://unused.invalid", api_key: "fixture", models: [{ name: "m", price: 9, pricing }] });
    expect(create.status).toBe(201);
    const row = await create.json() as { id: string; model_catalog: unknown[] };
    expect(row.model_catalog[0]).toMatchObject({ price: 9, pricing });
    const response = await request("PATCH", `/providers/${row.id}`, { models: [{ name: "m", pricing: { input: 1 } }] });
    expect(response.status).toBe(422);
    expect((await store.getProvider(row.id)).model_catalog[0]?.pricing).toEqual(pricing);
    const clear = await request("PATCH", `/providers/${row.id}`, { models: [{ name: "m", price: 9 }] });
    expect(clear.status).toBe(200);
    expect((await store.getProvider(row.id)).model_catalog[0]).not.toHaveProperty("pricing");
  } finally {
    await api.engine.close();
    server.stop(true);
    store.close();
  }
});

test("Bot endpoint tools accept and clear billing prices without a new approval", async () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  try {
    const { bot, direct_session } = store.createBot({ name: "Billing", duties: "test", boundaries: "fixture" });
    const ctx = { store, botId: bot.id, sessionId: direct_session.id, turnId: "fixture-turn", parentId: null };
    const added = await runCollabTool({ ...ctx, approved: true, approvalApiKey: "fixture" }, "add_endpoint", {
      name: "Fixture", base_url: "https://unused.invalid", models: [{ name: "m", price: 9, pricing }],
    });
    expect(added.ok).toBe(true);
    const id = added.data!.id as string;
    expect((await store.getProvider(id)).model_catalog[0]?.pricing).toEqual(pricing);
    const update = await runCollabTool(ctx, "update_endpoint", { id, models: [{ name: "m", price: 9, pricing: { input: 3, output: 6 } }] });
    expect(update.ok).toBe(true);
    expect(update.waitApproval).toBeUndefined();
    expect((await store.getProvider(id)).model_catalog[0]?.pricing).toEqual({ input: 3, output: 6 });
    const clear = await runCollabTool(ctx, "update_endpoint", { id, models: ["m"] });
    expect(clear.ok).toBe(true);
    expect((await store.getProvider(id)).model_catalog[0]).not.toHaveProperty("pricing");
  } finally { store.close(); }
});
