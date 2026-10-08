import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from ".";
import * as filing from "./filing";
import { KeyCache, type StoreContext } from "./shared";
import { Transactions } from "./transactions";
import { migrateFiling } from "./filing-migration";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store();
  stores.push(store);
  const director = store.createBot({ name: "导演", duties: "出片", boundaries: "none" });
  const reviewer = store.createBot({ name: "审片", duties: "审片", boundaries: "none" });
  const room = store.createGroup({ name: "片场", members: [director.bot.id, reviewer.bot.id] });
  const ctx: StoreContext = {
    db: store.db, keys: new KeyCache({ get: async () => null, set: async () => {}, delete: async () => {} }, store.db),
    commit: (work) => store.transaction(work), tx: new Transactions(store.db), inboxRoot: "", activeStages: new Set(),
    keyPlan: null, legacy: { copiedKey: false },
  };
  return { store, ctx, bot: director.bot, direct: director.direct_session.id, room: room.id };
}

test("a correction to a running plan reaches its live ticket segment without rebinding that segment", () => {
  const { store, ctx, bot, room, direct } = fixture();
  store.raiseEngineLevel(null);
  const a = store.openTask({ sessionId: room, title: 'Old filing' });
  const b = store.openTask({ sessionId: room, title: 'Busy target' });
  const ticket = store.createTicket({ taskId: b.id, title: 'Running draft', spec: '', status: 'doing' });
  const opening = store.postMessage(direct, { body: 'Work on the draft' });
  store.fileMessage(opening.id, { explicit: [{ taskId: b.id, ticketId: ticket.id }] });
  const live = store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: opening.id, taskId: b.id, ticketId: ticket.id });
  const message = store.postMessage(direct, { body: 'This belongs to the busy job' });
  filing.fileMessage(ctx, message.id, { explicit: [{ taskId: a.id }] });
  const source = store.createTurn({ sessionId: room, botId: bot.id, triggerMessageId: message.id, taskId: a.id });
  filing.refileMessage(ctx, message.id, { filings: [{ taskId: b.id }], userActionId: 'live-plan-correction' });
  const correction = store.db.query<{ seq: number; turn_id: string | null; work_item_id: string | null; task_id: string; ticket_id: string | null }, [string]>(
    "SELECT seq, turn_id, work_item_id, task_id, ticket_id FROM inbox_items WHERE message_id = ? AND source = 'system'").get(message.id)!;
  expect(correction).toMatchObject({ turn_id: live.id, work_item_id: live.work_item_id, task_id: b.id, ticket_id: null });
  expect(store.getTurn(live.id).ticket_id).toBe(ticket.id);
  const read = store.deliverInboxItems([correction.seq], live.id, 2);
  expect(read.delivered).toHaveLength(1);
  expect(store.getInboxItem(correction.seq)!.delivered_turn_id).toBe(live.id);
  expect(store.getTurn(source.id).task_id).toBe(a.id);
});

test("a turn's original trigger receives a correction even without a separately delivered inbox row", () => {
  const { store, ctx, bot, room, direct } = fixture();
  const a = store.openTask({ sessionId: room, title: '原规划' });
  const b = store.openTask({ sessionId: room, title: '新规划' });
  const message = store.postMessage(direct, { body: '改归这句话' });
  filing.fileMessage(ctx, message.id, { explicit: [{ taskId: a.id }] });
  const turn = store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: message.id, taskId: a.id });
  filing.refileMessage(ctx, message.id, { filings: [{ taskId: b.id }], userActionId: 'trigger-correction' });
  expect(store.getTurn(turn.id).task_id).toBe(a.id);
  // The correction for B, and a note for the segment still running on A not to act on the line there.
  expect(store.db.query("SELECT task_id, turn_id, state FROM inbox_items WHERE message_id = ? AND source = 'system' ORDER BY seq").all(message.id)).toEqual([
    { task_id: b.id, turn_id: null, state: 'queued' }, { task_id: a.id, turn_id: turn.id, state: 'queued' }]);
});

