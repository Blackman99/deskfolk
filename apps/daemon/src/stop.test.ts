/**
 * Your stops and go-ons carried out (ADR 0040 P2, engine/stop.ts): a line that is only a stop makes
 * holds and ends the work they cover at once, with no model call; the app's receipt says what
 * happened, from the holds' own record; a go on lifts them and opens the stopped work again on a
 * note; a line that only might be control is delivered as usual, carrying the buttons; Stop on a
 * turn's card holds that Bot's work in the plan until you next speak about it, keeping the
 * appointments it made for then instead of cancelling them. Fixture F-a
 * (scenarios/f-a-stop.test.ts) replays the incident; these pin each piece.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CompletionResult } from "./completions";
import type { ClientEvent, Hold } from "@real-bot/protocol";
import { openPlan, planSpec, videoTeam } from "./scenarios/video-team";
import { call, checkBack, createScenario, endTurn, fileUnder, requestText, say, sendMessage, shell, tool, type Scenario, type ScenarioOptions } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

// These control-plane regressions pin P4b (level 2): P4c delegation and end contracts are
// exercised separately in delegation-engine.test.ts, not silently enabled by future bumps.
async function scenario(options: ScenarioOptions = { workItems: true }): Promise<Scenario> {
  const h = await createScenario(options);
  open.push(h);
  // Where a line of yours belongs is a model's reading (ADR 0057); here it reads a line as about
  // the one job it was shown, as these lines are, and leaves it unplaced among several.
  h.judge("read_filing").handle(fileUnder());
  return h;
}

/** A turn of `bot` in `session` stuck in a hop that never answers, after `before` (booking a look back, say). */
async function atWork(h: Scenario, bot: { id: string }, session: string, open: () => void, before: CompletionResult[] = []) {
  let mid = false;
  h.script(bot, session).reply(...before, () => {
    mid = true;
    return new Promise<CompletionResult>(() => {});
  });
  open();
  await h.waitFor(() => mid, { what: "the turn to be mid-hop" });
  return h.store.listLiveTurns({ sessionId: session, botId: bot.id })[0]!;
}

/** The lines after `line` in `session`, as kind and body. */
function after(h: Scenario, session: string, line: { created_at: string }) {
  return h.messages(session).filter((message) => message.created_at > line.created_at);
}

function holds(h: Scenario): Hold[] {
  return h.store.listHolds().reverse();
}

describe("a stop line", () => {
  test("makes a hold of yours, ends every turn it covers, sets its appointments aside and says so, on one reading", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }), [
      call(checkBack(5, "看母带导出好没有"), shell("printf cut > EP01_MASTER.mp4")),
    ]);
    const dm = h.direct(director);

    const startedAt = Date.now();
    const stop = h.postUser(dm, "你手头的生成停一下");
    await h.routed();
    await h.waitIdle();

    const [hold] = holds(h);
    expect(hold).toMatchObject({ scope: "bot", scope_id: director.id, source: "user_text", source_message_id: stop.id, lifted_at: null });
    expect(h.store.getTurn(turn.id).status).toBe("stopped");
    // ADR 0040 benchmark S asks for quiet within ten seconds; here it is one write.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // What it was doing when it stopped, for the receipt and for going on later.
    expect(hold!.effect.stopped_turns).toEqual([
      {
        turn_id: turn.id,
        bot_id: director.id,
        session_id: thread,
        task_id: ep01.id,
        ticket_id: null,
        written: [expect.stringMatching(/EP01_MASTER\.mp4$/)],
        recent: ["check_back", "shell printf cut > EP01_MASTER.mp4"],
      },
    ]);
    const booked = h.store.getCheckBack(hold!.effect.suspended_check_backs![0]!);
    expect(booked.turn_id).toBe(turn.id);
    expect(booked.suspended_at).not.toBeNull();
    expect(hold!.effect.still_running).toEqual([]);
    // Read once for what it says (ADR 0055), and nothing else: no organizer, no judgement, no turn.
    // Where it belongs is read beside it, and is not waited on.
    expect(h.judgeCalls().filter((row) => row.at > stop.created_at).map((row) => row.kind).filter((kind) => kind !== "read_filing")).toEqual(["read_user_line"]);
    expect(h.hops().filter((hop) => hop.sessionId === dm)).toEqual([]);
    // The receipt: the app's line, kept from the Bots, from the hold's record.
    const [receipt] = after(h, dm, stop);
    expect(receipt).toMatchObject({ kind: "system", author: director.id });
    expect(receipt!.control).toEqual({
      kind: "receipt",
      verb: "stop",
      hold_ids: [hold!.id],
      offer: ["undo", "stop_all"],
      scopes: [{ scope: "bot", id: director.id }],
      // A stop on the whole Bot can be narrowed to the plan its stopped work was in.
      plans: [{ offer: "only_plan", task_id: ep01.id, title: "EP01" }],
    });
    expect(receipt!.body).toContain("已停下视频导演的全部工作");
    expect(receipt!.body).toContain("你手头的生成停一下");
    expect(receipt!.body).toContain("EP01");
    expect(receipt!.body).toContain("最后一步：shell printf cut > EP01_MASTER.mp4");
    expect(receipt!.body).toContain("挂起 1 个回看");
    expect(receipt!.body).toContain("此刻在跑：无");
    expect(h.store.listMainMessages(dm, 20).map((message) => message.id)).not.toContain(receipt!.id);
    expect(h.store.listWorkEvents({ kind: "control.hold" }).map((row) => row.payload)).toEqual([
      { hold: hold!.id, scope: "bot", scope_id: director.id, source: "user_text", stopped: [turn.id] },
    ]);
  });

  test("reaches the work the Bot handed on and has not had back, not the other Bot's own work", async () => {
    const h = await scenario();
    const { director, reviewer } = videoTeam(h);
    const dm = h.direct(director);
    const thread = h.botDirect(director, reviewer);
    let reviewing = false;
    h.script(reviewer, thread).reply(() => {
      reviewing = true;
      return new Promise<CompletionResult>(() => {});
    });
    // 视频导演 hands Shot 11 to 审片员 from your direct; 审片员 is at it in their direct.
    h.script(director, dm).reply(call(sendMessage("Shot 11 请审", { session_id: thread })));
    h.postUser(dm, "把 Shot 11 交给审片员");
    await h.waitFor(() => reviewing, { what: "审片员 to be reviewing" });
    const handedOn = h.store.listLiveTurns({ botId: reviewer.id })[0]!;
    // Meanwhile 审片员 does something of yours in its own direct.
    const own = await atWork(h, reviewer, h.direct(reviewer), () => h.postUser(h.direct(reviewer), "整理一下审片记录"));

    const stop = h.postUser(dm, "停下你所有的工作");
    await h.routed();

    const [hold] = holds(h);
    expect(hold!.targets).toEqual([{ scope: "turn", id: handedOn.id }]);
    expect(h.store.getTurn(handedOn.id).status).toBe("stopped");
    expect(h.store.getTurn(own.id).status).toBe("running");
    expect(after(h, dm, stop)[0]!.body).toContain("审片员");
  });

  test("said to a group with nobody named holds the group: its plans park, its turns end wherever they run", async () => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const onPlan = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const inRoom = await atWork(h, writer, room, () => h.postUser(room, "@编剧分镜师 第三场改成夜景"));

    const stop = h.postUser(room, "大家先停一下");
    await h.routed();

    const [hold] = holds(h);
    expect(hold).toMatchObject({ scope: "session", scope_id: room });
    expect(h.store.getTask(ep01.id).status).toBe("parked");
    expect([onPlan, inRoom].map((turn) => h.store.getTurn(turn.id).status)).toEqual(["stopped", "stopped"]);
    const receipt = after(h, room, stop).find((message) => message.kind === "system")!;
    expect(receipt.body).toContain("已停下这里的工作");
    expect(receipt.body).toContain("搁置：EP01");
  });

  test("「你」 in a group, answering a Bot's line, holds that Bot and the group: two holds, one receipt", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const line = h.postBot(director, room, "Shot 11 交了");
    await h.waitIdle();

    const stop = h.postUser(room, "你停下", { parentId: line.id });
    await h.routed();

    expect(holds(h).map(({ scope, scope_id }) => ({ scope, scope_id }))).toEqual([
      { scope: "bot", scope_id: director.id },
      { scope: "session", scope_id: room },
    ]);
    const receipts = after(h, room, stop).filter((message) => message.kind === "system");
    expect(receipts.map((message) => message.control?.kind)).toEqual(["receipt"]);
    expect(receipts[0]!.body).toContain("视频导演的全部工作、这里的工作");
  });

  test("before the engine level brings holds, goes where any line goes", async () => {
    const h = await scenario({});
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.script(director, dm).reply(say("好的，停了"));

    h.postUser(dm, "停下你所有的工作");
    await h.waitIdle();

    expect(holds(h)).toEqual([]);
    expect(h.turns(director).map(({ mode }) => mode)).toEqual(["work"]);
  });
});

