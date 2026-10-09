/**
 * The scribe's patch, applied (ADR 0040 P3): each item checked against your line on its own, every
 * change — a new number of yours included — only a proposal beside the entry, and the fallback
 * capture of a complaint the scribe filed nothing for. The property test at the end is I9: whatever
 * the scribe answers, no open entry leaves the open set.
 */
import { describe, expect, test } from "bun:test";
import { Store, type Requirement, type ScribePatch, type UserQuote } from ".";
import { readDimensions, sameDimensionValue, type DimensionValue } from "../quote-dimensions";
import { findWords, quoteWords } from "../quote-words";
import { REQUIREMENT_SUPERSEDE_ABORT } from "./requirements";
import { quoteTooShort, SCRIBE_ADDS_MAX, SCRIBE_QUOTE_MIN } from "./scribe-patch";

/** Your direct with 视频导演, and the plan its turn opened on your first line. */
function fixture() {
  const store = new Store();
  const director = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const direct = director.direct_session.id;
  const first = store.postMessage(direct, { body: "做 EP01 动画成片" });
  const turn = store.createTurn({ sessionId: direct, botId: director.bot.id, triggerMessageId: first.id });
  const planId = turn.task_id!;
  /** A line of yours in the direct, filed under the plan (and a ticket), and the quote it was kept as. */
  const say = (body: string, ticketId: string | null = null): UserQuote => {
    const line = store.postMessage(direct, { body });
    store.db.run(`UPDATE messages SET task_id = ?, ticket_id = ? WHERE id = ?`, [planId, ticketId, line.id]);
    return store.quoteOfMessage(line.id, "message")!;
  };
  /** An open entry of the plan standing on words of yours said just now. */
  const entry = (body: string, category: string, over: Partial<Parameters<Store["addRequirement"]>[0]> = {}): Requirement => {
    const quote = say(body);
    return store.addRequirement({ scope: "plan", scopeId: planId, quote: body, category, sourceKind: "message", sourceQuoteId: quote.id, addedBy: "scribe", ...over });
  };
  const apply = (quote: UserQuote, patch: Partial<ScribePatch>) =>
    store.applyScribePatch({
      quote,
      offered: store.openRequirementsFor(planId, 60).map((row) => row.id),
      patch: { adds: [], raises: [], supersedes: [], ...patch },
    });
  /** The director's turn called a video tool: what makes the plan video work. */
  const video = () => store.recordTurnRun({ turnId: turn.id, tool: "mcp__seedance__generate_video", command: "镜头 1", exitCode: 0, ok: true });
  return { store, direct, planId, say, entry, apply, video };
}

