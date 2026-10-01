/**
 * A stop of yours is obeyed on every way a Bot is woken (ADR 0040 I2) and on every call with an
 * effect (I3). Each wake path the engine has gets a test: with a hold covering it, no turn opens,
 * nothing is heard, anything booked is set aside for the lift, and the work log has a
 * `wake.suppressed` row naming the cause and the hold. The paths, and where each one wakes a Bot:
 *
 * 1. your line in a direct: the other side (participation, startTurn) — it opens a read-only turn instead
 * 2. your line in a group: the Bots it names (a read-only turn each), and the ones that would judge it (participation)
 * 3. a Bot's line in a Bot↔Bot direct or naming a Bot in a group (participation, hearOrStart)
 * 4. a held Bot's own line, waking somebody else (the same, through the line's author)
 * 5. a Bot's line for a Bot at work there, heard in its live turn (hearOrStart)
 * 6. your line filed under a plan, reaching its turns in other conversations (hearAcross)
 * 7. a turn that ended with lines unread, opening one more (reopenForUnheard)
 * 8. a check-back falling due (scheduler → fireCheckBack)
 * 9. a Bot↔Bot direct gone quiet, calling its opener back (direct-report)
 * 10. a quiet plan calling its Bot back (plan-watch)
 * 11. a routine's schedule (scheduler → fireRoutine)
 * 12. Continue on an interrupted turn (continueFromInterrupt)
 *
 * A status question wakes nobody at all, held or not (ADR 0040 P1), so it has no row here. Your
 * own line to a held Bot is not turned away but answered: it opens a read-only turn, which can read
 * and reply and nothing else (I2's one exemption), so it has no row either.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { CompletionResult } from "./completions";
import { HttpError } from "./errors";
import { ENGINE_LEVELS } from "./store/schema-gate";
import type { Hold, HoldScope } from "@real-bot/protocol";
import { openPlan, planSpec, videoTeam } from "./scenarios/video-team";
import { heardNote } from "./turn-inbox";
import { call, checkBack, createScenario, endTurn, media, requestText, say, sendMessage, shell, tool, writeFile, type Scenario } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function scenario(options?: Parameters<typeof createScenario>[0]): Promise<Scenario> {
  const h = await createScenario(options);
  open.push(h);
  return h;
}

/** Legacy phase 0–2 wake paths: raising holds mid-turn must not activate P4c end contracts
 * against the pre-work-item segment, or replace peer wakes/report-back with delegations. */
function hold(h: Scenario, scope: HoldScope, scopeId: string | null): Hold {
  if (h.store.capabilities().engine_level < ENGINE_LEVELS.holds) {
    for (const key of ["engine_level", "schema_min_compatible"]) {
      h.store.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(ENGINE_LEVELS.holds)]);
    }
  }
  return h.store.createHold({ scope, scopeId, source: "user_button" });
}

/** How the note a live turn hears a line in starts: the line reaching the turn, not just its transcript. */
const HEARD = heardNote("zh", []).split("\n")[0]!;

/** The wakes turned away for `bot`, as cause and holds. */
function suppressed(h: Scenario, bot: { id: string }) {
  return h.suppressedWakes(bot).map((row) => ({ cause: row.payload.cause, holds: row.payload.holds }));
}

/** A turn of `bot` in `session` in the middle of its first hop, answering `then` once `go` resolves. */
async function midHop(h: Scenario, bot: { id: string }, session: string, then: CompletionResult[], open: () => void) {
  const go = Promise.withResolvers<void>();
  let entered = false;
  h.script(bot, session).reply(async () => {
    entered = true;
    await go.promise;
    return then[0]!;
  }, ...then.slice(1));
  open();
  await h.waitFor(() => entered, { what: "the turn to be mid-hop" });
  return go;
}

