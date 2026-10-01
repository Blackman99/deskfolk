/**
 * What a restart cut off, told where you will see it (ADR 0041, engine/restart.ts): why the daemon
 * started again, read from how the last run ended and how this one runs; one line per job in the
 * conversation it belongs to where you are, with one notification; 继续 continues each of its turns
 * the way its own Continue would, 不续 leaves them. Nothing goes on by itself. The incident replay is
 * scenarios/restart-mid-job.test.ts; these pin each piece.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Message, Turn } from "@real-bot/protocol";
import type { CompletionResult } from "./completions";
import { classifyRestart } from "./engine/restart";
import { isoNow } from "./ids";
import { restartNoticeBody } from "./prompts";
import { Quiesce } from "./quiesce";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { openPlan, planSpec, videoTeam } from "./scenarios/video-team";
import { call, createScenario, endTurn, shell, type Scenario, type ScenarioOptions } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function scenario(options: ScenarioOptions = {}): Promise<Scenario> {
  const h = await createScenario({ durable: true, ...options });
  open.push(h);
  return h;
}

/** A turn of `bot` in `session` stuck in a hop that never answers, after `before`. */
async function atWork(h: Scenario, bot: { id: string }, session: string, start: () => void, before: CompletionResult[] = []): Promise<Turn> {
  let mid = false;
  h.script(bot, session).reply(...before, () => {
    mid = true;
    return new Promise<CompletionResult>(() => {});
  });
  start();
  await h.waitFor(() => mid, { what: "the turn to be mid-hop" });
  return h.store.listLiveTurns({ sessionId: session, botId: bot.id })[0]!;
}

/** The app's restart notices in `session`, oldest first. */
function notices(h: Scenario, session: string): Message[] {
  return h.messages(session).filter((message) => message.control?.kind === "restart");
}

function notification(h: Scenario, key: string) {
  return h.store.db
    .query<{ kind: string; session_id: string; action_state: string; resolution_reason: string | null }, [string]>(
      `SELECT kind, session_id, action_state, resolution_reason FROM notifications WHERE semantic_key = ?`,
    )
    .get(key);
}

function turnsAfter(h: Scenario, bot: { id: string }, at: string): Turn[] {
  return h.turns(bot).filter((turn) => turn.created_at > at);
}

describe("why the daemon started again", () => {
  test("a development run's restart is dev whatever the last run wrote; otherwise a deliberate stop is clean, and the rest a crash", () => {
    const plain = { execArgv: [], env: {} };
    expect(classifyRestart("clean", plain)).toBe("clean");
    // `bun --watch` sends SIGTERM before it restarts in place, and that stop writes `clean`.
    expect(classifyRestart("clean", { execArgv: ["--watch"], env: {} })).toBe("dev");
    expect(classifyRestart("crash", plain)).toBe("crash");
    expect(classifyRestart("crash", { execArgv: ["--watch"], env: {} })).toBe("dev");
    expect(classifyRestart("crash", { execArgv: ["--hot"], env: {} })).toBe("dev");
    expect(classifyRestart("crash", { execArgv: [], env: { REAL_BOT_DEV: "1" } })).toBe("dev");
    expect(classifyRestart("crash", { execArgv: [], env: { REAL_BOT_DEV: "0" } })).toBe("crash");
  });

  test("the notice says which, and that nothing goes on by itself", () => {
    const turns = [{ bot: "视频导演", plan: "任务 06《母带》", where: "视频导演和审片员的私聊", lastStep: "ffmpeg -i shots.txt EP01.mp4" }];
    expect(restartNoticeBody("zh", { cause: "crash", plan: "EP01", turns })).toBe(
      "守护进程意外退出后重新启动了，「EP01」这件事中断了：视频导演 · 任务 06《母带》 · 在「视频导演和审片员的私聊」 · 最后一步：ffmpeg -i shots.txt EP01.mp4。\n" +
        "不会自己接着做：点「继续」从断的地方接着做，点「不续」就先放着。",
    );
    expect(restartNoticeBody("zh", { cause: "dev", plan: null, turns: [{ bot: "视频导演", plan: null, where: null, lastStep: null }] })).toStartWith(
      "开发版守护进程重新启动了，这里的工作中断了：视频导演 · 没有规划的一段。",
    );
    expect(restartNoticeBody("en", { cause: "clean", plan: "EP01", turns })).toBe(
      'The daemon was stopped and has started again; the plan "EP01" was cut off: 视频导演 · 任务 06《母带》 · in 视频导演和审片员的私聊 · last step: ffmpeg -i shots.txt EP01.mp4.\n' +
        "Nothing picks up on its own: Continue picks each up from where it stopped; Leave it keeps it as it is.",
    );
  });
});