describe("an item is checked against your line", () => {
  test("its quote must be words of the line, compared without spaces, punctuation or width; the entry keeps the line's own wording", () => {
    const { store, planId, say, apply } = fixture();
    const quote = say("片长：约 ２ 分钟！机械臂必须是左手。");
    const outcome = apply(quote, {
      adds: [
        { quote: "片长约2分钟", restated: "母带约 120 秒", category: "时长", polarity: "must", scope_hint: "plan" },
        { quote: "机械臂必须是右手", category: "角色设定" },
        { quote: "机械臂必须是左手", category: "角色设定", scope_hint: "project" },
      ],
    });
    expect(outcome.added).toHaveLength(2);
    expect(outcome.rejected).toBe(1);
    const [duration, arm] = outcome.added.map((id) => store.getRequirement(id));
    expect(duration).toMatchObject({
      quote: "片长：约 ２ 分钟",
      restated: "母带约 120 秒",
      category: "时长",
      scope: "plan",
      scope_id: planId,
      status: "open",
      source_kind: "message",
      source_quote_id: quote.id,
      added_by: "scribe",
      dimension: "duration",
      value: { seconds: 120, bound: "about" },
    });
    expect(arm).toMatchObject({ quote: "机械臂必须是左手", scope: "project", scope_id: quote.session_id, dimension: null });
    expect(store.listWorkEvents({ kind: "scribe.rejected" })).toMatchObject([
      { actor: "scribe", task_id: planId, payload: { quote: quote.id, item: "add", index: 1, reason: "quote_not_in_line" } },
    ]);
    store.close();
  });

  test("a malformed item, an unknown entry or one not open is dropped and logged, and the rest still land", () => {
    const { store, planId, say, entry, apply } = fixture();
    const arm = entry("机械臂必须是左手", "角色设定");
    const waived = entry("字幕用黑体", "字幕", { status: "waived" });
    const elsewhere = store.openTask({ sessionId: say("x").session_id!, title: "另一件事" });
    const other = store.addRequirement({ scope: "plan", scopeId: elsewhere.id, quote: "另一件事的要求", category: "台词", sourceKind: "board", addedBy: "user" });
    const quote = say("再说一次，机械臂必须是左手，字幕用黑体");
    const outcome = apply(quote, {
      raises: [
        "not an object",
        { requirement_id: arm.id },
        { requirement_id: waived.id, quote: "字幕用黑体" },
        { requirement_id: other.id, quote: "机械臂必须是左手" },
        { requirement_id: 42, quote: "机械臂必须是左手" },
        { requirement_id: arm.id, quote: "机械臂必须是左手" },
        { requirement_id: arm.id, quote: "机械臂必须是左手" },
      ],
    });
    expect(outcome).toEqual({ added: [], raised: [arm.id], proposed: [], rejected: 6 });
    expect(store.getRequirement(arm.id).times_raised).toBe(2);
    expect(store.listWorkEvents({ kind: "scribe.rejected" }).map((row) => row.payload.reason)).toEqual([
      "malformed",
      "malformed",
      "not_offered",
      "not_offered",
      "not_offered",
      "duplicate",
    ]);
    expect(store.getRequirement(waived.id).status).toBe("waived");
    expect(store.getRequirement(other.id).times_raised).toBe(1);
    expect(planId).toBeTruthy();
    store.close();
  });

  test("an addition repeating an open entry here raises it instead, one repeated in the same answer lands once, and a line brings at most SCRIBE_ADDS_MAX", () => {
    const { store, say, entry, apply } = fixture();
    const arm = entry("机械臂必须是左手", "角色设定");
    const many = Array.from({ length: SCRIBE_ADDS_MAX + 2 }, (_, i) => `第${i + 1}镜要夜景`);
    const quote = say(`机械臂必须是左手。${many.join("，")}`);
    const outcome = apply(quote, {
      adds: [
        { quote: "机械臂必须是左手", category: "角色设定" },
        { quote: "机械臂必须是左手", category: "角色设定" },
        { quote: many[0], category: "场景" },
        ...many.map((words) => ({ quote: words, category: "场景" })),
      ],
    });
    expect(outcome.raised).toEqual([arm.id]);
    expect(store.getRequirement(arm.id).times_raised).toBe(2);
    expect(outcome.added).toHaveLength(SCRIBE_ADDS_MAX);
    expect(store.listWorkEvents({ kind: "scribe.rejected" }).map((row) => row.payload.reason)).toEqual(["duplicate", "duplicate", "too_many", "too_many"]);
    store.close();
  });

  test("your words again for an entry you set not to hold for this plan: it holds here again, said once more, not a second entry", () => {
    const { store, direct, planId, say, apply } = fixture();
    const first = say("每次过门都要有过渡镜头");
    const transition = store.addRequirement({ scope: "project", scopeId: direct, quote: "每次过门都要有过渡镜头", category: "转场", sourceKind: "message", sourceQuoteId: first.id, addedBy: "scribe" });
    store.setRequirementHere(transition.id, { taskId: planId, holds: false });
    const quote = say("每次过门都要有过渡镜头，这件也一样");
    const outcome = apply(quote, { adds: [{ quote: "每次过门都要有过渡镜头", category: "转场", scope_hint: "plan" }] });
    expect(outcome).toMatchObject({ added: [], raised: [transition.id] });
    expect(store.listRequirements()).toHaveLength(1);
    expect(store.getRequirement(transition.id).times_raised).toBe(2);
    expect(store.planRequirements(planId)).toMatchObject([{ id: transition.id, excluded: false }]);
    expect(store.listWorkEvents({ kind: "requirement.here_again" })).toMatchObject([
      { actor: "scribe", task_id: planId, payload: { requirement: transition.id, task: planId, quote: quote.id } },
    ]);
    store.close();
  });

  test("in a video job too, where an entry holds is the scribe's reading: the whole conversation only when it read 「以后都这样」", () => {
    // IG MV, 2026-10-09: 19 entries about this job alone (「要还原真实的比赛镜头」「对手的形象」) were widened to
    // the whole direct because they read as craft or look in a video job, and showed as inherited in
    // 「Connect to ACE Studio」. The scribe had said plan for them (2026-10-10: its reading decides).
    const { store, direct, planId, say, apply, video } = fixture();
    video();
    const ticket = store.createTicket({ taskId: planId, title: "C09" });
    const quote = say("背景要前后连贯，C09 背景要干净，字体统一用黑体，以后每部片都要有片尾二维码");
    const outcome = apply(quote, {
      adds: [
        { quote: "背景要前后连贯", category: "背景连贯", scope_hint: "plan", nature: "craft" },
        { quote: "C09 背景要干净", category: "背景连贯", scope_hint: "plan" },
        { quote: "字体统一用黑体", category: "字幕", scope_hint: "ticket", targets: [ticket.id] },
        { quote: "以后每部片都要有片尾二维码", category: "片尾", scope_hint: "project" },
      ],
    });
    expect(outcome.added.map((id) => store.getRequirement(id)).map((entry) => [entry.quote, entry.scope, entry.scope_id])).toEqual([
      ["背景要前后连贯", "plan", planId],
      ["C09 背景要干净", "plan", planId],
      ["字体统一用黑体", "ticket", ticket.id],
      ["以后每部片都要有片尾二维码", "project", direct],
    ]);
    store.close();
  });

  test("in a job that is no video work, a line that sounds like craft stays with the job; one you say every job should keep to still holds for all", () => {
    const { store, direct, planId, say, apply } = fixture();
    const quote = say("段落之间要有过渡，以后每份报告都用这个模板");
    const outcome = apply(quote, {
      adds: [
        { quote: "段落之间要有过渡", category: "过渡", scope_hint: "plan" },
        { quote: "以后每份报告都用这个模板", category: "模板", scope_hint: "project" },
      ],
    });
    expect(outcome.added.map((id) => store.getRequirement(id)).map((entry) => [entry.quote, entry.scope, entry.scope_id])).toEqual([
      ["段落之间要有过渡", "plan", planId],
      ["以后每份报告都用这个模板", "project", direct],
    ]);
    store.close();
  });

  test("a line for the whole plan with a ticket's words is an entry of its own the next plan inherits; a ticket's line raises only that ticket's", () => {
    const { store, direct, planId, say, apply, video } = fixture();
    video();
    const [c09, c10] = ["C09", "C10"].map((title) => store.createTicket({ taskId: planId, title }));
    const shot = apply(say("背景要连贯", c09!.id), { adds: [{ quote: "背景要连贯", category: "背景连贯", scope_hint: "ticket" }] }).added[0]!;
    expect(store.getRequirement(shot)).toMatchObject({ scope: "ticket", scope_id: c09!.id });
    // The same ticket again: said again. Another ticket: that ticket's own.
    expect(apply(say("背景要连贯", c09!.id), { adds: [{ quote: "背景要连贯", category: "背景连贯", scope_hint: "ticket" }] })).toMatchObject({ added: [], raised: [shot] });
    const other = apply(say("背景要连贯", c10!.id), { adds: [{ quote: "背景要连贯", category: "背景连贯", scope_hint: "ticket" }] }).added[0]!;
    expect(store.getRequirement(other)).toMatchObject({ scope: "ticket", scope_id: c10!.id });

    // Later, for every film here from now on: the conversation's own entry, not a third raise of C09's.
    const outcome = apply(say("以后每部片都是，背景要连贯"), { adds: [{ quote: "背景要连贯", category: "背景连贯", scope_hint: "project" }] });
    expect(outcome.raised).toEqual([]);
    const [wide] = outcome.added.map((id) => store.getRequirement(id));
    expect(wide).toMatchObject({ scope: "project", scope_id: direct, quote: "背景要连贯" });
    expect(store.getRequirement(shot).times_raised).toBe(2);
    const next = store.openTask({ sessionId: direct, title: "EP02 动画成片" });
    expect(store.planRequirements(next.id).map((entry) => entry.id)).toEqual([wide!.id]);
    store.close();
  });

  test("a new entry or a proposal needs SCRIBE_QUOTE_MIN of your words, or the whole of a shorter line", () => {
    const { store, say, entry, apply } = fixture();
    const transition = entry("每次过门都要有过渡镜头", "转场");
    const quote = say("接着做，C09 的脚不能穿地，过门直接切");
    const outcome = apply(quote, {
      adds: [
        { quote: "做", restated: "用户要求接着做完", category: "进度" },
        { quote: "C09 的脚不能穿地", category: "穿模" },
      ],
      supersedes: [{ requirement_id: transition.id, quote: "直接切", restated: "过门硬切", category: "转场" }],
    });
    expect(outcome.added.map((id) => store.getRequirement(id).quote)).toEqual(["C09 的脚不能穿地"]);
    expect(outcome.proposed).toEqual([]);
    expect(store.listWorkEvents({ kind: "scribe.rejected" }).map((row) => [row.payload.item, row.payload.reason])).toEqual([
      ["supersede", "quote_too_short"],
      ["add", "quote_too_short"],
    ]);
    // A line shorter than that is taken whole.
    const short = apply(say("竖屏！"), { adds: [{ quote: "竖屏", category: "画幅" }] });
    expect(short.added.map((id) => store.getRequirement(id).quote)).toEqual(["竖屏"]);
    expect(SCRIBE_QUOTE_MIN).toBe(4);
    store.close();
  });

  test("a number for a running time, a resolution, an aspect or a frame rate may be shorter, inside a longer line", () => {
    const { store, say, apply } = fixture();
    const quote = say("字幕用白色描边，整体节奏再快一点，片长 2 分钟");
    const outcome = apply(quote, {
      adds: [
        { quote: "2 分钟", restated: "片长 120 秒", category: "时长" },
        { quote: "白色", category: "字幕" },
      ],
    });
    expect(outcome.added.map((id) => store.getRequirement(id))).toMatchObject([{ quote: "2 分钟", dimension: "duration", value: { seconds: 120, bound: "exact" } }]);
    expect(store.listWorkEvents({ kind: "scribe.rejected" }).map((row) => [row.payload.item, row.payload.reason])).toEqual([["add", "quote_too_short"]]);
    const more = apply(say("另外出成 4K，画幅用 16:9，别的照旧"), {
      adds: [
        { quote: "4K", category: "分辨率" },
        { quote: "16:9", category: "画幅" },
      ],
    });
    expect(more.added.map((id) => store.getRequirement(id).quote)).toEqual(["4K", "16:9"]);
    store.close();
  });

  test("a ticket is where an addition holds when it names exactly one of the plan's, or the line was filed under one", () => {
    const { store, planId, say, apply } = fixture();
    const c09 = store.createTicket({ taskId: planId, title: "C09" });
    const c10 = store.createTicket({ taskId: planId, title: "C10" });
    const quote = say("C09 的脚不能穿地，C10 也是", c10.id);
    const outcome = apply(quote, {
      adds: [
        { quote: "C09 的脚不能穿地", category: "穿模", scope_hint: "ticket", targets: [c09.id, "not-a-ticket"] },
        { quote: "C10 也是", category: "穿模", scope_hint: "ticket", targets: [] },
        { quote: "的脚不能穿地", category: "穿模", scope_hint: "ticket", targets: [c09.id, c10.id] },
      ],
    });
    expect(outcome.added.map((id) => store.getRequirement(id)).map((row) => [row.scope, row.scope_id])).toEqual([
      ["ticket", c09.id],
      ["ticket", c10.id],
      ["plan", planId],
    ]);
    store.close();
  });
});

