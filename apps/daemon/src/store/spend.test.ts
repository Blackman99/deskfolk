import { describe, expect, test } from "bun:test";
import type { SpendKind, SpendSummaryQuery } from "@real-bot/protocol";
import { spyOn } from "bun:test";
import { Store } from ".";
import { ulid } from "../ids";
import { modelGroupId, type SpendInput } from "./spend";

const KINDS: SpendKind[] = ["turn", "judgement", "route_pick", "route_review", "route_learn", "composer_suggest"];

function open(): Store {
  return new Store();
}

describe("spend ledger", () => {
  test("a new row freezes the session and bot names, the call target, and the estimate", () => {
    const store = open();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
    const reader = store.createBot({ name: "Reader", duties: "read", boundaries: "none" });
    const group = store.createGroup({ name: "Desk", members: [writer.bot.id, reader.bot.id] });
    const provider = store.createProviderSync({ name: "Priced", base_url: "https://priced.invalid", models: [{ name: "fast", price: 1, pricing: { input: 2, output: 8, cached_input: 1 } }] });
    const row = store.insertSpend({
      kind: "turn",
      sessionId: group.id,
      botId: writer.bot.id,
      turnId: ulid(),
      providerId: provider.id,
      model: "fast",
      thinkingLevel: "low",
      inputTokens: 1000,
      cachedTokens: 200,
      outputTokens: 100,
    });
    expect(row.session_name).toBe("Desk");
    expect(row.bot_name).toBe("Writer");
    expect(row.provider_name).toBe("Priced");
    expect(row.thinking_level).toBe("low");
    expect(row.estimated_cost_usd_ticks).toBe(26_000_000);
    expect(row.cost_usd_ticks).toBeNull();

    store.patchProviderSync(provider.id, { models: [{ name: "fast", price: 1, pricing: { input: 20, output: 80 } }] });
    store.renameSession(group.id, "Renamed");
    const again = store.insertSpend({
      kind: "turn",
      sessionId: group.id,
      botId: writer.bot.id,
      turnId: ulid(),
      providerId: provider.id,
      providerName: "Frozen",
      model: "fast",
      inputTokens: 1000,
      outputTokens: 100,
      costUsdTicks: 9,
    });
    expect(store.listSpend({})[0]!.estimated_cost_usd_ticks).toBe(26_000_000);
    expect(store.listSpend({})[0]!.session_name).toBe("Desk");
    expect(again.session_name).toBe("Renamed");
    expect(again.provider_name).toBe("Frozen");
    expect(again.estimated_cost_usd_ticks).toBeNull();
    expect(again.cost_usd_ticks).toBe(9);
    const overridden = store.insertSpend({
      kind: "turn",
      sessionId: group.id,
      botId: writer.bot.id,
      turnId: ulid(),
      providerId: provider.id,
      model: "fast",
      inputTokens: 1000,
      outputTokens: 100,
      costUsdTicks: 9,
      estimatedCostUsdTicks: 1,
    });
    expect(overridden.cost_usd_ticks).toBe(9);
    expect(overridden.estimated_cost_usd_ticks).toBeNull();

    const suggest = store.insertSpend({
      kind: "composer_suggest",
      sessionId: writer.direct_session.id,
      botId: null,
      inputTokens: 10,
      outputTokens: null,
    });
    expect(suggest.bot_id).toBeNull();
    expect(suggest.bot_name).toBeNull();
    expect(suggest.session_name).toBe("Writer");
    expect(suggest.estimated_cost_usd_ticks).toBeNull();
    store.close();
  });

  test("deleting a session, clearing history, or deleting a bot leaves the rows and their names", () => {
    const store = open();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
    const reader = store.createBot({ name: "Reader", duties: "read", boundaries: "none" });
    const group = store.createGroup({ name: "Desk", members: [writer.bot.id, reader.bot.id] });
    const message = store.postMessage(group.id, { body: "hello" });
    const turn = store.createTurn({ sessionId: group.id, botId: writer.bot.id, triggerMessageId: message.id });
    const groupRow = store.insertSpend({ kind: "turn", sessionId: group.id, botId: writer.bot.id, turnId: turn.id, model: "fast" });
    const directRow = store.insertSpend({ kind: "judgement", sessionId: writer.direct_session.id, botId: writer.bot.id, judgementId: ulid(), model: "fast" });

    store.clearSessionMessages(writer.direct_session.id);
    expect(store.listSpend({ session_id: writer.direct_session.id }).map((row) => row.id)).toEqual([directRow.id]);
    expect(store.listSpend({ session_id: writer.direct_session.id })[0]!.bot_name).toBe("Writer");

    store.deleteSession(group.id);
    expect(store.listSpend({ session_id: group.id })[0]).toMatchObject({ id: groupRow.id, session_name: "Desk", bot_name: "Writer", model: "fast" });

    store.deleteBot(writer.bot.id);
    expect(store.listSpend({ bot_id: writer.bot.id })).toHaveLength(2);
    const after = store.spendSummary({ group_by: "session", session_id: writer.direct_session.id });
    expect(after.groups[0]).toMatchObject({ name: "Writer", deleted: true });
    store.close();
  });

  test("sums stay null when every value is null, and a reported amount is not an estimate", () => {
    const store = open();
    const bot = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
    store.insertSpend({ kind: "turn", sessionId: bot.direct_session.id, botId: bot.bot.id, turnId: ulid(), missingReason: "endpoint_omitted" });
    store.insertSpend({ kind: "turn", sessionId: bot.direct_session.id, botId: bot.bot.id, turnId: ulid(), inputTokens: null, totalTokens: 4 });
    const summary = store.spendSummary({});
    expect(summary.totals.calls).toBe(2);
    expect(summary.totals.input_tokens).toBeNull();
    expect(summary.totals.total_tokens).toBe(4);
    expect(summary.totals.reported_usd_ticks).toBeNull();
    expect(summary.totals.estimated_usd_ticks).toBeNull();
    expect(summary.totals.missing_calls).toBe(2);
    expect(summary.totals.missing_usage_calls).toBe(1);
    expect(store.spendSummary({ from: "2099-01-01T00:00:00.000Z" }).totals).toMatchObject({
      calls: 0,
      input_tokens: null,
      reported_usd_ticks: null,
      estimated_usd_ticks: null,
    });
    store.close();
  });

  test("every group_by and filter keeps deleted sessions and bots, and splits reported from estimated", () => {
    const store = open();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
    const reader = store.createBot({ name: "Reader", duties: "read", boundaries: "none" });
    const group = store.createGroup({ name: "Desk", members: [writer.bot.id, reader.bot.id] });
    const provider = store.createProviderSync({
      name: "Priced",
      base_url: "https://priced.invalid",
      models: [{ name: "fast", price: 1, pricing: { input: 1, output: 1 } }],
    });
    const other = store.createProviderSync({ name: "Other", base_url: "https://other.invalid", models: ["fast"] });
    const message = store.postMessage(group.id, { body: "hello" });
    const turn = store.createTurn({ sessionId: group.id, botId: writer.bot.id, triggerMessageId: message.id });
    const rows: Array<SpendInput & { createdAt: string }> = [
      { kind: "turn", sessionId: group.id, botId: writer.bot.id, turnId: turn.id, providerId: provider.id, model: "fast", inputTokens: 10, outputTokens: 1, costUsdTicks: 5, createdAt: "2026-03-01T15:30:00.000Z" },
      { kind: "judgement", sessionId: group.id, botId: reader.bot.id, judgementId: ulid(), providerId: provider.id, model: "fast", inputTokens: 4, outputTokens: 1, createdAt: "2026-03-01T16:00:00.000Z" },
      { kind: "route_pick", sessionId: writer.direct_session.id, botId: writer.bot.id, turnId: ulid(), providerId: other.id, model: "fast", inputTokens: 2, outputTokens: 1, createdAt: "2026-03-02T01:00:00.000Z" },
      { kind: "route_review", sessionId: group.id, botId: writer.bot.id, turnId: ulid(), chainId: "c1", model: null, inputTokens: 8, outputTokens: 1, createdAt: "2026-03-02T02:00:00.000Z" },
      { kind: "route_learn", sessionId: group.id, botId: writer.bot.id, chainId: "c1", providerId: provider.id, model: "slow", inputTokens: 1, outputTokens: 1, createdAt: "2026-03-02T03:00:00.000Z" },
      { kind: "composer_suggest", sessionId: writer.direct_session.id, botId: null, providerId: provider.id, model: "fast", inputTokens: 3, outputTokens: 1, createdAt: "2026-03-02T04:00:00.000Z" },
    ];
    for (const row of rows) insertAt(store, row);
    store.deleteSession(group.id);
    store.deleteBot(reader.bot.id);

    const all = store.spendSummary({});
    expect(all.totals.calls).toBe(6);
    expect(all.totals.reported_usd_ticks).toBe(5);
    expect(all.totals.reported_calls).toBe(1);
    expect(all.totals.estimated_calls).toBe(2);
    expect(all.totals.input_tokens).toBe(28);
    expect(all.totals.output_tokens).toBe(6);
    expect(all.categories.map((row) => [row.category, row.calls])).toEqual([
      ["turn", 1],
      ["judgement", 1],
      ["decision", 1],
      ["feedback", 2],
      ["other", 1],
    ]);
    expect(all.categories.find((row) => row.category === "feedback")!.kinds.map((row) => [row.kind, row.calls])).toEqual([
      ["route_review", 1],
      ["route_learn", 1],
    ]);

    const byModel = store.spendSummary({ group_by: "model" });
    const fast = byModel.groups.find((row) => row.provider_id === provider.id && row.model === "fast")!;
    const sameName = byModel.groups.find((row) => row.provider_id === other.id && row.model === "fast")!;
    const unrecorded = byModel.groups.find((row) => row.model === null)!;
    expect(fast.id).toBe(modelGroupId(provider.id, "fast"));
    expect(fast.id).not.toBe(sameName.id);
    expect(fast.provider_name).toBe("Priced");
    expect(unrecorded).toMatchObject({ id: null, name: null, provider_id: null, provider_name: null, deleted: false, calls: 1 });
    expect(byModel.groups.filter((row) => row.model === null)).toHaveLength(1);

    const bySession = store.spendSummary({ group_by: "session" });
    const gone = bySession.groups.find((row) => row.id === group.id)!;
    expect(gone).toMatchObject({ name: "Desk", deleted: true });
    const living = bySession.groups.find((row) => row.id === writer.direct_session.id)!;
    expect(living).toMatchObject({ name: "Writer", deleted: false });

    const byBot = store.spendSummary({ group_by: "bot" });
    expect(byBot.groups.find((row) => row.id === reader.bot.id)).toMatchObject({ name: "Reader", deleted: true });
    expect(byBot.groups.find((row) => row.id === writer.bot.id)).toMatchObject({ name: "Writer", deleted: false });
    expect(byBot.groups.find((row) => row.id === null)).toMatchObject({ deleted: false, calls: 1 });

    const byKind = store.spendSummary({ group_by: "kind" });
    expect(byKind.groups.map((row) => row.id).sort()).toEqual([...KINDS].sort());

    const byDay = store.spendSummary({ group_by: "day", tz: "America/New_York" });
    expect(byDay.groups.map((row) => row.id)).toEqual(["2026-03-01"]);
    expect(byDay.groups[0]!.calls).toBe(6);
    expect(byDay.groups[0]!.categories.find((row) => row.category === "turn")!.calls).toBe(1);
    const utc = store.spendSummary({ group_by: "day", tz: "UTC" });
    expect(utc.groups.map((row) => [row.id, row.calls])).toEqual([["2026-03-01", 2], ["2026-03-02", 4]]);

    const filters: SpendSummaryQuery[] = [
      { group_by: "model", kind: ["turn", "route_learn"], bot_id: writer.bot.id },
      { group_by: "session", session_id: group.id, model: "fast", provider_id: provider.id, kind: ["turn"] },
      { group_by: "bot", bot_id: null },
      { group_by: "kind", model: null },
      { group_by: "day", tz: "Asia/Shanghai", from: "2026-03-01T00:00:00.000Z", to: "2026-03-02T00:00:00.000Z", turn_id: turn.id },
      { kind: ["composer_suggest"], provider_id: provider.id },
    ];
    const expected = [2, 1, 1, 1, 1, 1];
    filters.forEach((filter, index) => {
      expect(store.spendSummary(filter).totals.calls).toBe(expected[index]);
    });
    expect(store.spendSummary({ bot_id: null, model: null }).totals.calls).toBe(0);
    expect(() => store.spendSummary({ group_by: "day", tz: "Not/AZone" })).toThrow();
    expect(() => store.spendSummary({ group_by: "hour" as "day" })).toThrow();

    insertAt(store, { kind: "turn", sessionId: reader.direct_session.id, botId: reader.bot.id, turnId: ulid(), inputTokens: 1, outputTokens: 1, createdAt: "2026-03-08T06:30:00.000Z" });
    insertAt(store, { kind: "turn", sessionId: reader.direct_session.id, botId: reader.bot.id, turnId: ulid(), inputTokens: 1, outputTokens: 1, createdAt: "2026-03-08T07:30:00.000Z" });
    const spring = store.spendSummary({ group_by: "day", tz: "America/New_York", from: "2026-03-08T00:00:00.000Z", to: "2026-03-09T00:00:00.000Z" });
    expect(spring.groups.map((row) => [row.id, row.calls])).toEqual([["2026-03-08", 2]]);
    expect(spring.totals.calls).toBe(2);
    const kolkata = store.spendSummary({ group_by: "day", tz: "Asia/Kolkata", from: "2026-03-01T15:00:00.000Z", to: "2026-03-01T16:00:00.000Z" });
    expect(kolkata.groups.map((row) => [row.id, row.calls])).toEqual([["2026-03-01", 1]]);
    store.db.run(`DELETE FROM spend WHERE created_at >= ?`, ["2026-03-08T00:00:00.000Z"]);

    const page = store.spendPage({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.created_at > page.items[1]!.created_at).toBe(true);
    expect(page.next).toBeTruthy();
    const rest = store.spendPage({ limit: 50, cursor: page.next });
    expect(rest.items).toHaveLength(4);
    expect(rest.next).toBeNull();
    const seen = new Set([...page.items, ...rest.items].map((row) => row.id));
    expect(seen.size).toBe(6);
    const detail = page.items.find((row) => row.turn_id === turn.id) ?? rest.items.find((row) => row.turn_id === turn.id)!;
    expect(detail.trigger_message_id).toBeNull();
    expect(detail.session_deleted).toBe(true);
    const readerDetail = [...page.items, ...rest.items].find((row) => row.bot_id === reader.bot.id)!;
    expect(readerDetail.bot_deleted).toBe(true);
    const writerDetail = [...page.items, ...rest.items].find((row) => row.bot_id === writer.bot.id)!;
    expect(writerDetail.bot_deleted).toBe(false);
    expect([...page.items, ...rest.items].find((row) => row.bot_id === null)!.bot_deleted).toBe(false);
    expect(() => store.spendPage({ cursor: "nope" })).toThrow();

    store.insertSpend({
      kind: "turn",
      sessionId: writer.direct_session.id,
      botId: writer.bot.id,
      turnId: ulid(),
      providerId: provider.id,
      model: null,
      inputTokens: 1,
      outputTokens: 1,
    });
    const withProvider = store.spendSummary({ group_by: "model" }).groups.filter((row) => row.model === null);
    expect(withProvider).toHaveLength(1);
    expect(withProvider[0]).toMatchObject({ id: null, provider_id: null, provider_name: null, calls: 2 });

    store.patchBot(writer.bot.id, { name: "Renamed" });
    expect(store.spendSummary({ group_by: "bot" }).groups.find((row) => row.id === writer.bot.id)).toMatchObject({ name: "Renamed", deleted: false });
    expect(store.spendSummary({ group_by: "session" }).groups.find((row) => row.id === writer.direct_session.id)).toMatchObject({ name: "Renamed", deleted: false });
    store.deleteBot(writer.bot.id);
    expect(store.spendSummary({ group_by: "bot" }).groups.find((row) => row.id === writer.bot.id)).toMatchObject({ name: "Writer", deleted: true });
    expect(store.spendSummary({ group_by: "session" }).groups.find((row) => row.id === writer.direct_session.id)).toMatchObject({ name: "Writer", deleted: true });
    store.close();
  });

  test("a millisecond stays on its UTC day, and a year that returns to the same offset still splits summer", () => {
    const store = open();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
    const rows = [
      "2026-01-01T00:00:00.900Z",
      "2026-07-15T16:00:00.900Z",
      "2026-12-15T05:00:00.000Z",
    ];
    for (const createdAt of rows) {
      insertAt(store, {
        kind: "turn",
        sessionId: writer.direct_session.id,
        botId: writer.bot.id,
        turnId: ulid(),
        inputTokens: 1,
        outputTokens: 1,
        createdAt,
      });
    }
    const utc = store.spendSummary({ group_by: "day", tz: "UTC" });
    expect(utc.groups.map((row) => [row.id, row.calls])).toEqual([
      ["2026-01-01", 1],
      ["2026-07-15", 1],
      ["2026-12-15", 1],
    ]);
    const year = store.spendSummary({
      group_by: "day",
      tz: "America/New_York",
      from: "2026-01-01T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
    });
    expect(year.groups.map((row) => [row.id, row.calls])).toEqual([
      ["2025-12-31", 1],
      ["2026-07-15", 1],
      ["2026-12-15", 1],
    ]);
    expect(year.totals.calls).toBe(3);
    store.close();
  });

  test("ten thousand rows aggregate on every grouping in under 100ms", () => {
    const store = open();
    const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
    const reader = store.createBot({ name: "Reader", duties: "read", boundaries: "none" });
    const group = store.createGroup({ name: "Desk", members: [writer.bot.id, reader.bot.id] });
    const insert = store.db.prepare(
      `INSERT INTO spend (
         id, session_id, session_name, bot_id, bot_name, turn_id, judgement_id, kind, chain_id,
         provider_id, provider_name, model, thinking_level,
         input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens,
         cost_usd_ticks, estimated_cost_usd_ticks, missing_reason, created_at
       ) VALUES (?, ?, 'Desk', ?, 'Writer', ?, ?, ?, ?, 'provider', 'Priced', ?, 'low', ?, 1, ?, NULL, NULL, ?, NULL, NULL, ?)`,
    );
    const sessions = [group.id, writer.direct_session.id];
    const bots = [writer.bot.id, reader.bot.id, null];
    store.db.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const kind = KINDS[index % KINDS.length]!;
        const needsTurn = kind === "turn" || kind === "route_pick" || kind === "route_review";
        const needsJudgement = kind === "judgement";
        const needsChain = kind === "route_review" || kind === "route_learn";
        insert.run(
          ulid(),
          sessions[index % sessions.length]!,
          bots[index % bots.length],
          needsTurn ? ulid() : null,
          needsJudgement ? ulid() : null,
          kind,
          needsChain ? "chain" : null,
          index % 7 === 0 ? null : "fast",
          index % 11 === 0 ? null : index,
          index % 11 === 0 ? null : index + 1,
          index % 5 === 0 ? null : index,
          new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
        );
      }
    })();
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM spend").get()!.n).toBe(10_000);
    // Compile the stable-offset day query. The timed call is the one a view repeats, and a DST fold.
    store.spendSummary({ group_by: "day", tz: "UTC", from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T00:01:00.000Z" });
    const cold = performance.now();
    const coldSummary = store.spendSummary({ group_by: "day", tz: "America/Los_Angeles", kind: ["turn", "route_review"] });
    expect(performance.now() - cold).toBeLessThan(100);
    expect(coldSummary.totals.calls).toBeGreaterThan(0);
    for (const groupBy of ["model", "session", "bot", "kind", "day"] as const) {
      const started = performance.now();
      const summary = store.spendSummary({ group_by: groupBy, tz: "America/Los_Angeles", kind: ["turn", "route_review"] });
      const elapsed = performance.now() - started;
      expect(summary.totals.calls).toBeGreaterThan(0);
      expect(summary.groups.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(100);
    }
    const loaded = spyOn(store.db, "query");
    const checked = store.spendSummary({ group_by: "model" });
    expect(checked.totals.calls).toBe(10_000);
    const selected = loaded.mock.calls.map((call) => String(call[0]));
    expect(selected.some((sql) => sql.includes("COUNT(*)") && sql.includes("GROUP BY"))).toBe(true);
    expect(selected.some((sql) => sql.includes("FROM spend") && !sql.includes("COUNT(*)"))).toBe(false);
    loaded.mockRestore();
    store.close();
  });
});

function insertAt(store: Store, input: SpendInput & { createdAt: string }): void {
  const { createdAt, ...rest } = input;
  const row = store.insertSpend(rest);
  store.db.run(`UPDATE spend SET created_at = ? WHERE id = ?`, [createdAt, row.id]);
}
