import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionResult } from "../completions";
import { call, checkBack, createScenario, endTurn, media, say, tool, writeFile, type Scenario, type ScenarioOptions } from "./scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function scenario(options?: ScenarioOptions): Promise<Scenario> {
  const h = await createScenario(options);
  open.push(h);
  return h;
}

const botLines = (h: Scenario, session: string): string[] =>
  h.messages(session).filter((m) => m.kind === "bot").map((m) => m.body);

test("one Bot working in two sessions at once gets each session's own reply", async () => {
  const h = await scenario();
  const [alpha, beta] = h.createBots("Alpha", "Beta");
  const dm = h.direct(alpha!);
  const room = h.group("剪辑组", [alpha!, beta!]);
  // Neither first hop answers until both have arrived, so the two turns really overlap.
  let arrived = 0;
  const both = Promise.withResolvers<void>();
  const meet = async (reply: CompletionResult): Promise<CompletionResult> => {
    arrived += 1;
    if (arrived === 2) both.resolve();
    await both.promise;
    return reply;
  };
  h.script(alpha!, dm).reply(() => meet(say("私聊这边收到")));
  h.script(alpha!, room).reply(() => meet(say("群里这边收到")));

  h.postUser(dm, "私聊里的事");
  h.postUser(room, "@Alpha 群里的事");
  await h.waitIdle();

  expect(botLines(h, dm)).toEqual(["私聊这边收到"]);
  expect(botLines(h, room)).toEqual(["群里这边收到"]);
  expect(h.turns(alpha!).map((turn) => turn.status)).toEqual(["completed", "completed"]);
  expect(h.turns(beta!)).toEqual([]);
  expect(h.unscripted()).toEqual([]);
});

test("a judgement is scripted per Bot, and an unscripted one reads as a pass", async () => {
  const h = await scenario();
  const [alpha, beta] = h.createBots("Alpha", "Beta");
  const room = h.group("剪辑组", [alpha!, beta!]);
  h.judge("judgement", { bot: beta! }).reply("join");
  h.script(beta!).reply(say("我来接"));

  h.postUser(room, "谁有空看一下这段");
  await h.waitIdle();

  expect(h.turns(alpha!)).toEqual([]);
  expect(h.turns(beta!).map((turn) => turn.session_id)).toEqual([room]);
  expect(botLines(h, room)).toEqual(["我来接"]);
  const judged = h.judgeCalls("judgement").map(({ botId, sessionId, scripted }) => ({ botId, sessionId, scripted }));
  expect(judged.sort((a, b) => (a.botId! < b.botId! ? -1 : 1))).toEqual(
    [
      { botId: alpha!.id, sessionId: room, scripted: false },
      { botId: beta!.id, sessionId: room, scripted: true },
    ].sort((a, b) => (a.botId < b.botId ? -1 : 1)),
  );
});

test("a hop nobody scripted ends its turn silently and is listed", async () => {
  const h = await scenario();
  const [alpha] = h.createBots("Alpha");
  const dm = h.direct(alpha!);

  h.postUser(dm, "在吗");
  await h.waitIdle();

  expect(h.unscripted().map(({ botId, sessionId, hop }) => ({ botId, sessionId, hop }))).toEqual([
    { botId: alpha!.id, sessionId: dm, hop: 1 },
  ]);
  expect(botLines(h, dm)).toEqual([]);
  expect(h.turns(alpha!).map((turn) => turn.status)).toEqual(["completed"]);
  expect(h.sideEffectCalls(alpha!)).toEqual([]);
});

test("a check-back fires only once the harness clock has passed it", async () => {
  const h = await scenario();
  const [alpha] = h.createBots("Alpha");
  const dm = h.direct(alpha!);
  h.script(alpha!, dm).reply(call(checkBack(10, "看渲染好了没有")), call(endTurn()), say("回看了，渲染好了"));

  h.postUser(dm, "渲染完了告诉我");
  await h.waitIdle();
  expect(h.turns(alpha!)).toHaveLength(1);

  h.advance(9 * 60_000);
  await h.waitIdle();
  expect(h.turns(alpha!)).toHaveLength(1);

  h.advance(2 * 60_000);
  await h.waitIdle();
  expect(h.turns(alpha!)).toHaveLength(2);
  expect(botLines(h, dm)).toEqual(["回看了，渲染好了"]);
  // Booking the check-back is a side effect; ending the turn is not.
  expect(h.sideEffectCalls(alpha!).map((row) => row.name)).toEqual(["check_back"]);
  expect(h.unscripted()).toEqual([]);
});

