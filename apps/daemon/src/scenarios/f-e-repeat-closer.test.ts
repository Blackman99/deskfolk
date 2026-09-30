/**
 * ADR 0040 fixture F-e: a reply that repeated one sentence to the token cap, posted as a closer.
 *
 * On 2026-09-29, three times, a hop streamed exactly 128,000 tokens of one sentence over and over
 * (one of them for 17 minutes, in 视频导演's Bot↔Bot direct with 审片员 on EP01) and stopped at
 * the cap with `finish_reason: "length"`. A cut-off reply counted as a reply: it was posted as the
 * turn's closing line, and in a Bot↔Bot direct a closing line wakes the other Bot, whose next hop
 * then read the whole repetition again.
 *
 * Since ADR 0040 P1 (output caps and failure shapes): a reply that repeats itself is a failed hop.
 * It is not posted and wakes nobody; the hop goes again once, on the same model, with a note saying
 * why, and when that one repeats too the turn fails visibly, with a failure line in the session.
 *
 * The scripted reply is what the endpoint streamed, handed over whole: the harness stands in for
 * the completions client, so the streaming watch that cuts a loop off mid-stream never sees it.
 * The turn engine judges the finished body with the same rules (`replyFailure` in hop-limits.ts)
 * before it posts anything, and that is what this fixture exercises.
 */
import { afterEach, expect, test } from "bun:test";
import type { MappedUsage } from "../completions";
import { retryNote } from "../hop-limits";
import { completionFailBody } from "../prompts";
import { createScenario, requestText, truncated, type Scenario } from "../test-kit/scenario";
import { openPlan, planSpec, videoTeam } from "./video-team";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** The sentence, as the Bot kept writing it. */
const LINE = "停工已对齐，本轮不再发消息。";

/** What the endpoint reported for each of those hops: the whole cap spent on output. */
const AT_THE_CAP: MappedUsage = {
  input_tokens: 90_000,
  output_tokens: 128_000,
  total_tokens: 218_000,
  cached_tokens: null,
  reasoning_tokens: null,
  cost_usd_ticks: null,
};

test("a reply cut off at the cap while repeating one sentence is a failed hop: not posted, wakes nobody, retried once", async () => {
  const h = await createScenario();
  open.push(h);
  const { director, reviewer, room } = videoTeam(h);
  const ep01 = openPlan(h, room, "EP01", planSpec("EP01 动画成片"));
  const thread = h.botDirect(director, reviewer);
  const loop = LINE.repeat(3457);
  // The hop, then the one retry: both run to the cap the same way.
  h.script(director, thread).reply(truncated(loop, AT_THE_CAP), truncated(loop, AT_THE_CAP));

  h.postBot(reviewer, thread, "EP01 的母带拼好了吗？", { taskId: ep01.id });
  await h.waitIdle();

  const [turn, ...others] = h.turns(director);
  expect(others).toEqual([]);
  // Nothing of it reaches the transcript.
  const repeated = h.messages(thread).filter((message) => message.body.includes(LINE.repeat(2)));
  expect(repeated.map(({ kind, author, body }) => ({ kind, author, chars: body.length }))).toEqual([]);
  // So nobody is woken by it.
  expect(h.turns(reviewer)).toEqual([]);
  // One retry, told why, then the turn fails where you can see it.
  const hops = h.hops(director).filter((hop) => hop.turnId === turn!.id);
  expect(hops).toHaveLength(2);
  expect(requestText(hops[1]!.request)).toContain(retryNote("zh", "repeat"));
  expect(requestText(hops[1]!.request)).not.toContain(LINE.repeat(2));
  const failures = h.messages(thread).filter((message) => message.kind === "system" && message.turn_id === turn!.id);
  expect(failures.map((message) => message.body)).toEqual([completionFailBody("zh", "repeat")]);
});
