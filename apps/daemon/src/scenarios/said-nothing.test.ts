/**
 * 2026-10-07 10:45, your direct with 通识: you asked 「OpenSSF criticality score 从哪里获取」. Its first
 * and only step was `end_turn(answered)`, and the answer went into `answer`, which reaches only a Bot
 * that asked through delegate. The end contract took the ending, nothing was posted, and your line sat
 * there with no reply and no sign of why. A replay of that step on the same context did it again once
 * in eight.
 *
 * Now a segment your line opened in your direct does not end without a word to you: the ending is sent
 * back once, to reply in the conversation, and an ending after that goes through with a line telling
 * you it did not reply.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, say, tool, writeFile, type Scenario, type ToolOutcome } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const QUESTION = "OpenSSF criticality score  从哪里获取";
const ANSWER = "OpenSSF Criticality Score 有两种拿法：查 ossf/criticality_score 公布的全量数据集，或者用它的 CLI 对你的仓库现算一次。";

/** 通识 in your direct, scripted by `step`; your question, then what you read and how its endings went. */
async function ask(step: (hop: number) => ReturnType<typeof call>) {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "通识", duties: "回答通识问题" });
  const dm = h.direct(bot!);
  const endings: ToolOutcome[] = [];
  h.script(bot!, dm).handle(({ hop, results }) => {
    endings.push(...results.filter((result) => result.name === "end_turn"));
    return step(hop);
  });
  h.postUser(dm, QUESTION);
  await h.waitIdle();
  const read = h.messages(dm).filter((message) => message.author !== "user").map((message) => `${message.kind}: ${message.body}`);
  return { h, bot: bot!, endings, read, turns: h.turns(bot!) };
}

test("an answer put into end_turn is sent back once, and the reply after it reaches you", async () => {
  const { endings, read, turns } = await ask((hop) => hop === 1
    ? call(tool("end_turn", { reason: "answered", answer: ANSWER, inbox: [{ id: "U13", disposition: "answered" }] }))
    : say(ANSWER));
  expect(endings).toMatchObject([{ ok: false, error: "said_nothing", content: expect.stringContaining("Your answer reached nobody") }]);
  expect(read).toEqual([`bot: ${ANSWER}`]);
  expect(turns).toMatchObject([{ status: "completed", end_reason: "answered" }]);
});

test("a Bot that still says nothing ends, and your direct says it did not reply", async () => {
  const { h, bot, endings, read, turns } = await ask(() => call(tool("end_turn", { reason: "answered", answer: ANSWER })));
  expect(endings.map((ending) => ending.error)).toEqual(["said_nothing"]);
  expect(h.hops(bot)).toHaveLength(2);
  expect(read).toEqual(["system: 通识这一轮没有回复你就结束了。要它回答，再说一次。"]);
  expect(turns).toMatchObject([{ status: "completed", end_reason: "answered" }]);
});

test("a reply that only says it was already answered does not go out, and is sent back once", async () => {
  const heard: string[] = [];
  const { h, bot, read } = await ask((hop) => hop === 1 ? say("上面已经回答过了。") : say(ANSWER));
  for (const hop of h.hops(bot)) heard.push(JSON.stringify(hop.request.messages.at(-1)));
  expect(heard.at(-1)).toContain("Your reply did not go out");
  expect(read).toEqual([`bot: ${ANSWER}`]);
});

test("files it wrote for you are a reply: the ending goes through the first time", async () => {
  const { h, bot, endings, read } = await ask(() => call(writeFile("openssf-score.md", ANSWER), tool("end_turn", { reason: "answered" })));
  expect(endings).toEqual([]);
  expect(h.hops(bot)).toHaveLength(1);
  expect(read).toEqual(["bot: "]);
});