describe("a go on", () => {
  test("lifts your stop on the Bot and wakes it where you said it, about that job: it goes on and says so itself, and the app writes nothing", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }), [
      call(checkBack(30, "看母带导出好没有"), shell("printf cut > EP01_MASTER.mp4")),
    ]);
    const dm = h.direct(director);
    h.postUser(dm, "你手头的生成停一下");
    await h.routed();
    h.script(director, dm).reply(say("好，母带接着拼"));

    const go = h.postUser(dm, "继续");
    await h.waitIdle();

    const [hold] = holds(h);
    expect(hold).toMatchObject({ lifted_by: "user_text", lifted_message_id: go.id });
    expect(h.store.listWorkEvents({ kind: "control.lift" }).map((row) => row.payload)).toEqual([{ hold: hold!.id, by: "user_text", go_on: true }]);
    // Your line is what wakes it, on the job it is filed under, where you said it; the work it was
    // at there is the Bot's to go on with, so nothing else opens beside it.
    const opened = h.turns(director).filter((row) => row.created_at > go.created_at);
    expect(opened.map(({ session_id, task_id, mode, trigger_message_id }) => ({ session_id, task_id, mode, trigger_message_id }))).toEqual([
      { session_id: dm, task_id: ep01.id, mode: "work", trigger_message_id: go.id },
    ]);
    expect(hold!.effect.resumed_turns).toBeUndefined();
    // Its appointment is back on the clock.
    expect(h.store.getCheckBack(hold!.effect.suspended_check_backs![0]!)).toMatchObject({ suspended_at: null, voided_at: null });
    // The Bot answers you; the app says nothing in its place.
    expect(after(h, dm, go).filter((message) => message.kind === "system")).toEqual([]);
    expect(h.messages(dm).at(-1)).toMatchObject({ author: director.id, body: "好，母带接着拼" });
  });

  test("never opens a job of its own, even read as new work: a go on is never new work", async () => {
    // 2026-10-09: 「继续」 after a stop at the desk was read as new work, and the desk opened a job named 「继续」.
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.postUser(dm, "停下你所有的工作");
    await h.routed();
    h.judge("read_filing").reply({ about: "new" });
    h.script(director, dm).reply(call(shell("printf ok > primes.py")), say("接着写好了"));

    const go = h.postUser(dm, "继续");
    await h.waitIdle();

    expect(h.store.db.query("SELECT title FROM tasks").all()).toEqual([]);
    expect(h.turns(director).map(({ task_id, trigger_message_id }) => ({ task_id, trigger_message_id }))).toEqual([{ task_id: null, trigger_message_id: go.id }]);
  });

  test("on a job it was not stopped on leaves that stop where it is: 「继续」 about one job never lifts a stop on another", async () => {
    // 2026-10-09: 「继续」 in 视频导演's direct, about the MV it had stopped on, lifted its old stop on
    // 《一拳超人》 instead, opened nothing there, and the MV stayed where it was.
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const dm = h.direct(director);
    const mv = openPlan(h, dm, "MV", planSpec("IG 2018 MV"));
    const opm = openPlan(h, room, "一拳超人", planSpec("《一拳超人》动画"));
    const onOpm = h.engine.createHold({ scope: "bot_plan", scopeId: `${director.id}:${opm.id}` });
    h.script(director, dm).reply(say("好，接着做第二段"));

    const go = h.store.postMessage(dm, { body: "继续" });
    h.store.fileMessage(go.id, { explicit: [{ taskId: mv.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(go.id), { fromUser: true });
    await h.waitIdle();

    expect(h.store.getHold(onOpm.id).lifted_at).toBeNull();
    expect(h.store.listWorkEvents({ kind: "control.lift" })).toEqual([]);
    expect(h.turns(director).map(({ session_id, task_id, trigger_message_id }) => ({ session_id, task_id, trigger_message_id }))).toEqual([
      { session_id: dm, task_id: mv.id, trigger_message_id: go.id },
    ]);
    expect(after(h, dm, go).filter((message) => message.kind === "system")).toEqual([]);
  });

  test("the reader's go on alone moves anything: the word lists' reading of 「继续」 lifts nothing, and the Bot gets the line", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const hold = h.engine.createHold({ scope: "bot_plan", scopeId: `${director.id}:${ep01.id}` });
    // The reader could not read it: its answer is no reading, so the word lists read the line.
    h.judge("read_user_line").reply("not json");
    const dm = h.direct(director);
    h.script(director, dm).reply(say("这件事还被你叫停着，要在回执上解除"));

    const go = h.postUser(dm, "继续");
    await h.waitIdle();

    expect(h.store.getHold(hold.id).lifted_at).toBeNull();
    expect(h.store.getMessage(go.id).taken_as ?? null).toBeNull();
    expect(h.turns(director).map(({ trigger_message_id }) => trigger_message_id)).toEqual([go.id]);
    expect(after(h, dm, go).filter((message) => message.kind === "system")).toEqual([]);
  });

  test("on another job opens the work the stop ended there again, where it was, on a note for that Bot alone", async () => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(reviewer, writer);
    const turn = await atWork(h, reviewer, thread, () => h.postBot(writer, thread, "EP01 第三镜审一下", { taskId: ep01.id }), [
      call(shell("printf ok > EP01_REVIEW.md")),
    ]);
    h.postUser(room, "所有Bot停下");
    await h.routed();
    const [everything] = holds(h);
    const dm = h.direct(director);
    h.script(director, dm).reply(say("收到"));
    const committed: ClientEvent[] = [];
    const unsubscribe = h.store.onCommit((event) => committed.push(event));
    const published = h.events.length;
    // The work opens again and stays mid-hop, so the note is still the newest line in its direct.
    let woke = null as string | null;
    h.script(reviewer, thread).reply(({ request }) => {
      woke = requestText(request);
      return new Promise<CompletionResult>(() => {});
    });

    const go = h.postUser(dm, "所有Bot继续");
    await h.waitFor(() => woke !== null, { what: "the stopped work to open again" });
    unsubscribe();

    expect(h.store.getHold(everything!.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: go.id });
    const [resumed] = h.turns(reviewer).filter((row) => row.created_at > go.created_at);
    expect(resumed).toMatchObject({ session_id: thread, task_id: ep01.id, mode: "work" });
    expect(h.store.getHold(everything!.id).effect.resumed_turns).toEqual([resumed!.id]);
    const note = h.store.getMessage(resumed!.trigger_message_id);
    expect(note).toMatchObject({ kind: "system", author: reviewer.id, turn_id: turn.id });
    expect(note.body).toContain("「所有Bot继续」");
    expect(note.body).toContain("shell printf ok > EP01_REVIEW.md");
    for (const push of ["接着干", "接着推进", "接着做"]) expect(note.body).not.toContain(push);
    // The turn it wakes reads it, as what woke it.
    expect(woke).toContain("（本轮触发）\n（应用提示）用户叫停了这件工作，现在解除了（原话：「所有Bot继续」）。");
    // Nothing else does: the conversation and the phone, the other Bot's transcript, the organizer,
    // search, the unread badge, the list's last line and the event stream leave it out, as they
    // leave out a check-back's own line.
    expect(h.store.listMessages(thread).items.map((message) => message.id)).not.toContain(note.id);
    expect(h.store.listMainMessages(thread, 20).map((message) => message.id)).not.toContain(note.id);
    expect(h.store.taskMessagesSince(ep01.id, "1970-01-01T00:00:00.000Z").map((message) => message.id)).not.toContain(note.id);
    expect(h.store.search("用户叫停了这件工作").map((hit) => hit.id)).not.toContain(note.id);
    expect(h.store.unreadCount(thread)).toBe(h.store.listMessages(thread).items.filter((message) => message.author !== "user").length);
    expect(h.store.listSessions().find((session) => session.id === thread)?.last_message?.id).not.toBe(note.id);
    const shown = [...h.events.slice(published), ...committed];
    expect(shown.some((event) => (event.event === "message.created" || event.event === "message.upsert") && event.id === note.id)).toBe(false);
    // No receipt of the app's: the Bot you said it to answers.
    expect(after(h, dm, go).filter((message) => message.kind === "system")).toEqual([]);
    // The flow board still draws the work waking again from the turn the stop ended.
    expect(h.store.taskTrace(ep01.id).nodes.find((node) => node.turn_id === resumed!.id)?.woken_by_turn_id).toBe(turn.id);
  });

  test("to a Bot lifts a stop on its work in that job too, and the Bot goes on with it where you said it", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const hold = h.engine.createHold({ scope: "bot_plan", scopeId: `${director.id}:${ep01.id}` });
    const dm = h.direct(director);
    h.script(director, dm).reply(say("母带接着拼"));

    const go = h.postUser(dm, "继续");
    await h.waitIdle();

    expect(h.store.getHold(hold.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: go.id });
    expect(h.turns(director).filter((row) => row.created_at > go.created_at).map(({ session_id, task_id }) => ({ session_id, task_id }))).toEqual([
      { session_id: dm, task_id: ep01.id },
    ]);
  });

  test("with nothing held is an ordinary line: the Bot gets it", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.script(director, dm).reply(say("好，接下来做第四镜"));

    h.postUser(dm, "继续");
    await h.waitIdle();

    // No existing job was named: an ordinary line starts a read-only desk, not a fabricated plan.
    expect(h.turns(director).map(({ mode, task_id }) => ({ mode, task_id }))).toEqual([{ mode: "desk", task_id: null }]);
    expect(h.messages(dm).at(-1)!.body).toBe("好，接下来做第四镜");
  });

  test("a stop on everything is lifted by a go on that names everything, as its receipt says", async () => {
    const h = await scenario();
    const { room } = videoTeam(h);
    const stop = h.postUser(room, "所有Bot停下");
    await h.routed();
    const receipt = after(h, room, stop).find((message) => message.kind === "system")!;
    expect(receipt.body).toContain("已停下所有 Bot 的工作");
    expect(receipt.body).toContain("日程也暂停");
    expect(receipt.body).toContain("说「所有 Bot 继续」就解除");

    h.postUser(room, "所有 Bot 继续");
    await h.routed();

    expect(holds(h).map(({ scope, lifted_by }) => ({ scope, lifted_by }))).toEqual([{ scope: "global", lifted_by: "user_text" }]);
  });

  test("that lifts a stop on a Bot also lifts your Stop on the job it is about, and the Bot goes on from your line", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const plan = openPlan(h, dm, "片头", planSpec("片头动画"));
    const turn = await atWork(h, director, dm, () => h.postUser(dm, "做片头"), [call(shell("printf a > intro.mp4"))]);
    h.engine.stop(turn.id, { button: true });
    h.postUser(dm, "停下你所有的工作");
    await h.waitIdle();
    const [pressed, said] = holds(h);
    h.script(director, dm).reply(say("片头接着渲染"));

    const go = h.postUser(dm, "继续");
    await h.waitIdle();

    expect([pressed, said].map((hold) => h.store.getHold(hold!.id).lifted_message_id)).toEqual([go.id, go.id]);
    const opened = h.turns(director).filter((row) => row.created_at > go.created_at);
    expect(opened.map(({ session_id, task_id, trigger_message_id }) => ({ session_id, task_id, trigger_message_id }))).toEqual([
      { session_id: dm, task_id: plan.id, trigger_message_id: go.id },
    ]);
    expect(h.messages(dm).at(-1)!.body).toBe("片头接着渲染");
  });

  test("under a stop on everything it does not name gets the Bot's read-only answer, told the stop still holds; the app writes nothing", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    h.postUser(room, "所有Bot停下");
    await h.routed();
    const dm = h.direct(director);
    h.script(director, dm).reply(say("所有 Bot 都还被你叫停着，要在那条回执上解除"));

    const go = h.postUser(dm, "继续");
    await h.waitIdle();

    expect(holds(h).map(({ scope, lifted_at }) => ({ scope, lifted_at }))).toEqual([{ scope: "global", lifted_at: null }]);
    const [answer] = h.turns(director);
    expect(answer).toMatchObject({ trigger_message_id: go.id, mode: "readonly" });
    expect(requestText(h.hops(director)[0]!.request)).toContain("要在它的回执上解除");
    expect(after(h, dm, go).map((message) => message.author)).toEqual([director.id]);
  });

  test("naming one Bot in a group stopped as a whole lifts nothing and restarts nobody: the group's stop stands, and that Bot answers read-only", async () => {
    const h = await scenario();
    const { director, writer, room } = videoTeam(h);
    const shooting = await atWork(h, director, room, () => h.postUser(room, "@视频导演 出第三镜"));
    const writing = await atWork(h, writer, room, () => h.postUser(room, "@编剧分镜师 第三场改成夜景"));
    h.postUser(room, "大家先停一下");
    await h.routed();
    const [group] = holds(h);
    h.script(director, room).reply(say("大家都还被叫停着"));

    const go = h.postUser(room, "@视频导演 继续");
    await h.waitIdle();

    expect(h.store.getHold(group!.id).lifted_at).toBeNull();
    expect(h.turns(director).filter((row) => row.id !== shooting.id).map(({ mode, trigger_message_id }) => ({ mode, trigger_message_id }))).toEqual([
      { mode: "readonly", trigger_message_id: go.id },
    ]);
    expect(h.turns(writer).map((row) => row.id)).toEqual([writing.id]);
    expect(after(h, room, go).filter((message) => message.kind === "system")).toEqual([]);
  });

  test("「@X 继续」 in a group where you stopped the job lifts nothing and restarts nobody: the job's stop stands", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const working = await atWork(h, director, room, () => h.postUser(room, "@视频导演 EP01 出第三镜"));
    h.postUser(room, "这件事停一下");
    await h.routed();
    const [onPlan] = holds(h);
    expect(onPlan).toMatchObject({ scope: "plan", scope_id: ep01.id });
    h.script(director, room).reply(say("EP01 还被叫停着"));

    const go = h.store.postMessage(room, { body: "@视频导演 继续" });
    h.store.fileMessage(go.id, { explicit: [{ taskId: ep01.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(go.id), { fromUser: true });
    await h.waitIdle();

    expect(h.store.getHold(onPlan!.id).lifted_at).toBeNull();
    expect(h.turns(director).filter((row) => row.id !== working.id).map(({ mode }) => mode)).toEqual(["readonly"]);
    expect(after(h, room, go).filter((message) => message.kind === "system")).toEqual([]);
  });

  test("「@X 继续」 after 「你停下」 in a group lifts X's own stop and leaves the group's", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const line = h.postBot(director, room, "Shot 11 交了");
    await h.waitIdle();
    h.postUser(room, "你停下", { parentId: line.id });
    await h.routed();
    const [own, group] = holds(h);
    h.script(director, room).reply(say("这里还被叫停着"));

    const go = h.postUser(room, "@视频导演 继续");
    await h.waitIdle();

    expect(h.store.getHold(own!.id).lifted_message_id).toBe(go.id);
    expect(h.store.getHold(group!.id).lifted_at).toBeNull();
    expect(after(h, room, go).filter((message) => message.kind === "system")).toEqual([]);
  });

  test("opens a stopped job beside a different job in the same group without giving its note to that other job", async () => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const ep02 = openPlan(h, h.direct(writer), "EP02", planSpec("EP02 动画成片"));
    const stopped = await atWork(h, director, room, () => h.postBot(reviewer, room, "@视频导演 EP01 母带重新拼一遍", { taskId: ep01.id }));
    const hold = h.engine.createHold({ scope: "plan", scopeId: ep01.id });
    let mid = false;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    h.script(director, room).reply(
      async () => {
        mid = true;
        await released;
        return call(tool("list_dir", { path: "." }));
      },
      say("EP02 分镜收到，EP01 母带我接着拼"),
    );
    h.postBot(writer, room, "@视频导演 EP02 分镜好了", { taskId: ep02.id });
    await h.waitFor(() => mid, { what: "视频导演 to be at EP02" });
    const working = h.store.listLiveTurns({ sessionId: room, botId: director.id })[0]!;

    h.engine.liftHold(hold.id);
    const live = h.store.listLiveTurns({ sessionId: room, botId: director.id });
    expect(live.map((row) => row.task_id).sort()).toEqual([ep01.id, ep02.id].sort());
    const resumed = live.find((row) => row.task_id === ep01.id)!;
    expect(resumed.id).not.toBe(working.id);
    release();
    await h.waitIdle();

    expect(h.turns(director).map((row) => row.id)).toEqual([stopped.id, working.id, resumed.id]);
    expect(h.store.getHold(hold.id).effect.resumed_turns).toEqual([resumed.id]);
    const resumedHops = h.hops(director).filter((hop) => hop.turnId === resumed.id);
    expect(resumedHops.some((hop) => requestText(hop.request).includes("用户叫停了这件工作，现在解除了"))).toBe(true);
    expect(h.hops(director).filter((hop) => hop.turnId === working.id).some((hop) => requestText(hop.request).includes("用户叫停了这件工作，现在解除了"))).toBe(false);
    // Heard, not shown: the group and the other Bots there never see the note.
    expect(h.store.listMessages(room).items.some((message) => message.body.includes("用户叫停了这件工作"))).toBe(false);
    expect(h.store.listMainMessages(room, 40).some((message) => message.body.includes("用户叫停了这件工作"))).toBe(false);
  });

  test("with work items, a lift resumes the stopped plan beside the Bot's other plan in the group", async () => {
    const h = await scenario({ workItems: true });
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const ep02 = openPlan(h, h.direct(writer), "EP02", planSpec("EP02 动画成片"));
    const stopped = await atWork(h, director, room, () => h.postBot(reviewer, room, "@视频导演 EP01 母带重新拼一遍", { taskId: ep01.id }));
    const hold = h.engine.createHold({ scope: "plan", scopeId: ep01.id });
    let entered = false;
    const release = Promise.withResolvers<void>();
    h.script(director, room).handle(async ({ turn }) => {
      if (turn!.task_id === ep02.id) {
        entered = true;
        await release.promise;
        return say("EP02 分镜收到");
      }
      expect(turn!.task_id).toBe(ep01.id);
      await release.promise;
      return say("EP01 母带接着拼");
    });
    h.postBot(writer, room, "@视频导演 EP02 分镜好了", { taskId: ep02.id });
    await h.waitFor(() => entered, { what: "the Bot to be on EP02" });
    const working = h.store.listLiveTurns({ sessionId: room, botId: director.id })[0]!;

    h.engine.liftHold(hold.id);
    const live = h.store.listLiveTurns({ sessionId: room, botId: director.id });
    expect(live.map((turn) => turn.task_id).sort()).toEqual([ep01.id, ep02.id].sort());
    const resumed = live.find((turn) => turn.task_id === ep01.id)!;
    expect(h.store.getHold(hold.id).effect.resumed_turns).toEqual([resumed.id]);
    expect(resumed.id).not.toBe(working.id);
    release.resolve();
    await h.waitIdle();
    expect(h.store.getTurn(stopped.id).status).toBe("stopped");
    expect(h.store.getTurn(resumed.id).status).toBe("completed");
    expect(h.store.getTurn(working.id).status).toBe("completed");
    expect(h.hops(director).find((hop) => hop.turnId === resumed.id)!.request.messages.map((message) => message.content).join("\n")).toContain("用户叫停了这件工作，现在解除了");
    expect(h.store.listMainMessages(room, 40).some((message) => message.body.includes("用户叫停了这件工作"))).toBe(false);
  });

  test("goes on beside a read-only turn still answering you there, not inside it", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    await atWork(h, director, room, () => h.postBot(reviewer, room, "@视频导演 EP01 母带重新拼一遍", { taskId: ep01.id }));
    h.postUser(room, "@视频导演 停下");
    await h.routed();
    const [hold] = holds(h);
    const answering = await atWork(h, director, room, () => h.postUser(room, "@视频导演 现在什么情况"));
    expect(answering.mode).toBe("readonly");
    h.script(director, room).reply(say("EP01 母带接着拼"));

    const go = h.postUser(room, "@视频导演 继续");
    await h.routed();

    expect(h.store.getHold(hold!.id).lifted_message_id).toBe(go.id);
    const opened = h.turns(director).filter((row) => row.trigger_message_id === go.id);
    expect(opened.map(({ session_id, task_id, mode }) => ({ session_id, task_id, mode }))).toEqual([{ session_id: room, task_id: ep01.id, mode: "work" }]);
    expect(h.store.getTurn(answering.id).status).toBe("running");
  });

  test("work still under another stop is handed to one that opens it again when lifted, not to a Stop's", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const dm = h.direct(director);
    h.postUser(dm, "停下你所有的工作");
    await h.routed();
    const onPlan = h.engine.createHold({ scope: "plan", scopeId: ep01.id });
    const likeStop = h.engine.createHold({ scope: "bot_plan", scopeId: `${director.id}:${ep01.id}`, liftOnNextUserMessage: true });

    const go = h.postUser(dm, "继续");
    await h.routed();

    // The job's stop, pressed elsewhere, still holds it: the Bot answers your line read-only.
    expect(h.turns(director).filter((row) => row.trigger_message_id === go.id).map((row) => row.mode)).toEqual(["readonly"]);
    expect(h.store.getHold(onPlan.id).effect.held_over!.map((row) => row.turn_id)).toEqual([turn.id]);
    expect(h.store.getHold(likeStop.id).effect.held_over).toBeUndefined();
    h.script(director, thread).reply(call(endTurn()));
    h.engine.liftHold(likeStop.id);
    h.engine.liftHold(onPlan.id);
    await h.waitIdle();
    expect(h.turns(director).filter((row) => row.id !== turn.id && row.mode !== "readonly").map(({ session_id, task_id }) => ({ session_id, task_id }))).toEqual([
      { session_id: thread, task_id: ep01.id },
    ]);
  });
});

