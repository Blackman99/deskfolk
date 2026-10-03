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
import { call, checkBack, createScenario, endTurn, requestText, say, sendMessage, shell, tool, type Scenario, type ScenarioOptions } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

// These control-plane regressions pin P4b (level 2): P4c delegation and end contracts are
// exercised separately in delegation-engine.test.ts, not silently enabled by future bumps.
async function scenario(options: ScenarioOptions = { workItems: true }): Promise<Scenario> {
  const h = await createScenario(options);
  open.push(h);
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
  test("makes a hold of yours, ends every turn it covers, sets its appointments aside and says so, with no model call", async () => {
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
    // No filing, no turn, no model call for the line.
    expect(h.judgeCalls().filter((row) => row.at > stop.created_at)).toEqual([]);
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
  test("lifts the stop and opens each stopped turn again on a note with your words and where it was", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }), [
      call(checkBack(30, "看母带导出好没有"), shell("printf cut > EP01_MASTER.mp4")),
    ]);
    const dm = h.direct(director);
    h.postUser(dm, "你手头的生成停一下");
    await h.routed();
    h.script(director, thread).reply(say("看过了，母带还在"));

    const go = h.postUser(dm, "继续");
    await h.waitIdle();

    const [hold] = holds(h);
    expect(hold).toMatchObject({ lifted_by: "user_text", lifted_message_id: go.id });
    // The stopped work opens again in its own direct, on the same plan, on a note.
    const [resumed] = h.turns(director).filter((row) => row.created_at > go.created_at);
    expect(resumed).toMatchObject({ session_id: thread, task_id: ep01.id, mode: "work" });
    expect(hold!.effect.resumed_turns).toEqual([resumed!.id]);
    const note = h.store.getMessage(resumed!.trigger_message_id);
    expect(note).toMatchObject({ kind: "system", author: director.id, turn_id: turn.id });
    expect(note.body).toContain("「继续」");
    expect(note.body).toContain("规划「EP01」");
    expect(note.body).toContain("shell printf cut > EP01_MASTER.mp4");
    for (const push of ["接着干", "接着推进", "接着做"]) expect(note.body).not.toContain(push);
    expect(requestText(h.hops(director).find((hop) => hop.turnId === resumed!.id)!.request)).toContain("「继续」");
    // Its appointment is back on the clock.
    expect(h.store.getCheckBack(hold!.effect.suspended_check_backs![0]!)).toMatchObject({ suspended_at: null, voided_at: null });
    // The line itself is not filed (the plan is, once the turn it opened ends); the receipt says what came back.
    expect(h.judgeCalls("organizer").filter((row) => row.at > go.created_at && row.sessionId === dm)).toEqual([]);
    const receipt = after(h, dm, go).find((message) => message.kind === "system")!;
    expect(receipt.control).toMatchObject({ kind: "receipt", verb: "continue", hold_ids: [hold!.id], offer: [] });
    expect(receipt.body).toContain("已解除叫停：视频导演的全部工作");
    expect(receipt.body).toContain("1 段被停下的工作带着一条说明重新开始");
    expect(receipt.body).toContain("1 个回看恢复");
  });

  test("the note the stopped work opens again on is for that Bot alone: the turn it wakes reads it, nothing else shows it", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }), [
      call(shell("printf cut > EP01_MASTER.mp4")),
    ]);
    const dm = h.direct(director);
    h.postUser(dm, "你手头的生成停一下");
    await h.routed();
    const committed: ClientEvent[] = [];
    const unsubscribe = h.store.onCommit((event) => committed.push(event));
    const published = h.events.length;
    // The work opens again and stays mid-hop, so the note is still the newest line in its direct.
    let woke = null as string | null;
    h.script(director, thread).reply(({ request }) => {
      woke = requestText(request);
      return new Promise<CompletionResult>(() => {});
    });

    const go = h.postUser(dm, "继续");
    await h.waitFor(() => woke !== null, { what: "the stopped work to open again" });
    unsubscribe();

    const [resumed] = h.turns(director).filter((row) => row.created_at > go.created_at);
    const note = h.store.getMessage(resumed!.trigger_message_id);
    expect(note).toMatchObject({ kind: "system", author: director.id, turn_id: turn.id });
    // The turn it wakes reads it, as what woke it.
    expect(woke).toContain("（本轮触发）\n（应用提示）用户叫停了这件工作，现在解除了（原话：「继续」）。");
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
    // What you see is the go on's receipt.
    expect(after(h, dm, go).map((message) => message.control?.kind)).toEqual(["receipt"]);
    // The flow board still draws the work waking again from the turn the stop ended.
    expect(h.store.taskTrace(ep01.id).nodes.find((node) => node.turn_id === resumed!.id)?.woken_by_turn_id).toBe(turn.id);
  });

  test("to a Bot lifts a stop on its work in one plan too, and that work opens again", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const hold = h.engine.createHold({ scope: "bot_plan", scopeId: `${director.id}:${ep01.id}` });
    h.script(director, thread).reply(say("母带接着拼"));

    const go = h.postUser(h.direct(director), "继续");
    await h.waitIdle();

    expect(h.store.getHold(hold.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: go.id });
    expect(h.turns(director).filter((row) => row.created_at > go.created_at).map(({ session_id, task_id }) => ({ session_id, task_id }))).toEqual([
      { session_id: thread, task_id: ep01.id },
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

  test("that lifts a stop on a Bot also lifts your Stop on the job it is about, and that work opens again on the same note", async () => {
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
    const [resumed] = h.turns(director).filter((row) => row.created_at > go.created_at);
    expect(resumed).toMatchObject({ session_id: dm, task_id: plan.id });
    const note = h.store.getMessage(resumed!.trigger_message_id);
    expect(note).toMatchObject({ kind: "system", turn_id: turn.id });
    expect(note.body).toContain("「继续」");
    expect(note.body).toContain("shell printf a > intro.mp4");
    // In your direct too the note is the Bot's to read, not a line of the conversation.
    expect(requestText(h.hops(director).find((hop) => hop.turnId === resumed!.id)!.request)).toContain("用户叫停了这件工作，现在解除了");
    expect(h.store.listMessages(dm).items.map((message) => message.id)).not.toContain(note.id);
  });

  test("under a hold it does not lift says so and offers the buttons, and opens nothing", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    h.postUser(room, "所有Bot停下");
    await h.routed();
    const dm = h.direct(director);

    const go = h.postUser(dm, "继续");
    await h.waitIdle();

    expect(holds(h).map(({ scope, lifted_at }) => ({ scope, lifted_at }))).toEqual([{ scope: "global", lifted_at: null }]);
    expect(h.turns(director)).toEqual([]);
    const [answer] = after(h, dm, go);
    expect(answer!.control).toMatchObject({ kind: "status", offer: ["continue_only", "continue_all"] });
    expect(answer!.body).toContain("所有 Bot 的工作");
  });

  test("naming one Bot in a group stopped as a whole lifts nothing and restarts nobody: the group's stop stands, with the buttons", async () => {
    const h = await scenario();
    const { director, writer, room } = videoTeam(h);
    const shooting = await atWork(h, director, room, () => h.postUser(room, "@视频导演 出第三镜"));
    const writing = await atWork(h, writer, room, () => h.postUser(room, "@编剧分镜师 第三场改成夜景"));
    h.postUser(room, "大家先停一下");
    await h.routed();
    const [group] = holds(h);

    const go = h.postUser(room, "@视频导演 继续");
    await h.waitIdle();

    expect(h.store.getHold(group!.id).lifted_at).toBeNull();
    expect(h.turns(director).map((row) => row.id)).toEqual([shooting.id]);
    expect(h.turns(writer).map((row) => row.id)).toEqual([writing.id]);
    const answer = after(h, room, go).find((message) => message.kind === "system")!;
    expect(answer.control).toMatchObject({ kind: "status", hold_ids: [group!.id], offer: ["continue_only", "continue_all"] });
    expect(answer.body).toContain("这里的工作");
  });

  test("「@X 继续」 in a group where you stopped the job lifts nothing and restarts nobody: the job's stop stands, with the buttons", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const working = await atWork(h, director, room, () => h.postUser(room, "@视频导演 EP01 出第三镜"));
    h.postUser(room, "这件事停一下");
    await h.routed();
    const [onPlan] = holds(h);
    expect(onPlan).toMatchObject({ scope: "plan", scope_id: ep01.id });

    // The control plane runs before ordinary filing. Capture the explicit UI job choice before
    // admission rather than relying on the old conversation-current-plan fallback.
    const go = h.store.postMessage(room, { body: "@视频导演 继续" });
    h.store.fileMessage(go.id, { explicit: [{ taskId: ep01.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(go.id), { fromUser: true });
    await h.waitIdle();

    expect(h.store.getHold(onPlan!.id).lifted_at).toBeNull();
    expect(h.turns(director).map((row) => row.id)).toEqual([working.id]);
    const answer = after(h, room, go).find((message) => message.kind === "system")!;
    expect(answer.control).toMatchObject({ kind: "status", hold_ids: [onPlan!.id], offer: ["continue_only", "continue_all"] });
    expect(answer.body).toContain("「EP01」这件事");
  });

  test("「@X 继续」 after 「你停下」 in a group lifts X's own stop and leaves the group's, with the buttons", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const line = h.postBot(director, room, "Shot 11 交了");
    await h.waitIdle();
    h.postUser(room, "你停下", { parentId: line.id });
    await h.routed();
    const [own, group] = holds(h);

    const go = h.postUser(room, "@视频导演 继续");
    await h.waitIdle();

    expect(h.store.getHold(own!.id).lifted_message_id).toBe(go.id);
    expect(h.store.getHold(group!.id).lifted_at).toBeNull();
    const receipt = after(h, room, go).find((message) => message.kind === "system")!;
    expect(receipt.control).toMatchObject({ kind: "receipt", verb: "continue", hold_ids: [own!.id], offer: ["continue_only", "continue_all"] });
    expect(receipt.body).toContain("仍在叫停中：这里的工作");
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

  test("opens stopped work beside a read-only turn still answering you there, not inside it", async () => {
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

    h.postUser(room, "@视频导演 继续");
    await h.routed();

    const [resumed] = h.store.getHold(hold!.id).effect.resumed_turns!;
    expect(resumed).not.toBe(answering.id);
    expect(h.store.getTurn(resumed!)).toMatchObject({ session_id: room, task_id: ep01.id, mode: "work" });
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

    h.postUser(dm, "继续");
    await h.routed();

    expect(h.store.getHold(onPlan.id).effect.held_over!.map((row) => row.turn_id)).toEqual([turn.id]);
    expect(h.store.getHold(likeStop.id).effect.held_over).toBeUndefined();
    h.script(director, thread).reply(call(endTurn()));
    h.engine.liftHold(likeStop.id);
    h.engine.liftHold(onPlan.id);
    await h.waitIdle();
    expect(h.turns(director).filter((row) => row.id !== turn.id).map(({ session_id, task_id }) => ({ session_id, task_id }))).toEqual([
      { session_id: thread, task_id: ep01.id },
    ]);
  });
});

describe("asking whether it stopped", () => {
  test("「怎么还在跑？」 with nothing held answers from what runs and offers a stop", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const dm = h.direct(director);

    const ask = h.postUser(dm, "怎么还在跑？");
    await h.routed();

    expect(holds(h)).toEqual([]);
    const [answer] = after(h, dm, ask);
    expect(answer!.control).toMatchObject({ kind: "status", hold_ids: [], offer: ["stop"] });
    expect(answer!.body).toContain("视频导演：没有被叫停");
    expect(answer!.body).toContain("此刻在跑：EP01");
    expect(h.judgeCalls().filter((row) => row.at > ask.created_at)).toEqual([]);
  });

  // 2026-10-03: the job was opened in a direct, the group's lines were filed under it, and 审片员
  // reviewed it in a Bot↔Bot direct opened from the group; the group was told 「此刻在跑：无」.
  test("in a group, it names work on the group's job that runs where a stop in the group does not reach", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const dm = h.direct(director);
    const ep01 = openPlan(h, dm, "EP01", planSpec("EP01 动画成片"));
    const asked = h.postBot(director, room, "母带好了，我私下找审片员审", { taskId: ep01.id });
    const thread = h.botDirect(director, reviewer, { sessionId: room, messageId: asked.id });
    await atWork(h, reviewer, thread, () => h.postBot(director, thread, "EP01 母带请审", { taskId: ep01.id }));

    const ask = h.postUser(room, "怎么还在跑？");
    await h.routed();

    const [answer] = after(h, room, ask);
    expect(answer!.control).toMatchObject({ kind: "status", hold_ids: [] });
    expect(answer!.body).toContain("此刻在跑：无");
    expect(answer!.body).toContain("别处也在做这里的事（在这里叫停停不到）：审片员 · EP01");
    // In the direct the job belongs to, the same work is what is running, and nothing is listed twice.
    const there = h.postUser(dm, "怎么还在跑？");
    await h.routed();
    const [direct] = after(h, dm, there);
    expect(direct!.body).not.toContain("别处");
  });

  test("in a group, work on a job your lines there were filed under counts too, wherever it runs", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const dm = h.direct(director);
    const ep01 = openPlan(h, dm, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    await atWork(h, reviewer, thread, () => h.postBot(director, thread, "EP01 母带请审", { taskId: ep01.id }));
    const filed = h.postUser(room, "片头再短一点");
    h.store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [ep01.id, filed.id]);

    const ask = h.postUser(room, "怎么还在跑？");
    await h.routed();

    const [answer] = after(h, room, ask).filter((message) => message.control?.kind === "status");
    expect(answer!.body).toContain("别处也在做这里的事（在这里叫停停不到）：审片员 · EP01");
  });

  test.each([
    ["「能停么」 asks whether it can stop: the answer offers the button and stops nothing", "能停么", ["stop"]],
    ["「怎么能停」 asks about a stop: the answer offers nothing and stops nothing", "怎么能停", []],
  ])("%s", async (_, words, offer) => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const working = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const dm = h.direct(director);

    const ask = h.postUser(dm, words);
    await h.routed();

    expect(holds(h)).toEqual([]);
    expect(h.store.getTurn(working.id).status).toBe("running");
    expect(h.turns(director).map((row) => row.id)).toEqual([working.id]);
    const [answer] = after(h, dm, ask);
    expect(answer!.control).toMatchObject({ kind: "status", hold_ids: [], offer });
    expect(answer!.body).toContain("此刻在跑：EP01");
  });

  test("「你没停」 under a hold ends what still runs under it, records the violation and answers", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    // A hold written with nothing ending what it covers: the case the check is there for.
    const hold = h.store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });
    const dm = h.direct(director);

    const told = h.postUser(dm, "你没停");
    await h.routed();

    expect(h.store.getTurn(turn.id).status).toBe("stopped");
    expect(h.store.getHold(hold.id).effect.violations).toEqual([turn.id]);
    expect(h.store.listWorkEvents({ kind: "hold.violation" }).map((row) => ({ turn: row.turn_id, hold: row.payload.hold }))).toEqual([
      { turn: turn.id, hold: hold.id },
    ]);
    const [answer] = after(h, dm, told);
    expect(answer!.body).toContain("视频导演：叫停中");
    expect(answer!.body).toContain("刚才发现叫停下还有在跑的，已停下：EP01");
    expect(answer!.body).toContain("此刻在跑：无");
  });
});

