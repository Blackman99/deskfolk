import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aGroup, aMessage, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";
import type { ToolStep } from "./turn-activity.ts";

const t = copyFor("zh");

function aStep(over: Partial<ToolStep> = {}): ToolStep {
  // Started just now, so no timer is shown yet.
  return { id: "call-1", name: "read_file", target: "src/app.ts", mcp: null, running: true, startedAt: Date.now(), exitCode: null, durationMs: null, ...over };
}

/** `steps` is each turn's latest step; `lists` its whole list, when a test needs more than that one. */
function stage(
  session: ReturnType<typeof aDirect>,
  turns: ReturnType<typeof aTurn>[],
  steps: Record<string, ToolStep>,
  lists: Record<string, ToolStep[]> = {},
  extra: Record<string, unknown> = {},
) {
  const runtime = reactive(fakeRuntime({
    bots: [aBot(), aBot({ id: "bot-2", name: "审片员" })],
    sessions: [session],
    messages: [aMessage({ session_id: session.id })],
    turns,
  }, {
    selectedId: session.id,
    stepOf: (id: string) => steps[id] ?? null,
    stepsOf: (id: string) => lists[id] ?? (steps[id] ? [steps[id]] : []),
    ...extra,
  }));
  const opened: string[] = [];
  const rendered = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: (id: string) => { opened.push(id); }, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  return { ...rendered, runtime, opened };
}

test("a working Bot's bubble ends on the step it is in instead of a bare 思考中", () => {
  const session = aDirect();
  const { host, close } = stage(session, [aTurn({ session_id: session.id })], { "turn-1": aStep() });
  try {
    flushSync();
    const line = host.querySelector<HTMLElement>(".is-streaming-wrap .stream-foot .stream-step");
    expect(line?.textContent).toBe("读取 src/app.ts");
    // One step and nothing it prints: opening it would only say the line again, so it is a line.
    expect(line?.tagName).toBe("SPAN");
    expect(line?.getAttribute("title")).toBe("读取 src/app.ts");
    // The line changes with every step and its timer ticks; the live region does not read it out.
    expect(line?.getAttribute("aria-live")).toBe("off");
    // Nothing about the work is left in the header: it is all at the end of the bubble.
    expect(host.querySelector(".msg-header .duration-badge")).toBeNull();
    expect(host.querySelector(".stream-foot .duration-badge")).not.toBeNull();
    // A turn that has said nothing yet is a bubble all the same, with no empty text in it.
    expect(host.querySelector(".is-streaming-wrap .streaming-cursor")).toBeNull();
    expect(host.querySelector(".attached-replying-card")).toBeNull();
  } finally {
    close();
  }
});

test("before its first step, and between steps, it is thinking", () => {
  const session = aDirect();
  const turns = [aTurn({ session_id: session.id })];
  const before = stage(session, turns, {});
  try {
    flushSync();
    expect(before.host.querySelector(".stream-foot .stream-step")?.textContent).toBe("思考中");
  } finally {
    before.close();
  }
  const after = stage(session, turns, { "turn-1": aStep({ running: false }) });
  try {
    flushSync();
    expect(after.host.querySelector(".stream-foot .stream-step")?.textContent).toBe("思考中 · 读了 src/app.ts");
  } finally {
    after.close();
  }
});

test("in a group each working Bot's bubble carries its own step", () => {
  const session = aGroup();
  const turns = [
    aTurn({ id: "turn-1", session_id: session.id, bot_id: "bot-1" }),
    aTurn({ id: "turn-2", session_id: session.id, bot_id: "bot-2", created_at: "2026-09-19T02:00:00.500Z" }),
  ];
  const { host, close } = stage(session, turns, {
    "turn-2": aStep({ id: "call-9", name: "shell", target: "ffprobe clip.mp4" }),
  });
  try {
    flushSync();
    const bubbles = [...host.querySelectorAll(".is-streaming-wrap")].map((wrap) => [
      wrap.querySelector(".sender-name")?.textContent?.trim(),
      wrap.querySelector(".stream-foot .stream-step")?.textContent,
    ]);
    // The first Bot has not started a step, so it is thinking.
    expect(bubbles).toEqual([[aBot().name, "思考中"], ["审片员", "运行 ffprobe clip.mp4"]]);
  } finally {
    close();
  }
});