describe("a change", () => {
  test("to a number you gave is only proposed, whatever category the scribe names: the entry stays open beside it", () => {
    const { store, planId, say, entry, apply } = fixture();
    const duration = entry("片长约 2 分钟", "时长");
    expect(duration).toMatchObject({ dimension: "duration", value: { seconds: 120, bound: "about" } });
    const quote = say("改成 3 分钟");
    const outcome = apply(quote, { supersedes: [{ requirement_id: duration.id, quote: "改成 3 分钟", restated: "母带 180 秒", category: "别的类别" }] });
    expect(outcome).toMatchObject({ added: [], raised: [], rejected: 0 });
    expect(outcome.proposed).toHaveLength(1);
    expect(store.getRequirement(outcome.proposed[0]!)).toMatchObject({
      quote: "改成 3 分钟",
      restated: "母带 180 秒",
      category: "时长",
      scope: "plan",
      scope_id: planId,
      status: "proposed",
      supersedes: duration.id,
      dimension: "duration",
      value: { seconds: 180, bound: "exact" },
      source_quote_id: quote.id,
    });
    expect(store.getRequirement(duration.id)).toMatchObject({ status: "open", superseded_by: null });
    expect(store.listWorkEvents({ kind: "requirement.supersede" })).toEqual([]);
    store.close();
  });

  test("several numbers in one line are each proposed, a short one included; words said earlier too; none closes anything", () => {
    const { store, say, entry, apply } = fixture();
    const duration = entry("片长约 2 分钟", "时长");
    const fps = entry("24fps", "帧率");
    const early = say("改成 4K");
    const resolution = entry("出 1080p", "分辨率");
    const lines = entry("台词按剧本原文", "台词");
    const quote = say("改成 3 分钟，帧率 30fps，还是约 2 分钟吧");
    const outcome = apply(quote, {
      supersedes: [
        { requirement_id: duration.id, quote: "3 分钟", category: "时长" },
        { requirement_id: fps.id, quote: "30fps", category: "别的" },
        { requirement_id: lines.id, quote: "还是约 2 分钟吧", category: "台词" },
      ],
    });
    expect(outcome.proposed.map((id) => store.getRequirement(id)).map((row) => [row.supersedes, row.quote, row.dimension])).toEqual([
      [duration.id, "3 分钟", "duration"],
      [fps.id, "30fps", "fps"],
      [lines.id, "还是约 2 分钟吧", "duration"],
    ]);
    const late = apply(early, { supersedes: [{ requirement_id: resolution.id, quote: "改成 4K", category: "别的" }] });
    expect(late).toMatchObject({ proposed: [expect.any(String)], rejected: 0 });
    expect([duration, fps, resolution, lines].map((row) => store.getRequirement(row.id).status)).toEqual(["open", "open", "open", "open"]);
    store.close();
  });

  test("giving the entry's own number again only raises it", () => {
    const { store, say, entry, apply } = fixture();
    const duration = entry("片长约 2 分钟", "时长");
    const quote = say("还是约 2 分钟吧，别再改了");
    const outcome = apply(quote, {
      supersedes: [
        { requirement_id: duration.id, quote: "还是约 2 分钟吧", restated: "片长约 120 秒", category: "时长" },
        { requirement_id: duration.id, quote: "约 2 分钟", category: "时长" },
      ],
    });
    expect(outcome).toEqual({ added: [], raised: [duration.id], proposed: [], rejected: 1 });
    expect(store.getRequirement(duration.id)).toMatchObject({ status: "open", times_raised: 2 });
    expect(store.requirementMentions(duration.id).map((row) => row.quote_id)).toContain(quote.id);
    expect(store.listWorkEvents({ kind: "requirement.raise" })).toMatchObject([{ actor: "scribe", payload: { requirement: duration.id, quote: quote.id } }]);
    expect(store.listWorkEvents({ kind: "scribe.rejected" }).map((row) => row.payload.reason)).toEqual(["duplicate"]);
    store.close();
  });

  test("of the same category is only proposed: the entry stays open beside it; words already proposed for their own category are not aimed at another", () => {
    const { store, say, entry, apply } = fixture();
    const arm = entry("机械臂必须是左手", "角色设定");
    const transition = entry("每次过门都要有过渡镜头", "转场");
    const quote = say("过门那里直接切就行");
    const outcome = apply(quote, {
      supersedes: [
        { requirement_id: arm.id, quote: "过门那里直接切就行", category: "转场" },
        { requirement_id: transition.id, quote: "过门那里直接切就行", restated: "过门直接硬切", category: "转场" },
        { requirement_id: transition.id, quote: "那里直接切", category: "转场" },
      ],
    });
    expect(outcome.proposed).toHaveLength(1);
    expect(store.getRequirement(outcome.proposed[0]!)).toMatchObject({ status: "proposed", supersedes: transition.id, category: "转场", restated: "过门直接硬切" });
    expect([arm, transition].map((row) => store.getRequirement(row.id).status)).toEqual(["open", "open"]);
    // The same words aimed at the arm too: the scribe's misfire, not a second proposal.
    expect(store.listWorkEvents({ kind: "scribe.rejected" }).map((row) => [row.payload.reason, row.payload.requirement])).toEqual([
      ["duplicate", transition.id],
      ["duplicate", arm.id],
    ]);
    store.close();
  });

  test("of another category is proposed beside the entry it would replace, in the scribe's own category, and nothing leaves force without you", () => {
    // IG MV, 2026-10-09 00:53: 「改成基于英雄联盟地图 + 英雄模型 + 真人模型的形式来还原」, aimed by the scribe at
    // R248 「原创风格化角色」 (角色设定) under 风格, was dropped as other_category — and the new
    // direction with it: R248 stayed open and nothing recorded the change.
    const { store, planId, say, entry, apply } = fixture();
    const stylized = entry("原创风格化角色", "角色设定");
    const quote = say("改成基于英雄联盟地图 + 英雄模型 + 真人模型的形式来还原，别用视频生成");
    const outcome = apply(quote, {
      supersedes: [{ requirement_id: stylized.id, quote: "改成基于英雄联盟地图 + 英雄模型 + 真人模型的形式来还原",
        restated: "改成用英雄联盟地图、英雄模型和真人模型来还原", category: "风格", nature: "look" }],
    });
    expect(outcome).toMatchObject({ added: [], raised: [], rejected: 0 });
    expect(outcome.proposed).toHaveLength(1);
    expect(store.getRequirement(outcome.proposed[0]!)).toMatchObject({
      status: "proposed", supersedes: stylized.id, category: "风格", nature: "look",
      quote: "改成基于英雄联盟地图 + 英雄模型 + 真人模型的形式来还原", restated: "改成用英雄联盟地图、英雄模型和真人模型来还原",
    });
    expect(store.getRequirement(stylized.id).status).toBe("open");
    // Taking it up replaces the old one, as for any proposal.
    store.confirmRequirement(outcome.proposed[0]!, { taskId: planId });
    expect(store.getRequirement(stylized.id)).toMatchObject({ status: "superseded", superseded_by: outcome.proposed[0] });
    store.close();
  });

  test("beside an entry with no category to tell by (typed on the board, an old rule), a change is proposed", () => {
    const { store, planId, say, apply } = fixture();
    const typed = say("机械臂必须是左手");
    const arm = store.addRequirement({ scope: "plan", scopeId: planId, quote: "机械臂必须是左手", sourceKind: "board", sourceQuoteId: typed.id, addedBy: "user" });
    const quote = say("机械臂改成右手");
    const outcome = apply(quote, { supersedes: [{ requirement_id: arm.id, quote: "机械臂改成右手", restated: "机械臂是右手", category: "角色设定" }] });
    expect(outcome.proposed).toHaveLength(1);
    expect(store.getRequirement(outcome.proposed[0]!)).toMatchObject({ status: "proposed", supersedes: arm.id, category: null, quote: "机械臂改成右手" });
    expect(store.getRequirement(arm.id).status).toBe("open");
    expect(store.listWorkEvents({ kind: "scribe.rejected" })).toEqual([]);
    store.close();
  });

  test("I4: the database marks an entry superseded only by one standing on later words of yours, whoever writes", () => {
    const { store, say, entry } = fixture();
    const before = say("约 3 分钟");
    const duration = entry("片长约 2 分钟", "时长");
    const stale = store.addRequirement({ scope: "plan", scopeId: duration.scope_id, quote: "约 3 分钟", sourceKind: "message", sourceQuoteId: before.id, addedBy: "app" });
    expect(() => store.db.run(`UPDATE requirements SET status = 'superseded' WHERE id = ?`, [duration.id])).toThrow(REQUIREMENT_SUPERSEDE_ABORT);
    expect(() => store.db.run(`UPDATE requirements SET status = 'superseded', superseded_by = ? WHERE id = ?`, [stale.id, duration.id])).toThrow(
      REQUIREMENT_SUPERSEDE_ABORT,
    );
    const later = say("约 3 分钟");
    const by = store.addRequirement({ scope: "plan", scopeId: duration.scope_id, quote: "约 3 分钟", sourceKind: "message", sourceQuoteId: later.id, addedBy: "app" });
    store.db.run(`UPDATE requirements SET status = 'superseded', superseded_by = ? WHERE id = ?`, [by.id, duration.id]);
    expect(store.getRequirement(duration.id)).toMatchObject({ status: "superseded", superseded_by: by.id });
    store.close();
  });
});

