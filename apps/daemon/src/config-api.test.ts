import { describe, expect, test } from "bun:test";
import { auth, registerLocalApiCleanup, startLocalApi } from "./test-kit/local-api-harness";

registerLocalApiCleanup();

const start = (opts: Parameters<typeof startLocalApi>[0] = {}) => startLocalApi(opts);

describe("empty roster and settings", () => {
  test("skills CRUD publishes upsert and removed events", async () => {
    const h = await start();
    const created = await fetch(`${h.origin}/v1/bots`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "Writer", duties: "write", boundaries: "stay" }),
    });
    const bot = (await created.json()) as { bot: { id: string } };
    const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const events: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (ev) => {
      events.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    });
    ws.send(JSON.stringify({ type: "auth", token: h.token }));
    await Bun.sleep(20);
    const posted = await fetch(`${h.origin}/v1/skills`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        bot_id: bot.bot.id,
        name: "commits",
        description: "when committing",
        body: "use conventional commits",
        uses: ["github", ""],
      }),
    });
    expect(posted.status).toBe(201);
    const skill = (await posted.json()) as { id: string; name: string; enabled: boolean; uses: string[] };
    expect(skill.name).toBe("commits");
    expect(skill.enabled).toBe(true);
    expect(skill.uses).toEqual(["github"]);
    const reUsed = await fetch(`${h.origin}/v1/skills/${skill.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ uses: ["github", "slack"] }),
    });
    expect(reUsed.status).toBe(200);
    expect(((await reUsed.json()) as { uses: string[] }).uses).toEqual(["github", "slack"]);
    await Bun.sleep(20);
    expect(events.some((e) => e.event === "skill.upsert" && e.id === skill.id)).toBe(true);
    const listed = await fetch(`${h.origin}/v1/skills`, { headers: auth(h) });
    const page = (await listed.json()) as { items: Array<{ id: string }> };
    expect(page.items.map((row) => row.id)).toEqual([skill.id]);
    const patched = await fetch(`${h.origin}/v1/skills/${skill.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    const deleted = await fetch(`${h.origin}/v1/skills/${skill.id}`, {
      method: "DELETE",
      headers: auth(h),
    });
    expect(deleted.status).toBe(204);
    await Bun.sleep(20);
    expect(events.some((e) => e.event === "skill.removed" && e.id === skill.id)).toBe(true);
    ws.close();
  });
});

describe("mcp servers", () => {
  test("usage_note round-trips through POST and PATCH and rejects an over-long note", async () => {
    const h = await start();
    const posted = await fetch(`${h.origin}/v1/mcp-servers`, {
      method: "POST",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: "github",
        command: "bun",
        args: ["run", "gh.ts"],
        enabled: false,
        usage_note: "  Only for the real-bot repo.  ",
      }),
    });
    expect(posted.status).toBe(201);
    const server = (await posted.json()) as { id: string; usage_note: string | null; instructions: string | null };
    expect(server.usage_note).toBe("Only for the real-bot repo.");
    expect(server.instructions).toBeNull();

    const patched = await fetch(`${h.origin}/v1/mcp-servers/${server.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ usage_note: "Read-only." }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { usage_note: string | null }).usage_note).toBe("Read-only.");

    const listed = await fetch(`${h.origin}/v1/mcp-servers`, { headers: auth(h) });
    const page = (await listed.json()) as { items: Array<{ id: string; usage_note: string | null }> };
    expect(page.items.find((row) => row.id === server.id)?.usage_note).toBe("Read-only.");

    const cleared = await fetch(`${h.origin}/v1/mcp-servers/${server.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ usage_note: null }),
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { usage_note: string | null }).usage_note).toBeNull();

    const tooLong = await fetch(`${h.origin}/v1/mcp-servers/${server.id}`, {
      method: "PATCH",
      headers: auth(h, { "Content-Type": "application/json" }),
      body: JSON.stringify({ usage_note: "x".repeat(2001) }),
    });
    expect(tooLong.status).toBe(422);
    expect(await tooLong.json()).toEqual({
      error: { code: "invalid_args", message: "usage_note must be at most 2000 characters" },
    });
  });
});

