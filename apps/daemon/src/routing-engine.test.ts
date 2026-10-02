/**
 * What a turn runs on from engine level 7 (ADR 0048): no model picks it — your pin, else the Bot's
 * default (inferred from its use, asked about once), else the endpoint's — and the reason is kept.
 */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { call, createScenario, endTurn, tool, type Scenario, type ToolOutcome } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const reasonOf = (h: Scenario, botId: string) => h.store.db.query<{ reason_code: string | null; model: string }, [string]>(
  "SELECT reason_code, model FROM turn_route_decisions WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(botId);

test("from level 7 no model picks a turn's model: the endpoint's default with nothing else to go on, then your pin", async () => {
  const h = await createScenario({ routing: true });
  open.push(h);
  const [writer] = h.createBots({ name: "Writer", duties: "write" });
  const dm = h.direct(writer!);
  h.script(writer!).reply(call(endTurn()));
  h.postUser(dm, "写一句开场白");
  await h.waitIdle();
  expect(reasonOf(h, writer!.id)).toEqual({ reason_code: "endpoint_default", model: "scenario" });
  expect(h.judgeCalls("route_pick")).toEqual([]);

  h.store.patchBot(writer!.id, { model: "scenario" });
  h.script(writer!).reply(call(endTurn()));
  h.postUser(dm, "再写一句");
  await h.waitIdle();
  expect(reasonOf(h, writer!.id)).toEqual({ reason_code: "pin", model: "scenario" });
  expect(h.judgeCalls("route_pick")).toEqual([]);
});

test("below level 7 the per-turn pick still runs and records no reason code", async () => {
  const h = await createScenario({ jobs: true });
  open.push(h);
  const [writer] = h.createBots({ name: "Writer", duties: "write" });
  const dm = h.direct(writer!);
  h.script(writer!).reply(call(endTurn()));
  h.postUser(dm, "写一句开场白");
  await h.waitIdle();
  expect(reasonOf(h, writer!.id)?.reason_code ?? null).toBeNull();
});

test("a Bot with a week of use runs on what it used most, and is asked once in its direct", async () => {
  const h = await createScenario({ routing: true });
  open.push(h);
  const [reviewer] = h.createBots({ name: "审片员", duties: "审片" });
  const dm = h.direct(reviewer!);
  for (let i = 0; i < 3; i += 1) {
    const trigger = h.store.insertMessage({ sessionId: dm, kind: "system", author: reviewer!.id, body: "工作" });
    const turn = h.store.createTurn({ sessionId: dm, botId: reviewer!.id, triggerMessageId: trigger.id });
    h.store.setTurnStatus(turn.id, "completed");
    const provider = h.store.db.query<{ id: string }, []>("SELECT id FROM providers LIMIT 1").get()!.id;
    h.store.db.run(`INSERT INTO turn_route_decisions (turn_id, session_id, bot_id, trigger_message_id, provider_id, model, thinking_level, signature, created_at)
      VALUES (?, ?, ?, ?, ?, 'scenario', 'high', 'general', ?)`, [turn.id, dm, reviewer!.id, trigger.id, provider, new Date(Date.now() - 86_400_000).toISOString()]);
  }
  h.script(reviewer!).reply(call(endTurn()));
  h.postUser(dm, "看一下第三镜");
  await h.waitIdle();
  expect(reasonOf(h, reviewer!.id)).toEqual({ reason_code: "default", model: "scenario" });
  const cards = h.messages(dm).filter((message) => message.control?.kind === "model_default");
  expect(cards).toHaveLength(1);
  expect(cards[0]!.control).toMatchObject({ model: "scenario", thinking_level: "high", offer: ["confirm", "decline"] });
  h.engine.control(cards[0]!.id, { action: "confirm" });
  expect(h.store.botDefault(reviewer!.id)).toMatchObject({ source: "confirmed" });
});

test("a pin no endpoint lists any more runs on the endpoint's default, says so once, and never gets a default inferred behind it", async () => {
  const h = await createScenario({ routing: true });
  open.push(h);
  const [writer] = h.createBots({ name: "Writer", duties: "write" });
  const dm = h.direct(writer!);
  h.store.db.run("UPDATE bots SET model = 'gone-model' WHERE id = ?", [writer!.id]);
  for (const body of ["写一句", "再写一句"]) {
    h.script(writer!).reply(call(endTurn()));
    h.postUser(dm, body);
    await h.waitIdle();
  }
  expect(reasonOf(h, writer!.id)).toEqual({ reason_code: "pin_unlisted", model: "scenario" });
  expect(h.messages(dm).filter((message) => message.body.includes("gone-model"))).toHaveLength(1);
  expect(h.messages(dm).filter((message) => message.control?.kind === "model_default")).toEqual([]);
});

test("a default's thinking level is matched to what the model offers now", async () => {
  const h = await createScenario({ routing: true });
  open.push(h);
  const [reviewer] = h.createBots({ name: "审片员", duties: "审片" });
  const dm = h.direct(reviewer!);
  const provider = h.store.db.query<{ id: string }, []>("SELECT id FROM providers LIMIT 1").get()!.id;
  h.store.db.run("UPDATE providers SET models = ? WHERE id = ?", [JSON.stringify([{ name: "scenario", price: null, thinking_levels: ["none", "high"], strengths: [] }]), provider]);
  h.store.db.run(`UPDATE bots SET default_provider_id = ?, default_model = 'scenario', default_thinking_level = 'max', default_source = 'confirmed' WHERE id = ?`, [provider, reviewer!.id]);
  h.script(reviewer!).reply(call(endTurn()));
  h.postUser(dm, "看一下第三镜");
  await h.waitIdle();
  const level = h.store.db.query<{ thinking_level: string }, [string]>("SELECT thinking_level FROM turn_route_decisions WHERE bot_id = ?").get(reviewer!.id)!.thinking_level;
  expect(["none", "high"]).toContain(level);
});

/** Two models on the scenario's endpoint: `scenario` marked as taking no pictures, `seer` as taking them. */
function twoModels(h: Scenario): string {
  const provider = h.store.db.query<{ id: string }, []>("SELECT id FROM providers LIMIT 1").get()!.id;
  h.store.db.run("UPDATE providers SET models = ? WHERE id = ?", [JSON.stringify([
    { name: "scenario", price: null, thinking_levels: ["none", "high"], strengths: [], input_image: false },
    { name: "seer", price: null, thinking_levels: ["none", "high"], strengths: [], input_image: true },
  ]), provider]);
  return provider;
}

test("a turn opened by a picture runs on a model that can see it; a pin that cannot is kept and you are told once", async () => {
  const h = await createScenario({ routing: true });
  open.push(h);
  twoModels(h);
  const [writer, pinned] = h.createBots({ name: "Writer", duties: "write" }, { name: "Pinned", duties: "write" });
  writeFileSync(join(h.root, "frame.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  for (const bot of [writer!, pinned!]) {
    const dm = h.direct(bot);
    if (bot === pinned) h.store.db.run("UPDATE bots SET model = 'scenario' WHERE id = ?", [bot.id]);
    h.script(bot).reply(call(endTurn()));
    const line = h.store.transaction(() => h.store.postMessage(dm, { body: "看看这一帧", paths: ["frame.png"] }));
    await h.engine.handleInboundMessage(line, { fromUser: true });
    await h.waitIdle();
  }
  expect(reasonOf(h, writer!.id)).toEqual({ reason_code: "capability_filter", model: "seer" });
  expect(reasonOf(h, pinned!.id)).toEqual({ reason_code: "pin", model: "scenario" });
  expect(h.messages(h.direct(pinned!)).filter((message) => message.body.includes("看不了图"))).toHaveLength(1);
});

test("a picture read mid-turn is not sent to a model marked as taking none; the Bot is told", async () => {
  const h = await createScenario({ routing: true });
  open.push(h);
  twoModels(h);
  const [writer] = h.createBots({ name: "Writer", duties: "write" });
  h.store.db.run("UPDATE bots SET model = 'scenario' WHERE id = ?", [writer!.id]);
  writeFileSync(join(h.root, "frame.png"), Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a40000000049454e44ae426082", "hex"));
  const results: ToolOutcome[] = [];
  h.script(writer!).reply(call(tool("read_file", { path: "frame.png" })), ({ results: got }) => {
    results.push(...got);
    return call(endTurn());
  });
  h.postUser(h.direct(writer!), "读一下 frame.png");
  await h.waitIdle();
  expect(results[0]!.content).toContain("看不了图");
});