test("a streaming reply that moved on to a tool call says so at its end", () => {
  const session = aDirect();
  const turns = [aTurn({ session_id: session.id, partial_text: "我先看一下源文件。" })];
  const { host, close } = stage(session, turns, { "turn-1": aStep({ name: "shell", target: "pnpm test" }) });
  try {
    flushSync();
    expect(host.querySelector(".is-streaming-wrap .stream-foot .stream-step")?.textContent?.trim()).toBe("运行 pnpm test");
    expect(host.querySelector(".is-streaming-wrap .streaming-cursor")).not.toBeNull();
  } finally {
    close();
  }
  const done = stage(session, turns, { "turn-1": aStep({ running: false }) });
  try {
    flushSync();
    expect(done.host.querySelector(".is-streaming-wrap .stream-foot .stream-step")?.textContent?.trim()).toBe("思考中 · 读了 src/app.ts");
  } finally {
    done.close();
  }
  const writing = stage(session, turns, {});
  try {
    flushSync();
    expect(writing.host.querySelector(".is-streaming-wrap .stream-foot .stream-step")?.textContent?.trim()).toBe(t.stream.streaming);
  } finally {
    writing.close();
  }
});

test("a long step shows its time apart from the text, so clipping never cuts it off", () => {
  const session = aDirect();
  const long = aStep({ name: "shell", target: "pnpm exec playwright test --project webkit", startedAt: Date.now() - 12_400 });
  const { host, close } = stage(session, [aTurn({ session_id: session.id })], { "turn-1": long });
  try {
    flushSync();
    expect(host.querySelector(".stream-foot .stream-step")?.textContent).toBe("运行 pnpm exec playwright test --project webkit");
    expect(host.querySelector(".stream-foot .stream-step-elapsed")?.textContent).toBe("12s");
  } finally {
    close();
  }
});

test("several Bots at once: each one's bubble shows its own step, said anything yet or not", () => {
  const session = aGroup();
  const turns = [
    aTurn({ id: "turn-a", session_id: session.id, bot_id: "bot-1", partial_text: "我先跑一下测试。", created_at: "2026-09-19T02:00:00.100Z" }),
    aTurn({ id: "turn-b", session_id: session.id, bot_id: "bot-2", partial_text: "我去看看片子。", created_at: "2026-09-19T02:00:00.200Z" }),
    aTurn({ id: "turn-c", session_id: session.id, bot_id: "bot-3", created_at: "2026-09-19T02:00:00.300Z" }),
  ];
  const runtime = reactive(fakeRuntime({
    bots: [aBot(), aBot({ id: "bot-2", name: "审片员" }), aBot({ id: "bot-3", name: "剪辑" })],
    sessions: [session],
    messages: [aMessage({ session_id: session.id })],
    turns,
  }, {
    selectedId: session.id,
    stepOf: (id: string) => ({
      "turn-a": aStep({ id: "a1", name: "shell", target: "pnpm test" }),
      "turn-b": aStep({ id: "b1", name: "read_file", target: "clips/c01.mp4" }),
      "turn-c": aStep({ id: "c1", name: "list_dir", target: "frames", running: false }),
    })[id] ?? null,
  }));
  const { host, close } = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  try {
    flushSync();
    const bubbles = [...host.querySelectorAll(".is-streaming-wrap")].map((wrap) => [
      wrap.querySelector(".sender-name")?.textContent?.trim(),
      wrap.querySelector(".stream-foot .stream-step")?.textContent?.trim(),
    ]);
    expect(bubbles).toEqual([
      [aBot().name, "运行 pnpm test"],
      ["审片员", "读取 clips/c01.mp4"],
      // The third has not written anything yet: a bubble all the same, with its own step.
      ["剪辑", "思考中 · 看了目录 frames"],
    ]);
    expect(host.querySelector(".attached-replying-card")).toBeNull();
  } finally {
    close();
  }
});

