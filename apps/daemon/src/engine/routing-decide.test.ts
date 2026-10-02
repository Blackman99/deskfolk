import { afterEach, expect, test } from "bun:test";
import { Store } from "../store";
import { ENGINE_LEVELS } from "../store/schema-gate";
import { createRouting } from "./routing";
import type { Creds } from "./types";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(models: Array<Record<string, unknown>>, opts: { picture?: boolean; other?: Array<Record<string, unknown>> } = {}) {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(ENGINE_LEVELS.routing)]);
  const bot = store.createBot({ name: "Maker", duties: "make", boundaries: "none" });
  store.db.run(`INSERT INTO providers (id, name, base_url, models, available_models, default_model, created_at, updated_at)
    VALUES ('p-1', 'P', 'http://x', ?, '[]', ?, '2026-01-01', '2026-01-01')`, [JSON.stringify(models), models[0]!.name as string]);
  const plan = store.openTask({ sessionId: bot.direct_session.id, title: "EP01" });
  const ticket = store.createTicket({ taskId: plan.id, title: "母带", worker: bot.bot.id });
  if (opts.other) {
    store.db.run(`INSERT INTO providers (id, name, base_url, models, available_models, default_model, created_at, updated_at)
      VALUES ('p-2', 'Q', 'http://y', ?, '[]', ?, '2026-01-01', '2026-01-01')`, [JSON.stringify(opts.other), opts.other[0]!.name as string]);
  }
  const trigger = store.insertMessage({ sessionId: bot.direct_session.id, kind: "system", author: bot.bot.id, body: "工作", ...(opts.picture ? { paths: ["frame.png"] } : {}) });
  const turn = store.createTurn({ sessionId: bot.direct_session.id, botId: bot.bot.id, triggerMessageId: trigger.id, taskId: plan.id, ticketId: ticket.id });
  const routing = createRouting({ store, completions: {} as never, recordResponseSpend: () => null, spendOwner: () => ({ sessionId: "", sessionName: null, botId: null, botName: null }) as never });
  const creds: Creds = { locale: "zh", defaultProviderId: "p-1", providers: [{ id: "p-1", name: "P", baseUrl: "http://x", apiKey: "k", models: models.map((m) => m.name as string), defaultModel: models[0]!.name as string },
    ...(opts.other ? [{ id: "p-2", name: "Q", baseUrl: "http://y", apiKey: "k", models: opts.other.map((m) => m.name as string), defaultModel: opts.other[0]!.name as string }] : [])] };
  return { store, bot: bot.bot, turn, routing, creds, dm: bot.direct_session.id };
}

test("an escalated job runs a thinking level higher per step, up to the model's top, and you are told once at the top", () => {
  const f = fixture([{ name: "m", price: null, thinking_levels: ["none", "low", "high"], strengths: [] }]);
  f.store.db.run("UPDATE bots SET default_provider_id = 'p-1', default_model = 'm', default_thinking_level = 'low', default_source = 'confirmed' WHERE id = ?", [f.bot.id]);
  const decide = () => f.routing.decideRoute(f.bot.id, f.creds, "继续剪", f.turn.id)!.decision;
  expect(decide()).toMatchObject({ thinkingLevel: "low", reasonCode: "default" });
  f.store.db.run("UPDATE work_items SET escalation = 1 WHERE id = ?", [f.turn.work_item_id!]);
  expect(decide()).toMatchObject({ thinkingLevel: "high", reasonCode: "escalation" });
  f.store.db.run("UPDATE work_items SET escalation = 2 WHERE id = ?", [f.turn.work_item_id!]);
  expect(decide()).toMatchObject({ thinkingLevel: "high", reasonCode: "escalation" });
  f.store.db.run("UPDATE bots SET default_thinking_level = 'high' WHERE id = ?", [f.bot.id]);
  decide();
  decide();
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM work_events WHERE kind = 'model.escalation_top'").get()).toEqual({ n: 1 });
});

