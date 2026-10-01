/**
 * The app's lines about the requirements ledger (ADR 0040 P3), end to end: the old rules nobody
 * found your words for are asked about once, the first time a line of yours lands in their plan
 * (都是 puts them in force); a craft category you raised in two video jobs of the group is suggested
 * as standing once (升为常设 makes it hold for every video job, and nothing the card should not
 * have named). Neither line reaches the Bots.
 */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@real-bot/protocol";
import { standingCardBody } from "./engine/requirement-cards";
import { LEGACY_IMPORTED_KEY } from "./store";
import { createScenario, say, type Scenario } from "./test-kit/scenario";
import { openPlan, planSpec, videoTeam } from "./scenarios/video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

function cards(h: Scenario, room: string): Message[] {
  return h.messages(room).filter((m) => m.control?.kind === "requirement");
}

test("old rules with none of your words are asked about once, on your next line in their plan, and 都是 puts them in force", async () => {
  const h = await createScenario();
  open.push(h);
  const { director, room } = videoTeam(h);
  const goal = "EP01 动画成片";
  const ep01 = openPlan(h, room, "EP01", planSpec(goal));
  // Written by the organizer before the ledger, then taken in: nobody found your words for it.
  h.store.db.run(`UPDATE tasks SET spec = ? WHERE id = ?`, [JSON.stringify(planSpec(goal, { rules: ["用户要求这条短片接着做完"] })), ep01.id]);
  h.store.db.run(`DELETE FROM settings WHERE key = ?`, [LEGACY_IMPORTED_KEY]);
  const [old] = h.store.importLegacyRules();
  expect(h.store.getRequirement(old!)).toMatchObject({ status: "unverified", added_by: "import" });
  expect(cards(h, room)).toEqual([]);

  for (const line of ["@视频导演 分镜先给我看看", "@视频导演 再快一点"]) {
    h.judge("organizer", { session: room }).reply({ decision: "continue", plan: planSpec(goal), tickets: [] });
    h.script(director, room).reply(say("好"));
    h.postUser(room, line);
    await h.waitIdle();
  }
  const [card] = cards(h, room);
  expect(cards(h, room)).toHaveLength(1);
  expect(card).toMatchObject({
    kind: "system",
    control: { kind: "requirement", event: "legacy", requirement_ids: [old], task_id: ep01.id, offer: ["confirm_requirements", "review_requirements"] },
  });
  expect(card!.body).toContain("「用户要求这条短片接着做完」");
  expect(card!.body).toContain("这些是你说的吗？");
  // For you: the Bots read the ledger in their situation, not this line.
  expect(h.hops(director).some((hop) => JSON.stringify(hop.request.messages).includes("这些是你说的吗"))).toBe(false);

  expect(() => h.engine.control(card!.id, { action: "review_requirements" })).toThrow("this line does not offer that button");
  expect(h.engine.control(card!.id, { action: "confirm_requirements" })).toEqual({ made: [], lifted: [] });
  expect(h.store.getRequirement(old!).status).toBe("open");
  expect(h.store.getMessage(card!.id).control).toMatchObject({ acted: ["confirm_requirements"] });
  // One press per line.
  expect(h.engine.control(card!.id, { action: "confirm_requirements" })).toEqual({ made: [], lifted: [] });
});

