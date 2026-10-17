import { afterEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aGroup, aMessage, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import SettingsModal from "../settings/SettingsModal.svelte";
import ChatStage from "./ChatStage.svelte";
import { focusMode } from "./focus-mode.svelte.ts";
import type { ToolStep } from "./turn-activity.ts";

const t = copyFor("zh");

afterEach(() => focusMode.set(false));

function stageWith() {
  const session = aGroup();
  const kept = [{ id: "turn-k:c1", turnId: "turn-k", name: "shell", command: "pnpm build", running: false, exitCode: 0, ok: true, durationMs: 900, text: "built" }];
  const step: ToolStep = { id: "call-1", name: "read_file", target: "src/app.ts", mcp: null, running: true, startedAt: Date.now(), exitCode: null, durationMs: null };
  const runtime = reactive(fakeRuntime({
    bots: [aBot({ model: "gpt-x" })],
    sessions: [session],
    messages: [
      aMessage({ id: "ask", session_id: session.id, kind: "user", author: "user", body: "构建", created_at: "2026-09-19T02:00:00.000Z" }),
      aMessage({ id: "ask-b", session_id: session.id, kind: "user", author: "user", body: "改过的话", edited_at: "2026-09-19T02:00:01.000Z", created_at: "2026-09-19T02:00:01.000Z" }),
      aMessage({ id: "reply", session_id: session.id, kind: "bot", author: "bot-1", turn_id: "turn-k", body: "构建好了。", created_at: "2026-09-19T02:00:02.000Z" }),
      aMessage({ id: "ask2", session_id: session.id, kind: "user", author: "user", body: "再来", created_at: "2026-09-19T02:01:00.000Z" }),
    ],
    turns: [
      aTurn({ id: "turn-k", session_id: session.id, status: "completed", trigger_message_id: "ask", created_at: "2026-09-19T02:00:00.500Z" }),
      aTurn({ id: "turn-r", session_id: session.id, status: "running", trigger_message_id: "ask2", created_at: "2026-09-19T02:01:00.500Z" }),
    ],
  }, {
    selectedId: session.id,
    commandsOf: (id: string) => (id === "turn-k" ? kept : []),
    stepOf: (id: string) => (id === "turn-r" ? step : null),
    stepsOf: (id: string) => (id === "turn-r" ? [step] : []),
  }));
  const rendered = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  return { ...rendered, runtime };
}

test("focus mode leaves out times, durations, commands and tags, and keeps what was said", () => {
  const { host, close } = stageWith();
  try {
    flushSync();
    const reply = host.querySelector('[data-message-id="reply"]')!;
    const wrap = reply.closest(".msg-wrap")!;
    // Off, as before: the tags, the command card with the time under the reply, the step and its clock.
    expect(wrap.querySelector(".model-badge")?.textContent).toBe("gpt-x");
    expect(wrap.querySelector(".bot-badge")).not.toBeNull();
    expect(reply.querySelector(".msg-foot .command-activity")).not.toBeNull();
    expect(host.querySelector(".stream-foot .stream-step")?.textContent).toBe("读取 src/app.ts");
    expect(host.querySelector(".stream-foot .duration-badge")).not.toBeNull();
    expect(host.querySelector('[data-message-id="ask"] .msg-foot .msg-time')).not.toBeNull();
    expect(host.querySelector(".segment-count-badge")).not.toBeNull();

    focusMode.set(true);
    flushSync();
    expect(wrap.querySelector(".model-badge")).toBeNull();
    expect(wrap.querySelector(".bot-badge")).toBeNull();
    // Who said it stays: a group's lines need their names.
    expect(wrap.querySelector(".sender-name")?.textContent?.trim()).toBe("Researcher");
    expect(reply.querySelector(".msg-foot")).toBeNull();
    expect(host.querySelector(".command-activity")).toBeNull();
    // The time is still there behind the hover actions.
    expect(reply.querySelector(".msg-toolbar .msg-when.is-peek .msg-time")).not.toBeNull();
    expect(reply.querySelector(".msg-toolbar .msg-when.is-peek .duration-badge")).toBeNull();
    // A working turn says that it works, not at what or for how long.
    expect(host.querySelector(".stream-foot .pulse")).not.toBeNull();
    expect(host.querySelector(".stream-foot .stream-step")?.textContent).toBe(t.sidebar.statusRunning);
    expect(host.querySelector(".stream-foot .duration-badge")).toBeNull();
    // Your lines lose their time; an edited one keeps 「已编辑」.
    expect(host.querySelector('[data-message-id="ask"] .msg-foot')).toBeNull();
    expect(host.querySelector('[data-message-id="ask-b"] .msg-foot .msg-time')).toBeNull();
    expect(host.querySelector('[data-message-id="ask-b"] .msg-foot .msg-edited')?.textContent).toBe(t.chat.edited);
    expect(host.querySelector(".segment-count-badge")).toBeNull();
    // What was said is all there.
    expect(reply.textContent).toContain("构建好了。");
    expect(host.querySelector('[data-message-id="ask2"]')?.textContent).toContain("再来");
  } finally {
    close();
  }
});

test("Settings › General turns focus mode on and off and keeps the choice", () => {
  const runtime = reactive(fakeRuntime({}, { settingsOpen: true }));
  const { host, close } = render(SettingsModal, {
    runtime, t, saveFailed: false, providerEditor: null, confirmingProvider: false, confirmingIndependent: false,
    patchImmediate: async () => true, openDeleteProviderConfirm: () => {}, closeSettings: () => {},
  });
  try {
    click(host.querySelector('[data-settings-tab="general"]'));
    const toggle = () => host.querySelector<HTMLInputElement>("#focus-mode-toggle")!;
    expect(toggle().checked).toBe(false);
    click(toggle());
    flushSync();
    expect(focusMode.on).toBe(true);
    expect(toggle().checked).toBe(true);
    expect(window.localStorage.getItem("real-bot-chat-focus")).toBe("1");
    click(toggle());
    flushSync();
    expect(focusMode.on).toBe(false);
    expect(window.localStorage.getItem("real-bot-chat-focus")).toBeNull();
  } finally {
    close();
  }
});
