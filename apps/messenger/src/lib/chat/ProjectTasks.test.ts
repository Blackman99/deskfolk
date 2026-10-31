import { expect, test } from "bun:test";
import type { AgentRun, AgentRunTask, AgentTask, AgentTaskDetail, Message } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aMessage, aProjectSession, anAgentRun, fakeRuntime } from "../test-fixtures.ts";
import { fakeApi } from "../test-mocks.ts";
import { settle } from "../test-async.ts";
import { click, press, render } from "../test-render.ts";
import { agentRunStatus } from "../sidebar/session-status.ts";
import ProjectChat from "./ProjectChat.svelte";
import { isCommandTask, placeTasks, runningCall, sessionTasks, taskCommandRow, taskStepRow, trailBlocks } from "./project-tasks.ts";

const t = copyFor("zh");

function aTask(over: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "b1", tool_use_id: "toolu_b1", kind: "shell", status: "running", description: "开发服务器", command: "npm run dev", agent_type: null, activity: null, summary: null,
    tool_uses: null, tokens: null, started_at: "2026-10-31T01:00:00.000Z", ended_at: null, output_file: null, ...over,
  };
}

const reply = (over: Partial<Message> = {}) => aMessage({ id: "m1", session_id: "proj-1", kind: "bot", author: "agent", body: "起来了", created_at: "2026-10-31T01:00:05.000Z", ...over });

function setup(run: AgentRun | null, opts: { earlier?: AgentRunTask[]; detail?: (run: string, task: string) => Partial<AgentTaskDetail>; messages?: Message[]; stubs?: Record<string, unknown> } = {}) {
  const reads: string[] = [];
  const client = fakeApi({
    projectTasks: async () => opts.earlier ?? [],
    agentTaskDetail: async (runId: string, taskId: string) => {
      reads.push(taskId);
      return { task: aTask({ id: taskId }), output: null, output_bytes: null, prompt: null, model: null, steps: [], ...opts.detail?.(runId, taskId) } as AgentTaskDetail;
    },
  });
  const session = aProjectSession();
  const runtime = fakeRuntime({ sessions: [session], messages: opts.messages ?? [reply()], agentRuns: run ? { "proj-1": run } : {} }, opts.stubs ?? {});
  Object.assign(runtime, { client, connection: "connected" });
  const view = render(ProjectChat, { runtime, t, selected: session, onOpenArtifact: () => {} });
  return { ...view, runtime, reads };
}

const bubble = (host: Element) => host.querySelector('[data-line="working"]');
const toggle = (host: Element) => host.querySelector("[data-project-steps-toggle]");

test("while only its tasks run the working bubble stays, says so, and opens onto what is going on with what it prints", async () => {
  const { host, close } = setup(anAgentRun({ idle: true, tasks: [aTask()] }), { detail: () => ({ output: "listening on 3000\n", output_bytes: 18 }) });
  await settle();
  expect(bubble(host)).not.toBeNull();
  expect(toggle(host)?.textContent).toContain("1 个后台任务运行中");
  // Folded until you ask, as a Bot's.
  expect(host.querySelector(".turn-steps")).toBeNull();
  click(toggle(host));
  await settle();
  const list = host.querySelector(".turn-steps");
  expect(list?.textContent).toContain("Claude Code 正在做");
  expect(list?.textContent).toContain("后台运行 npm run dev");
  expect(list?.querySelector(".turn-step-output")?.textContent).toContain("listening on 3000");
  press(list!, "Escape");
  await settle();
  expect(host.querySelector(".turn-steps")).toBeNull();
  close();
});

test("the output is read only while that list is open", async () => {
  const { host, reads, close } = setup(anAgentRun({ idle: true, tasks: [aTask()] }));
  await settle();
  expect(reads).toEqual([]);
  click(toggle(host));
  await settle();
  expect(reads).toEqual(["b1"]);
  close();
});

