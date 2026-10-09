import { afterEach, expect, test } from "bun:test";
import { isoNow } from "../ids";
import { Store } from ".";
import { jobArgsDigest } from "./external-jobs";
import { ENGINE_LEVELS } from "./schema-gate";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(level: number = ENGINE_LEVELS.jobs) {
  const store = new Store();
  stores.push(store);
  store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', ?)", [String(level)]);
  const director = store.createBot({ name: "Director", duties: "cut", boundaries: "none" });
  const plan = store.openTask({ sessionId: director.direct_session.id, title: "EP01" });
  const ticket = store.createTicket({ taskId: plan.id, title: "Shots", worker: director.bot.id });
  return { store, director: director.bot, dm: director.direct_session.id, plan, ticket };
}
type Fixture = ReturnType<typeof fixture>;
const at = (ms: number) => new Date(Date.parse("2026-10-03T08:00:00.000Z") + ms).toISOString();

function job(f: Fixture, requestId: string, opts: { args?: Record<string, unknown>; partNo?: number | null; now?: string; ticketId?: string | null; botId?: string } = {}) {
  return f.store.registerJob({ server: "cpa", submitTool: "mcp_cpa_submit_video", checkTool: "mcp_cpa_check_video", idParam: "job_id", requestId,
    digest: jobArgsDigest("cpa", "submit_video", opts.args ?? { prompt: requestId }), taskId: f.plan.id,
    ticketId: opts.ticketId === undefined ? f.ticket.id : opts.ticketId, partNo: opts.partNo ?? null,
    botId: opts.botId ?? f.director.id, workItemId: null, turnId: null, sessionId: f.dm, now: opts.now ?? at(0) });
}

test("the same arguments within half an hour are the job already started, whatever their key order; not after", () => {
  const f = fixture();
  const first = job(f, "j-1", { args: { prompt: "Shot 05", seconds: 8 } });
  const digest = jobArgsDigest("cpa", "submit_video", { seconds: 8, prompt: "Shot 05" });
  expect(f.store.recentJob(digest, at(29 * 60_000))?.id).toBe(first.id);
  expect(f.store.recentJob(digest, at(31 * 60_000))).toBeNull();
  expect(f.store.recentJob(jobArgsDigest("cpa", "submit_video", { prompt: "Shot 06", seconds: 8 }), at(60_000))).toBeNull();
});

test("a part is held while its job runs, and after it until its result is handed over", () => {
  const f = fixture();
  const running = job(f, "j-5", { partNo: 5 });
  expect(f.store.partJob(f.ticket.id, 5)?.id).toBe(running.id);
  expect(f.store.partJob(f.ticket.id, 6)).toBeNull();
  f.store.recordJobPoll(running.id, { state: "completed", statusText: "completed", result: "url: https://x/shot_05.mp4" }, at(60_000));
  expect(f.store.partJob(f.ticket.id, 5)?.state).toBe("completed");
  f.store.db.run(`INSERT INTO submissions (id, task_id, ticket_id, part_keys, bot_id, origin, artifacts, state, created_at, updated_at)
    VALUES ('s-5', ?, ?, '[]', ?, 'submit', ?, 'submitted', ?, ?)`, [f.plan.id, f.ticket.id, f.director.id, JSON.stringify([{ path: "work/x/shot_05.mp4", sha256: "a" }]), at(120_000), at(120_000)]);
  expect(f.store.partJob(f.ticket.id, 5)).toBeNull();
});

test("the daemon asks with a growing gap, wakes every waiter once it is done, and gives up after three hours", () => {
  const f = fixture();
  const done = job(f, "j-1");
  expect(f.store.claimDueJobs(at(10_000))).toEqual([]);
  expect(f.store.claimDueJobs(at(30_000)).map((row) => row.id)).toEqual([done.id]);
  // Claimed: not asked again before the next gap (a minute) is up.
  expect(f.store.claimDueJobs(at(60_000))).toEqual([]);
  expect(f.store.claimDueJobs(at(91_000)).map((row) => row.id)).toEqual([done.id]);
  const reviewer = f.store.createBot({ name: "Reviewer", duties: "review", boundaries: "none" }).bot;
  const room = f.store.createGroup({ name: "Studio", members: [f.director.id, reviewer.id] }).id;
  f.store.addJobWaiter(done.id, { bot_id: f.director.id, work_item_id: null, session_id: room });
  f.store.addJobWaiter(done.id, { bot_id: f.director.id, work_item_id: null, session_id: room });
  f.store.recordJobPoll(done.id, { state: "pending", statusText: "running", result: null }, at(91_000));
  expect(f.store.getJob(done.id)).toMatchObject({ state: "pending", status_text: "running" });
  f.store.recordJobPoll(done.id, { state: "completed", statusText: "completed", result: "url: https://x/v.mp4" }, at(200_000));
  const told = f.store.db.query<{ session_id: string; body: string }, [string]>("SELECT session_id, body_snapshot AS body FROM inbox_items WHERE bot_id = ? AND source = 'job' ORDER BY seq").all(f.director.id);
  expect(told.map((row) => row.session_id).sort()).toEqual([f.dm, room].sort());
  expect(told[0]!.body).toContain("https://x/v.mp4");

  const stale = job(f, "j-2", { now: at(0) });
  f.store.recordJobPoll(stale.id, { state: "pending", statusText: "running", result: null }, at(3 * 60 * 60_000 + 1));
  expect(f.store.getJob(stale.id)?.state).toBe("lost");
});