test("current P4c peer notes have wakes=0 and neither wake a held Bot nor lift its hold", async () => {
  const h = await scenario({ delegation: true });
  const { director, reviewer, room } = videoTeam(h);
  const plan = openPlan(h, room, 'Current job', planSpec('Current job'));
  const thread = h.botDirect(director, reviewer);
  h.store.db.run('UPDATE sessions SET thread_task_id = ? WHERE id = ?', [plan.id, thread]);
  const stop = h.store.createHold({ scope: 'bot', scopeId: director.id, source: 'user_button' });
  const before = h.turns(director).length;
  const note = h.postBot(reviewer, thread, '@视频导演 这是无需唤醒的进度说明', { taskId: plan.id });
  await h.routed();
  await h.waitIdle();
  expect(h.store.capabilities().engine_level).toBe(ENGINE_LEVELS.delegation);
  expect(h.turns(director)).toHaveLength(before);
  expect(h.store.db.query<{ wakes: number; state: string }, [string]>("SELECT wakes, state FROM inbox_items WHERE message_id = ? AND source = 'peer_note'").all(note.id)).toEqual([{ wakes: 0, state: 'held' }]);
  expect(h.store.getHold(stop.id).lifted_at).toBeNull();
  expect(h.sideEffectCalls(director)).toEqual([]);
});