test("a real pre-quotes schema reopens with additive filing, desk, parallel and lead columns intact", async () => {
  const root = mkdtempSync(join(tmpdir(), 'filing-migration-'));
  const filename = join(root, 'state.sqlite');
  try {
    const old = new Database(filename, { create: true });
    old.exec(await Bun.file(join(import.meta.dir, 'fixtures', 'schema-pre-quotes.sql')).text());
    old.close();
    const upgraded = new Store({ filename });
    for (const [table, required] of [
      ['messages', ['filing_state', 'filing_candidates']],
      ['turns', ['filing_candidates', 'filing_bounces', 'work_dir_changes', 'end_reason']],
      ['tasks', ['stage', 'delivered_at', 'lead_bot_id']],
      ['bots', ['parallel_limit']], ['work_items', ['thread_session_id']],
    ] as const) {
      const columns = upgraded.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      for (const column of required) expect(columns).toContain(column);
    }
    expect(upgraded.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    upgraded.close();
    const reopened = new Store({ filename });
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a bot's validated desk selection resolves a frozen default/undetermined message but cannot overwrite a user correction", () => {
  const { store, ctx, bot, room, direct } = fixture();
  const a = store.openTask({ sessionId: room, title: '甲' });
  const b = store.openTask({ sessionId: room, title: '乙' });
  const message = store.postMessage(direct, { body: '做这个' });
  expect(filing.fileMessage(ctx, message.id, { botId: bot.id }).state).toBe('undetermined');
  expect(filing.fileMessage(ctx, message.id, { botId: bot.id, botSelection: [{ taskId: b.id }] }).filings).toMatchObject([{ taskId: b.id, filedBy: `bot:${bot.id}`, strength: 'bot' }]);
  filing.refileMessage(ctx, message.id, { filings: [{ taskId: a.id }], userActionId: 'user-correction' });
  expect(() => filing.fileMessage(ctx, message.id, { botId: bot.id, botSelection: [{ taskId: b.id }] })).toThrow('locked attribution');
  expect(filing.filingsOfMessage(ctx, message.id)[0]!.taskId).toBe(a.id);
});

test("all plan links of preserved original words survive clear-history", () => {
  const { store, ctx, bot, room, direct } = fixture();
  const a = store.openTask({ sessionId: room, title: '主归属' });
  const b = store.openTask({ sessionId: room, title: '第二归属' });
  const message = store.postMessage(room, { body: '这两件都保持背景连贯' });
  filing.fileMessage(ctx, message.id, { explicit: [{ taskId: a.id }, { taskId: b.id }] });
  store.createTurn({ sessionId: room, botId: bot.id, triggerMessageId: message.id, taskId: b.id });
  store.clearSessionMessages(room);
  filing.resumePlan(ctx, b.id);
  // The clear took the Bot's segment on b with it, so from its direct b is no candidate any more
  // (ADR 0040 §8.4); in b's own conversation it is, with its words.
  expect(filing.planCandidates(ctx, { sessionId: direct, botId: bot.id }).some((c) => c.id === b.id)).toBe(false);
  const candidate = filing.planCandidates(ctx, { sessionId: room, botId: bot.id }).find((c) => c.id === b.id);
  expect(candidate?.lastUserQuote).toBe('这两件都保持背景连贯');
  expect(store.listQuotes({ messageId: message.id })).toEqual([]);
});

test("undetermined attribution replays the same snapshot even after more plans appear", () => {
  const { store, ctx, bot, room, direct } = fixture();
  store.openTask({ sessionId: room, title: '甲' });
  store.openTask({ sessionId: room, title: '乙' });
  const message = store.postMessage(direct, { body: '这版再看一遍' });
  const before = filing.fileMessage(ctx, message.id, { botId: bot.id });
  expect(before.state).toBe('undetermined');
  store.openTask({ sessionId: room, title: '丙' });
  const after = filing.fileMessage(ctx, message.id, { botId: bot.id });
  expect(after.candidates.map((c) => c.id)).toEqual(before.candidates.map((c) => c.id));
});

test("continue gives an aged delivered plan a user-activity grace period", () => {
  const { store, ctx, room } = fixture();
  const plan = store.openTask({ sessionId: room, title: '老交付' });
  store.db.run("UPDATE tasks SET stage = 'delivered', delivered_at = '2026-01-01T00:00:00.000Z', created_at = '2026-01-01T00:00:00.000Z', dormant_since = '2026-01-05T00:00:00.000Z' WHERE id = ?", [plan.id]);
  filing.resumePlan(ctx, plan.id);
  expect(filing.updatePlanDormancy(ctx, { now: new Date(Date.now() + 1000).toISOString() })).toEqual([]);
});

test("annotation inherits the exact part whose current file it marks, rather than just its directory ticket", () => {
  const { store, ctx, bot, room, direct } = fixture();
  const plan = store.openTask({ sessionId: room, title: '批注规划' });
  const ticket = store.createTicket({ taskId: plan.id, title: '渲染任务', spec: '', status: 'doing' });
  const path = `${ticket.dir}/shot_07.mp4`;
  // The part's current file, as the hand-over that named the part left it; the file's name says nothing.
  store.db.run(`INSERT INTO ticket_parts (id, ticket_id, key, title, declared_by, current_artifact) VALUES ('p7', ?, 'shot_07', 'Shot 07', 'plan_items', ?)`, [ticket.id, path]);
  const target = store.insertMessage({ sessionId: room, kind: 'bot', author: bot.id, body: '交付' });
  store.db.run('UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?', [plan.id, ticket.id, target.id]);
  store.db.run(`INSERT INTO attachments (id, message_id, workspace_relpath, original_filename, created_at)
    VALUES ('annotation-artifact', ?, ?, 'shot_07.mp4', '2026-01-01')`, [target.id, path]);
  const message = store.postMessage(direct, { body: '这里不行' });
  store.db.run(`INSERT INTO annotations (id, status, relpath, anchor_kind, anchor, content_sha256, target_message_id,
    target_session_id, bot_id, session_id, message_id, body, created_at, updated_at)
    VALUES ('part-annotation', 'open', ?, 'media_time', '{}', 'hash', ?, ?, ?, ?, ?, '重做', '2026-01-01', '2026-01-01')`,
    [path, target.id, room, bot.id, direct, message.id]);
  expect(filing.fileMessage(ctx, message.id, { botId: bot.id }).filings[0]).toMatchObject({ taskId: plan.id, ticketId: ticket.id, partKey: 'shot_07', filedBy: 'rule:2' });
});

test("refiling acknowledged mail corrects the new home session under its hold and moves source project requirements", () => {
  const { store, ctx, bot, room, direct } = fixture();
  const a = store.openTask({ sessionId: room, title: '原项目' });
  const b = store.openTask({ sessionId: direct, title: '新项目' });
  const message = store.postMessage(room, { body: '背景连贯' });
  filing.fileMessage(ctx, message.id, { explicit: [{ taskId: a.id }] });
  const quote = store.listQuotes({ messageId: message.id })[0]!;
  store.db.run(`INSERT INTO requirements (id, scope, scope_id, quote, source_kind, source_quote_id, status,
    last_raised_at, added_by, created_at, updated_at, origin_task_id)
    VALUES ('project-requirement', 'project', ?, '背景连贯', 'message', ?, 'open', '2026-01-01', 'capture', '2026-01-01', '2026-01-01', ?)`, [room, quote.id, a.id]);
  store.db.run(`INSERT INTO work_items (id, bot_id, task_id, home_session_id, state, created_at, updated_at)
    VALUES ('new-home', ?, ?, ?, 'idle', '2026-01-01', '2026-01-01')`, [bot.id, b.id, direct]);
  store.db.run(`INSERT INTO holds (id, scope, scope_id, source, created_at) VALUES ('home-hold', 'session', ?, 'user_button', '2026-01-01')`, [direct]);
  const turn = store.createTurn({ sessionId: room, botId: bot.id, triggerMessageId: message.id, taskId: a.id });
  const item = store.queueInboxItem({ botId: bot.id, sessionId: room, turnId: turn.id, taskId: a.id, ticketId: null,
    messageId: message.id, author: 'user', body: message.body, source: 'user', kind: 'change', priority: 1 });
  store.db.run("UPDATE inbox_items SET state = 'adopted', delivered_turn_id = ? WHERE seq = ?", [turn.id, item.seq]);
  filing.refileMessage(ctx, message.id, { filings: [{ taskId: b.id }], userActionId: 'project-move' });
  expect(store.db.query("SELECT session_id, state FROM inbox_items WHERE source = 'system' AND message_id = ? AND turn_id IS NOT ?").all(message.id, turn.id)).toEqual([{ session_id: direct, state: 'held' }]);
  expect(store.db.query("SELECT scope_id, origin_task_id FROM requirements WHERE id = 'project-requirement'").get()).toEqual({ scope_id: direct, origin_task_id: b.id });
});

test("legacy UI stamps and user corrections stay authoritative on reprocessing, including explicit none", () => {
  const { store, ctx, bot, room, direct } = fixture();
  const a = store.openTask({ sessionId: room, title: '显式选择' });
  const b = store.openTask({ sessionId: room, title: '路径目标' });
  const message = store.postMessage(direct, { body: `${b.dir}/result.mp4` });
  store.db.run('UPDATE messages SET task_id = ? WHERE id = ?', [a.id, message.id]);
  expect(filing.fileMessage(ctx, message.id, { botId: bot.id }).filings[0]).toMatchObject({ taskId: a.id, filedBy: 'rule:1' });
  filing.refileMessage(ctx, message.id, { filings: [{ taskId: a.id }], userActionId: 'correct-action' });
  expect(filing.fileMessage(ctx, message.id, { botId: bot.id }).filings).toMatchObject([{ taskId: a.id, filedBy: 'user', strength: 'user' }]);
  filing.refileMessage(ctx, message.id, { filings: [], userActionId: 'none-action' });
  expect(filing.fileMessage(ctx, message.id, { botId: bot.id })).toMatchObject({ state: 'none', filings: [] });
});

test("a file named like a shot makes no part: a path files a line under the ticket, and under a part only by its current file", () => {
  const { store, ctx, bot, room, direct } = fixture();
  const plan = store.openTask({ sessionId: room, title: '分件' });
  const ticket = store.createTicket({ taskId: plan.id, title: '渲染', spec: '', status: 'doing' });
  const delivery = store.insertMessage({ sessionId: room, kind: 'bot', author: bot.id, body: '交付' });
  store.db.run('UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?', [plan.id, ticket.id, delivery.id]);
  store.db.run(`INSERT INTO attachments (id, message_id, workspace_relpath, original_filename, created_at)
    VALUES ('shot12', ?, ?, 'shot_12.mp4', '2026-01-01')`, [delivery.id, `${ticket.dir}/shot_12.mp4`]);
  const line = store.postMessage(direct, { body: `${ticket.dir}/shot_12.mp4 重做` });
  expect(filing.fileMessage(ctx, line.id, { botId: bot.id }).filings).toMatchObject([{ taskId: plan.id, ticketId: ticket.id, partKey: null, filedBy: 'rule:4' }]);
  expect(store.db.query('SELECT COUNT(*) AS n FROM ticket_parts').get()).toEqual({ n: 0 });
});

test("paths honor directory boundaries and traversal; binding rejects wrong-bot/closed work before writes, bot output uses its own turn", () => {
  const { store, ctx, bot, direct, room } = fixture();
  const a = store.openTask({ sessionId: room, title: '当前片' });
  const b = store.openTask({ sessionId: room, title: '别的片' });
  const line = store.postMessage(direct, { body: `${a.dir}-other/result.mp4 ${a.dir}/../${b.dir}/result.mp4` });
  expect(filing.fileMessage(ctx, line.id, { botId: bot.id }).filings).toEqual([]);
  const other = store.createBot({ name: '其他', duties: 'none', boundaries: 'none' });
  store.db.run(`INSERT INTO work_items (id, bot_id, task_id, home_session_id, state, created_at, updated_at)
    VALUES ('wrong-bot', ?, ?, ?, 'running', '2026-01-01', '2026-01-01')`, [other.bot.id, b.id, room]);
  expect(() => filing.fileMessage(ctx, line.id, { botId: bot.id, boundWorkItemId: 'wrong-bot' })).toThrow('invalid bound work item');
  expect(filing.filingsOfMessage(ctx, line.id)).toEqual([]);
  const ownLine = store.postMessage(direct, { body: '做这个' });
  const ownTurn = store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: ownLine.id, taskId: a.id });
  const output = store.insertMessage({ sessionId: direct, kind: 'bot', author: bot.id, body: '完成', turnId: ownTurn.id });
  expect(filing.fileMessage(ctx, output.id, { botId: bot.id }).filings).toMatchObject([{ taskId: a.id, filedBy: 'rule:5' }]);
  store.setTurnStatus(ownTurn.id, 'completed');
  store.db.run("UPDATE work_items SET state = 'closed' WHERE id = (SELECT work_item_id FROM turns WHERE id = ?)", [ownTurn.id]);
  expect(filing.fileMessage(ctx, output.id, { botId: bot.id }).filings).toMatchObject([{ taskId: a.id, filedBy: 'rule:5' }]);
});