describe("a complaint that sends work back", () => {
  test("lifts the Stop on its maker's work in that job, as 退回 on a card does, though the line was said to another Bot", async () => {
    const h = await scenario({ submissions: true });
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const ticket = h.store.createTicket({ taskId: ep01.id, title: "母带", status: "review", worker: director.id });
    const stop = h.engine.createHold({ scope: "bot_plan", scopeId: `${director.id}:${ep01.id}`, liftOnNextUserMessage: true });
    h.script(reviewer, room).reply(say("我来看看"));
    h.script(director).handle(() => call(endTurn()));
    h.judge("read_user_line").reply({ control: "none", control_only: false, status_only: false, objections: ["母带太短了"] });

    const line = h.store.postMessage(room, { body: "@审片员 母带太短了" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: ep01.id, ticketId: ticket.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitIdle();

    expect(h.store.getMessage(line.id).control).toMatchObject({ kind: "rework", ticket_id: ticket.id, offer: ["undo"] });
    expect(h.store.getHold(stop.id).lifted_at).not.toBeNull();
    expect(h.store.listWorkEvents({ kind: "control.lift" }).map((row) => row.payload)).toMatchObject([{ hold: stop.id, send_back: line.id }]);
  });
});

describe("a question about the work goes to the Bot", () => {
  test.each(["怎么还在跑？", "能停么", "怎么能停"])("「%s」 stops nothing and gets no answer of the app's: the Bot it is said to gets it", async (words) => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const working = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const dm = h.direct(director);
    h.script(director, dm).reply(say("还在拼母带，拼完告诉你"));

    const ask = h.postUser(dm, words);
    await h.routed();

    expect(holds(h)).toEqual([]);
    expect(h.store.getTurn(working.id).status).toBe("running");
    expect(after(h, dm, ask).filter((message) => message.kind === "system")).toEqual([]);
    const heard = Boolean(h.store.db.query("SELECT 1 FROM inbox_items WHERE message_id = ?").get(ask.id));
    const opened = h.turns(director).some((row) => row.trigger_message_id === ask.id);
    expect(heard || opened).toBe(true);
  });

  test("in a group, it is heard by the turn at work there and cuts nothing off: no redirect, no second turn beside it", async () => {
    // A real group once had each 「怎么样了」 redirect the busy Bot's turn, ending it and starting another.
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const working = await atWork(h, director, room, () => h.postUser(room, "@视频导演 EP01 出第三镜"));
    expect(working.task_id).toBe(ep01.id);

    const ask = h.postUser(room, "@视频导演 怎么样了");
    await h.routed();

    expect(h.store.getTurn(working.id).status).toBe("running");
    expect(h.turns(director).map((row) => row.id)).toEqual([working.id]);
    expect(h.store.db.query("SELECT turn_id FROM inbox_items WHERE message_id = ?").all(ask.id)).toEqual([{ turn_id: working.id }]);
    expect(after(h, room, ask).filter((message) => message.kind === "system")).toEqual([]);
  });

  test("「你没停」 is read as a stop: what still runs is stopped, and the receipt says so", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const dm = h.direct(director);

    const told = h.postUser(dm, "你没停");
    await h.routed();

    expect(h.store.getTurn(turn.id).status).toBe("stopped");
    expect(holds(h)).toMatchObject([{ scope: "bot", scope_id: director.id, source_message_id: told.id }]);
    expect(after(h, dm, told).map((message) => message.control?.kind)).toEqual(["receipt"]);
  });

  test("「还在做吗」 to a held Bot gets that Bot's read-only answer, not the app's", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.postUser(dm, "停下你所有的工作");
    await h.routed();
    h.script(director, dm).reply(say("没在做，你叫停了我的全部工作"));

    const ask = h.postUser(dm, "还在做吗");
    await h.waitIdle();

    expect(h.turns(director).map(({ mode, trigger_message_id }) => ({ mode, trigger_message_id }))).toEqual([{ mode: "readonly", trigger_message_id: ask.id }]);
    expect(after(h, dm, ask).map((message) => ({ kind: message.kind, author: message.author }))).toEqual([{ kind: "bot", author: director.id }]);
  });

  test("a question about where the work stands never opens a job of its own", async () => {
    // 「怎么样了」 once opened a plan of that name that ran 79 turns by itself.
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.judge("read_filing").reply({ about: "new" });
    // It looks before it answers: an effect at its desk opens the job a line read as new work names.
    h.script(director, dm).reply(call(shell("ls")), say("手上没有在做的事"));

    const ask = h.postUser(dm, "怎么样了");
    await h.waitIdle();

    expect(h.store.db.query("SELECT title FROM tasks").all()).toEqual([]);
    expect(h.turns(director).map(({ task_id, trigger_message_id }) => ({ task_id, trigger_message_id }))).toEqual([
      { task_id: null, trigger_message_id: ask.id },
    ]);
    expect(after(h, dm, ask).filter((message) => message.kind === "system")).toEqual([]);
  });
});

