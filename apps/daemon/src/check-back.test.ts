import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientEvent } from "@real-bot/protocol";
import type { ChatMessage, CompletionOk } from "./completions";
import { SITUATION_HEADING } from "./context";
import { startScheduler } from "./scheduler";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";

function call(name: string, args: Record<string, unknown>): CompletionOk {
  return { ok: true, content: "", toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }], finishReason: "tool_calls", hadChoices: true, usage: null, missingReason: null };
}

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

function textOf(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

test("a Bot books a check-back, the scheduler wakes it in the same job with its note, and the block names the request", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-check-back-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const seen: ChatMessage[][] = [];
  const shown: ClientEvent[] = [];
  store.onCommit((event) => shown.push(event));
  let completed = 0;
  const waiters: Array<() => void> = [];
  const nextCompletion = () => new Promise<void>((resolve) => waiters.push(resolve));
  const engine = createTurnEngine({
    store,
    publish(event) {
      shown.push(event);
      if (event.event === "turn.upsert" && event.status === "completed") {
        completed += 1;
        for (const wake of waiters.splice(0)) wake();
      }
    },
    completions: {
      async complete(request) {
        seen.push(request.messages);
        const trigger = request.messages.find((m) => m.role === "user" && textOf(m).includes("（本轮触发）"));
        if (textOf(trigger!).includes("回看：")) return say("回看：report.md 还没有，我现在写。");
        const results = request.messages.filter((m) => m.role === "tool");
        if (results.length === 0) return call("check_back", { after_minutes: 5, note: "看 report.md 写好没，没有就自己写" });
        return say("五分钟后我回来看。");
      },
      async judge() {
        throw new Error("direct turns do not judge");
      },
    },
  });
  const scheduler = startScheduler({ store, engine, intervalMs: 3_600_000, now: () => new Date() });
  try {
    await store.patchSettings({ workspace_path: root, endpoint_base_url: "http://127.0.0.1:1/v1", endpoint_api_key: "fixture", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const session = writer.direct_session.id;
    const trigger = store.insertMessage({ sessionId: session, kind: "user", author: "user", body: "写一份周报，交到 report.md" });
    const first = nextCompletion();
    await engine.handleInboundMessage(trigger, { fromUser: true });
    await first;

    // The appointment is on the turn that booked it, in that turn's job, and the Bot was told when.
    const booked = store.pendingCheckBack(writer.bot.id, session)!;
    expect(booked.note).toBe("看 report.md 写好没，没有就自己写");
    const booking = store.getTurn(booked.turn_id!);
    expect(booking.status).toBe("completed");
    expect(booked.task_id).toBe(booking.task_id!);
    expect(textOf(seen[1]!.find((m) => m.role === "tool")!)).toContain('"after_minutes":5');
    expect(store.getCheckBack(booked.id).fired_at).toBeNull();

    // Six minutes later the scheduler's tick wakes the Bot with its own note as the trigger.
    const second = nextCompletion();
    scheduler.tick(new Date(Date.now() + 6 * 60_000));
    await second;
    const fired = store.getCheckBack(booked.id);
    expect(fired.fired_at).not.toBeNull();
    const woken = store.getTurn(fired.fired_turn_id!);
    expect(woken.task_id).toBe(booking.task_id!);
    expect(woken.status).toBe("completed");
    const note = store.getMessage(woken.trigger_message_id);
    expect(note).toMatchObject({ kind: "system", author: writer.bot.id, body: "回看：看 report.md 写好没，没有就自己写", turn_id: booking.id });
    expect(store.pendingCheckBack(writer.bot.id, session)).toBeNull();

    // The note is the Bot's reminder to itself. The conversation, the phone, other Bots' transcripts,
    // the organizer, search and the unread badge never see it; the flow board still draws the wake.
    expect(store.getCheckBack(booked.id).message_id).toBe(note.id);
    expect(store.listMessages(session).items.map((m) => m.id)).not.toContain(note.id);
    expect(store.listMainMessages(session, 10).map((m) => m.id)).not.toContain(note.id);
    expect(store.taskMessagesSince(booking.task_id!, "1970-01-01T00:00:00.000Z").map((m) => m.id)).not.toContain(note.id);
    expect(store.search("写好没").map((hit) => hit.id)).not.toContain(note.id);
    expect(store.unreadCount(session)).toBe(store.listMessages(session).items.filter((m) => m.author !== "user").length);
    expect(shown.some((event) => (event.event === "message.created" || event.event === "message.upsert") && event.id === note.id)).toBe(false);
    expect(store.taskTrace(booking.task_id!).nodes.find((node) => node.turn_id === woken.id)?.woken_by_turn_id).toBe(booking.id);

    // What the woken Bot saw: its note marked as the trigger, the opening request and the earlier
    // turn in the block, and no appointment still pending.
    const last = seen.at(-1)!;
    const situation = textOf(last.find((m) => m.role === "user" && textOf(m).startsWith(SITUATION_HEADING))!);
    expect(situation).toContain("这件事最初的要求：写一份周报，交到 report.md");
    expect(situation).toContain("【Writer】五分钟后我回来看。");
    expect(situation).not.toContain("你约的回看");
    expect(last.some((m) => m.role === "user" && textOf(m).includes("【系统】\n（本轮触发）\n回看：看 report.md 写好没"))).toBe(true);
    // Left out of the listing, the note still reads after what came before it, not above the history.
    const noteAt = last.findIndex((m) => textOf(m).includes("（本轮触发）\n回看："));
    const earlierAt = last.findIndex((m) => textOf(m).includes("五分钟后我回来看") && !textOf(m).startsWith(SITUATION_HEADING));
    expect(earlierAt).toBeGreaterThan(-1);
    expect(noteAt).toBeGreaterThan(earlierAt);
    expect(store.listMainMessages(session, 10).map((m) => m.body)).toContain("回看：report.md 还没有，我现在写。");

    // Fired is fired: a later tick finds nothing to wake.
    scheduler.tick(new Date(Date.now() + 7 * 60_000));
    expect(completed).toBe(2);
    expect(store.listPendingCheckBacks()).toEqual([]);
  } finally {
    scheduler.stop();
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a check-back whose Bot has left the group is consumed without waking anyone", async () => {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const engine = createTurnEngine({
    store,
    publish() {},
    completions: {
      async complete() {
        throw new Error("nobody should be woken");
      },
      async judge() {
        throw new Error("no judge");
      },
    },
  });
  try {
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" }).bot;
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" }).bot;
    const extra = store.createBot({ name: "Extra", duties: "", boundaries: "" }).bot;
    const group = store.createGroup({ name: "Brief", members: [writer.id, reviewer.id, extra.id] });
    const { row } = store.scheduleCheckBack({ botId: extra.id, sessionId: group.id, turnId: null, note: "n", afterMinutes: 1 });
    store.removeMember(group.id, extra.id);
    expect(engine.fireCheckBack(row.id, new Date(Date.now() + 2 * 60_000))).toBeNull();
    expect(store.getCheckBack(row.id).fired_at).not.toBeNull();
    expect(store.listMainMessages(group.id, 10)).toEqual([]);
    expect(store.listLiveTurns()).toEqual([]);
  } finally {
    await engine.close();
    store.close();
  }
});

async function until<T>(read: () => T | undefined | null | false, timeoutMs = 4000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = read();
    if (value) return value;
    await Bun.sleep(10);
  }
  throw new Error("timed out");
}

