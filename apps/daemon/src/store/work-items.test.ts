/**
 * Work items (ADR 0040 P4b): one Bot works two jobs at once, a third waits; a line moves to
 * another job with the inbox item it already reached; a group line with no name goes to the lead.
 */
import { expect, test } from "bun:test";
import { call, createScenario, endTurn, say, tool } from "../test-kit/scenario";

test("a third job waits behind the two a Bot is already on", async () => {
  const h = await createScenario({ workItems: true, settleQuietMs: 60_000 });
  const [director, reviewer] = h.createBots("视频导演", "审片员");
  const room = h.group("片场", [director!, reviewer!]);
  const held = Promise.withResolvers<void>();
  h.script(director).reply(async () => {
    await held.promise;
    return call(endTurn());
  }, async () => {
    await held.promise;
    return call(endTurn());
  });
  const one = h.store.openTask({ sessionId: room, title: "EP01" });
  const two = h.store.openTask({ sessionId: room, title: "回响纪元" });
  const three = h.store.openTask({ sessionId: room, title: "片头" });
  const say = (session: string, body: string, taskId: string) => {
    const message = h.store.insertMessage({ sessionId: session, kind: "user", author: "user", body });
    h.store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [taskId, message.id]);
    return message;
  };
  await h.engine.handleInboundMessage(say(room, "@视频导演 做 EP01", one.id), { fromUser: true });
  await h.routed();
  await h.engine.handleInboundMessage(say(h.direct(director!), "做回响纪元", two.id), { fromUser: true });
  await h.routed();
  await h.engine.handleInboundMessage(say(h.direct(director!), "做片头", three.id), { fromUser: true });
  await h.routed();

  const working = h.turns(director!).filter((turn) => turn.status === "running" || turn.status === "completed");
  expect(working.length).toBeLessThanOrEqual(2);
  expect(h.messages(h.direct(director!)).some((message) => message.body.includes("排在第"))).toBe(true);
  held.resolve();
  await h.close();
});

test("refiling a line moves the inbox item it reached", async () => {
  const h = await createScenario({ workItems: true });
  const [director, reviewer] = h.createBots("视频导演", "审片员");
  const room = h.group("片场", [director!, reviewer!]);
  const ep01 = h.store.openTask({ sessionId: room, title: "EP01" });
  const film = h.store.openTask({ sessionId: room, title: "回响纪元" });
  const line = h.store.insertMessage({ sessionId: h.direct(director), kind: "user", author: "user", body: "前三镜重做" });
  h.store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [ep01.id, line.id]);
  const turn = h.store.createTurn({ sessionId: h.direct(director), botId: director.id, triggerMessageId: line.id, taskId: ep01.id });
  const item = h.store.queueInboxItem({
    botId: director.id, sessionId: h.direct(director), turnId: turn.id, taskId: ep01.id, ticketId: null,
    messageId: line.id, author: "user", body: line.body, source: "user", kind: "change", priority: 1,
  });

  const moved = h.store.refileMessage(line.id, { taskId: film.id });
  expect(moved.task_id).toBe(film.id);
  expect(h.store.getInboxItem(item.seq)!.task_id).toBe(film.id);
  await h.close();
});

test("an unaddressed line in a group goes to its lead", async () => {
  const h = await createScenario({ workItems: true, settleQuietMs: 60_000 });
  const [director, reviewer] = h.createBots("视频导演", "审片员");
  const room = h.group("片场", [director, reviewer]);
  h.store.db.run(`UPDATE session_participants SET is_lead = 1 WHERE session_id = ? AND member = ?`, [room, reviewer.id]);
  const said: string[] = [];
  h.script(reviewer, room).reply(() => {
    said.push("reviewer");
    return say("我来");
  });
  h.script(director, room).reply(() => {
    said.push("director");
    return say("不该是我");
  });
  h.postUser(room, "这版再看一眼");
  await h.routed();
  await h.waitFor(() => said.length > 0);
  expect(said).toEqual(["reviewer"]);
  expect(h.judgeCalls("judgement")).toHaveLength(0);
  await h.close();
});

test("work_on binds the turn to the job it names", async () => {
  const h = await createScenario({ workItems: true });
  const [director, reviewer] = h.createBots("视频导演", "审片员");
  const room = h.group("片场", [director!, reviewer!]);
  const film = h.store.openTask({ sessionId: room, title: "回响纪元" });
  // The film is one of the director's jobs (work it has open from the group), so a line in its
  // direct may be put there; a group plan it never touched is no candidate (ADR 0040 §8.4).
  const held = h.store.findOrCreateWorkItem({ botId: director!.id, sessionId: room, taskId: film.id, ticketId: null });
  h.store.db.run("UPDATE work_items SET state = 'idle' WHERE id = ?", [held.id]);
  h.script(director).reply(call(tool("work_on", { plan: film.id })), say("改挂了"));
  h.postUser(h.direct(director), "接着做回响纪元");
  await h.waitIdle();
  const turn = h.turns(director!)[0]!;
  expect(turn.task_id).toBe(film.id);
  await h.close();
});
