import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CompletionResult } from "./completions";
import {
  BOUNCE_GATE,
  buildProbeTurn,
  formatReport,
  nudge,
  PROTOCOL_TOOLS,
  readAttempt,
  scoreCase,
  summarize,
  validateCases,
  type AttemptResult,
  type ProtocolCase,
} from "./protocol-probe";

const SHIPPED = resolve(import.meta.dir, "..", "eval", "protocol-probe-cases.json");

function ok(toolCalls: Array<{ name: string }>, usage: Partial<NonNullable<CompletionResult["usage"]>> = {}): CompletionResult {
  return {
    ok: true,
    content: "",
    toolCalls: toolCalls.map((call, i) => ({ id: `c${i}`, name: call.name, arguments: "{}" })),
    finishReason: "tool_calls",
    hadChoices: true,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_tokens: null, reasoning_tokens: null, cost_usd_ticks: null, ...usage },
    missingReason: null,
  };
}

function failed(): CompletionResult {
  return { ok: false, failKind: "truncated", hadChoices: true, usage: null, missingReason: null };
}

describe("validateCases", () => {
  test("the shipped case bank loads: every expect is offered, every name is a real protocol tool, no duplicate ids", () => {
    const cases = validateCases(JSON.parse(readFileSync(SHIPPED, "utf8")), SHIPPED);
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const c of cases) {
      expect(PROTOCOL_TOOLS).toContain(c.expect);
      expect(c.offered).toContain(c.expect);
    }
  });

  test("rejects an unknown tool name, a missing expect, or expect not among offered", () => {
    expect(() => validateCases({ cases: [{ id: "a", situation: "s", offered: ["end_turn"], expect: "review" }] })).toThrow("expect");
    expect(() => validateCases({ cases: [{ id: "a", situation: "s", offered: ["review"], expect: "end_turn" }] })).toThrow("offered");
    expect(() => validateCases({ cases: [{ id: "a", situation: "s", offered: ["submit"], expect: "end_turn" }] })).toThrow("must be one of offered");
  });

  test("rejects a duplicate id", () => {
    const dup = { cases: [{ id: "a", situation: "s", offered: ["end_turn"], expect: "end_turn" }, { id: "a", situation: "t", offered: ["end_turn"], expect: "end_turn" }] };
    expect(() => validateCases(dup)).toThrow("duplicate id");
  });
});

describe("buildProbeTurn", () => {
  test("offers exactly the case's tools, in order, and states the situation as the user's line", () => {
    const c: ProtocolCase = { id: "x", situation: "half done", offered: ["work_on", "end_turn"], expect: "work_on" };
    const turn = buildProbeTurn(c);
    expect(turn.tools.map((t) => t.function.name)).toEqual(["work_on", "end_turn"]);
    expect(turn.messages.at(-1)).toEqual({ role: "user", content: "half done" });
  });
});

