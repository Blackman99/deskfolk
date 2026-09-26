import { expect, test } from "bun:test";
import type { CatalogEntry } from "./route-decision";
import {
  extractJsonObject,
  parseRoutePick,
  parseRouteReview,
  verdictIsClarification,
  verdictIsExperience,
} from "./route-agent";
import {
  PAST_REVIEW_WINDOW,
  PREVIOUS_MESSAGE_LIMIT,
  REVIEW_REPLY_LIMIT,
  ROUTE_PICK_SYSTEM,
  ROUTE_REVIEW_SYSTEM,
  routePickPayload,
  routeReviewPayload,
} from "./prompts/routing";

const CANDIDATES: CatalogEntry[] = [
  {
    name: "grok-4.6",
    price: null,
    thinking_levels: ["none", "low", "high", "xhigh"],
    strengths: [],
    providerId: "p1",
  },
  {
    name: "gemini-3.8-flash-high",
    price: 2,
    thinking_levels: ["low", "max"],
    strengths: ["design"],
    providerId: "p1",
  },
  { name: "open-ended", price: null, thinking_levels: [], strengths: [], providerId: "p2" },
];

test("the first balanced object is taken out of prose and fences", () => {
  expect(extractJsonObject('here you go: {"a": 1} and more')).toEqual({ a: 1 });
  expect(extractJsonObject('```json\n{"a": {"b": 2}}\n```')).toEqual({ a: { b: 2 } });
  // A brace inside a string must not end the object early.
  expect(extractJsonObject('{"reason": "use } carefully", "a": 1}')).toEqual({
    reason: "use } carefully",
    a: 1,
  });
  expect(extractJsonObject("no json here")).toBeNull();
  expect(extractJsonObject('{"unclosed": 1')).toBeNull();
  expect(extractJsonObject("[1, 2]")).toBeNull();
});

test("a pick naming a candidate and a level it offers is trusted", () => {
  const pick = parseRoutePick(
    '{"model": "grok-4.6", "thinking_level": "xhigh", "reason": "needs deep reasoning"}',
    CANDIDATES,
  );
  expect(pick).toEqual({
    model: "grok-4.6",
    thinkingLevel: "xhigh",
    providerId: "p1",
    reason: "needs deep reasoning",
    continuesPrevious: false,
  });
});

test("case and stray space in the answer do not matter", () => {
  const pick = parseRoutePick(
    '{"model": " GROK-4.6 ", "thinking_level": " XHigh ", "reason": "x"}',
    CANDIDATES,
  );
  expect(pick).toMatchObject({ model: "grok-4.6", thinkingLevel: "xhigh" });
});

test("a model outside the candidates is refused rather than run", () => {
  expect(parseRoutePick('{"model": "gpt-9", "thinking_level": "low"}', CANDIDATES)).toBeNull();
  expect(parseRoutePick('{"thinking_level": "low"}', CANDIDATES)).toBeNull();
});

test("a level the named model does not offer is refused", () => {
  // gemini lists low / max; xhigh belongs to the other model.
  expect(
    parseRoutePick('{"model": "gemini-3.8-flash-high", "thinking_level": "xhigh"}', CANDIDATES),
  ).toBeNull();
  expect(parseRoutePick('{"model": "grok-4.6"}', CANDIDATES)).toBeNull();
});

test("a model that lists no levels takes whatever the endpoint was told", () => {
  const pick = parseRoutePick(
    '{"model": "open-ended", "thinking_level": "medium", "reason": "r"}',
    CANDIDATES,
  );
  expect(pick).toMatchObject({ model: "open-ended", thinkingLevel: "medium", providerId: "p2" });
});

test("a reason is collapsed to one line and capped", () => {
  const pick = parseRoutePick(
    `{"model": "grok-4.6", "thinking_level": "low", "reason": "a\\n  b   c ${"x".repeat(400)}"}`,
    CANDIDATES,
  );
  expect(pick!.reason.startsWith("a b c ")).toBe(true);
  expect(pick!.reason.length).toBeLessThanOrEqual(200);
});

test("garbage from the endpoint yields no pick at all", () => {
  expect(parseRoutePick("the model refused to answer", CANDIDATES)).toBeNull();
  expect(parseRoutePick("", CANDIDATES)).toBeNull();
});

