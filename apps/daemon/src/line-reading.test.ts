/**
 * 读句 (ADR 0055): what a model's answer must be before anything acts on it, and the word lists'
 * reading the app falls back to when no model can read a line. Where a line belongs (ADR 0057) has
 * no word lists behind it: its answer is checked against the refs the reading was shown.
 */
import { expect, test } from "bun:test";
import { botLineByWords, checkBotReading, checkFilingReading, checkUserReading, readsAsNoWork, userLineByWords, type FilingRefs } from "./line-reading";
import { parseBotLineAnswer, parseUserLineAnswer } from "./prompts/reader";

test("a reading of your line keeps each objection as the line's own words, however the model copied them", () => {
  const body = "这版节奏拖沓，整个推掉吧。片头那段还行";
  const reading = checkUserReading({ control: "none", control_only: false, status_only: false, objections: ["这版节奏拖沓", "整个 推掉吧"] }, body);
  expect(reading).toEqual({ source: "model", control: "none", controlOnly: false, statusOnly: false, objections: ["这版节奏拖沓", "整个推掉吧"] });
});

test("an objection that is not in the line is dropped; when none is, the line stands as the one objection", () => {
  const body = "这版节奏拖沓，整个推掉吧";
  expect(checkUserReading({ control: "none", objections: ["这版节奏拖沓", "颜色太暗"] }, body)!.objections).toEqual(["这版节奏拖沓"]);
  expect(checkUserReading({ control: "none", objections: ["颜色太暗"] }, body)!.objections).toEqual([body]);
  expect(checkUserReading({ control: "none", objections: [] }, body)!.objections).toEqual([]);
});

test("a reading of your line needs one of the four controls; control_only means nothing beside none", () => {
  expect(checkUserReading({ control: "halt" }, "停")).toBeNull();
  expect(checkUserReading({ objections: [] }, "停")).toBeNull();
  expect(checkUserReading({ control: "none", control_only: true }, "好的")!.controlOnly).toBe(false);
  expect(checkUserReading({ control: "stop", control_only: true }, "先别搞了")!).toMatchObject({ control: "stop", controlOnly: true });
  // Anything but a literal true is false.
  expect(checkUserReading({ control: "stop", control_only: "yes", status_only: 1 }, "先别搞了")!).toMatchObject({ controlOnly: false, statusOnly: false });
});

test("a Bot's promise is kept as the sentence of its line; one the line does not hold falls back to the lists' sentence, else the line", () => {
  const body = "收到。我这边着手整理第二集的分镜脚本，弄好发群里。";
  expect(checkBotReading({ later: "我这边着手整理第二集的分镜脚本，弄好发群里", claims_verified: false, no_work: false, bare_status: false }, body))
    .toEqual({ source: "model", later: "我这边着手整理第二集的分镜脚本，弄好发群里", claimsVerified: false, noWork: false, bareStatus: false, goAhead: false });
  expect(checkBotReading({ later: "稍后发你" }, "初稿先放这。结论随后。")!.later).toBe("结论随后。");
  expect(checkBotReading({ later: "稍后发你" }, body)!.later).toBe(body);
  expect(checkBotReading({ later: null, claims_verified: true }, "测试跑过了")!).toMatchObject({ later: null, claimsVerified: true });
  expect(checkBotReading({ verdict: "fine" }, body)).toBeNull();
});

test("a question that only asks for an OK to go on reads as a go-ahead only when a model says so (ADR 0058)", () => {
  const asked = "请确认《一拳超人》关键帧板（board.jpg）与设定集是否符合预期，确认后将正式启动视频片段生成与后期剪辑。";
  expect(checkBotReading({ later: null, go_ahead: true }, asked)!.goAhead).toBe(true);
  expect(checkBotReading({ go_ahead: "yes" }, asked)!.goAhead).toBe(false);
  // An answer that says nothing of it is still a reading; the word lists never read a go-ahead.
  expect(checkBotReading({ later: null, bare_status: false }, asked)!.goAhead).toBe(false);
  expect(botLineByWords(asked).goAhead).toBe(false);
});

test("a promise that repeats the line the Bot answers is that line's, not the Bot's; a phrase both use is still the Bot's", () => {
  // 2026-10-08: your English paragraph put back above its translation, and a model took its last sentence for the Bot's.
  const source = "The X search is done. The community-site search is still running. Once it's back, I'll compare the two and pick one to build.";
  const body = `**${source}**\n\n推荐译法：X 上的调研已经跑完了。社区站点的调研还在跑，等结果出来后，我会对比两边的数据。`;
  const quoted = { later: "The community-site search is still running. Once it's back, I'll compare the two and pick one to build.", claims_verified: false, no_work: false, bare_status: false };
  expect(checkBotReading(quoted, body)!.later).toBe("The community-site search is still running. Once it's back, …");
  expect(checkBotReading(quoted, body, source)!.later).toBeNull();
  // The word lists hear "I'll get back" in it; repeated from the line answered, it is not the Bot's either.
  const asked = "The community-site search is still running; I'll get back to you once it's back.";
  expect(botLineByWords(`${asked}\n\n译文：社区站点的搜索还在跑，等它出来我再回你。`).later).not.toBeNull();
  expect(botLineByWords(`${asked}\n\n译文：社区站点的搜索还在跑，等它出来我再回你。`, asked).later).toBeNull();
  // A few words in common are no quote: 「结论随后」 from your line is still the Bot's promise when it says it.
  expect(checkBotReading({ later: "结论随后" }, "收到，结论随后。", "你先查，结论随后发我")!.later).toBe("结论随后");
  expect(botLineByWords("收到，结论随后。", "你先查，结论随后发我").later).toBe("收到，结论随后。");
});