test("refiling validates atomically, moves unread targets, preserves delivered audit and queues a correction, then permits explicit none", () => {
  const { store, ctx, bot, direct, room } = fixture();
  const a = store.openTask({ sessionId: room, title: '原片' });
  const b = store.openTask({ sessionId: room, title: '正确片' });
  const ticket = store.createTicket({ taskId: b.id, title: 'Shot 01', spec: '', status: 'todo' });
  const message = store.postMessage(direct, { body: '这一镜重做' });
  filing.fileMessage(ctx, message.id, { explicit: [{ taskId: a.id }] });
  const turn = store.createTurn({ sessionId: direct, botId: bot.id, triggerMessageId: message.id, taskId: a.id });
  const makeItem = () => store.queueInboxItem({ botId: bot.id, sessionId: direct, turnId: turn.id, taskId: a.id, ticketId: null,
    messageId: message.id, author: 'user', body: message.body, source: 'user', kind: 'change', priority: 1 });
  const queued = makeItem();
  // Old P4a databases can already contain a separate read row. New admissions deduplicate, so
  // seed that historical row directly rather than asking queueInboxItem to duplicate one now.
  const delivered = store.db.query<{ seq: number }, [number]>(`INSERT INTO inbox_items
    (id, bot_id, session_id, turn_id, task_id, ticket_id, message_id, author, body_snapshot, source, kind, priority, state, created_at)
    SELECT 'historical-delivered', bot_id, session_id, turn_id, task_id, ticket_id, message_id, author, body_snapshot, source, kind, priority, 'delivered', created_at
      FROM inbox_items WHERE seq = ? RETURNING seq`).get(queued.seq)!;
  store.db.run("UPDATE inbox_items SET delivered_turn_id = ?, delivered_hop = 2 WHERE seq = ?", [turn.id, delivered.seq]);
  try {
    filing.refileMessage(ctx, message.id, { filings: [{ taskId: a.id, ticketId: ticket.id }], userActionId: 'bad-action' });
    throw new Error('expected an invalid target refusal');
  } catch (error) {
    expect(error).toMatchObject({ status: 422, code: 'invalid_args' });
  }
  expect(filing.filingsOfMessage(ctx, message.id)[0]!.taskId).toBe(a.id);
  const quote = store.listQuotes({ messageId: message.id })[0]!;
  store.db.run(`INSERT INTO requirements (id, scope, scope_id, quote, source_kind, source_quote_id, status,
    last_raised_at, added_by, created_at, updated_at, origin_task_id)
    VALUES ('requirement', 'plan', ?, '这一镜重做', 'message', ?, 'open', '2026-01-01', 'capture', '2026-01-01', '2026-01-01', ?)`, [a.id, quote.id, a.id]);
  const result = filing.refileMessage(ctx, message.id, { filings: [{ taskId: b.id, ticketId: ticket.id }], userActionId: 'change-action' });
  expect(result).toMatchObject({ id: message.id, task_id: b.id, ticket_id: ticket.id, filing_state: 'filed' });
  expect(store.getInboxItem(queued.seq)).toMatchObject({ task_id: b.id, ticket_id: ticket.id, turn_id: null });
  expect(store.getInboxItem(delivered.seq)).toMatchObject({ task_id: a.id, delivered_turn_id: turn.id, state: 'delivered' });
  expect(store.db.query("SELECT task_id, ticket_id FROM inbox_items WHERE source = 'system' AND message_id = ? ORDER BY seq").all(message.id)).toEqual([
    { task_id: b.id, ticket_id: ticket.id },
    // The segment that read it on A hears not to act on it there.
    { task_id: a.id, ticket_id: null },
  ]);
  expect(store.listQuotes({ messageId: message.id })[0]).toMatchObject({ task_id: b.id, ticket_id: ticket.id });
  expect(store.db.query("SELECT scope_id, origin_task_id FROM requirements WHERE id = 'requirement'").get()).toEqual({ scope_id: b.id, origin_task_id: b.id });
  expect(store.listWorkEvents({ kind: 'attribution.changed' })[0]!.payload).toMatchObject({ message: message.id, user_action_id: 'change-action' });
  filing.refileMessage(ctx, message.id, { filings: [], userActionId: 'none-action' });
  expect(filing.filingsOfMessage(ctx, message.id)).toEqual([]);
  expect(store.db.query('SELECT filing_state FROM messages WHERE id = ?').get(message.id)).toEqual({ filing_state: 'none' });
});

