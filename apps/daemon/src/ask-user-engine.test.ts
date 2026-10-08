import { describe, expect, test } from "bun:test";
import { createWriter, jsonAuth as auth, registerLocalApiCleanup, sse, subscribe, waitFor } from "./test-kit/local-api-harness";
import { startApi, startFixture, textChunks } from "./test-kit/engine-fixtures";

registerLocalApiCleanup();

describe("turn engine on the local API", () => {
  test("ask_user parks the turn and a reply continues the same turn", async () => {
    let hop = 0;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse([
          {
            id: "chatcmpl-1",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_ask",
                      function: { name: "ask_user", arguments: '{"question":"which tone?"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-1",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          },
        ]);
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      expect(messages.some((m) => m.role === "tool" && String(m.content).includes("formal"))).toBe(true);
      return sse(textChunks("got it"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "ask me" }),
    });
    const ask = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "ask" && e.author === botId,
    );
    expect(ask.body).toBe("which tone?");
    await waitFor(
      sub.events,
      (e) => e.event === "turn.upsert" && e.status === "waiting_ask" && e.id === ask.turn_id,
    );
    const reply = await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "formal", ask_id: ask.id }),
    });
    expect(reply.status).toBe(201);
    // An older client answering this way still gets its text written onto the question.
    const answered = (await reply.json()) as { id: string; ask_answer: { selected: string[]; custom: string } };
    expect(answered.id).toBe(ask.id as string);
    expect(answered.ask_answer).toMatchObject({ selected: [], custom: "formal" });
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "got it" && e.turn_id === ask.turn_id,
    );
    expect(sub.events.some((e) => e.event === "message.created" && e.author === "user" && e.body === "formal")).toBe(false);
    sub.close();
  });

  test("ask_user offers choices, and the answer is written onto the question instead of posted", async () => {
    let hop = 0;
    let toolResult: Record<string, unknown> | null = null;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse([
          {
            id: "chatcmpl-1",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_ask",
                      function: {
                        name: "ask_user",
                        arguments: JSON.stringify({
                          question: "Which sections go in?",
                          options: [
                            { label: "Summary (Recommended)", description: "one paragraph up top" },
                            "Numbers",
                            { label: "Risks" },
                          ],
                          multi_select: true,
                        }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const tool = messages.find((m) => m.role === "tool");
      toolResult = JSON.parse(String(tool?.content)) as Record<string, unknown>;
      return sse(textChunks("on it"));
    });
    const h = await startApi();
    const { botId, sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "draft the report" }),
    });
    const ask = await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "ask" && e.author === botId,
    );
    expect(ask.ask).toEqual({
      options: [
        { label: "Summary (Recommended)", description: "one paragraph up top" },
        { label: "Numbers" },
        { label: "Risks" },
      ],
      multi_select: true,
    });
    expect(ask.ask_answer).toBeNull();
    await waitFor(sub.events, (e) => e.event === "turn.upsert" && e.status === "waiting_ask" && e.id === ask.turn_id);

    const unknown = await fetch(`${h.origin}/v1/messages/${ask.id}/answer`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ selected: ["Charts"] }),
    });
    expect(unknown.status).toBe(422);

    const reply = await fetch(`${h.origin}/v1/messages/${ask.id}/answer`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ selected: ["Risks", "Summary (Recommended)"], custom: "  keep it short  " }),
    });
    expect(reply.status).toBe(200);
    const answered = (await reply.json()) as { id: string; kind: string; ask_answer: Record<string, unknown> };
    expect(answered.id).toBe(ask.id as string);
    expect(answered.ask_answer).toMatchObject({ selected: ["Summary (Recommended)", "Risks"], custom: "keep it short" });
    await waitFor(sub.events, (e) => e.event === "message.upsert" && e.id === ask.id && e.ask_answer != null);
    await waitFor(
      sub.events,
      (e) => e.event === "message.created" && e.kind === "bot" && e.body === "on it" && e.turn_id === ask.turn_id,
    );
    expect(toolResult).toMatchObject({
      ok: true,
      data: {
        ask_id: ask.id,
        selected: ["Summary (Recommended)", "Risks"],
        custom: "keep it short",
        answer: "Summary (Recommended)\nRisks\nkeep it short",
      },
    });
    const page = h.store.listMessages(sessionId as string).items;
    expect(page.filter((m) => m.author === "user").map((m) => m.body)).toEqual(["draft the report"]);
    expect(page.find((m) => m.id === ask.id)?.ask_answer?.selected).toEqual(["Summary (Recommended)", "Risks"]);

    const again = await fetch(`${h.origin}/v1/messages/${ask.id}/answer`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ custom: "changed my mind" }),
    });
    expect(again.status).toBe(422);
    sub.close();
  });

  test("ask_user sends unclear choices back to the Bot", async () => {
    let hop = 0;
    let toolResult: Record<string, unknown> | null = null;
    const fixture = await startFixture(({ body }) => {
      hop += 1;
      if (hop === 1) {
        return sse([
          {
            id: "chatcmpl-1",
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{
                  index: 0,
                  id: "call_ask",
                  function: { name: "ask_user", arguments: JSON.stringify({ question: "Pick", options: ["A", "A"] }) },
                }],
              },
              finish_reason: null,
            }],
          },
          { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      }
      const messages = body.messages as Array<{ role: string; content?: string }>;
      toolResult = JSON.parse(String(messages.find((m) => m.role === "tool")?.content)) as Record<string, unknown>;
      return sse(textChunks("fine"));
    });
    const h = await startApi();
    const { sessionId } = await createWriter(h, fixture.origin);
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "go" }),
    });
    await waitFor(sub.events, (e) => e.event === "message.created" && e.kind === "bot" && e.body === "fine");
    expect(toolResult).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(sub.events.some((e) => e.event === "message.created" && e.kind === "ask")).toBe(false);
    sub.close();
  });
});
