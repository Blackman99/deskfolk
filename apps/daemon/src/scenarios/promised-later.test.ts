/**
 * 2026-10-03, 19:09: you told the video group to start over from EP01. 视频导演 answered 「已确认重新
 * 启动……正在编写全新第 1 集设定集与剧本分镜方案。」 with `send_message`, then ended its segment with
 * `end_turn(done)` eight seconds later. The plan's one ticket still read handed over from the earlier
 * run, so nothing was open on the work: the ending went through, nothing woke the director again, and
 * the group showed a Bot "writing" that had stopped. The closing check did not catch it either —
 * 「正在编写」 was not among its words, and it had spent its one look on the files the line cited.
 *
 * Now the end contract weighs the segment's last word: a "still going" with nobody named to take it
 * bounces the ending once, and an ending after that goes through with a line telling you it stopped.
 */
import { afterEach, expect, test } from "bun:test";
import { call, checkBack, createScenario, fileUnder, requestText, say, sendMessage, tool, type HopContext, type Scenario, type ScriptedCall, type ToolOutcome } from "../test-kit/scenario";
import { openPlan, planSpec, videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const PROMISE = "已确认重新启动：之前全部内容作废，从第 1 集全新重做。正在编写全新第 1 集设定集与剧本分镜方案。";

/** The labels of your lines a hop read (`U12`); ULIDs never hold a `U`, so nothing else matches. */
function yourLabels(request: HopContext["request"]): string[] {
  return [...new Set([...requestText(request).matchAll(/\bU\d+\b/g)].map((match) => match[0]))];
}

/**
 * The group, its plan, and the ticket the earlier run left reading handed over; then your line and
 * the director's segment: the promise (sent again if the closing check turns it back, as the
 * second send goes through), `end_turn(done)`, and `next` for the hop after a refused ending (given that same ending).
 */
async function startOver(h: Scenario, next: (results: ToolOutcome[], end: ScriptedCall) => ScriptedCall[]) {
  const { director, room } = videoTeam(h);
  const plan = openPlan(h, room, "一拳超人", planSpec("一拳超人风格可播放短片"));
  h.store.createTicket({ taskId: plan.id, title: "一拳超人风格可播放短片", status: "review", worker: director.id });
  const refused: ToolOutcome[] = [];
  let labels: string[] = [];
  let sent = false;
  h.script(director).handle(({ hop, request, results }) => {
    if (hop === 1) labels = yourLabels(request);
    if (results.some((result) => result.name === "send_message" && result.ok)) sent = true;
    const end = tool("end_turn", { reason: "done", inbox: labels.map((id) => ({ id, disposition: "answered" })) });
    const bounced = results.filter((result) => result.name === "end_turn" && !result.ok);
    refused.push(...bounced);
    if (!sent) return call(sendMessage(PROMISE));
    if (bounced.length > 0 || results.some((result) => result.name === "check_back")) return call(...next(results, end));
    return call(end);
  });
  h.postUser(room, "@视频导演 从头再做一遍，之前的作废");
  await h.waitIdle();
  const turn = h.store.db.query<{ status: string; end_reason: string | null }, [string]>(
    "SELECT status, end_reason FROM turns WHERE bot_id = ? ORDER BY created_at DESC").get(director.id)!;
  return { director, room, refused, turn };
}

test("saying the work is under way and ending anyway bounces once, then tells you it stopped", async () => {
  const h = await createScenario({ submissions: true });
  open.push(h);
  const { room, refused, turn } = await startOver(h, (_, end) => [end]);
  // The first ending is turned back with the director's own words; the second goes through.
  expect(refused).toHaveLength(1);
  expect(refused[0]!).toMatchObject({ error: "promised_later", content: expect.stringContaining("正在编写全新第 1 集设定集与剧本分镜方案") });
  expect(turn).toEqual({ status: "completed", end_reason: "done" });
  // What you read in the group: its line, then one saying it stopped and how to get it going.
  const lines = h.messages(room).filter((message) => message.author !== "user").map((message) => `${message.kind}: ${message.body}`);
  expect(lines.at(-2)).toBe(`bot: ${PROMISE}`);
  expect(lines.at(-1)).toMatch(/^system: .*视频导演说「正在编写全新第 1 集设定集与剧本分镜方案。」，但这一轮已经结束了，没有人接着做。要它继续，@ 视频导演。$/);
});

test("a check-back booked after the bounce ends the segment waiting, with no line about a stop", async () => {
  const h = await createScenario({ submissions: true });
  open.push(h);
  const { director, room, refused, turn } = await startOver(h, (results) => results.some((result) => result.name === "check_back")
    ? [tool("end_turn", { reason: "nothing_new" })]
    : [checkBack(30, "写完第 1 集设定集与分镜后提交拍板")]);
  expect(refused).toHaveLength(1);
  expect(turn).toEqual({ status: "completed", end_reason: "nothing_new" });
  expect(h.messages(room).filter((message) => message.kind === "system" && message.body.includes("没有人接着做"))).toEqual([]);
  const pending = h.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM check_backs WHERE bot_id = ? AND fired_at IS NULL AND voided_at IS NULL").get(director.id)!.n;
  expect(pending).toBe(1);
});

test("said as a closing reply, the promise goes out first and the line about the stop after it", async () => {
  const h = await createScenario({ submissions: true });
  open.push(h);
  const { director, room } = videoTeam(h);
  const plan = openPlan(h, room, "一拳超人", planSpec("一拳超人风格可播放短片"));
  h.store.createTicket({ taskId: plan.id, title: "一拳超人风格可播放短片", status: "review", worker: director.id });
  const heard: string[] = [];
  h.script(director).handle(({ request }) => {
    heard.push(requestText(request));
    return say(PROMISE);
  });
  h.postUser(room, "@视频导演 从头再做一遍，之前的作废");
  await h.waitIdle();
  // Turned back once (the closing check may have looked first), and the reply after that goes out.
  expect(heard.some((text) => text.includes("You said 「正在编写全新第 1 集设定集与剧本分镜方案。」"))).toBe(true);
  const lines = h.messages(room).filter((message) => message.author !== "user").map((message) => message.kind);
  expect(lines.slice(-2)).toEqual(["bot", "system"]);
  expect(h.messages(room).at(-1)!.body).toContain("没有人接着做");
});

test("the start-over line asks to send the handed-over ticket back, and sent back it is the director's again", async () => {
  const h = await createScenario({ submissions: true });
  open.push(h);
  const { director, room } = videoTeam(h);
  const plan = openPlan(h, room, "一拳超人", planSpec("一拳超人风格可播放短片"));
  const ticket = h.store.createTicket({ taskId: plan.id, title: "一拳超人风格可播放短片", status: "review", worker: director.id });
  h.script(director).handle(() => call(tool("end_turn", { reason: "nothing_new" })));
  h.judge("read_filing").reply(fileUnder("一拳超人"));
  h.postUser(room, "@视频导演 从头再做一遍，之前的作废");
  await h.waitIdle();
  const card = h.messages(room).find((message) => message.control?.kind === "rework");
  expect(card?.body).toContain("从头再做一遍，之前的作废");
  expect(card?.control).toMatchObject({ ticket_id: ticket.id, offer: ["rework", "dismiss"] });
  h.engine.control(card!.id, { action: "rework" });
  await h.waitIdle();
  expect(h.store.getTicket(ticket.id)).toMatchObject({ status: "doing", stage: "rework" });
});
