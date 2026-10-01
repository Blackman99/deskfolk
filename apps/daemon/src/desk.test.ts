import { afterEach, expect, test } from "bun:test";
import { runCollabTool } from "./collab-tools";
import { Store } from "./store";
import { call, createScenario, endTurn, writeFile } from "./test-kit/scenario";
import { assembleTurnMessages } from "./context";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store();
  stores.push(store);
  store.raiseEngineLevel(null);
  const worker = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const other = store.createBot({ name: "Other", duties: "other", boundaries: "none" });
  const line = store.postMessage(worker.direct_session.id, { body: "Write a report" });
  const turn = store.createTurn({ sessionId: line.session_id, botId: worker.bot.id, triggerMessageId: line.id });
  const ctx = { store, botId: worker.bot.id, sessionId: line.session_id, turnId: turn.id, parentId: null };
  return { store, worker, other, line, turn, ctx };
}

test("an unfiled line with two possible plans opens a desk segment without silently choosing the current slot", () => {
  const { store, worker, ctx, turn: previous } = fixture();
  store.setTurnStatus(previous.id, "completed");
  store.openTask({ sessionId: ctx.sessionId, title: "Report" });
  store.openTask({ sessionId: ctx.sessionId, title: "Website" });
  const line = store.postMessage(ctx.sessionId, { body: "Change the style" });
  const turn = store.createTurn({ sessionId: ctx.sessionId, botId: worker.bot.id, triggerMessageId: line.id });
  expect(turn.task_id).toBeNull();
  expect(turn.mode).toBe("desk");
  expect(store.deskCandidateIds(turn.id)).toHaveLength(2);
});

test("opening a second plan does not park in-flight work in the deterministic engine", () => {
  const { store, ctx } = fixture();
  const existing = store.openTask({ sessionId: ctx.sessionId, title: "Report" });
  store.openTask({ sessionId: ctx.sessionId, title: "Website" });
  expect(store.getTask(existing.id).status).toBe("active");
  expect(store.getTask(existing.id).closed_at).toBeNull();
});

test("work_on opens the quoted request and binds its produce ticket in one operation", async () => {
  const { store, line, turn, ctx } = fixture();
  const result = await runCollabTool(ctx, "work_on", {
    plan: { new: { title: "Report", quote_message_id: line.id } },
    ticket: { new: { title: "Draft", deliverable: "report.md" } },
  });
  expect(result.ok).toBe(true);
  const bound = store.getTurn(turn.id);
  expect(bound.task_id).not.toBeNull();
  expect(bound.ticket_id).not.toBeNull();
  expect(store.getTicket(bound.ticket_id!).title).toBe("Draft");
  expect(store.getTicket(bound.ticket_id!).worker).toBe(ctx.botId);
  expect(store.getTask(bound.task_id!).brief).toBe("Write a report");
  expect(store.getMessage(line.id).task_id).toBe(bound.task_id);
  expect(result.emitted.some((entry) => entry.kind === "message" && entry.message.body.includes("Report"))).toBe(true);
});

test("an ambiguous desk segment cannot write until it chooses a captured plan", async () => {
  const h = await createScenario({ workItems: true });
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    h.store.openTask({ sessionId: direct, title: "Report" });
    h.store.openTask({ sessionId: direct, title: "Website" });
    h.script(bot!).reply(call(writeFile("wrong.txt", "must not exist")), call(endTurn()));
    h.postUser(direct, "Change the style");
    await h.waitIdle();
    const writes = h.toolCalls(bot!, "write_file");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.result).toEqual({ ok: false, error: "needs_filing" });
    expect(h.turns(bot!)[0]!.task_id).toBeNull();
  } finally {
    await h.close();
  }
});

