/**
 * I2 (ADR 0040): the database refuses a live turn a hold covers, whoever writes it. The engine asks
 * first (wake-gate.test.ts); these are for a writer that did not: the two places a turn row is
 * written, an older build's insert with no mode, and a live turn moved into a hold's cover in place.
 * The one turn a hold lets open is the read-only one a line of yours opens to answer you.
 */
import { describe, expect, test } from "bun:test";
import type { HoldScope } from "@real-bot/protocol";
import { Store } from ".";
import { HttpError } from "../errors";
import { isoNow, ulid } from "../ids";
import { botPlanScopeId } from "./holds";

/** 视频导演 and 审片员 in a group with a plan and a ticket, and a Bot↔Bot direct on it. Holds are on. */
function fixture() {
  const store = new Store();
  store.raiseEngineLevel(null);
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const reviewer = store.createBot({ name: "审片员", duties: "审片", boundaries: "none" });
  const room = store.createGroup({ name: "片场", members: [director.bot.id, reviewer.bot.id] });
  const plan = store.openTask({ sessionId: room.id, title: "EP01" });
  const other = store.openTask({ sessionId: director.direct_session.id, title: "回响纪元" });
  const shot = store.createTicket({ taskId: plan.id, title: "Shot 11", spec: "", status: "doing", worker: director.bot.id });
  const thread = store.createBotDirect(director.bot.id, reviewer.bot.id, null);
  const line = (sessionId: string, author = reviewer.bot.id, turnId: string | null = null) =>
    store.insertMessage({ sessionId, turnId, kind: author === "user" ? "user" : "bot", author, body: `line ${ulid()}` });
  return { store, director: director.bot, reviewer: reviewer.bot, dm: director.direct_session, room, plan, other, shot, thread, line };
}

function refusal(work: () => unknown): { status: number; code: string } | null {
  try {
    work();
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, code: error.code };
    throw error;
  }
  return null;
}

const HELD = { status: 409, code: "held" };

describe("a turn a hold covers is not written", () => {
  test("for each scope, a turn it covers is refused and one beside it opens", () => {
    const f = fixture();
    const { store, director, reviewer, room, plan, other, shot, thread, dm, line } = f;
    // A turn of the director's whose lines a turn hold covers.
    const booking = store.createTurn({ sessionId: thread.id, botId: director.id, triggerMessageId: line(thread.id).id, taskId: other.id });
    store.setTurnStatus(booking.id, "completed");
    const cases: Array<{ scope: HoldScope; id: string | null; covered: () => unknown; beside: () => unknown }> = [
      {
        scope: "global",
        id: null,
        covered: () => store.createTurn({ sessionId: dm.id, botId: director.id, triggerMessageId: line(dm.id, "user").id }),
        beside: () => null,
      },
      {
        scope: "bot",
        id: director.id,
        covered: () => store.createTurn({ sessionId: thread.id, botId: director.id, triggerMessageId: line(thread.id).id }),
        beside: () => store.createTurn({ sessionId: thread.id, botId: reviewer.id, triggerMessageId: line(thread.id, director.id).id }),
      },
      {
        scope: "session",
        id: room.id,
        // The group's plan, worked on in a Bot↔Bot direct, is still the group's.
        covered: () => store.createTurn({ sessionId: thread.id, botId: reviewer.id, triggerMessageId: line(thread.id, director.id).id, taskId: plan.id }),
        beside: () => store.createTurn({ sessionId: thread.id, botId: reviewer.id, triggerMessageId: line(thread.id, director.id).id, taskId: other.id }),
      },
      {
        scope: "plan",
        id: plan.id,
        covered: () => store.createTurn({ sessionId: thread.id, botId: reviewer.id, triggerMessageId: line(thread.id, director.id).id, taskId: plan.id }),
        beside: () => store.createTurn({ sessionId: thread.id, botId: reviewer.id, triggerMessageId: line(thread.id, director.id).id, taskId: other.id }),
      },
      {
        scope: "ticket",
        id: shot.id,
        covered: () => store.createTurn({ sessionId: room.id, botId: director.id, triggerMessageId: line(room.id).id, taskId: plan.id, ticketId: shot.id }),
        beside: () => store.createTurn({ sessionId: room.id, botId: director.id, triggerMessageId: line(room.id).id, taskId: plan.id }),
      },
      {
        scope: "bot_plan",
        id: botPlanScopeId(director.id, plan.id),
        covered: () => store.createTurn({ sessionId: room.id, botId: director.id, triggerMessageId: line(room.id).id, taskId: plan.id }),
        beside: () => store.createTurn({ sessionId: room.id, botId: reviewer.id, triggerMessageId: line(room.id, director.id).id, taskId: plan.id }),
      },
      {
        scope: "turn",
        id: booking.id,
        // A line that turn wrote wakes nobody; another line of the same Bot's does.
        covered: () => store.createTurn({ sessionId: thread.id, botId: reviewer.id, triggerMessageId: line(thread.id, director.id, booking.id).id }),
        beside: () => store.createTurn({ sessionId: thread.id, botId: reviewer.id, triggerMessageId: line(thread.id, director.id).id }),
      },
    ];
    for (const { scope, id, covered, beside } of cases) {
      const hold = store.createHold({ scope, scopeId: id, source: "user_button" });
      const before = store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM turns`).get()!.n;
      expect({ scope, refused: refusal(covered) }).toEqual({ scope, refused: HELD });
      expect(store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM turns`).get()!.n).toBe(before);
      expect({ scope, refused: refusal(beside) }).toEqual({ scope, refused: null });
      store.liftHold(hold.id, { by: "user_button" });
      // Nothing a case opened stays live into the next one.
      for (const live of store.listLiveTurns()) store.setTurnStatus(live.id, "completed");
    }
    store.close();
  });

  test("a plan the turn would have opened for itself goes with it", () => {
    const { store, director, reviewer, line } = fixture();
    const quiet = store.createBotDirect(director.id, reviewer.id, null);
    store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });
    const plans = () => store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`).get()!.n;
    const before = plans();
    expect(refusal(() => store.createTurn({ sessionId: quiet.id, botId: director.id, triggerMessageId: line(quiet.id).id }))).toEqual(HELD);
    expect(plans()).toBe(before);
    store.close();
  });

  test("an older build's insert, with no mode, is refused the same: a stop comes before compatibility", () => {
    const { store, director, dm, line } = fixture();
    store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });
    const now = isoNow();
    expect(() =>
      store.db.run(
        `INSERT INTO turns (id, session_id, bot_id, status, trigger_message_id, last_activity_at, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
        [ulid(), dm.id, director.id, line(dm.id, "user").id, now, now, now],
      ),
    ).toThrow("held");
    // A row that is not live is none of the hold's business.
    store.db.run(
      `INSERT INTO turns (id, session_id, bot_id, status, trigger_message_id, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)`,
      [ulid(), dm.id, director.id, line(dm.id, "user").id, now, now, now],
    );
    store.close();
  });

  test("Continue, which writes its row without createTurn, is refused the same", () => {
    const { store, director, dm, line } = fixture();
    const cut = store.createTurn({ sessionId: dm.id, botId: director.id, triggerMessageId: line(dm.id, "user").id });
    const { note } = store.interruptTurnRecord(cut.id)!;
    store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });
    expect(refusal(() => store.claimInterruptContinue(note.id))).toEqual(HELD);
    expect(store.getMessage(note.id).source_turn_id).toBeNull();
    store.close();
  });
});