function triggerText(messages: ChatMessage[]): string {
  return textOf(messages.find((m) => m.role === "user" && textOf(m).includes("（本轮触发）"))!);
}

/**
 * A Writer in a group with a Reviewer. `reply` answers each turn by what woke it; a turn it leaves
 * to the default opens a direct with the Reviewer and hands `handoff` over there.
 */
function relayHarness(reply: (trigger: string) => string | { handoff: string }) {
  const root = mkdtempSync(join(tmpdir(), "bot-report-back-"));
  const store = new Store({ endpointKey: memoryKeyStore() });
  const shown: ClientEvent[] = [];
  const engine = createTurnEngine({
    store,
    directQuietMs: 20,
    publish(event) {
      shown.push(event);
    },
    completions: {
      async complete(request) {
        const answer = reply(triggerText(request.messages));
        if (typeof answer === "string") return say(answer);
        const results = request.messages.filter((m) => m.role === "tool");
        if (results.length === 0) return call("create_direct", { name: "Reviewer" });
        const opened = JSON.parse(textOf(results[0]!));
        return call("send_message", { session_id: opened.data.session_id, body: answer.handoff });
      },
      async judge() {
        throw new Error("no judge");
      },
    },
  });
  const setup = async () => {
    await store.patchSettings({ workspace_path: root, endpoint_base_url: "http://127.0.0.1:1/v1", endpoint_api_key: "fixture", endpoint_models: ["fixture"], endpoint_default_model: "fixture" });
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "stay" }).bot;
    const reviewer = store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" }).bot;
    const group = store.createGroup({ name: "Cut", members: [writer.id, reviewer.id] });
    return { writer, reviewer, group };
  };
  /** The Writer's finished turns in the group, oldest first. */
  const writerTurnsIn = (sessionId: string, writerId: string) =>
    shown.filter(
      (e): e is Extract<ClientEvent, { event: "turn.upsert" }> =>
        e.event === "turn.upsert" && e.status === "completed" && e.bot_id === writerId && e.session_id === sessionId,
    );
  const cleanup = async () => {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { store, engine, setup, writerTurnsIn, cleanup };
}