test("two refused desk effects finish as needs_attention instead of trying indefinitely", async () => {
  const h = await createScenario({ workItems: true });
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    h.store.openTask({ sessionId: direct, title: "Report" });
    h.store.openTask({ sessionId: direct, title: "Website" });
    h.script(bot!).reply(call(writeFile("wrong.txt", "first")), call(writeFile("wrong.txt", "second")), call(writeFile("wrong.txt", "third")));
    h.postUser(direct, "Change the style");
    await h.waitIdle();
    expect(h.toolCalls(bot!, "write_file")).toHaveLength(2);
    expect(h.turns(bot!)[0]!.end_reason).toBe("needs_attention");
  } finally {
    await h.close();
  }
});

test("a new standalone effect opens a produce job once and then uses that ticket's working directory", async () => {
  const h = await createScenario({ workItems: true });
  try {
    const [bot] = h.createBots("Writer");
    h.script(bot!).reply(call(writeFile("report.md", "draft")), call(endTurn()));
    h.postUser(h.direct(bot!), "Write a report");
    await h.waitIdle();
    const turn = h.turns(bot!)[0]!;
    expect(turn.task_id).not.toBeNull();
    expect(turn.ticket_id).not.toBeNull();
    expect(h.toolCalls(bot!, "write_file")[0]!.result?.ok).toBe(true);
    expect(h.messages(h.direct(bot!)).filter((message) => message.body.includes("新开："))).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("work_on merges the actual trigger into a busy job and finishes the extra desk segment", async () => {
  const h = await createScenario({ workItems: true });
  const waiting = Promise.withResolvers<void>();
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const plan = h.store.openTask({ sessionId: direct, title: "Report" });
    const first = h.store.postMessage(direct, { body: "Work on the report" });
    h.store.db.run("UPDATE messages SET task_id = ? WHERE id = ?", [plan.id, first.id]);
    h.script(bot!).reply(async () => { await waiting.promise; return call(endTurn()); });
    await h.engine.handleInboundMessage(h.store.getMessage(first.id), { fromUser: true });
    await h.routed();
    const line = h.store.postMessage(direct, { body: "Also revise its tone" });
    const extra = h.store.createTurn({ sessionId: direct, botId: bot!.id, triggerMessageId: line.id });
    const result = await runCollabTool({ store: h.store, botId: bot!.id, sessionId: direct, turnId: extra.id, parentId: null }, "work_on", { plan: plan.id });
    expect(result).toMatchObject({ ok: true, data: { merged: true, ended: true } });
    const target = h.turns(bot!).find((turn) => turn.id !== extra.id && turn.task_id === plan.id)!;
    expect(h.store.queuedForTurn(target.id).some((item) => item.message_id === line.id && item.body_snapshot === line.body)).toBe(true);
  } finally {
    waiting.resolve();
    await h.close();
  }
});

test("work items remain distinct per ticket, while a desk also has a durable work item", () => {
  const { store, ctx, turn } = fixture();
  expect(turn.work_item_id).not.toBeNull();
  const plan = store.openTask({ sessionId: ctx.sessionId, title: "Report" });
  const first = store.createTicket({ taskId: plan.id, title: "Draft" });
  const second = store.createTicket({ taskId: plan.id, title: "Review" });
  const one = store.findOrCreateWorkItem({ botId: ctx.botId, sessionId: ctx.sessionId, taskId: plan.id, ticketId: first.id });
  const two = store.findOrCreateWorkItem({ botId: ctx.botId, sessionId: ctx.sessionId, taskId: plan.id, ticketId: second.id });
  expect(two.id).not.toBe(one.id);
  expect(two.ticket_id).toBe(second.id);
});

test("a desk prompt lists the captured candidates instead of hiding the filing decision", () => {
  const { store, worker, ctx, turn: previous } = fixture();
  store.setTurnStatus(previous.id, "completed");
  store.openTask({ sessionId: ctx.sessionId, title: "Report" });
  store.openTask({ sessionId: ctx.sessionId, title: "Website" });
  const plan = store.planCandidates({ sessionId: ctx.sessionId, botId: worker.bot.id }).find((candidate) => candidate.title === "Report")!;
  const words = store.postMessage(ctx.sessionId, { body: "The report is for first-time readers" });
  store.fileMessage(words.id, { explicit: [{ taskId: plan.id }] });
  const line = store.postMessage(ctx.sessionId, { body: "Change the style" });
  const turn = store.createTurn({ sessionId: ctx.sessionId, botId: worker.bot.id, triggerMessageId: line.id });
  const messages = assembleTurnMessages(store, { sessionId: ctx.sessionId, botId: worker.bot.id, turnId: turn.id,
    triggerMessageId: line.id, locale: "en", interrupt: false, loop: [] });
  const text = messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
  expect(text).toContain("Desk segment");
  expect(text).toContain("Report");
  expect(text).toContain("Website");
  expect(text).toContain("work_on");
  expect(text).toContain("The report is for first-time readers");
  expect(text).toContain("Last activity");
});

test("Continue preserves a desk's captured choices and cannot bypass filing guards", () => {
  const { store, worker, ctx, turn: initial } = fixture();
  store.setTurnStatus(initial.id, "completed");
  store.openTask({ sessionId: ctx.sessionId, title: "Report" });
  store.openTask({ sessionId: ctx.sessionId, title: "Website" });
  const line = store.postMessage(ctx.sessionId, { body: "Change the style" });
  const cut = store.createTurn({ sessionId: ctx.sessionId, botId: worker.bot.id, triggerMessageId: line.id });
  const interrupted = store.interruptTurnRecord(cut.id)!;
  const continued = store.claimInterruptContinue(interrupted.note.id);
  expect(continued.mode).toBe("desk");
  expect(continued.work_item_id).not.toBeNull();
  expect(store.deskCandidateIds(continued.id)).toEqual(store.deskCandidateIds(cut.id));
});

test("a third job is durable and starts after a running job frees the Bot's slot", async () => {
  const h = await createScenario({ workItems: true });
  const waiting = Promise.withResolvers<void>();
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const plans = ["Report", "Website", "Book"].map((title) => h.store.openTask({ sessionId: direct, title }));
    h.script(bot!).reply(async () => { await waiting.promise; return call(endTurn()); },
      async () => { await waiting.promise; return call(endTurn()); }, call(endTurn()));
    for (const plan of plans) {
      const line = h.store.postMessage(direct, { body: `Work on ${plan.title}` });
      h.store.db.run("UPDATE messages SET task_id = ? WHERE id = ?", [plan.id, line.id]);
      await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    }
    expect(h.turns(bot!)).toHaveLength(2);
    const queued = h.store.db.query<{ state: string }, [string]>("SELECT state FROM work_items WHERE task_id = ?").get(plans[2]!.id);
    expect(queued?.state).toBe("queued");
    waiting.resolve();
    await h.waitIdle();
    expect(h.turns(bot!)).toHaveLength(3);
    expect(h.turns(bot!).some((turn) => turn.task_id === plans[2]!.id && turn.status === "completed")).toBe(true);
  } finally {
    waiting.resolve();
    await h.close();
  }
});

test("exhausting the filing budget suppresses later effects in the same hop", async () => {
  const h = await createScenario({ workItems: true });
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const a = h.store.openTask({ sessionId: direct, title: "Report" });
    h.store.openTask({ sessionId: direct, title: "Website" });
    h.script(bot!).reply(call(writeFile("wrong.txt", "one"), writeFile("wrong.txt", "two"),
      { name: "work_on", args: { plan: a.id } }, writeFile("wrong.txt", "three")));
    h.postUser(direct, "Change the style");
    await h.waitIdle();
    expect(h.toolCalls(bot!, "write_file").some((row) => row.result?.ok === true)).toBe(false);
    expect(h.turns(bot!)[0]!.task_id).toBeNull();
    expect(h.turns(bot!)[0]!.end_reason).toBe("needs_attention");
  } finally { await h.close(); }
});

