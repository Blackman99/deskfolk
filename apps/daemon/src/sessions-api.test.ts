import { describe, expect, test } from "bun:test";
import { auth, registerLocalApiCleanup, startLocalApi, type Harness } from "./test-kit/local-api-harness";

registerLocalApiCleanup();

const start = (opts: Parameters<typeof startLocalApi>[0] = {}) => startLocalApi(opts);

describe("empty roster and settings", () => {
  test("DELETE /v1/sessions/:id and POST /v1/sessions/:id/clear", async () => {
    const h = await start();
    // Create two bots
    const b1Res = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "B1", duties: "d1", boundaries: "b1" }),
    });
    const b1 = (await b1Res.json()) as { bot: { id: string }; direct_session: { id: string } };

    const b2Res = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "B2", duties: "d2", boundaries: "b2" }),
    });
    const b2 = (await b2Res.json()) as { bot: { id: string } };

    // Create a group
    const gRes = await fetch(`${h.origin}/v1/sessions`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "TestGroup", members: [b1.bot.id, b2.bot.id] }),
    });
    const group = (await gRes.json()) as { id: string };

    // Post a message in the group
    await fetch(`${h.origin}/v1/sessions/${group.id}/messages`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ body: "Test message" }),
    });

    const msgsBefore = await fetch(`${h.origin}/v1/sessions/${group.id}/messages`, { headers: auth(h) });
    const msgsBeforeJson = (await msgsBefore.json()) as { items: unknown[] };
    expect(msgsBeforeJson.items.length).toBeGreaterThan(0);

    // Clear history
    const clearRes = await fetch(`${h.origin}/v1/sessions/${group.id}/clear`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
    });
    expect(clearRes.status).toBe(204);

    const msgsAfter = await fetch(`${h.origin}/v1/sessions/${group.id}/messages`, { headers: auth(h) });
    const msgsAfterJson = (await msgsAfter.json()) as { items: unknown[] };
    expect(msgsAfterJson.items.length).toBe(0);

    // Delete direct session fails (422)
    const delDirect = await fetch(`${h.origin}/v1/sessions/${b1.direct_session.id}`, {
      method: "DELETE",
      headers: auth(h),
    });
    expect(delDirect.status).toBe(422);

    // Delete group succeeds
    const delGroup = await fetch(`${h.origin}/v1/sessions/${group.id}`, {
      method: "DELETE",
      headers: auth(h),
    });
    expect(delGroup.status).toBe(204);

    const getGroup = await fetch(`${h.origin}/v1/sessions/${group.id}`, { headers: auth(h) });
    expect(getGroup.status).toBe(404);
  });

  test("clearing or deleting a conversation keeps what you said unless erase_quotes asks otherwise", async () => {
    const h = await start();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
    const editor = h.store.createBot({ name: "Editor", duties: "edit", boundaries: "none" });
    const group = h.store.createGroup({ name: "Team", members: [writer.bot.id, editor.bot.id] });
    const direct = writer.direct_session.id;
    const post = (session: string, body: string) =>
      fetch(`${h.origin}/v1/sessions/${session}/messages`, { method: "POST", headers: auth(h, { "Content-Type": "application/json" }), body: JSON.stringify({ body }) });
    const send = (method: string, path: string, body?: unknown) =>
      fetch(`${h.origin}${path}`, { method, headers: auth(h, { "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
    const words = (session: string) => h.store.listQuotes({ sessionId: session }).map((quote) => [quote.body, quote.message_id === null]);

    await post(direct, "片长两分钟左右");
    expect((await send("POST", `/v1/sessions/${direct}/clear`)).status).toBe(204);
    expect(words(direct)).toEqual([["片长两分钟左右", true]]);

    await post(direct, "机械臂是左手");
    // A wrong value is refused before anything is cleared.
    expect((await send("POST", `/v1/sessions/${direct}/clear`, { erase_quotes: "yes" })).status).toBe(422);
    expect(h.store.listMessages(direct).items.map((message) => message.body)).toContain("机械臂是左手");
    expect((await send("DELETE", `/v1/sessions/${direct}/messages`, { erase_quotes: true })).status).toBe(204);
    expect(words(direct)).toEqual([["", true], ["", true]]);

    await post(group.id, "背景要连贯");
    const [kept] = h.store.listQuotes({ sessionId: group.id });
    expect((await send("DELETE", `/v1/sessions/${group.id}`, {})).status).toBe(204);
    expect(h.store.listQuotes().find((quote) => quote.id === kept!.id)).toMatchObject({ body: "背景要连贯", session_id: null, message_id: null });
  });

  test("the board acts on an entry of the requirements ledger and gets the plan back; a moved-on entry is a 409", async () => {
    const h = await start();
    const { bot, direct_session: direct } = h.store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
    const line = h.store.postMessage(direct.id, { body: "做 EP01" });
    const plan = h.store.createTurn({ sessionId: direct.id, botId: bot.id, triggerMessageId: line.id }).task_id!;
    const old = h.store.addRequirement({ scope: "plan", scopeId: plan, quote: "标题别太长", sourceKind: "legacy", addedBy: "import", status: "unverified" });
    const act = (id: string, body: unknown) =>
      fetch(`${h.origin}/v1/requirements/${id}/action`, { method: "POST", headers: auth(h, { "Content-Type": "application/json" }), body: JSON.stringify(body) });

    const confirmed = await act(old.id, { action: "confirm", task_id: plan });
    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as { requirements: Array<{ id: string; status: string }> }).requirements).toMatchObject([{ id: old.id, status: "open" }]);
    expect((await act(old.id, { action: "reject", task_id: plan })).status).toBe(409);
    const widened = await act(old.id, { action: "whole_project", task_id: plan });
    expect(((await widened.json()) as { requirements: Array<{ scope: string }> }).requirements).toMatchObject([{ scope: "project" }]);
    expect((await act(old.id, { action: "purge", task_id: plan })).status).toBe(422);
    expect((await act(old.id, { action: "waive" })).status).toBe(404);
    expect((await act(old.id, { action: "waive", task_id: plan })).status).toBe(200);
    expect(h.store.getRequirement(old.id).status).toBe("waived");

    // One an edit of yours took the words of is shown so, and kept from the board.
    const kept = h.store.addRequirement({ scope: "plan", scopeId: plan, quote: "整不了就做 2D", sourceKind: "message", addedBy: "scribe" });
    const edited = h.store.editMessage(line.id, { body: "做 EP01，3D", userActionId: "edit-api" });
    h.store.db.run("UPDATE requirements SET withdraw_edit_id = ? WHERE id = ?", [edited.edit!.id, kept.id]);
    const board = (await (await fetch(`${h.origin}/v1/tasks/${plan}`, { headers: auth(h) })).json()) as { requirements: Array<{ id: string; withdraw_proposed: unknown }> };
    expect(board.requirements.find((entry) => entry.id === kept.id)?.withdraw_proposed).toEqual({ edit_id: edited.edit!.id, at: edited.edit!.created_at });
    const keptBack = await act(kept.id, { action: "keep", task_id: plan });
    expect(keptBack.status).toBe(200);
    expect(((await keptBack.json()) as { requirements: Array<{ id: string; withdraw_proposed: unknown }> }).requirements.find((entry) => entry.id === kept.id)?.withdraw_proposed).toBeNull();
    expect(h.store.getRequirement(kept.id)).toMatchObject({ status: "open", withdraw_edit_id: null });
  });

  test("erasing what you said takes the checks made from it with it, at once", async () => {
    const h = await start();
    const { bot, direct_session: direct } = h.store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" });
    const reviewer = h.store.createBot({ name: "审片员", duties: "审片", boundaries: "none" });
    const group = h.store.createGroup({ name: "片组", members: [bot.id, reviewer.bot.id] });
    const send = (method: string, path: string, body?: unknown) =>
      fetch(`${h.origin}${path}`, { method, headers: auth(h, { "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
    /** A line of yours in `session` that opens a plan, and the check it gives. */
    const planFrom = (session: string) => {
      const line = h.store.postMessage(session, { body: "片长约2分钟" });
      const turn = h.store.createTurn({ sessionId: session, botId: bot.id, triggerMessageId: line.id });
      h.store.setTurnStatus(turn.id, "completed");
      h.store.syncDerivedChecks(turn.task_id!);
      // Something else of yours keeps the plan when the conversation's words go.
      h.store.addRequirement({ scope: "plan", scopeId: turn.task_id!, quote: "机械臂是左手", sourceKind: "board", addedBy: "user" });
      return () => h.store.listChecks(turn.task_id!).filter((check) => check.origin === "derived");
    };

    const inDirect = planFrom(direct.id);
    expect(inDirect()).toHaveLength(1);
    // Cleared with your words kept, the check stays; erased with them, it goes without waiting for the plan's next line.
    expect((await send("POST", `/v1/sessions/${direct.id}/clear`)).status).toBe(204);
    expect(inDirect()).toHaveLength(1);
    expect((await send("DELETE", `/v1/sessions/${direct.id}/messages`, { erase_quotes: true })).status).toBe(204);
    expect(inDirect()).toEqual([]);

    const inGroup = planFrom(group.id);
    expect(inGroup()).toHaveLength(1);
    expect((await send("DELETE", `/v1/sessions/${group.id}`, { erase_quotes: true })).status).toBe(204);
    expect(inGroup()).toEqual([]);
  });

  test("POST /v1/sessions/:id/archive and /v1/sessions/:id/restore", async () => {
    const h = await start();
    const b1 = h.store.createBot({ name: "Worker1", duties: "d", boundaries: "b" });
    const b2 = h.store.createBot({ name: "Worker2", duties: "d", boundaries: "b" });
    const group = h.store.createGroup({ name: "TeamAlpha", members: [b1.bot.id, b2.bot.id] });

    const archiveRes = await fetch(`${h.origin}/v1/sessions/${group.id}/archive`, {
      method: "POST",
      headers: auth(h),
    });
    expect(archiveRes.status).toBe(200);
    const archived = (await archiveRes.json()) as { archived_at: string | null };
    expect(archived.archived_at).toBeString();

    const getArchived = await fetch(`${h.origin}/v1/sessions/${group.id}`, { headers: auth(h) });
    const fetched = (await getArchived.json()) as { archived_at: string | null };
    expect(fetched.archived_at).toBe(archived.archived_at);

    const restoreRes = await fetch(`${h.origin}/v1/sessions/${group.id}/restore`, {
      method: "POST",
      headers: auth(h),
    });
    expect(restoreRes.status).toBe(200);
    const restored = (await restoreRes.json()) as { archived_at: string | null };
    expect(restored.archived_at).toBeNull();
  });

  test("POST /v1/sessions/:id/read clears unread_count", async () => {
    const h = await start();
    const createdRes = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "Reader", duties: "d", boundaries: "b" }),
    });
    const created = (await createdRes.json()) as {
      bot: { id: string };
      direct_session: { id: string };
    };
    h.store.markSessionRead(created.direct_session.id, "2000-01-01T00:00:00.000Z");
    h.store.insertMessage({
      sessionId: created.direct_session.id,
      kind: "bot",
      author: created.bot.id,
      body: "hello from the bot",
    });
    const listed = await fetch(`${h.origin}/v1/sessions`, { headers: auth(h) });
    const listedBody = (await listed.json()) as {
      items: Array<{ id: string; unread_count: number; last_read_at: string | null }>;
    };
    const row = listedBody.items.find((s) => s.id === created.direct_session.id);
    expect(row?.unread_count).toBe(1);
    const readRes = await fetch(`${h.origin}/v1/sessions/${created.direct_session.id}/read`, {
      method: "POST",
      headers: auth(h),
    });
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as { unread_count: number; last_read_at: string | null };
    expect(readBody.unread_count).toBe(0);
    expect(readBody.last_read_at).toBeString();
  });

  test("POST /v1/turns/stop refuses a group turn and skips group when no turn_id", async () => {
    const h = await start();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const reviewer = h.store.createBot({ name: "Reviewer", duties: "review", boundaries: "stay" });
    const group = h.store.createGroup({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] });
    const groupMsg = h.store.postMessage(group.id, { body: "go" });
    const groupTurn = h.store.createTurn({
      sessionId: group.id,
      botId: writer.bot.id,
      triggerMessageId: groupMsg.id,
    });
    const refused = await fetch(`${h.origin}/v1/turns/stop`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ turn_id: groupTurn.id }),
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({
      error: { code: "invalid_args", message: "group turns cannot be stopped" },
    });
    expect(h.store.getTurn(groupTurn.id).status).toBe("running");

    const skipped = await fetch(`${h.origin}/v1/turns/stop`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(skipped.status).toBe(204);
    expect(h.store.getTurn(groupTurn.id).status).toBe("running");

    const directMsg = h.store.postMessage(writer.direct_session.id, { body: "hi" });
    const directTurn = h.store.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: directMsg.id,
    });
    const stopped = await fetch(`${h.origin}/v1/turns/stop`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ turn_id: directTurn.id }),
    });
    expect(stopped.status).toBe(200);
    expect(h.store.getTurn(directTurn.id).status).toBe("stopped");
    expect(h.store.getTurn(groupTurn.id).status).toBe("running");
  });

  test("POST /v1/turns/continue opens a new turn from an interrupted system note", async () => {
    const h = await start();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const trigger = h.store.postMessage(writer.direct_session.id, { body: "go" });
    const turn = h.store.createTurn({
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      triggerMessageId: trigger.id,
    });
    h.store.interruptRunningTurns();
    const note = h.store
      .listMainMessages(writer.direct_session.id, 10)
      .find((m) => m.kind === "system" && m.body === "中断");
    expect(note?.id).toBeString();

    const missing = await fetch(`${h.origin}/v1/turns/continue`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(422);

    const continued = await fetch(`${h.origin}/v1/turns/continue`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ message_id: note!.id }),
    });
    expect(continued.status).toBe(200);
    const body = (await continued.json()) as {
      id: string;
      bot_id: string;
      session_id: string;
      trigger_message_id: string;
      status: string;
    };
    expect(body.bot_id).toBe(writer.bot.id);
    expect(body.session_id).toBe(writer.direct_session.id);
    expect(body.trigger_message_id).toBe(note!.id);
    expect(body.status).toBe("running");
    expect(body.id).not.toBe(turn.id);
    expect(h.store.getMessage(note!.id).source_turn_id).toBe(body.id);

    const again = await fetch(`${h.origin}/v1/turns/continue`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ message_id: note!.id }),
    });
    expect(again.status).toBe(422);
    expect(h.store.getTurn(turn.id).status).toBe("interrupted");
  });
});