test("a Bot↔Bot direct that goes quiet calls its opener back to the group it came from", async () => {
  const h = relayHarness((trigger) => {
    if (trigger.includes("回看：")) return "第一镜审过了，Reviewer 说通过。";
    if (trigger.includes("第一镜通过")) return "无需回复";
    if (trigger.includes("请审第一镜")) return "第一镜通过";
    return { handoff: "请审第一镜" };
  });
  try {
    const { writer, group } = await h.setup();
    const ask = h.store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "@Writer 第一镜送审到通过为止" });
    await h.engine.handleInboundMessage(ask, { fromUser: true });

    const [, report] = await until(() => {
      const turns = h.writerTurnsIn(group.id, writer.id);
      return turns.length >= 2 && turns;
    });
    const opening = h.writerTurnsIn(group.id, writer.id)[0]!;
    expect(opening.trigger_message_id).toBe(ask.id);
    const direct = h.store.listSessions().find((s) => s.kind === "direct" && s.origin_session_id === group.id)!;
    const line = h.store.getMessage(report!.trigger_message_id);
    expect(line).toMatchObject({
      session_id: group.id,
      kind: "system",
      author: writer.id,
      body: "回看：你和Reviewer的私聊静下来了，最后一条是Reviewer说的：「第一镜通过」。先在这里交代这次私聊的结果，再接着推进下一步。",
    });
    // Hung on the direct's last turn, so the flow board draws the wake back across; same job.
    expect(h.store.getTurn(line.turn_id!).session_id).toBe(direct.id);
    expect(h.store.getTurn(report!.id).task_id).toBe(h.store.getTurn(opening.id).task_id!);
    // A reminder like any check-back: the group never shows the line, only the report it led to.
    const shownInGroup = h.store.listMainMessages(group.id, 10);
    expect(shownInGroup.map((m) => m.id)).not.toContain(line.id);
    expect(shownInGroup.map((m) => m.body)).toContain("第一镜审过了，Reviewer 说通过。");

    // Reported is reported: nothing new in the direct, so no second call-back.
    await Bun.sleep(100);
    expect(h.writerTurnsIn(group.id, writer.id)).toHaveLength(2);
    expect(h.store.listPendingCheckBacks()).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

test("an unanswered direct reports back once, and the direct that report opens does not bounce", async () => {
  const h = relayHarness((trigger) => {
    if (trigger.includes("回看：")) return { handoff: "请再审第二镜" };
    if (trigger.includes("请再审第二镜") || trigger.includes("请审第二镜")) return "无需回复";
    return { handoff: "请审第二镜" };
  });
  try {
    const { writer, group } = await h.setup();
    const ask = h.store.insertMessage({ sessionId: group.id, kind: "user", author: "user", body: "@Writer 第二镜送审" });
    await h.engine.handleInboundMessage(ask, { fromUser: true });

    const [, report] = await until(() => {
      const turns = h.writerTurnsIn(group.id, writer.id);
      return turns.length >= 2 && turns;
    });
    const line = h.store.getMessage(report!.trigger_message_id);
    expect(line.body).toBe("回看：你和Reviewer的私聊静下来了，Reviewer没有回你最后那条。先在这里交代现状，再决定下一步。");

    // The Writer went straight back into a new direct from that call-back, and the Reviewer stayed
    // silent there too. It has been back once; waking it again would only loop on silence.
    const second = await until(() =>
      h.store.listSessions().find((s) => s.kind === "direct" && s.origin_message_id === line.id),
    );
    await until(() => h.store.listMainMessages(second.id, 10).length > 0 && h.store.listLiveTurns({ sessionId: second.id }).length === 0);
    await Bun.sleep(100);
    expect(h.writerTurnsIn(group.id, writer.id)).toHaveLength(2);
    expect(h.store.listPendingCheckBacks()).toEqual([]);
  } finally {
    await h.cleanup();
  }
});