test("a separate new request while a job runs opens a desk instead of being heard by the other job", async () => {
  const h = await createScenario({ workItems: true });
  const waiting = Promise.withResolvers<void>();
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const a = h.store.openTask({ sessionId: direct, title: "Report" });
    h.script(bot!).reply(async () => { await waiting.promise; return call(endTurn()); }, call(endTurn()));
    const first = h.store.postMessage(direct, { body: "Write report" });
    h.store.fileMessage(first.id, { explicit: [{ taskId: a.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(first.id), { fromUser: true });
    const other = h.postUser(direct, "另外再写一份摘要");
    await h.routed();
    const desks = h.turns(bot!).filter((turn) => turn.mode === "desk");
    expect(desks).toHaveLength(1);
    expect(desks[0]!.trigger_message_id).toBe(other.id);
    const work = h.turns(bot!).find((turn) => turn.task_id === a.id)!;
    expect(h.store.turnInbox(work.id).some((item) => item.message_id === other.id)).toBe(false);
  } finally { waiting.resolve(); await h.close(); }
});

test("a cold corrected work item adopts and reads the correction when its segment opens", async () => {
  const h = await createScenario({ workItems: true });
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const a = h.store.openTask({ sessionId: direct, title: "Report" });
    const b = h.store.openTask({ sessionId: direct, title: "Website" });
    const line = h.store.postMessage(direct, { body: "Change the style" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: a.id }] });
    const original = h.store.createTurn({ sessionId: direct, botId: bot!.id, triggerMessageId: line.id });
    h.store.setTurnStatus(original.id, "completed");
    h.store.refileMessage(line.id, { filings: [{ taskId: b.id }], userActionId: "correction" });
    let saw = false;
    h.script(bot!).reply(({ request }) => {
      saw = request.messages.some((message) => typeof message.content === "string" && message.content.includes("这句改归到 Website"));
      return call(endTurn());
    });
    h.tick();
    await h.waitIdle();
    expect(saw).toBe(true);
    expect(h.turns(bot!).some((turn) => turn.id !== original.id && turn.task_id === b.id)).toBe(true);
  } finally { await h.close(); }
});