describe("the fallback capture", () => {
  test("keeps a complaint about a job that had delivered as a proposed entry of its ticket; not before a delivery, and not a line that is no complaint", () => {
    const { store, planId, say } = fixture();
    const early = say("前三镜背景跳跃太严重");
    expect(store.captureComplaint(early)).toBeNull();
    const shots = store.createTicket({ taskId: planId, title: "Shot 01–03", status: "review" });
    store.db.run(`UPDATE tickets SET updated_at = ? WHERE id = ?`, ["2000-01-01T00:00:00.000Z", shots.id]);
    expect(store.captureComplaint(say("很好，继续"))).toBeNull();
    const complaint = say("前三镜背景严重跳跃，太假了", shots.id);
    const kept = store.captureComplaint(complaint)!;
    expect(kept).toMatchObject({
      scope: "ticket",
      scope_id: shots.id,
      quote: "前三镜背景严重跳跃，太假了",
      status: "proposed",
      added_by: "capture",
      source_quote_id: complaint.id,
      category: null,
    });
    store.close();
  });

  test("judges the job as it stood when you spoke, when it has the reading taken then: a ticket sent back to doing since still counts", () => {
    const { store, planId, say } = fixture();
    const shots = store.createTicket({ taskId: planId, title: "Shot 01–03", status: "review" });
    const complaint = say("前三镜背景严重跳跃，太假了", shots.id);
    const handedOver = store.plansHandedOver();
    // The line's filing sends the ticket back over the very complaint.
    store.patchTicket(shots.id, { status: "doing" });
    expect(store.captureComplaint(complaint)).toBeNull();
    expect(store.captureComplaint(complaint, handedOver)).toMatchObject({ scope: "ticket", scope_id: shots.id, status: "proposed" });
    // And one said before anything was handed over is not taken for a complaint about a delivery made since.
    const early = say("第四镜节奏不对");
    const nothingYet = store.plansHandedOver();
    store.patchTicket(shots.id, { status: "done" });
    expect(nothingYet.has(planId)).toBe(false);
    expect(store.captureComplaint(early, nothingYet)).toBeNull();
    store.close();
  });
});

