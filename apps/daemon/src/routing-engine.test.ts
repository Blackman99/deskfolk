/**
 * What a turn runs on from engine level 7 (ADR 0048): no model picks it — your pin, else the Bot's
 * default (inferred from its use, asked about once), else the endpoint's — and the reason is kept.
 */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { call, createScenario, endTurn, failed, fileUnder, tool, type Scenario, type ToolOutcome } from "./test-kit/scenario";
import { openPlan, planSpec } from "./scenarios/video-team";

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

/** A Bot on a ticket of EP01 in its direct, its model offering four thinking levels; your next line is filed under the ticket. */
function onTicket(h: Scenario) {
  const provider = h.store.db.query<{ id: string }, []>("SELECT id FROM providers LIMIT 1").get()!.id;
  h.store.db.run("UPDATE providers SET models = ? WHERE id = ?", [JSON.stringify([
    { name: "scenario", price: null, thinking_levels: ["none", "low", "medium", "high"], strengths: [] },
  ]), provider]);
  const [writer] = h.createBots({ name: "Writer", duties: "write" });
  const dm = h.direct(writer!);
  const plan = openPlan(h, dm, "EP01", planSpec("EP01 开场"));
  const ticket = h.store.createTicket({ taskId: plan.id, title: "开场白", status: "doing", worker: writer!.id });
  h.judge("organizer", { session: dm }).reply({ decision: "join", join_plan_id: plan.id, plan: planSpec("EP01 开场"), tickets: [], message_ticket: ticket.id });
  // Your lines here are read as about EP01 (ADR 0057).
  h.judge("read_filing").handle(fileUnder("EP01"));
  return { writer: writer!, dm };
}

const LEVELS = ["none", "low", "medium", "high"];
const stepsOf = (h: Scenario, botId: string) => h.hops(botId).map((hop) => LEVELS.indexOf(String(hop.request.thinkingLevel)));
const escalations = (h: Scenario) => h.store.db.query<{ reason: string; to: number }, []>(
  "SELECT json_extract(payload, '$.reason') AS reason, json_extract(payload, '$.to') AS \"to\" FROM work_events WHERE kind = 'model.escalated' ORDER BY seq").all();

test("tool arguments that are not JSON twice in a row step the job up for the rest of the turn, once", async () => {
  const h = await createScenario({ routing: true });
  open.push(h);
  const { writer, dm } = onTicket(h);
  h.script(writer, dm).reply(call({ name: "read_file", raw: "{\"path\": " }), call({ name: "read_file", raw: "[1]" }),
    call({ name: "read_file", raw: "still not" }), call({ name: "read_file", raw: "nor this" }), call(endTurn()));
  h.postUser(dm, "写一句开场白");
  await h.waitIdle();
  const steps = stepsOf(h, writer.id);
  expect(steps.length).toBe(5);
  expect(steps[0]).toBeLessThan(LEVELS.length - 1);
  // Two hops on its own level, then one up for every hop left: once per turn, however many more come.
  expect(steps).toEqual([steps[0]!, steps[0]!, steps[0]! + 1, steps[0]! + 1, steps[0]! + 1]);
  expect(escalations(h)).toEqual([{ reason: "malformed_tool_json", to: 1 }]);
  expect(h.store.db.query("SELECT thinking_level, reason_code, base_reason_code FROM turn_route_decisions WHERE bot_id = ?").get(writer.id))
    .toEqual({ thinking_level: LEVELS[steps[0]! + 1], reason_code: "escalation", base_reason_code: "endpoint_default" });
});

test("the same tool called wrongly three times in a row steps the job up; another tool in between starts again, a missing file counts for nothing", async () => {
  const h = await createScenario({ routing: true });
  open.push(h);
  const { writer, dm } = onTicket(h);
  const wrong = () => call(tool("read_file", {}));
  const missing = () => call(tool("read_file", { path: "missing.txt" }));
  h.script(writer, dm).reply(wrong(), wrong(), call(tool("list_files", { path: "." })), wrong(), missing(), missing(), missing(), wrong(), wrong(), call(endTurn()));
  h.postUser(dm, "读一下那几个文件");
  await h.waitIdle();
  const steps = stepsOf(h, writer.id);
  expect(steps.slice(0, 9)).toEqual(Array(9).fill(steps[0]));
  expect(steps[9]).toBe(steps[0]! + 1);
  expect(escalations(h)).toEqual([{ reason: "tool_failures", to: 1 }]);
});

test("a thinking level you pinned is not moved by trouble inside the turn, and nothing is stepped", async () => {
  const h = await createScenario({ routing: true });
  open.push(h);
  const { writer, dm } = onTicket(h);
  h.store.patchBot(writer.id, { model: "scenario", thinking_level: "low" });
  h.script(writer, dm).reply(call({ name: "read_file", raw: "{" }), call({ name: "read_file", raw: "{" }), call(endTurn()));
  h.postUser(dm, "写一句开场白");
  await h.waitIdle();
  expect(stepsOf(h, writer.id)).toEqual([1, 1, 1]);
  expect(escalations(h)).toEqual([]);
});

test("a reply that fails again after its retry steps the job up for its next turn", async () => {
  const h = await createScenario({ routing: true });
  open.push(h);
  const { writer, dm } = onTicket(h);
  h.script(writer, dm).reply(failed("repeat"), failed("repeat"));
  h.postUser(dm, "写一句开场白");
  await h.waitIdle();
  const first = stepsOf(h, writer.id);
  expect(escalations(h)).toEqual([{ reason: "failure_shape", to: 1 }]);
  h.judge("organizer", { session: dm }).reply({ decision: "continue", plan: planSpec("EP01 开场"), tickets: [],
    message_ticket: h.store.db.query<{ id: string }, []>("SELECT id FROM tickets LIMIT 1").get()!.id });
  h.script(writer, dm).reply(call(endTurn()));
  h.postUser(dm, "再来一次");
  await h.waitIdle();
  expect(stepsOf(h, writer.id).at(-1)).toBe(first[0]! + 1);
});
