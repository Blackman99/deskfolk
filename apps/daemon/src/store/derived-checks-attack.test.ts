/**
 * Checks from your words against lines built to make a wrong gate (ADR 0040 P3). Two rounds of an
 * independent attacker found that any rule letting your words alone make a gate — "said twice" —
 * is beaten by a sentence pattern misread the same way twice. So nothing but your click makes a gate
 * now: a reading only ever makes or refreshes a card, and a gate never changes by itself. These are
 * the attackers' scenarios with what the app does now; a card where a reading is plausible is fine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from ".";
import { bindRuleOf, derivedStatements } from "../derived-checks";
import type { PlanSpec } from "./plan-shape";
import type { OrganizerResult } from "./plan-spec";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** 视频导演 in your direct, the plan your first line opens, and what its checks from your words are. */
function world(first: string) {
  const root = mkdtempSync(join(tmpdir(), "derived-attack-"));
  roots.push(root);
  const store = new Store();
  store.patchSettingsSync({ workspace_path: root });
  const { bot, direct_session: direct } = store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
  const say = (body: string) => {
    const line = store.postMessage(direct.id, { body });
    const turn = store.createTurn({ sessionId: direct.id, botId: bot.id, triggerMessageId: line.id });
    store.setTurnStatus(turn.id, "completed");
    return { turn, line };
  };
  const { turn } = say(first);
  const planId = turn.task_id!;
  const deliver = (relpath: string, ticketId?: string) => {
    mkdirSync(join(root, relpath, ".."), { recursive: true });
    writeFileSync(join(root, relpath), "video");
    const line = store.insertMessage({ sessionId: direct.id, turnId: turn.id, kind: "bot", author: bot.id, body: `交了 ${relpath}`, paths: [relpath] });
    if (ticketId) store.db.run(`UPDATE messages SET ticket_id = ? WHERE id = ?`, [ticketId, line.id]);
  };
  const ticket = (title: string) => {
    store.applyOrganizerResult({
      sessionId: direct.id,
      current: store.getTask(planId),
      result: { decision: "continue", resumePlanId: null, spec: spec(), tickets: [{ id: "new-1", title, spec: title }], messageTicket: null } as OrganizerResult,
      source: { messageId: null, turnId: null, messageBody: "" },
    });
    return store.listTickets(planId).find((row) => row.title === title)!;
  };
  const derived = () => store.listChecks(planId).filter((check) => check.origin === "derived");
  const sync = () => store.syncDerivedChecks(planId);
  /** Each live check: what it says, where it stands, and the file it measures. */
  const live = () => derived().map((check) => `${check.item}|${check.derived_state}${check.path ? `@${check.path}` : ""}`);
  const active = () => derived().filter((check) => check.derived_state === "active").map((check) => check.item);
  return { store, direct: direct.id, planId, say, deliver, ticket, derived, sync, live, active };
}

function spec(over: Partial<PlanSpec> = {}): PlanSpec {
  return { kind: "视频", goal: "宣传片", acceptance: [], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: "active", ...over };
}

/** You confirmed 「片长约2分钟」: a gate. */
function gated(first = "做一集 EP01 动画成片，片长约2分钟") {
  const w = world(first);
  w.store.confirmDerivedCheck(w.sync().proposed[0]!);
  w.sync();
  return w;
}

/** Your first line, then each line of the attack, synced after each; what is in force and what is live. */
function run(first: string, lines: readonly string[]) {
  const w = world(first);
  w.sync();
  for (const line of lines) {
    w.say(line);
    w.sync();
  }
  const out = { active: w.active(), live: w.live() };
  w.store.close();
  return out;
}