test("dormancy protects long work and recent user speech, ages delivery, and explicit user filing wakes every target", () => {
  const { store, ctx, bot, room } = fixture();
  const old = store.openTask({ sessionId: room, title: "闲置旧片" });
  const busy = store.openTask({ sessionId: room, title: "长期活" });
  const delivered = store.openTask({ sessionId: room, title: "已交付" });
  const recent = store.openTask({ sessionId: room, title: "最近投诉" });
  const newest = store.openTask({ sessionId: room, title: "新片" });
  store.db.run("UPDATE tasks SET created_at = '2026-01-01T00:00:00.000Z' WHERE id <> ?", [newest.id]);
  store.db.run("UPDATE tasks SET created_at = '2026-01-05T00:00:00.000Z' WHERE id = ?", [newest.id]);
  store.db.run("UPDATE tasks SET stage = 'delivered', status = 'done', delivered_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?)", [delivered.id, recent.id]);
  store.db.run(`INSERT INTO work_items (id, bot_id, task_id, home_session_id, state, created_at, updated_at)
    VALUES ('long-work', ?, ?, ?, 'waiting', '2026-01-01', '2026-01-01')`, [bot.id, busy.id, room]);
  store.db.run(`INSERT INTO user_quotes (id, session_id, task_id, via, body, created_at)
    VALUES ('recent-quote', ?, ?, 'message', '再改一下', '2026-01-04T23:30:00.000Z')`, [room, recent.id]);
  const asleep = filing.updatePlanDormancy(ctx, { now: '2026-01-05T00:00:00.000Z', newTaskId: newest.id });
  expect(asleep.sort()).toEqual([old.id, delivered.id].sort());
  expect(store.getTask(busy.id).dormant_since).toBeNull();
  expect(store.getTask(recent.id).dormant_since).toBeNull();
  expect(store.getTask(delivered.id).dormant_since).toBe('2026-01-05T00:00:00.000Z');
  expect(store.getTask(delivered.id).closed_at).not.toBeNull();
  const line = store.postMessage(room, { body: '这两件继续' });
  filing.fileMessage(ctx, line.id, { explicit: [{ taskId: old.id }, { taskId: delivered.id }] });
  expect(store.getTask(old.id)).toMatchObject({ dormant_since: null, closed_at: null });
  expect(store.getTask(delivered.id)).toMatchObject({ dormant_since: null, closed_at: null });
});

