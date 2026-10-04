import { afterEach, expect, test } from "bun:test";
import { isoNow } from "./ids";
import { createScenario, fileUnder, requestText, say, type Scenario } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const ITEM = "逐帧比对相邻两镜的首尾机位";

/**
 * ADR 0051: an approval you overturned is reflected on at the next tick by the reviewer, on its own
 * model; its proposal waits on your card, and once adopted the reviewer reads it in its situation.
 */
test("a review miss becomes the reviewer's checklist item only once you adopt it", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [director, reviewer] = h.createBots("视频导演", "审片员");
  const room = h.group("Studio", [director!, reviewer!]);
  const plan = h.store.openTask({ sessionId: room, title: "EP01" });
  const ticket = h.store.createTicket({ taskId: plan.id, title: "第七镜", worker: director!.id });
  h.store.db.run("UPDATE tickets SET reviewer_bot_id = ? WHERE id = ?", [reviewer!.id, ticket.id]);
  const now = isoNow();
  h.store.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id, part_keys, bot_id, model, turn_id, origin, artifacts, content, claims,
    note, state, reviews, created_at, updated_at) VALUES ('sub-1', NULL, ?, ?, '[]', ?, 'scenario', NULL, 'submit', '[]', NULL, '[]', '', 'approved', ?, ?, ?)`,
    [plan.id, ticket.id, director!.id, JSON.stringify([{ reviewer_bot_id: reviewer!.id, reviewer_model: "scenario", outcome: "approve", note: "画面完整", verdicts: [] }]), now, now]);
  const complaint = h.store.insertMessage({ sessionId: room, kind: "user", author: "user", body: "第七镜的机位和第六镜接不上" });
  h.store.recordWorkEvent({ kind: "review.miss", actor: "user", botId: reviewer!.id, taskId: plan.id, ticketId: ticket.id,
    payload: { submission_id: "sub-1", reviewer_bot_id: reviewer!.id, reviewer_model: "scenario", message_id: complaint.id, card_id: "card-1" } });

  h.judge("reflect").reply(JSON.stringify({ kind: "checklist", hook: "before_review", text: ITEM }));
  h.tick(new Date());
  await h.waitIdle();
  expect(h.judgeCalls("reflect")).toHaveLength(1);
  const cardId = h.store.db.query<{ id: string }, [string]>("SELECT id FROM messages WHERE session_id = ? AND json_extract(control, '$.kind') = 'lesson'").get(room)?.id;
  const card = cardId ? h.store.getMessage(cardId) : null;
  expect(card?.body).toContain(ITEM);
  // Not yet: a proposal holds nothing until you adopt it.
  expect(h.store.checklistFor(reviewer!.id, ["before_review"])).toEqual([]);
  h.engine.control(card!.id, { action: "confirm" });
  // A second tick reflects on nothing more.
  h.tick(new Date());
  await h.waitIdle();
  expect(h.judgeCalls("reflect")).toHaveLength(1);

  h.script(reviewer!, room).reply(say("我再看一遍"));
  h.judge("read_filing").reply(fileUnder("EP01", { ticket: "第七镜" }));
  h.postUser(room, "@审片员 再看看 EP01 第七镜");
  await h.waitIdle();
  const [hop] = h.hops(reviewer!);
  expect(requestText(hop!.request)).toContain(ITEM);
});

test("an adopted check proposal runs at once, as one you add on the board does", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [director, reviewer] = h.createBots("视频导演", "审片员");
  const room = h.group("Studio", [director!, reviewer!]);
  const plan = h.store.openTask({ sessionId: room, title: "EP01" });
  const ticket = h.store.createTicket({ taskId: plan.id, title: "第七镜", worker: director!.id });
  h.store.recordWorkEvent({ kind: "review.miss", actor: "user", botId: reviewer!.id, taskId: plan.id, ticketId: ticket.id,
    payload: { reviewer_bot_id: reviewer!.id, reviewer_model: "scenario", message_id: null, card_id: "card-1" } });
  h.judge("reflect").reply(JSON.stringify({ kind: "check", check_kind: "exists", item: "母带在", path: `${ticket.dir}/master.mp4` }));
  h.tick(new Date());
  await h.waitIdle();
  const cardId = h.store.db.query<{ id: string }, [string]>("SELECT id FROM messages WHERE session_id = ? AND json_extract(control, '$.kind') = 'lesson'").get(room)!.id;
  expect(h.store.getMessage(cardId).body).toContain(`文件 "${ticket.dir}/master.mp4" 存在`);
  h.engine.control(cardId, { action: "confirm" });
  await h.waitIdle();
  const runs = h.store.db.query<{ outcome: string | null }, [string]>(`SELECT r.outcome FROM acceptance_check_runs r JOIN acceptance_checks c ON c.id = r.check_id
    WHERE c.task_id = ? AND c.origin = 'reflection'`).all(plan.id);
  expect(runs).toEqual([{ outcome: "fail" }]);
});
