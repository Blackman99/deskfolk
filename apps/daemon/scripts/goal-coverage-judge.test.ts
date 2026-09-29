import { expect, test } from "bun:test";
import type { CompletionsClient, JudgeResult } from "../src/completions";
import { goalCoveragePayload } from "../src/goal-coverage-eval";
import { COVERAGE_JUDGE_ATTEMPTS, judgeCoverage } from "./goal-coverage-judge";

const VALID = '{"requirements":[{"text":"交到 report.md","status":"covered","evidence":"report.md 存在"}],"summary":"齐了"}';

function client(answers: string[]): CompletionsClient & { asked: number } {
  const c = {
    asked: 0,
    async complete() {
      throw new Error("not used");
    },
    async judge(): Promise<JudgeResult> {
      const content = answers[c.asked] ?? "";
      c.asked += 1;
      return { content, toolCalls: [], hadToolCalls: false, usage: { input_tokens: 100, output_tokens: 10 } as JudgeResult["usage"], failKind: null };
    },
  };
  return c as CompletionsClient & { asked: number };
}

const payload = goalCoveragePayload({ brief: "写 report.md", deliveries: [{ path: "report.md", excerpt: "# 报告" }], finalMessages: [] });
const input = (c: CompletionsClient) => ({ client: c, baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "judge", timeoutMs: 1000, payload });

test("an unreadable verdict is asked again once, and the usage of both asks adds up", async () => {
  const c = client(["我觉得都满足了。", VALID]);
  const verdict = await judgeCoverage(input(c));
  expect(c.asked).toBe(2);
  expect(verdict.error).toBeNull();
  expect(verdict.score).toBe(1);
  expect(verdict.usage?.input_tokens).toBe(200);
  expect(verdict.usage?.output_tokens).toBe(20);
});

test("two unreadable verdicts give up, and the error quotes what came back", async () => {
  const c = client(['{"requirements":[{"text":"a","status":"done"}]}', '{"requirements":[{"text":"a","status":"done"}]}']);
  const verdict = await judgeCoverage(input(c));
  expect(c.asked).toBe(COVERAGE_JUDGE_ATTEMPTS);
  expect(verdict.score).toBeNull();
  expect(verdict.error).toStartWith("the judge did not answer in the expected shape: ");
  expect(verdict.error).toContain('"status":"done"');
});

test("a readable verdict is asked once", async () => {
  const c = client([VALID]);
  const verdict = await judgeCoverage(input(c));
  expect(c.asked).toBe(1);
  expect(verdict.score).toBe(1);
});