test("a craft category raised in two video jobs is suggested as standing once, and 升为常设 makes it hold for every video job", async () => {
  const h = await createScenario();
  open.push(h);
  const { director, reviewer, room } = videoTeam(h);
  /** A video the director handed over in the plan: what makes it video work. */
  const deliver = (taskId: string, sessionId: string, name: string) => {
    writeFileSync(join(h.root, name), "mp4");
    const line = h.store.insertMessage({ sessionId, kind: "bot", author: director.id, body: "交了", paths: [name] });
    h.store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [taskId, line.id]);
  };
  const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
  deliver(ep01.id, room, "EP01_MASTER.mp4");
  const first = h.store.postMessage(room, { body: "背景要连贯" });
  h.store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [ep01.id, first.id]);
  const continuity = h.store.addRequirement({
    scope: "project",
    scopeId: room,
    quote: "背景要连贯",
    category: "背景连贯",
    sourceKind: "message",
    sourceQuoteId: h.store.quoteOfMessage(first.id, "message")!.id,
    addedBy: "scribe",
  });
  const film = openPlan(h, room, "9AG7", planSpec("未来世界短片"));
  // The new film is video work too: the director handed over a cut in it.
  deliver(film.id, room, "9AG7_cut.mp4");

  for (const line of ["@视频导演 前后背景还是要连贯", "@视频导演 背景连贯别忘了"]) {
    h.judge("organizer", { session: room }).reply({ decision: "continue", plan: planSpec("未来世界短片"), tickets: [] });
    h.judge("scribe", { session: room }).reply({ adds: [], raises: [{ requirement_id: continuity.id, quote: line.slice(5) }], supersedes: [] });
    h.script(director, room).reply(say("收到"));
    h.postUser(room, line);
    await h.waitIdle();
  }
  expect(h.store.getRequirement(continuity.id).times_raised).toBe(3);
  const [card] = cards(h, room);
  expect(cards(h, room)).toHaveLength(1);
  expect(card).toMatchObject({
    control: { kind: "requirement", event: "standing", requirement_ids: [continuity.id], category: "背景连贯", domain: "video", offer: ["make_standing", "keep_project"] },
  });
  // The card says the words it would widen, so the press is an informed one.
  expect(card!.body).toBe("「背景连贯」这类要求你在 2 件事里都提过：「背景要连贯」。要不要以后每个视频都照这条？");

  // A line that names more than such a card may (one put up before this build's rules, say): 升为常设
  // widens only a craft entry of this group still in force. Another group's entry of the category stays its own.
  const elsewhere = h.store.createGroup({ name: "另一个组", members: [director.id, reviewer.id] }).id;
  const other = openPlan(h, elsewhere, "别组", planSpec("别组的片子"));
  const theirLine = h.store.postMessage(elsewhere, { body: "背景也要连贯" });
  h.store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [other.id, theirLine.id]);
  const theirs = h.store.addRequirement({
    scope: "project",
    scopeId: elsewhere,
    quote: "背景也要连贯",
    category: "背景连贯",
    sourceKind: "message",
    sourceQuoteId: h.store.quoteOfMessage(theirLine.id, "message")!.id,
    addedBy: "scribe",
  });
  const control = card!.control as Extract<Message["control"], { kind: "requirement" }>;
  h.store.setMessageControl(card!.id, { ...control, requirement_ids: [...control.requirement_ids, theirs.id] });

  h.engine.control(card!.id, { action: "make_standing" });
  expect(h.store.getRequirement(continuity.id)).toMatchObject({ scope: "standing", scope_id: null, domain: "video" });
  expect(h.store.getRequirement(theirs.id)).toMatchObject({ scope: "project", scope_id: elsewhere });
});

test("a standing card names the words of what it would widen; one about a single entry says only its words", () => {
  const card = { category: "背景连贯", domain: "video", plans: 2, quotes: ["背景要连贯"], each: false };
  expect(standingCardBody("zh", card)).toBe("「背景连贯」这类要求你在 2 件事里都提过：「背景要连贯」。要不要以后每个视频都照这条？");
  expect(standingCardBody("en", card)).toBe('You have asked for "背景连贯" in 2 jobs: "背景要连贯". Make it hold for every video job from now on?');
  const one = { ...card, quotes: ["背景不能跳变"], plans: 3, each: true };
  expect(standingCardBody("zh", one)).toBe("「背景不能跳变」你在 3 件事里都说过。要不要以后每个视频都照这条？");
  expect(standingCardBody("en", one)).toBe('You have said "背景不能跳变" in 3 jobs. Make it hold for every video job from now on?');
});
