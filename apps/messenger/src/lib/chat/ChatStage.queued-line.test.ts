/**
 * A line of yours no Bot has read yet (ADR 0069): the row under it says where it waits and offers
 * 直接插入 while its Bot works or a stop holds it, and 撤回 until a Bot reads it; a line taken back shows that, with
 * 重新编辑 to put its words back in the box.
 */
import { expect, test } from "bun:test";
import type { BotRunner, Message, MessageDelivery, SessionSummary, Turn } from "@real-bot/protocol";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aMessage, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";

const t = copyFor("zh");

function stage(messages: Message[], opts: { turns?: Turn[]; queuedLineActions?: boolean; runner?: BotRunner | null; session?: SessionSummary } = {}) {
  const session = opts.session ?? aDirect();
  const lines = messages.map((message) => ({ ...message, session_id: session.id }));
  const turns = (opts.turns ?? []).map((turn) => ({ ...turn, session_id: session.id }));
  const runtime = reactive(fakeRuntime({
    bots: [aBot({ id: "bot-1", runner: opts.runner ?? null })], sessions: [session], messages: lines, turns,
    messageEdits: true, queuedLineActions: opts.queuedLineActions ?? true,
  }, { selectedId: session.id }));
  const view = render(ChatStage, {
    runtime, t, selected: session,
    onOpenProfile: () => {}, onOpenArtifact: () => {}, onCreateBot: () => {},
  });
  const segment = (id: string) => view.host.querySelector(`[data-message-id="${id}"]`)!;
  return { ...view, runtime, session, segment };
}

const waiting = (state: MessageDelivery["state"] = "queued", over: Partial<Message> = {}) =>
  aMessage({
    id: "line-1", kind: "user", author: "user", body: "模型要用真一点的", created_at: "2026-10-08T03:41:52.000Z",
    delivery: { bot_id: "bot-1", state, hop: null, note: null }, ...over,
  });

const working = () => aTurn({ id: "turn-1", bot_id: "bot-1", status: "running", trigger_message_id: "opener" });

test("a line waiting for its working Bot's next step says so, and can be read now or taken back", () => {
  const s = stage([waiting()], { turns: [working()] });
  try {
    const row = s.segment("line-1").querySelector(".msg-queued-row")!;
    expect(row.textContent).toContain(t.chat.queuedNextStep);
    click(buttonByText(row as HTMLElement, t.chat.insertNow));
    click(buttonByText(row as HTMLElement, t.chat.withdrawLine));
    flushSync();
    const calls = s.runtime.calls.filter((call) => call.name === "insertLine" || call.name === "withdrawLine");
    expect(calls.map((call) => [call.name, call.args[0], (call.args[1] as Message).id])).toEqual([
      ["insertLine", s.session.id, "line-1"],
      ["withdrawLine", s.session.id, "line-1"],
    ]);
  } finally {
    s.close();
  }
});

test("what 直接插入 cuts is said for who runs the Bot: Claude Code stops a running command too", () => {
  const agent = stage([waiting()], { turns: [working()], runner: "claude_code" });
  try {
    expect(buttonByText(agent.segment("line-1") as HTMLElement, t.chat.insertNow).title).toBe(t.chat.insertNowAgentTitle);
  } finally {
    agent.close();
  }
  const loop = stage([waiting()], { turns: [working()] });
  try {
    expect(buttonByText(loop.segment("line-1") as HTMLElement, t.chat.insertNow).title).toBe(t.chat.insertNowLoopTitle);
  } finally {
    loop.close();
  }
});

test("any other local agent cuts a step short the same way, except Antigravity's print mode, where the line waits (ADR 0079)", () => {
  for (const runner of ["codex", "grok", "opencode", "zcode", "custom"] as const) {
    const agent = stage([waiting()], { turns: [working()], runner });
    try {
      expect(buttonByText(agent.segment("line-1") as HTMLElement, t.chat.insertNow).title).toBe(t.chat.insertNowAgentTitle);
    } finally {
      agent.close();
    }
  }
  const agy = stage([waiting()], { turns: [working()], runner: "antigravity" });
  try {
    expect(buttonByText(agy.segment("line-1") as HTMLElement, t.chat.insertNow).title).toBe(t.chat.insertNowWaitsTitle);
  } finally {
    agy.close();
  }
});

test("held by a stop it can be read now, lifting the Stop, or taken back; waiting for the Bot's next turn, only taken back", () => {
  const held = stage([waiting("held")], { turns: [] });
  try {
    const row = held.segment("line-1").querySelector(".msg-queued-row")!;
    expect(row.textContent).toContain(t.chat.queuedHeld);
    expect(buttonByText(row as HTMLElement, t.chat.insertNow).title).toBe(t.chat.insertNowHeldTitle);
    expect(row.textContent).toContain(t.chat.withdrawLine);
  } finally {
    held.close();
  }
  const later = stage([waiting()], { turns: [] });
  try {
    const row = later.segment("line-1").querySelector(".msg-queued-row")!;
    expect(row.textContent).toContain(t.chat.queuedItsTurn);
    expect(row.textContent).not.toContain(t.chat.insertNow);
  } finally {
    later.close();
  }
});

test("a line a Bot has read, or one from an older daemon, has no row", () => {
  const read = stage([waiting("adopted")], { turns: [working()] });
  try {
    expect(read.segment("line-1").querySelector(".msg-queued-row")).toBeNull();
  } finally {
    read.close();
  }
  const older = stage([waiting()], { turns: [working()], queuedLineActions: false });
  try {
    expect(older.segment("line-1").querySelector(".msg-queued-row")).toBeNull();
  } finally {
    older.close();
  }
});

test("a line taken back shows that instead of the bubble, and 重新编辑 puts its words back in the box", () => {
  const s = stage([waiting("withdrawn", { withdrawn_at: "2026-10-08T03:42:10.000Z" })]);
  try {
    const segment = s.segment("line-1");
    expect(segment.querySelector(".msg")).toBeNull();
    expect(segment.querySelector(".msg-withdrawn")!.textContent).toContain(t.chat.lineWithdrawn);
    expect(segment.textContent).not.toContain("模型要用真一点的");
    click(buttonByText(segment as HTMLElement, t.chat.reEditLine));
    flushSync();
    const refill = s.runtime.calls.filter((call) => call.name === "refillLine");
    expect(refill.map((call) => [call.args[0], (call.args[1] as Message).id, call.args[2]])).toEqual([[s.session.id, "line-1", { append: true }]]);
  } finally {
    s.close();
  }
});

test("what came of the press is said under the line", () => {
  const s = stage([waiting()], { turns: [working()] });
  try {
    s.runtime.sessionView(s.session.id).lineNote = { id: "line-1", code: "already_read" };
    flushSync();
    expect(s.segment("line-1").querySelector(".msg-line-note")!.textContent).toBe(t.chat.lineAlreadyRead);
    s.runtime.sessionView(s.session.id).lineNote = { id: "line-1", code: "held" };
    flushSync();
    expect(s.segment("line-1").querySelector(".msg-line-note")!.textContent).toBe(t.chat.lineHeld);
    s.runtime.sessionView(s.session.id).lineAction = { id: "line-1", kind: "withdraw" };
    flushSync();
    for (const button of s.segment("line-1").querySelectorAll<HTMLButtonElement>(".msg-queued-row button")) expect(button.disabled).toBe(true);
  } finally {
    s.close();
  }
});
