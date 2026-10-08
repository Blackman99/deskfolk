import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { ORGANIZER_SYSTEM } from "./prompts/organizer";
import { JUDGEMENT_SYSTEM } from "./prompts/judgement";
import { READ_BOT_LINE_SYSTEM, READ_USER_LINE_SYSTEM } from "./prompts/reader";
import { SCRIBE_SYSTEM } from "./prompts/scribe";
import { ROUTE_LEARN_SYSTEM, ROUTE_PICK_SYSTEM, ROUTE_REVIEW_SYSTEM } from "./prompts/routing";
import { Store } from "./store";
import { harnesses, jsonAuth as auth, registerLocalApiCleanup, sse, subscribe, waitFor, type Harness } from "./test-kit/local-api-harness";
import { isComposerSuggestRequest, isJudgementRequest, judgementPass, startApi, startFixture, textChunks } from "./test-kit/engine-fixtures";

registerLocalApiCleanup();

type LedgerRow = {
  kind: string;
  purpose: string | null;
  session_id: string;
  session_name: string | null;
  bot_id: string | null;
  bot_name: string | null;
  turn_id: string | null;
  judgement_id: string | null;
  chain_id: string | null;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  thinking_level: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  missing_reason: string | null;
};

/** A non-streaming answer. `usage: null` is a body with no usage; omit it to leave usage off entirely. */
function judgeBody(content: string | null, usage?: Record<string, number> | null, status = 200): Response {
  const body: Record<string, unknown> = {
    choices: content === null ? [] : [{ message: { role: "assistant", content } }],
  };
  if (usage !== undefined) body.usage = usage;
  return Response.json(body, { status });
}

function systemOf(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ role?: string; content?: string }> | undefined;
  return messages?.find((row) => row.role === "system")?.content ?? "";
}

function ledger(store: Store): LedgerRow[] {
  return store.db.query<LedgerRow, []>(`SELECT * FROM spend ORDER BY created_at ASC, id ASC`).all();
}

/**
 * The restart sweep only reviews a chain that went quiet. Age its rows past the quiet window:
 * when its turns started and ended, and when you last said something about them.
 */
function ageChain(store: Store, quietMs: number): void {
  const at = new Date(Date.now() - quietMs).toISOString();
  store.db.run(
    `UPDATE turn_route_decisions SET created_at = ?, finished_at = CASE WHEN finished_at IS NULL THEN NULL ELSE ? END`,
    [at, at],
  );
  store.db.run(`UPDATE route_feedback SET created_at = ?`, [at]);
}

const PICK = '{"model":"code-pro","thinking_level":"high","reason":"要改代码","continues_previous":false}';
const PICK_CONTINUE = '{"model":"code-pro","thinking_level":"high","reason":"还在改","continues_previous":true}';
const REVIEW = '{"fault":"model","direction":"stronger","rounds":1,"confidence":0.9,"reason":"改偏了"}';
const SUGGEST = JSON.stringify({
  suggestions: [{ label: "继续", prompt: "继续写" }],
});
const USAGE = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, cost_in_usd_ticks: 9 };

