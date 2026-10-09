/**
 * A group's job you go on with in your direct with one of its Bots (2026-10-04). 《一拳超人》 lives
 * in AI影视创作组, where it was opened and first worked on; that morning you went on with 视频导演 in
 * your direct. Its report asking 「请拍板」 came in the direct, but the question card for it landed
 * in the group — you answered by typing in the direct — and so did both restart notices that day,
 * while the 「中断」 lines they stood for were in the direct beside your last words.
 */
import { afterEach, expect, test } from "bun:test";
import { openPlan, planSpec, videoTeam } from "./video-team";
import { call, createScenario, fileUnder, say, tool, writeFile, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** The job opened and worked on in the group, then taken up in your direct: the director's line there, your reply. */
function wentOnInYourDirect(h: Scenario) {
  const { director, writer, room } = videoTeam(h);
  const plan = openPlan(h, room, "做《一拳超人》动画", planSpec("一拳超人第一集"));
  // Worked on in the group first: the director's work on the job has its home there.
  const earlier = h.store.postMessage(room, { body: "琦玉不会用波，只用拳头" });
  h.store.db.run("UPDATE messages SET task_id = ? WHERE id = ?", [plan.id, earlier.id]);
  const first = h.store.createTurn({ sessionId: room, botId: director.id, triggerMessageId: earlier.id, taskId: plan.id });
  h.store.setTurnStatus(first.id, "completed");
  h.store.db.run("UPDATE work_items SET state = 'idle' WHERE id = ?", [first.work_item_id!]);
  const dm = h.direct(director);
  h.postBot(director, dm, "关键帧板重做好了，请拍板。", { taskId: plan.id });
  // Your reply to it is read as about the film (ADR 0057), as the reader model read the real line.
  h.judge("read_filing").handle(fileUnder("做《一拳超人》动画"));
  return { director, writer, room, plan, dm, home: first.work_item_id! };
}

test("a Bot blocked in your direct on a group's job asks you there", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const { director, room, plan, dm, home } = wentOnInYourDirect(h);
  h.script(director, dm).reply(call(tool("end_turn", { reason: "blocked", needs_from_user: "打斗加了城市破坏，同意启动视频生成吗？" })));

  h.postUser(dm, "但是打斗画面要有张力");
  await h.waitIdle();

  const turn = h.turns(director).at(-1)!;
  expect([turn.session_id, turn.task_id, turn.work_item_id]).toEqual([dm, plan.id, home]);
  const asked = (session: string) => h.messages(session).filter((message) => message.control?.kind === "work_question");
  expect(asked(room)).toEqual([]);
  expect(asked(dm).map((message) => message.body)).toEqual(["打斗加了城市破坏，同意启动视频生成吗？"]);
});

test("work a restart cut off is told where you last spoke about its job", async () => {
  const h = await createScenario({ durable: true, learning: true });
  open.push(h);
  const { director, room, dm } = wentOnInYourDirect(h);
  let mid = false;
  h.script(director, dm).reply(() => {
    mid = true;
    return new Promise(() => {});
  });
  h.postUser(dm, "但是打斗画面要有张力");
  await h.waitFor(() => mid, { what: "the director to be mid-hop" });

  // Cut in the middle of an external call: the job waits for you, so it is told (one that goes on by itself is not).
  const cut = h.store.listLiveTurns({ sessionId: dm, botId: director.id })[0]!;
  h.store.db.run(`INSERT INTO tool_executions (id, work_item_id, task_id, ticket_id, bot_id, turn_id, tool_call_id, tool, side_effect, started_at)
    VALUES ('exec-cut', ?, ?, ?, ?, ?, 'call-cut', 'mcp_submit_video', 1, ?)`, [cut.work_item_id ?? null, cut.task_id ?? null, cut.ticket_id ?? null, director.id, cut.id, cut.created_at]);
  await h.restart({ clean: false, dev: true });
  await h.waitIdle();

  const notices = (session: string) => h.messages(session).filter((message) => message.control?.kind === "restart");
  expect(notices(room)).toEqual([]);
  const [notice] = notices(dm);
  expect(notice!.body).toContain("：视频导演 · 规划「做《一拳超人》动画」。");
  expect(notice!.control).toMatchObject({ notes: [h.messages(dm).find((message) => message.body === "中断")!.id] });
});