test("migration imports stale done plans as delivered+dormant once, preserving recent done and explicit-none filing", () => {
  const { store, ctx, room } = fixture();
  const stale = store.openTask({ sessionId: room, title: "旧交付" });
  const fresh = store.openTask({ sessionId: room, title: "近期交付" });
  store.db.run("UPDATE tasks SET status = 'done', created_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?)", [stale.id, fresh.id]);
  store.db.run(`INSERT INTO user_quotes (id, session_id, task_id, via, body, created_at)
    VALUES ('fresh-quote', ?, ?, 'message', '看过了', '2026-01-04T23:30:00.000Z')`, [room, fresh.id]);
  const message = store.postMessage(room, { body: '保留原话' });
  store.db.run("UPDATE messages SET task_id = ?, filing_state = NULL WHERE id = ?", [stale.id, message.id]);
  store.db.run("UPDATE user_quotes SET created_at = '2026-01-01T00:00:00.000Z' WHERE message_id = ?", [message.id]);
  migrateFiling(store.db, '2026-01-05T00:00:00.000Z');
  expect(store.getTask(stale.id).dormant_since).toBe('2026-01-05T00:00:00.000Z');
  expect(store.db.query('SELECT stage, status FROM tasks WHERE id = ?').get(stale.id)).toEqual({ stage: 'delivered', status: 'done' });
  expect(store.getTask(fresh.id).dormant_since).toBeNull();
  expect(filing.filingsOfMessage(ctx, message.id)).toMatchObject([{ taskId: stale.id, filedBy: 'legacy' }]);
  filing.fileMessage(ctx, message.id, { none: true });
  migrateFiling(store.db, '2026-01-06T00:00:00.000Z');
  expect(filing.filingsOfMessage(ctx, message.id)).toEqual([]);
  expect(store.db.query('SELECT filing_state FROM messages WHERE id = ?').get(message.id)).toEqual({ filing_state: 'none' });
});