test("a default filing can be split into a quoted new job before its first effect", async () => {
  const { store, worker, ctx, turn: initial } = fixture();
  store.setTurnStatus(initial.id, "completed");
  const a = store.openTask({ sessionId: ctx.sessionId, title: "Report" });
  const line = store.postMessage(ctx.sessionId, { body: "Make a website" });
  store.fileMessage(line.id, { botId: worker.bot.id });
  expect(store.getMessage(line.id).task_id).toBe(a.id);
  const turn = store.createTurn({ sessionId: ctx.sessionId, botId: worker.bot.id, triggerMessageId: line.id });
  const result = await runCollabTool({ ...ctx, turnId: turn.id }, "work_on", { plan: { new: { title: "Website", quote_message_id: line.id } } });
  expect(result.ok).toBe(true);
  expect(store.getTurn(turn.id).task_id).not.toBe(a.id);
  expect(store.getMessage(line.id).task_id).toBe(store.getTurn(turn.id).task_id);
});

test("a bot's invalid work_on calls share the bounded filing correction budget", async () => {
  const h = await createScenario({ workItems: true });
  try {
    const [bot] = h.createBots("Writer");
    h.script(bot!).reply(call({ name: "work_on", args: { plan: "not-a-candidate" } }),
      call({ name: "work_on", args: { plan: "not-a-candidate" } }), call(writeFile("wrong.txt", "must not run")));
    h.postUser(h.direct(bot!), "Write a report");
    await h.waitIdle();
    expect(h.toolCalls(bot!, "work_on")).toHaveLength(2);
    expect(h.toolCalls(bot!, "write_file")).toHaveLength(0);
    expect(h.turns(bot!)[0]!.end_reason).toBe("needs_attention");
  } finally { await h.close(); }
});