describe("words", () => {
  test("are compared folded, and found as written", () => {
    expect(quoteWords("Ｃ09 的脚，不能 穿地！")).toBe("c09的脚不能穿地");
    expect(findWords("c09的脚不能穿地", "审片员：Ｃ09 的脚，不能 穿地！谢谢")).toBe("Ｃ09 的脚，不能 穿地");
    expect(findWords("！！", "什么都行")).toBeNull();
    expect(findWords("穿帮", "什么都行")).toBeNull();
  });
});

// ── I9 ───────────────────────────────────────────────────────────────────────────────────────

/** A small seeded generator, so a failure names the seed that reproduces it. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeds the I9 run covers: enough that a rare interplay of fragments turns up (seed 43 once did). */
const I9_SEEDS = 300;

const FRAGMENTS = [
  "改成 3 分钟", "片长约 2 分钟", "两分钟以上", "C09 的脚不能穿地", "机械臂必须是左手", "出 4K", "帧率 30fps",
  "24fps", "素材总长约 20 分钟", "不要剪成 90 秒", "帧率 24 改成 60", "像素宽高比 1:1", "分辨率从 4K 降到 1080",
  "背景要连贯", "不行，太假了", "台词别改", "画幅 9:16", "过门直接切", "字幕用黑体", "重做 Shot 12",
];
const CATEGORIES = ["时长", "角色设定", "背景连贯", "台词", "分辨率", "帧率", "转场", "穿模", ""];