describe("a line that only might be control", () => {
  test("goes to the Bot as usual, marked with the buttons it might have meant", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.script(director, dm).reply(say("好，第三镜换夜景"));

    const line = h.postUser(dm, "先停，把第三镜换成夜景");
    await h.waitIdle();

    expect(holds(h)).toEqual([]);
    expect(h.store.getMessage(line.id).control).toEqual({ kind: "possible_control", offer: ["stop"], scopes: [{ scope: "bot", id: director.id }] });
    expect(h.turns(director).map(({ mode, task_id }) => ({ mode, task_id }))).toEqual([{ mode: "desk", task_id: null }]);
  });

  // 2026-10-03: 「继续做第二集，……」 in a group with nothing stopped carried a 继续 button, whose
  // press answered 「没有被叫停。此刻在跑：无。」 and read 「已继续」.
  test("a request that starts with 继续 carries no button while nothing is stopped, and goes to the Bot as usual", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.script(director, dm).reply(say("好，开始第二集"));

    const line = h.postUser(dm, "继续做第二集，琦玉跟杰诺斯参加英雄协会报名");
    await h.waitIdle();

    expect(holds(h)).toEqual([]);
    expect(h.store.getMessage(line.id).control).toBeUndefined();
    expect(h.turns(director)).toHaveLength(1);
    expect(after(h, dm, line).filter((message) => message.kind === "system")).toEqual([]);
  });

  test("the same request under a stop on the Bot is a go on: it lifts the stop and goes to the Bot, with no buttons", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const hold = h.engine.createHold({ scope: "bot", scopeId: director.id });
    h.script(director, dm).reply(say("好"));

    const line = h.postUser(dm, "继续做第二集，琦玉跟杰诺斯参加英雄协会报名");
    await h.waitIdle();

    expect(h.store.getHold(hold.id).lifted_message_id).toBe(line.id);
    expect(h.store.getMessage(line.id).control).toBeUndefined();
    expect(h.turns(director).map(({ mode, trigger_message_id }) => ({ mode, trigger_message_id }))).toEqual([{ mode: "desk", trigger_message_id: line.id }]);
  });

  test("「算了」 alone stops and drops nothing, carries no buttons, and the Bot gets it", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.script(director, dm).reply(say("好"));

    const line = h.postUser(dm, "算了");
    await h.waitIdle();

    expect(holds(h)).toEqual([]);
    expect(h.store.getMessage(line.id).control).toBeUndefined();
    expect(h.turns(director)).toHaveLength(1);
  });
});

describe("a read-only turn", () => {
  test("opened under a hold on the Bot's work in one plan still changes nothing, and its answer wakes nobody", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    h.engine.createHold({ scope: "bot_plan", scopeId: `${director.id}:${ep01.id}` });
    h.script(director, room).reply(call(shell("printf x > a.txt")), say("@审片员 EP01 停着，你先别审"));

    h.postUser(room, "@视频导演 EP01 现在什么情况");
    await h.waitIdle();

    // Bound to no plan, so the hold does not cover it; it is read-only all the same, and 审片员,
    // whom the hold does not cover either, is not woken by it.
    expect(h.turns(director).map(({ mode, task_id }) => ({ mode, task_id }))).toEqual([{ mode: "readonly", task_id: null }]);
    expect(h.toolCalls(director, "shell").map((row) => row.result)).toEqual([{ ok: false, error: "held" }]);
    expect(h.messages(room).at(-1)!.body).toBe("@审片员 EP01 停着，你先别审");
    expect(h.turns(reviewer)).toEqual([]);
  });

  test("answering you in a group is not cut off by a Bot's line for that Bot: the new turn opens beside it", async () => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const ep02 = openPlan(h, h.direct(writer), "EP02", planSpec("EP02 动画成片"));
    h.engine.createHold({ scope: "bot_plan", scopeId: `${director.id}:${ep01.id}` });
    const answering = await atWork(h, director, room, () => h.postUser(room, "@视频导演 EP01 现在什么情况"));
    expect(answering.mode).toBe("readonly");
    h.script(director, room).reply(say("EP02 分镜收到"));

    h.postBot(reviewer, room, "@视频导演 EP02 分镜请看", { taskId: ep02.id });
    await h.waitFor(() => h.turns(director).length > 1, { what: "a turn on EP02" });

    expect(h.store.getTurn(answering.id).status).toBe("running");
    expect(h.turns(director).filter((row) => row.id !== answering.id).map(({ mode, task_id }) => ({ mode, task_id }))).toEqual([{ mode: "work", task_id: ep02.id }]);
  });
});

