import { expect, test } from "bun:test";
import { ensureHighlightLang, getShikiHighlighter, recoverFromTimeLimit } from "./shiki-highlighter.ts";

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

test("a line that ran out of time gets one more try", () => {
  const { calls, grammar } = slowGrammar(1);
  const result = grammar.tokenizeLine2("a", "start" as never, 500);
  expect(result.stoppedEarly).toBe(false);
  expect(result.ruleStack as unknown).toBe("end of a");
  expect(calls).toEqual(["start", "start"]);
});

test("the next line never starts from where a line stopped", () => {
  const { calls, grammar } = slowGrammar(2);
  const result = grammar.tokenizeLine2("a", "start" as never, 500);
  expect(result.stoppedEarly).toBe(true);
  expect(result.ruleStack as unknown).toBe("start");
  expect(grammar.tokenizeLine2("b", result.ruleStack, 500).ruleStack as unknown).toBe("end of b");
  expect(calls).toHaveLength(3);
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
  const [line] = highlighter.codeToTokensBase('const CACHE = "real-bot-v1"; // note', {
    lang: "javascript",
    theme: "github-light",
  });
  const text = line!.map((token) => token.content);
  expect(text).toContain('"real-bot-v1"');
  expect(text).toContain("// note");
});