test("from level 6 a check-back is for real waits: five minutes or more, six an hour, never to poll a job the daemon polls", () => {
  const f = fixture();
  const book = (note: string, afterMinutes: number) => () => f.store.scheduleCheckBack({ botId: f.director.id, sessionId: f.dm, turnId: null, note, afterMinutes, now: new Date(isoNow()) });
  expect(book("看看", 1)).toThrow("at least 5");
  job(f, "render-77");
  expect(book("看 render-77 渲好没有", 5)).toThrow("already polls job render-77");
  for (let n = 0; n < 6; n += 1) book(`等编剧回复 ${n}`, 5)();
  expect(book("再等等", 5)).toThrow("in the last hour");

  const low = fixture(ENGINE_LEVELS.submissions);
  expect(() => low.store.scheduleCheckBack({ botId: low.director.id, sessionId: low.dm, turnId: null, note: "看看", afterMinutes: 1 })).not.toThrow();
});

test("while a render runs on a ticket the ball is the job poller's, so nobody is called back to poll it", () => {
  const f = fixture();
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toMatchObject({ kind: "owner" });
  const running = job(f, "j-9");
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "app", reason: "job", ref: running.id });
  f.store.recordJobPoll(running.id, { state: "completed", statusText: "completed", result: null }, at(60_000));
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toMatchObject({ kind: "owner" });
});

test("a render its Bot started on the job as a whole, from a segment on no ticket, holds the ball too; another Bot's does not", () => {
  const f = fixture();
  const other = f.store.createBot({ name: "Editor", duties: "cut", boundaries: "none" }).bot;
  job(f, "j-other", { ticketId: null, botId: other.id });
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toMatchObject({ kind: "owner" });
  const running = job(f, "j-plan", { ticketId: null });
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toEqual({ kind: "app", reason: "job", ref: running.id });
  f.store.recordJobPoll(running.id, { state: "completed", statusText: "completed", result: null }, at(60_000));
  expect(f.store.ballHolder({ ticketId: f.ticket.id })).toMatchObject({ kind: "owner" });
});

test("a job whose check no longer answers is given up after three hours like any other, keeping what it last said", async () => {
  const f = fixture();
  const gone = job(f, "j-gone", { now: new Date(Date.now() - 3 * 60 * 60_000 - 60_000).toISOString() });
  f.store.recordJobPoll(gone.id, { state: "pending", statusText: "running", result: null }, new Date(Date.now() - 2 * 60 * 60_000).toISOString());
  const { createJobPoller } = await import("../engine/jobs");
  const pending: Promise<unknown>[] = [];
  const poller = createJobPoller({ store: f.store, track: (promise) => { pending.push(promise); return promise; }, dispatchQueued: () => {}, log: () => {},
    mcp: { call: async () => ({ ok: false, error: { code: "failed", message: "unknown tool: mcp_cpa_check_video" } }) } as never });
  poller.poll(new Date());
  await Promise.all(pending);
  expect(f.store.getJob(gone.id)).toMatchObject({ state: "lost", status_text: "running" });
  expect(f.store.db.query("SELECT body_snapshot AS body FROM inbox_items WHERE bot_id = ? AND source = 'job'").get(f.director.id))
    .toMatchObject({ body: expect.stringContaining("三个小时还没完成") });
});

test("from level 6 the hourly cap is per job, and a booking a stop suspended does not count", () => {
  const f = fixture();
  const other = f.store.openTask({ sessionId: f.dm, title: "EP02" });
  const turnOn = (taskId: string) => {
    const trigger = f.store.insertMessage({ sessionId: f.dm, kind: "system", author: f.director.id, body: "工作" });
    return f.store.createTurn({ sessionId: f.dm, botId: f.director.id, triggerMessageId: trigger.id, taskId, ticketId: null }).id;
  };
  const first = turnOn(f.plan.id);
  const book = (turnId: string, n: number) => () => f.store.scheduleCheckBack({ botId: f.director.id, sessionId: f.dm, turnId, note: `等编剧回复 ${n}`, afterMinutes: 5 });
  for (let n = 0; n < 6; n += 1) book(first, n)();
  expect(book(first, 7)).toThrow("in the last hour");
  f.store.setTurnStatus(first, "completed");
  const second = turnOn(other.id);
  expect(book(second, 8)).not.toThrow();
  f.store.setTurnStatus(second, "completed");
  const third = turnOn(f.plan.id);
  f.store.db.run("UPDATE check_backs SET suspended_at = ? WHERE task_id = ?", [isoNow(), f.plan.id]);
  expect(book(third, 9)).not.toThrow();
});

test("a job on a ticket its lead dropped since wakes nobody back onto that ticket: its result is heard with the job's next work", () => {
  // IG MV, 2026-10-09 01:50: a 2D video job finishing woke the director on the 2D ticket after the job
  // had turned to 3D, and the 3D work it did next was filed under that ticket for five hours.
  const f = fixture();
  const running = job(f, "j-2d");
  f.store.db.run("UPDATE tickets SET status = 'parked', stage = 'dropped', dropped_why = '改成 3D' WHERE id = ?", [f.ticket.id]);
  f.store.recordJobPoll(running.id, { state: "completed", statusText: "completed", result: "url: https://x/2d.mp4" }, at(60_000));
  const told = f.store.db.query<{ wakes: number; body: string; work_item_id: string }, [string]>(
    "SELECT wakes, body_snapshot AS body, work_item_id FROM inbox_items WHERE bot_id = ? AND source = 'job'").all(f.director.id);
  expect(told).toHaveLength(1);
  expect(told[0]!.wakes).toBe(0);
  expect(told[0]!.body).toContain("这张任务已经作废");
  expect(f.store.db.query<{ ticket_id: string | null }, [string]>("SELECT ticket_id FROM work_items WHERE id = ?").get(told[0]!.work_item_id)!.ticket_id).toBeNull();
});
