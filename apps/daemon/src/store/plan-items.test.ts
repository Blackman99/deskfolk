import { afterEach, expect, test } from "bun:test";
import { Store } from ".";
import { ENGINE_LEVELS } from "./schema-gate";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(level: number = ENGINE_LEVELS.submissions) {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(level)]);
  const lead = store.createBot({ name: "视频导演", duties: "统筹", boundaries: "none" }).bot;
  const maker = store.createBot({ name: "动画师", duties: "出片", boundaries: "none" }).bot;
  const reviewer = store.createBot({ name: "审片员", duties: "审片", boundaries: "none" }).bot;
  const outsider = store.createBot({ name: "路人", duties: "无", boundaries: "none" }).bot;
  const room = store.createGroup({ name: "Studio", members: [lead.id, maker.id, reviewer.id] });
  const plan = store.openTask({ sessionId: room.id, title: "EP01" });
  store.db.run("UPDATE tasks SET lead_bot_id = ? WHERE id = ?", [lead.id, plan.id]);
  // Each its own turn, the one before it over (one live turn per Bot and plan).
  const turnOf = (botId: string) => {
    for (const live of store.listLiveTurns().filter((turn) => turn.bot_id === botId)) store.setTurnStatus(live.id, "completed");
    const trigger = store.insertMessage({ sessionId: room.id, kind: "system", author: botId, body: "工作" });
    return store.createTurn({ sessionId: room.id, botId, triggerMessageId: trigger.id, taskId: plan.id }).id;
  };
  return { store, lead, maker, reviewer, outsider, room, plan, turnOf };
}

const parts = (store: Store, ticketId: string) =>
  store.db.query<{ key: string; title: string; declared_by: string }, [string]>("SELECT key, title, declared_by FROM ticket_parts WHERE ticket_id = ? ORDER BY key").all(ticketId);

test("the lead lays the plan out in one call: owners, a reviewer, what waits for what, and parts", () => {
  const f = fixture();
  const result = f.store.planItems({ turnId: f.turnOf(f.lead.id), items: [
    { title: "分镜", owner: "视频导演" },
    { title: "动画", owner: "动画师", reviewer: "审片员", depends_on: ["分镜"], parts: ["Shot 01", "C02", "第三镜", "片尾"] },
  ] });
  expect(result.tickets.map((row) => [row.title, row.created, row.seq])).toEqual([["分镜", true, 1], ["动画", true, 2]]);
  const [storyboard, animation] = result.tickets;
  expect(animation).toMatchObject({ owner: f.maker.id, reviewer: f.reviewer.id, depends_on: [storyboard!.ticket_id], parts: ["shot_01", "shot_02", "shot_03", "片尾"] });
  expect(parts(f.store, animation!.ticket_id)).toEqual([
    { key: "shot_01", title: "Shot 01", declared_by: "plan_items" },
    { key: "shot_02", title: "Shot 02", declared_by: "plan_items" },
    { key: "shot_03", title: "Shot 03", declared_by: "plan_items" },
    { key: "片尾", title: "片尾", declared_by: "plan_items" },
  ]);
  expect(f.store.listWorkEvents({ kind: "plan.items" })).toHaveLength(1);
});

test("a title the plan already has is that ticket: updated, never opened twice; numbers name tickets too", () => {
  const f = fixture();
  const turn = f.turnOf(f.lead.id);
  const first = f.store.planItems({ turnId: turn, items: [{ title: "分镜", owner: "视频导演" }, { title: "动画", owner: "动画师", parts: ["1"] }] });
  const again = f.store.planItems({ turnId: turn, items: [{ title: "动画", owner: "动画师", reviewer: "审片员", depends_on: ["#01"], parts: ["2"] }] });
  expect(again.tickets).toMatchObject([{ ticket_id: first.tickets[1]!.ticket_id, created: false, reviewer: f.reviewer.id, depends_on: [first.tickets[0]!.ticket_id] }]);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM tickets WHERE task_id = ?").get(f.plan.id)).toEqual({ n: 2 });
  expect(parts(f.store, first.tickets[1]!.ticket_id).map((row) => row.key)).toEqual(["shot_01", "shot_02"]);
});