test("clicking the line lists only what is going on now, and clicking again folds it", () => {
  const session = aDirect();
  const list = [
    aStep({ id: "c1", target: "deliveries/report.md", running: false, durationMs: 20 }),
    aStep({ id: "c2", name: "shell", target: "pnpm test", running: false, exitCode: 1, durationMs: 12_000 }),
    aStep({ id: "c3", name: "shell", target: "pnpm build", startedAt: Date.now() - 4_000 }),
    aStep({ id: "c4", name: "read_file", target: "notes.md" }),
  ];
  const { host, close } = stage(session, [aTurn({ session_id: session.id, created_at: new Date().toISOString() })], { "turn-1": list[3]! }, { "turn-1": list });
  try {
    flushSync();
    const toggle = host.querySelector<HTMLButtonElement>("button.stream-step");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".turn-steps")).toBeNull();

    click(toggle);
    const panel = host.querySelector(".turn-steps");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.querySelector(".turn-steps-head")?.textContent).toBe(`${aBot().name} 正在做的 2 件事`);
    const rows = [...panel!.querySelectorAll(".turn-step .turn-step-text")].map((row) => row.textContent);
    // What has finished is not repeated here: the commands are in the card, the rest is done with.
    expect(rows).toEqual(["运行 pnpm build", "读取 notes.md"]);

    click(toggle);
    expect(host.querySelector(".turn-steps")).toBeNull();
  } finally {
    close();
  }
});

test("Escape inside the list folds it", () => {
  const session = aDirect();
  const { host, close } = stage(session, [aTurn({ session_id: session.id })], { "turn-1": aStep() }, { "turn-1": [aStep({ id: "r1", name: "shell", target: "pnpm build" }), aStep({ id: "r2", target: "notes.md" })] });
  try {
    flushSync();
    click(host.querySelector("button.stream-step"));
    const panel = host.querySelector(".turn-steps")!;
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(host.querySelector(".turn-steps")).toBeNull();
  } finally {
    close();
  }
});

test("before its first step there is nothing to open", () => {
  const session = aDirect();
  const { host, close } = stage(session, [aTurn({ session_id: session.id })], {});
  try {
    flushSync();
    expect(host.querySelector("button.stream-step")).toBeNull();
    expect(host.querySelector("span.stream-step")?.textContent).toBe("思考中");
  } finally {
    close();
  }
});

test("the line opens onto what a running command prints; a finished one is left to the card", () => {
  const session = aDirect();
  const list = [
    aStep({ id: "c1", name: "shell", target: "pnpm lint", running: false, exitCode: 0, durationMs: 2_000 }),
    aStep({ id: "c2", name: "shell", target: "pnpm test" }),
  ];
  const { host, close, runtime } = stage(session, [aTurn({ session_id: session.id })], { "turn-1": list[1]! }, { "turn-1": list });
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  for (const [id, text] of [["c1", "lint clean\n"], ["c2", "running 12 tests\n"]] as const) {
    runtime.activity.applyTool({ type: "tool", turn_id: "turn-1", id, name: "shell", phase: "started", command: "x" });
    runtime.activity.applyStream({ type: "stream", id: `turn-1:${id}`, offset: 0, data: b64(text) });
  }
  runtime.activityRevision += 1;
  try {
    flushSync();
    click(host.querySelector("button.stream-step"));
    const outputs = [...host.querySelectorAll(".turn-step-output")].map((node) => node.textContent);
    expect(outputs).toEqual(["running 12 tests\n"]);
    expect([...host.querySelectorAll(".turn-step-text")].map((node) => node.textContent)).toEqual(["运行 pnpm test"]);
    expect(host.querySelector(".turn-step-output-toggle")).toBeNull();
  } finally {
    close();
  }
});

