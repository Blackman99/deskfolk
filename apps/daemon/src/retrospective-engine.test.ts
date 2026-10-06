import { afterEach, expect, test } from "bun:test";
import { createScenario, type Scenario } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * ADR 0062: a plan you sent back once and then accepted is looked back on at a tick, half an hour
 * after its delivery, by the Bot that made it, on its own model; what it concludes lands in its own
 * memories and skills without a card, and the plan's board shows it.
 */
test("a delivered plan is looked back on by the Bot that made it; its conclusions land in its memories and skills", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [director, writer] = h.createBots("视频导演", "编剧");
  const room = h.group("Studio", [director!, writer!]);
  const plan = h.store.openTask({ sessionId: room, title: "选举篇短片" });
  const ticket = h.store.createTicket({ taskId: plan.id, title: "选举篇治愈小杰短片", worker: director!.id });
  const skill = h.store.createSkill({ bot_id: director!.id, name: "关键帧出片", description: "做短片时用", body: "1. 先算账\n2. 出关键帧" });
  const hand = (id: string, state: string, at: string) => h.store.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id, part_keys, bot_id,
    model, turn_id, origin, artifacts, content, claims, note, state, reviews, created_at, updated_at)
    VALUES (?, NULL, ?, ?, '[]', ?, 'scenario', NULL, 'submit', '[]', NULL, '[]', '', ?, '[]', ?, ?)`, [id, plan.id, ticket.id, director!.id, state, at, at]);
  hand("sub-1", "rejected", ago(120));
  h.store.recordWorkEvent({ kind: "review.recorded", actor: "user", taskId: plan.id, ticketId: ticket.id,
    payload: { submission_id: "sub-1", outcome: "reject", by: "user", note: "动画不是真人" } });
  hand("sub-2", "approved", ago(90));
  h.store.db.run("UPDATE quality_events SET created_at = ?", [ago(110)]);
  h.store.db.run("UPDATE tasks SET stage = 'delivered', delivered_at = ?, status = 'done' WHERE id = ?", [ago(31), plan.id]);

  const committed: import("@real-bot/protocol").ClientEvent[] = [];
  h.store.onCommit((event) => committed.push(event));
  let read: Record<string, unknown> | null = null;
  h.judge("retrospect").reply(({ payload }) => {
    read = payload as Record<string, unknown>;
    return JSON.stringify({
      summary: "改编动漫先定画风",
      pitfalls: ["默认做成了真人风格"],
      rework_causes: ["开工前没确认画风"],
      keep: ["开工前先确认画风"],
      earlier: [],
      memory: [{ op: "remember", subject: "改编片画风", body: "改编动漫默认做成动画，不做真人。", replaces: [], why: "第一版被退回" }],
      skills: [{ op: "edit", name: "关键帧出片", edits: [{ old: "1. 先算账", new: "1. 先定画风，再算账" }], why: "画风返工" }],
    });
  });
  h.tick(new Date());
  await h.waitIdle();
  expect(h.judgeCalls("retrospect")).toHaveLength(1);
  // It read the job's record — your send-back in your words — and its own skill.
  expect(read!.you).toBe("视频导演");
  expect(JSON.stringify(read!.hand_overs)).toContain("动画不是真人");
  expect(JSON.stringify(read!.skills)).toContain("1. 先算账");

  expect(h.store.listMemories(director!.id).map((memory) => memory.body)).toEqual(["改编动漫默认做成动画，不做真人。"]);
  expect(h.store.getSkill(skill.id).body).toBe("1. 先定画风，再算账\n2. 出关键帧");
  const [retrospective] = h.store.taskDetail(plan.id, () => true).retrospectives ?? [];
  expect(retrospective).toMatchObject({ state: "done", bot_id: director!.id, summary: "改编动漫先定画风", rework_causes: ["开工前没确认画风"] });
  expect(retrospective!.changes.map((change) => [change.kind, change.op, change.status])).toEqual([["memory", "remember", "applied"], ["skill", "edit", "applied"]]);
  // Billed apart, and nothing posted in the conversation or asked of you.
  expect(h.store.db.query("SELECT kind, purpose, bot_id FROM spend WHERE purpose = 'retrospect'").all()).toEqual([{ kind: "organize", purpose: "retrospect", bot_id: director!.id }]);
  expect(h.messages(room).filter((message) => message.kind !== "user")).toEqual([]);
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
  // The board and the profile hear of it, from the store's own change journal.
  expect(committed.some((event) => event.event === "task.upsert" && event.id === plan.id && (event.retrospectives ?? []).some((row) => row.state === "done"))).toBe(true);
  expect(committed.some((event) => event.event === "memory.upsert" && event.retrospective?.id === retrospective!.id)).toBe(true);
  expect(committed.some((event) => event.event === "skill.upsert" && event.id === skill.id && event.retrospective?.id === retrospective!.id)).toBe(true);
  // A second tick looks back on nothing more.
  h.tick(new Date());
  await h.waitIdle();
  expect(h.judgeCalls("retrospect")).toHaveLength(1);
});

test("an answer cut off mid-way writes nothing, and the retrospective says it failed", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [director, writer] = h.createBots("视频导演", "编剧");
  const room = h.group("Studio", [director!, writer!]);
  const plan = h.store.openTask({ sessionId: room, title: "选举篇短片" });
  const ticket = h.store.createTicket({ taskId: plan.id, title: "短片", worker: director!.id });
  for (const id of ["sub-1", "sub-2"]) {
    h.store.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id, part_keys, bot_id, model, turn_id, origin, artifacts, content, claims, note,
      state, reviews, created_at, updated_at) VALUES (?, NULL, ?, ?, '[]', ?, 'scenario', NULL, 'submit', '[]', NULL, '[]', '', 'approved', '[]', ?, ?)`,
      [id, plan.id, ticket.id, director!.id, ago(100), ago(100)]);
  }
  h.store.db.run("UPDATE tasks SET stage = 'delivered', delivered_at = ?, status = 'done' WHERE id = ?", [ago(45), plan.id]);
  h.judge("retrospect").reply({ ok: true, content: '{"summary":"x","memory":[{"op":"remember","subject":"a","body":"b"}', toolCalls: [], finishReason: "length",
    hadChoices: true, usage: null, missingReason: null, hadToolCalls: false, failKind: "incomplete" });
  h.tick(new Date());
  await h.waitIdle();
  expect(h.judgeCalls("retrospect")).toHaveLength(1);
  expect(h.store.listMemories(director!.id)).toEqual([]);
  expect(h.store.taskDetail(plan.id, () => true).retrospectives).toEqual([expect.objectContaining({ state: "failed", note: "truncated", changes: [] })]);
});