describe("the read-only turn a line of yours opens is the one a hold lets through", () => {
  test("opened on your line it is written; on a Bot's line it is not", () => {
    const { store, director, dm, thread, line } = fixture();
    store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });
    const answer = store.createTurn({ sessionId: dm.id, botId: director.id, triggerMessageId: line(dm.id, "user").id, mode: "readonly" });
    expect(answer).toMatchObject({ status: "running", mode: "readonly" });
    expect(refusal(() => store.createTurn({ sessionId: thread.id, botId: director.id, triggerMessageId: line(thread.id).id, mode: "readonly" }))).toEqual(HELD);
    store.close();
  });

  test("it cannot become a working turn, or move onto another plan, in place", () => {
    const { store, director, dm, other, line } = fixture();
    store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });
    const answer = store.createTurn({ sessionId: dm.id, botId: director.id, triggerMessageId: line(dm.id, "user").id, mode: "readonly" });
    expect(() => store.db.run(`UPDATE turns SET mode = 'work' WHERE id = ?`, [answer.id])).toThrow("held");
    expect(() => store.db.run(`UPDATE turns SET task_id = ? WHERE id = ?`, [other.id, answer.id])).toThrow("held");
    expect(store.getTurn(answer.id)).toMatchObject({ mode: "readonly", task_id: answer.task_id });
    // Everything else about a live turn still moves: touching it, and ending it.
    store.touchTurn(answer.id);
    store.setTurnStatus(answer.id, "completed");
    store.close();
  });

  test("a turn a hold names itself, as Stop on it does, is not moved onto another plan in place", () => {
    const { store, director, dm, plan, line } = fixture();
    const stopped = store.createTurn({ sessionId: dm.id, botId: director.id, triggerMessageId: line(dm.id, "user").id, taskId: plan.id });
    store.createHold({ scope: "turn", scopeId: stopped.id, source: "user_button" });
    expect(() => store.db.run(`UPDATE turns SET task_id = ? WHERE id = ?`, [plan.id, stopped.id])).toThrow("held");
    expect(() => store.db.run(`UPDATE turns SET mode = 'readonly' WHERE id = ?`, [stopped.id])).toThrow("held");
    expect(store.getTurn(stopped.id)).toMatchObject({ task_id: stopped.task_id, mode: "work" });
    store.close();
  });

  test("a working turn beside the hold is not moved into it in place either", () => {
    const { store, director, reviewer, thread, plan, other, line } = fixture();
    const turn = store.createTurn({ sessionId: thread.id, botId: reviewer.id, triggerMessageId: line(thread.id, director.id).id, taskId: other.id });
    store.createHold({ scope: "plan", scopeId: plan.id, source: "user_button" });
    expect(() => store.db.run(`UPDATE turns SET task_id = ? WHERE id = ?`, [plan.id, turn.id])).toThrow("held");
    store.setTurnStatus(turn.id, "completed");
    // An ended turn is history, and history can be refiled.
    store.db.run(`UPDATE turns SET task_id = ? WHERE id = ?`, [plan.id, turn.id]);
    store.close();
  });
});
