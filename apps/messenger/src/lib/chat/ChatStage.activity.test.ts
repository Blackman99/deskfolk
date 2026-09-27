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

test("a thinking Bot says which step it is in instead of a bare 思考中", () => {
  const session = aDirect();
  const { host, close } = stage(session, [aTurn({ session_id: session.id })], { "turn-1": aStep() });
  try {
    flushSync();
    const line = host.querySelector<HTMLElement>(".attached-replying-card.is-single .attached-replying-text");
    expect(line?.textContent).toBe("读取 src/app.ts");
    // The tooltip has the whole subject, and says a click lists the steps.
    expect(line?.getAttribute("title")).toBe(`读取 src/app.ts\n${t.chat.activity.showSteps}`);
    // The line changes with every step and its timer ticks; the live region does not read it out.
    expect(line?.getAttribute("aria-live")).toBe("off");
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
    expect(before.host.querySelector(".attached-replying-text")?.textContent).toBe("思考中");
  } finally {
    before.close();
  }
  const after = stage(session, turns, { "turn-1": aStep({ running: false }) });
  try {
    flushSync();
    expect(after.host.querySelector(".attached-replying-text")?.textContent).toBe("思考中 · 读了 src/app.ts");
  } finally {
    after.close();
  }
});

test("in a group each thinking Bot's chip carries its own step", () => {
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
    const card = host.querySelector(".attached-replying-card.is-multiple");
    expect(card).not.toBeNull();
    const steps = [...card!.querySelectorAll(".attached-replying-step")].map((node) => node.textContent);
    // The first Bot has not started a step, so its chip is just its name.
    expect(steps).toEqual(["运行 ffprobe clip.mp4"]);
  } finally {
    close();
  }
});

test("a streaming reply that moved on to a tool call says so", () => {
  const session = aDirect();
  const turns = [aTurn({ session_id: session.id, partial_text: "我先看一下源文件。" })];
  const { host, close } = stage(session, turns, { "turn-1": aStep({ name: "shell", target: "pnpm test" }) });
  try {
    flushSync();
    const status = host.querySelector(".is-streaming-wrap .streaming-status");
    expect(status?.textContent?.trim()).toBe("运行 pnpm test");
  } finally {
    close();
  }
  const done = stage(session, turns, { "turn-1": aStep({ running: false }) });
  try {
    flushSync();
    expect(done.host.querySelector(".is-streaming-wrap .streaming-status")?.textContent?.trim()).toBe(t.stream.streaming);
  } finally {
    done.close();
  }
});

test("a long step shows its time apart from the text, so clipping never cuts it off", () => {
  const session = aDirect();
  const long = aStep({ name: "shell", target: "pnpm exec playwright test --project webkit", startedAt: Date.now() - 12_400 });
  const { host, close } = stage(session, [aTurn({ session_id: session.id })], { "turn-1": long });
  try {
    flushSync();
    expect(host.querySelector(".attached-replying-text")?.textContent).toBe("运行 pnpm exec playwright test --project webkit");
    expect(host.querySelector(".attached-replying-elapsed")?.textContent).toBe("12s");
  } finally {
    close();
  }
});

test("several Bots at once: each streaming reply and each thinking Bot shows its own step", () => {
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
      wrap.querySelector(".streaming-status")?.textContent?.trim(),
    ]);
    expect(bubbles).toEqual([
      [aBot().name, "运行 pnpm test"],
      ["审片员", "读取 clips/c01.mp4"],
    ]);
    // The third has not written anything yet: it is the pill, with its own step.
    const pill = host.querySelector(".attached-replying-card.is-single");
    expect(pill?.textContent).toContain("剪辑");
    expect(pill?.querySelector(".attached-replying-text")?.textContent).toBe("思考中 · 看了目录 frames");
  } finally {
    close();
  }
});