describe("Stop on a turn's card", () => {
  test("holds that Bot's work in the plan, keeps its appointment, and your next line about the plan lifts it", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const plan = openPlan(h, dm, "片头", planSpec("片头动画"));
    const turn = await atWork(h, director, dm, () => h.postUser(dm, "做片头"), [call(checkBack(30, "看片头渲染"), shell("printf a > intro.mp4"))]);
    expect(turn.task_id).toBe(plan.id);

    const stopped = h.engine.stop(turn.id, { button: true })!;
    await h.waitIdle();

    expect(stopped.status).toBe("stopped");
    const [hold] = holds(h);
    expect(hold).toMatchObject({ scope: "bot_plan", scope_id: `${director.id}:${plan.id}`, source: "user_button", lift_on_next_user_message: true });
    // The appointment it made waits for the lift instead of being cancelled.
    const booked = h.store.getCheckBack(hold!.effect.suspended_check_backs![0]!);
    expect(booked.suspended_at).not.toBeNull();
    // You pressed it on the turn it stopped: no receipt says so again (ADR 0058). The hold records what it ended.
    expect(h.messages(dm).filter((message) => message.control?.kind === "receipt")).toEqual([]);
    expect(hold!.effect.stopped_turns!.map((row) => row.turn_id)).toEqual([turn.id]);

    h.script(director, dm).reply(say("好，换成慢速"));
    const next = h.postUser(dm, "片头改成慢速");
    await h.waitIdle();

    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: next.id });
    expect(h.store.getCheckBack(booked.id)).toMatchObject({ suspended_at: null, voided_at: null });
    // Your line is what it goes on from: one turn on it, no note of the app's.
    const opened = h.turns(director).filter((row) => row.created_at > next.created_at);
    expect(opened.map((row) => h.store.getMessage(row.trigger_message_id).id)).toEqual([next.id]);
  });

  test("changing the line it was stopped on is your next line about the job: the hold goes and the Bot reads the change", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    openPlan(h, dm, "片头", planSpec("片头动画"));
    let line!: { id: string };
    const turn = await atWork(h, director, dm, () => (line = h.postUser(dm, "片头用快速剪辑")));
    h.engine.stop(turn.id, { button: true });
    await h.waitIdle();
    const [hold] = holds(h);
    expect(hold).toMatchObject({ lift_on_next_user_message: true, lifted_at: null });
    h.script(director, dm).reply(say("好，片头改成慢速"));

    const changed = h.store.editMessage(line.id, { body: "片头用慢速长镜头", userActionId: "after-stop" });
    h.engine.noteEdited(changed);
    await h.waitIdle();

    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: line.id });
    // It goes on from the change, as it would from a new line: one turn on the line, reading what changed.
    const opened = h.turns(director).filter((row) => row.id !== turn.id);
    expect(opened.map(({ trigger_message_id, mode }) => ({ trigger_message_id, mode }))).toEqual([{ trigger_message_id: line.id, mode: "work" }]);
    const read = requestText(h.hops(director).find((hop) => hop.turnId === opened[0]!.id)!.request);
    expect(read).toContain("你改了这句。现在是：「片头用慢速长镜头」（原来是：「片头用快速剪辑」）");
    expect(h.messages(dm).at(-1)!.body).toBe("好，片头改成慢速");
  });

  test("a line sent while it worked, held by the Stop: 直接插入 lifts the Stop and the Bot reads it now", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    openPlan(h, dm, "片头", planSpec("片头动画"));
    const turn = await atWork(h, director, dm, () => h.postUser(dm, "做片头"));
    const line = h.postUser(dm, "片头改成慢速");
    await h.routed();
    h.engine.stop(turn.id, { button: true });
    await h.waitIdle();
    const [hold] = holds(h);
    expect(h.store.getMessage(line.id).delivery?.state).toBe("held");
    h.script(director, dm).reply(say("好，改慢速"));

    expect(h.engine.insertNow(line.id)).toBe(1);
    await h.waitIdle();

    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_button", lifted_message_id: line.id });
    const opened = h.turns(director).filter((row) => row.id !== turn.id);
    expect(opened.map(({ trigger_message_id, mode }) => ({ trigger_message_id, mode }))).toEqual([{ trigger_message_id: line.id, mode: "work" }]);
    expect(h.messages(dm).at(-1)!.body).toBe("好，改慢速");
  });

  test("a line sent while it worked, held by the Stop, is read once the Stop is lifted by its button", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    openPlan(h, dm, "片头", planSpec("片头动画"));
    const turn = await atWork(h, director, dm, () => h.postUser(dm, "做片头"));
    const line = h.postUser(dm, "片头改成慢速");
    await h.routed();
    h.engine.stop(turn.id, { button: true });
    await h.waitIdle();
    const [hold] = holds(h);
    h.script(director, dm).reply(say("好，改慢速"));

    h.engine.liftHold(hold!.id);
    await h.waitIdle();

    // Before, the line went back to 「排队中」 on work left idle when the Stop ended its turn, and nothing took it up.
    const opened = h.turns(director).filter((row) => row.id !== turn.id);
    expect(opened.map(({ trigger_message_id, mode }) => ({ trigger_message_id, mode }))).toEqual([{ trigger_message_id: line.id, mode: "work" }]);
  });

  test("直接插入 under a stop that stays until you lift it reads nothing now: the line stays held", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    openPlan(h, dm, "片头", planSpec("片头动画"));
    await atWork(h, director, dm, () => h.postUser(dm, "做片头"));
    const line = h.postUser(dm, "片头改成慢速");
    await h.routed();
    h.engine.createHold({ scope: "bot", scopeId: director.id });
    await h.waitIdle();
    const done = h.turns(director);
    expect(h.store.getMessage(line.id).delivery?.state).toBe("held");

    expect(h.engine.insertNow(line.id)).toBe(0);
    await h.waitIdle();

    expect(holds(h).map(({ scope, lifted_at }) => ({ scope, lifted_at }))).toEqual([{ scope: "bot", lifted_at: null }]);
    expect(h.store.getMessage(line.id).delivery?.state).toBe("held");
    expect(h.turns(director)).toEqual(done);
  });

  test("a stop that stays until you lift it keeps holding a change to a line the Bot read", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    openPlan(h, dm, "片头", planSpec("片头动画"));
    h.script(director, dm).reply(say("片头做好了"));
    const line = h.postUser(dm, "片头用快速剪辑");
    await h.waitIdle();
    const done = h.turns(director);
    h.engine.createHold({ scope: "bot", scopeId: director.id });

    h.engine.noteEdited(h.store.editMessage(line.id, { body: "片头用慢速长镜头", userActionId: "under-hold" }));
    await h.waitIdle();

    expect(holds(h).map(({ scope, lifted_at }) => ({ scope, lifted_at }))).toEqual([{ scope: "bot", lifted_at: null }]);
    const told = h.store.db
      .query<{ state: string }, [string]>(`SELECT state FROM inbox_items WHERE message_id = ? AND edit_id IS NOT NULL`)
      .all(line.id);
    expect(told).toEqual([{ state: "held" }]);
    expect(h.turns(director)).toEqual(done);
  });

  test.each(["继续", "这件事继续"])("「%s」 after it is your next line about the job: the hold goes and the Bot goes on from it", async (words) => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const plan = openPlan(h, dm, "片头", planSpec("片头动画"));
    const turn = await atWork(h, director, dm, () => h.postUser(dm, "做片头"));
    h.engine.stop(turn.id, { button: true });
    await h.waitIdle();
    const [hold] = holds(h);
    h.script(director, dm).reply(say("好，接着渲染片头"));

    const go = h.store.postMessage(dm, { body: words });
    h.store.fileMessage(go.id, { explicit: [{ taskId: plan.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(go.id), { fromUser: true });
    await h.waitIdle();

    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: go.id });
    const opened = h.turns(director).filter((row) => row.created_at > go.created_at);
    expect(opened.map(({ trigger_message_id, mode }) => ({ trigger_message_id, mode }))).toEqual([{ trigger_message_id: go.id, mode: "work" }]);
    expect(h.messages(dm).at(-1)!.body).toBe("好，接着渲染片头");
    // Not carried out as a go on: no receipt of the app's.
    expect(after(h, dm, go).filter((message) => message.kind === "system")).toEqual([]);
  });

  test.each([
    ["in its direct", "继续"],
    ["in a group", "@视频导演 继续"],
    ["in its direct, naming everything", "所有Bot继续"],
  ])("pressed on a job in a direct between Bots, 「继续」 to that Bot %s (「%s」) lifts it, and the Bot goes on with that job from your line", async (place, words) => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, h.direct(reviewer), "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }), [
      call(shell("printf cut > EP01_MASTER.mp4")),
    ]);
    h.engine.stop(turn.id, { button: true });
    await h.waitIdle();
    const [hold] = holds(h);
    const where = place.startsWith("in its direct") ? h.direct(director) : room;
    h.script(director, where).reply(say("母带接着拼"));

    const go = h.store.postMessage(where, { body: words });
    h.store.fileMessage(go.id, { explicit: [{ taskId: ep01.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(go.id), { fromUser: true });
    await h.waitIdle();

    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: go.id });
    // Your line wakes it where you said it, on that job; the work it was at in the direct between
    // Bots is the Bot's to go on with, so nothing opens there beside it.
    const opened = h.turns(director).filter((row) => row.created_at > go.created_at);
    expect(opened.map(({ session_id, task_id, mode, trigger_message_id }) => ({ session_id, task_id, mode, trigger_message_id }))).toEqual([
      { session_id: where, task_id: ep01.id, mode: "work", trigger_message_id: go.id },
    ]);
    expect(after(h, where, go).filter((message) => message.kind === "system")).toEqual([]);
  });

  test.each(["所有Bot继续", "全都继续"])("pressed on a job in a direct between Bots, a go on in the room that names everything (「%s」) lifts it and opens that work again where it was, on a note", async (words) => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, h.direct(reviewer), "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }), [
      call(shell("printf cut > EP01_MASTER.mp4")),
    ]);
    h.engine.stop(turn.id, { button: true });
    await h.waitIdle();
    const [hold] = holds(h);
    h.script(director, thread).reply(say("母带接着拼"));

    const go = h.postUser(room, words);
    await h.waitIdle();

    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: go.id });
    // Your line did not wake the Bot at that job, so the work opens again where it was, on the note with your words.
    const opened = h.turns(director).filter((row) => row.created_at > go.created_at && row.task_id === ep01.id);
    expect(opened.map(({ session_id, mode }) => ({ session_id, mode }))).toEqual([{ session_id: thread, mode: "work" }]);
    const note = h.store.getMessage(opened[0]!.trigger_message_id);
    expect(note).toMatchObject({ kind: "system", turn_id: turn.id });
    expect(note.body).toContain(`「${words}」`);
    expect(note.body).toContain("shell printf cut > EP01_MASTER.mp4");
    expect(after(h, room, go).filter((message) => message.kind === "system")).toEqual([]);
  });

  test("「@X 继续」 about a job lifts X's Stop on it only, not another Bot's on that job, nor X's on another job", async () => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const ep02 = openPlan(h, h.direct(writer), "EP02", planSpec("EP02 动画成片"));
    const reviewing = h.botDirect(reviewer, writer);
    const review = await atWork(h, reviewer, reviewing, () => h.postBot(writer, reviewing, "EP02 第三镜审一下", { taskId: ep02.id }));
    const thread = h.botDirect(director, writer);
    const cut = await atWork(h, director, thread, () => h.postBot(writer, thread, "EP02 母带重新拼一遍", { taskId: ep02.id }), [
      call(shell("printf cut > EP02_MASTER.mp4")),
    ]);
    const onEp01 = h.engine.createHold({ scope: "bot_plan", scopeId: `${director.id}:${ep01.id}` });
    h.engine.stop(review.id, { button: true });
    h.engine.stop(cut.id, { button: true });
    await h.waitIdle();
    const [, onReview, onCut] = holds(h);
    expect([onReview!.scope_id, onCut!.scope_id]).toEqual([`${reviewer.id}:${ep02.id}`, `${director.id}:${ep02.id}`]);
    h.script(director, room).reply(say("EP02 母带接着拼"));

    const go = h.store.postMessage(room, { body: "@视频导演 继续" });
    h.store.fileMessage(go.id, { explicit: [{ taskId: ep02.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(go.id), { fromUser: true });
    await h.waitIdle();

    expect(h.store.getHold(onCut!.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: go.id });
    expect(h.store.getHold(onReview!.id).lifted_at).toBeNull();
    expect(h.store.getHold(onEp01.id).lifted_at).toBeNull();
    expect(h.turns(director).filter((row) => row.created_at > go.created_at).map(({ session_id, task_id }) => ({ session_id, task_id }))).toEqual([
      { session_id: room, task_id: ep02.id },
    ]);
    expect(h.turns(reviewer).filter((row) => row.created_at > go.created_at)).toEqual([]);
    expect(after(h, room, go).filter((message) => message.kind === "system")).toEqual([]);
  });

  test("a line received before Stop but admitted afterwards does not lift it", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const plan = openPlan(h, dm, "片头", planSpec("片头动画"));
    const turn = await atWork(h, director, dm, () => h.postUser(dm, "做片头"));
    // Receipt and admission are separate seams. Capture the original line and its explicit job
    // before Stop, then admit it afterwards: no organizer or fake timing dependency remains.
    const earlier = h.store.postMessage(dm, { body: "片头加个标题" });
    h.store.fileMessage(earlier.id, { explicit: [{ taskId: plan.id }] });
    h.script(director, dm).reply(say("片头停着，标题等你说了再加"));
    h.engine.stop(turn.id, { button: true });
    await h.engine.handleInboundMessage(h.store.getMessage(earlier.id), { fromUser: true });
    await h.waitIdle();

    const [hold] = holds(h);
    expect(hold!.lifted_at).toBeNull();
    // It still gets an answer, from a turn the Stop leaves read-only.
    expect(h.turns(director).filter((row) => row.trigger_message_id === earlier.id).map(({ mode }) => mode)).toEqual(["readonly"]);
  });

  test("refuses a turn already over, as before holds, and makes no hold for it", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.script(director, dm).reply(say("好"));
    h.postUser(dm, "做片头");
    await h.waitIdle();
    const [done] = h.turns(director);

    expect(() => h.engine.stop(done!.id, { button: true })).toThrow("turn is not in progress");
    expect(holds(h)).toEqual([]);
  });

  test("stops one Bot's turn in a group, the others' going on, with no receipt in the group", async () => {
    const h = await scenario();
    const { director, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const cut = await atWork(h, director, room, () => h.postBot(writer, room, "@视频导演 EP01 片尾", { taskId: ep01.id }));
    const other = await atWork(h, writer, room, () => h.postUser(room, "@编剧分镜师 第三场改成夜景"));

    h.engine.stop(cut.id, { button: true });

    const [hold] = holds(h);
    expect(hold).toMatchObject({ scope: "bot_plan", scope_id: `${director.id}:${ep01.id}`, source: "user_button", lift_on_next_user_message: true });
    expect(h.store.getTurn(cut.id).status).toBe("stopped");
    expect(h.store.getTurn(other.id).status).toBe("running");
    expect(h.messages(room).filter((message) => message.control?.kind === "receipt")).toEqual([]);
  });

  test.each([
    ["on the Bot's work in the job", "bot_plan"],
    ["on its turn alone", "turn"],
  ])("pressed in a group, a Stop %s is lifted by your next line to that Bot, not by one to another Bot there", async (_, scope) => {
    const h = await scenario();
    const { director, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const cut = await atWork(h, director, room, () => h.postBot(writer, room, "@视频导演 EP01 片尾", { taskId: ep01.id }), [
      call(checkBack(30, "看片尾渲染")),
    ]);
    // A turn in a group always has a plan, so a Stop on the turn alone comes from the API here.
    if (scope === "bot_plan") h.engine.stop(cut.id, { button: true });
    else h.engine.createHold({ scope: "turn", scopeId: cut.id, liftOnNextUserMessage: true });
    await h.waitIdle();
    const [hold] = holds(h);
    expect(hold).toMatchObject(scope === "bot_plan" ? { scope, scope_id: `${director.id}:${ep01.id}` } : { scope, scope_id: cut.id });
    const booked = hold!.effect.suspended_check_backs![0]!;

    // A line to 编剧分镜师 about the same job is not what you said to 视频导演: its Stop and the
    // appointment it made stay, so nothing wakes it back.
    h.script(writer, room).reply(say("好，第三场改成夜景"));
    h.postUser(room, "@编剧分镜师 第三场改成夜景");
    await h.waitIdle();

    expect(h.store.getHold(hold!.id).lifted_at).toBeNull();
    expect(h.store.getCheckBack(booked).suspended_at).not.toBeNull();
    expect(h.turns(director).filter((row) => row.id !== cut.id)).toEqual([]);

    h.script(director, room).reply(say("片尾也换成夜景"));
    const toDirector = h.postUser(room, "@视频导演 片尾也改成夜景");
    await h.waitIdle();

    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: toDirector.id });
    expect(h.store.getCheckBack(booked)).toMatchObject({ suspended_at: null, voided_at: null });
  });

  test("before holds are on, only ends the turn and cancels its appointment", async () => {
    const h = await scenario({});
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const turn = await atWork(h, director, dm, () => h.postUser(dm, "做片头"), [call(checkBack(30, "看片头渲染"))]);

    h.engine.stop(turn.id, { button: true });
    await h.waitIdle();

    expect(holds(h)).toEqual([]);
    expect(h.store.pendingCheckBack(director.id, dm)).toBeNull();
  });
});