test("a hand-over you are waiting on in your direct comes up there; another Bot's goes to the group, not into this direct", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const { director, writer, room, plan, dm } = wentOnInYourDirect(h);
  const shots = h.store.createTicket({ taskId: plan.id, title: "关键帧板", worker: director.id });
  const script = h.store.createTicket({ taskId: plan.id, title: "分镜脚本", worker: writer.id });
  h.script(director, dm).handle(({ hop }) => hop === 1 ? call(tool("work_on", { plan: plan.id, ticket: shots.id }))
    : hop === 2 ? call(writeFile(`${shots.dir}/board.md`, "S01 怪人砸楼"))
      : hop === 3 ? call(tool("delegate", { to: "编剧分镜师", ask: "把第六镜的分镜改成拳风劈开云层", expects: "deliverable", ticket: script.id }))
        : hop === 4 ? call(tool("submit", { artifacts: [`${shots.dir}/board.md`] }))
          : call(tool("end_turn", { reason: "nothing_new" })));
  h.script(writer).handle(({ hop }) => hop === 1 ? call(writeFile(`${script.dir}/script.md`, "S06 拳风劈开云层"))
    : hop === 2 ? call(tool("submit", { artifacts: [`${script.dir}/script.md`] })) : call(tool("end_turn", { reason: "nothing_new" })));

  h.postUser(dm, "但是打斗画面要有张力");
  await h.waitIdle();
  h.tick(new Date(Date.now() + 60_000));
  await h.waitIdle();

  const cards = (session: string) => h.messages(session).filter((message) => message.control?.kind === "review_item")
    .map((message) => (message.control?.kind === "review_item" ? message.control.ticket_id : null));
  expect(cards(dm)).toEqual([shots.id]);
  expect(cards(room)).toEqual([script.id]);
});

test("the question whether a complaint sends work back comes up where you complained", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const { director, room, plan, dm } = wentOnInYourDirect(h);
  const shots = h.store.createTicket({ taskId: plan.id, title: "关键帧板", worker: director.id });
  h.store.patchTicketByUser(shots.id, { status: "done" });
  h.script(director, dm).reply(call(tool("end_turn", { reason: "nothing_new" })));
  h.judge("read_user_line").reply({ text: JSON.stringify({ kind: "complaint", objecting: ["打斗没有张力"] }) });

  h.postUser(dm, "关键帧板的打斗没有张力，不行");
  await h.waitIdle();

  const asked = (session: string) => h.messages(session).filter((message) => message.control?.kind === "rework");
  expect(asked(room)).toEqual([]);
  expect(asked(dm)).toHaveLength(1);
});

test("work you send back from your direct with the Bot that made it is redone there", async () => {
  // Real-model run, 2026-10-04: 「第二句换成更有画面感的」 said to 文案 in your direct, 转回返工 pressed there,
  // and 文案 redid the slogans in the group the job began in; the new version landed there.
  const h = await createScenario({ learning: true });
  open.push(h);
  const { director, room, plan, dm } = wentOnInYourDirect(h);
  const shots = h.store.createTicket({ taskId: plan.id, title: "关键帧板", worker: director.id });
  // The ticket's work began in the group, as the slogans' did.
  const begun = h.store.postMessage(room, { body: "先出关键帧板" });
  h.store.db.run("UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?", [plan.id, shots.id, begun.id]);
  const there = h.store.createTurn({ sessionId: room, botId: director.id, triggerMessageId: begun.id, taskId: plan.id, ticketId: shots.id });
  h.store.setTurnStatus(there.id, "completed");
  h.store.db.run("UPDATE work_items SET state = 'idle' WHERE id = ?", [there.work_item_id!]);
  h.postBot(director, dm, "关键帧板在群里交过一版了。", { taskId: plan.id, ticketId: shots.id });
  h.script(director).handle(({ turn, hop }) => {
    if (turn?.trigger_message_id && h.store.getMessage(turn.trigger_message_id).kind === "user") {
      return hop === 1 ? call(tool("work_on", { plan: plan.id, ticket: shots.id }))
        : hop === 2 ? call(writeFile(`${shots.dir}/board.md`, "S01 怪人砸楼"))
          : hop === 3 ? call(tool("submit", { artifacts: [`${shots.dir}/board.md`] }))
            // Handed in, with no word to your line yet: submit leaves it to reply.
            : say("关键帧板改好交了：S01 加了怪人砸楼的城市破坏。");
    }
    return call(tool("end_turn", { reason: "nothing_new" }));
  });

  h.postUser(dm, "但是打斗画面要有张力");
  await h.waitIdle();
  h.tick(new Date(Date.now() + 60_000));
  await h.waitIdle();
  const card = h.messages(dm).find((message) => message.control?.kind === "review_item")!;
  const before = h.turns(director).length;

  h.engine.control(card.id, { action: "reject", note: "城市破坏还不够" });
  await h.waitIdle();

  expect(h.store.db.query("SELECT home_session_id FROM work_items WHERE id = ?").get(there.work_item_id!)).toEqual({ home_session_id: room });
  const redo = h.turns(director).slice(before);
  expect(redo.map((turn) => turn.session_id)).toEqual([dm]);
});