describe("a status question under a stop", () => {
  test("「还在做吗」 to a held Bot with no plan to report on gets where the stop stands, not a turn", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.postUser(dm, "停下你所有的工作");
    await h.routed();

    const ask = h.postUser(dm, "还在做吗");
    await h.waitIdle();

    expect(h.turns(director)).toEqual([]);
    expect(h.judgeCalls().filter((row) => row.at > ask.created_at)).toEqual([]);
    const [answer] = after(h, dm, ask);
    expect(answer!.control).toMatchObject({ kind: "status" });
    expect(answer!.body).toContain("视频导演：叫停中");
  });

  test("「还在做吗」 about a plan names the stops over it, after ending anything still running under one", async () => {
    const h = await scenario();
    const { director, reviewer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }));
    const hold = h.store.createHold({ scope: "bot", scopeId: director.id, source: "user_button" });

    const ask = h.postUser(room, "还在做吗");
    await h.routed();

    expect(h.store.getTurn(turn.id).status).toBe("stopped");
    expect(h.store.getHold(hold.id).effect.violations).toEqual([turn.id]);
    const [answer] = after(h, room, ask);
    expect(answer!.body).toContain("这件事：EP01");
    expect(answer!.body).toContain("叫停：视频导演的全部工作");
    expect(answer!.body).toContain("刚才发现叫停下还有在跑的，已停下");
    expect(answer!.body).toContain("现在没有人在做");
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

  test("the same request under a stop on the Bot offers 继续, and the press lifts it", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    const hold = h.engine.createHold({ scope: "bot", scopeId: director.id });
    h.script(director, dm).reply(say("好"));

    const line = h.postUser(dm, "继续做第二集，琦玉跟杰诺斯参加英雄协会报名");
    await h.waitIdle();

    expect(h.store.getMessage(line.id).control).toEqual({ kind: "possible_control", offer: ["continue"], scopes: [{ scope: "bot", id: director.id }] });
    const { lifted } = h.engine.control(line.id, { action: "continue" });
    expect(lifted.map((row) => row.id)).toEqual([hold.id]);
  });

  test("「算了」 alone stops and drops nothing: it asks which, and the Bot still gets it", async () => {
    const h = await scenario();
    const { director } = videoTeam(h);
    const dm = h.direct(director);
    h.script(director, dm).reply(say("好"));

    const line = h.postUser(dm, "算了");
    await h.waitIdle();

    expect(holds(h)).toEqual([]);
    expect(h.store.getMessage(line.id).control).toMatchObject({ kind: "possible_control", offer: ["stop", "cancel"] });
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
    const receipt = h.messages(dm).filter((message) => message.kind === "system").at(-1)!;
    expect(receipt.body).toContain("你在这件事上再说话，它就接着往下");

    h.script(director, dm).reply(say("好，换成慢速"));
    const next = h.postUser(dm, "片头改成慢速");
    await h.waitIdle();

    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: next.id });
    expect(h.store.getCheckBack(booked.id)).toMatchObject({ suspended_at: null, voided_at: null });
    // Your line is what it goes on from: one turn on it, no note of the app's.
    const opened = h.turns(director).filter((row) => row.created_at > next.created_at);
    expect(opened.map((row) => h.store.getMessage(row.trigger_message_id).id)).toEqual([next.id]);
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
  ])("pressed on a job in a direct between Bots, 「继续」 to that Bot %s lifts it and opens that work again on a note", async (_, words) => {
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
    const where = words === "继续" ? h.direct(director) : room;

    const go = h.postUser(where, words);
    await h.waitIdle();

    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: go.id });
    // The work opens again where it was, on the note with your words; nothing opens on the line itself.
    const opened = h.turns(director).filter((row) => row.created_at > go.created_at);
    expect(opened.map(({ session_id, task_id, mode }) => ({ session_id, task_id, mode }))).toEqual([{ session_id: thread, task_id: ep01.id, mode: "work" }]);
    const note = h.store.getMessage(opened[0]!.trigger_message_id);
    expect(note).toMatchObject({ kind: "system", turn_id: turn.id });
    expect(note.body).toContain(`「${words}」`);
    expect(note.body).toContain("shell printf cut > EP01_MASTER.mp4");
    const receipt = after(h, where, go).find((message) => message.kind === "system")!;
    expect(receipt.control).toMatchObject({ kind: "receipt", verb: "continue", hold_ids: [hold!.id], offer: [] });
  });

  test.each([
    ["in the room", "所有Bot继续"],
    ["in its direct", "所有Bot继续"],
    ["in the room", "全都继续"],
  ])("pressed on a job in a direct between Bots, a go on that names everything %s (「%s」) lifts it and opens that work again on a note", async (place, words) => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, h.direct(reviewer), "EP01", planSpec("EP01 动画成片"));
    const thread = h.botDirect(director, reviewer);
    const turn = await atWork(h, director, thread, () => h.postBot(reviewer, thread, "EP01 母带重新拼一遍", { taskId: ep01.id }), [
      call(shell("printf cut > EP01_MASTER.mp4")),
    ]);
    h.engine.stop(turn.id, { button: true });
    await h.waitIdle();
    const [hold] = holds(h);
    h.script(director, thread).reply(say("母带接着拼"));
    const where = place === "in the room" ? room : h.direct(director);

    const go = h.postUser(where, words);
    await h.waitIdle();

    expect(h.store.getHold(hold!.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: go.id });
    // The work opens again where it was, on the note with your words; nothing opens on the line itself.
    const opened = h.turns(director).filter((row) => row.created_at > go.created_at);
    expect(opened.map(({ session_id, task_id, mode }) => ({ session_id, task_id, mode }))).toEqual([{ session_id: thread, task_id: ep01.id, mode: "work" }]);
    expect([director, reviewer, writer].flatMap((bot) => h.turns(bot)).filter((row) => row.trigger_message_id === go.id)).toEqual([]);
    const note = h.store.getMessage(opened[0]!.trigger_message_id);
    expect(note).toMatchObject({ kind: "system", turn_id: turn.id });
    expect(note.body).toContain(`「${words}」`);
    expect(note.body).toContain("shell printf cut > EP01_MASTER.mp4");
    const receipt = after(h, where, go).find((message) => message.kind === "system")!;
    expect(receipt.control).toMatchObject({ kind: "receipt", verb: "continue", hold_ids: [hold!.id], offer: [] });
  });

  test("「@X 继续」 lifts and opens again X's Stops only, not another Bot's on the plan the line lands on", async () => {
    const h = await scenario();
    const { director, reviewer, writer, room } = videoTeam(h);
    const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
    const ep02 = openPlan(h, h.direct(writer), "EP02", planSpec("EP02 动画成片"));
    const reviewing = h.botDirect(reviewer, writer);
    const review = await atWork(h, reviewer, reviewing, () => h.postBot(writer, reviewing, "EP01 第三镜审一下", { taskId: ep01.id }));
    const thread = h.botDirect(director, writer);
    const cut = await atWork(h, director, thread, () => h.postBot(writer, thread, "EP02 母带重新拼一遍", { taskId: ep02.id }), [
      call(shell("printf cut > EP02_MASTER.mp4")),
    ]);
    h.engine.stop(review.id, { button: true });
    h.engine.stop(cut.id, { button: true });
    await h.waitIdle();
    const [onReview, onCut] = holds(h);
    expect([onReview!.scope_id, onCut!.scope_id]).toEqual([`${reviewer.id}:${ep01.id}`, `${director.id}:${ep02.id}`]);
    h.script(director, thread).reply(say("EP02 母带接着拼"));

    const go = h.postUser(room, "@视频导演 继续");
    await h.waitIdle();

    expect(h.store.getHold(onCut!.id)).toMatchObject({ lifted_by: "user_text", lifted_message_id: go.id });
    expect(h.store.getHold(onReview!.id).lifted_at).toBeNull();
    // 视频导演's work opens again where it was; 审片员 stays stopped until you speak to it about EP01.
    expect(h.turns(director).filter((row) => row.created_at > go.created_at).map(({ session_id, task_id }) => ({ session_id, task_id }))).toEqual([
      { session_id: thread, task_id: ep02.id },
    ]);
    expect(h.turns(reviewer).filter((row) => row.created_at > go.created_at)).toEqual([]);
    const receipt = after(h, room, go).find((message) => message.kind === "system")!;
    expect(receipt.control).toMatchObject({ kind: "receipt", verb: "continue", hold_ids: [onCut!.id] });
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

  test("stops one Bot's turn in a group, the others' going on, and says so in the group", async () => {
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
    const receipt = h.messages(room).find((message) => message.control?.kind === "receipt");
    expect(receipt?.control).toMatchObject({ verb: "stop", hold_ids: [hold!.id], offer: ["undo"] });
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
});

describe("a read-only answer that says nothing", () => {
  test("is answered by the app with the go on buttons, which lift the stop and take up your line", async () => {
    const h = await scenario();
    const { director, room } = videoTeam(h);
    const [hold] = [h.engine.createHold({ scope: "session", scopeId: room })];
    h.script(director, room).reply(call(endTurn()));

    const line = h.postUser(room, "@视频导演 从头再做一遍");
    await h.waitIdle();

    expect(h.turns(director).map(({ mode, status }) => ({ mode, status }))).toEqual([{ mode: "readonly", status: "completed" }]);
    const status = after(h, room, line).find((message) => message.control?.kind === "status")!;
    expect(status.control).toMatchObject({ kind: "status", hold_ids: [hold!.id], offer: ["continue_only", "continue_all"], unanswered: line.id });
    expect(status.body.split("\n")[0]).toBe("视频导演没有回话：它被叫停着，这一段只能读和回答，不会照你的话动手。");
    expect(status.body.split("\n").at(-1)).toBe("点下面的按钮解除，它就照你这句做。");

    h.script(director, room).reply(say("好，从头做"));
    const { lifted } = h.engine.control(status.id, { action: "continue_all" });
    await h.waitIdle();

    expect(lifted.map((row) => row.id)).toEqual([hold!.id]);
    const working = h.turns(director).filter((row) => row.mode !== "readonly");
    expect(working.map(({ trigger_message_id }) => trigger_message_id)).toEqual([line.id]);
    expect(h.messages(room).filter((message) => message.kind === "bot").at(-1)!.body).toBe("好，从头做");
  });

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

    h.script(director, room).reply(call(endTurn()));
    h.script(writer, room).reply(call(endTurn()));
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
    const goOn = h.postUser(room, "@视频导演 继续");
    await h.routed();
    const status = after(h, room, goOn).find((message) => message.control?.kind === "status")!;
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