describe("after a restart", () => {
  test("a development run's restart is told as one, and nothing starts until you press a button", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "母带重新拼一遍", { taskId: ep01.id }), [
      call(shell("printf cut > EP01_MASTER.mp4")),
    ]);
    const downAt = isoNow();

    await h.restart({ clean: false, dev: true });
    await h.waitIdle();

    const [notice] = notices(h, room);
    expect(notice).toMatchObject({ kind: "system", author: director.id, control: { kind: "restart", cause: "dev", offer: ["resume", "leave"] } });
    expect(notice!.body).toStartWith("开发版守护进程重新启动了，「EP01」这件事中断了：视频导演 · 规划「EP01」 · 在「视频导演和审片员的私聊」 · 最后一步：printf cut > EP01_MASTER.mp4");
    // It points at the turn's own 「中断」 line, which is what 继续 goes from.
    const note = h.messages(thread).find((message) => message.body === "中断")!;
    expect(notice!.control).toMatchObject({ notes: [note.id] });
    expect(note.turn_id).toBe(turn.id);
    expect(h.store.listWorkEvents({ kind: "daemon.restart" }).map((row) => row.payload)).toEqual([{ cause: "dev", cut: [turn.id], boot_id: expect.any(String) }]);
    expect(turnsAfter(h, director, downAt)).toEqual([]);
  });

  test("a clean stop's cut work is told the same way, named as a stop", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    await atWork(h, director, thread, () => h.postBot(reviewer, thread, "母带重新拼一遍", { taskId: ep01.id }));
    const downAt = isoNow();

    await h.restart({ clean: true });
    await h.waitIdle();

    const [notice] = notices(h, room);
    expect(notice!.control).toMatchObject({ kind: "restart", cause: "clean" });
    expect(notice!.body).toStartWith("守护进程停下后重新启动了，「EP01」这件事中断了");
    expect(notification(h, `restart:${notice!.id}`)).toMatchObject({ kind: "interrupted", session_id: room, action_state: "open" });
    expect(turnsAfter(h, director, downAt)).toEqual([]);
  });

  test("继续 continues every turn the restart cut off in the job, from its 「中断」 line; a second press does nothing more", async () => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const cutting = h.botDirect(director, reviewer);
    const boarding = h.botDirect(writer, reviewer);
    const first = await atWork(h, director, cutting, () => h.postBot(reviewer, cutting, "母带重新拼一遍", { taskId: ep01.id }));
    const second = await atWork(h, writer, boarding, () => h.postBot(reviewer, boarding, "第三场分镜改成夜景", { taskId: ep01.id }));
    await h.restart({ clean: false });
    await h.waitIdle();
    h.script(director, cutting).reply(call(endTurn()));
    h.script(writer, boarding).reply(call(endTurn()));

    const [notice] = notices(h, room);
    expect(notices(h, room)).toHaveLength(1);
    expect(notice!.body).toContain("视频导演 · 规划「EP01」 · 在「视频导演和审片员的私聊」");
    expect(notice!.body).toContain("编剧分镜师 · 规划「EP01」 · 在「编剧分镜师和审片员的私聊」");
    const pressedAt = isoNow();
    expect(h.engine.control(notice!.id, { action: "resume" })).toEqual({ made: [], lifted: [] });
    await h.waitIdle();

    const notes = h.store.getMessage(notice!.id).control;
    expect(notes).toMatchObject({ acted: ["resume"] });
    const [cutNote, boardNote] = notice!.control!.kind === "restart" ? notice!.control!.notes : [];
    expect(turnsAfter(h, director, pressedAt).map((turn) => [turn.trigger_message_id, turn.task_id])).toEqual([[cutNote, ep01.id]]);
    expect(turnsAfter(h, writer, pressedAt).map((turn) => [turn.trigger_message_id, turn.task_id])).toEqual([[boardNote, ep01.id]]);
    expect(h.store.getMessage(cutNote!).turn_id).toBe(first.id);
    expect(h.store.getMessage(boardNote!).turn_id).toBe(second.id);
    expect(notification(h, `restart:${notice!.id}`)).toMatchObject({ action_state: "resolved", resolution_reason: "continued" });

    h.engine.control(notice!.id, { action: "resume" });
    await h.waitIdle();
    expect(turnsAfter(h, director, pressedAt)).toHaveLength(1);
    expect(turnsAfter(h, writer, pressedAt)).toHaveLength(1);
  });

  test("不续 leaves the work as it is; its own 「中断」 line can still continue it", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    await atWork(h, director, thread, () => h.postBot(reviewer, thread, "母带重新拼一遍", { taskId: ep01.id }));
    await h.restart({ clean: false });
    await h.waitIdle();
    const [notice] = notices(h, room);
    const pressedAt = isoNow();

    h.engine.control(notice!.id, { action: "leave" });
    await h.waitIdle();

    expect(h.store.getMessage(notice!.id).control).toMatchObject({ acted: ["leave"] });
    expect(notification(h, `restart:${notice!.id}`)).toMatchObject({ action_state: "resolved", resolution_reason: "left" });
    expect(turnsAfter(h, director, pressedAt)).toEqual([]);
    // Answered once: 继续 pressed afterwards (a second tap, a stale page) does nothing more.
    expect(h.engine.control(notice!.id, { action: "resume" })).toEqual({ made: [], lifted: [] });
    await h.waitIdle();
    expect(turnsAfter(h, director, pressedAt)).toEqual([]);
    expect(() => h.engine.control(notice!.id, { action: "stop" })).toThrow();
    h.script(director, thread).reply(call(endTurn()));
    const note = notice!.control!.kind === "restart" ? notice!.control!.notes[0]! : "";
    expect(h.engine.continueFromInterrupt(note).trigger_message_id).toBe(note);
  });

  test("work cut where you are has one notification, the notice's, beside its 「中断」 line", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const plan = openPlan(h, dm, "片头", planSpec("片头动画"));
    const turn = await atWork(h, director, dm, () => h.postUser(dm, "把片头做出来"));
    expect(turn.task_id).toBe(plan.id);

    await h.restart({ clean: false });
    await h.waitIdle();

    const lines = h.messages(dm).filter((message) => message.kind === "system");
    expect(lines.map((message) => message.body === "中断" || message.control?.kind === "restart")).toEqual([true, true]);
    const [notice] = notices(h, dm);
    // Where it ran is where the notice is, so the turn is not named with a place.
    expect(notice!.body).toContain("：视频导演 · 规划「片头」。");
    expect(notification(h, `interrupted:${turn.id}`)).toMatchObject({ action_state: "voided", resolution_reason: "restart_notice" });
    expect(notification(h, `restart:${notice!.id}`)).toMatchObject({ session_id: dm, action_state: "open" });
  });

  test("a stop over the job refuses 继续 until you lift it", async () => {
    const h = await scenario({ holds: true });
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    await atWork(h, director, thread, () => h.postBot(reviewer, thread, "母带重新拼一遍", { taskId: ep01.id }));
    await h.restart({ clean: false });
    await h.waitIdle();
    const [notice] = notices(h, room);
    const hold = h.engine.createHold({ scope: "bot", scopeId: director.id });
    const pressedAt = isoNow();

    expect(() => h.engine.control(notice!.id, { action: "resume" })).toThrow(expect.objectContaining({ status: 409, code: "held" }));
    expect(h.store.getMessage(notice!.id).control).not.toHaveProperty("acted");
    expect(turnsAfter(h, director, pressedAt)).toEqual([]);

    h.engine.liftHold(hold.id);
    h.script(director, thread).reply(call(endTurn()));
    h.engine.control(notice!.id, { action: "resume" });
    await h.waitIdle();
    expect(turnsAfter(h, director, pressedAt)).toHaveLength(1);
  });

  test("a stop over some of the job's turns lets 继续 take the rest, says how many it holds, and 继续 takes those after the lift", async () => {
    const h = await scenario({ holds: true });
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const cutting = h.botDirect(director, reviewer);
    const boarding = h.botDirect(writer, reviewer);
    await atWork(h, director, cutting, () => h.postBot(reviewer, cutting, "母带重新拼一遍", { taskId: ep01.id }));
    await atWork(h, writer, boarding, () => h.postBot(reviewer, boarding, "第三场分镜改成夜景", { taskId: ep01.id }));
    await h.restart({ clean: false });
    await h.waitIdle();
    const [notice] = notices(h, room);
    const hold = h.engine.createHold({ scope: "bot", scopeId: director.id });
    h.script(writer, boarding).reply(call(endTurn()));
    const pressedAt = isoNow();

    expect(h.engine.control(notice!.id, { action: "resume" })).toEqual({ made: [], lifted: [], partial: { continued: 1, held: 1 } });
    await h.waitIdle();
    expect(turnsAfter(h, writer, pressedAt)).toHaveLength(1);
    expect(turnsAfter(h, director, pressedAt)).toEqual([]);
    // Not answered yet: the held turn is still the notice's to go on with.
    expect(h.store.getMessage(notice!.id).control).not.toHaveProperty("acted");
    expect(notification(h, `restart:${notice!.id}`)).toMatchObject({ action_state: "open" });
    // Pressed again under the same stop: nothing new goes on, and the stop says why.
    expect(() => h.engine.control(notice!.id, { action: "resume" })).toThrow(expect.objectContaining({ status: 409, code: "held" }));

    h.engine.liftHold(hold.id);
    h.script(director, cutting).reply(call(endTurn()));
    expect(h.engine.control(notice!.id, { action: "resume" })).toEqual({ made: [], lifted: [] });
    await h.waitIdle();
    expect(turnsAfter(h, director, pressedAt)).toHaveLength(1);
    expect(turnsAfter(h, writer, pressedAt)).toHaveLength(1);
    expect(h.store.getMessage(notice!.id).control).toMatchObject({ acted: ["resume"] });
    expect(notification(h, `restart:${notice!.id}`)).toMatchObject({ action_state: "resolved", resolution_reason: "continued" });
  });

  test("继续 after every turn went on from its own 「中断」 line does nothing more, and succeeds", async () => {
    const h = await scenario({ holds: true });
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const cutting = h.botDirect(director, reviewer);
    const boarding = h.botDirect(writer, reviewer);
    await atWork(h, director, cutting, () => h.postBot(reviewer, cutting, "母带重新拼一遍", { taskId: ep01.id }));
    await atWork(h, writer, boarding, () => h.postBot(reviewer, boarding, "第三场分镜改成夜景", { taskId: ep01.id }));
    await h.restart({ clean: false });
    await h.waitIdle();
    const [notice] = notices(h, room);
    const notes = notice!.control!.kind === "restart" ? notice!.control!.notes : [];
    h.script(director, cutting).reply(call(endTurn()));
    h.script(writer, boarding).reply(call(endTurn()));
    for (const note of notes) h.engine.continueFromInterrupt(note);
    await h.waitIdle();
    // A stop made since does not turn the press into a refusal: there is nothing left for it to hold.
    h.engine.createHold({ scope: "bot", scopeId: director.id });
    const pressedAt = isoNow();

    expect(h.engine.control(notice!.id, { action: "resume" })).toEqual({ made: [], lifted: [] });
    await h.waitIdle();
    expect(turnsAfter(h, director, pressedAt)).toEqual([]);
    expect(turnsAfter(h, writer, pressedAt)).toEqual([]);
    expect(h.store.getMessage(notice!.id).control).toMatchObject({ acted: ["resume"] });
  });

  test("a job homed in a Bot↔Bot direct is told in the conversation that direct was opened from, else in your direct with the Bot", async () => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const origin = h.store.postMessage(room, { body: "你们俩对一下台词" });
    const opened = h.botDirect(director, reviewer, { sessionId: room, messageId: origin.id });
    const loose = h.botDirect(writer, reviewer);
    // A line in a Bot↔Bot direct with no job of its own opens one there, where you are not.
    const fromRoom = await atWork(h, director, opened, () => h.postBot(reviewer, opened, "先对第一场"));
    const fromNowhere = await atWork(h, writer, loose, () => h.postBot(reviewer, loose, "第二场也对一下"));
    expect([h.store.getTask(fromRoom.task_id!).session_id, h.store.getTask(fromNowhere.task_id!).session_id]).toEqual([opened, loose]);

    await h.restart({ clean: false });
    await h.waitIdle();

    expect(notices(h, room).map((message) => message.body.split("\n")[0])).toEqual([
      "守护进程意外退出后重新启动了，「先对第一场」这件事中断了：视频导演 · 规划「先对第一场」 · 在「视频导演和审片员的私聊」。",
    ]);
    expect(notices(h, h.direct(writer)).map((message) => message.body.split("\n")[0])).toEqual([
      "守护进程意外退出后重新启动了，「第二场也对一下」这件事中断了：编剧分镜师 · 规划「第二场也对一下」 · 在「编剧分镜师和审片员的私聊」。",
    ]);
  });

  test("a later restart does not tell again about work an earlier one cut off", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    await atWork(h, director, thread, () => h.postBot(reviewer, thread, "母带重新拼一遍", { taskId: ep01.id }));
    await h.restart({ clean: false });
    await h.waitIdle();
    expect(notices(h, room)).toHaveLength(1);

    await h.restart({ clean: false, dev: true });
    await h.waitIdle();

    expect(notices(h, room)).toHaveLength(1);
    expect(h.store.listWorkEvents({ kind: "daemon.restart" }).map((row) => row.payload)).toEqual([
      { cause: "crash", cut: [expect.any(String)], boot_id: expect.any(String) },
      { cause: "dev", cut: [], boot_id: expect.any(String) },
    ]);
  });

  test("a forced drain you call off ends its turns without a restart to tell of", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "母带重新拼一遍", { taskId: ep01.id }));
    const quiesce = new Quiesce(h.store, h.engine, h.admission, null);

    quiesce.force();
    quiesce.cancel();
    await h.waitIdle();
    expect(h.store.getTurn(turn.id).status).toBe("interrupted");

    await h.restart({ clean: true });
    await h.waitIdle();
    expect(notices(h, room)).toEqual([]);
  });
});