test("spend summary and detail pages filter, page, and stay out of the snapshot", async () => {
  const h = await start();
  const created = h.store.createBot({ name: "Writer", duties: "d", boundaries: "b" });
  const provider = h.store.createProviderSync({
    name: "Priced",
    base_url: "https://priced.invalid",
    models: [{ name: "fast", price: 1, pricing: { input: 1, output: 1 } }],
  });
  h.store.insertSpend({
    kind: "turn",
    sessionId: created.direct_session.id,
    botId: created.bot.id,
    turnId: created.bot.id,
    providerId: provider.id,
    model: "fast",
    inputTokens: 10,
    outputTokens: 2,
    costUsdTicks: 4,
  });
  h.store.insertSpend({
    kind: "composer_suggest",
    sessionId: created.direct_session.id,
    botId: null,
    providerId: provider.id,
    model: "fast",
    inputTokens: 3,
    outputTokens: 1,
  });
  const get = (path: string) => fetch(`${h.origin}${path}`, { headers: auth(h) });
  const summary = await get("/v1/spend/summary?group_by=kind&tz=UTC&kind=turn,composer_suggest");
  expect(summary.status).toBe(200);
  const body = await summary.json() as { totals: { calls: number; reported_usd_ticks: number | null; estimated_usd_ticks: number | null }; groups: Array<{ id: string }> };
  expect(body.totals.calls).toBe(2);
  expect(body.totals.reported_usd_ticks).toBe(4);
  expect(body.totals.estimated_usd_ticks).toBe(40_000);
  expect(body.groups.map((row) => row.id).sort()).toEqual(["composer_suggest", "turn"]);
  const unassigned = await get("/v1/spend/summary?bot_id=&group_by=bot");
  expect((await unassigned.json() as { totals: { calls: number } }).totals.calls).toBe(1);
  const page = await get("/v1/spend?limit=1&kind=turn&kind=composer_suggest");
  const first = await page.json() as { items: Array<{ kind: string }>; next: string | null };
  expect(first.items).toHaveLength(1);
  expect(first.next).toBeString();
  const rest = await get(`/v1/spend?limit=1&cursor=${encodeURIComponent(first.next!)}`);
  expect((await rest.json() as { items: unknown[]; next: string | null }).items).toHaveLength(1);
  expect((await get("/v1/spend?from=yesterday")).status).toBe(422);
  expect((await get("/v1/spend?from=2026-02-31T00:00:00.000Z")).status).toBe(422);
  expect((await get("/v1/spend?to=2026-04-31T00:00:00Z")).status).toBe(422);
  const noMillis = await get("/v1/spend?from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:00.001Z");
  expect(noMillis.status).toBe(200);
  expect((await noMillis.json() as { items: unknown[] }).items).toHaveLength(0);
  expect((await get("/v1/spend/summary?tz=Not/AZone")).status).toBe(422);
  expect((await get("/v1/spend?limit=0")).status).toBe(422);
  // A purpose is a line of its own (ADR 0042): the scribe's call is not the organizer's.
  h.store.insertSpend({ kind: "organize", purpose: "scribe", sessionId: created.direct_session.id, botId: null, model: "fast", inputTokens: 5, outputTokens: 1 });
  const lines = await (await get("/v1/spend/summary?group_by=kind&tz=UTC&kind=scribe&kind=organize")).json() as { groups: Array<{ id: string; calls: number }> };
  expect(lines.groups.map((row) => [row.id, row.calls])).toEqual([["scribe", 1]]);
  const scribed = await (await get("/v1/spend?kind=scribe")).json() as { items: Array<{ kind: string; purpose: string | null }> };
  expect(scribed.items).toMatchObject([{ kind: "organize", purpose: "scribe" }]);
  expect((await get("/v1/spend?kind=scribble")).status).toBe(422);
  const snapshot = await (await get("/v1/snapshot")).json() as Record<string, unknown>;
  expect("spend" in snapshot).toBe(false);
});

describe("lessons", () => {
  test("retiring a reflection's waiting proposal in Settings closes its card for every open chat at once", async () => {
    const h = await start();
    h.store.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('engine_level', '8')");
    const maker = h.store.createBot({ name: "视频导演", duties: "出片", boundaries: "none" }).bot;
    const reviewer = h.store.createBot({ name: "审片员", duties: "审片", boundaries: "none" }).bot;
    const room = h.store.createGroup({ name: "Studio", members: [maker.id, reviewer.id] });
    const plan = h.store.openTask({ sessionId: room.id, title: "EP01" });
    const ticket = h.store.createTicket({ taskId: plan.id, title: "第七镜", worker: maker.id });
    h.store.recordWorkEvent({ kind: "review.miss", actor: "user", botId: reviewer.id, taskId: plan.id, ticketId: ticket.id,
      payload: { reviewer_bot_id: reviewer.id, reviewer_model: "m", message_id: null, card_id: "c1" } });
    const { lesson, message } = h.store.recordReflection(h.store.claimDueReflection()!, { kind: "checklist", hook: "before_review", text: "逐帧比对" });

    const ws = new WebSocket(`${h.origin.replace("http", "ws")}/v1/events`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const events: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (ev) => events.push(JSON.parse(String(ev.data)) as Record<string, unknown>));
    ws.send(JSON.stringify({ type: "auth", token: h.token }));
    await Bun.sleep(20);
    const res = await fetch(`${h.origin}/v1/lessons/${lesson!.id}`, { method: "PATCH", headers: auth(h, { "Content-Type": "application/json" }), body: JSON.stringify({ status: "retired" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: lesson!.id, status: "retired" });
    await Bun.sleep(50);
    ws.close();
    const upserts = events.filter((event) => event.event === "message.upsert" && event.id === message!.id);
    expect(upserts.at(-1)).toMatchObject({ control: { kind: "lesson", acted: ["decline"] } });
  });
});