describe("no gate from your words alone, however often a misread line is said", () => {
  // The second attacker's thirty-one runs: each pattern said twice.
  test.each([
    ["G1 footage total", "做一支宣传片，片长约 2 分钟", ["素材都传网盘了，总时长大概 20 分钟", "素材又补了一些，总长还是 20 分钟左右"]],
    ["G2 reference", "做一支宣传片", ["参考苹果那支广告，它的片长约 90 秒", "苹果那支我又看了一遍，片长 90 秒左右"]],
    ["G3 past project", "做一支宣传片，要 2 分钟", ["上个项目片长约 90 秒，这个要 2 分钟", "上次那个项目片长约 90 秒，节奏挺好"]],
    ["G3b competitor", "做一支宣传片，我们做 30 秒", ["竞品那支片长约 60 秒，我们做 30 秒", "友商那支广告片长约 60 秒"]],
    ["G4 不要剪成", "做一支宣传片，要 2 分钟", ["不要剪成 90 秒", "千万别剪成 90 秒那种"]],
    ["G4b 别压到…以下", "做一支宣传片", ["片长别压到 60 秒以下", "片长不要剪到 1 分钟以下"]],
    ["G5 分屏比例", "做一支横屏宣传片", ["左右分屏，比例 1:1", "分屏比例 1:1，左边产品右边人"]],
    ["G5b 像素宽高比", "做一支 16:9 的宣传片", ["导出设置：像素宽高比 1:1", "记得像素宽高比 1:1（方形像素）"]],
    ["G5c 男女比例", "做一支宣传片", ["群演男女比例 1:1", "演员男女比例 1:1 就行"]],
    ["G6 画幅 16:9 改成竖屏", "做一支宣传片", ["画幅 16:9 改成竖屏", "画幅别用 16:9 了，改成竖屏"]],
    ["G6b 帧率 24 改成 60", "做一支宣传片", ["帧率 24 改成 60", "帧率 24 改 60，要丝滑"]],
    ["G6c 分辨率从 4K 降到 1080", "做一支宣传片", ["分辨率从 4K 降到 1080", "分辨率 4K 压到 1080，文件太大"]],
    ["G7 这段剪成", "做一支宣传片，约 2 分钟", ["把这段剪成 20 秒", "把老板讲话那段剪成 20 秒"]],
    ["G7b 采访", "做一支宣传片，约 2 分钟", ["把采访剪成 30 秒左右", "中间那段访谈剪成 30 秒左右"]],
    ["G8 C09，时长", "做一集 EP01 动画成片，片长约2分钟", ["C09 这个镜头，时长 8 秒", "C09，时长还是 8 秒"]],
    ["G9 预算 2k", "做一支 4K 宣传片", ["预算控制在 2k 以内", "预算还是控制在 2k 以内"]],
    ["G9b 报价 4k", "做一支 1080p 宣传片", ["报价压到 4k", "稿费压到 4k"]],
    ["G10 分辨率最低 1080p", "做一支宣传片", ["分辨率最低 1080p", "分辨率 1080p 打底"]],
    ["G10b 片长最长 90 秒", "做一支宣传片", ["片长最长 90 秒", "片长上限 90 秒"]],
    ["G11 客户说", "做一支宣传片", ["客户说片长要 90 秒，我不同意，按 2 分钟做", "客户坚持片长 90 秒，但别听他的，做 2 分钟"]],
    ["G12 朋友圈那条", "做一支宣传片，片长约 2 分钟", ["朋友圈那条剪成 15 秒", "给朋友圈的剪成 15 秒"]],
    ["G12b 横屏版", "做一支竖屏宣传片，30 秒左右", ["横屏版片长约 2 分钟", "横屏版片长 2 分钟左右"]],
    ["G13 打分", "做一支宣传片，约 2 分钟", ["打分：时长 8 分，画面 7 分", "时长 8 分，节奏 6 分"]],
    ["G14 帧率 24 或 30", "做一支宣传片", ["帧率 24 或 30", "帧率 24/30 都行"]],
    ["G15 粗剪", "做一支宣传片，精剪 2 分钟", ["粗剪先控制在 5 分钟左右", "粗剪时长约 5 分钟"]],
    ["G16 游戏帧率", "录一段游戏实况，成片 30fps", ["游戏帧率 60", "录的游戏帧率是 60"]],
    ["G16b 原画帧率", "做一集 EP01 动画成片，24 帧每秒", ["原画帧率 12，一拍二", "作画帧率 12"]],
    ["G17 配图/壁纸", "做一支横屏宣传片", ["壁纸做成 9:16 竖屏", "预览图做成 9:16 竖屏"]],
    ["G17b 手机界面", "做一支横屏宣传片", ["画面里的手机做成竖屏", "手机界面做成竖屏"]],
    ["G18 发布会", "把发布会剪成 3 分钟集锦", ["发布会全长 2 小时左右，你挑重点", "这个发布会总长约 2 小时"]],
    ["G19 90s 那种感觉", "做一支 MV，片长约 3 分钟", ["做成 90s 那种感觉", "调成 90s 日系"]],
    // The first attacker's twenty, the ones that made gates by saying something twice.
    ["S1 describing the cut", "做一集 EP01 动画成片，片长约2分钟", ["你交的片子差不多 107 秒，我看一下", "片子差不多 107 秒，节奏再紧一点"]],
    ["S2 短了 / 有点短", "做一集 EP01 动画成片，片长约2分钟", ["107 秒左右，短了", "差不多 107 秒，有点短"]],
    ["S3 拍的", "做一支宣传片，1080p，30 帧", ["我拍的是 4K 25 帧", "都是 4K 25 帧拍的"]],
    ["S4 frame counts", "做一支宣传片，30 帧", ["结尾淡出 24 帧", "转场叠化也用 24 帧"]],
    ["S5 90s 港风", "做一支 MV，片长约 3 分钟", ["做成 90s 港风", "整体调成 90s 色调"]],
    ["S6 logo", "做个产品视频，片长约 1 分钟", ["logo 在 5 秒左右出现", "记得 logo 在 5 秒左右出现"]],
    ["S6b 开头", "做个产品视频，片长约 1 分钟", ["开头控制在 5 秒以内", "开头还是控制在 5 秒以内"]],
    ["S15 ffprobe", "做一支宣传片，30 帧", ["ffprobe 显示 1920x1080 25fps", "ffprobe: 1920x1080, 25 fps"]],
    ["S16 比分", "做个比赛集锦，横屏 16:9", ["片尾打上比分 2:1", "比分 2:1 要大一点"]],
    ["S18 竖版", "做一支横屏宣传片，画幅 16:9", ["竖版的也要，9:16", "竖版 9:16 的也要"]],
    ["S19 抖音版", "做一支宣传片，片长约 2 分钟", ["抖音版 30 秒左右", "抖音版控制在 30 秒左右"]],
    // Even your own number, said as a target twice, is only a card until you confirm it.
    ["your own number twice", "做一集 EP01 动画成片，片长约2分钟", ["片长 2 分钟左右，别超太多"]],
  ] as const)("%s", (_name, first, lines) => {
    expect(run(first, lines).active).toEqual([]);
  });

  test("the cheap fixes leave fewer wrong cards: a no before a setting word, from X to Y, money, scores, rough cuts, stills and song lengths read nothing", () => {
    for (const [first, lines] of [
      ["做一支宣传片", ["不要剪成 90 秒", "片长别压到 60 秒以下"]],
      ["做一支宣传片", ["帧率 24 改成 60", "分辨率从 4K 降到 1080", "帧率 24 或 30"]],
      ["做一支宣传片", ["预算控制在 2k 以内", "报价压到 4k"]],
      ["做一支宣传片", ["打分：时长 8 分，画面 7 分", "时长 8 分，节奏 6 分"]],
      ["做一支宣传片", ["粗剪先控制在 5 分钟左右", "粗剪时长约 5 分钟"]],
      ["做一支宣传片", ["壁纸做成 9:16 竖屏", "手机界面做成竖屏"]],
      ["做一支宣传片", ["用那首歌，时长 3 分 20 秒", "做成 90s 那种感觉", "C09 这个镜头，时长 8 秒", "横屏版片长约 2 分钟"]],
    ] as const) {
      expect(run(first, lines).live, lines.join(" / ")).toEqual([]);
    }
    // The bound words it lacked.
    expect(run("做一支宣传片", ["分辨率最低 1080p"]).live).toEqual(["分辨率至少 1080p|proposed"]);
    expect(run("做一支宣传片", ["片长最长 90 秒"]).live).toEqual(["时长不超过 90 秒|proposed"]);
    expect(run("做一支宣传片", ["分辨率 1080p 打底"]).live).toEqual(["分辨率至少 1080p|proposed"]);
  });
});

