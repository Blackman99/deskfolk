/**
 * The app's lines about the requirements ledger (ADR 0040 P3), end to end. Since 2026-10-04 none is
 * put up: old rules nobody found your words for stay reference-only until you take them up on the
 * board, and a craft category you raised in two video jobs of the group stays the group's. Cards
 * an earlier build put up still take their buttons: 都是 puts old rules in force, 升为常设 makes a
 * craft entry hold for every video job (and nothing the card should not have named).
 */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { USER_MEMBER, type Message } from "@real-bot/protocol";
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

/** A card as an earlier build put it up in `room`. */
function oldCard(h: Scenario, room: string, control: Extract<Message["control"], { kind: "requirement" }>): Message {
  return h.store.insertMessage({ sessionId: room, kind: "system", author: USER_MEMBER, body: "（旧卡片）", hiddenFromBots: true, control });
}

/** EP01 with old rules the organizer wrote before the ledger, taken in with none of your words found. */
function oldRules(h: Scenario, room: string, rules: string[]) {
  const goal = "EP01 动画成片";
  const ep01 = openPlan(h, room, "EP01", planSpec(goal));
  h.store.db.run(`UPDATE tasks SET spec = ? WHERE id = ?`, [JSON.stringify(planSpec(goal, { rules })), ep01.id]);
  h.store.db.run(`DELETE FROM settings WHERE key = ?`, [LEGACY_IMPORTED_KEY]);
  return { goal, ep01, ids: h.store.importLegacyRules() };
}

test("old rules with none of your words are not asked about: they stay for reference, and the board takes them up", async () => {
  const h = await createScenario();
  open.push(h);
  const { director, room } = videoTeam(h);
  const { goal, ep01, ids: [old] } = oldRules(h, room, ["用户要求这条短片接着做完"]);
  expect(h.store.getRequirement(old!)).toMatchObject({ status: "unverified", added_by: "import" });

  for (const line of ["@视频导演 分镜先给我看看", "@视频导演 再快一点"]) {
    h.judge("organizer", { session: room }).reply({ decision: "continue", plan: planSpec(goal), tickets: [] });
    h.script(director, room).reply(say("好"));
    h.postUser(room, line);
    await h.waitIdle();
  }
  expect(cards(h, room)).toEqual([]);
  expect(h.store.getRequirement(old!).status).toBe("unverified");
  expect(h.store.planRequirements(ep01.id)).toMatchObject([{ id: old, status: "unverified" }]);
  h.store.confirmRequirement(old!, { taskId: ep01.id });
  expect(h.store.getRequirement(old!).status).toBe("open");
});

test("a card about old rules already out: 都是 puts them in force, once; gone through on the board, it settles and a stale press changes nothing", async () => {
  const h = await createScenario();
  open.push(h);
  const { room } = videoTeam(h);
  const { ep01, ids } = oldRules(h, room, ["用户要求这条短片接着做完", "按附件图片里的格式来写", "地址字段和排版与附件图片一致"]);
  const [kept, ...rest] = ids;
  const pressed = oldCard(h, room, { kind: "requirement", event: "legacy", requirement_ids: [kept!], task_id: ep01.id, offer: ["confirm_requirements", "review_requirements"] });
  expect(() => h.engine.control(pressed.id, { action: "review_requirements" })).toThrow("this line does not offer that button");
  expect(h.engine.control(pressed.id, { action: "confirm_requirements" })).toEqual({ made: [], lifted: [] });
  expect(h.store.getRequirement(kept!).status).toBe("open");
  expect(h.store.getMessage(pressed.id).control).toMatchObject({ acted: ["confirm_requirements"] });
  expect(h.engine.control(pressed.id, { action: "confirm_requirements" })).toEqual({ made: [], lifted: [] });

  const settled = oldCard(h, room, { kind: "requirement", event: "legacy", requirement_ids: rest, task_id: ep01.id, offer: ["confirm_requirements", "review_requirements"] });
  for (const id of rest) h.store.rejectRequirement(id, { taskId: ep01.id });
  expect(h.store.getMessage(settled.id).control).toMatchObject({ settled_at: expect.any(String) });
  expect(h.engine.control(settled.id, { action: "confirm_requirements" })).toEqual({ made: [], lifted: [] });
  expect(rest.map((id) => h.store.getRequirement(id).status)).toEqual(["not_requirement", "not_requirement"]);
  expect(h.store.getMessage(settled.id).control).not.toHaveProperty("acted");
});

test("a craft category raised in two video jobs is not suggested as standing; a standing card already out still widens only what it may", async () => {
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
  expect(h.store.getRequirement(continuity.id)).toMatchObject({ times_raised: 3, scope: "project", scope_id: room });
  expect(cards(h, room)).toEqual([]);

  // A card an earlier build put up, naming more than such a card may: 升为常设 widens only a craft
  // entry of this group still in force. Another group's entry of the category stays its own.
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
  const card = oldCard(h, room, { kind: "requirement", event: "standing", requirement_ids: [continuity.id, theirs.id], task_id: film.id,
    category: "背景连贯", domain: "video", offer: ["make_standing", "keep_project"] });
  h.engine.control(card.id, { action: "make_standing" });
  expect(h.store.getRequirement(continuity.id)).toMatchObject({ scope: "standing", scope_id: null, domain: "video" });
  expect(h.store.getRequirement(theirs.id)).toMatchObject({ scope: "project", scope_id: elsewhere });
});