test("the media server answers submit and check, and every call is logged against the Bot and its turn", async () => {
  const h = await scenario({ media: { videoPolls: 1 } });
  const [director] = h.createBots("Director");
  const dm = h.direct(director!);
  const jobOf = (content: string): { job_id: string; status: string } => {
    const outer = JSON.parse(content) as { data: { content: Array<{ text: string }> } };
    return JSON.parse(outer.data.content[0]!.text) as { job_id: string; status: string };
  };
  h.script(director!, dm).handle(({ hop, results }) => {
    if (hop === 1) return call(media("submit_video", { prompt: "日落" }));
    const job = jobOf(results[0]!.content);
    return job.status === "completed" ? say(`视频好了：${job.job_id}`) : call(media("check_video", { job_id: job.job_id }));
  });

  h.postUser(dm, "做一段日落视频");
  await h.waitIdle();

  const [turn] = h.turns(director!);
  const calls = h.mcpCalls(director!);
  expect(calls.map(({ tool, turnId }) => ({ tool, turnId }))).toEqual([
    { tool: "submit_video", turnId: turn!.id },
    { tool: "check_video", turnId: turn!.id },
    { tool: "check_video", turnId: turn!.id },
  ]);
  expect(calls.map((row) => (row.result?.ok ? jobOf(JSON.stringify({ data: row.result.data })).status : null))).toEqual([
    "pending",
    "running",
    "completed",
  ]);
  expect(botLines(h, dm)).toEqual(["视频好了：fixture-video-1"]);
  expect(h.runs(director!).map((row) => row.tool)).toEqual([
    "mcp_media_submit_video",
    "mcp_media_check_video",
    "mcp_media_check_video",
  ]);
  expect(h.sideEffectCalls(director!)).toHaveLength(3);
});

test("a hop still waiting when its turn is stopped gives up the way the real client does", async () => {
  const h = await scenario();
  const [alpha] = h.createBots("Alpha");
  const dm = h.direct(alpha!);
  let asked = false;
  h.script(alpha!, dm).reply(() => {
    asked = true;
    return new Promise<CompletionResult>(() => {});
  });

  h.postUser(dm, "慢慢想");
  await h.waitFor(() => asked, { what: "the first hop" });
  await expect(h.waitIdle({ timeoutMs: 100 })).rejects.toThrow("scenario never went idle: 1 model or MCP call(s) in flight");

  const [turn] = h.turns(alpha!);
  h.engine.stop(turn!.id);
  await h.waitIdle();

  expect(h.turns(alpha!).map((row) => row.status)).toEqual(["stopped"]);
  expect(h.hops(alpha!).map((row) => row.reply.ok)).toEqual([false]);
  expect(botLines(h, dm)).toEqual([]);
});

test("two check-backs in a row each come due their full wait after the turn that booked them", async () => {
  const h = await scenario();
  const [alpha] = h.createBots("Alpha");
  const dm = h.direct(alpha!);
  h.script(alpha!, dm).reply(
    call(checkBack(10, "第一次回看")),
    call(endTurn()),
    call(checkBack(10, "第二次回看")),
    call(endTurn()),
    say("两次都看过了"),
  );

  h.postUser(dm, "渲染完了告诉我");
  await h.waitIdle();
  h.advance(11 * 60_000);
  await h.waitIdle();
  expect(h.turns(alpha!)).toHaveLength(2);

  // The second one was booked after the first advance: no time has passed for it yet.
  h.tick();
  await h.waitIdle();
  expect(h.turns(alpha!)).toHaveLength(2);
  h.advance(9 * 60_000);
  await h.waitIdle();
  expect(h.turns(alpha!)).toHaveLength(2);

  h.advance(2 * 60_000);
  await h.waitIdle();
  expect(h.turns(alpha!)).toHaveLength(3);
  expect(botLines(h, dm)).toEqual(["两次都看过了"]);
  expect(h.unscripted()).toEqual([]);
});

test("a turn stuck across an advance past the stall limit is swept", async () => {
  const h = await scenario();
  const [alpha] = h.createBots("Alpha");
  const dm = h.direct(alpha!);
  let asked = false;
  h.script(alpha!, dm).reply(() => {
    asked = true;
    return new Promise<CompletionResult>(() => {});
  });

  h.postUser(dm, "慢慢想");
  await h.waitFor(() => asked, { what: "the first hop" });
  h.advance(21 * 60_000);
  await h.waitIdle();

  expect(h.turns(alpha!).map((turn) => turn.status)).toEqual(["interrupted"]);
});

test("a turn started after a long advance is not taken for stuck", async () => {
  const h = await scenario();
  const [alpha] = h.createBots("Alpha");
  const dm = h.direct(alpha!);
  h.advance(21 * 60_000);
  const release = Promise.withResolvers<void>();
  let asked = false;
  h.script(alpha!, dm).reply(async () => {
    asked = true;
    await release.promise;
    return say("想好了");
  });

  h.postUser(dm, "慢慢想");
  await h.waitFor(() => asked, { what: "the first hop" });
  h.tick();
  expect(h.turns(alpha!).map((turn) => turn.status)).toEqual(["running"]);
  release.resolve();
  await h.waitIdle();

  expect(h.turns(alpha!).map((turn) => turn.status)).toEqual(["completed"]);
  expect(botLines(h, dm)).toEqual(["想好了"]);
});

