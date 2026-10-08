import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createWriter, jsonAuth as auth, registerLocalApiCleanup, sse, subscribe, waitFor } from "./test-kit/local-api-harness";
import { startApi, startFixture, textChunks } from "./test-kit/engine-fixtures";

registerLocalApiCleanup();

describe("turn engine on the local API", () => {
  test("dialing the clock to due forks a you↔Bot turn and leaves the live turn running", async () => {
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered = () => {};
    const firstInFlight = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let releaseRoutine = () => {};
    const routineHeld = new Promise<void>((resolve) => {
      releaseRoutine = resolve;
    });
    const fixture = await startFixture(async ({ body }) => {
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (lastUser.includes("write the daily")) {
        await routineHeld;
        return sse(textChunks("routine reply"));
      }
      firstEntered();
      await firstHeld;
      return sse(textChunks("still going"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);

    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "keep going" }),
    });
    const first = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === botId,
    );
    await firstInFlight;

    const created = await fetch(`${h.origin}/v1/routines`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        bot_id: botId,
        title: "日报",
        instruction: "write the daily",
        schedule: { kind: "daily", time: "09:00" },
        enabled: false,
      }),
    });
    expect(created.status).toBe(201);
    const routine = (await created.json()) as { id: string };
    h.store.db.run(
      `UPDATE routines SET created_at = ?, last_fired_for_due_at = NULL, enabled = 1 WHERE id = ?`,
      [new Date(2026, 8, 10, 8, 0, 0).toISOString(), routine.id],
    );

    const dueNow = new Date(2026, 8, 14, 9, 0, 0);
    const opened = h.engine.fireRoutine(routine.id, dueNow);
    expect(opened).not.toBeNull();
    expect(opened!.session_id).toBe(sessionId);
    expect(opened!.bot_id).toBe(botId);
    expect(opened!.id).not.toBe(first.id);

    // The fire is the app's system line under the Bot, not a message in your name.
    const trigger = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.body === "日程「日报」：write the daily",
    );
    expect(trigger).toMatchObject({ session_id: sessionId, kind: "system", author: botId });
    expect(
      h.store.listMainMessages(sessionId, 40).some((m) => m.kind === "user" && m.body.includes("write the daily")),
    ).toBe(false);
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === opened!.id && e.status === "running",
    );
    expect(h.store.getTurn(String(first.id)).status).toBe("running");
    expect(h.store.listLiveTurns({ sessionId, botId }).map((t) => t.id).sort()).toEqual(
      [String(first.id), opened!.id].sort(),
    );

    releaseRoutine();
    const botMsg = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "routine reply",
    );
    expect(botMsg.turn_id).toBe(opened!.id);
    expect(botMsg.session_id).toBe(sessionId);
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === opened!.id && e.status === "completed",
    );
    expect(h.store.getTurn(String(first.id)).status).toBe("running");

    expect(h.store.getRoutine(routine.id).last_fired_for_due_at).toBe(dueNow.toISOString());
    expect(h.engine.fireRoutine(routine.id, dueNow)).toBeNull();

    // The fire ran as a ticket of the routine's standing plan, not as a new plan of the session:
    // the user's own plan is still the current one.
    const standing = h.store.routineTask(routine.id)!;
    expect(standing.routine_id).toBe(routine.id);
    const fired = h.store.getTurn(opened!.id);
    expect(fired.task_id).toBe(standing.id);
    const ticket = h.store.getTicket(fired.ticket_id!);
    expect(ticket).toMatchObject({ task_id: standing.id, seq: 1, worker: botId });
    expect(h.store.turnWorkDir(fired.id)).toBe(ticket.dir);
    expect(h.store.sessionCurrentTask(sessionId)?.id).toBe(h.store.getTurn(String(first.id)).task_id!);
    // Nobody woke it: no card of yours, and no line claiming the Bot handed it to itself.
    expect(h.store.taskTrace(standing.id).nodes).toEqual([
      expect.objectContaining({ turn_id: opened!.id, actor: botId, woken_by_turn_id: null, woken_elsewhere: null }),
    ]);

    releaseFirst();
    sub.close();
  });

  test("a due fire does not redirect a live group turn or post the instruction in the group", async () => {
    let releaseGroup = () => {};
    const groupHeld = new Promise<void>((resolve) => {
      releaseGroup = resolve;
    });
    let releaseRoutine = () => {};
    const routineHeld = new Promise<void>((resolve) => {
      releaseRoutine = resolve;
    });
    const fixture = await startFixture(async ({ body }) => {
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("你正在做一次判断")) {
        return Response.json({
          choices: [{ message: { role: "assistant", content: JSON.stringify({ decision: "pass" }) } }],
        });
      }
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (lastUser.includes("write the daily")) {
        await routineHeld;
        return sse(textChunks("routine reply"));
      }
      await groupHeld;
      return sse(textChunks("group still going"));
    });
    const h = await startApi();
    mkdirSync("/tmp/real-bot-ws", { recursive: true });
    await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: "/tmp/real-bot-ws",
        endpoint_base_url: fixture.origin,
        endpoint_api_key: "sk-test",
        endpoint_models: ["test-model"],
        endpoint_default_model: "test-model",
      }),
    });
    const writer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string }; direct_session: { id: string } };
    const researcher = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Researcher", duties: "read", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const group = (await (
      await fetch(`${h.origin}/v1/sessions`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Brief", members: [writer.bot.id, researcher.bot.id] }),
      })
    ).json()) as { id: string };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${group.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer keep going" }),
    });
    const groupTurn = await waitFor(
      sub.events,
      (e) =>
        e.event === "turn.upsert" &&
        e.status === "running" &&
        e.session_id === group.id &&
        e.bot_id === writer.bot.id,
    );

    const created = await fetch(`${h.origin}/v1/routines`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        bot_id: writer.bot.id,
        title: "日报",
        instruction: "write the daily",
        schedule: { kind: "daily", time: "09:00" },
        enabled: false,
      }),
    });
    const routine = (await created.json()) as { id: string };
    h.store.db.run(
      `UPDATE routines SET created_at = ?, last_fired_for_due_at = NULL, enabled = 1 WHERE id = ?`,
      [new Date(2026, 8, 10, 8, 0, 0).toISOString(), routine.id],
    );

    const opened = h.engine.fireRoutine(routine.id, new Date(2026, 8, 14, 9, 0, 0));
    expect(opened).not.toBeNull();
    expect(opened!.session_id).toBe(writer.direct_session.id);
    expect(h.store.getTurn(String(groupTurn.id)).status).toBe("running");
    expect(h.store.listMainMessages(group.id, 40).some((m) => m.body.includes("write the daily"))).toBe(false);
    releaseRoutine();
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "routine reply",
    );

    releaseGroup();
    sub.close();
  });

  test("catch-up after a missed stretch only fires the latest due", async () => {
    const fixture = await startFixture(() => sse(textChunks("caught up")));
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);

    const created = await fetch(`${h.origin}/v1/routines`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        bot_id: botId,
        title: "日报",
        instruction: "write the daily",
        schedule: { kind: "daily", time: "09:00" },
        enabled: false,
      }),
    });
    const routine = (await created.json()) as { id: string };
    h.store.db.run(
      `UPDATE routines SET created_at = ?, last_fired_for_due_at = NULL, enabled = 1 WHERE id = ?`,
      [new Date(2026, 8, 10, 8, 0, 0).toISOString(), routine.id],
    );

    const now = new Date(2026, 8, 14, 10, 0, 0);
    const opened = h.engine.fireRoutine(routine.id, now);
    expect(opened).not.toBeNull();
    expect(opened!.session_id).toBe(sessionId);
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "system" && e.body === "日程「日报」：write the daily",
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === opened!.id && e.status === "completed",
    );

    const due = new Date(2026, 8, 14, 9, 0, 0).toISOString();
    expect(h.store.getRoutine(routine.id).last_fired_for_due_at).toBe(due);
    expect(h.engine.fireRoutine(routine.id, now)).toBeNull();

    const transcript = h.store.listMainMessages(sessionId, 40);
    expect(transcript.filter((m) => m.body.includes("write the daily"))).toHaveLength(1);

    sub.close();
  });
});