const read = (about: 'jobs' | 'new' | 'in_place' | 'unclear', targets: Array<{ taskId: string; ticketId?: string | null; partKey?: string | null }> = []) =>
  ({ source: 'model' as const, about, targets: targets.map((t) => ({ taskId: t.taskId, ticketId: t.ticketId ?? null, partKey: t.partKey ?? null })) });

test("with nothing locked, a line goes where the reading puts it, as a default; with no reading, nowhere — not even to the one job open (ADR 0057)", () => {
  const { store, ctx, bot, direct } = fixture();
  const a = store.openTask({ sessionId: direct, title: "当前片" });
  const shots = store.createTicket({ taskId: a.id, title: "镜头", spec: "", status: "doing" });
  store.db.run(`INSERT INTO ticket_parts (id, ticket_id, key, title, declared_by) VALUES ('p3', ?, 'shot_03', 'Shot 03', 'plan_items')`, [shots.id]);
  // The one job open, and a line about nothing else: still nobody's guess.
  const unread = store.postMessage(direct, { body: "再看一遍" });
  expect(filing.fileMessage(ctx, unread.id, { botId: bot.id })).toMatchObject({ state: "undetermined", filings: [] });
  expect(filing.lineReadAsNew(ctx, unread.id)).toBe(false);
  // Read as about the job, its ticket and part: filed there, as a default.
  const about = store.postMessage(direct, { body: "第三镜要重做" });
  expect(filing.fileMessage(ctx, about.id, { botId: bot.id, read: read("jobs", [{ taskId: a.id, ticketId: shots.id, partKey: "shot_03" }]) }).filings)
    .toMatchObject([{ taskId: a.id, ticketId: shots.id, partKey: "shot_03", filedBy: "reader", strength: "default" }]);
  // Read as about none of the jobs: left for the Bot's desk, marked so.
  const fresh = store.postMessage(direct, { body: "帮我写首诗" });
  expect(filing.fileMessage(ctx, fresh.id, { botId: bot.id, read: read("new") }).state).toBe("undetermined");
  expect(filing.lineReadAsNew(ctx, fresh.id)).toBe(true);
  expect(filing.lineReadInPlace(ctx, fresh.id)).toBe(false);
  // Read as done in place, about none of them either: left for the desk, marked so — its effects open no job.
  const aside = store.postMessage(direct, { body: "把模型窗口改成 20 万" });
  expect(filing.fileMessage(ctx, aside.id, { botId: bot.id, read: read("in_place") }).state).toBe("undetermined");
  expect(filing.lineReadInPlace(ctx, aside.id)).toBe(true);
  expect(filing.lineReadAsNew(ctx, aside.id)).toBe(false);
  // No telling which: left for the desk, unmarked.
  const unclear = store.postMessage(direct, { body: "这个呢" });
  expect(filing.fileMessage(ctx, unclear.id, { botId: bot.id, read: read("unclear") }).state).toBe("undetermined");
  expect(filing.lineReadAsNew(ctx, unclear.id)).toBe(false);
  expect(filing.lineReadInPlace(ctx, unclear.id)).toBe(false);
  // A job closed since the reading is no place for it.
  const b = store.openTask({ sessionId: direct, title: "旧片" });
  store.db.run("UPDATE tasks SET stage = 'accepted' WHERE id = ?", [b.id]);
  const late = store.postMessage(direct, { body: "旧片再改改" });
  expect(filing.fileMessage(ctx, late.id, { botId: bot.id, read: read("jobs", [{ taskId: b.id }]) }).state).toBe("undetermined");
  // A locked signal wins over any reading: a quoted reply goes where the line it quotes went.
  const quoted = store.postMessage(direct, { body: "这句再改", parent_id: about.id });
  expect(filing.fileMessage(ctx, quoted.id, { botId: bot.id, read: read("new") }).filings)
    .toMatchObject([{ taskId: a.id, ticketId: shots.id, partKey: "shot_03", filedBy: "rule:3", strength: "locked" }]);
  expect(filing.lineReadAsNew(ctx, quoted.id)).toBe(false);
  // Once the Bot chooses a job for the line read as new, it is no longer marked.
  filing.fileMessage(ctx, fresh.id, { botId: bot.id, botSelection: [{ taskId: a.id }] });
  expect(filing.lineReadAsNew(ctx, fresh.id)).toBe(false);
});