test("a streaming reply's finished commands fold to one line, and stay as you left them as more come in", () => {
  const session = aDirect();
  const turn = aTurn({ session_id: session.id, partial_text: "我先跑一下检查。" });
  const { host, close, runtime } = stage(session, [turn], {});
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  runtime.activity.applyTool({ type: "tool", turn_id: turn.id, id: "c1", name: "shell", phase: "started", command: 'cd "/w/2026-10-05-x" && pnpm lint' });
  runtime.activity.applyStream({ type: "stream", id: `${turn.id}:c1`, offset: 0, data: b64("lint failed\n") });
  runtime.activity.applyTool({ type: "tool", turn_id: turn.id, id: "c1", name: "shell", phase: "exited", exit_code: 1, duration_ms: 2_000 });
  runtime.activity.applyTool({ type: "tool", turn_id: turn.id, id: "c3", name: "shell", phase: "started", command: "mkdir -p out" });
  runtime.activity.applyTool({ type: "tool", turn_id: turn.id, id: "c3", name: "shell", phase: "exited", exit_code: 0, duration_ms: 22 });
  runtime.activity.applyTool({ type: "tool", turn_id: turn.id, id: "c2", name: "shell", phase: "started", command: "pnpm test" });
  runtime.activity.applyStream({ type: "stream", id: `${turn.id}:c2`, offset: 0, data: b64("running 12 tests\n") });
  runtime.activityRevision += 1;
  const summary = () => host.querySelector<HTMLButtonElement>(".command-activity .command-summary");
  const output = () => host.querySelector(".command-activity .command-output")?.textContent ?? null;
  const lines = () => [...host.querySelectorAll<HTMLElement>(".command-activity .command-row .command-line")];
  try {
    flushSync();
    // The running one is not counted yet: it is the bubble's last line until it ends.
    expect(summary()?.getAttribute("aria-expanded")).toBe("false");
    expect(summary()?.textContent?.replace(/\s+/g, " ").trim()).toBe("2 条命令 · 1 条失败");
    expect(host.querySelector(".command-activity .command-card")).toBeNull();

    click(summary());
    // The leading cd is gone, the program is set apart, and how it ended sits on the right.
    const rows = lines().map((line) => [
      line.querySelector(".command-program")?.textContent,
      line.querySelector(".command-text")?.textContent,
      line.querySelector(".command-meta")?.textContent?.replace(/\s+/g, " ").trim(),
    ]);
    expect(rows).toEqual([
      ["pnpm", "pnpm lint", "退出码 1 2.0s"],
      ["mkdir", "mkdir -p out", "22ms"],
    ]);
    expect(lines()[0]!.getAttribute("title")).toBe('cd "/w/2026-10-05-x" && pnpm lint');
    // A command that printed nothing has nothing to open.
    expect(lines().map((line) => line.tagName)).toEqual(["BUTTON", "DIV"]);
    expect(output()).toBeNull();
    click(lines()[0]!);
    expect(output()).toBe("lint failed\n");

    // The running one ends and joins the list; the list stays open, and so does the output.
    runtime.activity.applyTool({ type: "tool", turn_id: turn.id, id: "c2", name: "shell", phase: "exited", exit_code: 0, duration_ms: 3_100 });
    runtime.activityRevision += 1;
    flushSync();
    expect(summary()?.getAttribute("aria-expanded")).toBe("true");
    expect(summary()?.textContent?.replace(/\s+/g, " ").trim()).toBe("3 条命令 · 1 条失败");
    expect(lines().map((line) => line.querySelector(".command-text")?.textContent)).toEqual(["pnpm lint", "mkdir -p out", "pnpm test"]);
    expect(output()).toBe("lint failed\n");
  } finally {
    close();
  }
});

