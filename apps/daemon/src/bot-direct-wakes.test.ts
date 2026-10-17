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
    // Once more back in your direct, to say how it came out (ADR 0093); never again in this one.
    expect(h.turns(owner!).filter((turn) => turn.session_id === direct)).toHaveLength(1);
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

// ADR 0093: a direct opens only from a conversation the user is in, and once it goes quiet its
// opener is called back there to say how it came out, at every engine level.

/** Owner opens a direct with Helper from your direct; Helper answers, Owner ends its turn there. */
async function talkedInDirect(h: Awaited<ReturnType<typeof createScenario>>, report: string, seen = { request: "" }) {
  const [owner, helper] = h.createBots("Owner", "Helper");
  const yours = h.direct(owner!);
  const line = h.store.postMessage(yours, { body: "Share the notes with Helper" });
  const direct = h.botDirect(owner!, helper!, { sessionId: yours, messageId: line.id });
  h.script(helper!).reply(say("Thanks, I will cut the music to 2:41 in my next film"));
  h.script(owner!, direct).reply(call(endTurn()));
  h.script(owner!, yours).handle(({ request }) => {
    seen.request = requestText(request);
    return say(report);
  });
  h.postBot(owner!, direct, "The cut notes are in notes.md; keep the one about music length for your next film");
  return { owner: owner!, helper: helper!, yours, direct };
}

test("a quiet direct calls its opener back to the conversation it came from at the top engine level", async () => {
  const h = await createScenario({ learning: true });
  try {
    const seen = { request: "" };
    const { owner, yours, direct } = await talkedInDirect(h, "Helper has the notes and will cut the music to 2:41.", seen);
    await h.waitFor(() => h.messages(yours).some((m) => m.body === "Helper has the notes and will cut the music to 2:41."), { what: "the report in your direct" });
    await h.waitIdle();
    const back = h.turns(owner).find((turn) => turn.session_id === yours)!;
    const cue = h.store.getMessage(back.trigger_message_id);
    expect(cue).toMatchObject({ kind: "system", author: owner.id });
    expect(cue.body).toContain("Thanks, I will cut the music to 2:41 in my next film");
    // Hung on the opener's own turn in the direct, so the flow draws the wake back across.
    expect(h.store.getTurn(cue.turn_id!)).toMatchObject({ session_id: direct, bot_id: owner.id });
    expect(h.store.listPendingCheckBacks()).toEqual([]);
    // What the direct came to rides under the cue, not only its last line.
    expect(seen.request).toContain("【Owner】The cut notes are in notes.md; keep the one about music length for your next film");
    expect(seen.request).toContain("【Helper】Thanks, I will cut the music to 2:41 in my next film");
  } finally { await h.close(); }
});

test("a quiet delegation thread does not call its opener back at the top engine level", async () => {
  const h = await createScenario({ learning: true });
  try {
    const [owner, helper] = h.createBots({ name: "Owner", duties: "make the MV" }, { name: "Helper", duties: "answer questions" });
    const yours = h.direct(owner!);
    const plan = openPlan(h, yours, "MV", planSpec("an MV"));
    const line = h.store.postMessage(yours, { body: "Ask Helper about the music length" });
    const thread = h.botDirect(owner!, helper!, { sessionId: yours, messageId: line.id });
    h.script(helper!).reply(say("The music runs 2:41, I am cutting the film to that now"));
    // The Owner ran there, as a delegation thread's opener can, and the thread is the job's: the
    // delegation's answer and the supervisor bring it back, not a quiet clock.
    h.script(owner!, thread).handle(() => {
      h.store.db.run("UPDATE sessions SET thread_task_id = ? WHERE id = ?", [plan.id, thread]);
      return call(endTurn());
    });
    h.postBot(owner!, thread, "How long does the music run? I need it for the cut");
    await h.waitFor(() => h.turns(owner!).some((turn) => turn.session_id === thread && turn.status === "completed"), { what: "the owner's turn in the thread" });
    await h.waitIdle();
    expect(h.turns(owner!).filter((turn) => turn.session_id === yours)).toHaveLength(0);
    expect(h.store.db.query("SELECT id FROM check_backs WHERE session_id = ?").all(yours)).toEqual([]);
  } finally { await h.close(); }
});

test("create_direct from a Bot↔Bot direct is refused", async () => {
  const h = await createScenario({ learning: true });
  try {
    const [owner, helper] = h.createBots("Owner", "Helper");
    h.createBots("Third");
    const yours = h.direct(owner!);
    const line = h.store.postMessage(yours, { body: "Share the notes with Helper" });
    const direct = h.botDirect(owner!, helper!, { sessionId: yours, messageId: line.id });
    h.script(helper!).reply(call(tool("create_direct", { name: "Third" })), call(endTurn()));
    h.postBot(owner!, direct, "The cut notes are in notes.md; pass the music one on to Third");
    await h.routed();
    await h.waitIdle();
    expect(h.toolCalls(helper!, "create_direct")[0]?.result).toMatchObject({ ok: false, error: "not_a_member" });
    expect(h.store.listSessions().filter((session) => session.origin_session_id === direct)).toEqual([]);
  } finally { await h.close(); }
});