test("a verdict is read when it commits to a known fault", () => {
  const verdict = parseRouteReview(
    '{"fault": "model", "direction": "stronger", "rounds": 3, "confidence": 0.8, "reason": "kept missing the point"}',
  );
  expect(verdict).toEqual({
    fault: "model",
    direction: "stronger",
    rounds: 3,
    confidence: 0.8,
    reason: "kept missing the point",
  });
});

test("an unknown fault means no verdict; an unknown direction just means no direction", () => {
  expect(parseRouteReview('{"fault": "vibes", "confidence": 0.9}')).toBeNull();
  expect(parseRouteReview('{"confidence": 0.9}')).toBeNull();
  expect(
    parseRouteReview('{"fault": "task", "direction": "sideways", "confidence": 0.6}'),
  ).toMatchObject({ fault: "task", direction: "same" });
});

test("confidence is required and clamped; rounds are rounded and never negative", () => {
  expect(parseRouteReview('{"fault": "none"}')).toBeNull();
  expect(parseRouteReview('{"fault": "none", "confidence": "high"}')).toBeNull();
  expect(parseRouteReview('{"fault": "none", "confidence": 4}')).toMatchObject({ confidence: 1 });
  expect(parseRouteReview('{"fault": "none", "confidence": -2}')).toMatchObject({ confidence: 0 });
  expect(
    parseRouteReview('{"fault": "model", "confidence": 0.7, "rounds": 2.6}'),
  ).toMatchObject({ rounds: 3 });
  expect(
    parseRouteReview('{"fault": "model", "confidence": 0.7, "rounds": -5}'),
  ).toMatchObject({ rounds: 0 });
});

test("only a confident verdict against the model becomes experience", () => {
  const base = { direction: "stronger" as const, rounds: 2, reason: "r" };
  expect(verdictIsExperience({ ...base, fault: "model", confidence: 0.8 })).toBe(true);
  expect(verdictIsExperience({ ...base, fault: "model", confidence: 0.2 })).toBe(false);
  // The @-mention correction that used to penalise every bot is a prompt fault.
  expect(verdictIsExperience({ ...base, fault: "prompt", confidence: 0.99 })).toBe(false);
  expect(verdictIsExperience({ ...base, fault: "task", confidence: 0.99 })).toBe(false);
  expect(verdictIsExperience({ ...base, fault: "none", confidence: 0.99 })).toBe(false);
});

test("a request the user had to spell out twice is worth a memory of what they meant", () => {
  const base = { direction: "same" as const, reason: "r" };
  expect(verdictIsClarification({ ...base, fault: "prompt", rounds: 2, confidence: 0.8 })).toBe(true);
  expect(verdictIsClarification({ ...base, fault: "prompt", rounds: 5, confidence: 0.5 })).toBe(true);
  // One round is noise; a hedged verdict is not worth a call; other faults are not clarifications.
  expect(verdictIsClarification({ ...base, fault: "prompt", rounds: 1, confidence: 0.9 })).toBe(false);
  expect(verdictIsClarification({ ...base, fault: "prompt", rounds: 3, confidence: 0.3 })).toBe(false);
  expect(verdictIsClarification({ ...base, fault: "model", rounds: 3, confidence: 0.9 })).toBe(false);
  expect(verdictIsClarification({ ...base, fault: "task", rounds: 3, confidence: 0.9 })).toBe(false);
});

test("the picker's payload carries the shortlist and the recent conclusions, newest first", () => {
  const payload = routePickPayload({
    message: "帮我把这个函数重构一下",
    bot: { name: "Writer", duties: "write", boundaries: "stay" },
    candidates: [
      { name: "grok-4.6", price: null, thinking_levels: ["low", "xhigh"], strengths: [] },
      { name: "cheap", price: 1, thinking_levels: ["none"], strengths: ["chat"] },
    ],
    pastReviews: Array.from({ length: 9 }, (_, i) => ({
      message: `任务 ${i} ${"长".repeat(500)}`,
      signature: "coding",
      model: `m${i}`,
      thinkingLevel: "low",
      direction: "stronger",
      rounds: 2,
      reason: `r${i}`,
    })),
    cleanCompletions: [
      { message: "写个函数", signature: "coding", model: "code-pro", thinkingLevel: "high" },
      { message: "你好", signature: "simple", model: "cheap", thinkingLevel: "none" },
    ],
  });
  // The model name is repeated as `model` because that is the key the prompt tells it to copy.
  expect(payload.candidates[0]).toMatchObject({ model: "grok-4.6", thinking_levels: ["low", "xhigh"] });
  expect(payload.past_reviews).toHaveLength(PAST_REVIEW_WINDOW);
  expect(payload.past_reviews[0]).toMatchObject({
    signature: "coding",
    model: "m0",
    thinking_level: "low",
    direction: "stronger",
    rounds: 2,
    reason: "r0",
  });
  expect(payload.past_reviews[0]!.message.length).toBeLessThanOrEqual(400);
  expect(payload.clean_completions).toEqual([
    { message: "写个函数", signature: "coding", model: "code-pro", thinking_level: "high" },
    { message: "你好", signature: "simple", model: "cheap", thinking_level: "none" },
  ]);
});