test("with several Bots, the name still opens the profile and the step opens that Bot's list", () => {
  const session = aGroup();
  const turns = [
    aTurn({ id: "turn-1", session_id: session.id, bot_id: "bot-1" }),
    aTurn({ id: "turn-2", session_id: session.id, bot_id: "bot-2", created_at: "2026-09-19T02:00:00.500Z" }),
  ];
  const { host, close, opened, runtime } = stage(session, turns, {
    "turn-1": aStep({ id: "a1", name: "shell", target: "pnpm build" }),
    "turn-2": aStep({ id: "b1", name: "shell", target: "ffprobe clip.mp4" }),
  });
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  for (const [turnId, id] of [["turn-1", "a1"], ["turn-2", "b1"]] as const) {
    runtime.activity.applyTool({ type: "tool", turn_id: turnId, id, name: "shell", phase: "started", command: "x" });
    runtime.activity.applyStream({ type: "stream", id: `${turnId}:${id}`, offset: 0, data: b64("working\n") });
  }
  runtime.activityRevision += 1;
  try {
    flushSync();
    const bubbles = [...host.querySelectorAll(".is-streaming-wrap")];
    expect(bubbles).toHaveLength(2);
    click(bubbles[1]!.querySelector("button.sender-name"));
    expect(opened).toEqual(["bot-2"]);
    expect(host.querySelector(".turn-steps")).toBeNull();

    click(bubbles[1]!.querySelector("button.stream-step"));
    const panel = host.querySelector(".turn-steps");
    expect(panel?.querySelector(".turn-steps-head")?.textContent).toBe("审片员 正在做");
    expect(panel?.querySelector(".turn-step-text")?.textContent).toBe("运行 ffprobe clip.mp4");
    expect(bubbles[1]!.contains(panel)).toBe(true);

    // One list at a time: opening the other Bot's swaps it.
    click(bubbles[0]!.querySelector("button.stream-step"));
    expect(host.querySelectorAll(".turn-steps")).toHaveLength(1);
    expect(host.querySelector(".turn-steps-head")?.textContent).toBe(`${aBot().name} 正在做`);
  } finally {
    close();
  }
});

test("a finished turn's commands stay under its last reply, read as it comes near, and nowhere else", () => {
  const session = aDirect();
  const kept = [
    { id: "turn-k:c1", turnId: "turn-k", name: "shell", command: "pnpm install", running: false, exitCode: null, ok: false, durationMs: 120_000, text: "timed out" },
    { id: "turn-k:c2", turnId: "turn-k", name: "shell", command: "pnpm build", running: false, exitCode: 0, ok: true, durationMs: 900, text: "" },
  ];
  const runtime = reactive(fakeRuntime({
    bots: [aBot()],
    sessions: [session],
    messages: [
      aMessage({ id: "ask", session_id: session.id, kind: "user", author: "user", body: "装一下依赖再构建", created_at: "2026-09-19T02:00:00.000Z" }),
      aMessage({ id: "progress", session_id: session.id, kind: "bot", author: "bot-1", turn_id: "turn-k", body: "开始装依赖。", created_at: "2026-09-19T02:00:01.000Z" }),
      aMessage({ id: "reply", session_id: session.id, kind: "bot", author: "bot-1", turn_id: "turn-k", body: "构建好了。", created_at: "2026-09-19T02:00:02.000Z" }),
      aMessage({ id: "other", session_id: session.id, kind: "bot", author: "bot-1", turn_id: "turn-x", body: "没跑命令。", created_at: "2026-09-19T02:00:03.000Z" }),
    ],
    turns: [],
  }, {
    selectedId: session.id,
    commandsOf: (id: string) => (id === "turn-k" ? kept : []),
  }));
  const { host, close } = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  try {
    flushSync();
    const cardIn = (id: string) => host.querySelector(`[data-message-id="${id}"] .command-activity`);
    expect(cardIn("reply")).not.toBeNull();
    // The progress line shares the turn; the card would only repeat under it.
    expect(cardIn("progress")).toBeNull();
    // A turn that ran nothing has no card at all.
    expect(cardIn("other")).toBeNull();
    expect(cardIn("reply")?.querySelector(".command-summary")?.textContent?.replace(/\s+/g, " ").trim()).toBe("2 条命令 · 1 条失败");
    click(cardIn("reply")?.querySelector(".command-summary") ?? null);
    const metas = [...host.querySelectorAll('[data-message-id="reply"] .command-meta')].map((node) => node.textContent?.replace(/\s+/g, " ").trim());
    // Timed out, so no exit code: it still reads as failed.
    expect(metas).toEqual(["失败 2m0s", "900ms"]);
    expect(runtime.calls.filter((call) => call.name === "loadTurnCommands").map((call) => call.args[0]).sort()).toEqual(["turn-k", "turn-x"]);
  } finally {
    close();
  }
});