describe("a hold from the menu", () => {
  test("ends what it covers, and lifting it opens that work again", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));

    const hold = h.engine.createHold({ scope: "plan", scopeId: ep01.id });

    expect(h.store.getTurn(turn.id).status).toBe("stopped");
    expect(hold.effect.stopped_turns!.map((row) => row.turn_id)).toEqual([turn.id]);
    expect(hold.effect.parked_plans).toEqual([{ task_id: ep01.id, prior: "active" }]);

    h.script(director, thread).reply(call(endTurn()));
    h.engine.liftHold(hold.id);
    await h.waitIdle();

    expect(h.store.getTask(ep01.id).status).toBe("active");
    const resumed = h.turns(director).filter((row) => row.id !== turn.id);
    expect(resumed.map(({ session_id, task_id }) => ({ session_id, task_id }))).toEqual([{ session_id: thread, task_id: ep01.id }]);
    expect(h.store.getMessage(resumed[0]!.trigger_message_id).body).toContain("用户叫停了这件工作，现在解除了。");
  });

  test("a plan parked from the board ends the turns working in it", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));

    h.store.setPlanSpecByUser(ep01.id, planSpec("EP01 动画成片", { status: "parked" }));
    h.engine.enforceHolds();

    expect(h.store.getTurn(turn.id).status).toBe("stopped");
    expect(holds(h)[0]!.effect.stopped_turns!.map((row) => row.turn_id)).toEqual([turn.id]);
  });
});

describe("a group's stop menu", () => {
  /** A stop chosen from the group's menu: it goes with your next line there (Composer.svelte). */
  function menuStop(h: Scenario, scope: "session" | "bot" | "plan", scopeId: string, room: string): Hold {
    return h.engine.createHold({ scope, scopeId, sessionId: room, liftOnNextUserMessage: true });
  }

  test("on the group: your next line there lifts it and is what the Bots go on from, not a read-only answer", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const cut = await atWork(h, director, room, () => h.postUser(room, "@视频导演 做第三集"));

    const hold = menuStop(h, "session", room, room);

    expect(h.store.getTurn(cut.id).status).toBe("stopped");
    const receipt = h.messages(room).filter((message) => message.kind === "system").at(-1)!;
    expect(receipt.body.split("\n").at(-1)).toBe("你在这个群里再说话就解除，Bot 从你这句接着往下。");

    h.script(director, room).reply(say("好，从第 1 集重做"));
    const next = h.postUser(room, "@视频导演 从头再做一遍，之前的作废");
    await h.waitIdle();

    expect(h.store.getHold(hold.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: next.id });
    // Your line is what it goes on from: one turn on it that can act (on no job: at the desk), no note of the app's.
    const opened = h.turns(director).filter((row) => row.created_at > next.created_at);
    expect(opened.map(({ trigger_message_id, mode }) => ({ trigger_message_id, mode }))).toEqual([{ trigger_message_id: next.id, mode: "desk" }]);
    expect(h.messages(room).at(-1)!.body).toBe("好，从第 1 集重做");
  });

  test("on a Bot: a line to another Bot leaves it, a line to that Bot lifts it", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    await atWork(h, director, room, () => h.postUser(room, "@视频导演 做第三集"));
    const hold = menuStop(h, "bot", director.id, room);
    expect(h.messages(room).filter((message) => message.kind === "system").at(-1)!.body.split("\n").at(-1)).toBe("你再对它说话就解除，它从你这句接着往下。");

    h.script(reviewer, room).reply(say("好的"));
    h.postUser(room, "@审片员 先看下第二集");
    await h.waitIdle();
    expect(h.store.getHold(hold.id).lifted_at).toBeNull();

    h.script(director, room).reply(say("好，改成夜景"));
    const next = h.postUser(room, "@视频导演 第三集改成夜景");
    await h.waitIdle();

    expect(h.store.getHold(hold.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: next.id });
    expect(h.turns(director).filter((row) => row.created_at > next.created_at).map(({ mode }) => mode)).toEqual(["desk"]);
  });

  test("on a job: your next line about it lifts it, and the job is no longer parked", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    await atWork(h, director, room, () => h.postUser(room, "@视频导演 EP01 出第三镜"));
    const hold = menuStop(h, "plan", ep01.id, room);
    expect(h.store.getTask(ep01.id).status).toBe("parked");

    h.script(director, room).reply(say("好，第三镜改慢"));
    const next = h.store.postMessage(room, { body: "@视频导演 第三镜改慢一点" });
    h.store.fileMessage(next.id, { explicit: [{ taskId: ep01.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(next.id), { fromUser: true });
    await h.waitIdle();

    expect(h.store.getHold(hold.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: next.id });
    expect(h.store.getTask(ep01.id).status).toBe("active");
  });

  test("「@X 继续」 lifts the group's stop and X goes on; the other Bots' stopped work stays stopped", async () => {
    const h = await scenario();
    const { director, writer, room } = videoTeam(h);
    const shooting = await atWork(h, director, room, () => h.postUser(room, "@视频导演 出第三镜"));
    const writing = await atWork(h, writer, room, () => h.postUser(room, "@编剧分镜师 第三场改成夜景"));
    const hold = menuStop(h, "session", room, room);

    h.script(director, room).reply(say("接着出第三镜"));
    const go = h.postUser(room, "@视频导演 继续");
    await h.waitIdle();

    expect(h.store.getHold(hold.id).lifted_at).not.toBeNull();
    expect(h.turns(director).filter((row) => row.id !== shooting.id).map(({ trigger_message_id, mode }) => ({ trigger_message_id, mode }))).toEqual([
      { trigger_message_id: go.id, mode: "desk" },
    ]);
    expect(h.turns(writer).map((row) => row.id)).toEqual([writing.id]);
  });

  test("「@X 继续」 that also lifts X's own stop still reopens no other Bot's work the group's stop ended", async () => {
    const h = await scenario();
    const { director, writer, room } = videoTeam(h);
    const shooting = await atWork(h, director, room, () => h.postUser(room, "@视频导演 出第三镜"));
    const writing = await atWork(h, writer, room, () => h.postUser(room, "@编剧分镜师 第三场改成夜景"));
    const own = h.engine.createHold({ scope: "bot", scopeId: director.id });
    const group = menuStop(h, "session", room, room);

    h.script(director, room).reply(say("接着出第三镜"));
    const go = h.postUser(room, "@视频导演 继续");
    await h.waitIdle();

    expect([own, group].map((hold) => h.store.getHold(hold.id).lifted_message_id)).toEqual([go.id, go.id]);
    expect(h.turns(director).filter((row) => row.id !== shooting.id).map(({ trigger_message_id }) => trigger_message_id)).toEqual([go.id]);
    expect(h.turns(writer).map((row) => row.id)).toEqual([writing.id]);
  });
});