test("clicking the line lists every step of the turn so far, and clicking again folds it", () => {
  const session = aDirect();
  const list = [
    aStep({ id: "c1", target: "deliveries/report.md", running: false, durationMs: 20 }),
    aStep({ id: "c2", name: "shell", target: "pnpm test", running: false, exitCode: 1, durationMs: 12_000 }),
    aStep({ id: "c3", name: "shell", target: "pnpm build", startedAt: Date.now() - 4_000 }),
  ];
  const { host, close } = stage(session, [aTurn({ session_id: session.id, created_at: new Date().toISOString() })], { "turn-1": list[2]! }, { "turn-1": list });
  try {
    flushSync();
    const toggle = host.querySelector<HTMLButtonElement>("button.attached-replying-text");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".turn-steps")).toBeNull();

    click(toggle);
    const panel = host.querySelector(".turn-steps");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.querySelector(".turn-steps-head")?.textContent).toBe(`${aBot().name} 这一轮 · 3 步`);
    const rows = [...panel!.querySelectorAll(".turn-step")].map((row) => [
      row.className.match(/is-(running|done|failed)/)?.[1],
      row.querySelector(".turn-step-text")?.textContent,
      row.querySelector(".turn-step-meta")?.textContent?.replace(/\s+/g, " ").trim(),
    ]);
    expect(rows).toEqual([
      ["done", "读了 deliveries/report.md", ""],
      ["failed", "跑完 pnpm test", "退出码 1 12s"],
      ["running", "运行 pnpm build", "4s"],
    ]);
    // It began after this page was listening, so nothing is said about missing steps.
    expect(panel?.querySelector(".turn-steps-note")).toBeNull();

    click(toggle);
    expect(host.querySelector(".turn-steps")).toBeNull();
  } finally {
    close();
  }
});

test("Escape inside the list folds it", () => {
  const session = aDirect();
  const { host, close } = stage(session, [aTurn({ session_id: session.id })], { "turn-1": aStep() });
  try {
    flushSync();
    click(host.querySelector("button.attached-replying-text"));
    const panel = host.querySelector(".turn-steps")!;
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(host.querySelector(".turn-steps")).toBeNull();
  } finally {
    close();
  }
});

test("a turn that began before the page connected says its first steps may be missing", () => {
  const session = aDirect();
  const turn = aTurn({ session_id: session.id, created_at: "2026-09-19T02:00:00.000Z" });
  const { host, close } = stage(session, [turn], { "turn-1": aStep() }, {}, { listeningSince: Date.parse("2026-09-19T02:05:00.000Z") });
  try {
    flushSync();
    click(host.querySelector("button.attached-replying-text"));
    expect(host.querySelector(".turn-steps-note")?.textContent).toBe(t.chat.activity.missedStart);
  } finally {
    close();
  }
});

test("before its first step there is nothing to open", () => {
  const session = aDirect();
  const { host, close } = stage(session, [aTurn({ session_id: session.id })], {});
  try {
    flushSync();
    expect(host.querySelector("button.attached-replying-text")).toBeNull();
    expect(host.querySelector("span.attached-replying-text")?.textContent).toBe("思考中");
  } finally {
    close();
  }
});

test("a command's output shows while it runs, and opens on demand once it has finished", () => {
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
  try {
    flushSync();
    click(host.querySelector("button.attached-replying-text"));
    const outputs = () => [...host.querySelectorAll(".turn-step-output")].map((node) => node.textContent);
    expect(outputs()).toEqual(["running 12 tests\n"]);
    const show = host.querySelector<HTMLButtonElement>(".turn-step-output-toggle");
    expect(show?.textContent).toBe("输出");
    click(show);
    expect(outputs()).toEqual(["lint clean\n", "running 12 tests\n"]);
    expect(show?.getAttribute("aria-expanded")).toBe("true");
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
  const { host, close, opened } = stage(session, turns, {
    "turn-1": aStep({ id: "a1", target: "notes.md" }),
    "turn-2": aStep({ id: "b1", name: "shell", target: "ffprobe clip.mp4" }),
  });
  try {
    flushSync();
    const members = [...host.querySelectorAll(".attached-replying-member")];
    expect(members).toHaveLength(2);
    click(members[1]!.querySelector("button.attached-replying-chip"));
    expect(opened).toEqual(["bot-2"]);
    expect(host.querySelector(".turn-steps")).toBeNull();

    click(members[1]!.querySelector("button.attached-replying-step"));
    const panel = host.querySelector(".turn-steps");
    expect(panel?.querySelector(".turn-steps-head")?.textContent).toBe("审片员 这一轮 · 1 步");
    expect(panel?.querySelector(".turn-step-text")?.textContent).toBe("运行 ffprobe clip.mp4");
    expect(members[1]!.classList.contains("is-open")).toBe(true);

    // One list at a time: opening the other Bot's swaps it.
    click(members[0]!.querySelector("button.attached-replying-step"));
    expect(host.querySelectorAll(".turn-steps")).toHaveLength(1);
    expect(host.querySelector(".turn-steps-head")?.textContent).toBe(`${aBot().name} 这一轮 · 1 步`);
  } finally {
    close();
  }
});
