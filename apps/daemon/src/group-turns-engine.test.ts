import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { ORGANIZER_SYSTEM } from "./prompts/organizer";
import { runCollabTool } from "./collab-tools";
import { createGroupWithBots, createWriter, jsonAuth as auth, registerLocalApiCleanup, sse, subscribe, waitFor, type Harness } from "./test-kit/local-api-harness";
import { isJudgementRequest, judgementPass, routingAnswer, startApi, startFixture, textChunks, toolCallChunks } from "./test-kit/engine-fixtures";

registerLocalApiCleanup();

function judgementJoin(): Response {
  return Response.json({
    choices: [{ message: { role: "assistant", content: JSON.stringify({ decision: "join", reason: "duties" }) } }],
  });
}

describe("turn engine on the local API", () => {
  test("unmentioned group members are judged and a join opens a forked turn", async () => {
    const judgements: Array<Record<string, unknown>> = [];
    let releaseJudgements: (() => void) | undefined;
    const holdJudgements = new Promise<void>((resolve) => {
      releaseJudgements = resolve;
    });
    const fixture = await startFixture(async ({ body }) => {
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("你正在做一次判断")) {
        judgements.push(body);
        expect(body.stream).toBe(false);
        expect(body.tools).toBeUndefined();
        expect(body.response_format).toBeUndefined();
        expect(system.includes("{")).toBe(false);
        expect(system).toContain("触发条与最近转录是同一件事的重复或转述");
        await holdJudgements;
        const decision = judgements.length <= 2 ? "join" : "pass";
        return Response.json({
          choices: [
            { message: { role: "assistant", content: JSON.stringify({ decision, reason: "duties" }) } },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        });
      }
      return sse(textChunks("joined"));
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
    const writer = await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
      })
    ).json() as { bot: { id: string } };
    const researcher = await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Researcher", duties: "read", boundaries: "stay" }),
      })
    ).json() as { bot: { id: string } };
    const group = await (
      await fetch(`${h.origin}/v1/sessions`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Brief", members: [writer.bot.id, researcher.bot.id] }),
      })
    ).json() as { id: string };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${group.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "please begin" }),
    });
    const started = await waitFor(
      sub.events,
      (e) => e.event === "judgement.started" && e.session_id === group.id,
    );
    expect(started.bot_id).toBeTruthy();
    expect(started.message_id).toBeTruthy();
    const listed = await fetch(`${h.origin}/v1/sessions`, { headers: auth(h) });
    const listedBody = (await listed.json()) as {
      items: Array<{ id: string; pending_judgements?: Array<{ bot_id: string }> }>;
    };
    const listedGroup = listedBody.items.find((s) => s.id === group.id);
    expect((listedGroup?.pending_judgements ?? []).length).toBeGreaterThan(0);
    releaseJudgements?.();
    await waitFor(sub.events, (e) => e.event === "judgement.created" && e.decision === "join");
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.session_id === group.id,
    );
    await waitFor(sub.events, (e) => e.event === "message.created" && e.kind === "bot" && e.body === "joined");
    expect(judgements.length).toBeGreaterThanOrEqual(2);
    const after = await fetch(`${h.origin}/v1/sessions/${group.id}`, { headers: auth(h) });
    const afterBody = (await after.json()) as { pending_judgements?: unknown[] };
    expect(afterBody.pending_judgements ?? []).toEqual([]);
    sub.close();
  });

  test("a user @ in a group only opens the named bot and does not judge the others", async () => {
    const judgements: unknown[] = [];
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) {
        judgements.push(body);
        return judgementJoin();
      }
      return sse(textChunks("only writer"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const researcher = bots.find((b) => b.name === "Researcher")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer please write" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "only writer" && e.author === writer.id,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === writer.id,
    );
    await Bun.sleep(40);
    expect(judgements).toEqual([]);
    // Only the named Bot waited on the filing; nobody judged.
    expect(
      sub.events.filter((e) => e.event === "judgement.started").map((e) => [e.bot_id, e.stage]),
    ).toEqual([[writer.id, "organizing"]]);
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.bot_id === researcher.id)).toBe(false);
    sub.close();
  });

  test("while your message is being filed, the Bot it wakes already shows under it", async () => {
    let releaseOrganizer: (() => void) | undefined;
    const holdOrganizer = new Promise<void>((resolve) => {
      releaseOrganizer = resolve;
    });
    const fixture = await startFixture(
      () => sse(textChunks("done")),
      async ({ body }) => {
        const messages = body.messages as Array<{ content?: string }>;
        if (messages[0]?.content === ORGANIZER_SYSTEM) await holdOrganizer;
        return routingAnswer("{}");
      },
    );
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    const posted = await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "please write" }),
    });
    const message = (await posted.json()) as { id: string };

    const organizing = await waitFor(
      sub.events,
      (e) => e.event === "judgement.started" && e.session_id === sessionId,
    );
    expect(organizing).toMatchObject({ message_id: message.id, bot_id: botId, stage: "organizing" });
    await Bun.sleep(40);
    expect(sub.events.some((e) => e.event === "turn.upsert")).toBe(false);
    // A window that loads the session now sees the same row.
    const detail = (await (
      await fetch(`${h.origin}/v1/sessions/${sessionId}`, { headers: auth(h) })
    ).json()) as { pending_judgements?: unknown[] };
    expect(detail.pending_judgements).toMatchObject([{ id: organizing.id, bot_id: botId, stage: "organizing" }]);

    releaseOrganizer?.();
    const ended = await waitFor(sub.events, (e) => e.event === "judgement.ended" && e.id === organizing.id);
    const running = sub.events.findIndex(
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === botId,
    );
    // The turn is up before the row goes, so the Bot never drops out from under the message.
    expect(running).toBeGreaterThanOrEqual(0);
    expect(running).toBeLessThan(sub.events.indexOf(ended));
    await waitFor(sub.events, (e) => e.event === "message.created" && e.kind === "bot" && e.body === "done");
    const after = (await (
      await fetch(`${h.origin}/v1/sessions/${sessionId}`, { headers: auth(h) })
    ).json()) as { pending_judgements?: unknown[] };
    expect(after.pending_judgements ?? []).toEqual([]);
    sub.close();
  });

  test("in a group, each Bot waiting on the filing hands over to its judgement", async () => {
    let releaseOrganizer: (() => void) | undefined;
    const holdOrganizer = new Promise<void>((resolve) => {
      releaseOrganizer = resolve;
    });
    const fixture = await startFixture(
      ({ body }) => (isJudgementRequest(body) ? judgementPass() : sse(textChunks("unused"))),
      async ({ body }) => {
        const messages = body.messages as Array<{ content?: string }>;
        if (messages[0]?.content === ORGANIZER_SYSTEM) await holdOrganizer;
        return routingAnswer("{}");
      },
    );
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
    ]);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "please begin" }),
    });
    const startedFor = (stage: string) =>
      sub.events.filter((e) => e.event === "judgement.started" && e.stage === stage);
    const deadline = Date.now() + 2000;
    while (startedFor("organizing").length < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(startedFor("organizing").map((e) => e.bot_id).sort()).toEqual(bots.map((b) => b.id).sort());
    expect(startedFor("judging")).toEqual([]);

    releaseOrganizer?.();
    for (const bot of bots) {
      await waitFor(sub.events, (e) => e.event === "judgement.created" && e.bot_id === bot.id);
      const organizing = startedFor("organizing").find((e) => e.bot_id === bot.id)!;
      const judging = startedFor("judging").find((e) => e.bot_id === bot.id)!;
      const ended = sub.events.findIndex((e) => e.event === "judgement.ended" && e.id === organizing.id);
      expect(sub.events.indexOf(judging)).toBeLessThan(ended);
    }
    const after = (await (
      await fetch(`${h.origin}/v1/sessions/${groupId}`, { headers: auth(h) })
    ).json()) as { pending_judgements?: unknown[] };
    expect(after.pending_judgements ?? []).toEqual([]);
    sub.close();
  });

  test("a bot group message with no @ does not judge or open other turns", async () => {
    const judgements: unknown[] = [];
    let writerHops = 0;
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) {
        judgements.push(body);
        return judgementJoin();
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("## 名字\n\nWriter")) {
        writerHops += 1;
        if (writerHops === 1) {
          return sse(toolCallChunks("call_1", "send_message", '{"body":"handoff note"}'));
        }
        throw new Error("send_message should end the turn without another completion");
      }
      return sse(textChunks("should not speak"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const researcher = bots.find((b) => b.name === "Researcher")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer go" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "handoff note" && e.author === writer.id,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === writer.id,
    );
    await Bun.sleep(40);
    expect(judgements).toEqual([]);
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.bot_id === researcher.id)).toBe(false);
    expect(
      sub.events.filter((e) => e.event === "message.created" && e.kind === "bot").map((e) => e.body),
    ).toEqual(["handoff note"]);
    sub.close();
  });

  test("a bot @ in a group only opens the named bot and does not judge bystanders", async () => {
    const judgements: unknown[] = [];
    let writerHops = 0;
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) {
        judgements.push(body);
        return judgementJoin();
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("## 名字\n\nWriter")) {
        writerHops += 1;
        if (writerHops === 1) {
          return sse(toolCallChunks("call_1", "send_message", '{"body":"@Researcher take this"}'));
        }
        throw new Error("send_message should end the turn without another completion");
      }
      if (system.includes("## 名字\n\nResearcher")) {
        return sse(textChunks("took it"));
      }
      return sse(textChunks("reviewer should not speak"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
      { name: "Reviewer", duties: "review" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const researcher = bots.find((b) => b.name === "Researcher")!;
    const reviewer = bots.find((b) => b.name === "Reviewer")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer go" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "@Researcher take this" && e.author === writer.id,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "took it" && e.author === researcher.id,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === researcher.id,
    );
    await Bun.sleep(40);
    expect(judgements).toEqual([]);
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.bot_id === reviewer.id)).toBe(false);
    sub.close();
  });

  /**
   * A teammate naming a Bot that is mid-task used to end that turn and open a new one with an
   * empty tool loop: a frontend engineer lost three runs that way and never delivered. The line
   * is heard in the live turn instead, at the start of its next hop.
   */
  test("a bot @ in a group is heard inside the named bot's live turn instead of ending it", async () => {
    let writerHops = 0;
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sawFirstWriter = () => {};
    const firstWriterArrived = new Promise<void>((resolve) => {
      sawFirstWriter = resolve;
    });
    let heardNote = "";
    const fixture = await startFixture(async ({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("## 名字\n\nWriter")) {
        writerHops += 1;
        if (writerHops === 1) {
          sawFirstWriter();
          await firstHeld;
          return sse(toolCallChunks("call_w", "list_dir", '{"path":"."}'));
        }
        heardNote = messages.filter((m) => m.role === "user").map((m) => m.content ?? "").at(-1) ?? "";
        return sse(textChunks("heard the handoff"));
      }
      if (system.includes("## 名字\n\nResearcher")) {
        return sse(toolCallChunks("call_1", "send_message", '{"body":"@Writer take this"}'));
      }
      return sse(textChunks("should not speak"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const researcher = bots.find((b) => b.name === "Researcher")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer go" }),
    });
    const first = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === writer.id,
    );
    await firstWriterArrived;
    // The group moves on to another job; the Researcher's line is about that one.
    h.store.openTask({ sessionId: groupId, title: "另一件事" });
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Researcher hand off" }),
    });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "@Writer take this" && e.author === researcher.id,
    );
    // Still one writer turn, still running: the handoff went into its inbox.
    expect(h.store.listLiveTurns({ sessionId: groupId, botId: writer.id }).map((turn) => turn.id)).toEqual([String(first.id)]);
    releaseFirst();
    const said = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "heard the handoff" && e.author === writer.id,
    );
    expect(said.turn_id).toBe(first.id);
    expect(heardNote).toContain("收件 1 条（这一段没有被打断）");
    expect(heardNote).toContain("[B1 Researcher] 〔规划「另一件事」〕@Writer take this");
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.id === first.id && e.status === "completed");
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.bot_id === writer.id && e.status === "redirected")).toBe(false);
    expect(new Set(sub.events.filter((e) => e.event === "turn.upsert" && e.bot_id === writer.id).map((e) => String(e.id)))).toEqual(new Set([String(first.id)]));
    sub.close();
  });

  /** Your own @ still turns the Bot around, and what the old turn had done comes along. */
  test("a user @ in a group redirects the live turn and carries what it had written", async () => {
    let writerHops = 0;
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sawSecondHop = () => {};
    const secondHopArrived = new Promise<void>((resolve) => {
      sawSecondHop = resolve;
    });
    let carried = "";
    const fixture = await startFixture(async ({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (!system.includes("## 名字\n\nWriter")) return sse(textChunks("should not speak"));
      writerHops += 1;
      if (writerHops === 1) return sse(toolCallChunks("call_w", "shell", '{"command":"printf draft > draft.md"}'));
      if (writerHops === 2) {
        sawSecondHop();
        await firstHeld;
        return sse(textChunks("first should not land"));
      }
      carried = messages.filter((m) => m.role === "user").map((m) => m.content ?? "").at(-1) ?? "";
      return sse(textChunks("turned around"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer draft it" }),
    });
    const first = await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === writer.id);
    await secondHopArrived;
    // The new line opens another job, so the note says which one the old turn was on.
    h.store.openTask({ sessionId: groupId, title: "提纲" });
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer stop, do the outline first" }),
    });
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.id === first.id && e.status === "redirected");
    await waitFor(sub.events, (e) => e.event === "message.created" && e.body === "turned around");
    expect(carried).toContain("你上一轮被上面这条新消息改道了");
    expect(carried).toContain("draft.md");
    expect(carried).toContain("shell printf draft > draft.md");
    expect(carried).toContain("它在做的是〔规划「@Writer draft it」〕。");
    releaseFirst();
    sub.close();
  });

  test("quoting a bot group message auto-@s them and opens their turn", async () => {
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("## 名字\n\nWriter")) {
        return sse(textChunks("first draft"));
      }
      if (system.includes("## 名字\n\nResearcher")) {
        return sse(textChunks("revised"));
      }
      return sse(textChunks("should not speak"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const researcher = bots.find((b) => b.name === "Researcher")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer go" }),
    });
    const draft = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "first draft" && e.author === writer.id,
    );
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "please revise", parent_id: draft.id }),
    });
    const quote = await waitFor(
      sub.events,
      (e) =>
        e.event === "message.created" &&
        e.kind === "user" &&
        e.parent_id === draft.id &&
        typeof e.body === "string" &&
        String(e.body).startsWith("@Writer "),
    );
    expect(quote.body).toBe("@Writer please revise");
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === writer.id && e.trigger_message_id === quote.id,
    );
    await Bun.sleep(40);
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.bot_id === researcher.id && e.trigger_message_id === quote.id)).toBe(
      false,
    );
    sub.close();
  });

  test("send_message status notes like 介绍已发出 are not posted in a group", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      hop += 1;
      if (hop === 1) {
        return sse(
          toolCallChunks("call_1", "send_message", '{"body":"介绍已经发出，并 @ 了同组的架构师和审查员，等他们各自发言。"}'),
        );
      }
      throw new Error("status closer should end the turn without another completion");
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
    ]);
    const writer = bots.find((b) => b.name === "Writer")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@Writer go" }),
    });
    const running = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === writer.id,
    );
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === running.id && e.status === "completed",
    );
    expect(hop).toBe(1);
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "bot")).toBe(false);
    sub.close();
  });

  test("@everyone opens every present bot and each one finishes a reply", async () => {
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const name = system.match(/## 名字\n\n(.+)/)?.[1] ?? "bot";
      return sse(textChunks(`${name} ready`));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "Writer", duties: "write" },
      { name: "Researcher", duties: "read" },
      { name: "Reviewer", duties: "review" },
    ]);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@everyone start together" }),
    });
    for (const bot of bots) {
      await waitFor(
        sub.events,
        (e) => e.event === "message.created" && e.kind === "bot" && e.author === bot.id,
        4000,
      );
      await waitFor(
        sub.events,
        (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === bot.id,
        4000,
      );
    }
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "system")).toBe(false);
    sub.close();
  });
});

