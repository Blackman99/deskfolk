/**
 * What a turn does with a hop that is not a reply (ADR 0040 P1, output caps and failure shapes): a
 * reply cut off at the output cap carries on once; a loop, a canned refusal, half a stream or a hop
 * past its time limit goes again once with a note, and failing again in a row ends the turn with a
 * failure line. None of it is posted. F-e (scenarios/f-e-repeat-closer.test.ts) is the incident.
 */
import { afterEach, expect, test } from "bun:test";
import type { CompletionResult } from "./completions";
import { continueNote, retryNote } from "./hop-limits";
import { completionFailBody } from "./prompts";
import { call, createScenario, failed, requestText, say, tool, truncated, type Scenario } from "./test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function oneBot() {
  const h = await createScenario();
  open.push(h);
  const [alpha] = h.createBots("Alpha");
  const dm = h.direct(alpha!);
  return { h, alpha: alpha!, dm };
}

const REFUSAL = "I'm sorry, but I can't help with that.";

function lines(h: Scenario, session: string, kind: "bot" | "system"): string[] {
  return h.messages(session).filter((m) => m.kind === kind).map((m) => m.body);
}

test("every hop sends its model's output cap and time limit: 32K and ten minutes until measured", async () => {
  const { h, alpha, dm } = await oneBot();
  h.script(alpha, dm).reply(say("好"), say("又好了"));
  h.postUser(dm, "说一句");
  await h.waitIdle();
  expect(h.hops(alpha).map(({ request }) => [request.maxTokens, request.wallMs])).toEqual([[32_768, 600_000]]);

  await h.store.patchSettings({ endpoint_models: [{ name: "scenario", max_output: 60_000, stream_tps_p10: 40 }] });
  h.postUser(dm, "再说一句");
  await h.waitIdle();
  expect(h.hops(alpha).map(({ request }) => [request.maxTokens, request.wallMs])[1]).toEqual([60_000, 2_250_000]);
});

test("a price saved from the settings form keeps what was measured about the model", async () => {
  const { h } = await oneBot();
  await h.store.patchSettings({ endpoint_models: [{ name: "scenario", max_output: 60_000, stream_tps_p10: 40 }] });
  // The form sends each name with only the fields it shows.
  await h.store.patchSettings({ endpoint_models: [{ name: "scenario", price: 2, thinking_levels: ["low", "high"], strengths: [] }] });
  expect(h.store.catalogEntries().map(({ name, price, max_output, stream_tps_p10 }) => ({ name, price, max_output, stream_tps_p10 }))).toEqual([
    { name: "scenario", price: 2, max_output: 60_000, stream_tps_p10: 40 },
  ]);
});

test("a slow model's measured limit keeps its hop going past the stale sweep's twenty minutes", async () => {
  const { h, alpha, dm } = await oneBot();
  // 60,000 tokens at 40 a second, half again: 37.5 minutes.
  await h.store.patchSettings({ endpoint_models: [{ name: "scenario", max_output: 60_000, stream_tps_p10: 40 }] });
  let asked = 0;
  h.script(alpha, dm).reply(() => {
    asked += 1;
    return new Promise<CompletionResult>(() => {});
  }, say("写完了"));

  h.postUser(dm, "写一份长的");
  await h.waitFor(() => asked === 1, { what: "the first hop" });
  h.advance(25 * 60_000);
  expect(h.turns(alpha).map((turn) => turn.status)).toEqual(["running"]);
  h.advance(13 * 60_000);
  await h.waitIdle();

  expect(lines(h, dm, "bot")).toEqual(["写完了"]);
  expect(requestText(h.hops(alpha)[1]!.request)).toContain(retryNote("zh", "overtime"));
});

test("a reply cut off at the cap carries on once: the cut part is never posted, the next hop reads it", async () => {
  const { h, alpha, dm } = await oneBot();
  h.script(alpha, dm).reply(truncated("第一部分：镜头一到镜头四的分镜说明"), say("分镜写进了 work/分镜.md。"));
  h.postUser(dm, "写分镜");
  await h.waitIdle();

  expect(lines(h, dm, "bot")).toEqual(["分镜写进了 work/分镜.md。"]);
  expect(lines(h, dm, "system")).toEqual([]);
  const second = requestText(h.hops(alpha)[1]!.request);
  expect(second).toContain("第一部分：镜头一到镜头四的分镜说明");
  expect(second).toContain(continueNote("zh", false));
});

