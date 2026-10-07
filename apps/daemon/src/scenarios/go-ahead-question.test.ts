/**
 * ADR 0058, 2026-10-04: a Bot that stops only for your OK to go on.
 *
 * At 12:10 视频导演 handed in the keyframe board of 《制作《一拳超人》动画》 and ended its segment
 * blocked: 「请确认《一拳超人》关键帧板（board.jpg）与设定集是否符合预期，确认后将正式启动视频片段生成与后期剪辑。」
 * The card sat until 14:48, when you answered 「确认」. It asked for nothing only you could give:
 * the work was yours already asked for, and you look at what is handed over anyway.
 *
 * Now the reader reads such a question (a blocked ending's, or `ask_user`'s), and one that only asks
 * your OK to go on is sent back once, with the Bot told to go on. A question about something only
 * you can give — or one the Bot asks again after being told — still reaches you.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, tool, writeFile, type Scenario, type ToolOutcome } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const SIGN_OFF = "请确认《一拳超人》关键帧板（board.jpg）与设定集是否符合预期，确认后将正式启动视频片段生成与后期剪辑。";
const LOGIN = "生成视频要用你的 Runway 账号，请在设置里登录后告诉我。";

/** A job in your direct with 视频导演, its line filed under it, and the reader reading go-aheads by `goAhead`. */
async function job(goAhead: (said: string) => boolean) {
  const h = await createScenario({ supervision: true });
  open.push(h);
  const [director] = h.createBots("视频导演");
  const dm = h.direct(director!);
  const plan = h.store.openTask({ sessionId: dm, title: "制作《一拳超人》动画" });
  h.judge("read_bot_line").handle(({ payload }) => {
    const said = String((payload as { said?: string }).said ?? "");
    return { later: null, claims_verified: false, no_work: false, bare_status: false, go_ahead: goAhead(said) };
  });
  const start = async (body: string) => {
    const line = h.store.postMessage(dm, { body });
    h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
    await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
    await h.waitIdle();
  };
  return { h, director: director!, dm, plan, start };
}

const cards = (h: Scenario, dm: string) => h.messages(dm).filter((message) => message.control?.kind === "work_question");

test("stopping only for your OK to go on is sent back once, and the Bot goes on with no card to you", async () => {
  const { h, director, dm, plan, start } = await job((said) => said === SIGN_OFF);
  const refused: ToolOutcome[] = [];
  h.script(director).handle(({ hop, results }) => {
    refused.push(...results.filter((result) => result.name === "end_turn" && !result.ok));
    if (hop === 1) return call(tool("end_turn", { reason: "blocked", needs_from_user: SIGN_OFF }));
    if (hop === 2) return call(writeFile(`${plan.dir}/clips.md`, "C01 埼玉出场"));
    // A segment your line opened in your direct says something to you before it ends.
    if (hop === 3) return call(tool("send_message", { body: "分镜先写在 clips.md，接着出视频片段。" }));
    return call(tool("end_turn", { reason: "nothing_new" }));
  });
  await start("做个《一拳超人》动画");

  expect(refused).toHaveLength(1);
  expect(refused[0]!.error).toBe("asks_go_ahead");
  expect(refused[0]!.content).toContain(`「${SIGN_OFF}」`);
  expect(refused[0]!.content).toContain("do not wait for an OK");
  // It went on in the same segment, and nothing waits on you.
  expect(h.turns(director)).toHaveLength(1);
  expect(h.toolCalls(director, "write_file")[0]!.result?.ok).toBe(true);
  expect(cards(h, dm)).toEqual([]);
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'ask'").get()).toEqual({ n: 0 });
  expect(h.store.listWorkEvents({ kind: "end.rejected" }).map((event) => event.payload.code)).toEqual(["asks_go_ahead"]);
});

test("asked again after being told, the question is yours: it goes up as a card", async () => {
  const { h, director, dm, start } = await job((said) => said === SIGN_OFF);
  h.script(director).reply(
    call(tool("end_turn", { reason: "blocked", needs_from_user: SIGN_OFF })),
    call(tool("end_turn", { reason: "blocked", needs_from_user: SIGN_OFF })),
  );
  await start("做个《一拳超人》动画");
  expect(cards(h, dm).map((card) => card.body)).toEqual([SIGN_OFF]);
  // Read once: a second question in the segment is not read again.
  expect(h.judgeCalls("read_bot_line").filter((row) => row.scripted)).toHaveLength(1);
});

test("a question about something only you can give goes up as a card, as before", async () => {
  const { h, director, dm, start } = await job((said) => said === SIGN_OFF);
  h.script(director).reply(call(tool("end_turn", { reason: "blocked", needs_from_user: LOGIN })));
  await start("做个《一拳超人》动画");
  expect(cards(h, dm).map((card) => card.body)).toEqual([LOGIN]);
  expect(h.store.listWorkEvents({ kind: "end.rejected" })).toEqual([]);
});

test("ask_user for an OK to go on is refused once; a choice that is yours is asked", async () => {
  const OK = "关键帧板没问题的话我就开始生成视频，可以吗？";
  const CHOICE = "先做第 3 话还是第 5 话？";
  const { h, director, dm, start } = await job((said) => said === OK);
  const refused: ToolOutcome[] = [];
  h.script(director).handle(({ hop, results }) => {
    refused.push(...results.filter((result) => result.name === "ask_user" && !result.ok));
    if (hop === 1) return call(tool("ask_user", { question: OK }));
    if (hop === 2) return call(tool("ask_user", { question: CHOICE, options: ["第 3 话", "第 5 话"] }));
    return call(tool("end_turn", { reason: "nothing_new" }));
  });
  await start("做个《一拳超人》动画");

  expect(refused.map((result) => result.error)).toEqual(["asks_go_ahead"]);
  const asks = h.messages(dm).filter((message) => message.kind === "ask");
  expect(asks.map((ask) => ask.body)).toEqual([CHOICE]);
  expect(h.turns(director)[0]!.status).toBe("waiting_ask");
  expect(h.store.listWorkEvents({ kind: "ask.go_ahead_refused" }).map((event) => event.payload.question)).toEqual([OK]);
});

test("with no model to read it, a question goes to you as before", async () => {
  const h = await createScenario({ supervision: true });
  open.push(h);
  const [director] = h.createBots("视频导演");
  const dm = h.direct(director!);
  const plan = h.store.openTask({ sessionId: dm, title: "制作《一拳超人》动画" });
  h.script(director!).reply(call(tool("end_turn", { reason: "blocked", needs_from_user: SIGN_OFF })));
  const line = h.store.postMessage(dm, { body: "做个《一拳超人》动画" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id }] });
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitIdle();
  expect(cards(h, dm).map((card) => card.body)).toEqual([SIGN_OFF]);
});
