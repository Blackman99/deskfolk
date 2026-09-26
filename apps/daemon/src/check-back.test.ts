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