describe("I9: the open entries never shrink", () => {
  test("for any scribe answer, over random ledgers and lines, adversarial changes included", () => {
    const counts = { added: 0, raised: 0, proposed: 0, proposedByNumber: 0, proposedAcross: 0, rejected: 0 };
    for (let seed = 1; seed <= I9_SEEDS; seed++) {
      const rand = mulberry32(seed);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
      const { store, planId, say, entry } = fixture();
      const ticket = store.createTicket({ taskId: planId, title: "C09" });
      const elsewhere = store.openTask({ sessionId: say("x").session_id!, title: "另一件事" });
      // A ledger: open entries of the plan (numbers among them), a ticket's, one elsewhere, some not open.
      for (let i = 0; i < 6 + Math.floor(rand() * 6); i++) {
        const status = rand() < 0.2 ? pick(["proposed", "waived", "unverified"] as const) : "open";
        entry(pick(FRAGMENTS), pick(CATEGORIES), { status, ...(rand() < 0.2 ? { scope: "ticket" as const, scopeId: ticket.id } : {}) });
      }
      store.addRequirement({ scope: "plan", scopeId: elsewhere.id, quote: pick(FRAGMENTS), category: pick(CATEGORIES), sourceKind: "board", addedBy: "user" });

      for (let round = 0; round < 5; round++) {
        const body = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(FRAGMENTS)).join("，");
        const quote = say(body, rand() < 0.3 ? ticket.id : null);
        const all = store.listRequirements();
        const offered = store.openRequirementsFor(planId, 60).map((row) => row.id);
        const anyId = (): unknown =>
          rand() < 0.7 ? pick(all).id : pick([undefined, 42, "not-an-id", pick(offered.length > 0 ? offered : ["x"])]);
        const words = (): unknown => {
          const r = rand();
          if (r < 0.5) {
            const at = Math.floor(rand() * body.length);
            return body.slice(at, at + 1 + Math.floor(rand() * 8));
          }
          if (r < 0.8) return pick(FRAGMENTS);
          return pick([undefined, null, 7, "", "  "]);
        };
        const item = (): unknown =>
          rand() < 0.1
            ? pick([null, "x", 3, []])
            : { requirement_id: anyId(), quote: words(), restated: pick(FRAGMENTS), category: pick(CATEGORIES), scope_hint: pick(["plan", "ticket", "project", "x"]), targets: [ticket.id], polarity: pick(["must", "must_not", "?"]) };
        // The adversarial part: a change aimed at every entry the scribe was shown, whatever its category.
        const patch: ScribePatch = {
          adds: Array.from({ length: Math.floor(rand() * 4) }, item),
          raises: Array.from({ length: Math.floor(rand() * 4) }, item),
          supersedes: [
            ...offered.map((id) => ({ requirement_id: id, quote: words(), restated: "改掉", category: pick(CATEGORIES) })),
            ...Array.from({ length: Math.floor(rand() * 3) }, item),
          ],
        };

        const before = new Map(store.listRequirements().map((row) => [row.id, row]));
        const got = store.applyScribePatch({ quote, offered, patch });
        counts.added += got.added.length;
        counts.raised += got.raised.length;
        counts.rejected += got.rejected;
        const after = new Map(store.listRequirements().map((row) => [row.id, row]));
        const context = `seed ${seed}, round ${round}, line 「${body}」`;

        for (const [id, was] of before) {
          const now = after.get(id);
          expect(now, context).toBeDefined();
          expect(now!.times_raised, context).toBeGreaterThanOrEqual(was.times_raised);
          // No exception: whatever the answer, an open entry stays open, and nothing else moves either.
          expect(now!.status, context).toBe(was.status);
          expect(now!.superseded_by, context).toBe(was.superseded_by);
        }
        for (const [id, row] of after) {
          if (before.has(id)) continue;
          // Everything new stands on this line's words, and is open or only proposed.
          expect(row.source_quote_id, context).toBe(quote.id);
          expect(quoteWords(body).includes(quoteWords(row.quote)), context).toBe(true);
          expect(["open", "proposed"], context).toContain(row.status);
          if (row.status === "open") {
            expect(row.supersedes, context).toBeNull();
          } else {
            // A proposal replaces an entry that was open; of another category only when it gives
            // that entry's number anew, which is then its own number.
            const old = before.get(row.supersedes!)!;
            expect(old.status, context).toBe("open");
            const byNumber = old.dimension !== null && row.dimension === old.dimension;
            if (byNumber) {
              const reading = readDimensions(row.quote).filter((value) => value.dimension === old.dimension);
              expect(reading, context).toHaveLength(1);
              const was = { dimension: old.dimension, ...(old.value as object) } as DimensionValue;
              expect(sameDimensionValue(was, reading[0]!), context).toBe(false);
              counts.proposedByNumber += 1;
            } else if (old.category === null || old.category === row.category) {
              counts.proposed += 1;
            } else {
              // Of another category: proposed beside it all the same (2026-10-10), the old entry still open.
              counts.proposedAcross += 1;
            }
          }
          // …and on enough of them, unless they are one number for a dimension (the number is what they
          // say), judged with the line around them exactly as the scribe's check judges it; a new
          // number for an entry's dimension needs no minimum at all.
          if (!(row.status === "proposed" && row.dimension !== null && before.get(row.supersedes!)?.dimension === row.dimension)) {
            expect(quoteTooShort(row.quote, body), context).toBe(false);
          }
        }
      }
      store.close();
    }
    // The runs reach every kind of outcome, numbers proposed against entries of another category among them.
    if (process.env.I9_COUNTS) console.log("I9", JSON.stringify(counts));
    for (const count of Object.values(counts)) expect(count).toBeGreaterThan(0);
    // 1,500 answers, each a write whose plan's board is read back for its event: seconds, not the default five.
  }, 30_000);
});