test("what a reading is shown: the jobs a line may be about, a routine's included when the Bot's line just before was on it, and the lines before with their jobs", () => {
  const { store, ctx, bot, direct } = fixture();
  const job = store.openTask({ sessionId: direct, title: "地址信息" });
  const routine = store.createRoutine({ bot_id: bot.id, title: "日报", instruction: "做日报", schedule: { kind: "daily", time: "01:00" } });
  // Its standing plan, as its first fire opens it: never a candidate by itself.
  const standing = store.openTask({ sessionId: direct, title: "日报" });
  store.db.run("UPDATE tasks SET routine_id = ? WHERE id = ?", [routine.id, standing.id]);
  const today = store.createTicket({ taskId: standing.id, title: "2026-10-03", spec: "", status: "doing", worker: bot.id });
  const brief = store.insertMessage({ sessionId: direct, kind: "bot", author: bot.id, body: "今天的日报" });
  store.db.run("UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?", [standing.id, today.id, brief.id]);
  const line = store.postMessage(direct, { body: "标题跟 LOGO 没有对齐" });

  const shown = filing.lineToFile(ctx, line.id)!;
  expect(shown).toMatchObject({ where: "direct", said: "标题跟 LOGO 没有对齐" });
  expect(shown.jobs.map((j) => j.title).sort()).toEqual(["地址信息", "日报"].sort());
  expect(shown.jobs.find((j) => j.taskId === standing.id)!.tickets.map((t) => t.title)).toEqual(["2026-10-03"]);
  expect(shown.before.at(-1)).toMatchObject({ author: "导演", text: "今天的日报", taskId: standing.id });
  // The desk captures the same jobs, so the Bot can choose what a reading could not.
  expect(filing.lineCandidates(ctx, { sessionId: direct, botId: bot.id, messageId: line.id }).map((c) => c.id).sort()).toEqual([job.id, standing.id].sort());
  // Read as the brief's: filed under the routine's job and today's ticket.
  filing.fileMessage(ctx, line.id, { botId: bot.id, read: read("jobs", [{ taskId: standing.id, ticketId: today.id }]) });
  expect(filing.filingsOfMessage(ctx, line.id)).toMatchObject([{ taskId: standing.id, ticketId: today.id, filedBy: "reader" }]);
  // Nothing to read once it is filed, nor for a quoted reply or a pure stop.
  expect(filing.lineToFile(ctx, line.id)).toBeNull();
  const quoted = store.postMessage(direct, { body: "这句再改", parent_id: brief.id });
  expect(filing.lineToFile(ctx, quoted.id)).toBeNull();
  // A conversation with no job is read too, with nothing to choose: new work, or something done in place.
  const other = store.createBot({ name: "空闲", duties: "none", boundaries: "none" });
  expect(filing.lineToFile(ctx, store.postMessage(other.direct_session.id, { body: "你好" }).id)).toMatchObject({ said: "你好", jobs: [] });
});