describe("a Bot↔Bot direct is view-only", () => {
  async function twoBotsTalking(h: Harness) {
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = h.store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    const direct = h.store.createBotDirect(writer.bot.id, researcher.bot.id, null);
    return { writer, researcher, direct };
  }

  test("posting into one is 403 not_a_member and writes nothing", async () => {
    const h = await start();
    const { direct } = await twoBotsTalking(h);
    const res = await fetch(`${h.origin}/v1/sessions/${direct.id}/messages`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ body: "let me in" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_a_member");
    expect(h.store.listMainMessages(direct.id, 10)).toEqual([]);
  });

  test("the multipart path is refused too", async () => {
    const h = await start();
    const { direct } = await twoBotsTalking(h);
    const form = new FormData();
    form.set("body", "notes attached");
    form.set("files", new File([Buffer.from("hi")], "note.txt", { type: "text/plain" }));
    const res = await fetch(`${h.origin}/v1/sessions/${direct.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: form,
    });
    expect(res.status).toBe(403);
    expect(h.store.listMainMessages(direct.id, 10)).toEqual([]);
  });

  test("posting into your own direct and into a group still works", async () => {
    const h = await start();
    const { writer } = await twoBotsTalking(h);
    const res = await fetch(`${h.origin}/v1/sessions/${writer.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ body: "hello" }),
    });
    expect(res.status).toBe(201);
  });

  /** Read-only is about not joining in. Tidying your own view stays yours. */
  test("read, archive, restore and clear still work on one", async () => {
    const h = await start();
    const { direct } = await twoBotsTalking(h);
    for (const path of ["read", "archive", "restore", "clear"]) {
      const res = await fetch(`${h.origin}/v1/sessions/${direct.id}/${path}`, {
        method: "POST",
        headers: auth(h),
      });
      expect([200, 204]).toContain(res.status);
    }
  });

  test("composer suggestions come back empty rather than failing", async () => {
    const h = await start();
    const { direct } = await twoBotsTalking(h);
    const res = await fetch(`${h.origin}/v1/sessions/${direct.id}/composer-suggestions`, {
      headers: auth(h),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });

  test("the session list carries where a direct came from", async () => {
    const h = await start();
    const writer = h.store.createBot({ name: "Writer", duties: "write", boundaries: "stay" });
    const researcher = h.store.createBot({ name: "Researcher", duties: "dig", boundaries: "stay" });
    const group = h.store.createGroup({
      name: "Desk",
      members: [writer.bot.id, researcher.bot.id],
    });
    const trigger = h.store.postMessage(group.id, { body: "go ask" });
    const direct = h.store.createBotDirect(writer.bot.id, researcher.bot.id, {
      sessionId: group.id,
      messageId: trigger.id,
    });
    const res = await fetch(`${h.origin}/v1/sessions`, { headers: auth(h) });
    const body = (await res.json()) as {
      items: Array<{ id: string; origin_session_id: string | null; origin_message_id: string | null }>;
    };
    const listed = body.items.find((s) => s.id === direct.id);
    expect(listed).toBeDefined();
    expect(listed?.origin_session_id).toBe(group.id);
    expect(listed?.origin_message_id).toBe(trigger.id);
  });
});

/** A phone opening a conversation used to get the whole transcript back from marking it read. */
test("marking a conversation read answers with its read state, not its transcript", async () => {
  const h = await start();
  const created = h.store.createBot({ name: "Reader", duties: "d", boundaries: "b" });
  const message = h.store.postMessage(created.direct_session.id, { body: "hello" });
  const res = await fetch(`${h.origin}/v1/sessions/${created.direct_session.id}/read`, {
    method: "POST",
    headers: auth(h, { "Content-Type": "application/json" }),
    body: JSON.stringify({ through_message_id: message.id }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.id).toBe(created.direct_session.id);
  expect(body.unread_count).toBe(0);
  expect(body.last_read_at).toBeString();
  expect(body).not.toHaveProperty("messages");
  expect(body).not.toHaveProperty("turns");
});

/** A phone asks for the screenful it shows; older history comes a page at a time as it scrolls. */
test("a conversation snapshot pages its first history by limit", async () => {
  const h = await start();
  const created = h.store.createBot({ name: "Pager", duties: "d", boundaries: "b" });
  for (let i = 0; i < 25; i++) h.store.postMessage(created.direct_session.id, { body: `m${i}` });
  const snap = (query: string) => fetch(`${h.origin}/v1/sessions/${created.direct_session.id}/snapshot${query}`, { headers: auth(h) })
    .then(async (res) => ({ status: res.status, body: await res.json() as { session: { messages: { items: unknown[]; next: string | null } } } }));
  const paged = await snap("?limit=20");
  expect(paged.status).toBe(200);
  expect(paged.body.session.messages.items).toHaveLength(20);
  expect(paged.body.session.messages.next).toBeString();
  expect((await snap("")).body.session.messages.items).toHaveLength(25);
  expect((await snap("?limit=0")).status).toBe(422);
});