describe("which shutdown a boot tells of", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  /** A database file, and a way to open it the way a run of the daemon does. */
  function database() {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-restart-"));
    dirs.push(dir);
    const keys = memoryKeyStore();
    return { open: () => new Store({ filename: join(dir, "state.sqlite"), endpointKey: keys }) };
  }

  /** A turn of a fresh Bot, running in its direct. */
  function working(store: Store, name: string): Turn {
    const bot = store.createBot({ name, duties: "write", boundaries: "stay" });
    const trigger = store.postMessage(bot.direct_session.id, { body: "go" });
    return store.createTurn({ sessionId: bot.direct_session.id, botId: bot.bot.id, triggerMessageId: trigger.id });
  }

  /** A run's deliberate end: what is live is noted as cut off by it, then interrupted. */
  function quit(store: Store): void {
    store.noteTurnsCutByShutdown();
    store.interruptRunningTurns();
    store.close();
  }

  /** A boot: recovery, then what the last shutdown cut off. */
  function boot(store: Store): string[] {
    store.recoverInterruptedTurns();
    return store.takeTurnsCutByRestart().map((row) => row.turn.id);
  }

  test("the boot right after a run's end tells of it, once", () => {
    const db = database();
    const first = db.open();
    const turn = working(first, "Writer");
    quit(first);

    const next = db.open();
    expect(boot(next)).toEqual([turn.id]);
    expect(next.takeTurnsCutByRestart()).toEqual([]);
    next.close();
  });

  test("a record another run left behind is not told by a later boot under its own cause", () => {
    const db = database();
    const first = db.open();
    working(first, "Writer");
    quit(first);
    // A run that opened the database and ended before telling anything (it died during boot).
    db.open().close();

    const later = db.open();
    expect(boot(later)).toEqual([]);
    // Dropped, not kept for another time.
    expect(later.db.query(`SELECT 1 FROM settings WHERE key = '_cut_by_shutdown'`).get()).toBeNull();
    later.close();
  });

  test("an older copy of the app that worked in between makes the record stale, and only what its own end cut off is told", () => {
    const db = database();
    const first = db.open();
    const firstRun = first.bootId;
    working(first, "Writer");
    quit(first);
    // An installed copy too old to know the record: it leaves the last run's id alone, starts a
    // turn of its own and dies with it running.
    const older = db.open();
    older.db.run(`UPDATE settings SET value = ? WHERE key = '_last_run'`, [firstRun]);
    const its = working(older, "Editor");
    older.close();

    const later = db.open();
    expect(later.previousBootId).toBe(firstRun);
    expect(boot(later)).toEqual([its.id]);
    later.close();
  });
});