test("cut off at the cap again in a row, the turn fails and posts nothing of either", async () => {
  const { h, alpha, dm } = await oneBot();
  h.script(alpha, dm).reply(truncated("第一段很长的文字"), truncated("第二段还是很长的文字"));
  h.postUser(dm, "写分镜");
  await h.waitIdle();

  expect(lines(h, dm, "bot")).toEqual([]);
  expect(lines(h, dm, "system")).toEqual([completionFailBody("zh", "truncated")]);
});

test("cut off inside a tool call's arguments, nothing runs and the next hop is told to write in parts", async () => {
  const { h, alpha, dm } = await oneBot();
  h.script(alpha, dm).reply({ ...truncated(""), toolArgsCut: true }, say("分成三个文件写好了。"));
  h.postUser(dm, "把全文写进文件");
  await h.waitIdle();

  expect(h.toolCalls(alpha)).toEqual([]);
  expect(requestText(h.hops(alpha)[1]!.request)).toContain(continueNote("zh", true));
  expect(lines(h, dm, "bot")).toEqual(["分成三个文件写好了。"]);
});

test("a canned refusal is not posted; the hop goes again with a note, without the refusal", async () => {
  const { h, alpha, dm } = await oneBot();
  h.script(alpha, dm).reply(say(REFUSAL), say("好的，这就改。"));
  h.postUser(dm, "改一下第二镜");
  await h.waitIdle();

  expect(lines(h, dm, "bot")).toEqual(["好的，这就改。"]);
  const second = requestText(h.hops(alpha)[1]!.request);
  expect(second).toContain(retryNote("zh", "declined"));
  expect(second).not.toContain(REFUSAL);
});

test("failing the same way twice in a row ends the turn with a failure line, and wakes nobody", async () => {
  const h = await createScenario();
  open.push(h);
  const [alpha, beta] = h.createBots("Alpha", "Beta");
  const thread = h.botDirect(alpha!, beta!);
  h.script(alpha!, thread).reply(say(REFUSAL), say(REFUSAL));
  h.postBot(beta!, thread, "第二镜改好了吗？");
  await h.waitIdle();

  expect(lines(h, thread, "bot")).toEqual(["第二镜改好了吗？"]);
  expect(lines(h, thread, "system")).toEqual([completionFailBody("zh", "declined")]);
  expect(h.turns(beta!)).toEqual([]);
});

test("half a stream goes again once, then fails; an endpoint that cannot be reached fails at once", async () => {
  const { h, alpha, dm } = await oneBot();
  h.script(alpha, dm).reply(failed("incomplete"), failed("incomplete"), failed("unreachable"));
  h.postUser(dm, "第一件");
  await h.waitIdle();
  expect(h.hops(alpha)).toHaveLength(2);
  expect(lines(h, dm, "system")).toEqual([completionFailBody("zh", "incomplete")]);

  h.postUser(dm, "第二件");
  await h.waitIdle();
  expect(h.hops(alpha)).toHaveLength(3);
  expect(lines(h, dm, "system")).toEqual([completionFailBody("zh", "incomplete"), completionFailBody("zh", "unreachable")]);
});

test("a prompt over the model's window fails the turn at once, with the numbers (ADR 0067)", async () => {
  const { h, alpha, dm } = await oneBot();
  h.script(alpha, dm).reply({ ...failed("context_full"), hadChoices: true, contextFull: { estimated: 15_313, read: 4_098, window: 8_192 } });
  h.postUser(dm, "建个文件");
  await h.waitIdle();
  // Not sent again: the same prompt would meet the same window.
  expect(h.hops(alpha)).toHaveLength(1);
  expect(lines(h, dm, "system")).toEqual([
    completionFailBody("zh", "context_full", "这一步约 15,313 token，端点只读进了 4,098 token，窗口是 8,192"),
  ]);
});

test("the one retry is for failures in a row: a usable hop in between earns another", async () => {
  const { h, alpha, dm } = await oneBot();
  h.script(alpha, dm).reply(say(REFUSAL), call(tool("list_dir", { path: "." })), say(REFUSAL), say("看完了，目录是空的。"));
  h.postUser(dm, "看看工作区");
  await h.waitIdle();

  expect(h.hops(alpha)).toHaveLength(4);
  expect(lines(h, dm, "bot")).toEqual(["看完了，目录是空的。"]);
  expect(lines(h, dm, "system")).toEqual([]);
});
