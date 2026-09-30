/**
 * Checks from your words, kept (ADR 0040 P3): offered the moment a number of yours is filed, and
 * again, with a count, when you say it again; bound and measured, but a gate only once you confirm
 * it; a gate never changed by itself (a later target is offered beside it); untouched by
 * complaints; bound by name to the final deliverable a Bot delivers.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from ".";
import { checkEnv } from "../acceptance-eval";
import { HttpError } from "../errors";
import { runMeasureCheck } from "../measure-check";
import { CHECKS_MAX } from "./acceptance-checks";
import { resolveFfmpegBins } from "../seams-check";
import type { OrganizerResult } from "./plan-spec";
import type { PlanSpec } from "./plan-shape";

const FFMPEG = resolveFfmpegBins(checkEnv(process.env));

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** 视频导演 in your direct, a workspace to deliver into, and the plan your first line opens. */
function world(first = "做一集 EP01 动画成片，片长约2分钟") {
  const root = mkdtempSync(join(tmpdir(), "derived-checks-"));
  roots.push(root);
  const store = new Store();
  store.patchSettingsSync({ workspace_path: root });
  const { bot, direct_session: direct } = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  /** A line of yours, filed under the plan by the turn it opens. */
  const say = (body: string) => {
    const line = store.postMessage(direct.id, { body });
    const turn = store.createTurn({ sessionId: direct.id, botId: bot.id, triggerMessageId: line.id });
    store.setTurnStatus(turn.id, "completed");
    return { line, turn };
  };
  const { turn } = say(first);
  const planId = turn.task_id!;
  /** 视频导演 delivers a file it made (a real video of `seconds` at `fps` when given): a line of its own under the plan, the file attached. */
  const deliver = (relpath: string, seconds?: number, fps = 1) => {
    mkdirSync(join(root, relpath, ".."), { recursive: true });
    if (seconds === undefined) writeFileSync(join(root, relpath), "video");
    else {
      const args = ["-v", "error", "-f", "lavfi", "-i", `color=c=black:s=16x16:r=${fps}`, "-t", String(seconds), "-c:v", "mpeg4", "-y", join(root, relpath)];
      if (spawnSync(FFMPEG!.ffmpeg, args, { stdio: "ignore" }).status !== 0) throw new Error("ffmpeg failed");
    }
    store.insertMessage({ sessionId: direct.id, turnId: turn.id, kind: "bot", author: bot.id, body: `交了 ${relpath}`, paths: [relpath] });
  };
  /** 视频导演 names a file it delivered before, attached again to a later line (comparing two cuts). */
  const cite = (relpath: string) => {
    store.insertMessage({ sessionId: direct.id, turnId: turn.id, kind: "bot", author: bot.id, body: `和 ${relpath} 比`, paths: [relpath] });
  };
  const derived = () => store.listChecks(planId).filter((check) => check.origin === "derived");
  return { store, root, direct: direct.id, planId, say, deliver, cite, derived };
}