describe("legacy phase 0–2 holds turn every old wake away, and say so in the work log", () => {
  test("1. your line in a held Bot's direct opens only a read-only turn: it reads and answers, and does nothing else", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    hold(h, "bot", director.id);
    h.script(director, dm).reply(call(shell("ls"), tool("list_dir", { path: "." })), say("停着呢，恢复后换夜景"));

    h.postUser(dm, "第三镜换成夜景");
    await h.waitIdle();

    expect(h.turns(director).map(({ mode, status }) => ({ mode, status }))).toEqual([{ mode: "readonly", status: "completed" }]);
    // It is shown only what changes nothing, and told why; what it calls anyway is refused.
    const offered = (h.hops(director)[0]!.request.tools as Array<{ function: { name: string } }>).map((row) => row.function.name);
    expect(offered).toContain("list_dir");
    expect(offered).not.toContain("shell");
    expect(offered).not.toContain("send_message");
    expect(requestText(h.hops(director)[0]!.request)).toContain("这一段只能回答");
    expect(h.sideEffectCalls(director)).toEqual([]);
    expect(h.toolCalls(director, "shell").map((row) => row.result)).toEqual([{ ok: false, error: "held" }]);
    expect(h.messages(dm).at(-1)!.body).toBe("停着呢，恢复后换夜景");
    expect(suppressed(h, director)).toEqual([]);
  });

  test("2. your line in a group opens only a read-only turn for a held Bot it names, and a held Bot is not asked to judge it", async () => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const stop = hold(h, "bot", director.id);

    h.postUser(room, "@视频导演 第三镜换成夜景");
    await h.waitIdle();
    h.postUser(room, "大家看看第三镜");
    await h.waitIdle();

    expect(h.turns(director).map(({ mode }) => mode)).toEqual(["readonly"]);
    // The others were asked whether the second line was theirs; the held one was not.
    expect(h.judgeCalls("judgement").map((row) => row.botId).sort()).toEqual([reviewer.id, writer.id].sort());
    expect(suppressed(h, director)).toEqual([{ cause: "user_line", holds: [stop.id] }]);
  });

  test("3. a Bot's line in a Bot↔Bot direct, or naming a held Bot in a group, opens no turn", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const thread = h.botDirect(director, reviewer);
    const stop = hold(h, "bot", director.id);

    h.postBot(reviewer, thread, "Shot 11 分镜过了，开始生成");
    await h.waitIdle();
    h.postBot(reviewer, room, "@视频导演 Shot 11 可以开了");
    await h.waitIdle();

    expect(h.turns(director)).toEqual([]);
    expect(suppressed(h, director)).toEqual([
      { cause: "mention", holds: [stop.id] },
      { cause: "mention", holds: [stop.id] },
    ]);
  });

  test("4. a held Bot's line wakes nobody, in a direct or a group", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const thread = h.botDirect(director, reviewer);
    const stop = hold(h, "bot", director.id);

    h.postBot(director, thread, "Shot 11 交了，请审");
    await h.waitIdle();
    h.postBot(director, room, "@审片员 Shot 11 交了");
    await h.waitIdle();

    expect(h.turns(reviewer)).toEqual([]);
    expect(suppressed(h, reviewer)).toEqual([
      { cause: "mention", holds: [stop.id] },
      { cause: "mention", holds: [stop.id] },
    ]);
  });

  test("5. a line for a held Bot at work there is not heard in its live turn", async () => {
    const h = await scenario();
    const { director, reviewer } = videoTeam(h);
    const thread = h.botDirect(director, reviewer);
    // The turn goes on for one more hop after the one that is out, which is where a line it heard
    // would be read out. The line is in the direct's transcript either way.
    const go = await midHop(h, director, thread, [call(tool("list_dir", { path: "." })), say("在做")], () => {
      h.postBot(reviewer, thread, "Shot 11 分镜过了，开始生成");
    });
    const stop = hold(h, "bot", director.id);

    h.postBot(reviewer, thread, "机械臂改成左手");
    await h.routed();
    go.resolve();
    await h.waitIdle();

    expect(h.turns(director)).toHaveLength(1);
    const hops = h.hops(director);
    expect(hops).toHaveLength(2);
    expect(requestText(hops[1]!.request)).not.toContain(HEARD);
    expect(suppressed(h, director)).toEqual([{ cause: "mention", holds: [stop.id] }]);
  });

  test("6. your line filed under a plan does not reach a held Bot's turn on it in another conversation", async () => {
    const h = await scenario({ workItems: true });
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    // With work items on, the rows file this line without the organizer: EP01 has real work underway.
    h.store.createTicket({ taskId: ep01.id, title: "母带", status: "doing", worker: director.id });
    const thread = h.botDirect(director, reviewer);
    const go = await midHop(h, director, thread, [call(tool("list_dir", { path: "." })), say("在做")], () => {
      h.postBot(reviewer, thread, "EP01 母带按新的转场重新拼一遍", { taskId: ep01.id });
    });
    const [threadTurn] = h.turns(director);
    const stop = hold(h, "bot", director.id);
    const dm = h.direct(director);

    const line = h.postUser(dm, "EP01 片尾字幕换成白色");
    await h.routed();
    go.resolve();
    await h.waitIdle();

    expect(h.store.getMessage(line.id).task_id).toBe(ep01.id);
    // In your direct the line is answered by a read-only turn; the working one never hears it.
    expect(h.turns(director).map(({ id, mode }) => ({ id, mode }))).toEqual([
      { id: threadTurn!.id, mode: "work" },
      { id: expect.any(String), mode: "readonly" },
    ]);
    const second = h.hops(director).filter((hop) => hop.turnId === threadTurn!.id)[1]!;
    expect(requestText(second.request)).not.toContain(HEARD);
    // Not even in the quote layer of its situation (ADR 0040 P3), which every other turn on EP01
    // reads it in: a held turn reads what you said as it stood when the stop was made.
    expect(requestText(second.request)).not.toContain("片尾字幕换成白色");
    const wakes = h.suppressedWakes(director).map((row) => ({ cause: row.payload.cause, turn: row.turn_id, holds: row.payload.holds }));
    expect(wakes.filter((row) => row.cause === "heard_across")).toEqual([
      { cause: "heard_across", turn: threadTurn!.id, holds: [stop.id] },
    ]);
    // The real open ticket can also prompt a plan call-back; that wake must obey the same hold.
    for (const wake of wakes.filter((row) => row.cause !== "heard_across")) {
      expect(wake).toEqual({ cause: "plan_nudge", turn: null, holds: [stop.id] });
    }
  });

  test("7. a turn that ends with a line unread opens no turn for it under a hold", async () => {
    const h = await scenario();
    const { director, reviewer } = videoTeam(h);
    const thread = h.botDirect(director, reviewer);
    const go = await midHop(h, director, thread, [say("好")], () => {
      h.postBot(reviewer, thread, "Shot 11 分镜过了，开始生成");
    });
    // Heard while nothing held it; the turn then ends on this hop without reading it.
    h.postBot(reviewer, thread, "机械臂改成左手");
    await h.routed();
    const stop = hold(h, "bot", director.id);
    go.resolve();
    await h.waitIdle();

    expect(h.turns(director)).toHaveLength(1);
    expect(suppressed(h, director)).toEqual([{ cause: "unheard", holds: [stop.id] }]);
  });

  test("a check-back a turn heard and ended without reading is set aside for the lift, then fires with its line", async () => {
    const h = await scenario();
    const { director, reviewer } = videoTeam(h);
    const thread = h.botDirect(director, reviewer);
    h.script(director, thread).reply(call(checkBack(1, "看 Shot 11 渲染好没有"), endTurn()));
    h.postBot(reviewer, thread, "Shot 11 开始渲染");
    await h.waitIdle();
    const [booked] = h.store.listPendingCheckBacks(thread);
    // It falls due while the next turn is out on a hop, and is heard there; the turn then ends on
    // this hop without reading it, under a hold made meanwhile.
    const go = await midHop(h, director, thread, [say("好")], () => {
      h.postBot(reviewer, thread, "Shot 12 也开始了");
    });
    h.advance(2 * 60_000);
    await h.waitFor(() => h.store.getCheckBack(booked!.id).fired_at !== null, { what: "the check-back to be heard" });
    const line = h.store.getCheckBack(booked!.id).message_id;
    const stop = hold(h, "bot", director.id);
    go.resolve();
    await h.waitIdle();

    expect(h.turns(director)).toHaveLength(2);
    expect(h.store.getCheckBack(booked!.id)).toMatchObject({ fired_at: null, suspended_at: expect.any(String), message_id: line });
    expect(suppressed(h, director)).toEqual([{ cause: "unheard", holds: [stop.id] }]);

    h.store.liftHold(stop.id, { by: "user_button" });
    h.tick();
    await h.waitIdle();
    const woken = h.turns(director)[2];
    expect(woken?.trigger_message_id).toBe(line!);
    expect(h.store.getCheckBack(booked!.id)).toMatchObject({ fired_turn_id: woken!.id, message_id: line });
  });

  for (const heldLast of [true, false]) {
    test(`a turn that ends with lines unread asks the holds of each: it opens on the newest unheld one, with the held one ${heldLast ? "last" : "first"}`, async () => {
      const h = await scenario();
      const { director, reviewer, room } = videoTeam(h);
      const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
      const trailer = openPlan(h, room, "预告片", planSpec("预告片"));
      const thread = h.botDirect(director, reviewer);
      const go = await midHop(h, director, thread, [say("好")], () => {
        h.postBot(reviewer, thread, "我先看一下分镜");
      });
      // Both heard while nothing held them; the turn then ends on this hop without reading either.
      const onHeld = () => h.postBot(reviewer, thread, "EP01 片尾字幕换成白色", { taskId: ep01.id });
      const onTrailer = () => h.postBot(reviewer, thread, "预告片开头加一秒黑场", { taskId: trailer.id });
      const [first, second] = heldLast ? [onTrailer(), onHeld()] : [onHeld(), onTrailer()];
      await h.routed();
      const stop = hold(h, "plan", ep01.id);
      go.resolve();
      await h.waitIdle();

      const turns = h.turns(director);
      expect(turns).toHaveLength(2);
      expect(turns[1]).toMatchObject({ trigger_message_id: (heldLast ? first : second)!.id, task_id: trailer.id });
      expect(suppressed(h, director)).toEqual([{ cause: "unheard", holds: [stop.id] }]);
    });
  }

  test("a check-back about held work that a turn heard and ended without reading does not ride along into the turn that opens", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const trailer = openPlan(h, room, "预告片", planSpec("预告片"));
    const thread = h.botDirect(director, reviewer);
    h.script(director, thread).reply(call(checkBack(1, "看 EP01 母带渲染好没有"), endTurn()));
    h.postBot(reviewer, thread, "EP01 母带开始渲染", { taskId: ep01.id });
    await h.waitIdle();
    const [booked] = h.store.listPendingCheckBacks(thread);
    expect(booked).toMatchObject({ task_id: ep01.id });
    // It falls due while the next turn is out on a hop and is heard there, and so is a line about
    // the trailer; the turn then ends on this hop without reading either, under a hold on EP01.
    const go = await midHop(h, director, thread, [say("好")], () => {
      h.postBot(reviewer, thread, "我先看一下分镜");
    });
    h.advance(2 * 60_000);
    await h.waitFor(() => h.store.getCheckBack(booked!.id).fired_at !== null, { what: "the check-back to be heard" });
    const line = h.store.getCheckBack(booked!.id).message_id;
    const aboutTrailer = h.postBot(reviewer, thread, "预告片开头加一秒黑场", { taskId: trailer.id });
    await h.routed();
    const stop = hold(h, "plan", ep01.id);
    go.resolve();
    await h.waitIdle();

    const turns = h.turns(director);
    expect(turns).toHaveLength(3);
    expect(turns[2]).toMatchObject({ trigger_message_id: aboutTrailer.id, task_id: trailer.id });
    expect(h.hops(director).filter((hop) => hop.turnId === turns[2]!.id).some((hop) => requestText(hop.request).includes("看 EP01 母带渲染好没有"))).toBe(false);
    expect(h.store.getCheckBack(booked!.id)).toMatchObject({ fired_at: null, suspended_at: expect.any(String), message_id: line });
    expect(suppressed(h, director)).toEqual([{ cause: "unheard", holds: [stop.id] }]);

    h.store.liftHold(stop.id, { by: "user_button" });
    h.tick();
    await h.waitIdle();
    expect(h.turns(director)[3]?.trigger_message_id).toBe(line!);
  });

  test("8. a check-back that falls due under a hold is set aside for the lift, and fires nothing", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.script(director, dm).reply(call(checkBack(5, "看 EP01 母带导出好没有"), endTurn()));
    h.postUser(dm, "导出 EP01 母带");
    await h.waitIdle();
    const [booked] = h.store.listPendingCheckBacks(dm);
    const stop = hold(h, "bot", director.id);
    // The hold set it aside as it was made. One it did not — booked by a build from before holds,
    // say — is caught when it falls due.
    expect(h.store.getCheckBack(booked!.id).suspended_at).not.toBeNull();
    h.store.db.run(`UPDATE check_backs SET suspended_at = NULL, voided_at = NULL WHERE id = ?`, [booked!.id]);

    h.advance(6 * 60_000);
    await h.waitIdle();

    expect(h.turns(director)).toHaveLength(1);
    expect(h.store.getCheckBack(booked!.id)).toMatchObject({ fired_at: null, suspended_at: expect.any(String) });
    expect(h.messages(dm).filter((message) => message.kind === "system")).toEqual([]);
    expect(suppressed(h, director)).toEqual([{ cause: "check_back", holds: [stop.id] }]);
  });

  test("9. a Bot↔Bot direct gone quiet under a hold on the other Bot calls its opener back to nothing", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const kickoff = h.postUser(room, "@视频导演 EP01 开工");
    h.script(director, room).reply(call(endTurn()));
    await h.waitIdle();
    const thread = h.botDirect(director, reviewer, { sessionId: room, messageId: kickoff.id });
    const go = await midHop(h, reviewer, thread, [say("Shot 11 过了")], () => {
      h.postBot(director, thread, "Shot 11 交了，请审");
    });
    const stop = hold(h, "bot", reviewer.id);
    go.resolve();
    await h.waitIdle();

    expect(h.turns(director).filter((turn) => turn.session_id !== room || turn.trigger_message_id !== kickoff.id)).toEqual([]);
    expect(h.store.listPendingCheckBacks(room)).toEqual([]);
    expect(h.store.db.query(`SELECT 1 FROM check_backs WHERE cause = 'delegation'`).all()).toEqual([]);
    // The reviewer's answer woke nobody in the thread, and its going quiet called nobody back.
    expect(suppressed(h, director)).toEqual([
      { cause: "mention", holds: [stop.id] },
      { cause: "report_back", holds: [stop.id] },
    ]);
  });

  test("a Bot↔Bot direct gone quiet under a hold on its opener keeps the report-back for the lift", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const kickoff = h.postUser(room, "@视频导演 EP01 开工");
    h.script(director, room).reply(call(endTurn()));
    await h.waitIdle();
    const thread = h.botDirect(director, reviewer, { sessionId: room, messageId: kickoff.id });
    const go = await midHop(h, reviewer, thread, [say("Shot 11 过了")], () => {
      h.postBot(director, thread, "Shot 11 交了，请审");
    });
    const stop = hold(h, "bot", director.id);
    go.resolve();
    await h.waitIdle();

    expect(h.turns(director)).toHaveLength(1);
    const kept = () => h.store.db.query<{ id: string; suspended_at: string | null; fired_turn_id: string | null }, []>(`SELECT id, suspended_at, fired_turn_id FROM check_backs WHERE cause = 'delegation'`).all();
    expect(kept()).toEqual([{ id: expect.any(String), suspended_at: expect.any(String), fired_turn_id: null }]);
    expect(suppressed(h, director)).toEqual([
      { cause: "mention", holds: [stop.id] },
      { cause: "report_back", holds: [stop.id] },
    ]);

    h.store.liftHold(stop.id, { by: "user_button" });
    h.tick();
    await h.waitIdle();
    const back = h.turns(director)[1];
    expect(back?.session_id).toBe(room);
    expect(kept()).toEqual([{ id: expect.any(String), suspended_at: null, fired_turn_id: back!.id }]);
  });

  test("10. a quiet plan with work left does not call a held Bot back, and books nothing", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const echo = openPlan(h, room, "回响纪元", planSpec("未来世界短片《回响纪元》"));
    h.store.createTicket({ taskId: echo.id, title: "Shot 12", status: "todo", worker: director.id });
    const stop = hold(h, "bot", director.id);

    // 审片员's turn on the plan ends, the plan goes quiet with Shot 12 still to do.
    h.postUser(room, "@审片员 Shot 11 看一眼");
    await h.waitIdle();

    expect(h.turns(reviewer)).toHaveLength(1);
    expect(h.turns(director)).toEqual([]);
    expect(h.store.lastPlanNudge(echo.id)).toBeNull();
    expect(suppressed(h, director)).toEqual([{ cause: "plan_nudge", holds: [stop.id] }]);
  });

  test("11. a routine due under a hold is recorded once, fires nothing, and fires once for its latest due time after the lift", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const routine = h.store.createRoutine({ bot_id: director.id, title: "日报", instruction: "写今天的进度", schedule: { kind: "daily", time: "09:00" } });
    const day = (n: number, time: string) => {
      const at = new Date();
      at.setDate(at.getDate() + n);
      const [hour, minute] = time.split(":").map(Number);
      at.setHours(hour!, minute!, 0, 0);
      return at;
    };
    const stop = hold(h, "bot", director.id);

    // Every scheduler tick asks again; tomorrow's and the day after's due times go by held.
    expect(h.engine.fireRoutine(routine.id, day(1, "09:05"))).toBeNull();
    expect(h.engine.fireRoutine(routine.id, day(1, "09:06"))).toBeNull();
    expect(h.engine.fireRoutine(routine.id, day(2, "09:05"))).toBeNull();
    expect(h.turns(director)).toEqual([]);
    expect(suppressed(h, director)).toEqual([
      { cause: "routine", holds: [stop.id] },
      { cause: "routine", holds: [stop.id] },
    ]);

    h.store.liftHold(stop.id, { by: "user_button" });
    const fired = h.engine.fireRoutine(routine.id, day(2, "09:10"));
    await h.waitIdle();
    expect(fired?.routine_due_at).toBe(day(2, "09:00").toISOString());
    expect(h.turns(director)).toHaveLength(1);
  });

  test("12. Continue on a held Bot's interrupted turn answers held and opens nothing, until the hold is lifted", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const line = h.store.postMessage(dm, { body: "导出 EP01 母带" });
    const cut = h.store.createTurn({ sessionId: dm, botId: director.id, triggerMessageId: line.id });
    const { note } = h.store.interruptTurnRecord(cut.id)!;
    const stop = hold(h, "bot", director.id);

    let refused: unknown = null;
    try {
      h.engine.continueFromInterrupt(note.id);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(HttpError);
    expect(refused).toMatchObject({ status: 409, code: "held" });
    expect(h.turns(director).map((turn) => turn.id)).toEqual([cut.id]);
    expect(suppressed(h, director)).toEqual([{ cause: "continue", holds: [stop.id] }]);

    h.store.liftHold(stop.id, { by: "user_button" });
    const continued = h.engine.continueFromInterrupt(note.id);
    await h.waitIdle();
    expect(continued.trigger_message_id).toBe(note.id);
  });

  test("a hold on one plan turns away only the wakes about that plan", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const echo = openPlan(h, room, "回响纪元", planSpec("未来世界短片《回响纪元》"));
    const stop = hold(h, "plan", ep01.id);
    const heldThread = h.botDirect(director, reviewer);
    const freeThread = h.botDirect(director, reviewer);

    h.postBot(reviewer, heldThread, "EP01 母带按新的转场重新拼一遍", { taskId: ep01.id });
    h.postBot(reviewer, freeThread, "《回响纪元》Shot 11 可以开了", { taskId: echo.id });
    await h.waitIdle();

    expect(h.turns(director).map((turn) => turn.task_id)).toEqual([echo.id]);
    expect(suppressed(h, director)).toEqual([{ cause: "mention", holds: [stop.id] }]);
  });

  test("a turn a plan hold covers does not hear a line about another plan; that line opens a turn of its own", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const echo = openPlan(h, room, "回响纪元", planSpec("未来世界短片《回响纪元》"));
    const thread = h.botDirect(director, reviewer);
    const go = await midHop(h, director, thread, [call(tool("list_dir", { path: "." })), say("在做")], () => {
      h.postBot(reviewer, thread, "EP01 母带按新的转场重新拼一遍", { taskId: ep01.id });
    });
    const [held] = h.turns(director);
    hold(h, "plan", ep01.id);

    h.postBot(reviewer, thread, "《回响纪元》Shot 11 可以开了", { taskId: echo.id });
    await h.routed();
    go.resolve();
    await h.waitIdle();

    // The held turn was neither handed the line (it is in the direct's transcript either way) nor
    // redirected for it: the new turn opened beside it.
    const second = h.hops(director).filter((hop) => hop.turnId === held!.id)[1];
    expect(requestText(second!.request)).not.toContain(HEARD);
    expect(h.turns(director).map((turn) => [turn.task_id, turn.status])).toEqual([
      [ep01.id, "completed"],
      [echo.id, "completed"],
    ]);
    expect(suppressed(h, director)).toEqual([]);
  });
});