describe("a gate you confirmed never changes by itself", () => {
  test("misread lines leave it in force; a real change is offered beside it", () => {
    const w = gated();
    for (const line of [
      "素材传好了，总时长大概 20 分钟",
      "参考苹果那支广告，它的片长约 90 秒",
      "不要剪成 90 秒",
      "C09 这个镜头，时长 8 秒",
      "把老板讲话那段剪成 20 秒",
      "时长 8 分，节奏 6 分",
      "粗剪先控制在 5 分钟左右",
      "朋友圈那条剪成 15 秒",
      "用那首歌，时长 3 分 20 秒",
      "片子差不多 107 秒，节奏再紧一点",
    ]) {
      w.say(line);
      w.sync();
      expect(w.active(), line).toEqual(["时长约 2 分钟"]);
    }
    w.say("片长改成 90 秒");
    w.sync();
    expect(w.live()).toEqual(["时长约 2 分钟|active", "时长 90 秒|proposed"]);
    w.say("片长 90 秒");
    w.sync();
    expect(w.live()).toEqual(["时长约 2 分钟|active", "时长 90 秒|proposed"]);
    w.store.close();
  });

  test("S7 / S8 board edits quote only what you changed, never the organizer's words you kept", () => {
    const w = world("帮我做个宣传片");
    w.store.applyOrganizerResult({
      sessionId: w.direct,
      current: w.store.getTask(w.planId),
      result: { decision: "continue", resumePlanId: null, spec: spec({ goal: "剪一支约 60 秒的宣传片" }), tickets: [{ id: "new-1", title: "剪辑", spec: "把素材剪成约 60 秒" }], messageTicket: null } as OrganizerResult,
      source: { messageId: null, turnId: null, messageBody: "" },
    });
    w.store.setPlanSpecByUser(w.planId, spec({ goal: "剪一支约 60 秒的宣传片，加字幕" }));
    w.store.setPlanSpecByUser(w.planId, spec({ goal: "剪一支约 60 秒的宣传片，加中英字幕" }));
    const [ticket] = w.store.listTickets(w.planId);
    w.store.patchTicketByUser(ticket!.id, { spec: "把素材剪成约 60 秒，注意节奏" });
    w.sync();
    expect(w.live()).toEqual([]);
    expect(w.store.listQuotes({ taskId: w.planId }).filter((quote) => quote.via === "board").map((quote) => quote.body)).toEqual(["加字幕", "加中英字幕", "注意节奏"]);
    w.store.close();
  });

  test("S9 / S9b removing a gate, or turning down its replacement, brings back no older number", () => {
    const w = gated("做一集 EP01，片长约 90 秒");
    w.say("片长改成约 2 分钟");
    const offer = w.sync().proposed[0]!;
    w.store.confirmDerivedCheck(offer);
    w.sync();
    w.store.removeCheckByUser(offer);
    w.sync();
    expect(w.live()).toEqual([]);

    const v = gated();
    v.say("片长改成 150 秒");
    v.sync();
    v.say("片长改成 90 秒");
    v.store.removeCheckByUser(v.sync().proposed[0]!);
    v.sync();
    expect(v.live()).toEqual(["时长约 2 分钟|active"]);
    w.store.close();
    v.store.close();
  });

  test("S10 / S11 a later number, even one inside the tolerance, is offered beside the gate; two near numbers are two offers in turn", () => {
    const w = world("做一集 EP01，片长约2分钟");
    w.sync();
    w.say("片长改成 90 秒");
    w.store.confirmDerivedCheck(w.sync().proposed[0]!);
    w.sync();
    w.say("片长 2 分钟左右");
    w.sync();
    // The 「约2分钟」 said before your confirm is one you chose against: counted once, not twice.
    expect(w.live()).toEqual(["时长 90 秒|active", "时长约 2 分钟|proposed"]);

    const v = gated();
    v.say("片长改成 130 秒");
    v.sync();
    expect(v.derived().map((check) => [check.measure, check.derived_state])).toEqual([
      [{ dimension: "duration", min: 108, max: 132 }, "active"],
      [{ dimension: "duration", min: 117, max: 143 }, "proposed"],
    ]);
    w.store.close();
    v.store.close();
  });

  test("S17 refiling your line elsewhere never takes away a check you confirmed; erasing those words makes it an offer again", () => {
    const w = world("做一集 EP01，片长约2分钟");
    const offer = w.sync().proposed[0]!;
    w.store.confirmDerivedCheck(offer);
    const [quote] = w.store.listQuotes({ taskId: w.planId });
    w.store.db.run(`UPDATE messages SET task_id = NULL WHERE id = ?`, [quote!.message_id!]);
    expect(w.sync().dropped).toEqual([]);
    expect(w.live()).toEqual(["时长约 2 分钟|active"]);
    w.store.db.run(`UPDATE user_quotes SET body = '', redacted_at = ? WHERE id = ?`, [new Date().toISOString(), quote!.id]);
    expect(w.sync().demoted).toEqual([offer]);
    expect(w.live()).toEqual(["时长约 2 分钟|proposed"]);
    w.store.close();
  });
});