test("two turns of one Bot running before either first hop are told apart by their trigger lines", async () => {
  const h = await scenario();
  const [alpha, beta] = h.createBots("Alpha", "Beta");
  const dm = h.direct(alpha!);
  const room = h.group("剪辑组", [alpha!, beta!]);
  h.script(alpha!, dm).reply(call(checkBack(10, "私聊这边回看")), call(endTurn()), say("私聊这边看过了"));
  h.script(alpha!, room).reply(call(checkBack(10, "群里这边回看")), call(endTurn()), say("群里这边看过了"));
  h.postUser(dm, "私聊里的事");
  h.postUser(room, "@Alpha 群里的事");
  await h.waitIdle();

  // Both come due in one tick, so both turns are running before either asks the model anything.
  h.advance(11 * 60_000);
  await h.waitIdle();

  expect(botLines(h, dm)).toEqual(["私聊这边看过了"]);
  expect(botLines(h, room)).toEqual(["群里这边看过了"]);
  const woken = h.turns(alpha!).slice(2).map((turn) => turn.id);
  expect(woken).toHaveLength(2);
  // The first to ask had both to choose from; once it was placed, the other had only itself left.
  expect(h.hops(alpha!).filter((hop) => hop.hop === 1 && woken.includes(hop.turnId!)).map((hop) => hop.matchedBy)).toEqual(["trigger", "only"]);
});

test("two turns of one Bot opened on the same words fail the scenario instead of guessing", async () => {
  const h = await scenario();
  const [alpha, beta] = h.createBots("Alpha", "Beta");
  const dm = h.direct(alpha!);
  const room = h.group("剪辑组", [alpha!, beta!]);
  h.script(alpha!, dm).reply(call(checkBack(10, "回看一下")), call(endTurn()), say("私聊这边看过了"));
  h.script(alpha!, room).reply(call(checkBack(10, "回看一下")), call(endTurn()), say("群里这边看过了"));
  h.postUser(dm, "私聊里的事");
  h.postUser(room, "@Alpha 群里的事");
  await h.waitIdle();

  h.advance(11 * 60_000);
  await expect(h.waitIdle()).rejects.toThrow("a hop of Alpha matches 2 of its running turns");
  // Neither took the other's reply.
  expect(botLines(h, dm)).toEqual([]);
  expect(botLines(h, room)).toEqual([]);
});

test("a call turned away before it ran is not a side effect", async () => {
  const h = await scenario();
  const [alpha] = h.createBots("Alpha");
  const dm = h.direct(alpha!);
  const outside = join(tmpdir(), `scenario-outside-${crypto.randomUUID()}.txt`);
  h.script(alpha!, dm).reply(
    call(writeFile(outside, "不该写到工作区外面")),
    call(tool("write_file", { path: "note.txt" })),
    say("两个都没写成"),
  );

  h.postUser(dm, "写两个文件");
  await h.waitIdle();
  expect(h.toolCalls(alpha!, "write_file").map((row) => row.approval)).toEqual(["pending"]);
  expect(h.sideEffectCalls(alpha!)).toEqual([]);
  const [card] = h.store.listApprovals("pending");
  h.engine.resolveApproval(card!.id, "deny");
  await h.waitIdle();

  expect(h.toolCalls(alpha!, "write_file").map(({ approval, result }) => ({ approval, result }))).toEqual([
    { approval: "denied", result: { ok: false, error: "denied" } },
    { approval: null, result: { ok: false, error: "invalid_args" } },
  ]);
  expect(h.sideEffectCalls(alpha!)).toEqual([]);
  expect(existsSync(outside)).toBe(false);
  expect(botLines(h, dm)).toEqual(["两个都没写成"]);
});

test("a call refused on a turn's last hop is still not a side effect, with no later hop to carry its result", async () => {
  const h = await scenario();
  const [alpha] = h.createBots("Alpha");
  const dm = h.direct(alpha!);
  // Bad arguments, then end_turn in the same hop: the turn ends and no hop ever carries the refusal back.
  h.script(alpha!, dm).reply(call(tool("write_file", { path: "note.txt" }), endTurn()));

  h.postUser(dm, "写个文件就收工");
  await h.waitIdle();
  expect(h.hops(alpha!)).toHaveLength(1);
  expect(h.toolCalls(alpha!, "write_file").map(({ dispatchedAt, result }) => ({ ran: dispatchedAt !== null, result }))).toEqual([
    { ran: true, result: { ok: false, error: "invalid_args" } },
  ]);
  expect(h.sideEffectCalls(alpha!)).toEqual([]);
});
