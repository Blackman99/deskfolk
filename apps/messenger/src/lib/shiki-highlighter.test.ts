import { expect, test } from "bun:test";
import { WARM_UP_TRIES, ensureHighlightLang, getShikiHighlighter, recoverFromTimeLimit } from "./shiki-highlighter.ts";

type Grammar = Parameters<typeof recoverFromTimeLimit>[0];

/** A grammar whose `tokenizeLine2` runs out of time for its first `slow` calls. */
function slowGrammar(slow: number) {
  const calls: unknown[] = [];
  const grammar = {
    tokenizeLine2(line: string, prev: unknown) {
      calls.push(prev);
      const stoppedEarly = calls.length <= slow;
      return { tokens: new Uint32Array([0, 1]), ruleStack: stoppedEarly ? "mid-line" : `end of ${line}`, stoppedEarly };
    },
  } as unknown as Grammar;
  recoverFromTimeLimit(grammar);
  return { calls, grammar };
}

test("a line that runs out of time is tried again until it finishes", () => {
  const { calls, grammar } = slowGrammar(3);
  const result = grammar.tokenizeLine2("a", "start" as never, 500);
  expect(result.stoppedEarly).toBe(false);
  expect(result.ruleStack as unknown).toBe("end of a");
  expect(calls).toEqual(["start", "start", "start", "start"]);
});

test("the extra tries are spent once per grammar, and then a line that runs out never leaks its stop", () => {
  const { calls, grammar } = slowGrammar(Infinity);
  const first = grammar.tokenizeLine2("a", "start" as never, 500);
  expect(first.stoppedEarly).toBe(true);
  expect(calls).toHaveLength(1 + WARM_UP_TRIES);
  // The next line starts from where this one started, not from inside the rule it stopped in.
  expect(first.ruleStack as unknown).toBe("start");
  const second = grammar.tokenizeLine2("b", first.ruleStack, 500);
  expect(second.ruleStack as unknown).toBe("start");
  expect(calls).toHaveLength(2 + WARM_UP_TRIES);
});

test("a grammar is wrapped once, however often its language is ensured", () => {
  const { calls, grammar } = slowGrammar(1);
  recoverFromTimeLimit(grammar);
  grammar.tokenizeLine2("a", "start" as never, 500);
  expect(calls).toHaveLength(2);
});

test("JS loaded as HTML's embed still tokenizes, and its strings stay strings", async () => {
  await ensureHighlightLang("html");
  await ensureHighlightLang("javascript");
  const highlighter = await getShikiHighlighter();
  // A limit far under one cold regex scan makes every machine as slow as CI's: each scan that
  // compiles overruns it, and the line still has to come out whole.
  const [line] = highlighter.codeToTokensBase('const CACHE = "real-bot-v1"; // note', {
    lang: "javascript",
    theme: "github-light",
    tokenizeTimeLimit: 5,
  });
  const text = line!.map((token) => token.content);
  expect(text).toContain('"real-bot-v1"');
  expect(text).toContain("// note");
});