describe("the final deliverable", () => {
  test("names of a part, another version or format, a draft, and footage or reference folders never bind", () => {
    for (const path of [
      "plans/ep01/EP01_MASTER_9x16.mp4",
      "plans/ep01/EP01_MASTER_vertical.mp4",
      "plans/ep01/EP01_douyin_MASTER.mp4",
      "plans/ep01/EP01_trailer_MASTER.mp4",
      "plans/ep01/EP01_teaser_final.mp4",
      "plans/ep01/EP01_片头_MASTER.mp4",
      "plans/ep01/intro_MASTER.mp4",
      "plans/ep01/OP_final.mp4",
      "plans/ep01/logo_sting_final.mp4",
      "plans/ep01/EP01_MASTER_720p_preview.mp4",
      "plans/ep01/EP01_MASTER_proxy.mp4",
      "footage/interview_master.mov",
      "ref/Nike_final.mp4",
      "plans/ep01/EP01_30s_MASTER.mp4",
      "plans/ep01/EP01_MASTER_竖版.mp4",
      "plans/ep01/EP01_母带_抖音.mp4",
      "deliverables/logo_sting.mp4",
      "deliverables/EP01_vertical.mp4",
      "shots/C09_final.mp4",
      "shots/master_shot_03.mp4",
    ]) {
      expect(bindRuleOf(path), path).toBeNull();
    }
    for (const path of ["plans/ep01/E01_MASTER.mp4", "plans/ep01/EP01_MASTER_R2.mp4", "plans/ep01/EP01-MASTER-v2.mp4", "plans/ep01/EP01.MASTER.mp4"]) {
      expect(bindRuleOf(path), path).toEqual({ glob: "*MASTER*", rank: 0 });
    }
  });

  test("B1–B7 the master keeps the check: a vertical, an intro, a preview, another version's ticket, footage, a reference", () => {
    const cases: Array<[string, (w: ReturnType<typeof world>) => void, string | null]> = [
      ["B1", (w) => w.deliver("plans/ep01/EP01_MASTER_9x16_30s.mp4"), "plans/ep01/EP01_MASTER.mp4"],
      ["B2", (w) => w.deliver("plans/ep01/EP01_片头_MASTER.mp4"), "plans/ep01/EP01_MASTER.mp4"],
      ["B4", (w) => w.deliver("plans/ep01/EP01_MASTER_720p_preview.mp4"), "plans/ep01/EP01_MASTER.mp4"],
      ["B5", (w) => w.deliver("plans/ep01/EP01_MASTER_v3.mp4", w.ticket("抖音版剪辑").id), "plans/ep01/EP01_MASTER.mp4"],
      ["B7", (w) => w.deliver("plans/ep01/EP01_OP_MASTER.mp4", w.ticket("片头成片").id), "plans/ep01/EP01_MASTER.mp4"],
      ["C10", (w) => w.deliver("plans/ep01/EP01_MASTER_v2.mp4", w.ticket("C10 重剪").id), "plans/ep01/EP01_MASTER.mp4"],
    ];
    for (const [name, after, path] of cases) {
      const w = gated();
      w.deliver("plans/ep01/EP01_MASTER.mp4");
      w.sync();
      after(w);
      w.sync();
      expect(w.derived()[0]!.path, name).toBe(path);
      w.store.close();
    }
    const footage = gated();
    footage.deliver("plans/ep01/EP01_final.mp4");
    footage.sync();
    footage.deliver("footage/interview_master.mov");
    footage.sync();
    expect(footage.derived()[0]!.path).toBe("plans/ep01/EP01_final.mp4");
    footage.store.close();
    const reference = gated();
    reference.deliver("ref/Nike_final.mp4");
    reference.sync();
    expect(reference.derived()[0]!.path).toBeNull();
    reference.store.close();
  });
});

