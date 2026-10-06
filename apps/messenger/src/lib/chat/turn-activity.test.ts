import { expect, test } from "bun:test";
import type { ToolFrame } from "@real-bot/protocol";
import { COPY } from "../copy.ts";
import { LONG_STEP_MS, MAX_STEPS, TurnActivity, describeStep, stepRow, stepText, turnSteps, type ToolStep } from "./turn-activity.ts";

const zh = COPY.zh.chat.activity;
const en = COPY.en.chat.activity;

function frame(over: Partial<ToolFrame>): ToolFrame {
  return { type: "tool", turn_id: "T", id: "call_1", name: "read_file", phase: "started", ...over };
}

function step(over: Partial<ToolStep>): ToolStep {
  return { id: "c", name: "read_file", target: null, mcp: null, running: true, startedAt: 0, exitCode: null, durationMs: null, ...over };
}

test("a turn's step is the call it is in, then the one it last finished", () => {
  const activity = new TurnActivity();
  activity.applyTool(frame({ target: "src/app.ts" }), 1000);
  expect(activity.latestFor("T")).toMatchObject({ name: "read_file", target: "src/app.ts", running: true, startedAt: 1000 });

  activity.applyTool(frame({ phase: "exited", exit_code: null }));
  expect(activity.latestFor("T")).toMatchObject({ target: "src/app.ts", running: false });

  activity.applyTool(frame({ id: "call_2", name: "shell", command: "pnpm test" }), 2000);
  expect(activity.latestFor("T")).toMatchObject({ id: "call_2", target: "pnpm test", running: true });
  expect(activity.latestFor("other")).toBeNull();
});

test("an exit for a call that is not the latest changes nothing", () => {
  const activity = new TurnActivity();
  activity.applyTool(frame({ id: "call_2" }));
  activity.applyTool(frame({ id: "call_1", phase: "exited" }));
  expect(activity.latestFor("T")?.running).toBe(true);
  activity.applyTool(frame({ turn_id: "U", phase: "exited" }));
  expect(activity.latestFor("U")).toBeNull();
});

test("an MCP call keeps its server and its own tool name; forget and clear drop turns", () => {
  const activity = new TurnActivity();
  activity.applyTool(frame({ name: "mcp_GitHub_create_issue", mcp_server: "GitHub", mcp_tool: "create-issue" }));
  expect(activity.latestFor("T")?.mcp).toEqual({ server: "GitHub", tool: "create-issue" });
  activity.applyTool(frame({ turn_id: "U" }));
  activity.forget("T");
  expect(activity.latestFor("T")).toBeNull();
  expect(activity.latestFor("U")).not.toBeNull();
  activity.clear();
  expect(activity.latestFor("U")).toBeNull();
});

test("a running step says what it is doing, and for how long once that is worth saying", () => {
  const reading = step({ target: "src/app.ts", startedAt: 0 });
  expect(describeStep(reading, zh, 500).text).toBe("读取 src/app.ts");
  expect(describeStep(reading, en, 500).text).toBe("Reading src/app.ts");
  expect(describeStep(reading, zh, 500).elapsed).toBeNull();
  // Apart from the text, so clipping a long command never cuts the time off.
  expect(describeStep(reading, zh, LONG_STEP_MS + 2500)).toMatchObject({ text: "读取 src/app.ts", elapsed: "5s" });
  expect(stepText(describeStep(step({ name: "shell", target: "pnpm build" }), zh, 125_000))).toBe("运行 pnpm build · 2m 5s");
  expect(describeStep(step({ running: false }), zh, 125_000).elapsed).toBeNull();
  expect(describeStep(step({ name: "send_message" }), zh, 0).text).toBe("发消息");
});

test("between steps it is thinking again, after what it just did", () => {
  expect(describeStep(step({ target: "a.ts", running: false }), zh, 0).text).toBe("思考中 · 读了 a.ts");
  expect(describeStep(step({ target: "a.ts", running: false }), en, 0).text).toBe("Thinking · Read a.ts");
  const failed = step({ name: "shell", target: "pnpm test", running: false, exitCode: 1 });
  expect(describeStep(failed, zh, 0).text).toBe("思考中 · 跑完 pnpm test · 失败");
  expect(describeStep({ ...failed, exitCode: 0 }, zh, 0).text).toBe("思考中 · 跑完 pnpm test");
});

test("an MCP tool names its server; a tool nobody listed still names itself", () => {
  const mcp = step({ name: "mcp_GitHub_create_issue", mcp: { server: "GitHub", tool: "create-issue" } });
  expect(describeStep(mcp, zh, 0).text).toBe("调用 GitHub · create-issue");
  expect(describeStep({ ...mcp, running: false }, en, 0).text).toBe("Thinking · Called GitHub · create-issue");
  expect(describeStep(step({ name: "brand_new_tool" }), zh, 0).text).toBe("调用 brand_new_tool");
});

