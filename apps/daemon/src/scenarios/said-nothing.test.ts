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
 *
 * The same day 视频导演 answered 「水印去不掉吗」 with a video and 「这个视频生成跟 Grok 的比哪个好」 with
 * three clips handed over, not a word to either: files counted as a reply, and submit ended the
 * segment the moment they were handed over. Files are no reply now, and submit does not end such a
 * segment before a word of it has reached you.
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
  return { h, bot: bot!, dm, endings, read, turns: h.turns(bot!) };
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

const REPLY = "两种拿法都写在 openssf-score.md 里：查公布的数据集，或者用 CLI 现算。";

test("files alone are no reply: the ending is sent back once, and the reply after it goes out with the file", async () => {
  // The write opened a job of its own, so the reply is sent back for that job's open ticket too: it
  // has gone out by then, and the Bot is told so.
  const heard: string[] = [];
  const { h, bot, dm, endings, turns } = await ask((hop) => hop === 1
    ? call(writeFile("openssf-score.md", ANSWER), tool("end_turn", { reason: "answered" }))
    : hop === 2 ? say(REPLY) : call(tool("end_turn", { reason: "nothing_new" })));
  expect(endings).toMatchObject([{ ok: false, error: "said_nothing", content: expect.stringContaining("You ended with files and no words") }]);
  expect(turns).toMatchObject([{ status: "completed" }]);
  for (const hop of h.hops(bot)) heard.push(JSON.stringify(hop.request.messages.at(-1)));
  expect(heard[2]).toContain("你的回复已经原样发出");
  const lines = h.messages(dm).filter((message) => message.author !== "user");
  expect(lines.map((message) => [message.kind, message.attachments.map((file) => file.workspace_relpath)])).toEqual([["bot", ["openssf-score.md"]]]);
  expect(lines[0]!.body).toContain("两种拿法都写在");
});

test("a reply written again after it went out is not posted twice", async () => {
  const { h, bot, dm } = await ask((hop) => hop === 1
    ? call(writeFile("openssf-score.md", ANSWER), tool("end_turn", { reason: "answered" }))
    : say(REPLY));
  expect(h.hops(bot)).toHaveLength(3);
  expect(h.messages(dm).filter((message) => message.kind === "bot")).toHaveLength(1);
});

test("a hand-over in your direct does not end the segment before a word; the reply after it goes out, without the files again", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots({ name: "视频导演", duties: "测视频生成" });
  const dm = h.direct(bot!);
  const plan = h.store.openTask({ sessionId: dm, title: "测试百炼端点能否生成视频" });
  const ticket = h.store.createTicket({ taskId: plan.id, title: "测试百炼端点能否生成视频", worker: bot!.id });
  const submits: ToolOutcome[] = [];
  h.script(bot!, dm).handle(({ hop, results }) => {
    submits.push(...results.filter((result) => result.name === "submit"));
    if (hop === 1) return call(writeFile(`${ticket.dir}/grok_cmp_cat.mp4`, "clip"));
    if (hop === 2) return call(tool("submit", { artifacts: [`${ticket.dir}/grok_cmp_cat.mp4`] }));
    return say("两者整体差不多，做连续镜头更推荐 Grok：对比片子见 grok_cmp_cat.mp4。");
  });
  const line = h.store.postMessage(dm, { body: "这个视频生成跟 Grok 的比哪个好" });
  h.store.fileMessage(line.id, { explicit: [{ taskId: plan.id, ticketId: ticket.id }] });
  await h.engine.handleInboundMessage(h.store.getMessage(line.id), { fromUser: true });
  await h.waitIdle();

  // Handed over, and told it has not replied yet: the segment went on to the reply.
  expect(submits).toHaveLength(1);
  expect(submits[0]!.ok).toBe(true);
  expect(submits[0]!.content).toContain("no word of yours has reached them");
  const lines = h.messages(dm).filter((message) => message.author !== "user" && message.kind === "bot");
  expect(lines.map((message) => [message.body === "" ? "files" : "words", message.attachments.map((file) => file.workspace_relpath)])).toEqual([
    ["files", [`${ticket.dir}/grok_cmp_cat.mp4`]],
    ["words", []],
  ]);
  expect(lines[1]!.body).toContain("更推荐 Grok");
  expect(h.turns(bot!)).toMatchObject([{ status: "completed", end_reason: "done" }]);
  expect(h.store.listWorkEvents({ kind: "end.rejected" })).toEqual([]);
});