test("a pinned thinking level is never escalated, and a model measured to gain nothing from it is not either", () => {
  const f = fixture([{ name: "m", price: null, thinking_levels: ["none", "low", "high"], strengths: [], reasoning_effective: false }]);
  f.store.db.run("UPDATE work_items SET escalation = 1 WHERE id = ?", [f.turn.work_item_id!]);
  f.store.db.run("UPDATE bots SET model = 'm', thinking_level = 'low' WHERE id = ?", [f.bot.id]);
  expect(f.routing.decideRoute(f.bot.id, f.creds, "继续", f.turn.id)!.decision).toMatchObject({ thinkingLevel: "low", reasonCode: "pin" });
  f.store.db.run("UPDATE bots SET model = NULL, thinking_level = NULL, default_provider_id = 'p-1', default_model = 'm', default_thinking_level = 'low', default_source = 'confirmed' WHERE id = ?", [f.bot.id]);
  expect(f.routing.decideRoute(f.bot.id, f.creds, "继续", f.turn.id)!.decision).toMatchObject({ thinkingLevel: "low", reasonCode: "default" });
});

const noted = (f: ReturnType<typeof fixture>) => f.store.db.query<{ kind: string }, []>("SELECT kind FROM work_events WHERE kind LIKE 'model.%' ORDER BY seq").all().map((row) => row.kind);

test("a pinned model that cannot see pictures stays pinned on a picture turn, stepped up or not", () => {
  const f = fixture([{ name: "blind", price: null, thinking_levels: ["low", "high"], strengths: [], input_image: false },
    { name: "eyes", price: null, thinking_levels: ["low", "high"], strengths: [], input_image: true }], { picture: true });
  f.store.db.run("UPDATE bots SET model = 'blind' WHERE id = ?", [f.bot.id]);
  expect(f.routing.decideRoute(f.bot.id, f.creds, "看图", f.turn.id)!.decision).toMatchObject({ model: "blind", reasonCode: "pin" });
  f.store.db.run("UPDATE work_items SET escalation = 1 WHERE id = ?", [f.turn.work_item_id!]);
  expect(f.routing.decideRoute(f.bot.id, f.creds, "看图", f.turn.id)!.decision).toMatchObject({ model: "blind", thinkingLevel: "high" });
  expect(noted(f)).toEqual(["model.pin_no_pictures"]);
});

test("a Bot pinned to an endpoint only looks for a picture-taking model there, not on another endpoint", () => {
  const f = fixture([{ name: "a", price: null, thinking_levels: ["low"], strengths: [], input_image: false }], { picture: true,
    other: [{ name: "b", price: null, thinking_levels: ["low"], strengths: [], input_image: true }] });
  f.store.db.run("UPDATE bots SET provider_id = 'p-1' WHERE id = ?", [f.bot.id]);
  expect(f.routing.decideRoute(f.bot.id, f.creds, "看图", f.turn.id)!.decision).toMatchObject({ providerId: "p-1", model: "a" });
  expect(noted(f)).toContain("model.no_picture_model");
  f.store.db.run("UPDATE bots SET provider_id = NULL WHERE id = ?", [f.bot.id]);
  expect(f.routing.decideRoute(f.bot.id, f.creds, "看图", f.turn.id)!.decision).toMatchObject({ providerId: "p-2", model: "b", reasonCode: "capability_filter" });
});

test("a model you set on the ticket comes before the Bot's pin, stays on a picture turn, and must be one an endpoint lists", () => {
  const f = fixture([{ name: "blind", price: null, thinking_levels: ["low", "high"], strengths: [], input_image: false },
    { name: "eyes", price: null, thinking_levels: ["low", "high"], strengths: [], input_image: true }], { picture: true });
  f.store.db.run("UPDATE bots SET model = 'eyes' WHERE id = ?", [f.bot.id]);
  const ticketId = f.store.getTurn(f.turn.id).ticket_id!;
  expect(() => f.store.patchTicketByUser(ticketId, { modelOverride: { provider_id: "p-1", model: "nowhere" } })).toThrow("names no model");
  f.store.patchTicketByUser(ticketId, { modelOverride: { provider_id: "p-1", model: "blind" } });
  expect(f.store.getTicket(ticketId).model_override).toEqual({ provider_id: "p-1", model: "blind" });
  expect(f.routing.decideRoute(f.bot.id, f.creds, "看图", f.turn.id)!.decision).toMatchObject({ model: "blind", reasonCode: "ticket_override" });
  expect(noted(f)).toEqual(["model.ticket_override_no_pictures"]);
  f.store.patchTicketByUser(ticketId, { modelOverride: null });
  expect(f.routing.decideRoute(f.bot.id, f.creds, "看图", f.turn.id)!.decision).toMatchObject({ model: "eyes", reasonCode: "pin" });
  f.store.db.run("UPDATE settings SET value = '6' WHERE key = 'engine_level'");
  expect(() => f.store.patchTicketByUser(ticketId, { modelOverride: { provider_id: "p-1", model: "blind" } })).toThrow("engine level 7");
});

