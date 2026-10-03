/**
 * 读句 (ADR 0055): what a model's answer must be before anything acts on it, and the word lists'
 * reading the app falls back to when no model can read a line.
 */
import { expect, test } from "bun:test";
import { botLineByWords, checkBotReading, checkUserReading, readsAsNoWork, userLineByWords } from "./line-reading";
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
    .toEqual({ source: "model", later: "我这边着手整理第二集的分镜脚本，弄好发群里", claimsVerified: false, noWork: false, bareStatus: false });
  expect(checkBotReading({ later: "稍后发你" }, "初稿先放这。结论随后。")!.later).toBe("结论随后。");
  expect(checkBotReading({ later: "稍后发你" }, body)!.later).toBe(body);
  expect(checkBotReading({ later: null, claims_verified: true }, "测试跑过了")!).toMatchObject({ later: null, claimsVerified: true });
  expect(checkBotReading({ verdict: "fine" }, body)).toBeNull();
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