test("a Bot message ends on one line with its commands, its tag and its time; a running turn's progress line has no card", () => {
  const session = aDirect();
  const filed = (over: Record<string, unknown>) => Object.assign(aMessage({ session_id: session.id, kind: "bot", author: "bot-1", ...over }), {
    filing_state: "filed", filings: [{ task_id: "plan-a", ticket_id: null, part_key: null }],
  });
  const kept = [{ id: "turn-k:c1", turnId: "turn-k", name: "shell", command: "pnpm build", running: false, exitCode: 0, ok: true, durationMs: 900, text: "built" }];
  const runtime = reactive(fakeRuntime({
    bots: [aBot()],
    sessions: [session],
    messages: [
      aMessage({ id: "ask", session_id: session.id, kind: "user", author: "user", body: "构建", created_at: "2026-09-19T02:00:00.000Z" }),
      filed({ id: "reply", turn_id: "turn-k", body: "构建好了。", created_at: "2026-09-19T02:00:02.000Z" }),
      aMessage({ id: "ask2", session_id: session.id, kind: "user", author: "user", body: "再来", created_at: "2026-09-19T02:01:00.000Z" }),
      aMessage({ id: "progress", session_id: session.id, kind: "bot", author: "bot-1", turn_id: "turn-r", body: "开始了。", created_at: "2026-09-19T02:01:01.000Z" }),
    ],
    turns: [aTurn({ id: "turn-r", session_id: session.id, status: "running", trigger_message_id: "ask2", created_at: "2026-09-19T02:01:00.500Z" })],
  }, {
    selectedId: session.id,
    commandsOf: (id: string) => (id === "turn-k" || id === "turn-r" ? kept : []),
  }));
  const { host, close } = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  try {
    flushSync();
    const reply = host.querySelector('[data-message-id="reply"]')!;
    // Nothing about when it came is left at the top.
    const wrap = reply.closest(".msg-wrap")!;
    expect(wrap.querySelector(".msg-header .msg-time")).toBeNull();
    // The commands, the tag and the time share the commands' line.
    const head = reply.querySelector(".msg-foot .command-head")!;
    expect(head.querySelector(".command-summary")?.textContent?.replace(/\s+/g, " ").trim()).toBe("1 条命令");
    expect(head.querySelector(".attribution-chip")).not.toBeNull();
    expect(head.querySelector(".msg-time")?.textContent?.trim()).toMatch(/^\d{1,2}:\d{2}$/);
    // On the right, the time last: how long it took comes before it.
    expect(head.querySelector(".msg-when")?.lastElementChild?.classList.contains("msg-time")).toBe(true);
    // Opened, the list goes under that line, not into it.
    click(head.querySelector(".command-summary"));
    expect(head.querySelector(".command-card")).toBeNull();
    expect(reply.querySelector(".msg-foot .command-card")).not.toBeNull();

    // Still running: its commands are in its working bubble, not under the line it sent on the way.
    const progress = host.querySelector('[data-message-id="progress"]')!;
    expect(progress.querySelector(".command-activity")).toBeNull();
    // A part with the working bubble after it gives up its time line: the time is with the hover actions.
    expect(progress.querySelector(".msg-foot")).toBeNull();
    expect(progress.querySelector(".msg-toolbar .msg-when.is-peek .msg-time")?.textContent?.trim()).toMatch(/^\d{1,2}:\d{2}$/);
  } finally {
    close();
  }
});