function spec(over: Partial<PlanSpec> = {}): PlanSpec {
  return { kind: "视频", goal: "EP01 动画成片", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active", ...over };
}

function done(): OrganizerResult {
  return { decision: "continue", resumePlanId: null, spec: spec({ status: "done" }), tickets: [], messageTicket: null };
}

const NOTHING = { proposed: [], repeated: [], demoted: [], bound: [], rebound: [], dropped: [], counts: {} };

/** A world where you confirmed 「片长约2分钟」: a gate, and the only way one is made. */
function gated() {
  const w = world();
  w.store.confirmDerivedCheck(w.store.syncDerivedChecks(w.planId).proposed[0]!);
  w.store.syncDerivedChecks(w.planId);
  return w;
}

const held = (w: ReturnType<typeof world>) =>
  w.store.applyOrganizerResult({ sessionId: w.direct, current: w.store.getTask(w.planId), result: done(), source: { messageId: null, turnId: null, messageBody: "" } }).heldByChecks.map((check) => check.id);

describe("offered from your words, never made a gate by them", () => {
  test("a number of yours is offered the moment it is filed; bound to the master, it is measured and still no gate", () => {
    const w = world();
    const change = w.store.syncDerivedChecks(w.planId);
    const [check] = w.derived();
    expect(change).toEqual({ ...NOTHING, proposed: [check!.id], counts: { [check!.id]: 1 } });
    expect(check).toMatchObject({
      origin: "derived",
      source: "user",
      kind: "measure",
      item: "时长约 2 分钟",
      measure: { dimension: "duration", min: 108, max: 132 },
      derived_state: "proposed",
      path: null,
      bind_kind: null,
      last_run: null,
    });
    expect(w.store.listWorkEvents({ kind: "check.derived" }).map((event) => event.payload)).toEqual([
      { check: check!.id, quote: w.store.listQuotes({ taskId: w.planId })[0]!.id, dimension: "duration", measure: { dimension: "duration", min: 108, max: 132 }, change: "proposed" },
    ]);
    w.deliver("plans/ep01/06/EP01_MASTER.mp4");
    expect(w.store.syncDerivedChecks(w.planId)).toEqual({ ...NOTHING, bound: [check!.id] });
    // A failing measure of it is shown, and holds nothing back.
    const run = w.store.beginCheckRun(check!.id, "edit");
    w.store.finishCheckRun(run.id, { outcome: "fail", exitCode: null, detail: "107.00 秒，要时长 108–132 秒", output: null });
    expect(w.store.checkStale(w.planId)).toBe(false);
    expect(held(w)).toEqual([]);
    expect(w.store.syncDerivedChecks(w.planId)).toEqual(NOTHING);
    w.store.close();
  });

  test("said again from another line, the same offer comes back with how many times; saying it however often never makes a gate", () => {
    const w = world();
    const [first] = w.store.syncDerivedChecks(w.planId).proposed;
    const again = w.say("片长 2 分钟左右，别超太多");
    expect(w.store.syncDerivedChecks(w.planId)).toEqual({ ...NOTHING, repeated: [first!], counts: { [first!]: 2 } });
    const quoteOf = (id: string) => w.store.db.query<{ quote_id: string }, [string]>(`SELECT quote_id FROM acceptance_checks WHERE id = ?`).get(id)!.quote_id;
    expect(quoteOf(first!)).toBe(w.store.quoteOfMessage(again.line.id, "message")!.id);
    w.say("片长约 2 分钟");
    expect(w.store.syncDerivedChecks(w.planId)).toMatchObject({ repeated: [first], counts: { [first!]: 3 } });
    expect(w.derived()).toMatchObject([{ id: first, derived_state: "proposed" }]);
    // Saving the same board field again is the same line of yours.
    w.store.setPlanSpecByUser(w.planId, spec({ goal: "EP01 动画成片，片长约 2 分钟" }));
    expect(w.store.syncDerivedChecks(w.planId)).toMatchObject({ repeated: [first], counts: { [first!]: 4 } });
    w.store.setPlanSpecByUser(w.planId, spec({ goal: "EP01 动画成片，片长约 2 分钟。" }));
    w.store.setPlanSpecByUser(w.planId, spec({ goal: "EP01 动画成片，片长约 2 分钟" }));
    expect(w.store.syncDerivedChecks(w.planId).repeated).toEqual([]);
    // A different number replaces the offer.
    w.say("改成 3 分钟");
    const change = w.store.syncDerivedChecks(w.planId);
    expect(change.dropped).toEqual([first]);
    expect(w.derived()).toMatchObject([{ id: change.proposed[0], item: "时长 3 分钟", derived_state: "proposed", measure: { dimension: "duration", min: 162, max: 198 } }]);
    w.store.close();
  });

  test("two lines already saying the same thing make one offer, told it was said twice", () => {
    const w = world("做一集 EP01 动画成片，片长约2分钟");
    w.say("片长两分钟左右");
    const change = w.store.syncDerivedChecks(w.planId);
    expect(change.proposed).toHaveLength(1);
    expect(change.counts[change.proposed[0]!]).toBe(2);
    expect(w.derived().map((check) => check.derived_state)).toEqual(["proposed"]);
    w.store.close();
  });

  test("a running time about one part, a line giving two, or words about nothing measurable offer nothing", () => {
    const w = world("C09 改成 8 秒");
    w.say("镜头 3 太长，总长 3 分钟，其实 4 分钟以内也行");
    w.say("机械臂必须是左手");
    expect(w.store.syncDerivedChecks(w.planId).proposed).toEqual([]);
    w.say("做成竖屏，至少 1080p");
    expect(w.store.syncDerivedChecks(w.planId).proposed).toHaveLength(2);
    expect(w.derived().map((check) => check.measure)).toEqual([
      { dimension: "resolution", min: 1080, max: null },
      { dimension: "aspect", ratio: "portrait" },
    ]);
    w.store.close();
  });
});

describe("only your click makes a gate, and a gate never changes by itself", () => {
  test("confirmed, it is a gate: due a run and holding a plan called done open", () => {
    const w = gated();
    const [gate] = w.derived();
    expect(gate).toMatchObject({ derived_state: "active" });
    w.deliver("plans/ep01/06/EP01_MASTER.mp4");
    w.store.syncDerivedChecks(w.planId);
    expect(w.store.checkStale(w.planId)).toBe(true);
    expect(held(w)).toEqual([gate!.id]);
    w.store.close();
  });

  test("a later, different target is offered in its place, and the gate stays in force meanwhile", () => {
    const w = gated();
    const [gate] = w.derived();
    w.deliver("plans/ep01/06/EP01_MASTER.mp4");
    w.store.syncDerivedChecks(w.planId);
    w.say("片长改成 3 分钟");
    const change = w.store.syncDerivedChecks(w.planId);
    expect(change.proposed).toHaveLength(1);
    expect(w.derived().map((check) => [check.measure, check.derived_state])).toEqual([
      [{ dimension: "duration", min: 108, max: 132 }, "active"],
      [{ dimension: "duration", min: 162, max: 198 }, "proposed"],
    ]);
    expect(held(w)).toEqual([gate!.id]);
    // Said again, the offer comes back; the gate is still the gate.
    w.say("片长 3 分钟");
    expect(w.store.syncDerivedChecks(w.planId)).toMatchObject({ repeated: change.proposed, counts: { [change.proposed[0]!]: 2 } });
    expect(w.derived().map((check) => check.derived_state)).toEqual(["active", "proposed"]);
    // A third number replaces the offer, not the gate; a reading that is no target offers nothing beside it.
    w.say("片长改成 150 秒");
    expect(w.store.syncDerivedChecks(w.planId).dropped).toEqual(change.proposed);
    w.say("约 90 秒");
    expect(w.store.syncDerivedChecks(w.planId)).toEqual(NOTHING);
    expect(w.derived().map((check) => [check.item, check.derived_state])).toEqual([
      ["时长约 2 分钟", "active"],
      ["时长 2 分 30 秒", "proposed"],
    ]);
    w.store.close();
  });

  test("you choose: the new one takes the gate's place, or 不要 keeps the gate and that line does not offer it again", () => {
    const take = gated();
    const [gate] = take.derived();
    take.say("片长改成 3 分钟");
    const offer = take.store.syncDerivedChecks(take.planId).proposed[0]!;
    take.store.confirmDerivedCheck(offer);
    expect(take.store.syncDerivedChecks(take.planId)).toEqual(NOTHING);
    expect(take.derived().map((check) => [check.id, check.derived_state])).toEqual([[offer, "active"]]);
    expect(take.store.listWorkEvents({ kind: "check.confirmed" }).map((event) => event.payload.removed)).toEqual([null, gate!.id]);

    const keep = gated();
    const [kept] = keep.derived();
    keep.say("片长改成 3 分钟");
    keep.store.removeCheckByUser(keep.store.syncDerivedChecks(keep.planId).proposed[0]!);
    expect(keep.store.syncDerivedChecks(keep.planId)).toEqual(NOTHING);
    expect(keep.derived().map((check) => [check.id, check.derived_state])).toEqual([[kept!.id, "active"]]);

    // Your gate's number said again withdraws an offer beside it.
    const back = gated();
    back.say("片长改成 3 分钟");
    const dropped = back.store.syncDerivedChecks(back.planId).proposed[0]!;
    back.say("算了，片长还是约 2 分钟");
    expect(back.store.syncDerivedChecks(back.planId)).toEqual({ ...NOTHING, dropped: [dropped] });
    for (const w of [take, keep, back]) w.store.close();
  });

  test.each([
    ["字幕也要改，片长改成 100 秒", { min: 90, max: 110 }],
    ["另外，片长改成 90 秒", { min: 81, max: 99 }],
    ["also, make it 90 seconds", { min: 81, max: 99 }],
    ["不要额外加片头，片长约 70 秒", { min: 63, max: 77 }],
    ["片长控制在 80 秒以内", { min: null, max: 80 }],
  ] as const)("a clean change is offered beside the gate: %s", (line, measure) => {
    const w = gated();
    w.say(line);
    const change = w.store.syncDerivedChecks(w.planId);
    expect(change.proposed, line).toHaveLength(1);
    expect(w.store.getCheck(change.proposed[0]!).measure).toEqual({ dimension: "duration", ...measure });
    expect(w.derived()[0]!.derived_state).toBe("active");
    w.store.close();
  });
});

describe("complaints never touch a check", () => {
  const COMPLAINTS = [
    "上一版 107 秒太短了",
    "107 秒不行",
    "只有 107 秒",
    "你剪成 107 秒了，太短",
    "你剪成 107 秒，太短",
    "为什么只剪到 107 秒？",
    "怎么剪成 107 秒了",
    "大约 107 秒，画面太暗",
    "现在大概 107 秒",
    "you cut it to 107 seconds, too short",
    "太长了，改成 90 秒",
    "这版太长了，缩短点，80 秒以内就行",
  ];
  const ASIDES = [
    "半小时左右能好吗",
    "预计 30 分钟左右出片",
    "限你3分钟弄完",
    "给我 5 分钟",
    "等 5 分钟再看",
    "渲染要 20 分钟",
    "logo 放在 3 秒",
    "横幅标语改一下",
    "横屏的也做一版，30 秒左右",
    "竖屏的效果不好",
    "60 帧太卡",
  ];

  test("a complaint, a time it takes or a remark leaves the gates, and the offers, as they are", () => {
    const w = world("做一集 EP01 动画成片，片长约2分钟，画幅 9:16，帧率 30");
    for (const id of w.store.syncDerivedChecks(w.planId).proposed) w.store.confirmDerivedCheck(id);
    w.deliver("plans/ep01/06/EP01_MASTER.mp4");
    w.store.syncDerivedChecks(w.planId);
    const before = w.derived().map((check) => [check.id, check.measure, check.derived_state, check.path]);
    expect(before.map(([, , state]) => state)).toEqual(["active", "active", "active"]);
    for (const line of [...COMPLAINTS, ...ASIDES]) {
      w.say(line);
      expect(w.store.syncDerivedChecks(w.planId), line).toEqual(NOTHING);
    }
    expect(w.derived().map((check) => [check.id, check.measure, check.derived_state, check.path])).toEqual(before);
    w.store.close();
  });

  test.skipIf(!FFMPEG)("your complaint about the 107-second master leaves the gate failing it", async () => {
    const w = gated();
    w.deliver("plans/ep01/06/EP01_MASTER.mp4", 107);
    w.store.syncDerivedChecks(w.planId);
    const measure = async () => (await runMeasureCheck(w.root, w.derived()[0]!)).detail;
    expect(await measure()).toBe("107.00 秒，要时长 108–132 秒");
    for (const line of COMPLAINTS) {
      w.say(line);
      expect(w.store.syncDerivedChecks(w.planId), line).toEqual(NOTHING);
    }
    expect(w.derived()).toMatchObject([{ item: "时长约 2 分钟", derived_state: "active", measure: { dimension: "duration", min: 108, max: 132 } }]);
    expect(await measure()).toBe("107.00 秒，要时长 108–132 秒");
    w.store.close();
  });

  test.skipIf(!FFMPEG)("a complaint about a 30 fps master leaves the 60 fps gate failing it", async () => {
    const w = world("做一集 EP01 动画成片，片长约2分钟，帧率 60");
    const fps = () => w.derived().find((check) => check.measure?.dimension === "fps")!;
    w.store.syncDerivedChecks(w.planId);
    w.store.confirmDerivedCheck(fps().id);
    w.deliver("plans/ep01/06/EP01_MASTER.mp4", 120, 30);
    w.store.syncDerivedChecks(w.planId);
    expect(fps().derived_state).toBe("active");
    expect((await runMeasureCheck(w.root, fps())).detail).toBe("30 fps，要帧率 54–66");
    for (const line of ["上一版用 30 帧，太卡了", "用 30 帧太卡了", "exported at 30 fps looks choppy"]) {
      w.say(line);
      expect(w.store.syncDerivedChecks(w.planId), line).toEqual(NOTHING);
    }
    expect((await runMeasureCheck(w.root, fps())).detail).toBe("30 fps，要帧率 54–66");
    w.store.close();
  });

  test.skipIf(!FFMPEG)("a change you confirm is measured on the cut you asked for", async () => {
    const w = gated();
    w.deliver("plans/ep01/06/EP01_MASTER.mp4", 120);
    w.store.syncDerivedChecks(w.planId);
    w.say("另外，片长改成 90 秒");
    const offer = w.store.syncDerivedChecks(w.planId).proposed[0]!;
    w.store.confirmDerivedCheck(offer);
    w.deliver("plans/ep01/06/EP01_MASTER_v2.mp4", 90);
    w.store.syncDerivedChecks(w.planId);
    expect(w.derived()).toMatchObject([{ id: offer, item: "时长 90 秒", derived_state: "active", path: "plans/ep01/06/EP01_MASTER_v2.mp4" }]);
    expect((await runMeasureCheck(w.root, w.derived()[0]!)).outcome).toBe("pass");
    w.store.close();
  });
});

describe("bound to the final deliverable", () => {
  test("the newest master a Bot delivered; a video under deliverables/ only until one is, and never after; never a shot", () => {
    const w = gated();
    const [check] = w.derived();

    w.deliver("assets/render/EP01_cut.mp4");
    expect(w.store.syncDerivedChecks(w.planId).bound).toEqual([]);

    // A shot's file, whatever its folder, is not the film.
    w.deliver("deliverables/shot03.mp4");
    expect(w.store.syncDerivedChecks(w.planId).bound).toEqual([]);
    w.deliver("deliverables/EP01.mp4");
    expect(w.store.syncDerivedChecks(w.planId).bound).toEqual([check!.id]);
    expect(w.derived()[0]).toMatchObject({ path: "deliverables/EP01.mp4", bind_kind: "glob", bind_glob: "deliverables/**" });

    w.deliver("deliverables/EP01_MASTER.mp4");
    w.store.syncDerivedChecks(w.planId);
    expect(w.derived()[0]).toMatchObject({ path: "deliverables/EP01_MASTER.mp4", bind_glob: "*MASTER*" });

    w.deliver("deliverables/EP01_v2.mp4");
    expect(w.store.syncDerivedChecks(w.planId).bound).toEqual([]);

    // A run on the old master does not speak for the new one.
    const run = w.store.beginCheckRun(check!.id, "edit");
    w.store.finishCheckRun(run.id, { outcome: "fail", exitCode: null, detail: "107.00 秒", output: null });
    w.deliver("deliverables/EP01_MASTER_v2.mp4");
    expect(w.store.syncDerivedChecks(w.planId)).toMatchObject({ bound: [check!.id], rebound: [check!.id] });
    expect(w.derived()[0]).toMatchObject({ path: "deliverables/EP01_MASTER_v2.mp4", last_run: null });
    expect(w.store.listWorkEvents({ kind: "check.bound" }).map((event) => event.payload.path)).toEqual([
      "deliverables/EP01.mp4",
      "deliverables/EP01_MASTER.mp4",
      "deliverables/EP01_MASTER_v2.mp4",
    ]);
    // A Bot citing the older cut again (a reviewer comparing the two) does not hand it back.
    w.cite("deliverables/EP01_MASTER.mp4");
    expect(w.store.syncDerivedChecks(w.planId).bound).toEqual([]);
    expect(w.derived()[0]!.path).toBe("deliverables/EP01_MASTER_v2.mp4");
    // A MASTER kept somewhere else does not outrank the one in deliverables/, nor anything from a
    // footage folder.
    w.deliver("elsewhere/EP01_MASTER_v3.mp4");
    w.deliver("footage/interview_master.mov");
    expect(w.store.syncDerivedChecks(w.planId).bound).toEqual([]);

    expect(w.store.checkStale(w.planId)).toBe(true);
    expect(held(w)).toEqual([check!.id]);
    w.store.close();
  });

  test("a check offered after the delivery is bound in the same step", () => {
    const w = world("先出个样片");
    w.deliver("out/EP01_final.mp4");
    w.say("成片画幅 16:9");
    const change = w.store.syncDerivedChecks(w.planId);
    expect(change.proposed).toHaveLength(1);
    expect(change.bound).toEqual(change.proposed);
    expect(w.derived()[0]).toMatchObject({ path: "out/EP01_final.mp4", bind_glob: "*final*", derived_state: "proposed" });
    w.store.close();
  });
});

describe("yours to confirm or remove, not anyone's to rewrite", () => {
  test("a check you removed is not offered again from what you had said; saying it again offers it again", () => {
    const w = world();
    w.store.syncDerivedChecks(w.planId);
    w.store.removeCheckByUser(w.derived()[0]!.id);
    expect(w.store.syncDerivedChecks(w.planId)).toEqual(NOTHING);
    w.say("改成 90 秒以内");
    expect(w.store.syncDerivedChecks(w.planId).proposed).toHaveLength(1);
    expect(w.derived()[0]!.measure).toEqual({ dimension: "duration", min: null, max: 90 });
    w.say("片长约 2 分钟");
    const change = w.store.syncDerivedChecks(w.planId);
    // Counted from after the removal: once.
    expect(change.counts[change.proposed[0]!]).toBe(1);
    expect(w.derived().map((check) => [check.measure, check.derived_state])).toEqual([[{ dimension: "duration", min: 108, max: 132 }, "proposed"]]);
    w.store.close();
  });

  test("words erased take an offer with them; said again, it comes back", () => {
    const w = world();
    const [offer] = w.store.syncDerivedChecks(w.planId).proposed;
    // Something else of yours keeps the plan when the conversation's words go.
    w.store.addRequirement({ scope: "plan", scopeId: w.planId, quote: "机械臂是左手", sourceKind: "board", addedBy: "user" });
    w.store.clearSessionMessages(w.direct, { eraseQuotes: true });
    expect(w.store.syncDerivedChecks(w.planId).dropped).toEqual([offer]);
    expect(w.derived()).toEqual([]);
    const line = w.store.postMessage(w.direct, { body: "片长约2分钟" });
    w.store.db.run(`UPDATE messages SET task_id = ? WHERE id = ?`, [w.planId, line.id]);
    expect(w.store.syncDerivedChecks(w.planId).proposed).toHaveLength(1);
    w.store.close();
  });

  test("a gate stands on the words you confirmed it on: a later line erased changes nothing, those words erased make it an offer again", () => {
    const w = gated();
    const [gate] = w.derived();
    const later = w.say("片长 2 分钟左右");
    w.store.syncDerivedChecks(w.planId);
    const erase = (quoteId: string) => w.store.db.run(`UPDATE user_quotes SET body = '', redacted_at = ? WHERE id = ?`, [new Date().toISOString(), quoteId]);
    erase(w.store.quoteOfMessage(later.line.id, "message")!.id);
    expect(w.store.syncDerivedChecks(w.planId)).toEqual(NOTHING);
    expect(w.derived()).toMatchObject([{ id: gate!.id, derived_state: "active" }]);
    erase(w.store.listQuotes({ taskId: w.planId })[0]!.id);
    expect(w.store.syncDerivedChecks(w.planId)).toEqual({ ...NOTHING, demoted: [gate!.id] });
    // Never quietly deleted: an offer until you act on it.
    expect(w.store.syncDerivedChecks(w.planId)).toEqual(NOTHING);
    expect(w.derived()).toMatchObject([{ id: gate!.id, derived_state: "proposed" }]);
    w.store.close();
  });

  test("it takes no room from the checks a plan may hold, and a full plan still gets it", () => {
    const w = world();
    w.store.syncDerivedChecks(w.planId);
    for (let i = 0; i < CHECKS_MAX; i++) w.store.createCheckByUser(w.planId, { item: `第 ${i} 条`, kind: "exists", path: `f${i}.md` });
    let refused: unknown = null;
    try {
      w.store.createCheckByUser(w.planId, { item: "超额", kind: "exists", path: "over.md" });
    } catch (error) {
      refused = error;
    }
    expect((refused as HttpError).code).toBe("too_many_checks");
    w.say("做成竖屏");
    expect(w.store.syncDerivedChecks(w.planId).proposed).toHaveLength(1);
    expect(w.store.listChecks(w.planId)).toHaveLength(CHECKS_MAX + 2);
    w.store.close();
  });

  test("its number changes only by your words: the board's editor refuses it, and confirm takes only one of these", () => {
    const w = world();
    w.store.syncDerivedChecks(w.planId);
    const code = (run: () => unknown): string | null => {
      try {
        run();
        return null;
      } catch (error) {
        return error instanceof HttpError ? error.code : String(error);
      }
    };
    expect(code(() => w.store.patchCheckByUser(w.derived()[0]!.id, { item: "别的" }))).toBe("derived_check");
    const typed = w.store.createCheckByUser(w.planId, { item: "交到 report.md", kind: "exists", path: "report.md" });
    expect(code(() => w.store.confirmDerivedCheck(typed.id))).toBe("invalid_args");
    const [offer] = w.derived();
    w.store.removeCheckByUser(offer!.id);
    expect(code(() => w.store.confirmDerivedCheck(offer!.id))).toBe("check_gone");
    w.store.close();
  });
});