test("the reviewer's payload trims the reply but keeps every follow-up", () => {
  const payload = routeReviewPayload({
    bot: { name: "Writer", duties: "write" },
    message: "写一份周报",
    model: "grok-4.6",
    thinkingLevel: "low",
    reply: "x".repeat(5000),
    outcome: "completed",
    followUps: ["这里不对", "还是不行", "算了我自己改"],
    execution: {
      hops: 4,
      tool_calls: 6,
      tool_errors: 3,
      repeated_failures: 2,
      files_written: 1,
      fail_kind: null,
      cost_usd_ticks: 40,
    },
  });
  expect(payload.turn.reply).toHaveLength(REVIEW_REPLY_LIMIT);
  expect(payload.turn.execution.repeated_failures).toBe(2);
  expect(payload.follow_ups).toEqual(["这里不对", "还是不行", "算了我自己改"]);
});

test("both prompts name every value their parser accepts", () => {
  for (const fault of ["model", "task", "prompt", "none"]) {
    expect(ROUTE_REVIEW_SYSTEM).toContain(fault);
  }
  for (const direction of ["stronger", "lighter", "faster", "cheaper", "same"]) {
    expect(ROUTE_REVIEW_SYSTEM).toContain(direction);
  }
  // The picker must be told to copy a candidate name rather than invent one.
  expect(ROUTE_PICK_SYSTEM).toContain("candidates");
  expect(ROUTE_PICK_SYSTEM).toContain("thinking_levels");
  expect(ROUTE_PICK_SYSTEM).toContain("past_reviews");
  expect(ROUTE_PICK_SYSTEM).toContain("clean_completions");
  expect(ROUTE_PICK_SYSTEM).toContain("signature");
  expect(ROUTE_REVIEW_SYSTEM).toContain("repeated_failures");
  expect(ROUTE_REVIEW_SYSTEM).toContain("null");
  for (const prompt of [ROUTE_PICK_SYSTEM, ROUTE_REVIEW_SYSTEM]) {
    expect(prompt).toContain("只输出一个 JSON 对象");
    expect(prompt).toContain("不要 tool-call");
  }
});

test("the same pick says whether the message continues the previous one", () => {
  const same = parseRoutePick(
    '{"model": "grok-4.6", "thinking_level": "low", "continues_previous": true}',
    CANDIDATES,
  );
  expect(same!.continuesPrevious).toBe(true);
  // Only a plain true continues a chain; a missing or fuzzy answer starts a new one.
  for (const raw of ['"yes"', "1", "null", "false"]) {
    const pick = parseRoutePick(
      `{"model": "grok-4.6", "thinking_level": "low", "continues_previous": ${raw}}`,
      CANDIDATES,
    );
    expect(pick!.continuesPrevious).toBe(false);
  }
  expect(
    parseRoutePick('{"model": "grok-4.6", "thinking_level": "low"}', CANDIDATES)!.continuesPrevious,
  ).toBe(false);
});

test("the picker is shown the previous trigger only when there is one", () => {
  const base = {
    message: "再改一下",
    bot: { name: "W", duties: "d", boundaries: "b" },
    candidates: [{ name: "m", price: null, thinking_levels: ["low"], strengths: [] }],
    pastReviews: [],
  };
  expect(routePickPayload(base).previous).toBeUndefined();
  const withPrev = routePickPayload({
    ...base,
    previous: { message: "x".repeat(900), model: "m", thinkingLevel: "low" },
  });
  expect(withPrev.previous!.message).toHaveLength(PREVIOUS_MESSAGE_LIMIT);
  expect(withPrev.previous!.thinking_level).toBe("low");
});
