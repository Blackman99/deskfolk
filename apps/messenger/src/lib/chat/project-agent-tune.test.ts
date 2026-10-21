import { expect, test } from "bun:test";
import type { ClaudeCodeModel } from "@real-bot/protocol";
import { effortOn, effortRows, effortsShown, tunePatch } from "./project-agent-tune.ts";

const list: ClaudeCodeModel[] = [
  { value: "default", display_name: "Default (recommended)", description: "Opus 5.5", resolved_model: "claude-opus-5-5", efforts: ["low", "high"] },
  { value: "haiku", display_name: "Haiku 5.5", description: "Fastest", resolved_model: "claude-haiku-5-5", efforts: [] },
];
const now = { account: "/b", model: "", effort: "high" };

test("a pick changes only what differs along its path, in one change", () => {
  expect(tunePatch(now, { account: "/b" }, list)).toBeNull();
  expect(tunePatch(now, { account: "" }, list)).toEqual({ config_dir: null });
  expect(tunePatch(now, { account: "", model: "" }, list)).toEqual({ config_dir: null });
  expect(tunePatch(now, { account: "/b", model: "", effort: "low" }, list)).toEqual({ effort: "low" });
  expect(tunePatch(now, { account: "/b", model: "", effort: "" }, list)).toEqual({ effort: null });
});

test("a model picked without a level keeps the session's only if it takes it", () => {
  expect(tunePatch(now, { account: "/b", model: "haiku" }, list)).toEqual({ model: "haiku", effort: null });
  expect(tunePatch({ ...now, model: "haiku" }, { account: "/b", model: "" }, list)).toEqual({ model: null });
  expect(tunePatch(now, { account: "/b", model: "haiku", effort: "" }, list)).toEqual({ model: "haiku", effort: null });
  // Before the list comes every level counts as taken.
  expect(tunePatch(now, { account: "/b", model: "opus" }, null)).toEqual({ model: "opus" });
});

test("the levels a model takes: the default first, one set already that it does not take stays", () => {
  const levels = { low: "低", high: "高" };
  expect(effortRows(list, "", "", "默认思考", levels).map((row) => row.label)).toEqual(["默认思考", "低", "高"]);
  expect(effortRows(list, "haiku", "high", "默认思考", levels).map((row) => row.value)).toEqual(["", "high"]);
  expect(effortsShown(list, "haiku", "")).toBe(false);
  expect(effortsShown(list, "haiku", "high")).toBe(true);
  expect(effortOn(list, "haiku", "high")).toBe("");
  expect(effortOn(list, "", "high")).toBe("high");
});