describe("mention spelling in groups", () => {
  test("a bot's truncated @ resolves to the only matching member and wakes it", async () => {
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const name = system.match(/## 名字\n\n(.+)/)?.[1] ?? "bot";
      if (name === "导演") return sse(textChunks("@分镜 请按锁点出六场镜表"));
      return sse(textChunks("镜表已出"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "导演", duties: "direct" },
      { name: "分镜师", duties: "storyboard" },
    ]);
    const storyboard = bots.find((b) => b.name === "分镜师")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@导演 开始" }),
    });
    const reply = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === storyboard.id,
      4000,
    );
    expect(reply.body).toBe("镜表已出");
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === storyboard.id,
      4000,
    );
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "system")).toBe(false);
    sub.close();
  });

  test("a bot's @ before a digit is a timestamp, not a miss: no system note is posted", async () => {
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const name = system.match(/## 名字\n\n(.+)/)?.[1] ?? "bot";
      if (name === "导演") return sse(textChunks("全局峰值 −1.0 dB @37.79s，@分镜师 请复核"));
      return sse(textChunks("已复核"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "导演", duties: "direct" },
      { name: "分镜师", duties: "storyboard" },
    ]);
    const storyboard = bots.find((b) => b.name === "分镜师")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@导演 开始" }),
    });
    const reply = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.author === storyboard.id,
      4000,
    );
    expect(reply.body).toBe("已复核");
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === storyboard.id,
      4000,
    );
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "system")).toBe(false);
    sub.close();
  });

  test("a bot's unknown @ leaves a system note naming the members and wakes nobody", async () => {
    const fixture = await startFixture(({ body }) => {
      if (isJudgementRequest(body)) return judgementPass();
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const name = system.match(/## 名字\n\n(.+)/)?.[1] ?? "bot";
      if (name === "导演") return sse(textChunks("@张三 请出镜表"));
      return sse(textChunks("ok"));
    });
    const h = await startApi();
    const { bots, groupId } = await createGroupWithBots(h, fixture.origin, [
      { name: "导演", duties: "direct" },
      { name: "分镜师", duties: "storyboard" },
    ]);
    const director = bots.find((b) => b.name === "导演")!;
    const storyboard = bots.find((b) => b.name === "分镜师")!;
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "@导演 开始" }),
    });
    const note = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "system" && e.author === director.id,
      4000,
    );
    expect(note.body).toBe("@张三 没有匹配到群成员。在场：分镜师。点名请逐字写全名。");
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "completed" && e.bot_id === director.id,
      4000,
    );
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.bot_id === storyboard.id)).toBe(false);
    sub.close();
  });
});