test("a desk answer does not wait behind the Bot's two working jobs", async () => {
  const h = await createScenario({ workItems: true });
  const waiting = Promise.withResolvers<void>();
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const plans = ["Report", "Website"].map((title) => h.store.openTask({ sessionId: direct, title }));
    h.script(bot!).reply(async () => { await waiting.promise; return call(endTurn()); },
      async () => { await waiting.promise; return call(endTurn()); }, call(endTurn()));
    for (const plan of plans) {
      const line = h.store.postMessage(direct, { body: `Work on ${plan.title}` });
      h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
      await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    }
    h.postUser(direct, "另外回答一个小问题");
    await h.routed();
    expect(h.turns(bot!).filter((turn) => turn.mode === "desk")).toHaveLength(1);
    expect(h.turns(bot!).filter((turn) => turn.task_id)).toHaveLength(2);
  } finally { waiting.resolve(); await h.close(); }
});

test("an explicit line about two jobs is dispatched to both authoritative filings", async () => {
  const h = await createScenario({ workItems: true });
  const waiting = Promise.withResolvers<void>();
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const a = h.store.openTask({ sessionId: direct, title: "Report" });
    const b = h.store.openTask({ sessionId: direct, title: "Website" });
    const line = h.store.postMessage(direct, { body: "Both need the new style" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: a.id }, { taskId: b.id }] });
    h.script(bot!).reply(async () => { await waiting.promise; return call(endTurn()); },
      async () => { await waiting.promise; return call(endTurn()); });
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    expect(h.turns(bot!).map((turn) => turn.task_id).sort()).toEqual([a.id, b.id].sort());
  } finally { waiting.resolve(); await h.close(); }
});

test("a desk cannot execute a third working job when its first effect binds new work", async () => {
  const h = await createScenario({ workItems: true });
  const waiting = Promise.withResolvers<void>();
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const plans = ["Report", "Website"].map((title) => h.store.openTask({ sessionId: direct, title }));
    h.script(bot!).reply(async () => { await waiting.promise; return call(endTurn()); },
      async () => { await waiting.promise; return call(endTurn()); }, ({ turn }) => call(
        { name: "work_on", args: { plan: { new: { title: "Book", quote_message_id: turn!.trigger_message_id } } } },
        writeFile("third.txt", "must wait")));
    for (const plan of plans) {
      const line = h.store.postMessage(direct, { body: `Work on ${plan.title}` });
      h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
      await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    }
    h.postUser(direct, "另外新写一本书");
    await h.routed();
    await h.waitFor(() => h.turns(bot!).some((turn) => turn.mode === "desk" && turn.status === "completed"));
    expect(h.toolCalls(bot!, "write_file").some((row) => row.result?.ok === true)).toBe(false);
    expect(h.turns(bot!).filter((turn) => turn.mode === "work" && turn.status === "running")).toHaveLength(2);
  } finally { waiting.resolve(); await h.close(); }
});

test("a continued zero-candidate desk still opens the original user's request on its first effect", async () => {
  const h = await createScenario({ workItems: true });
  const first = Promise.withResolvers<void>();
  try {
    const [bot] = h.createBots("Writer");
    let started = false;
    h.script(bot!).reply(async () => { started = true; await first.promise; return call(endTurn()); }, call(writeFile("report.md", "draft")), call(endTurn()));
    h.postUser(h.direct(bot!), "Write a report");
    await h.routed();
    await h.waitFor(() => started);
    const cut = h.turns(bot!)[0]!;
    const stopped = h.store.interruptTurnRecord(cut.id)!;
    h.engine.continueFromInterrupt(stopped.note.id);
    await h.waitFor(() => h.toolCalls(bot!, "write_file").some((row) => row.result?.ok === true));
    const continued = h.turns(bot!).find((turn) => turn.id !== cut.id)!;
    expect(continued.task_id).not.toBeNull();
    expect(h.store.getTask(continued.task_id!).brief).toBe("Write a report");
  } finally { first.resolve(); await h.close(); }
});

