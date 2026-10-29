/**
 * A stop of yours holds the work there is when you say it, and a routine's later due time is not
 * that work: it is a new run your schedule asked for (2026-10-29: 「先停下」 in a direct kept two
 * dailies from firing for two days, until you next spoke to the Bot). So a stop on the Bot, or
 * Stop on a routine's run, ends the run going then and lets the next one fire; a stop on everything
 * (「停下所有 Bot」) and one on the routine's own plan still pause it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CompletionResult } from "./completions";
import type { Hold } from "@real-bot/protocol";
import { videoTeam } from "./scenarios/video-team";
import { call, createScenario, fileUnder, say, shell, type Scenario } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function scenario(): Promise<Scenario> {
  const h = await createScenario({ workItems: true });
  open.push(h);
  h.judge("read_filing").handle(fileUnder());
  return h;
}

/** `time` on the day `n` days from today, local. */
function day(n: number, time: string): Date {
  const at = new Date();
  at.setDate(at.getDate() + n);
  const [hour, minute] = time.split(":").map(Number);
  at.setHours(hour!, minute!, 0, 0);
  return at;
}

/** 视频导演's daily at 09:00, made three days ago so that yesterday's due time is one. */
function daily(h: Scenario, bot: { id: string }) {
  const routine = h.store.createRoutine({ bot_id: bot.id, title: "日报", instruction: "写今天的进度", schedule: { kind: "daily", time: "09:00" } });
  h.store.db.run(`UPDATE routines SET created_at = ? WHERE id = ?`, [day(-3, "08:00").toISOString(), routine.id]);
  return routine;
}

/** The routine's run for yesterday, stuck in a hop that never answers. */
async function yesterdaysRun(h: Scenario, bot: { id: string }, session: string, routine: { id: string }) {
  let mid = false;
  h.script(bot, session).reply(() => {
    mid = true;
    return new Promise<CompletionResult>(() => {});
  });
  const run = h.engine.fireRoutine(routine.id, day(-1, "09:05"))!;
  await h.waitFor(() => mid, { what: "the routine's run to be mid-hop" });
  return run;
}

function holds(h: Scenario): Hold[] {
  return h.store.listHolds().reverse();
}

describe("a routine under a stop of yours", () => {
  test("「先停下」 in the direct holds the Bot's work, not its routine: the next due time fires and the run does its work", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const routine = daily(h, director);
    h.postUser(dm, "先停下");
    await h.routed();
    await h.waitIdle();
    const [stop] = holds(h);
    expect(stop).toMatchObject({ scope: "bot", scope_id: director.id, source: "user_text", lifted_at: null });

    h.script(director, dm).reply(call(shell("printf ok > brief.md")), say("今天的进度写好了"));
    const run = h.engine.fireRoutine(routine.id, day(1, "09:05"));
    await h.waitIdle();

    expect(run?.routine_due_at).toBe(day(1, "09:00").toISOString());
    expect(h.sideEffectCalls(director).map((row) => row.name)).toEqual(["shell"]);
    expect(h.messages(dm).at(-1)!.body).toBe("今天的进度写好了");
    expect(h.suppressedWakes(director)).toEqual([]);
    // The stop still holds what it was about, until you next speak to the Bot.
    expect(h.store.getHold(stop!.id).lifted_at).toBeNull();
  });

  test("the run going when you say 「先停下」 is stopped with the rest, and the next due time fires all the same", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const routine = daily(h, director);
    const going = await yesterdaysRun(h, director, dm, routine);

    h.postUser(dm, "先停下");
    await h.routed();
    await h.waitIdle();
    const [stop] = holds(h);
    expect(h.store.getTurn(going.id).status).toBe("stopped");
    expect(stop!.effect.stopped_turns!.map((row) => row.turn_id)).toEqual([going.id]);

    h.script(director, dm).reply(say("今天的进度写好了"));
    const next = h.engine.fireRoutine(routine.id, day(1, "09:05"));
    await h.waitIdle();

    expect(next?.routine_due_at).toBe(day(1, "09:00").toISOString());
    expect(h.store.getTurn(next!.id).ticket_id).not.toBe(going.ticket_id);
    // The stopped run stays stopped: the routine's next run does not lift the stop.
    expect(h.store.getTurn(going.id).status).toBe("stopped");
    expect(h.store.getHold(stop!.id).lifted_at).toBeNull();
  });

  test("Stop on a routine's run holds that run only: the next due time fires", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const routine = daily(h, director);
    const going = await yesterdaysRun(h, director, dm, routine);

    h.engine.stop(going.id, { button: true });
    await h.waitIdle();
    const [stop] = holds(h);
    expect(stop).toMatchObject({ scope: "bot_plan", scope_id: `${director.id}:${h.store.routineTask(routine.id)!.id}` });

    h.script(director, dm).reply(say("今天的进度写好了"));
    const next = h.engine.fireRoutine(routine.id, day(1, "09:05"));
    await h.waitIdle();

    expect(next?.routine_due_at).toBe(day(1, "09:00").toISOString());
    expect(h.store.getTurn(going.id).status).toBe("stopped");
    expect(h.suppressedWakes(director)).toEqual([]);
  });

  test("a stop on everything, or on the routine's own plan, still pauses it", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const dm = h.direct(director);
    const routine = daily(h, director);
    h.script(director, dm).reply(say("昨天的进度写好了"));
    h.engine.fireRoutine(routine.id, day(-1, "09:05"));
    await h.waitIdle();
    const plan = h.store.routineTask(routine.id)!;

    h.postUser(room, "所有Bot停下");
    await h.routed();
    const onPlan = h.store.createHold({ scope: "plan", scopeId: plan.id, source: "user_button" });
    const everything = holds(h).find((row) => row.scope === "global")!;
    const onBot = h.store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });

    expect(h.engine.fireRoutine(routine.id, day(1, "09:05"))).toBeNull();
    expect(h.suppressedWakes(director).map((row) => row.payload.holds)).toEqual([[everything.id, onPlan.id]]);

    h.store.liftHold(everything.id, { by: "user_button" });
    expect(h.engine.fireRoutine(routine.id, day(1, "09:06"))).toBeNull();
    h.store.liftHold(onPlan.id, { by: "user_button" });
    h.script(director, dm).reply(say("今天的进度写好了"));
    expect(h.engine.fireRoutine(routine.id, day(1, "09:07"))?.routine_due_at).toBe(day(1, "09:00").toISOString());
    await h.waitIdle();
    expect(h.store.getHold(onBot.id).lifted_at).toBeNull();
  });
});