describe("spend ledger for routing and composer calls", () => {
  async function catalog(h: Harness, origin: string): Promise<void> {
    mkdirSync("/tmp/real-bot-ws", { recursive: true });
    const patched = await fetch(`${h.origin}/v1/settings`, {
      method: "PATCH",
      headers: auth(h),
      body: JSON.stringify({
        workspace_path: "/tmp/real-bot-ws",
        endpoint_base_url: origin,
        endpoint_api_key: "sk-test",
        endpoint_models: [
          { name: "cheap-chat", price: 1, thinking_levels: ["none", "low"], strengths: ["chat"] },
          { name: "code-pro", price: 12, thinking_levels: ["medium", "high"], strengths: ["code"] },
          { name: "flash-lite", price: 1, thinking_levels: ["low"], strengths: ["chat"] },
        ],
        endpoint_default_model: "cheap-chat",
      }),
    });
    expect(patched.status).toBe(200);
  }

  function routeAnswer(
    body: Record<string, unknown>,
    mode: "usage" | "omitted" | "error" | "down",
    pick: string = PICK,
  ): Response {
    const system = systemOf(body);
    if (mode === "down") return judgeBody(null, null, 500);
    const content =
      system === ROUTE_REVIEW_SYSTEM ? REVIEW : system === ROUTE_LEARN_SYSTEM ? "{}" : system === ROUTE_PICK_SYSTEM ? pick : "{}";
    if (mode === "error") return judgeBody(null, USAGE, 500);
    if (mode === "omitted") return judgeBody(content, null);
    return judgeBody(content, USAGE);
  }

  test("a private message, two follow-ups and a quiet close record pick, turn, review and one learn hop", async () => {
    const calls: string[] = [];
    let picks = 0;
    const fixture = await startFixture(
      ({ body }) => {
        if (isJudgementRequest(body)) return judgementPass();
        return sse(textChunks("ok", { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }));
      },
      ({ body }) => {
        calls.push(systemOf(body));
        const system = systemOf(body);
        if (system === ROUTE_PICK_SYSTEM) {
          picks += 1;
          return routeAnswer(body, "usage", picks === 1 ? PICK : PICK_CONTINUE);
        }
        return routeAnswer(body, "usage");
      },
    );
    const h = await startApi();
    await catalog(h, fixture.origin);
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
    });
    const body = (await created.json()) as { bot: { id: string; name: string }; direct_session: { id: string } };
    const sub = await subscribe(h);
    for (const text of ["把这个函数重构一下", "这里不对", "还是不行"]) {
      await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ body: text }),
      });
      const done = sub.events.filter((event) => event.event === "turn.upsert" && event.status === "completed").length;
      await waitFor(
        sub.events,
        () => sub.events.filter((event) => event.event === "turn.upsert" && event.status === "completed").length > done,
        4000,
      );
    }
    // The chain stays open until the user goes quiet. The restart sweep is that same review path.
    ageChain(h.store, 16 * 60_000);
    h.engine.sweepStaleChains();
    await waitFor(sub.events, () => calls.includes(ROUTE_LEARN_SYSTEM), 4000);
    // The scribe notes each line after its turn has started; a drain would drop one still queued.
    await waitFor(sub.events, () => h.store.listWorkEvents({ kind: "scribe.answer" }).length === 3, 4000);
    await h.engine.drain();

    const all = ledger(h.store);
    // Each of the three user messages was read before anything acted on it (ADR 0055), and the
    // Bot's lines once per text: billed as organize with the reader's own purpose, one row a call.
    const reads = calls.filter((call) => call === READ_USER_LINE_SYSTEM || call === READ_BOT_LINE_SYSTEM);
    expect(calls.filter((call) => call === READ_USER_LINE_SYSTEM)).toHaveLength(3);
    const read = all.filter((row) => row.purpose === "reader");
    expect(read).toHaveLength(reads.length);
    for (const row of read) expect(row).toMatchObject({ kind: "organize", session_id: body.direct_session.id, bot_id: null, turn_id: null, model: "cheap-chat" });
    // Each of the three user messages was organized first and noted by the scribe after (billed as
    // the same kind, the scribe's with its own purpose), on the default model, owned by nobody.
    const organized = all.filter((row) => row.kind === "organize" && row.purpose !== "reader");
    expect(organized).toHaveLength(6);
    expect(calls.filter((call) => call === SCRIBE_SYSTEM)).toHaveLength(3);
    expect(organized.map((row) => row.purpose ?? "organizer").sort()).toEqual(["organizer", "organizer", "organizer", "scribe", "scribe", "scribe"]);
    for (const row of organized) {
      expect(row).toMatchObject({ session_id: body.direct_session.id, bot_id: null, turn_id: null, model: "cheap-chat", thinking_level: null });
      expect(row.input_tokens).not.toBeNull();
    }
    const rows = all.filter((row) => row.kind !== "organize");
    const kinds = rows.map((row) => row.kind);
    expect(kinds.filter((kind) => kind === "route_pick")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "turn")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "route_review")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "route_learn")).toHaveLength(1);
    const providerId = (await h.store.listProviders())[0]!.id;
    const chainId = h.store.listSessionRoutes(body.direct_session.id)[0]!.chain_id;
    for (const row of rows) {
      expect(row.session_id).toBe(body.direct_session.id);
      expect(row.session_name).toBe("Writer");
      expect(row.bot_id).toBe(body.bot.id);
      expect(row.bot_name).toBe("Writer");
      expect(row.provider_id).toBe(providerId);
      expect(row.provider_name).toBe("Default");
      expect(row.input_tokens).not.toBeNull();
      expect(row.missing_reason).toBeNull();
    }
    for (const row of rows.filter((row) => row.kind === "route_pick" || row.kind === "route_review" || row.kind === "route_learn")) {
      expect(row.model).toBe("cheap-chat");
      expect(row.thinking_level).toBeNull();
      expect(row.chain_id).toBe(row.kind === "route_pick" ? null : chainId);
    }
    const turns = h.store.listSessionRoutes(body.direct_session.id);
    expect(rows.filter((row) => row.kind === "route_pick").map((row) => row.turn_id).sort()).toEqual(
      turns.map((row) => row.turn_id).sort(),
    );
    expect(rows.find((row) => row.kind === "route_review")!.turn_id).toBe(turns[0]!.turn_id);
    expect(rows.find((row) => row.kind === "turn")!.model).toBe("code-pro");
    expect(rows.find((row) => row.kind === "turn")!.thinking_level).toBe("high");
    sub.close();
  });

  test("a clean quiet chain is recorded locally and spends nothing on review or learning", async () => {
    const calls: string[] = [];
    const fixture = await startFixture(
      () => sse(textChunks("ok")),
      ({ body }) => {
        calls.push(systemOf(body));
        return routeAnswer(body, "usage");
      },
    );
    const h = await startApi();
    await catalog(h, fixture.origin);
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
    });
    const body = (await created.json()) as { bot: { id: string }; direct_session: { id: string } };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "你好" }),
    });
    await waitFor(sub.events, (event) => event.event === "turn.upsert" && event.status === "completed");
    ageChain(h.store, 16 * 60_000);
    h.engine.sweepStaleChains();
    await waitFor(sub.events, () => h.store.listWorkEvents({ kind: "scribe.answer" }).length === 1, 4000);
    await h.engine.drain();
    expect(calls.filter((call) => ![ORGANIZER_SYSTEM, SCRIBE_SYSTEM, READ_USER_LINE_SYSTEM, READ_BOT_LINE_SYSTEM].includes(call))).toEqual([ROUTE_PICK_SYSTEM]);
    const rows = ledger(h.store);
    // Your line and the Bot's reply were each read once (ADR 0055), billed apart as the reader's.
    expect(rows.filter((row) => row.purpose === "reader")).toHaveLength(2);
    expect(rows.filter((row) => row.purpose !== "reader").map((row) => row.kind).sort()).toEqual(["organize", "organize", "route_pick", "turn"]);
    expect(h.store.listSessionReviews(body.direct_session.id)[0]).toMatchObject({ fault: "none" });
    sub.close();
  });

  test("a bot with model and thinking level pinned never calls routing and writes no route_pick", async () => {
    const calls: string[] = [];
    const fixture = await startFixture(
      ({ body }) => {
        expect(body.model).toBe("code-pro");
        expect(body.reasoning_effort).toBe("high");
        return sse(textChunks("ok", USAGE));
      },
      ({ body }) => {
        calls.push(systemOf(body));
        return routeAnswer(body, "usage");
      },
    );
    const h = await startApi();
    await catalog(h, fixture.origin);
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({
        name: "Writer",
        duties: "write",
        boundaries: "stay",
        model: "code-pro",
        thinking_level: "high",
      }),
    });
    const body = (await created.json()) as { bot: { id: string }; direct_session: { id: string } };
    const sub = await subscribe(h);
    await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
      method: "POST",
      headers: auth(h),
      body: JSON.stringify({ body: "please implement a TypeScript function that parses the AST" }),
    });
    await waitFor(sub.events, (event) => event.event === "turn.upsert" && event.status === "completed");
    await waitFor(sub.events, () => h.store.listWorkEvents({ kind: "scribe.answer" }).length === 1, 4000);
    await h.engine.drain();
    // The pin covers the Bot's own calls; the reader, the organizer and the scribe still run once
    // each for your line, on the default model (and the reader once more for the Bot's reply).
    expect(calls.filter((call) => call !== READ_BOT_LINE_SYSTEM)).toEqual([READ_USER_LINE_SYSTEM, ORGANIZER_SYSTEM, SCRIBE_SYSTEM]);
    const rows = ledger(h.store);
    expect(rows.filter((row) => row.purpose === "reader")).toHaveLength(2);
    expect(rows.filter((row) => row.purpose !== "reader").map((row) => row.kind).sort()).toEqual(["organize", "organize", "turn"]);
    // Every side-call, the readings included, runs on the default model and is nobody's Bot's.
    expect(rows.filter((row) => row.kind === "organize")).toHaveLength(4);
    for (const row of rows.filter((entry) => entry.kind === "organize")) expect(row).toMatchObject({ model: "cheap-chat", bot_id: null });
    expect(rows.find((row) => row.kind === "turn")).toMatchObject({ model: "code-pro", thinking_level: "high", bot_id: body.bot.id });
    sub.close();
  });

  test.each(["route_pick", "route_review", "route_learn"] as const)(
    "%s records usage, an omitted body, an error that still reported usage, and nothing when the endpoint is unreachable",
    async (kind) => {
      for (const mode of ["usage", "omitted", "error", "down"] as const) {
        const calls: string[] = [];
        const fixture = await startFixture(
          () => sse(textChunks("ok")),
          ({ body }) => {
            const system = systemOf(body);
            calls.push(system);
            if (kind === "route_pick" && system === ROUTE_PICK_SYSTEM) return routeAnswer(body, mode);
            if (kind !== "route_pick" && system === ROUTE_PICK_SYSTEM) return routeAnswer(body, "usage");
            if (system === ROUTE_REVIEW_SYSTEM) {
              return kind === "route_review" ? routeAnswer(body, mode) : routeAnswer(body, "usage");
            }
            return routeAnswer(body, mode);
          },
        );
        const h = await startApi();
        await catalog(h, fixture.origin);
        const created = await fetch(`${h.origin}/v1/bots`, {
          method: "POST",
          headers: auth(h),
          body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
        });
        const body = (await created.json()) as { direct_session: { id: string } };
        const sub = await subscribe(h);
        await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
          method: "POST",
          headers: auth(h),
          body: JSON.stringify({ body: "把这个函数重构一下" }),
        });
        await waitFor(sub.events, (event) => event.event === "turn.upsert" && event.status === "completed");
        if (kind !== "route_pick") {
          await fetch(`${h.origin}/v1/sessions/${body.direct_session.id}/messages`, {
            method: "POST",
            headers: auth(h),
            body: JSON.stringify({ body: "这里不对" }),
          });
          await waitFor(
            sub.events,
            () => sub.events.filter((event) => event.event === "turn.upsert" && event.status === "completed").length >= 2,
          );
          ageChain(h.store, 16 * 60_000);
          h.engine.sweepStaleChains();
          if (mode !== "down" || kind !== "route_review") {
            await waitFor(sub.events, () => calls.includes(kind === "route_learn" ? ROUTE_LEARN_SYSTEM : ROUTE_REVIEW_SYSTEM), 4000);
          } else {
            await waitFor(sub.events, () => calls.includes(ROUTE_REVIEW_SYSTEM), 4000);
          }
        }
        await h.engine.drain();
        const row = ledger(h.store).find((item) => item.kind === kind);
        if (mode === "down") {
          expect(row).toBeUndefined();
        } else if (mode === "omitted") {
          expect(row).toMatchObject({ input_tokens: null, total_tokens: null, missing_reason: "endpoint_omitted" });
        } else {
          expect(row).toMatchObject({ input_tokens: 11, output_tokens: 3, total_tokens: 14, missing_reason: null });
        }
        sub.close();
        await h.close();
        harnesses.pop();
      }
    },
    20_000,
  );

  test("composer suggestions record the light model, a missing usage, an error usage, and nothing when unreachable", async () => {
    const modes = ["usage", "omitted", "error", "down"] as const;
    for (const mode of modes) {
      const fixture = await startFixture(({ body }) => {
        if (isComposerSuggestRequest(body)) {
          expect(body.model).toBe("flash-lite");
          if (mode === "down") return judgeBody(null, null, 500);
          if (mode === "error") return judgeBody(null, USAGE, 500);
          if (mode === "omitted") return judgeBody(SUGGEST, null);
          return judgeBody(SUGGEST, USAGE);
        }
        if (isJudgementRequest(body)) return judgementPass();
        return sse(textChunks("ok"));
      });
      const h = await startApi();
      await catalog(h, fixture.origin);
      const writer = (await (
        await fetch(`${h.origin}/v1/bots`, {
          method: "POST",
          headers: auth(h),
          body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
        })
      ).json()) as { bot: { id: string } };
      const reviewer = (await (
        await fetch(`${h.origin}/v1/bots`, {
          method: "POST",
          headers: auth(h),
          body: JSON.stringify({ name: "Reviewer", duties: "review", boundaries: "stay" }),
        })
      ).json()) as { bot: { id: string } };
      const groupId = ((await (
        await fetch(`${h.origin}/v1/sessions`, {
          method: "POST",
          headers: auth(h),
          body: JSON.stringify({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] }),
        })
      ).json()) as { id: string }).id;
      await fetch(`${h.origin}/v1/sessions/${groupId}/messages`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ body: "请各自介绍" }),
      });
      const res = await fetch(`${h.origin}/v1/sessions/${groupId}/composer-suggestions`, { headers: auth(h) });
      expect(res.status).toBe(200);
      const row = ledger(h.store).find((item) => item.kind === "composer_suggest");
      if (mode === "down") {
        expect(row).toBeUndefined();
        expect(await res.json()).toEqual({ items: [] });
      } else {
        expect(row).toMatchObject({
          session_id: groupId,
          session_name: "Brief",
          bot_id: null,
          bot_name: null,
          turn_id: null,
          chain_id: null,
          model: "flash-lite",
          thinking_level: null,
          provider_name: "Default",
        });
        if (mode === "omitted") {
          expect(row!.missing_reason).toBe("endpoint_omitted");
          expect(row!.input_tokens).toBeNull();
        } else {
          expect(row).toMatchObject({ input_tokens: 11, missing_reason: null });
        }
      }
      await h.close();
      harnesses.pop();
    }
  });

  test("a composer suggestion cancelled after the response came back is still recorded", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await startFixture(() => sse(textChunks("unused")));
    const h = await startApi(undefined, {
      completions: {
        complete: () => Promise.reject(new Error("unused")),
        async judge(request) {
          entered();
          await held;
          // The user's abort arrived while this call was out. The body still came back.
          expect(request.signal.aborted).toBe(true);
          return {
            content: SUGGEST,
            toolCalls: [],
            hadToolCalls: false,
            usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14, cached_tokens: null, reasoning_tokens: null, cost_usd_ticks: 9 },
            failKind: null,
          };
        },
      },
    });
    await catalog(h, fixture.origin);
    const writer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const reviewer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Reviewer", duties: "review", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const groupId = ((await (
      await fetch(`${h.origin}/v1/sessions`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] }),
      })
    ).json()) as { id: string }).id;
    const controller = new AbortController();
    const pending = h.engine.suggestComposer(groupId, controller.signal);
    await started;
    controller.abort();
    release();
    await expect(pending).resolves.toEqual([]);
    await h.engine.drain();
    const row = ledger(h.store).find((item) => item.kind === "composer_suggest");
    expect(row).toMatchObject({
      session_id: groupId,
      bot_id: null,
      model: "flash-lite",
      input_tokens: 11,
      missing_reason: null,
    });
  });

  test("a composer suggestion cancelled before any response writes no row", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (reason?: unknown) => void;
    const held = new Promise<never>((_, reject) => {
      release = reject;
    });
    const fixture = await startFixture(() => sse(textChunks("unused")));
    const h = await startApi(undefined, {
      completions: {
        complete: () => Promise.reject(new Error("unused")),
        async judge() {
          entered();
          return held;
        },
      },
    });
    await catalog(h, fixture.origin);
    const writer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const reviewer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Reviewer", duties: "review", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const groupId = ((await (
      await fetch(`${h.origin}/v1/sessions`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] }),
      })
    ).json()) as { id: string }).id;
    const controller = new AbortController();
    const pending = h.engine.suggestComposer(groupId, controller.signal);
    await started;
    controller.abort();
    release(new DOMException("aborted", "AbortError"));
    await expect(pending).resolves.toEqual([]);
    await h.engine.drain();
    expect(ledger(h.store).some((row) => row.kind === "composer_suggest")).toBe(false);
  });

  /**
   * Suggestions are drafted when someone presses ✨ and waits for them. The 8s they had as a silent
   * background fetch timed out on a thinking "flash" model (3-8s measured), and a press came back empty.
   */
  test("a composer suggestion waits long enough for a thinking model to answer", async () => {
    let timeoutMs: number | undefined;
    const fixture = await startFixture(() => sse(textChunks("unused")));
    const h = await startApi(undefined, {
      completions: {
        complete: () => Promise.reject(new Error("unused")),
        async judge(request: { timeoutMs?: number }) {
          timeoutMs = request.timeoutMs;
          return { content: SUGGEST, toolCalls: [], hadToolCalls: false, usage: null, failKind: null };
        },
      },
    });
    await catalog(h, fixture.origin);
    const writer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const reviewer = (await (
      await fetch(`${h.origin}/v1/bots`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Reviewer", duties: "review", boundaries: "stay" }),
      })
    ).json()) as { bot: { id: string } };
    const groupId = ((await (
      await fetch(`${h.origin}/v1/sessions`, {
        method: "POST",
        headers: auth(h),
        body: JSON.stringify({ name: "Brief", members: [writer.bot.id, reviewer.bot.id] }),
      })
    ).json()) as { id: string }).id;
    await h.engine.suggestComposer(groupId);
    expect(timeoutMs).toBeGreaterThanOrEqual(20_000);
  });
});