test("Continue queues interrupted work when two other jobs occupy its Bot's working slots", () => {
  const { store, worker, ctx, turn: initial } = fixture();
  store.setTurnStatus(initial.id, "completed");
  const plans = ["Report", "Website", "Book"].map((title) => store.openTask({ sessionId: ctx.sessionId, title }));
  const interrupted = store.createTurn({ sessionId: ctx.sessionId, botId: worker.bot.id, triggerMessageId: initial.trigger_message_id, taskId: plans[0]!.id });
  const cut = store.interruptTurnRecord(interrupted.id)!;
  for (const plan of plans.slice(1)) {
    const room = store.createGroup({ name: plan.title, members: [worker.bot.id, store.createBot({ name: `Helper-${plan.title}`, duties: "help", boundaries: "none" }).bot.id] });
    const line = store.postMessage(room.id, { body: "Work on this job" });
    store.createTurn({ sessionId: room.id, botId: worker.bot.id, triggerMessageId: line.id, taskId: plan.id });
  }
  const resumed = store.claimInterruptContinue(cut.note.id);
  expect(resumed.status).toBe("completed");
  expect(resumed.end_reason).toBe("queued");
  expect(store.listLiveTurns({ botId: worker.bot.id })).toHaveLength(2);
  expect(store.dispatchableWork()).toHaveLength(0);
});

test("a group mention dispatches every authoritative filing without rebinding all turns to the primary", async () => {
  const h = await createScenario({ workItems: true });
  const waiting = Promise.withResolvers<void>();
  try {
    const [bot, helper] = h.createBots("Writer", "Helper");
    const room = h.group("Studio", [bot!, helper!]);
    const a = h.store.openTask({ sessionId: room, title: "Report" });
    const b = h.store.openTask({ sessionId: room, title: "Website" });
    const line = h.store.postMessage(room, { body: "@Writer Both need the new style" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: a.id }, { taskId: b.id }] });
    h.script(bot!).reply(async () => { await waiting.promise; return call(endTurn()); },
      async () => { await waiting.promise; return call(endTurn()); });
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    expect(h.turns(bot!).map((turn) => turn.task_id).sort()).toEqual([a.id, b.id].sort());
  } finally { waiting.resolve(); await h.close(); }
});

test("durable mail arriving in a segment's final hop is read once by the next segment", async () => {
  const h = await createScenario({ workItems: true });
  const release = Promise.withResolvers<void>();
  let started = false;
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const plan = h.store.openTask({ sessionId: direct, title: "Report" });
    h.script(bot!).reply(async () => { started = true; await release.promise; return call(endTurn()); }, call(endTurn()));
    const first = h.store.postMessage(direct, { body: "Work on the report" });
    h.store.fileMessage(first.id, { explicit: [{ taskId: plan.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(first.id), { fromUser: true });
    await h.waitFor(() => started);
    const current = h.turns(bot!)[0]!;
    const later = h.store.postMessage(direct, { body: "The last correction must still be heard" });
    const item = h.store.queueInboxItem({ botId: bot!.id, sessionId: direct, turnId: current.id,
      taskId: plan.id, ticketId: null, messageId: later.id, author: "user", body: later.body, source: "user", kind: "change", priority: 1 });
    release.resolve();
    await h.waitIdle();
    expect(h.turns(bot!)).toHaveLength(2);
    expect(h.store.getInboxItem(item.seq)!.delivered_turn_id).not.toBe(current.id);
    expect(h.hops(bot!).filter((hop) => hop.request.messages.some((message) => typeof message.content === "string"
      && message.content.includes("The last correction must still be heard")))).toHaveLength(1);
  } finally { release.resolve(); await h.close(); }
});

test("work_on cannot move a desk turn into a plan outside its captured candidates", async () => {
  const { store, other, turn, ctx } = fixture();
  const foreign = store.openTask({ sessionId: other.direct_session.id, title: "Private job" });
  const result = await runCollabTool(ctx, "work_on", { plan: foreign.id });
  expect(result).toMatchObject({ ok: false, error: { code: "invalid_candidate" } });
  expect(store.getTurn(turn.id).task_id).toBeNull();
  expect(store.getTask(foreign.id).title).toBe("Private job");
});