describe("a read-only answer", () => {
  test("that did answer gets no line of the app's", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    h.engine.createHold({ scope: "session", scopeId: room });
    h.script(director, room).reply(say("停着呢，解除后我再做"));

    const line = h.postUser(room, "@视频导演 从头再做一遍");
    await h.waitIdle();

    expect(after(h, room, line).map(({ kind, body }) => ({ kind, body }))).toEqual([{ kind: "bot", body: "停着呢，解除后我再做" }]);
  });
});

describe("a line a stop left read-only", () => {
  // The Bot could only answer it, and said it would act once you went on; before, nothing did unless
  // a turn had been stopped to open again (2026-10-04: the logo stayed as it was after 继续).
  test("is what the Bot goes on from once you say go on, though no work had been stopped", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const hold = h.engine.createHold({ scope: "session", scopeId: room });
    h.script(director, room).reply(say("停着呢，解除后我再放大"));
    const line = h.postUser(room, "@视频导演 片尾的 logo 再大一点");
    await h.waitIdle();
    const [answering] = h.turns(director);
    expect(answering!.mode).toBe("readonly");
    expect(h.store.getHold(hold.id).effect.answered_lines).toEqual([{ message_id: line.id, bot_id: director.id, turn_id: answering!.id }]);

    h.script(director, room).reply(say("好，放大 logo 重出成片"));
    const go = h.postUser(room, "继续");
    await h.waitIdle();

    const working = h.turns(director).filter((row) => row.mode !== "readonly");
    // On no job here, so a desk segment: what the line would have opened with nothing stopped.
    expect(working.map(({ trigger_message_id, mode }) => ({ trigger_message_id, mode }))).toEqual([{ trigger_message_id: line.id, mode: "desk" }]);
    expect(h.store.getHold(hold.id)).toMatchObject({ lifted_message_id: go.id, effect: { taken_up_turns: [working[0]!.id] } });
    expect(h.messages(room).filter((message) => message.kind === "bot").map((message) => message.body)).toEqual(["停着呢，解除后我再放大", "好，放大 logo 重出成片"]);
    // The Bot says it goes on; the app writes nothing.
    expect(after(h, room, go).filter((message) => message.kind === "system")).toEqual([]);
  });

  test("of several, the last opens the Bot's turn, and it reads the others above it", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    h.engine.createHold({ scope: "session", scopeId: room });
    h.script(director, room).reply(say("记下了"), say("也记下了"));
    h.postUser(room, "@视频导演 片尾的 logo 再大一点");
    await h.waitIdle();
    const last = h.postUser(room, "@视频导演 主标语也换一句");
    await h.waitIdle();

    h.script(director, room).reply(say("两处都改"));
    h.postUser(room, "继续");
    await h.waitIdle();

    const working = h.turns(director).filter((row) => row.mode !== "readonly");
    expect(working.map(({ trigger_message_id }) => trigger_message_id)).toEqual([last.id]);
    expect(requestText(h.hops(director).find((hop) => hop.turnId === working[0]!.id)!.request)).toContain("片尾的 logo 再大一点");
  });

  test("one another stop still covers waits for that stop", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const group = h.engine.createHold({ scope: "session", scopeId: room });
    const own = h.engine.createHold({ scope: "bot", scopeId: director.id });
    h.script(director, room).reply(say("停着呢"));
    const line = h.postUser(room, "@视频导演 片尾的 logo 再大一点");
    await h.waitIdle();

    h.engine.liftHold(group.id);
    await h.waitIdle();
    expect(h.turns(director).filter((row) => row.mode !== "readonly")).toEqual([]);

    h.script(director, room).reply(say("好，放大"));
    h.engine.liftHold(own.id);
    await h.waitIdle();
    expect(h.turns(director).filter((row) => row.mode !== "readonly").map(({ trigger_message_id }) => trigger_message_id)).toEqual([line.id]);
    expect(h.store.getHold(own.id).effect.taken_up_turns).toHaveLength(1);
  });
});