test("a long subject is clipped to fit, a path from its start so the file name stays", () => {
  const path = `${"very/deep/".repeat(8)}report.md`;
  const line = describeStep(step({ target: path }), zh, 0);
  expect(line.text.startsWith("读取 …")).toBe(true);
  expect(line.text.endsWith("report.md")).toBe(true);
  expect(line.full).toBe(`读取 ${path}`);

  const command = `pnpm exec playwright test ${"--grep something ".repeat(6)}`;
  const run = describeStep(step({ name: "shell", target: `${command}\nsecond line` }), zh, 0);
  expect(run.text.startsWith("运行 pnpm exec playwright")).toBe(true);
  expect(run.text.endsWith("…")).toBe(true);
  // Its lines fold onto one: a script's first line alone said only `python3 -c "`.
  expect(run.full).not.toContain("\n");
  expect(run.full.endsWith("second line")).toBe(true);
  const script = describeStep(step({ name: "shell", target: 'cd "/w/job" && python3 -c "\nimport json\nprint(1)\n"' }), zh, 0);
  expect(script.full).toBe('运行 python3 -c " import json print(1) "');
});

test("the whole turn is kept in order, each step with how long the daemon says it ran", () => {
  const activity = new TurnActivity();
  activity.applyTool(frame({ id: "c1", target: "a.ts" }), 1000);
  activity.applyTool(frame({ id: "c1", phase: "exited", duration_ms: 40 }), 1100);
  activity.applyTool(frame({ id: "c2", name: "shell", command: "pnpm test" }), 2000);
  const steps = activity.stepsFor("T");
  expect(steps.map((s) => [s.id, s.running, s.durationMs])).toEqual([["c1", false, 40], ["c2", true, null]]);
  expect(activity.latestFor("T")?.id).toBe("c2");
  // An exit without a duration is timed by this client instead.
  activity.applyTool(frame({ id: "c2", phase: "exited", exit_code: 1 }), 2600);
  expect(activity.latestFor("T")).toMatchObject({ exitCode: 1, durationMs: 600 });
  expect(activity.stepsFor("other")).toEqual([]);
});

test("a very long turn keeps its latest steps and counts the ones it let go", () => {
  const activity = new TurnActivity();
  for (let i = 0; i < MAX_STEPS + 3; i++) activity.applyTool(frame({ id: `c${i}` }));
  expect(activity.stepsFor("T")).toHaveLength(MAX_STEPS);
  expect(activity.stepsFor("T")[0]!.id).toBe("c3");
  expect(activity.droppedFor("T")).toBe(3);
  activity.forget("T");
  expect(activity.droppedFor("T")).toBe(0);
});

test("a row in the list says the whole thing, how long it took and how it ended", () => {
  const command = "pnpm build\npnpm test";
  expect(stepRow(step({ name: "shell", target: command, running: false, exitCode: 2, durationMs: 12_300 }), zh, 0)).toEqual({
    id: "c", state: "failed", text: `跑完 ${command}`, time: "12s", exitCode: 2, shell: true,
  });
  expect(stepRow(step({ target: "a.ts", running: false, exitCode: null, durationMs: 30 }), zh, 0))
    .toMatchObject({ state: "done", text: "读了 a.ts", time: null, exitCode: null, shell: false });
  expect(stepRow(step({ target: "a.ts", startedAt: 0 }), en, 65_000)).toMatchObject({ state: "running", text: "Reading a.ts", time: "1m 5s" });
  expect(stepRow(step({ name: "mcp_x", mcp: { server: "GitHub", tool: "create-issue" }, running: false }), zh, 0).text)
    .toBe("调用了 GitHub · create-issue");
});

test("a turn that began before this client listened may be missing its first steps", () => {
  const listening = Date.parse("2026-09-19T02:00:10.000Z");
  expect(turnSteps([], 0, "2026-09-19T02:00:00.000Z", listening, zh, 0).missedStart).toBe(true);
  // A moment's disagreement between two clocks is not a gap.
  expect(turnSteps([], 0, "2026-09-19T02:00:09.000Z", listening, zh, 0).missedStart).toBe(false);
  expect(turnSteps([], 0, "2026-09-19T02:00:30.000Z", listening, zh, 0).missedStart).toBe(false);
  expect(turnSteps([step({})], 4, "2026-09-19T02:00:30.000Z", listening, zh, 0)).toMatchObject({ dropped: 4, rows: [{ id: "c" }] });
});
