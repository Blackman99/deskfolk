/**
 * ADR 0040 P3: what you asked of one film carries into the next one of the group.
 *
 * On 2026-09-27…28 you told the video group, working on EP01, that the backgrounds must hold
 * together shot to shot and that every doorway needs a transition, and that the robot arm is a left
 * arm. On 09-29 at 05:22 you opened the next film in the same group, 「未来世界短片，2 分钟以上」:
 * the new plan started with no rules and no precedent (the kind label did not match), and nothing
 * you had said about how the films are made reached it.
 *
 * Target: in a video job, a requirement about how the work is made (背景连贯, 过门要有过渡) or that
 * stays the same across a series (左手) holds for the conversation the plan lives in — the project
 * — so the new film's turns read them from their first turn, marked 「继承自「EP01…」」. One that
 * does not fit the new film is set aside for it with 不适用这件事 and goes out of its turns, while
 * EP01 keeps it.
 * A requirement about one film only (「片尾字幕用白色」) stays with that film.
 */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SITUATION_HEADING } from "../context/situation";
import { createScenario, requestText, say, type Scenario } from "../test-kit/scenario";
import { planSpec, videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** The situation block of a Bot's latest hop. */
function situationOf(h: Scenario, bot: { id: string }): string {
  const hop = h.hops(bot).at(-1)!;
  const block = hop.request.messages.find((m) => typeof m.content === "string" && m.content.startsWith(SITUATION_HEADING));
  return String(block?.content ?? requestText(hop.request));
}

test("craft and series requirements said about EP01 reach the next film of the group, each can be set aside for it, and EP01 keeps them", async () => {
  const h = await createScenario();
  open.push(h);
  const { director, room } = videoTeam(h);

  // EP01, opened in the group.
  h.judge("organizer", { session: room }).reply({
    decision: "new",
    plan: planSpec("EP01 动画成片：BEACON ZERO 第一集"),
    tickets: [],
    message_ticket: null,
  });
  h.script(director, room).reply(say("收到，开始 EP01"));
  h.postUser(room, "@视频导演 做一集 EP01 动画成片");
  await h.waitIdle();
  const [ep01] = h.store.sessionTasks(room);
  // EP01 is video work: the director handed over a first cut in it.
  writeFileSync(join(h.root, "EP01_cut.mp4"), "mp4");
  const cut = h.store.insertMessage({ sessionId: room, kind: "bot", author: director.id, body: "初剪：EP01_cut.mp4", paths: ["EP01_cut.mp4"] });
  h.store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [ep01!.id, cut.id]);

  // What you asked of EP01, as the scribe reads it.
  h.judge("organizer", { session: room }).reply({ decision: "continue", plan: planSpec("EP01 动画成片：BEACON ZERO 第一集"), tickets: [] });
  h.judge("scribe", { session: room }).reply({
    adds: [
      { quote: "所有镜头背景要连贯", restated: "镜头之间背景连贯", category: "背景连贯", scope_hint: "plan" },
      { quote: "每次过门都要有过渡镜头", category: "转场", scope_hint: "plan" },
      { quote: "机械臂必须是左手", category: "角色设定", scope_hint: "plan" },
      { quote: "片尾字幕用白色", category: "字幕", scope_hint: "plan" },
    ],
    raises: [],
    supersedes: [],
  });
  h.script(director, room).reply(say("记下了"));
  h.postUser(room, "@视频导演 所有镜头背景要连贯，每次过门都要有过渡镜头，机械臂必须是左手，片尾字幕用白色");
  await h.waitIdle();
  const entries = h.store.listRequirements();
  expect(entries.map((entry) => [entry.quote, entry.scope, entry.origin_task_id])).toEqual([
    ["所有镜头背景要连贯", "project", ep01!.id],
    ["每次过门都要有过渡镜头", "project", ep01!.id],
    ["机械臂必须是左手", "project", ep01!.id],
    ["片尾字幕用白色", "plan", ep01!.id],
  ]);
  const [continuity, transition, arm] = entries;

  // 05:22, the next film, in the same group.
  h.judge("organizer", { session: room }).reply({ decision: "new", plan: planSpec("未来世界短片《回响纪元》"), tickets: [], message_ticket: null });
  h.judge("scribe", { session: room }).reply({ adds: [], raises: [], supersedes: [] });
  h.script(director, room).reply(say("好，开新片"));
  h.postUser(room, "@视频导演 新开一个：未来世界短片，2 分钟以上");
  await h.waitIdle();
  const film = h.store.sessionTasks(room).find((task) => task.id !== ep01!.id)!;
  expect(h.turns(director).at(-1)!.task_id).toBe(film.id);

  // Its first turn already reads them, inherited from EP01; the EP01-only line is not among them.
  const first = situationOf(h, director);
  for (const entry of [continuity, transition, arm]) {
    expect(first).toContain(`R-${entry!.seq}｜「${entry!.quote}」`);
  }
  expect(first).toContain("适用：这个会话的每件事（继承自「EP01 动画成片：BEACON ZER…」）");
  expect(first).not.toContain(`R-${entries[3]!.seq}｜`);
  // The board says the same.
  expect(h.store.taskDetail(film.id, () => true).requirements!.map((entry) => [entry.seq, entry.inherited_from?.task_id])).toEqual(
    [continuity, transition, arm].map((entry) => [entry!.seq, ep01!.id]),
  );

  // The arm is BEACON ZERO's, not this film's: 不适用这件事.
  h.store.setRequirementHere(arm!.id, { taskId: film.id, holds: false });
  h.judge("organizer", { session: room }).reply({ decision: "continue", plan: planSpec("未来世界短片《回响纪元》"), tickets: [] });
  h.judge("scribe", { session: room }).reply({ adds: [], raises: [], supersedes: [] });
  h.script(director, room).reply(say("明白"));
  h.postUser(room, "@视频导演 分镜先给我看看");
  await h.waitIdle();
  const next = situationOf(h, director);
  expect(next).not.toContain(`R-${arm!.seq}｜`);
  expect(next).toContain(`R-${continuity!.seq}｜`);
  expect(h.store.planRequirements(film.id).find((entry) => entry.id === arm!.id)).toMatchObject({ excluded: true });
  // EP01 keeps all four.
  expect(h.store.planRequirements(ep01!.id).map((entry) => [entry.quote, entry.excluded])).toEqual(entries.map((entry) => [entry.quote, false]));
});