for (const end of ["stop", "delete"] as const) {
  test(`returned paid turn usage survives ${end} before the response settles`, async () => {
    let entered!: () => void;
    const began = new Promise<void>((resolve) => { entered = resolve; });
    let respond!: (value: import("./completions").CompletionResult) => void;
    const pending = new Promise<import("./completions").CompletionResult>((resolve) => { respond = resolve; });
    const h = await startApi(undefined, { completions: {
      async complete() { entered(); return pending; },
      async judge() { return { content: "{}", toolCalls: [], hadToolCalls: false, usage: null, failKind: null }; },
    } });
    const provider = await h.store.createProvider({ name: "Billing", base_url: "http://unused.invalid", api_key: "fixture", models: [{ name: "model", thinking_levels: ["high"] }] });
    const created = h.store.createBot({ name: "Paid", duties: "test", boundaries: "fixture", model: "model", thinking_level: "high" });
    const trigger = h.store.postMessage(created.direct_session.id, { body: "do it" });
    await h.engine.handleInboundMessage(trigger);
    await began;
    const turn = h.store.listLiveTurns()[0]!;
    h.engine.stop(turn.id);
    if (end === "delete") {
      h.store.clearSessionMessages(created.direct_session.id);
      h.store.deleteBot(created.bot.id);
    }
    respond({ ok: true, content: "late", toolCalls: [], finishReason: "stop", hadChoices: true,
      usage: { input_tokens: 10, output_tokens: 2, cached_tokens: null, reasoning_tokens: null, total_tokens: 12, cost_usd_ticks: 8 }, missingReason: null });
    await h.engine.drain();
    expect(h.store.listSpend({ session_id: created.direct_session.id }).filter((row) => row.kind !== "organize")).toMatchObject([{
      kind: "turn", turn_id: turn.id, bot_name: "Paid", session_name: "Paid", provider_id: provider.id,
      model: "model", thinking_level: "high", total_tokens: 12, cost_usd_ticks: 8,
    }]);
  });
}

