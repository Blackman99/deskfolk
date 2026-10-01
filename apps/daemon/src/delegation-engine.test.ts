import { expect, test } from "bun:test";
import { call, createScenario, endTurn, sendMessage, tool, writeFile } from "./test-kit/scenario";

function hasWords(request: { messages: Array<{ content?: unknown }> }, words: string): boolean {
  return request.messages.some((message) => typeof message.content === "string" && message.content.includes(words));
}

test("a progress send does not end a working segment or discard its remaining independent work", async () => {
  const h = await createScenario({ delegation: true });
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const plan = h.store.openTask({ sessionId: direct, title: "Report" });
    const line = h.store.postMessage(direct, { body: "Write the report" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
    h.script(bot!).reply(call(sendMessage("I found the outline")), call(writeFile("report.md", "finished")), call(endTurn()));
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitIdle();
    expect(h.toolCalls(bot!, "write_file")).toHaveLength(1);
    expect(h.toolCalls(bot!, "write_file")[0]!.result?.ok).toBe(true);
    expect(h.turns(bot!)).toHaveLength(1);
    expect(h.messages(direct).flatMap((message) => message.attachments).some((attachment) => attachment.workspace_relpath === "report.md")).toBe(true);
  } finally { await h.close(); }
});

test("ordinary words in a Bot pair's thread never wake the other Bot", async () => {
  const h = await createScenario({ delegation: true });
  try {
    const [owner, helper] = h.createBots("Owner", "Helper");
    const group = h.group("Studio", [owner!, helper!]);
    const plan = h.store.openTask({ sessionId: group, title: "Report" });
    const from = h.store.postMessage(group, { body: "@Owner Ask the helper" });
    h.store.fileMessage(from.id, { explicit: [{ taskId: plan.id }] });
    h.script(owner!).reply(call(tool("delegate", { to: helper!.id, ask: "Find a citation", expects: "answer" })), call(endTurn()));
    h.script(helper!).reply(call(endTurn()));
    await h.engine.handleInboundMessage(h.store.getMessage(from.id), { fromUser: true });
    await h.waitIdle();
    const delegation = h.store.listDelegations()[0]!;
    const before = h.turns(owner!).length;
    h.postBot(helper!, delegation.thread_session_id, "@Owner Here is a courtesy acknowledgment", { taskId: plan.id });
    await h.routed();
    expect(h.turns(owner!)).toHaveLength(before);
    expect(h.store.db.query<{ wakes: number }, [string]>("SELECT wakes FROM inbox_items WHERE session_id = ? AND source = 'peer_note' ORDER BY seq DESC LIMIT 1").get(delegation.thread_session_id)?.wakes).toBe(0);
  } finally { await h.close(); }
});

test("a thread cannot summon an absent teammate through a plain @ message", async () => {
  const h = await createScenario({ delegation: true });
  try {
    const [owner, helper, outside] = h.createBots("Owner", "Helper", "Outside");
    const group = h.group("Studio", [owner!, helper!, outside!]);
    const plan = h.store.openTask({ sessionId: group, title: "Report" });
    const line = h.store.postMessage(group, { body: "@Owner Ask the helper" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
    h.script(owner!).reply(call(tool("delegate", { to: helper!.id, ask: "Find a citation", expects: "answer" })), call(endTurn()));
    h.script(helper!).reply(call(sendMessage("@Outside Review this answer")), call(endTurn()));
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitIdle();
    expect(h.toolCalls(helper!, "send_message")[0]!.result).toEqual({ ok: false, error: "use_delegate" });
    expect(h.turns(outside!)).toHaveLength(0);
    expect(h.messages(h.store.listDelegations()[0]!.thread_session_id).some((message) => message.body.includes("@Outside"))).toBe(false);
  } finally { await h.close(); }
});

test("a segment emits at most three progress lines but can still finish its work afterwards", async () => {
  const h = await createScenario({ delegation: true });
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const plan = h.store.openTask({ sessionId: direct, title: "Report" });
    const line = h.store.postMessage(direct, { body: "Write a report" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
    h.script(bot!).reply(call(sendMessage("Progress one"), sendMessage("Progress two"), sendMessage("Progress three"), sendMessage("Progress four")),
      call(writeFile("report.md", "finished")), call(endTurn()));
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitIdle();
    expect(h.messages(direct).filter((message) => message.kind === "bot" && message.body.startsWith("Progress"))).toHaveLength(3);
    expect(h.toolCalls(bot!, "send_message")[3]!.result).toEqual({ ok: false, error: "progress_limit" });
    expect(h.toolCalls(bot!, "write_file")[0]!.result?.ok).toBe(true);
  } finally { await h.close(); }
});

test("spoken completion cannot end an unfinished ticket without one contract bounce", async () => {
  const h = await createScenario({ delegation: true });
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const plan = h.store.openTask({ sessionId: direct, title: "Report" });
    const ticket = h.store.createTicket({ taskId: plan.id, title: "Draft", worker: bot!.id });
    const line = h.store.postMessage(direct, { body: "Write the report" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id, ticketId: ticket.id }] });
    h.script(bot!).reply({ ok: true, content: "All done", toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null }, call(endTurn()));
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitIdle();
    expect(h.hops(bot!).filter((hop) => hop.scripted)).toHaveLength(2);
    expect(h.hops(bot!)[1]!.request.messages.some((message) => typeof message.content === "string" && message.content.includes("work"))).toBe(true);
    expect(h.store.getTicket(ticket.id).status).toBe("todo");
    expect(h.turns(bot!)[0]!.end_reason).toBe("nothing_new");
  } finally { await h.close(); }
});

test("stopping an owner follows its durable delegation edge without stopping the helper's other job", async () => {
  const h = await createScenario({ delegation: true });
  const release = Promise.withResolvers<void>();
  try {
    const [owner, helper] = h.createBots("Owner", "Helper");
    const group = h.group("Studio", [owner!, helper!]);
    const plan = h.store.openTask({ sessionId: group, title: "Report" });
    const from = h.store.postMessage(group, { body: "@Owner Ask the helper" });
    h.store.fileMessage(from.id, { explicit: [{ taskId: plan.id }] });
    let reached = false;
    h.script(owner!).reply(call(tool("delegate", { to: helper!.id, ask: "Find a citation", expects: "answer" })));
    h.script(helper!).reply(async () => { reached = true; await release.promise; return call(endTurn()); });
    await h.engine.handleInboundMessage(h.store.getMessage(from.id), { fromUser: true });
    await h.waitFor(() => reached);
    const unrelated = h.store.openTask({ sessionId: h.direct(helper!), title: "Other job" });
    const otherLine = h.store.postMessage(h.direct(helper!), { body: "Work on another job" });
    const other = h.store.createTurn({ sessionId: h.direct(helper!), botId: helper!.id, triggerMessageId: otherLine.id, taskId: unrelated.id });
    const hold = h.engine.createHold({ scope: "bot", scopeId: owner!.id, cascade: true });
    const delegated = h.turns(helper!).find((turn) => turn.task_id === plan.id)!;
    expect(delegated.status).toBe("stopped");
    expect(hold.targets).toContainEqual({ scope: "bot_plan", id: `${helper!.id}:${plan.id}` });
    expect(h.store.getTurn(other.id).status).toBe("running");
  } finally { release.resolve(); await h.close(); }
});

test("a verification bounce happens before a segment commits its end state", async () => {
  const h = await createScenario({ delegation: true });
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const plan = h.store.openTask({ sessionId: direct, title: "Report" });
    const from = h.store.postMessage(direct, { body: "Write the report" });
    h.store.fileMessage(from.id, { explicit: [{ taskId: plan.id }] });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${h.root}/report.md`, "unverified report");
    let committedTooSoon = false;
    h.script(bot!).reply({ ok: true, content: "All tests passed and build succeeded; [report](report.md)",  toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null },
      ({ turn }) => {
        committedTooSoon = h.store.listWorkEvents({ kind: "work.ended" }).some((event) => event.turn_id === turn!.id);
        return call(tool("end_turn", { reason: "blocked", needs_from_user: "I need the actual verification environment" }));
      });
    await h.engine.handleInboundMessage(h.store.getMessage(from.id), { fromUser: true });
    await h.waitIdle();
    expect(committedTooSoon).toBe(false);
    expect(h.turns(bot!)[0]!.end_reason).toBe("blocked");
    expect(h.messages(direct).some((message) => message.body.includes("actual verification environment"))).toBe(true);
  } finally { await h.close(); }
});

test("a continue:true delegation answer wakes its idle owner after the owner finished independent work", async () => {
  const h = await createScenario({ delegation: true });
  const release = Promise.withResolvers<void>();
  let helperStarted = false;
  let heard = false;
  try {
    const [owner, helper] = h.createBots("Owner", "Helper");
    const group = h.group("Studio", [owner!, helper!]);
    const plan = h.store.openTask({ sessionId: group, title: "Report" });
    const line = h.store.postMessage(group, { body: "@Owner Ask then keep working" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
    h.script(owner!).reply(call(tool("delegate", { to: helper!.id, ask: "Find a citation", expects: "answer", continue: true })),
      call(tool("end_turn", { reason: "answered" })), ({ request }) => { heard = hasWords(request, "The source is public"); return call(endTurn()); });
    h.script(helper!).reply(async () => { helperStarted = true; await release.promise; return call(tool("end_turn", { reason: "answered", answer: "The source is public" })); });
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitFor(() => helperStarted && h.turns(owner!)[0]!.status === "completed");
    expect(h.store.getDelegationWait(h.store.listDelegations()[0]!.id)).toBeNull();
    release.resolve();
    await h.waitIdle();
    expect(heard).toBe(true);
    expect(h.turns(owner!)).toHaveLength(2);
  } finally { release.resolve(); await h.close(); }
});

test("malformed explicit ending requests consume the shared two-correction budget", async () => {
  const h = await createScenario({ delegation: true });
  try {
    const [bot] = h.createBots("Writer");
    h.script(bot!).reply(call(tool("end_turn", {})), call(tool("end_turn", { reason: "blocked" })), call(writeFile("too-late.md", "not allowed")));
    h.postUser(h.direct(bot!), "Explain this topic");
    await h.waitIdle();
    expect(h.toolCalls(bot!, "end_turn")).toHaveLength(2);
    expect(h.toolCalls(bot!, "write_file")).toHaveLength(0);
    expect(h.turns(bot!)[0]!.end_reason).toBe("needs_attention");
  } finally { await h.close(); }
});

test("archiving an active Bot cancels its live completion and forbids the next side effect", async () => {
  const h = await createScenario({ delegation: true });
  let started = false;
  const release = Promise.withResolvers<void>();
  try {
    const [bot] = h.createBots("Writer");
    h.script(bot!).reply(async ({ request }) => { started = true; await release.promise; return call(writeFile("must-not-run.md", "forbidden")); });
    h.postUser(h.direct(bot!), "Write the report");
    await h.waitFor(() => started);
    h.store.archiveBot(bot!.id);
    await h.waitIdle();
    expect(h.toolCalls(bot!, "write_file")).toHaveLength(0);
    expect(h.turns(bot!)[0]!.status).toBe("interrupted");
    expect(h.turns(bot!)[0]!.end_reason).toBe("bot_archived");
  } finally { release.resolve(); await h.close(); }
});

test("returned invalid delegate targets also exhaust the shared correction budget", async () => {
  const h = await createScenario({ delegation: true });
  try {
    const [bot] = h.createBots("Writer");
    const direct = h.direct(bot!);
    const plan = h.store.openTask({ sessionId: direct, title: "Report" });
    const line = h.store.postMessage(direct, { body: "Work on report" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
    h.script(bot!).reply(call(tool("delegate", { to: "Missing", ask: "Work", expects: "answer" })),
      call(tool("delegate", { to: "Missing", ask: "Work", expects: "answer" })), call(writeFile("too-late.md", "forbidden")));
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitIdle();
    expect(h.toolCalls(bot!, "delegate")).toHaveLength(2);
    expect(h.toolCalls(bot!, "write_file")).toHaveLength(0);
    expect(h.turns(bot!)[0]!.end_reason).toBe("needs_attention");
  } finally { await h.close(); }
});

test("a delegated answer reaches the waiting owner's work through its reused pair thread",            async () => {
  const h = await createScenario({ delegation: true });
  try {
    const [owner, helper] = h.createBots("Owner", "Helper");
    const group = h.group("Studio", [owner!, helper!]);
    const plan = h.store.openTask({ sessionId: group, title: "Report" });
    const ticket = h.store.createTicket({ taskId: plan.id, title: "Research", worker: owner!.id });
    let heard = false;
    h.script(owner!).reply(call(tool("delegate", { to: helper!.id, ask: "Find the missing citation", expects: "answer" })),
      ({ request }) => { heard = hasWords(request, "The source is public"); return call(endTurn()); });
    h.script(helper!).reply(call(tool("end_turn", { reason: "answered", answer: "The source is public" })));
    const line = h.store.postMessage(group, { body: "@Owner Find the citation" });
    h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id, ticketId: ticket.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitIdle();
    expect(h.toolCalls(owner!, "delegate")[0]!.result?.ok).toBe(true);
    const delegation = h.store.listDelegations()[0]!;
    expect(delegation.status).toBe("replied");
    expect(h.turns(helper!)[0]!.session_id).toBe(delegation.thread_session_id);
    expect(heard).toBe(true);
    expect(h.store.getDelegationWait(delegation.id)!.voided_at).not.toBeNull();
  } finally { await h.close(); }
});