test("locked annotation, quote, path and bound-work signals accumulate in order before any default", () => {
  const { store, ctx, bot, direct, room } = fixture();
  const a = store.openTask({ sessionId: room, title: "批注目标" });
  const b = store.openTask({ sessionId: room, title: "引用目标" });
  const c = store.openTask({ sessionId: room, title: "路径目标" });
  const d = store.openTask({ sessionId: room, title: "作业目标" });
  const ticket = store.createTicket({ taskId: c.id, title: "Shot 07", spec: "", status: "todo" });
  const quote = store.postMessage(room, { body: "旧交付" });
  filing.fileMessage(ctx, quote.id, { explicit: [{ taskId: b.id }] });
  const target = store.postMessage(room, { body: "批注交付" });
  filing.fileMessage(ctx, target.id, { explicit: [{ taskId: a.id }] });
  const message = store.postMessage(direct, { body: `看一下 ${ticket.dir}/shot_07.mp4` });
  store.db.run(`INSERT INTO annotations (id, status, relpath, anchor_kind, anchor, content_sha256, target_message_id,
    target_session_id, bot_id, session_id, message_id, body, created_at, updated_at)
    VALUES ('annotation', 'open', ?, 'media_time', '{}', 'hash', ?, ?, ?, ?, ?, '重做', '2026-01-01', '2026-01-01')`,
    [`${a.dir}/result.mp4`, target.id, room, bot.id, direct, message.id]);
  store.db.run(`INSERT INTO work_items (id, bot_id, task_id, home_session_id, state, created_at, updated_at)
    VALUES ('bound-work', ?, ?, ?, 'running', '2026-01-01', '2026-01-01')`, [bot.id, d.id, direct]);
  const result = filing.fileMessage(ctx, message.id, { botId: bot.id, referenceMessageId: quote.id, boundWorkItemId: "bound-work" });
  expect(result.filings.map((f) => [f.taskId, f.ticketId, f.filedBy])).toEqual([
    [a.id, null, "rule:2"], [b.id, null, "rule:3"], [c.id, ticket.id, "rule:4"], [d.id, null, "rule:5"],
  ]);
  expect(result.filings.every((f) => f.strength === "locked")).toBe(true);
});

test("a candidate snapshot includes the conversation's own delivered work and the called bot's recent or open work, not dormant or unrelated work", () => {
  const { store, ctx, bot, direct, room } = fixture();
  const visible = store.openTask({ sessionId: room, title: "本群交付" });
  const local = store.openTask({ sessionId: direct, title: "私聊小活" });
  const asleep = store.openTask({ sessionId: room, title: "旧片" });
  store.db.run("UPDATE tasks SET dormant_since = '2026-01-01T00:00:00.000Z', closed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [asleep.id]);
  store.db.run("UPDATE tasks SET stage = 'delivered', status = 'done' WHERE id = ?", [visible.id]);
  const otherBot = store.createBot({ name: "无关", duties: "none", boundaries: "none" });
  const unrelated = store.openTask({ sessionId: otherBot.direct_session.id, title: "别人的事" });
  const open = store.openTask({ sessionId: otherBot.direct_session.id, title: "有工作项" });
  store.db.run(`INSERT INTO work_items (id, bot_id, task_id, home_session_id, state, created_at, updated_at)
    VALUES ('open-work', ?, ?, ?, 'idle', '2026-01-01', '2026-01-01')`, [bot.id, open.id, direct]);
  // From the direct: its own plan and the Bot's open work; the group's plan the Bot is merely a
  // member of is not one of its jobs (ADR 0040 §8.4, the 2026-10-01 audit's P3).
  const candidates = filing.planCandidates(ctx, { sessionId: direct, botId: bot.id });
  expect(candidates.map((candidate) => candidate.id).sort()).toEqual([local.id, open.id].sort());
  expect(candidates.some((candidate) => candidate.id === unrelated.id)).toBe(false);
  // In the group itself its delivered plan is a candidate.
  expect(filing.planCandidates(ctx, { sessionId: room, botId: bot.id }).find((candidate) => candidate.id === visible.id))
    .toMatchObject({ title: "本群交付", dir: visible.dir, stage: "delivered" });
  // Once the Bot has worked on it within a day, it is one of its jobs from the direct too.
  const said = store.postMessage(room, { body: "看一下交付" });
  store.createTurn({ sessionId: room, botId: bot.id, triggerMessageId: said.id, taskId: visible.id });
  const after = filing.planCandidates(ctx, { sessionId: direct, botId: bot.id });
  expect(after.map((candidate) => candidate.id).sort()).toEqual([visible.id, local.id, open.id].sort());
  const frozenIds = after.map((candidate) => candidate.id);
  store.openTask({ sessionId: direct, title: "快照之后的新事" });
  expect(after.map((candidate) => candidate.id)).toEqual(frozenIds);
});

test("UI selections authoritatively file one line under multiple plans, with only the first primary", () => {
  const { store, ctx, room } = fixture();
  const a = store.openTask({ sessionId: room, title: "EP01" });
  const b = store.openTask({ sessionId: room, title: "片头" });
  const message = store.postMessage(room, { body: "这两件都要改" });
  const result = filing.fileMessage(ctx, message.id, { explicit: [{ taskId: a.id }, { taskId: b.id }] });
  expect(result.state).toBe("filed");
  expect(result.filings).toMatchObject([
    { taskId: a.id, ticketId: null, partKey: null, filedBy: "rule:1", strength: "locked", isPrimary: true },
    { taskId: b.id, ticketId: null, partKey: null, filedBy: "rule:1", strength: "locked", isPrimary: false },
  ]);
  expect(filing.filingsOfMessage(ctx, message.id)).toEqual(result.filings);
  expect(store.db.query("SELECT task_id, filing_state FROM messages WHERE id = ?").get(message.id)).toEqual({ task_id: a.id, filing_state: "filed" });
  expect(store.listQuotes({ messageId: message.id })[0]!.task_id).toBe(a.id);
});