test("judgements record an unspecified reasoning level when the request sends none", async () => {
  const requests: import("./completions").JudgeRequest[] = [];
  const h = await startApi(undefined, { completions: {
    async complete() { throw new Error("a pass cannot open a turn"); },
    async judge(request) { requests.push(request); return { content: '{"decision":"pass","reason":"fixture"}', toolCalls: [], hadToolCalls: false,
      usage: { input_tokens: 10, output_tokens: 2, cached_tokens: null, reasoning_tokens: null, total_tokens: 12, cost_usd_ticks: 8 }, failKind: null }; },
  } });
  await h.store.createProvider({ name: "Billing", base_url: "http://unused.invalid", api_key: "fixture", models: [{ name: "model", thinking_levels: ["high"] }] });
  const a = h.store.createBot({ name: "First", duties: "test", boundaries: "fixture", model: "model", thinking_level: "high" });
  const b = h.store.createBot({ name: "Second", duties: "test", boundaries: "fixture", model: "model", thinking_level: "high" });
  const group = h.store.createGroup({ name: "Judgements", members: [a.bot.id, b.bot.id] });
  await h.engine.handleInboundMessage(h.store.postMessage(group.id, { body: "Anyone?" }));
  await h.engine.drain();
  const judged = requests.filter((request) => request.messages[0]?.content === JUDGEMENT_SYSTEM);
  expect(judged).toHaveLength(2);
  expect(judged.every((request) => !("thinkingLevel" in request))).toBe(true);
  const rows = h.store.listSpend({ session_id: group.id }).filter((row) => row.kind !== "organize");
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.kind === "judgement" && row.model === "model" && row.thinking_level === null)).toBe(true);
});
