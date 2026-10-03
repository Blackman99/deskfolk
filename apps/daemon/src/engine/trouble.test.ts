import { expect, test } from "bun:test";
import { malformedArguments, modelsMistake, noteArguments, noteOutcome, troubleCount } from "./trouble";

test("arguments that are not a JSON object are malformed; none at all is a call without any", () => {
  expect(["", "  ", "{}", "{\"path\": \"a\"}"].map(malformedArguments)).toEqual([false, false, false, false]);
  expect(["{", "[1]", "null", "3", "\"a\"", "not json"].map(malformedArguments)).toEqual([true, true, true, true, true, true]);
});

test("two malformed in a row is trouble, once; a good one in between starts again", () => {
  const count = troubleCount();
  expect([noteArguments(count, "{"), noteArguments(count, "{}"), noteArguments(count, "{"), noteArguments(count, "[")]).toEqual([null, null, null, "malformed_tool_json"]);
  expect(noteArguments(count, "{")).toBeNull();
});

test("the same tool called wrongly three times in a row is trouble; success or another tool starts again; a failure that is not the model's mistake changes nothing", () => {
  const count = troubleCount();
  const wrong = { code: "invalid_args", message: "path is required" };
  const run = (steps: Array<[string, boolean, { code: string; message: string }?]>) => steps.map(([tool, ok, error]) => noteOutcome(count, tool, ok, error));
  expect(run([["shell", false, wrong], ["shell", false, wrong], ["read_file", false, wrong], ["shell", false, wrong], ["shell", false, wrong], ["shell", true]])).toEqual([null, null, null, null, null, null]);
  // A missing file, a timeout, an MCP server's error, a hold, your denial: any model meets them.
  const notIts = ["not_found", "timeout", "failed", "held", "denied", "too_large"].map((code) => ["shell", false, { code, message: "x" }] as [string, boolean, { code: string; message: string }]);
  expect(run([["shell", false, wrong], ["shell", false, { code: "refused", message: "guard" }], ...notIts])).toEqual([null, null, null, null, null, null, null, null]);
  expect(run([["shell", false, { code: "failed", message: "unknown tool: shel" }]])).toEqual(["tool_failures"]);
});

test("the model's own mistakes are the ones that count", () => {
  expect(["invalid_args", "refused", "use_delegate", "unknown_mention"].map((code) => modelsMistake(code, ""))).toEqual([true, true, true, true]);
  expect(["failed", "not_found", "timeout", "too_large", "held", "denied", "unreachable", "repeated_effect", undefined].map((code) => modelsMistake(code, "x"))).toEqual(Array(9).fill(false));
  expect(modelsMistake("failed", "unknown tool: foo")).toBe(true);
});