test("only the lead may, owners and reviewers are Bots here, and a call with one bad item changes nothing", () => {
  const f = fixture();
  expect(() => f.store.planItems({ turnId: f.turnOf(f.maker.id), items: [{ title: "动画", owner: "动画师" }] })).toThrow("only the plan's lead");
  const turn = f.turnOf(f.lead.id);
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "动画", owner: "路人" }] })).toThrow("not a Bot in this plan's conversation");
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "动画", owner: "动画师", reviewer: "动画师" }] })).toThrow("reviewer cannot be its owner");
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "甲", owner: "动画师", depends_on: ["乙"] }, { title: "乙", owner: "动画师", depends_on: ["甲"] }] }))
    .toThrow("wait for each other");
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "甲", owner: "动画师", depends_on: ["不存在"] }] })).toThrow("names no ticket");
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM tickets WHERE task_id = ?").get(f.plan.id)).toEqual({ n: 0 });
  const low = fixture(ENGINE_LEVELS.supervision);
  expect(() => low.store.planItems({ turnId: low.turnOf(low.lead.id), items: [{ title: "动画", owner: "动画师" }] })).toThrow("engine level 5");
});

test("laying a ticket out again only fills in: your reviewer, owner and dependencies stay, and what was asked but kept says so", () => {
  const f = fixture();
  const turn = f.turnOf(f.lead.id);
  const [storyboard, animation] = f.store.planItems({ turnId: turn, items: [{ title: "分镜", owner: "视频导演" }, { title: "动画", owner: "动画师", parts: ["1"] }] }).tickets;
  f.store.patchTicketByUser(animation!.ticket_id, { reviewerBotId: f.reviewer.id, dependsOn: [storyboard!.ticket_id] });
  const again = f.store.planItems({ turnId: turn, items: [{ title: "动画", owner: "审片员", reviewer: "视频导演", parts: ["2"] }] }).tickets[0]!;
  expect(again).toMatchObject({ owner: f.maker.id, reviewer: f.reviewer.id, depends_on: [storyboard!.ticket_id], kept: ["owner", "reviewer"] });
  // Left out, nothing is cleared.
  const bare = f.store.planItems({ turnId: turn, items: [{ title: "动画" }] }).tickets[0]!;
  expect(bare).toMatchObject({ owner: f.maker.id, reviewer: f.reviewer.id, depends_on: [storyboard!.ticket_id] });
  expect(bare.kept).toBeUndefined();
  expect(parts(f.store, animation!.ticket_id).map((row) => row.key)).toEqual(["shot_01", "shot_02"]);
});

test("a ticket that is done, parked or approved is not laid out again, and two parts one number would merge are refused", () => {
  const f = fixture();
  const turn = f.turnOf(f.lead.id);
  const [done] = f.store.planItems({ turnId: turn, items: [{ title: "分镜", owner: "视频导演" }] }).tickets;
  f.store.db.run("UPDATE tickets SET status = 'done' WHERE id = ?", [done!.ticket_id]);
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "分镜", parts: ["1"] }] })).toThrow("reopens it on the board");
  f.store.db.run("UPDATE tickets SET status = 'doing' WHERE id = ?", [done!.ticket_id]);
  f.store.db.run("UPDATE tickets SET stage = 'approved' WHERE id = ?", [done!.ticket_id]);
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "分镜", parts: ["1"] }] })).toThrow("is approved");
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "动画", owner: "动画师", parts: ["Scene 1 Shot 5", "C05"] }] })).toThrow("are both shot_05");
  expect(f.store.planItems({ turnId: turn, items: [{ title: "动画", owner: "动画师", parts: ["C05", "C05"] }] }).tickets[0]!.parts).toEqual(["shot_05"]);
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "字幕" }] })).toThrow("new ticket needs an owner");
});

