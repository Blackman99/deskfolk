import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carriedTotals } from "./model-usage";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function sessionFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "model-usage-"));
  dirs.push(dir);
  writeFileSync(join(dir, "s.jsonl"), text);
  return join(dir, "s.jsonl");
}

const costState = (inputTokens: number, costUSD: number) =>
  `${JSON.stringify({ type: "cost-state", modelUsage: { "claude-opus-5-5": { inputTokens, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, outputTokens: 7, costUSD } } })}\n`;
const said = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

test("a session's carried totals are its last cost-state entry, read back from the end of the file", () => {
  expect(carriedTotals(sessionFile(costState(1, 0.1) + said("再来") + costState(100, 2) + said("然后")))).toEqual(
    new Map([["claude-opus-5-5", { input: 115, output: 7, cached: 10, cost: 2 }]]),
  );
  // Far from the end: past many windows of lines it said since, in a script of several bytes a character.
  expect(carriedTotals(sessionFile(costState(3, 0.3) + said("很长的一句话。".repeat(60_000)))))
    .toEqual(new Map([["claude-opus-5-5", { input: 18, output: 7, cached: 10, cost: 0.3 }]]));
});

test("an entry that straddles the edge of a read is read whole", () => {
  const entry = costState(42, 1.5);
  // The edge of the last 256 KiB falls 20 bytes into the entry.
  const after = `${"x".repeat(256 * 1024 + 20 - Buffer.byteLength(entry) - 1)}\n`;
  expect(carriedTotals(sessionFile(said("前面") + entry + after))).toEqual(new Map([["claude-opus-5-5", { input: 57, output: 7, cached: 10, cost: 1.5 }]]));
});

test("no entry, or no file, carries nothing", () => {
  expect(carriedTotals(sessionFile(said("只有话")))).toBeNull();
  expect(carriedTotals(join(tmpdir(), "no-such-session.jsonl"))).toBeNull();
});