describe("a Bot↔Bot direct", () => {
  async function addResearcher(h: Harness): Promise<string> {
    const res = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Researcher", duties: "dig", boundaries: "stay" }),
    });
    return ((await res.json()) as { bot: { id: string } }).bot.id;
  }

  test("one bot's message wakes the other", async () => {
    const fixture = await startFixture(() => sse(textChunks("on it")));
    const h = await startApi();
    const { botId } = await createWriter(h, fixture.origin);
    const researcherId = await addResearcher(h);
    const direct = h.store.createBotDirect(botId, researcherId, null);
    const sub = await subscribe(h);

    const opener = h.store.insertMessage({
      sessionId: direct.id,
      kind: "bot",
      author: botId,
      body: "what did you find?",
    });
    await h.engine.handleInboundMessage(opener, { fromUser: false });

    const turn = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.bot_id === researcherId && e.session_id === direct.id,
    );
    expect(turn.trigger_message_id).toBe(opener.id);
    sub.close();
  });

  /**
   * A turn's plain reply is its send_message. Only groups used to read it for who to wake, so a
   * reviewer answering a submission this way left the other side waiting for good.
   */
  test("a turn's closing reply wakes the other bot too, not only send_message", async () => {
    let n = 0;
    const fixture = await startFixture(() => {
      n += 1;
      return sse(textChunks(n === 1 ? "found three sources" : "no new work"));
    });
    const h = await startApi();
    const { botId } = await createWriter(h, fixture.origin);
    const researcherId = await addResearcher(h);
    const direct = h.store.createBotDirect(botId, researcherId, null);
    const sub = await subscribe(h);

    const opener = h.store.insertMessage({
      sessionId: direct.id,
      kind: "bot",
      author: botId,
      body: "what did you find?",
    });
    await h.engine.handleInboundMessage(opener, { fromUser: false });

    const reply = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.author === researcherId && e.session_id === direct.id,
    );
    expect(reply.body).toBe("found three sources");
    const back = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.bot_id === botId && e.session_id === direct.id,
    );
    expect(back.trigger_message_id).toBe(reply.id);
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.id === back.id && e.status === "completed",
    );
    sub.close();
  });

  /**
   * With no user in the room there is nobody to want two answers at once, so a second message is
   * heard by the live turn rather than cloning or ending it. One that lands after the turn's last
   * hop started is not lost: the turn closes, and one more turn opens on it. The user↔Bot default
   * stays fork.
   */
  test("a second message is heard by the live turn, and one it never read opens the next turn", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    const fixture = await startFixture(async () => {
      n += 1;
      if (n === 1) {
        await held;
        return sse(textChunks("first"));
      }
      return sse(textChunks("no new work"));
    });
    const h = await startApi();
    const { botId } = await createWriter(h, fixture.origin);
    const researcherId = await addResearcher(h);
    const direct = h.store.createBotDirect(botId, researcherId, null);
    const sub = await subscribe(h);

    const one = h.store.insertMessage({
      sessionId: direct.id,
      kind: "bot",
      author: botId,
      body: "one",
    });
    await h.engine.handleInboundMessage(one, { fromUser: false });
    const first = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "running" && e.bot_id === researcherId,
    );

    const two = h.store.insertMessage({
      sessionId: direct.id,
      kind: "bot",
      author: botId,
      body: "two",
    });
    await h.engine.handleInboundMessage(two, { fromUser: false });
    expect(h.store.listLiveTurns({ sessionId: direct.id, botId: researcherId }).map((turn) => turn.id)).toEqual([String(first.id)]);
    release();
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.id === first.id && e.status === "completed");
    const next = await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.bot_id === researcherId && e.id !== first.id,
    );
    expect(next.trigger_message_id).toBe(two.id);
    expect(sub.events.some((e) => e.event === "turn.upsert" && e.id === first.id && e.status === "redirected")).toBe(false);
    sub.close();
  });

  /**
   * Every publisher builds the payload from one helper. If a hand-rolled copy comes back, the
   * direct silently loses the entry point it hangs under, so pin it on the wire.
   */
  test("session.upsert carries where the direct came from", async () => {
    const fixture = await startFixture(() => sse(textChunks("ok")));
    const h = await startApi();
    const { botId } = await createWriter(h, fixture.origin);
    const researcherId = await addResearcher(h);
    const group = h.store.createGroup({ name: "Desk", members: [botId, researcherId] });
    const trigger = h.store.postMessage(group.id, { body: "price the competition" });
    const turn = h.store.createTurn({ sessionId: group.id, botId, triggerMessageId: trigger.id });
    const opened = await runCollabTool(
      { store: h.store, botId, sessionId: group.id, turnId: turn.id, parentId: null },
      "create_direct",
      { name: "Researcher" },
    );
    const directId = String(opened.data?.session_id);
    const sub = await subscribe(h);

    await fetch(`${h.origin}/v1/sessions/${directId}/archive`, {
      method: "POST",
      headers: auth(h),
    });
    const event = await waitFor(
      sub.events,
      (e) => e.event === "session.upsert" && e.id === directId,
    );
    expect(event.origin_session_id).toBe(group.id);
    expect(event.origin_message_id).toBe(trigger.id);
    sub.close();
  });
});