describe("buttons on the app's lines about your stops", () => {
  /** The app's receipt for `line` in `session`. */
  function receiptAfter(h: Scenario, session: string, line: { created_at: string }) {
    const receipt = after(h, session, line).find((message) => message.control?.kind === "receipt");
    expect(receipt).toBeDefined();
    return receipt!;
  }

  test("undo lifts the stop, opens the work again, and sends your line on as any line; a second press does nothing", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const dm = h.direct(director);
    const stop = h.postUser(dm, "你手头的生成停一下");
    await h.routed();
    const receipt = receiptAfter(h, dm, stop);
    const [hold] = holds(h);

    h.script(director, thread).reply(call(tool("list_dir", { path: "." })), say("好的，接着拼"));
    const result = h.engine.control(receipt.id, { action: "undo" });
    await h.waitIdle();

    expect(result.lifted.map((row) => row.id)).toEqual([hold!.id]);
    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_button" });
    // The thread work opens again on the note, as any lift opens it.
    const reopened = h.turns(director).filter((row) => row.session_id === thread && row.id !== turn.id);
    expect(reopened).toHaveLength(1);
    // Your line was never a stop. I1b delivers it to that job's already resumed segment, rather
    // than opening another segment in the direct: assert it was actually read, not merely queued.
    const delivered = h.store.db.query<{ delivered_turn_id: string; state: string }, [string]>(
      "SELECT delivered_turn_id, state FROM inbox_items WHERE message_id = ? AND source = 'user' ORDER BY seq",
    ).all(stop.id);
    expect(delivered).toEqual([{ delivered_turn_id: reopened[0]!.id, state: expect.any(String) }]);
    expect(delivered[0]!.delivered_turn_id).toBe(reopened[0]!.id);
    expect(delivered[0]!.state).not.toBe("queued");
    expect(h.hops(director).filter((hop) => hop.turnId === reopened[0]!.id).some((hop) => requestText(hop.request).includes(stop.body))).toBe(true);
    expect(h.store.getMessage(receipt.id).control).toMatchObject({ acted: ["undo"] });

    expect(h.engine.control(receipt.id, { action: "undo" })).toEqual({ made: [], lifted: [] });
    await h.waitIdle();
    expect(h.store.db.query("SELECT seq FROM inbox_items WHERE message_id = ? AND source = 'user'").all(stop.id)).toHaveLength(1);
    expect(h.turns(director).filter((row) => row.session_id === thread && row.id !== turn.id)).toHaveLength(1);
  });

  test("undo of a stop said where the Bot was working sends your line on there, without opening that work again beside it", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    openPlan(h, dm, "片头", planSpec("片头动画"));
    const turn = await atWork(h, director, dm, () => h.postUser(dm, "做片头"));
    const stop = h.postUser(dm, "你手头的生成停一下");
    await h.routed();
    const receipt = receiptAfter(h, dm, stop);
    const [hold] = holds(h);
    expect(h.store.getTurn(turn.id).status).toBe("stopped");

    h.script(director, dm).reply(say("好，片头先停着"));
    h.engine.control(receipt.id, { action: "undo" });
    await h.waitIdle();

    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_button" });
    // One turn on your line, not a second one on the app's note beside it.
    expect(h.turns(director).filter((row) => row.id !== turn.id).map(({ trigger_message_id }) => trigger_message_id)).toEqual([stop.id]);
    expect(h.store.getHold(hold!.id).effect.resumed_turns ?? []).toEqual([]);
  });

  test("undo of a stop said to a whole group opens every Bot's work there again, since your line alone would wake nobody", async () => {
    const h = await scenario();
    const { director, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const shooting = await atWork(h, director, room, () => h.postUser(room, "@视频导演 EP01 出第三镜"));
    const writing = await atWork(h, writer, room, () => h.postUser(room, "@编剧分镜师 第三场改成夜景"));
    const stop = h.postUser(room, "大家先停一下");
    await h.routed();
    const receipt = receiptAfter(h, room, stop);
    const [hold] = holds(h);
    expect([shooting, writing].map((turn) => h.store.getTurn(turn.id).status)).toEqual(["stopped", "stopped"]);

    // The reopened work is still at it when your line, sent on, has been read and filed: the next
    // step hears it there, and the work ends after it.
    const atIt = async () => {
      await h.waitFor(() => h.store.getMessage(stop.id).filing_state !== undefined, { what: "the line sent on to be filed" });
      return call(tool("list_bots"));
    };
    h.script(director, room).reply(atIt, call(endTurn()));
    h.script(writer, room).reply(atIt, call(endTurn()));
    h.engine.control(receipt.id, { action: "undo" });
    await h.waitIdle();

    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_button" });
    expect(h.store.getTask(ep01.id).status).toBe("active");
    // Both Bots are at their work in the room again, one turn each, as any lift would open it.
    const reopened = (bot: { id: string }, before: string) => h.turns(bot).filter((row) => row.session_id === room && row.id !== before);
    expect([reopened(director, shooting.id), reopened(writer, writing.id)].map((rows) => rows.length)).toEqual([1, 1]);
    expect(h.store.getHold(hold!.id).effect.resumed_turns).toHaveLength(2);
  });

  test("「扩大到所有 Bot」 stops every Bot and says so where you pressed it", async () => {
    const h = await scenario();
    const { director, writer, room } = videoTeam(h);
    const dm = h.direct(director);
    const other = await atWork(h, writer, room, () => h.postUser(room, "@编剧分镜师 第三场改成夜景"));
    const stop = h.postUser(dm, "停一下");
    await h.routed();
    const receipt = receiptAfter(h, dm, stop);

    const { made } = h.engine.control(receipt.id, { action: "stop_all" });

    expect(made.map(({ scope, source }) => ({ scope, source }))).toEqual([{ scope: "global", source: "user_button" }]);
    expect(h.store.getTurn(other.id).status).toBe("stopped");
    const wider = receiptAfter(h, dm, receipt);
    expect(wider.control).toMatchObject({ verb: "stop", hold_ids: [made[0]!.id], offer: ["undo"], scopes: [{ scope: "global", id: null }] });
    expect(wider.body).toContain("所有 Bot 的工作");
  });

  test("「一起停下《…》」 stops the plan another Bot was still working in", async () => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const writing = await atWork(h, writer, room, () => h.postBot(director, room, "@编剧分镜师 EP01 第三场分镜", { taskId: ep01.id }));
    const dm = h.direct(director);
    const stop = h.postUser(dm, "你手头的生成停一下");
    await h.routed();
    const receipt = receiptAfter(h, dm, stop);
    expect(receipt.control).toMatchObject({ plans: expect.arrayContaining([{ offer: "stop_plan", task_id: ep01.id, title: "EP01" }]) });
    expect(h.store.getTurn(writing.id).status).toBe("running");

    const { made } = h.engine.control(receipt.id, { action: "stop_plan", taskId: ep01.id });

    expect(made.map(({ scope, scope_id }) => ({ scope, scope_id }))).toEqual([{ scope: "plan", scope_id: ep01.id }]);
    expect(h.store.getTurn(writing.id).status).toBe("stopped");
    expect(() => h.engine.control(receipt.id, { action: "stop_plan", taskId: "01NOTAPLAN000000000000000" })).toThrow("does not offer");
  });

  test("「只停《…》」 narrows a stop on the Bot to that plan, and its other work opens again", async () => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const ep02 = openPlan(h, room, "EP02", planSpec("EP02 动画成片"));
    const review = h.botDirect(director, reviewer);
    const script = h.botDirect(director, writer);
    const onEp01 = await atWork(h, director, review, () => h.postBot(reviewer, review, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const onEp02 = await atWork(h, director, script, () => h.postBot(writer, script, "EP02 片头", { taskId: ep02.id }));
    const dm = h.direct(director);
    const stop = h.postUser(dm, "停下你所有的工作");
    await h.routed();
    const receipt = receiptAfter(h, dm, stop);
    const [wide] = holds(h);
    expect(receipt.control).toMatchObject({
      plans: expect.arrayContaining([
        { offer: "only_plan", task_id: ep01.id, title: "EP01" },
        { offer: "only_plan", task_id: ep02.id, title: "EP02" },
      ]),
    });

    h.script(director, script).reply(call(endTurn()));
    const { made, lifted } = h.engine.control(receipt.id, { action: "only_plan", taskId: ep01.id });
    await h.waitIdle();

    expect(made.map(({ scope, scope_id, source_message_id }) => ({ scope, scope_id, source_message_id }))).toEqual([
      { scope: "bot_plan", scope_id: `${director.id}:${ep01.id}`, source_message_id: stop.id },
    ]);
    expect(lifted.map((row) => row.id)).toEqual([wide!.id]);
    const later = h.turns(director).filter((row) => row.id !== onEp01.id && row.id !== onEp02.id);
    expect(later.map(({ session_id, task_id }) => ({ session_id, task_id }))).toEqual([{ session_id: script, task_id: ep02.id }]);
    expect(h.store.getHold(made[0]!.id).effect.held_over?.map((row) => row.turn_id)).toEqual([onEp01.id]);
    const narrowed = receiptAfter(h, dm, receipt);
    expect(narrowed.control).toMatchObject({ verb: "continue", hold_ids: [wide!.id] });
    expect(narrowed.body).toContain("仍在叫停中：视频导演在「EP01」上的工作");
  });

  test("「只让 X 继续」 under a stop on everything leaves one stop per other Bot and lets X go on", async () => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const cut = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const stop = h.postUser(room, "所有Bot停下");
    await h.routed();
    const [global] = holds(h);
    expect(global!.scope).toBe("global");
    // A line that may have meant either carries the buttons; its 继续 cannot lift a stop on
    // everything for one Bot, so the app's answer to that press offers how.
    const both = h.postUser(room, "@视频导演 今天先停明天继续");
    await h.routed();
    expect(h.store.getMessage(both.id).control).toMatchObject({ kind: "possible_control", offer: ["stop", "continue"] });
    h.engine.control(both.id, { action: "continue" });
    const status = after(h, room, both).find((message) => message.control?.kind === "status")!;
    expect(status.control).toMatchObject({ offer: ["continue_only", "continue_all"], hold_ids: [global!.id] });

    h.script(director, thread).reply(call(endTurn()));
    const { made, lifted } = h.engine.control(status.id, { action: "continue_only" });
    await h.waitIdle();

    expect(lifted.map((row) => row.id)).toEqual([global!.id]);
    expect(made.map(({ scope, scope_id }) => ({ scope, scope_id })).sort((a, b) => a.scope_id!.localeCompare(b.scope_id!))).toEqual(
      [reviewer.id, writer.id].sort().map((id) => ({ scope: "bot", scope_id: id })),
    );
    expect(made.every((row) => row.source_message_id === stop.id)).toBe(true);
    expect(h.turns(director).filter((row) => row.session_id === thread && row.id !== cut.id)).toHaveLength(1);
    expect(h.store.holdsCovering({ botId: director.id })).toEqual([]);
    expect(h.store.holdsCovering({ botId: writer.id }).map((row) => row.scope)).toEqual(["bot"]);
  });

  test("「停下」 on a line that only might have been a stop makes that stop, quoting the line", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.script(director, dm).reply(say("好，第三镜换夜景"));
    const line = h.postUser(dm, "先停，把第三镜换成夜景");
    await h.waitIdle();
    const committed: ClientEvent[] = [];
    const unsubscribe = h.store.onCommit((event) => committed.push(event));

    const { made } = h.engine.control(line.id, { action: "stop" });
    unsubscribe();

    expect(made.map(({ scope, scope_id, source, source_message_id }) => ({ scope, scope_id, source, source_message_id }))).toEqual([
      { scope: "bot", scope_id: director.id, source: "user_button", source_message_id: line.id },
    ]);
    expect(h.store.getMessage(line.id).control).toMatchObject({ kind: "possible_control", acted: ["stop"] });
    // Clients learn of the press from the line itself, as they learn of any change to it.
    expect(committed.some((event) => event.event === "message.upsert" && event.id === line.id && event.control?.acted?.includes("stop"))).toBe(true);
    expect(receiptAfter(h, dm, line).body).toContain("先停，把第三镜换成夜景");
    expect(() => h.engine.control(line.id, { action: "continue" })).toThrow("does not offer");
  });

  test("「作废」 on a stop's receipt keeps the stop and records it as dropping the job", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const stop = h.postUser(dm, "算了，先停下");
    await h.routed();
    const receipt = receiptAfter(h, dm, stop);
    expect(receipt.control).toMatchObject({ offer: ["undo", "stop_all", "cancel"] });

    h.engine.control(receipt.id, { action: "cancel" });

    const [hold] = holds(h);
    expect(hold).toMatchObject({ action: "cancel", lifted_at: null });
  });

  test("a stop from a menu says what it stopped in the conversation it was chosen in", async () => {
    const h = await scenario();
    const { director, writer, room } = videoTeam(h);
    const inRoom = await atWork(h, writer, room, () => h.postUser(room, "@编剧分镜师 第三场改成夜景"));
    const dm = h.direct(director);
    const before = h.messages(dm).at(-1) ?? { created_at: "" };

    const hold = h.engine.createHold({ scope: "session", scopeId: room, sessionId: dm });

    expect(h.store.getTurn(inRoom.id).status).toBe("stopped");
    const receipt = receiptAfter(h, dm, before);
    expect(receipt.control).toMatchObject({ verb: "stop", hold_ids: [hold.id], scopes: [{ scope: "session", id: room }] });
    // Without one, no receipt anywhere.
    const count = h.messages(room).length;
    h.engine.createHold({ scope: "global" });
    expect(h.messages(room)).toHaveLength(count);
  });

  test("refuses a line with no buttons, and a button the line does not offer", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.script(director, dm).reply(say("好"));
    const plain = h.postUser(dm, "做片头");
    await h.waitIdle();
    expect(() => h.engine.control(plain.id, { action: "stop" })).toThrow("no control buttons");
    const stop = h.postUser(dm, "停一下");
    await h.routed();
    expect(() => h.engine.control(receiptAfter(h, dm, stop).id, { action: "continue_all" })).toThrow("does not offer");
  });
});