describe("a turn a hold covers makes no call with an effect", () => {
  test("its shell, writes, messages and bookings come back refused and do nothing; reading still works", async () => {
    const h = await scenario();
    const { director, reviewer } = videoTeam(h);
    const thread = h.botDirect(director, reviewer);
    const go = await midHop(
      h,
      director,
      thread,
      [
        call(
          shell("printf master > EP01_MASTER.mp4"),
          writeFile("notes.md", "Shot 12"),
          sendMessage("Shot 12 交了", { session_id: thread }),
          checkBack(5, "看 Shot 12"),
          tool("list_dir", { path: "." }),
        ),
        call(endTurn()),
      ],
      () => {
        h.postBot(reviewer, thread, "Shot 11 分镜过了，开始生成");
      },
    );
    hold(h, "bot", director.id);
    go.resolve();
    await h.waitIdle();

    const results = h.hops(director)[1]!.request.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(String(message.content)) as { ok: boolean; error?: { code: string } });
    expect(results.map((result) => (result.ok ? "ok" : result.error!.code))).toEqual(["held", "held", "held", "held", "ok"]);
    expect(existsSync(join(h.root, "EP01_MASTER.mp4"))).toBe(false);
    expect(h.runs(director)).toEqual([]);
    expect(h.messages(thread).filter((message) => message.author === director.id)).toEqual([]);
    expect(h.store.listPendingCheckBacks()).toEqual([]);
    expect(h.sideEffectCalls(director)).toEqual([]);
  });

  test("a message whose closing check is out when the hold is made does not go out", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const go = await midHop(
      h,
      director,
      thread,
      [call(sendMessage("EP01 母带交了", { session_id: room, paths: ["EP01_MASTER.mp4"] })), call(endTurn())],
      () => {
        h.postBot(reviewer, thread, "EP01 母带按新的转场重新拼一遍", { taskId: ep01.id });
      },
    );
    // The closing check looks up the turn's plan once it is under way: the hold is made right then.
    const taskOfTurn = h.store.taskOfTurn;
    let armed = true;
    const spy = spyOn(h.store, "taskOfTurn").mockImplementation((turnId) => {
      if (armed) hold(h, "plan", ep01.id);
      armed = false;
      return taskOfTurn(turnId);
    });
    go.resolve();
    await h.waitIdle();
    spy.mockRestore();

    expect(armed).toBe(false);
    expect(h.messages(room).filter((message) => message.author === director.id)).toEqual([]);
    const results = h.hops(director)[1]!.request.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(String(message.content)) as { ok: boolean; error?: { code: string } });
    expect(results.map((result) => (result.ok ? "ok" : result.error!.code))).toEqual(["held"]);
  });

  test("an MCP tool its server marks read-only still runs; one that makes something does not", async () => {
    const h = await scenario({ media: true });
    const { director, reviewer } = videoTeam(h);
    const thread = h.botDirect(director, reviewer);
    const go = await midHop(
      h,
      director,
      thread,
      [call(media("check_video", { job_id: "fixture-video" }), media("submit_video", { prompt: "Shot 12" })), call(endTurn())],
      () => {
        h.postBot(reviewer, thread, "看看 Shot 11 渲染好没有");
      },
    );
    hold(h, "bot", director.id);
    go.resolve();
    await h.waitIdle();

    expect(h.mcpCalls(director).map((row) => row.tool)).toEqual(["check_video"]);
  });

  test("a call waiting on your approval does not run once a hold covers its turn, even if you allow it", async () => {
    const h = await scenario();
    const { director, reviewer } = videoTeam(h);
    const thread = h.botDirect(director, reviewer);
    const outside = join(h.root, "..", `outside-${crypto.randomUUID()}.txt`);
    h.script(director, thread).reply(call(writeFile(outside, "Shot 12")), call(endTurn()));
    h.postBot(reviewer, thread, "把 Shot 12 的说明写到外面");
    await h.waitFor(() => h.store.listApprovals().some((row) => row.status === "pending"), { what: "the approval card" });
    hold(h, "bot", director.id);

    const card = h.store.listApprovals().find((row) => row.status === "pending")!;
    h.engine.resolveApproval(card.id, "allow_once");
    await h.waitIdle();

    expect(existsSync(outside)).toBe(false);
    const results = h.hops(director)[1]!.request.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(String(message.content)) as { ok: boolean; error?: { code: string } });
    expect(results.map((result) => (result.ok ? "ok" : result.error!.code))).toEqual(["held"]);
    expect(h.sideEffectCalls(director)).toEqual([]);
  });
});
