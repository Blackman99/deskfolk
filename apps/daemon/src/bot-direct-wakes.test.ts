import { expect, test } from "bun:test";
import { call, createScenario, endTurn, fileUnder, requestText, say, shell, tool } from "./test-kit/scenario";
import { openPlan, planSpec } from "./scenarios/video-team";

// ADR 0091: at the delegation levels a direct a Bot opens with create_direct wakes the other side on
// every line, as below them; a pair's delegation thread keeps its words as notes (ADR 0044).

test("a line in a direct a Bot opened itself wakes the other Bot at the top engine level", async () => {
  const h = await createScenario({ learning: true });
  try {
    const [owner, helper] = h.createBots("Owner", "Helper");
    const yours = h.direct(owner!);
    const line = h.store.postMessage(yours, { body: "Share the notes with Helper" });
    const direct = h.botDirect(owner!, helper!, { sessionId: yours, messageId: line.id });
    h.script(helper!).reply(call(endTurn()));
    const shared = h.postBot(owner!, direct, "The cut notes are in notes.md; keep the one about music length for your next film");
    await h.routed();
    await h.waitIdle();
    const turns = h.turns(helper!);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.session_id).toBe(direct);
    expect(turns[0]!.trigger_message_id).toBe(shared.id);
    expect(h.store.db.query("SELECT 1 FROM inbox_items WHERE session_id = ? AND source = 'peer_note'").get(direct)).toBeNull();
  } finally { await h.close(); }
});

test("a nod to a nod in such a direct wakes nobody", async () => {
  const h = await createScenario({ learning: true });
  try {
    const [owner, helper] = h.createBots("Owner", "Helper");
    const yours = h.direct(owner!);
    const line = h.store.postMessage(yours, { body: "Tell Helper about the notes" });
    const direct = h.botDirect(owner!, helper!, { sessionId: yours, messageId: line.id });
    h.script(helper!).reply(say("收到。"));
    h.script(owner!).reply(say("好的。"));
    h.postBot(owner!, direct, "The notes are in notes.md, the music section changed today");
    await h.routed();
    await h.waitIdle();
    await h.routed();
    await h.waitIdle();
    expect(h.turns(helper!)).toHaveLength(1);
    expect(h.turns(owner!)).toHaveLength(1);
    const bodies = h.messages(direct).map((message) => message.body);
    expect(bodies).toEqual(["The notes are in notes.md, the music section changed today", "收到。", "好的。"]);
  } finally { await h.close(); }
});

test("create_direct opens a direct at the top engine level instead of sending the Bot to delegate", async () => {
  const h = await createScenario({ learning: true });
  try {
    const [owner, helper] = h.createBots("Owner", "Helper");
    const yours = h.direct(owner!);
    const line = h.store.postMessage(yours, { body: "Share the notes with Helper" });
    h.script(owner!).reply(call(tool("create_direct", { name: "Helper" })), say("Opened a direct with Helper."));
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitIdle();
    expect(h.toolCalls(owner!, "create_direct")[0]?.result).toMatchObject({ ok: true });
    const direct = h.store.listSessions().find((session) => session.kind === "direct" && session.origin_message_id === line.id);
    expect(direct?.participants.map((p) => p.member).sort()).toEqual([owner!.id, helper!.id].sort());
  } finally { await h.close(); }
});

test("the other Bot's answer reaches the opener's turn still at work on the job, instead of opening a second one", async () => {
  const h = await createScenario({ learning: true });
  try {
    const [owner, helper] = h.createBots({ name: "Owner", duties: "make the MV" }, { name: "Helper", duties: "answer questions" });
    const yours = h.direct(owner!);
    const plan = openPlan(h, yours, "MV", planSpec("an MV"));
    h.judge("read_filing").handle(fileUnder("MV"));
    const go = Promise.withResolvers<void>();
    const seen = { working: false, note: "" };
    h.script(owner!, yours).handle(async ({ hop, request }) => {
      if (hop === 1) {
        seen.working = true;
        await go.promise;
        return call(shell("echo cut"));
      }
      if (hop === 2) seen.note = requestText(request);
      return say("The cut is done.");
    });
    h.postUser(yours, "Finish the MV");
    await h.waitFor(() => seen.working, { what: "the owner at work in your direct" });
    const line = h.messages(yours)[0]!;
    const direct = h.botDirect(owner!, helper!, { sessionId: yours, messageId: line.id });
    const answer = h.postBot(helper!, direct, "The music runs 2:41, cut to that", { taskId: plan.id });
    await h.routed();
    go.resolve();
    await h.waitIdle();
    const turns = h.turns(owner!);
    expect(turns).toHaveLength(1);
    const row = h.store.db.query<{ delivered_turn_id: string | null; wakes: number }, [string]>(
      "SELECT delivered_turn_id, wakes FROM inbox_items WHERE message_id = ?").get(answer.id);
    expect(row).toEqual({ delivered_turn_id: turns[0]!.id, wakes: 1 });
    expect(seen.note).toContain("The music runs 2:41, cut to that");
  } finally { await h.close(); }
});