test("the lead is one that does not shift: stored, confirmed for the group, or the Bot of a direct — never whoever ran most", () => {
  const f = fixture();
  f.store.db.run("UPDATE tasks SET lead_bot_id = NULL WHERE id = ?", [f.plan.id]);
  for (let i = 0; i < 3; i += 1) f.turnOf(f.maker.id);
  expect(() => f.store.planItems({ turnId: f.turnOf(f.maker.id), items: [{ title: "动画", owner: "动画师" }] })).toThrow("no confirmed lead");
  f.store.db.run("UPDATE session_participants SET is_lead = 1 WHERE session_id = ? AND member = ?", [f.room.id, f.reviewer.id]);
  expect(() => f.store.planItems({ turnId: f.turnOf(f.maker.id), items: [{ title: "动画", owner: "动画师" }] })).toThrow("only the plan's lead");
  expect(f.store.planItems({ turnId: f.turnOf(f.reviewer.id), items: [{ title: "动画", owner: "动画师" }] }).tickets).toHaveLength(1);
  const solo = f.store.createBot({ name: "独行", duties: "做", boundaries: "none" });
  const plan = f.store.openTask({ sessionId: solo.direct_session.id, title: "私活" });
  const trigger = f.store.insertMessage({ sessionId: solo.direct_session.id, kind: "system", author: solo.bot.id, body: "工作" });
  const turn = f.store.createTurn({ sessionId: solo.direct_session.id, botId: solo.bot.id, triggerMessageId: trigger.id, taskId: plan.id }).id;
  expect(f.store.planItems({ turnId: turn, items: [{ title: "初稿", owner: "独行" }] }).tickets).toMatchObject([{ owner: solo.bot.id, created: true }]);
});

test("a ticket cannot be handed to its own reviewer in one change", () => {
  const f = fixture();
  const [ticket] = f.store.planItems({ turnId: f.turnOf(f.lead.id), items: [{ title: "动画", owner: "动画师" }] }).tickets;
  expect(() => f.store.patchTicketByUser(ticket!.ticket_id, { worker: f.reviewer.id, reviewerBotId: f.reviewer.id })).toThrow("reviewer cannot be its owner");
});

test("an owner is never made the reviewer, from either side; a parked ticket is not waited for; a review on its way keeps its reviewer", () => {
  const f = fixture();
  const turn = f.turnOf(f.lead.id);
  const [old, , free] = f.store.planItems({ turnId: turn, items: [{ title: "旧稿", owner: "视频导演" }, { title: "动画", owner: "动画师" }, { title: "无主", owner: "动画师" }] }).tickets;
  // The board: making the reviewer the owner is refused, whichever field moves.
  f.store.patchTicketByUser(free!.ticket_id, { reviewerBotId: f.reviewer.id });
  expect(() => f.store.patchTicketByUser(free!.ticket_id, { worker: f.reviewer.id })).toThrow("reviewer cannot be its owner");
  // plan_items filling an empty owner with the ticket's reviewer: refused too.
  f.store.db.run("UPDATE tickets SET worker = NULL, owner_bot_id = NULL WHERE id = ?", [free!.ticket_id]);
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "无主", owner: "审片员" }] })).toThrow("reviewer cannot be its owner");
  // A parked ticket is not a dependency to add, and one that becomes parked holds nothing up.
  f.store.db.run("UPDATE tickets SET status = 'parked' WHERE id = ?", [old!.ticket_id]);
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "动画", depends_on: ["旧稿"] }] })).toThrow("parked");
  // A hand-over on its way to review: the reviewer stays as it is, and the answer says so.
  const animation = f.store.listTickets(f.plan.id).find((ticket) => ticket.title === "动画")!;
  f.store.db.run(`INSERT INTO submissions (id, work_item_id, task_id, ticket_id, part_keys, bot_id, model, turn_id, origin, artifacts, content, claims, note, state, created_at, updated_at)
    VALUES ('sub-r', NULL, ?, ?, '[]', ?, NULL, NULL, 'submit', '[]', NULL, '[]', '', 'in_review', '2026-10-03', '2026-10-03')`, [f.plan.id, animation.id, f.maker.id]);
  expect(f.store.planItems({ turnId: turn, items: [{ title: "动画", reviewer: "审片员" }] }).tickets[0]).toMatchObject({ reviewer: null, kept: ["reviewer"] });
});