test("whoever reviews the ticket keeps its own model, and a model no endpoint lists any more is told once and cleared with its endpoint", async () => {
  const f = fixture([{ name: "a", price: null, thinking_levels: ["low"], strengths: [] }, { name: "b", price: null, thinking_levels: ["low"], strengths: [] }],
    { other: [{ name: "c", price: null, thinking_levels: ["low"], strengths: [] }] });
  const ticketId = f.store.getTurn(f.turn.id).ticket_id!;
  const reviewer = f.store.createBot({ name: "Checker", duties: "check", boundaries: "none" });
  f.store.db.run("UPDATE bots SET model = 'b' WHERE id = ?", [reviewer.bot.id]);
  f.store.patchTicketByUser(ticketId, { reviewerBotId: reviewer.bot.id, modelOverride: { provider_id: "p-2", model: "c" } });
  const trigger = f.store.insertMessage({ sessionId: reviewer.direct_session.id, kind: "system", author: reviewer.bot.id, body: "审" });
  const review = f.store.createTurn({ sessionId: reviewer.direct_session.id, botId: reviewer.bot.id, triggerMessageId: trigger.id, taskId: f.store.getTicket(ticketId).task_id, ticketId });
  expect(f.routing.decideRoute(f.bot.id, f.creds, "做", f.turn.id)!.decision).toMatchObject({ model: "c", reasonCode: "ticket_override" });
  expect(f.routing.decideRoute(reviewer.bot.id, f.creds, "审", review.id)!.decision).toMatchObject({ model: "b", reasonCode: "pin" });
  // Before anyone owns it: any turn on it but its reviewer's.
  f.store.db.run("UPDATE tickets SET owner_bot_id = NULL, worker = NULL WHERE id = ?", [ticketId]);
  expect(f.routing.decideRoute(f.bot.id, f.creds, "做", f.turn.id)!.decision).toMatchObject({ model: "c", reasonCode: "ticket_override" });
  expect(f.routing.decideRoute(reviewer.bot.id, f.creds, "审", review.id)!.decision).toMatchObject({ model: "b", reasonCode: "pin" });
  f.store.db.run("UPDATE tickets SET owner_bot_id = ?, worker = ? WHERE id = ?", [f.bot.id, f.bot.id, ticketId]);
  // Listed no more: the Bot's own model meanwhile, told once.
  const unlisted = { ...f.creds, providers: f.creds.providers.filter((provider) => provider.id === "p-1") };
  expect(f.routing.decideRoute(f.bot.id, unlisted, "做", f.turn.id)!.decision.reasonCode).not.toBe("ticket_override");
  f.routing.decideRoute(f.bot.id, unlisted, "做", f.turn.id);
  expect(noted(f)).toEqual(["model.ticket_override_unlisted"]);
  // The endpoint's list no longer naming it, or the endpoint going, clears it.
  f.store.patchTicketByUser(ticketId, { modelOverride: { provider_id: "p-1", model: "a" } });
  f.store.patchProviderSync("p-1", { models: ["b"] });
  expect(f.store.getTicket(ticketId).model_override).toBeNull();
  f.store.patchTicketByUser(ticketId, { modelOverride: { provider_id: "p-2", model: "c" } });
  await f.store.deleteProvider("p-2");
  expect(f.store.getTicket(ticketId).model_override).toBeNull();
});