test("the composer's Stop is the only one: with tasks going it is a menu of everything or one of them", async () => {
  const { host, runtime, close } = setup(anAgentRun({ idle: true, tasks: [aTask(), aTask({ id: "m1", tool_use_id: "toolu_m1", kind: "monitor", description: "盯日志" })] }));
  await settle();
  expect(bubble(host)?.querySelector("[data-task-stop]")).toBeNull();
  expect(host.querySelector(".composer-action.stop")).toBeNull();
  click(host.querySelector(".stop-menu-trigger"));
  await settle();
  const items = [...host.querySelectorAll<HTMLButtonElement>('.stop-menu [role="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual(["全部停下", "停下「开发服务器」", "停下「盯日志」"]);
  click(items[2]);
  await settle();
  expect(runtime.calls.filter((call) => call.name === "stopAgentTask").map((call) => call.args)).toEqual([["run-1", "m1"]]);
  click(host.querySelector(".stop-menu-trigger"));
  await settle();
  click(host.querySelector('.stop-menu [role="menuitem"]'));
  await settle();
  expect(runtime.calls.filter((call) => call.name === "stopAgentRun").map((call) => call.args)).toEqual([["run-1"]]);
  close();
});

test("no tasks going: the one Stop a direct has, and no menu", async () => {
  const { host, close } = setup(anAgentRun({ tasks: [aTask({ status: "completed", ended_at: "2026-10-31T01:00:02.000Z" })] }));
  await settle();
  expect(host.querySelector(".stop-menu")).toBeNull();
  expect(host.querySelector(".composer-action.stop")).not.toBeNull();
  close();
});

test("a finished command joins the bubble's command card with its output, once and not twice", async () => {
  const done = aTask({ status: "completed", summary: 'Background command "x" completed (exit code 0)', ended_at: "2026-10-31T01:00:02.000Z" });
  const { host, runtime, close } = setup(anAgentRun({ tasks: [done] }), { earlier: [{ ...done, run_id: "run-1", output: "all good\n" }] });
  runtime.activity.applyTool({ type: "tool", turn_id: "run-1", id: "toolu_b1", name: "Bash", phase: "started", command: "npm run dev" });
  runtime.activity.applyTool({ type: "tool", turn_id: "run-1", id: "toolu_b1", name: "Bash", phase: "exited", command: "npm run dev", exit_code: 0 });
  runtime.activityRevision += 1;
  await settle();
  const card = bubble(host)?.querySelector(".command-activity");
  expect(card?.textContent).toContain("1 条命令");
  click(card?.querySelector("button"));
  await settle();
  expect(card?.querySelectorAll(".command-row")).toHaveLength(1);
  click(card?.querySelector(".command-row button"));
  await settle();
  expect(card?.querySelector(".command-output")?.textContent).toContain("all good");
  close();
});

test("a run over: its commands stay folded under the reply of the turn that started them, a stopped one saying so", async () => {
  const { host, close } = setup(anAgentRun({ status: "completed", tasks: [] }), {
    messages: [reply({ id: "m1", body: "启动了" }), reply({ id: "m2", body: "都结束了", created_at: "2026-10-31T01:05:00.000Z" })],
    earlier: [
      { ...aTask({ status: "stopped", ended_at: "2026-10-31T01:00:09.000Z" }), run_id: "run-0", output: "tick\n[killed]\n" },
      { ...aTask({ id: "b2", tool_use_id: "toolu_b2", command: "false", status: "failed", summary: "failed with exit code 3", ended_at: "2026-10-31T01:00:09.000Z" }), run_id: "run-0", output: null },
    ],
  });
  await settle();
  expect(bubble(host)).toBeNull();
  const line = (id: string) => host.querySelector(`[data-message-id="${id}"]`)!;
  expect(line("m2").querySelector(".command-activity")).toBeNull();
  const card = line("m1").querySelector(".command-activity")!;
  expect(card.textContent).toContain("2 条命令");
  expect(card.textContent).toContain("1 条失败");
  // The time sits on the card's line, as on a Bot's reply.
  expect(card.querySelector(".command-beside .time")).not.toBeNull();
  click(card.querySelector(".command-summary"));
  await settle();
  const rows = [...card.querySelectorAll<HTMLElement>(".command-row")];
  expect(rows[0]!.textContent).toContain("已停止");
  expect(rows[1]!.textContent).toContain("退出码 3");
  // A command with no output left is a plain line, as a Bot's is.
  expect(rows[0]!.querySelector("button")).not.toBeNull();
  expect(rows[1]!.querySelector("button")).toBeNull();
  close();
});

test("a subagent is a way in under the line that sent it, and opens as a popup with what it was asked, said and did", async () => {
  const sub = aTask({ id: "a1", tool_use_id: "toolu_a1", kind: "subagent", description: "查文档", command: null, agent_type: "Explore", tool_uses: 2, tokens: 900 });
  const { host, reads, close } = setup(anAgentRun({ idle: true, tasks: [sub] }), {
    detail: () => ({
      prompt: "找到配置项",
      model: "claude-haiku-5-5",
      steps: [
        { kind: "say", at: "t", text: "**先**看目录" },
        { kind: "call", id: "c1", at: "t", tool: "Bash", label: "Bash ls", ok: true, duration_ms: 1500, output: "a.txt" },
        { kind: "call", id: "c2", at: "t", tool: "Read", label: "Read a.txt", ok: null, duration_ms: 0, output: null },
      ],
    }),
  });
  await settle();
  const line = host.querySelector('[data-message-id="m1"]')!;
  const chip = line.querySelector<HTMLElement>('[data-subagent="a1"]')!;
  expect(chip.textContent).toContain("查文档");
  expect(line.textContent).toContain("运行中");
  expect(reads).toEqual([]);
  click(chip);
  await settle();
  const dialog = host.querySelector('[data-subagent-dialog="a1"]')!;
  expect(dialog.querySelector("[data-subagent-prompt]")?.textContent).toBe("找到配置项");
  expect(dialog.textContent).toContain("Explore · claude-haiku-5-5 · 2 次工具调用 · 900 tokens");
  expect(dialog.querySelector(".subagent-say strong")?.textContent).toBe("先");
  // Its finished calls folded, as a Bot's commands; the one it is on is the last line.
  const calls = dialog.querySelector(".command-activity")!;
  expect(calls.textContent).toContain("1 次工具调用");
  expect(calls.textContent).not.toContain("Bash ls");
  expect(dialog.querySelector(".subagent-step")?.textContent).toBe("Read a.txt");
  // Yours to read: Stop is in the composer.
  expect(dialog.querySelector("[data-task-stop], .stop-menu")).toBeNull();
  press(dialog, "Escape");
  await settle();
  expect(host.querySelector("[data-subagent-dialog]")).toBeNull();
  close();
});

test("a subagent going on is in the list too, and opens from there; one with no line yet waits in the bubble", async () => {
  const sub = aTask({ id: "a1", tool_use_id: "toolu_a1", kind: "subagent", description: "查文档", command: null, activity: "Reading a.txt", started_at: "2026-10-31T02:00:00.000Z" });
  const { host, close } = setup(anAgentRun({ tasks: [sub] }));
  await settle();
  expect(host.querySelector('[data-message-id="m1"] [data-subagent]')).toBeNull();
  expect(bubble(host)?.querySelector('[data-subagent="a1"]')).not.toBeNull();
  click(toggle(host));
  await settle();
  const row = host.querySelector<HTMLButtonElement>(".turn-steps button.turn-step-text")!;
  expect(row.textContent).toBe("子代理 查文档 · Reading a.txt");
  click(row);
  await settle();
  expect(host.querySelector('[data-subagent-dialog="a1"]')).not.toBeNull();
  close();
});

test("a card waiting on you still shows while only tasks run, and the row says background", async () => {
  const { host, close } = setup(anAgentRun({ status: "waiting_approval", idle: true, approval: { kind_key: "shell", target: "/x", summary: "shell ls" }, tasks: [aTask()] }));
  await settle();
  expect(host.querySelector("[data-agent-approval]")).not.toBeNull();
  close();
  const labels = { running: "思考中", replying: "回复中", waitingApproval: "待审批", waitingAsk: "", failed: "", interrupted: "", idle: "", background: "后台任务运行中" };
  expect(agentRunStatus(anAgentRun({ idle: true }), labels)).toEqual({ kind: "running", label: "后台任务运行中", isBusy: true });
  expect(agentRunStatus(anAgentRun({ idle: false }), labels)?.label).toBe("思考中");
});

test("a task's call is not the agent's step: the foot line says what the agent itself is doing", async () => {
  const session = aProjectSession();
  const runtime = fakeRuntime({ sessions: [session], messages: [], agentRuns: { "proj-1": anAgentRun({ tasks: [aTask()] }) } });
  (runtime as unknown as { stepOf: (id: string) => unknown }).stepOf = () => ({ id: "toolu_b1", name: "Bash", target: "npm run dev", mcp: null, startedAt: Date.now(), running: true, exitCode: null });
  const { host, close } = render(ProjectChat, { runtime, t, selected: session, onOpenArtifact: () => {} });
  await settle();
  expect(host.querySelector(".stream-step")?.textContent).not.toContain("npm run dev");
  close();
});

test("each task's place, the list's order and its rows", () => {
  const task = (id: string, started: string, run = "old", over: Partial<AgentTask> = {}): AgentRunTask => ({ ...aTask({ id, started_at: started, ...over }), run_id: run });
  const lines = [{ id: "l1", created_at: "2026-10-31T01:00:00.000Z" }, { id: "l2", created_at: "2026-10-31T02:00:00.000Z" }];
  const places = placeTasks([
    task("before", "2026-10-31T00:59:00.000Z"),
    task("between", "2026-10-31T01:30:00.000Z"),
    task("after", "2026-10-31T03:00:00.000Z"),
    task("waits", "2026-10-31T03:00:00.000Z", "now"),
  ], lines, "now", null);
  expect(places.byLine.get("l1")?.map((row) => row.id)).toEqual(["before"]);
  // After the last line, a finished run's takes it; the live run's has its line yet to come.
  expect(places.byLine.get("l2")?.map((row) => row.id)).toEqual(["between", "after"]);
  expect(places.bubble.map((row) => row.id)).toEqual(["waits"]);
  expect(placeTasks([task("x", "2026-10-31T00:00:00.000Z")], [], null, null).end.map((row) => row.id)).toEqual(["x"]);
  // Older than what is loaded: its line is not here yet, and no later line takes it.
  expect(placeTasks([task("x", "2026-10-31T00:00:00.000Z")], lines, null, "2026-10-31T00:30:00.000Z").byLine.size).toBe(0);

  const run = anAgentRun({ id: "now", tasks: [aTask({ id: "y", started_at: "2026-10-31T03:00:00.000Z" })] });
  const read = [{ ...aTask({ id: "y", status: "completed" }), run_id: "now", output: "out" }, task("z", "2026-10-31T02:00:00.000Z")];
  // The run's own comes from its events, what it printed from the read.
  expect(sessionTasks(run, read).map((row) => [row.id, row.status, row.output ?? null])).toEqual([["z", "running", null], ["y", "running", "out"]]);

  expect(isCommandTask({ kind: "monitor" })).toBe(true);
  expect(isCommandTask({ kind: "subagent" })).toBe(false);
  const row = (over: Partial<AgentRunTask>) => taskCommandRow({ ...aTask(), run_id: "r", ...over }, "已停止");
  expect(row({ kind: "monitor", command: "tail -f x" }).command).toBe("Monitor tail -f x");
  expect(row({ status: "failed", summary: "failed with exit code 3", ended_at: "2026-10-31T01:00:02.000Z" })).toMatchObject({ exitCode: 3, ok: false, durationMs: 2000, running: false });
  expect(row({ status: "stopped" })).toMatchObject({ endedAs: "已停止" });
  expect(row({ status: "completed", output: "hi" })).toMatchObject({ ok: true, text: "hi" });
  expect(taskStepRow(aTask(), "后台运行", Date.parse("2026-10-31T01:00:03.000Z"))).toEqual({ id: "b1", text: "后台运行 npm run dev", time: "3.0s", shell: true });
  const open = () => {};
  expect(taskStepRow(aTask({ kind: "subagent", command: null, description: "查", activity: null }), "子代理", 0, open)).toMatchObject({ text: "子代理 查", shell: false, open });

  const blocks = trailBlocks([
    { kind: "say", at: "t", text: "a" },
    { kind: "call", id: "c1", at: "t", tool: "Bash", label: "Bash ls", ok: true, duration_ms: 5, output: "x" },
    { kind: "call", id: "c2", at: "t", tool: "Read", label: "Read y", ok: false, duration_ms: 0, output: null },
    { kind: "say", at: "t", text: "b" },
  ]);
  expect(blocks.map((block) => block.kind)).toEqual(["say", "calls", "say"]);
  expect(blocks[1]).toMatchObject({ rows: [{ command: "Bash ls", ok: true, durationMs: 5, text: "x" }, { command: "Read y", ok: false, durationMs: null, text: "" }] });
  expect(runningCall([{ kind: "call", id: "c", at: "t", tool: "R", label: "Read y", ok: null, duration_ms: 0, output: null }])).toBe("Read y");
  expect(runningCall([{ kind: "say", at: "t", text: "a" }])).toBeNull();
});
