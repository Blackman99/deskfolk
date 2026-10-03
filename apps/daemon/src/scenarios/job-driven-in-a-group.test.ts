/**
 * 2026-10-03, the 《一拳超人》 job. It had opened on 2026-10-01 in your direct with 审片员, from
 * 「你为什么不回复视频导演」, and the episodes were made under it from there. On 10-03 you archived
 * 审片员 at 10:42, and at 11:03 you said 「制作《一拳超人》动画」 in the group AI影视创作组, where
 * 视频导演 is the lead you confirmed; the line was filed under that job, and the work went on in
 * the group. But everything that asks who may work on a job asked only its home conversation, the
 * archived Bot's direct: 视频导演, the group's lead, was refused `plan_items` ("this plan has no
 * confirmed lead"), its own ticket was nobody's (视频导演 is no member of that direct), and the
 * supervisor's notices had nowhere you would look but that direct.
 *
 * A job's conversations are its home and every conversation you have spoken about it in. A Bot
 * that is a member of one of them can hold its tickets; a lead you confirmed in one of those groups
 * is its lead; and the supervisor tells you where you last spoke about it, never in the direct of
 * an archived Bot.
 */
import { afterEach, expect, test } from "bun:test";
import { confirmGroupLead } from "../store/group-leads";
import { createScenario, endTurn, call, type Scenario } from "../test-kit/scenario";
import { openPlan, planSpec } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function theJob(h: Scenario) {
  const [reviewer, director, writer] = h.createBots(
    { name: "审片员", duties: "逐镜审片，放行或打回" },
    { name: "视频导演", duties: "按分镜生成镜头，剪辑，出母带" },
    { name: "故事编剧", duties: "写剧本和分镜" },
  );
  const reviewerDm = h.direct(reviewer!);
  const room = h.group("AI影视创作组", [director!, writer!]);
  confirmGroupLead(h.store, room, director!.id);
  // 10-01, in your direct with 审片员: the job opens there.
  const job = openPlan(h, reviewerDm, "让审片员回复视频导演，说明未回复原因并给出审片意见。", planSpec("一拳超人动画"));
  const asked = h.store.transaction(() => h.store.postMessage(reviewerDm, { body: "你为什么不回复视频导演" }));
  h.store.fileMessage(asked.id, { explicit: [{ taskId: job.id }] });
  const film = h.store.createTicket({ taskId: job.id, title: "一拳超人风格可播放短片", status: "todo", worker: director!.id });
  // 10-03 10:42: 审片员 archived. 11:03: you take the job up in the group.
  h.store.archiveBot(reviewer!.id);
  const said = h.store.transaction(() => h.store.postMessage(room, { body: "制作《一拳超人》动画" }));
  h.store.fileMessage(said.id, { explicit: [{ taskId: job.id }] });
  return { reviewer: reviewer!, director: director!, writer: writer!, reviewerDm, room, job, film };
}

test("the group's lead lays the job out, though the job opened in another conversation", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const { director, writer, room, job } = await theJob(h);

  const turn = h.store.createTurn({ sessionId: room, botId: director.id, triggerMessageId: h.messages(room).at(-1)!.id, taskId: job.id });
  const laid = h.store.planItems({ turnId: turn.id, items: [{ title: "第 1 集剧本与分镜", owner: "故事编剧", reviewer: "视频导演" }] });
  expect(laid.tickets.map(({ title, owner, reviewer }) => ({ title, owner, reviewer }))).toEqual([
    { title: "第 1 集剧本与分镜", owner: writer.id, reviewer: director.id },
  ]);
  expect(h.store.planLead(job.id)).toBe(director.id);
});

test("its ticket is the director's, the supervisor calls the director back to it in the group, and says there that it stopped", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const { director, reviewerDm, room, film } = await theJob(h);

  expect(h.store.ballHolder({ ticketId: film.id })).toMatchObject({ kind: "owner", botId: director.id });

  // Nobody moves it: each call-back the director ends with nothing new.
  h.script(director).reply(call(endTurn()), call(endTurn()), call(endTurn()));
  for (const minutes of [15, 30, 45]) {
    h.tick(new Date(Date.now() + minutes * 60_000));
    await h.waitIdle();
  }
  const wakes = h.store.db.query<{ bot_id: string }, [string]>(
    "SELECT bot_id FROM check_backs WHERE kind = 'supervisor' AND ticket_id = ? ORDER BY created_at").all(film.id);
  expect(wakes.length).toBeGreaterThan(0);
  expect(wakes.every((wake) => wake.bot_id === director.id)).toBe(true);
  // Twice with nothing new, and the job waits on you: the line saying so is in the group, where you
  // took the job up, not in the archived Bot's direct.
  expect(h.store.ballHolder({ ticketId: film.id })).toMatchObject({ kind: "user", reason: "blocked" });
  const said = (session: string) => h.messages(session).filter((m) => m.kind === "system" && m.created_at > film.created_at).map((m) => m.body);
  expect(said(room).some((body) => body.includes("视频导演") && body.includes("等你"))).toBe(true);
  expect(said(reviewerDm)).toEqual([]);
});