describe("what a target is", () => {
  test("a number set for the deliverable by its dimension word or a setting verb; the rest are cards at most", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const target = (body: string) => [...derivedStatements([{ id: "q", body, via: "message", source: "q", at, aboutPart: false }]).values()].flat().map((statement) => statement.target);
    for (const line of ["片长约 2 分钟", "成片时长 90 秒左右", "分辨率 1080p", "帧率改成 30", "画幅 9:16", "比例改成 16:9", "剪成 90 秒发给我", "控制在 2 分钟以内", "做成竖屏", "running time about 2 minutes", "make it 90 seconds"]) {
      expect(target(line), line).toEqual([true]);
    }
    for (const line of ["片子差不多 107 秒，节奏再紧一点", "约 90 秒", "不要超过 2 分钟", "1080p 就行", "要竖屏", "每秒 30 帧", "把素材剪成 90 秒左右", "素材 20 分钟，剪成 90 秒"]) {
      expect(target(line), line).toEqual([false]);
    }
  });

  test("an annotation, a line on a part's ticket or one naming a part gives no dimension for the master", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const of = (body: string, extra: { via?: "annotation" | "message"; aboutPart?: boolean } = {}) =>
      derivedStatements([{ id: "q", body, via: extra.via ?? "message", source: "q", at, aboutPart: extra.aboutPart ?? false }]);
    expect(of("这里升格成 60 帧", { via: "annotation", aboutPart: true }).size).toBe(0);
    expect(of("这里帧率改成 60", { via: "annotation" }).size).toBe(0);
    expect(of("C09 做成竖屏", { aboutPart: true }).size).toBe(0);
    expect(of("C09 做成竖屏").size).toBe(0);
    expect(of("片头做成竖屏").size).toBe(0);
  });
});