/** The ticket the job opened with, named as the job, and worked on: a file handed over under it. */
function touchedOpening(f: ReturnType<typeof fixture>) {
  const opening = f.store.createTicket({ taskId: f.plan.id, title: "EP01", worker: f.lead.id });
  f.store.recordWorkEvent({ kind: "plan.opened", actor: f.lead.id, taskId: f.plan.id, ticketId: opening.id, payload: {} });
  const turn = f.turnOf(f.lead.id);
  f.store.db.run("UPDATE turns SET ticket_id = ? WHERE id = ?", [opening.id, turn]);
  f.store.insertMessage({ sessionId: f.room.id, turnId: turn, kind: "bot", author: f.lead.id, body: "先试了一版", paths: [`${opening.dir}/try.mp4`] });
  f.store.db.run("UPDATE messages SET ticket_id = ? WHERE turn_id = ?", [opening.id, turn]);
  f.store.setTurnStatus(turn, "completed");
  return opening;
}

test("the opening ticket, worked on, is folded into the job by a layout — not by a single ticket added beside it, nor while a hand-over waits on it", () => {
  // IG MV: ticket 01, named as the whole job, held the first 2D attempt's 42 files and stood 待做 for good.
  const f = fixture();
  const opening = touchedOpening(f);
  const one = f.store.planItems({ turnId: f.turnOf(f.lead.id), items: [{ title: "配乐", owner: "视频导演" }] });
  expect(one.folded).toBeUndefined();
  expect(f.store.getTicket(opening.id).status).toBe("todo");
  const laid = f.store.planItems({ turnId: f.turnOf(f.lead.id), items: [{ title: "分镜", owner: "视频导演" }, { title: "动画", owner: "动画师" }] });
  expect(laid.folded).toBe(opening.id);
  expect(f.store.getTicket(opening.id)).toMatchObject({ status: "parked", stage: "dropped", dropped_why: "并入整件事（开头那张，拆分里没有它）" });
  expect(f.store.listWorkEvents({ kind: "ticket.folded" }).at(-1)!.payload).toMatchObject({ touched: true });

  // With a hand-over of it waiting on review: left, and the lead is told why.
  const g = fixture();
  const kept = touchedOpening(g);
  g.store.db.run(`INSERT INTO submissions (id, task_id, ticket_id, bot_id, origin, artifacts, state, created_at, updated_at)
    VALUES ('s-open', ?, ?, ?, 'submit', '[]', 'submitted', ?, ?)`, [g.plan.id, kept.id, g.lead.id, "2026-10-09T00:00:00.000Z", "2026-10-09T00:00:00.000Z"]);
  const result = g.store.planItems({ turnId: g.turnOf(g.lead.id), items: [{ title: "分镜", owner: "视频导演" }, { title: "动画", owner: "动画师" }] });
  expect(result.folded).toBeUndefined();
  expect(result.opening_kept).toEqual({ ticket_id: kept.id, seq: kept.seq, why: "in_review" });
});

test("drop alone, without new items, takes tickets out; one also among the items is refused", () => {
  const f = fixture();
  const turn = f.turnOf(f.lead.id);
  const [storyboard, animation] = f.store.planItems({ turnId: turn, items: [{ title: "分镜", owner: "视频导演" }, { title: "动画", owner: "动画师", depends_on: ["分镜"] }] }).tickets;
  expect(() => f.store.planItems({ turnId: turn, items: [{ title: "分镜", owner: "视频导演" }], drop: [{ ticket: "分镜", reason: "不要了" }] })).toThrow("also among the items");
  const dropped = f.store.planItems({ turnId: turn, items: [], drop: [{ ticket: 1, reason: "不要分镜了" }] });
  expect(dropped.dropped).toEqual([{ ticket_id: storyboard!.ticket_id, seq: 1, reason: "不要分镜了", waited_on_by: [animation!.seq] }]);
  expect(f.store.getTicket(storyboard!.ticket_id)).toMatchObject({ stage: "dropped", dropped_why: "不要分镜了" });
  expect(f.store.listWorkEvents({ kind: "ticket.dropped" }).map((event) => event.payload)).toMatchObject([{ reason: "不要分镜了" }]);
});