test("a long promise is cut to what a bounce quotes", () => {
  const body = `正在${"逐镜核对".repeat(30)}。`;
  const later = checkBotReading({ later: body }, body)!.later!;
  expect([...later].length).toBe(61);
  expect(later.endsWith("…")).toBe(true);
});

test("an answer is read out of prose around it, and anything else is no reading", () => {
  expect(parseUserLineAnswer('好的：{"control": "stop", "control_only": true, "status_only": false, "objections": []}', "收手吧")!.control).toBe("stop");
  expect(parseUserLineAnswer("stop", "收手吧")).toBeNull();
  expect(parseBotLineAnswer('```json\n{"later": null, "claims_verified": false, "no_work": true, "bare_status": false}\n```', "本轮无事")!.noWork).toBe(true);
  expect(parseBotLineAnswer("", "本轮无事")).toBeNull();
});

test("the word lists' readings: control is left to the rules, the rest as the lists always read it", () => {
  expect(userLineByWords("C07 太假了，重做", { statusQuestion: false })).toEqual({
    source: "words", control: null, controlOnly: false, statusOnly: false, objections: ["C07 太假了", "重做"],
  });
  expect(userLineByWords("怎么样了", { statusQuestion: true }).statusOnly).toBe(true);
  expect(botLineByWords("正在逐对核验 18 张起止帧，结论随后。")).toMatchObject({ source: "words", later: "正在逐对核验 18 张起止帧，结论随后。" });
  expect(botLineByWords("测试全部通过")).toMatchObject({ claimsVerified: true });
  expect(botLineByWords("本轮无新工作。")).toMatchObject({ noWork: true });
  expect(botLineByWords("好的")).toMatchObject({ bareStatus: true });
});

test("a line that cannot be a no-work closer by its shape costs no reading", async () => {
  const asked: string[] = [];
  const read = async (body: string) => {
    asked.push(body);
    return { ...botLineByWords(body), source: "model" as const, noWork: true };
  };
  expect(await readsAsNoWork("   ", read)).toBe(true);
  expect(await readsAsNoWork("@审片员 看一下这个", read)).toBe(false);
  expect(await readsAsNoWork("要不要先改片头？", read)).toBe(false);
  expect(await readsAsNoWork("写好了：drafts/ep01.md", read)).toBe(false);
  expect(asked).toEqual([]);
  expect(await readsAsNoWork("这轮我就不说了", read)).toBe(true);
  expect(asked).toEqual(["这轮我就不说了"]);
});

const REFS: FilingRefs = [
  { ref: "J1", taskId: "film", tickets: [{ ref: "T1", ticketId: "shots", parts: ["shot_01", "shot_02", "shot_03"] }, { ref: "T2", ticketId: "music", parts: [] }] },
  { ref: "J2", taskId: "poster", tickets: [{ ref: "T3", ticketId: "draft", parts: [] }] },
];

test("where a line belongs, as read: jobs, tickets and parts by the refs it was shown, each part a target of its own", () => {
  expect(checkFilingReading({ about: "jobs", jobs: [{ job: "J1", ticket: "T1", parts: ["shot_01", "shot_03"] }, { job: "J2", ticket: null, parts: [] }] }, REFS)).toEqual({
    source: "model", about: "jobs",
    targets: [{ taskId: "film", ticketId: "shots", partKey: "shot_01" }, { taskId: "film", ticketId: "shots", partKey: "shot_03" }, { taskId: "poster", ticketId: null, partKey: null }],
  });
  // A part named without its ticket is the ticket's when only one ticket of the job has it.
  expect(checkFilingReading({ about: "jobs", jobs: [{ job: "J1", parts: ["shot_02"] }] }, REFS)!.targets).toEqual([{ taskId: "film", ticketId: "shots", partKey: "shot_02" }]);
});

test("refs it was not shown are dropped: a wrong ticket or part leaves the job, a wrong job leaves nothing, and nothing left reads as unclear", () => {
  expect(checkFilingReading({ about: "jobs", jobs: [{ job: "J1", ticket: "T9", parts: ["shot_09"] }] }, REFS)!.targets).toEqual([{ taskId: "film", ticketId: null, partKey: null }]);
  expect(checkFilingReading({ about: "jobs", jobs: [{ job: "J1", ticket: "T2", parts: ["shot_01"] }] }, REFS)!.targets).toEqual([{ taskId: "film", ticketId: "music", partKey: null }]);
  expect(checkFilingReading({ about: "jobs", jobs: [{ job: "J7" }, "J1"] }, REFS)).toEqual({ source: "model", about: "unclear", targets: [] });
  expect(checkFilingReading({ about: "jobs" }, REFS)).toEqual({ source: "model", about: "unclear", targets: [] });
});

test("new, in_place and unclear carry no targets, whatever else the answer says; anything else is no reading", () => {
  expect(checkFilingReading({ about: "new", jobs: [{ job: "J1" }] }, REFS)).toEqual({ source: "model", about: "new", targets: [] });
  expect(checkFilingReading({ about: "in_place", jobs: [{ job: "J1" }] }, REFS)).toEqual({ source: "model", about: "in_place", targets: [] });
  expect(checkFilingReading({ about: "unclear" }, REFS)).toEqual({ source: "model", about: "unclear", targets: [] });
  expect(checkFilingReading({ about: "J1" }, REFS)).toBeNull();
  expect(checkFilingReading({ jobs: [{ job: "J1" }] }, REFS)).toBeNull();
});