describe("readAttempt", () => {
  const offered = ["end_turn", "submit", "work_on"] as const;

  test("exactly one offered tool call, matching expect, is read back as compliant", () => {
    const attempt = readAttempt(ok([{ name: "submit" }]), offered, "submit");
    expect(attempt.toolCalled).toBe("submit");
    expect(attempt.failKind).toBeNull();
  });

  test("no call at all is not compliant (the classic bounce: says it will call a tool and doesn't)", () => {
    const result: CompletionResult = { ok: true, content: "I'll call submit now.", toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
    const attempt = readAttempt(result, offered, "submit");
    expect(attempt.toolCalled).toBeNull();
    expect(attempt.failKind).toBe("no_call");
  });

  test("a failed completion is not compliant, and reads as a transport failure, not the model's own non-compliance", () => {
    const attempt = readAttempt(failed(), offered, "submit");
    expect(attempt.toolCalled).toBeNull();
    expect(attempt.failKind).toBe("transport");
  });

  test("more than one call, even two offered ones, is not compliant (the contract wants exactly one)", () => {
    const attempt = readAttempt(ok([{ name: "submit" }, { name: "end_turn" }]), offered, "submit");
    expect(attempt.toolCalled).toBeNull();
    expect(attempt.failKind).toBe("wrong_call");
  });

  test("a name outside the offered set is flagged and not compliant, even alone", () => {
    const attempt = readAttempt(ok([{ name: "review" }]), offered, "submit");
    expect(attempt.toolCalled).toBeNull();
    expect(attempt.unrecognizedCall).toBe(true);
    expect(attempt.failKind).toBe("wrong_call");
  });

  test("a lone call to an offered tool that isn't `expect` is not compliant: wrong_call, not read as if it complied", () => {
    const attempt = readAttempt(ok([{ name: "end_turn" }]), offered, "submit");
    expect(attempt.toolCalled).toBe("end_turn");
    expect(attempt.failKind).toBe("wrong_call");
  });
});

describe("nudge", () => {
  test("words the reason by what actually happened, not always \"you did not call a tool\"", () => {
    expect(nudge(["submit"], "no_call")).toContain("You did not call a tool");
    expect(nudge(["submit"], "wrong_call")).not.toContain("You did not call a tool");
    expect(nudge(["submit"], "transport")).toContain("failed before it could answer");
  });
});

describe("scoreCase and summarize", () => {
  const c: ProtocolCase = { id: "x", situation: "s", offered: ["end_turn", "submit", "work_on"], expect: "submit" };

  test("compliant on the first attempt: no retries, no extra spend", () => {
    const attempts: AttemptResult[] = [{ toolCalled: "submit", unrecognizedCall: false, failKind: null, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_tokens: null, reasoning_tokens: null, cost_usd_ticks: null } }];
    const row = scoreCase(c, attempts);
    expect(row).toMatchObject({ compliant_first_try: true, never_compliant: false, final_tool: "submit", extra_input_tokens: 0, extra_output_tokens: 0 });
  });

  test("a bounce then a compliant retry: extra spend is only the retry's, and it is not compliant_first_try", () => {
    const attempts: AttemptResult[] = [
      { toolCalled: null, unrecognizedCall: false, failKind: "no_call", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_tokens: null, reasoning_tokens: null, cost_usd_ticks: null } },
      { toolCalled: "submit", unrecognizedCall: false, failKind: null, usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18, cached_tokens: null, reasoning_tokens: null, cost_usd_ticks: null } },
    ];
    const row = scoreCase(c, attempts);
    expect(row.compliant_first_try).toBe(false);
    expect(row.never_compliant).toBe(false);
    expect(row.extra_input_tokens).toBe(12);
    expect(row.extra_output_tokens).toBe(6);
  });

  test("never compliant within the retry budget: never_compliant, final_tool null", () => {
    const attempts: AttemptResult[] = [
      { toolCalled: null, unrecognizedCall: false, failKind: "no_call", usage: null },
      { toolCalled: null, unrecognizedCall: false, failKind: "no_call", usage: null },
      { toolCalled: "end_turn", unrecognizedCall: false, failKind: null, usage: null }, // wrong tool, still not compliant
    ];
    const row = scoreCase(c, attempts);
    expect(row.never_compliant).toBe(true);
    expect(row.final_tool).toBeNull();
  });

  test("transport_failures counts only the attempts that failed in transport", () => {
    const attempts: AttemptResult[] = [
      { toolCalled: null, unrecognizedCall: false, failKind: "transport", usage: null },
      { toolCalled: null, unrecognizedCall: false, failKind: "no_call", usage: null },
      { toolCalled: "submit", unrecognizedCall: false, failKind: null, usage: null },
    ];
    expect(scoreCase(c, attempts).transport_failures).toBe(1);
  });

  test("summarize: bounce_rate is the share that needed a nudge (not compliant on the first try), not the share that exhausted the retry budget", () => {
    const rows = [
      // Compliant first try.
      scoreCase(c, [{ toolCalled: "submit", unrecognizedCall: false, failKind: null, usage: null }]),
      // Needed one nudge, then complied: counts toward bounce_rate, not toward needs_attention.
      scoreCase(c, [
        { toolCalled: null, unrecognizedCall: false, failKind: "no_call", usage: null },
        { toolCalled: "submit", unrecognizedCall: false, failKind: null, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, cached_tokens: null, reasoning_tokens: null, cost_usd_ticks: null } },
      ]),
      // Never compliant: counts toward both bounce_rate and needs_attention.
      scoreCase(c, [
        { toolCalled: null, unrecognizedCall: false, failKind: "no_call", usage: null },
        { toolCalled: null, unrecognizedCall: false, failKind: "no_call", usage: null },
      ]),
    ];
    const summary = summarize(rows);
    expect(summary).toMatchObject({
      total: 3,
      compliant_first_try: 1,
      compliant: 2,
      bounce_rate: 2 / 3,
      needs_attention: 1,
      needs_attention_rate: 1 / 3,
      extra_input_tokens: 1,
      extra_output_tokens: 2,
    });
  });

  test("a model that needs a nudge on every hop and then complies scores a high bounce_rate, not 0%: it broke the contract every time, even though every case eventually recovered", () => {
    const rows = Array.from({ length: 6 }, () =>
      scoreCase(c, [
        { toolCalled: null, unrecognizedCall: false, failKind: "no_call", usage: null },
        { toolCalled: "submit", unrecognizedCall: false, failKind: null, usage: null },
      ]),
    );
    const summary = summarize(rows);
    expect(summary.needs_attention).toBe(0);
    expect(summary.bounce_rate).toBe(1);
  });

  test("an empty case list summarizes to a 0 bounce rate, not NaN", () => {
    expect(summarize([]).bounce_rate).toBe(0);
    expect(summarize([]).needs_attention_rate).toBe(0);
  });
});

describe("nudge and formatReport", () => {
  test("the nudge names exactly the offered tools", () => {
    expect(nudge(["submit", "work_on"])).toContain("submit, work_on");
  });

  test("the report names PASS under the gate and FAIL at or above it", () => {
    const c: ProtocolCase = { id: "x", situation: "s", offered: ["end_turn"], expect: "end_turn" };
    const passing = [scoreCase(c, [{ toolCalled: "end_turn", unrecognizedCall: false, failKind: null, usage: null }])];
    expect(formatReport("model", summarize(passing), passing)).toContain("PASS");
    const failing = Array.from({ length: 10 }, () => scoreCase(c, [{ toolCalled: null, unrecognizedCall: false, failKind: "no_call", usage: null }]));
    expect(formatReport("model", summarize(failing), failing)).toContain("FAIL");
    expect(BOUNCE_GATE).toBe(0.1);
  });
});
